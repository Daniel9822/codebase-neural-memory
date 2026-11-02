import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { lstatSync, realpathSync, readdirSync } from "node:fs";
import type { Dirent, Stats } from "node:fs";
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

type TypeScriptMatchFiles = (
  path: string,
  extensions: readonly string[] | undefined,
  excludes: readonly string[] | undefined,
  includes: readonly string[] | undefined,
  useCaseSensitiveFileNames: boolean,
  currentDirectory: string,
  depth: number | undefined,
  getFileSystemEntries: (path: string) => { files: string[]; directories: string[] },
  realpath: (path: string) => string,
) => string[];

const matchTypeScriptFiles = (ts as unknown as { matchFiles: TypeScriptMatchFiles }).matchFiles;



function readConfigBytesSafely(candidatePath: string, projectRoot: string): Buffer {
  const root = realpathSync(projectRoot);
  const absoluteCandidate = resolve(candidatePath);
  const relativeCandidate = relative(root, absoluteCandidate).split(sep).join("/");
  const external = relativeCandidate === ".." || relativeCandidate.startsWith("../") ||
    isAbsolute(relativeCandidate);
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
  const packageManagerPath = relativeCandidate.split("/").includes("node_modules");
  if (!external && !packageManagerPath) {
    const read = readFileWithinRoot(root, absoluteCandidate, {
      canonicalRoot: root,
      rejectFinalSymlink: true,
      rejectHardLinks: true,
    });
    const relativeParentAfterRead = relative(root, dirname(absoluteCandidate));
    let currentAfterRead = root;
    for (const segment of relativeParentAfterRead.split(sep).filter(Boolean)) {
      currentAfterRead = join(currentAfterRead, segment);
      const identity = lstatSync(currentAfterRead);
      const currentRelative = relative(root, currentAfterRead).split(sep).join("/");
      if (identity.isSymbolicLink() && !currentRelative.split("/").includes("node_modules")) {
        throw new Error("Configuration path traverses a symbolic-link directory.");
      }
      if (!identity.isDirectory() && !identity.isSymbolicLink()) {
        throw new Error("Configuration parent is not a directory.");
      }
    }
    return read.content;
  }
  // Explicit external config targets and package-manager directory symlinks
  // remain supported; the final manifest component itself must be a real file.
  const canonicalParent = realpathSync(dirname(candidatePath));
  const canonicalCandidate = join(canonicalParent, basename(candidatePath));
  return readFileWithinRoot(canonicalParent, canonicalCandidate, {
    canonicalRoot: canonicalParent,
    rejectFinalSymlink: true,
  }).content;
}

function readConfigTextSafely(candidatePath: string, projectRoot: string): string | undefined {
  try {
    return readConfigBytesSafely(candidatePath, projectRoot).toString("utf8");
  } catch {
    return undefined;
  }
}

/**
 * Read a TypeScript host input through a descriptor-verified reader. Project
 * files outside node_modules must remain beneath the canonical project root;
 * package-manager links and external TypeScript library files are allowed, but
 * their final file component is still opened and identity-checked safely.
 */
function readTypeScriptInputSafely(candidatePath: string, projectRoot: string): string | undefined {
  try {
    const root = realpathSync(projectRoot);
    const absolute = resolve(candidatePath);
    const relativePath = relative(root, absolute).split(sep).join("/");
    const isInsideRoot = relativePath !== ".." && !relativePath.startsWith("../") && !isAbsolute(relativePath);
    const isPackageManagerPath = relativePath.split("/").includes("node_modules");
    if (isInsideRoot && !isPackageManagerPath) {
      return readFileWithinRoot(root, absolute, {
        canonicalRoot: root,
        rejectFinalSymlink: true,
        rejectHardLinks: true,
      }).content.toString("utf8");
    }

    // TypeScript resolves pnpm/npm package links to their physical targets.
    // Anchor the verified read at the real parent so normal package symlinks
    // remain usable without following a replaceable final-file symlink.
    const canonicalParent = realpathSync(dirname(absolute));
    const canonicalCandidate = join(canonicalParent, basename(absolute));
    return readFileWithinRoot(canonicalParent, canonicalCandidate, {
      canonicalRoot: canonicalParent,
      rejectFinalSymlink: true,
    }).content.toString("utf8");
  } catch {
    return undefined;
  }
}

export interface TypeScriptHostFileSystem {
  lstatSync(path: string): Stats;
  realpathSync(path: string): string;
  readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
}

const defaultTypeScriptHostFileSystem: TypeScriptHostFileSystem = {
  lstatSync,
  realpathSync,
  readdirSync: (path, options) => readdirSync(path, options),
};

