import { builtinModules } from "node:module";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readFileWithinRoot } from "./safe-file.js";
import ts from "typescript";

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}


export interface ImportDiagnostic {
  filePath: string;
  moduleSpecifier: string;
  code: number;
  kind: "missing-package" | "missing-export";
  message: string;
  line: number;
  column: number;
  importedName: string | null;
}

const IMPORT_DIAGNOSTIC_CODES = new Set([2307, 2305, 2614, 2724, 1192]);
const BUILTINS = new Set(builtinModules.flatMap((name) => [name, name.replace(/^node:/, "")]));

function readConfigTextSafely(candidatePath: string, projectRoot: string): string | undefined {
  try {
    const root = resolve(projectRoot);
    const absoluteCandidate = resolve(candidatePath);
    const relativeCandidate = relative(root, absoluteCandidate).split(sep).join("/");
    const external = relativeCandidate === ".." || relativeCandidate.startsWith("../") || isAbsolute(relativeCandidate);
    if (!external) {
      const relativeParent = relative(root, dirname(absoluteCandidate));
      let current = root;
      for (const segment of relativeParent.split(sep).filter(Boolean)) {
        current = join(current, segment);
        const identity = lstatSync(current);
        const currentRelative = relative(root, current).split(sep).join("/");
        if (identity.isSymbolicLink() && !currentRelative.split("/").includes("node_modules")) {
          throw new Error("Configuration path traverses a symbolic-link directory.");
        }
        if (!identity.isDirectory() && !identity.isSymbolicLink()) {
          throw new Error("Configuration parent is not a directory.");
        }
      }
    }
    const canonicalRoot = realpathSync(root);
    const absoluteCandidate = resolve(candidatePath);
    const relativeCandidate = relative(canonicalRoot, absoluteCandidate).split(sep).join("/");
    const external = relativeCandidate === ".." || relativeCandidate.startsWith("../") ||
      isAbsolute(relativeCandidate);
    const packageManagerPath = relativeCandidate.split("/").includes("node_modules");
    if (!external && !packageManagerPath) {
      return readFileWithinRoot(canonicalRoot, absoluteCandidate, {
        canonicalRoot,
        rejectFinalSymlink: true,
      }).content.toString("utf8");
    }
    // Explicit external "extends" targets and package-manager links under
    // node_modules remain supported; final-component symlinks still fail closed.
    const canonicalParent = realpathSync(dirname(candidatePath));
    const canonicalCandidate = join(canonicalParent, basename(candidatePath));
    return readFileWithinRoot(canonicalParent, canonicalCandidate, {
      canonicalRoot: canonicalParent,
      rejectFinalSymlink: true,
    }).content.toString("utf8");
  } catch {
    return undefined;
  }
}

function nodeAtPosition(sourceFile: ts.SourceFile, position: number): ts.Node {
  let best: ts.Node = sourceFile;
  const visit = (node: ts.Node): void => {
    if (position < node.getFullStart() || position >= node.getEnd()) return;
    best = node;
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return best;
}

function moduleContext(node: ts.Node): { specifier: string; importedName: string | null } | undefined {
  let current: ts.Node | undefined = node;
  let importedName: string | null = null;
  while (current) {
    if (ts.isImportSpecifier(current) || ts.isExportSpecifier(current)) {
      importedName = (current.propertyName ?? current.name).text;
    } else if (ts.isImportClause(current) && current.name) {
      importedName = "default";
    }
    if (ts.isImportDeclaration(current) && ts.isStringLiteral(current.moduleSpecifier)) {
      return { specifier: current.moduleSpecifier.text, importedName };
    }
    if (ts.isExportDeclaration(current) && current.moduleSpecifier && ts.isStringLiteral(current.moduleSpecifier)) {
      return { specifier: current.moduleSpecifier.text, importedName };
    }
    current = current.parent;
  }
  return undefined;
}

function isPathAlias(specifier: string, options: ts.CompilerOptions): boolean {
  return Object.keys(options.paths ?? {}).some((pattern) => {
    const wildcard = pattern.indexOf("*");
    if (wildcard < 0) return pattern === specifier;
    const prefix = pattern.slice(0, wildcard);
    const suffix = pattern.slice(wildcard + 1);
    return specifier.startsWith(prefix) && specifier.endsWith(suffix) &&
      specifier.length >= prefix.length + suffix.length;
  });
}

function isBareExternalSpecifier(specifier: string, localPackages: ReadonlySet<string>, options: ts.CompilerOptions): boolean {
  if (isPathAlias(specifier, options)) return false;
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#")) return false;
  const packageName = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0] ?? "";
  const normalizedSpecifier = specifier.replace(/^node:/, "");
  return Boolean(packageName) && !localPackages.has(packageName) &&
    !BUILTINS.has(normalizedSpecifier) && !BUILTINS.has(packageName);
}

