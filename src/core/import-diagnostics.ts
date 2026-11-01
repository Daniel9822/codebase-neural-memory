import { builtinModules } from "node:module";
import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";

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

function isBareExternalSpecifier(specifier: string, localPackages: ReadonlySet<string>): boolean {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#")) return false;
  const packageName = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0] ?? "";
  return Boolean(packageName) && !localPackages.has(packageName) &&
    !BUILTINS.has(specifier) && !BUILTINS.has(packageName);
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
  if (existsSync(configPath)) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (!config.error) {
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, undefined, configPath);
      options = { ...options, ...parsed.options, allowJs: parsed.options.allowJs ?? true, checkJs: false, skipLibCheck: true, noEmit: true };
    }
  }
  const absolutePaths = indexedPaths.map((path) => resolve(root, path));
  const indexedSet = new Set(absolutePaths);
  const program = ts.createProgram({ rootNames: absolutePaths, options });
  const output: ImportDiagnostic[] = [];
  for (const diagnostic of program.getSemanticDiagnostics()) {
    if (!diagnostic.file || diagnostic.start === undefined || !IMPORT_DIAGNOSTIC_CODES.has(diagnostic.code)) continue;
    const filePath = resolve(diagnostic.file.fileName);
    if (!indexedSet.has(filePath)) continue;
    const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    const context = moduleContext(diagnostic.file.getTokenAtPosition(diagnostic.start));
    if (!context || !isBareExternalSpecifier(context.specifier, localPackages)) continue;
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
  const unique = new Map<string, ImportDiagnostic>();
  for (const item of output) {
    const key = [item.filePath, item.moduleSpecifier, item.code, item.line, item.column].join(":");
    unique.set(key, item);
  }
  return [...unique.values()].sort((a, b) =>
    a.filePath.localeCompare(b.filePath) || a.line - b.line || a.column - b.column || a.code - b.code,
  );
}