function isWithinPath(candidate: string, parent: string): boolean {
  const relativePath = relative(parent, candidate);
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(".." + sep) && !isAbsolute(relativePath));
}

/**
 * Restrict TypeScript's path-based discovery APIs as well as its file reads.
 * Physical package-manager targets are admitted only after a lexical path
 * beneath this project's node_modules has resolved to that directory.
 */
export function createSafeTypeScriptHost(
  options: ts.CompilerOptions,
  projectRoot: string,
  fileSystem: TypeScriptHostFileSystem = defaultTypeScriptHostFileSystem,
): ts.CompilerHost {
  const root = fileSystem.realpathSync(projectRoot);
  const host = ts.createCompilerHost(options);
  const trustedExternalDirectories = new Set<string>();

  // TypeScript's own standard library is a fixed, installation-derived root.
  try {
    trustedExternalDirectories.add(fileSystem.realpathSync(dirname(ts.getDefaultLibFilePath(options))));
  } catch {
    // If the compiler library cannot be canonicalized, its inputs fail closed.
  }

  const isPackageManagerPath = (absolute: string): boolean =>
    isWithinPath(absolute, root) &&
    relative(root, absolute).split(sep).includes("node_modules");

  // Trust only a package entry directly below node_modules (or one package
  // entry below a real @scope directory). A nested symlink inside an already
  // approved package must never become a second trusted external root.
  const isPackageManagerRootSymlink = (absolute: string): boolean => {
    if (!isPackageManagerPath(absolute)) return false;
    const segments = relative(root, absolute).split(sep).filter(Boolean);
    const nodeModulesIndex = segments.lastIndexOf("node_modules");
    const packageSegments = segments.slice(nodeModulesIndex + 1);
    return packageSegments.length === 1 ||
      (packageSegments.length === 2 && packageSegments[0]?.startsWith("@") === true);
  };

  const isSafeDirectory = (candidate: string): boolean => {
    try {
      const absolute = resolve(candidate);
      if (isWithinPath(absolute, root)) {
        const relativeDirectory = relative(root, absolute);
        let current = root;
        for (const segment of relativeDirectory.split(sep).filter(Boolean)) {
          current = join(current, segment);
          const identity = fileSystem.lstatSync(current);
          if (identity.isSymbolicLink()) {
            if (!isPackageManagerRootSymlink(current)) return false;
            const canonical = fileSystem.realpathSync(current);
            if (fileSystem.lstatSync(canonical).isDirectory()) trustedExternalDirectories.add(canonical);
          } else if (!identity.isDirectory()) {
            return false;
          }
        }
        return true;
      }
      for (const trusted of trustedExternalDirectories) {
        if (!isWithinPath(absolute, trusted)) continue;
        const relativeDirectory = relative(trusted, absolute);
        let current = trusted;
        for (const segment of relativeDirectory.split(sep).filter(Boolean)) {
          current = join(current, segment);
          const identity = fileSystem.lstatSync(current);
          // Package-manager links are trusted only at their registered root.
          // A second symlink below that root could redirect resolution again.
          if (identity.isSymbolicLink() || !identity.isDirectory()) return false;
        }
        return true;
      }
      return false;
    } catch {
      return false;
    }
  };

  const isSafeFileCandidate = (candidate: string): boolean => {
    try {
      const absolute = resolve(candidate);
      if (!isSafeDirectory(dirname(absolute))) return false;
      const identity = fileSystem.lstatSync(absolute);
      return identity.isFile() && !identity.isSymbolicLink();
    } catch {
      return false;
    }
  };

  host.directoryExists = (directoryName) => isSafeDirectory(directoryName);
  const safeRealpath = (path: string): string => {
    const absolute = resolve(path);
    if (!isSafeDirectory(dirname(absolute)) && !isSafeDirectory(absolute)) {
      throw new Error("TypeScript path resolution crossed an untrusted directory.");
    }
    const canonical = fileSystem.realpathSync(absolute);
    if (isPackageManagerRootSymlink(absolute) && fileSystem.lstatSync(absolute).isSymbolicLink() &&
        fileSystem.lstatSync(canonical).isDirectory()) {
      trustedExternalDirectories.add(canonical);
    }
    if (!isWithinPath(canonical, root) &&
        ![...trustedExternalDirectories].some((trusted) => isWithinPath(canonical, trusted))) {
      throw new Error("TypeScript path resolution escaped approved roots.");
    }
    return canonical;
  };
  host.realpath = safeRealpath;
  const getSafeFileSystemEntries = (directory: string): { files: string[]; directories: string[] } => {
    if (!isSafeDirectory(directory)) {
      throw new Error("TypeScript directory enumeration crossed an untrusted directory.");
    }
    const beforePath = fileSystem.lstatSync(directory);
    const beforeCanonical = fileSystem.realpathSync(directory);
    const beforeTarget = fileSystem.lstatSync(beforeCanonical);
    if (!beforeTarget.isDirectory()) {
      throw new Error("TypeScript directory target is not a directory.");
    }
    const entries = fileSystem.readdirSync(directory, { withFileTypes: true });
    const afterPath = fileSystem.lstatSync(directory);
    const afterCanonical = fileSystem.realpathSync(directory);
    const afterTarget = fileSystem.lstatSync(afterCanonical);
    if (beforeCanonical !== afterCanonical ||
        beforePath.dev !== afterPath.dev || beforePath.ino !== afterPath.ino ||
        beforeTarget.dev !== afterTarget.dev || beforeTarget.ino !== afterTarget.ino) {
      throw new Error("TypeScript directory changed during safe enumeration.");
    }
    const files: string[] = [];
    const directories: string[] = [];
    for (const entry of entries) {
      const candidate = join(directory, entry.name);
      const identity = fileSystem.lstatSync(candidate);
      if (identity.isFile()) {
        files.push(entry.name);
      } else if (identity.isDirectory() ||
          (identity.isSymbolicLink() && isSafeDirectory(candidate))) {
        directories.push(entry.name);
      }
    }
    return { files, directories };
  };
  host.getDirectories = (path) => isSafeDirectory(path) ? getSafeFileSystemEntries(path).directories : [];
  host.readDirectory = (path, extensions, excludes, includes, depth) => {
    if (!isSafeDirectory(path)) return [];
    return matchTypeScriptFiles(
      path,
      extensions,
      excludes,
      includes,
      ts.sys.useCaseSensitiveFileNames,
      ts.sys.getCurrentDirectory(),
      depth,
      getSafeFileSystemEntries,
      safeRealpath,
    ).filter((entry) => isSafeFileCandidate(entry));
  };
  host.fileExists = (path) => isSafeFileCandidate(path) &&
    readTypeScriptInputSafely(path, root) !== undefined;
  host.readFile = (path) => isSafeFileCandidate(path)
    ? readTypeScriptInputSafely(path, root)
    : undefined;
  host.getSourceFile = (fileName, languageVersionOrOptions, onError) => {
    if (!isSafeFileCandidate(fileName)) {
      onError?.("File is outside the approved TypeScript resolution roots.");
      return undefined;
    }
    const text = readTypeScriptInputSafely(fileName, root);
    if (text === undefined) {
      onError?.("File could not be safely read.");
      return undefined;
    }
    return ts.createSourceFile(fileName, text, languageVersionOrOptions, true);
  };
  return host;
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
  hostFileSystem: TypeScriptHostFileSystem = defaultTypeScriptHostFileSystem,
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
  const host = createSafeTypeScriptHost(options, root, hostFileSystem);
  const program = ts.createProgram({ rootNames: absolutePaths, options, host });
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
      const resolvedModule = ts.resolveModuleName(context.specifier, sourceFile.fileName, options, host).resolvedModule;
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


export interface SemanticPackageManifestSnapshot {
  hash: string;
  errors: string[];
  manifestCount: number;
}

export interface SemanticResolutionInput {
  containingFile: string;
  specifier: string;
}

const MAX_SEMANTIC_PACKAGE_MANIFESTS = 10_000;

function isNodeModulesPackageManifest(path: string): boolean {
  const normalized = resolve(path).replaceAll("\\", "/");
  const segments = normalized.split("/");
  return segments.at(-1) === "package.json" && segments.includes("node_modules");
}

/**
 * Fingerprint the package.json files actually consulted by TypeScript's
 * module resolver for the indexed import specifiers. This avoids scanning
 * node_modules or constructing a full TypeScript program during freshness.
 */
export function inspectSemanticPackageManifests(
  rootPath: string,
  resolutionInputs: SemanticResolutionInput[],
): SemanticPackageManifestSnapshot {
  const root = resolve(rootPath);
  const rootConfigPath = join(root, "tsconfig.json").replaceAll("\\", "/");
  let options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    allowJs: true,
    checkJs: false,
    skipLibCheck: true,
    noEmit: true,
  };
  const config = ts.readConfigFile(rootConfigPath, (path) => readConfigTextSafely(path, root));
  if (!config.error) {
    const configHost: ts.ParseConfigHost = {
      ...ts.sys,
      readFile: (path) => readConfigTextSafely(path, root),
      readDirectory: () => [],
    };
    const parsed = ts.parseJsonConfigFileContent(config.config, configHost, root, undefined, rootConfigPath);
    options = {
      ...options,
      ...parsed.options,
      allowJs: parsed.options.allowJs ?? true,
      checkJs: false,
      skipLibCheck: true,
      noEmit: true,
    };
  }

  type ManifestRead = { content: Buffer | null; failure: string | null };
  const consulted = new Map<string, ManifestRead>();
  const errors: string[] = [];
  let manifestLimitExceeded = false;
  const readManifest = (candidate: string): ManifestRead => {
    const absolute = resolve(candidate);
    const key = absolute.replaceAll("\\", "/");
    const previous = consulted.get(key);
    if (previous) return previous;
    if (consulted.size >= MAX_SEMANTIC_PACKAGE_MANIFESTS) {
      if (!manifestLimitExceeded) {
        errors.push("TypeScript semantic package-manifest inspection exceeded its safety limit.");
        manifestLimitExceeded = true;
      }
      return { content: null, failure: "safety-limit" };
    }
    let result: ManifestRead;
    try {
      result = { content: readConfigBytesSafely(absolute, root), failure: null };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unsafe-or-unreadable";
      result = { content: null, failure: code };
    }
    if (result.failure && result.failure !== "ENOENT" && result.failure !== "ENOTDIR") {
      const relativePath = relative(root, absolute).replaceAll("\\", "/");
      const displayPath = relativePath === ".." || relativePath.startsWith("../") || isAbsolute(relativePath)
        ? absolute
        : relativePath;
      errors.push(displayPath + ": TypeScript package manifest could not be safely read (" + result.failure + ").");
    }
    consulted.set(key, result);
    return result;
  };

  const host = createSafeTypeScriptHost(options, root);
  const defaultFileExists = host.fileExists.bind(host);
  const defaultReadFile = host.readFile.bind(host);
  const defaultGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (path) => isNodeModulesPackageManifest(path)
    ? readManifest(path).content !== null
    : defaultFileExists(path);
  host.readFile = (path) => {
    if (isNodeModulesPackageManifest(path)) {
      const manifest = readManifest(path);
      return manifest.content?.toString("utf8");
    }
    return defaultReadFile(path);
  };
  host.getSourceFile = (fileName, languageVersionOrOptions, onError) => {
    if (isNodeModulesPackageManifest(fileName)) {
      const manifest = readManifest(fileName);
      if (!manifest.content) return undefined;
      return ts.createSourceFile(fileName, manifest.content.toString("utf8"), languageVersionOrOptions, true);
    }
    return defaultGetSourceFile(fileName, languageVersionOrOptions, onError);
  };

  const uniqueInputs = new Map<string, SemanticResolutionInput>();
  for (const input of resolutionInputs) {
    const containingFile = resolve(root, input.containingFile);
    uniqueInputs.set(containingFile + "\0" + input.specifier, { containingFile, specifier: input.specifier });
  }
  for (const input of [...uniqueInputs.values()].sort((a, b) =>
    compareCodeUnits(a.containingFile, b.containingFile) || compareCodeUnits(a.specifier, b.specifier))) {
    ts.resolveModuleName(input.specifier, input.containingFile, options, host);
  }
  for (const typeName of options.types ?? []) {
    ts.resolveTypeReferenceDirective(typeName, join(root, "__cnm_type_reference__.ts"), options, host);
  }

  const hash = createHash("sha256");
  for (const [path, manifest] of [...consulted].sort(([a], [b]) => compareCodeUnits(a, b))) {
    hash.update(path).update("\0");
    if (manifest.content) {
      hash.update("present\0").update(manifest.content);
      const manifestText = manifest.content.toString("utf8");
      if (!Buffer.from(manifestText, "utf8").equals(manifest.content)) {
        errors.push(path + ": TypeScript package manifest is not valid UTF-8.");
      }
      try {
        const parsed: unknown = JSON.parse(manifestText);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          errors.push(path + ": TypeScript package manifest must contain a JSON object.");
        }
      } catch {
        errors.push(path + ": TypeScript package manifest contains invalid JSON.");
      }
    } else {
      hash.update(manifest.failure === "ENOENT" || manifest.failure === "ENOTDIR"
        ? "<missing>" : "<unreadable:" + (manifest.failure ?? "unknown") + ">");
    }
    hash.update("\0");
  }
  return {
    hash: hash.digest("hex"),
    errors: [...new Set(errors)].sort(compareCodeUnits),
    manifestCount: consulted.size,
  };
}