/**
 * Ask TypeScript's resolver and checker only for import-resolution diagnostics.
 * This intentionally does not replace the project's full typecheck/build.
 */
export function analyzeImportDiagnostics(
  rootPath: string,
  indexedPaths: string[],
  localPackages: ReadonlySet<string> = new Set(),
): ImportDiagnostic[] {
  if (indexedPaths.length === 0) return [];
  const root = resolve(rootPath);
  const configPath = join(root, "tsconfig.json");
  let options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    allowJs: true,
    checkJs: false,
    skipLibCheck: true,
    noEmit: true,
  };
  // TypeScript requires a stable slash-normalized filename for diagnostics
  // on Windows; otherwise malformed JSON can trigger an internal assertion.
  const typescriptConfigPath = configPath.replaceAll("\\", "/");
  const config = ts.readConfigFile(typescriptConfigPath, (path) => readConfigTextSafely(path, root));
  if (!config.error) {
    const configHost: ts.ParseConfigHost = { ...ts.sys, readFile: (path) => readConfigTextSafely(path, root), readDirectory: () => [] };
    const parsed = ts.parseJsonConfigFileContent(config.config, configHost, root, undefined, typescriptConfigPath);
    options = { ...options, ...parsed.options, allowJs: parsed.options.allowJs ?? true, checkJs: false, skipLibCheck: true, noEmit: true };
  }
  const absolutePaths = indexedPaths.map((path) => resolve(root, path));
  const indexedSet = new Set(absolutePaths);
  const program = ts.createProgram({ rootNames: absolutePaths, options });
  const output: ImportDiagnostic[] = [];
  // Restrict diagnostics to indexed source files instead of collecting errors
  // from the entire dependency graph (notably node_modules).
  for (const sourceFile of program.getSourceFiles()) {
    const filePath = resolve(sourceFile.fileName);
    if (!indexedSet.has(filePath)) continue;
    for (const diagnostic of program.getSemanticDiagnostics(sourceFile)) {
      if (diagnostic.start === undefined || !IMPORT_DIAGNOSTIC_CODES.has(diagnostic.code)) continue;
      const position = sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
      const context = moduleContext(nodeAtPosition(sourceFile, diagnostic.start));
      if (!context || !isBareExternalSpecifier(context.specifier, localPackages, options)) continue;
      const resolvedModule = ts.resolveModuleName(context.specifier, sourceFile.fileName, options, ts.sys).resolvedModule;
      if (resolvedModule) {
        const resolvedPath = resolve(resolvedModule.resolvedFileName);
        const relativeResolved = relative(root, resolvedPath).split(sep).join("/");
        const insideProject = relativeResolved !== ".." && !relativeResolved.startsWith("../") && !relativeResolved.startsWith("/");
        if (insideProject && !relativeResolved.split("/").includes("node_modules")) continue;
      }
      const relativePath = relative(root, filePath).split(sep).join("/");
      const kind = diagnostic.code === 2307 ? "missing-package" : "missing-export";
      output.push({
        filePath: relativePath,
        moduleSpecifier: context.specifier,
        code: diagnostic.code,
        kind,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        line: position.line + 1,
        column: position.character + 1,
        importedName: context.importedName,
      });
    }
  }
  const unique = new Map<string, ImportDiagnostic>();
  for (const item of output) {
    const key = [item.filePath, item.moduleSpecifier, item.code, item.line, item.column].join(":");
    unique.set(key, item);
  }
  return [...unique.values()].sort((a, b) =>
    compareCodeUnits(a.filePath, b.filePath) || a.line - b.line || a.column - b.column || a.code - b.code,
  );
}
