import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readFileSync, realpathSync, statSync, type Dirent } from "node:fs";
import { basename, extname, join, relative, dirname, posix, resolve, isAbsolute } from "node:path";
import ts from "typescript";
import ignore from "ignore";
import type { ProjectLocation } from "./project.js";
import { getGitSnapshot, sameGitSnapshot } from "./git.js";
import { isSupportedSourceFile, parseTypeScriptFile } from "./typescript-parser.js";
import { analyzeImportDiagnostics } from "./import-diagnostics.js";
import type { IndexSummary } from "../shared/types.js";
import { readFileWithinRoot } from "./safe-file.js";
import { openDatabase, type MemoryDatabase } from "../storage/database.js";

function assertDirectoryIdentity(
  directory: string,
  canonicalRoot: string,
  expected?: ReturnType<typeof lstatSync>,
): ReturnType<typeof lstatSync> {
  const pathStat = lstatSync(directory);
  if (pathStat.isSymbolicLink() || !pathStat.isDirectory()) {
    throw new Error("Directory path was replaced or is not a real directory; retry indexing.");
  }
  if (expected) {
    if (pathStat.dev !== expected.dev || pathStat.ino !== expected.ino) {
      throw new Error("Directory identity changed during discovery; retry indexing.");
    }
    return pathStat;
  }
  const canonicalPath = realpathSync(directory);
  const canonicalRelative = relative(canonicalRoot, canonicalPath).replaceAll("\\", "/");
  if (canonicalRelative === ".." || canonicalRelative.startsWith("../") || isAbsolute(canonicalRelative)) {
    throw new Error("Directory path resolves outside the project root.");
  }
  const canonicalStat = statSync(canonicalPath);
  if (pathStat.dev !== canonicalStat.dev || pathStat.ino !== canonicalStat.ino) {
    throw new Error("Directory identity changed during discovery; retry indexing.");
  }
  return pathStat;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertNoSymlinkedConfigParents(candidatePath: string, projectRoot: string): void {
  const root = realpathSync(projectRoot);
  const absoluteCandidate = resolve(candidatePath);
  const relativeCandidate = relative(root, absoluteCandidate).replaceAll("\\", "/");
  // Explicit external TypeScript "extends" targets remain supported. For
  // project-local config paths, do not let a directory symlink redirect the
  // final safe read outside the lexical project tree. Package-manager links
  // under node_modules are an intentional dependency-resolution boundary.
  if (relativeCandidate === ".." || relativeCandidate.startsWith("../") ||
      isAbsolute(relativeCandidate)) return;
  const relativeParent = relative(root, dirname(absoluteCandidate)).replaceAll("\\", "/");
  let current = root;
  for (const segment of relativeParent.split("/").filter(Boolean)) {
    current = join(current, segment);
    const identity = lstatSync(current);
    const currentRelative = relative(root, current).replaceAll("\\", "/");
    if (identity.isSymbolicLink() && !currentRelative.split("/").includes("node_modules")) {
      throw new Error("Configuration path traverses a symbolic-link directory.");
    }
    if (!identity.isDirectory() && !identity.isSymbolicLink()) {
      throw new Error("Configuration parent is not a directory.");
    }
  }
}

function readConfigBytesSafely(candidatePath: string, projectRoot: string): Buffer {
  assertNoSymlinkedConfigParents(candidatePath, projectRoot);
  const root = realpathSync(projectRoot);
  const absoluteCandidate = resolve(candidatePath);
  const relativeCandidate = relative(root, absoluteCandidate).replaceAll("\\", "/");
  const external = relativeCandidate === ".." || relativeCandidate.startsWith("../") ||
    isAbsolute(relativeCandidate);
  const packageManagerPath = relativeCandidate.split("/").includes("node_modules");
  if (!external && !packageManagerPath) {
    // Keep project-local config reads rooted at the canonical project. This
    // makes a parent-directory substitution fail containment during open/read.
    const read = readFileWithinRoot(root, absoluteCandidate, {
      canonicalRoot: root,
      rejectFinalSymlink: true,
    });
    // Recheck parent components after the descriptor-bound read to detect
    // substitutions that occurred after the pre-open path inspection.
    assertNoSymlinkedConfigParents(candidatePath, projectRoot);
    return read.content;
  }
  // Explicit external "extends" paths and package-manager links under
  // node_modules remain supported as separate, intentional trust boundaries.
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

function isExtendedConfigCandidate(candidatePath: string, projectRoot: string): boolean {
  try {
    assertNoSymlinkedConfigParents(candidatePath, projectRoot);
    const candidateStat = lstatSync(candidatePath);
    // Preserve unsafe candidates for the diagnostic pass; never follow a
    // final-component symlink merely to decide which config path to inspect.
    if (candidateStat.isSymbolicLink()) return true;
    if (!candidateStat.isFile()) return false;
    readConfigBytesSafely(candidatePath, projectRoot);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    // Missing candidates are normal while trying TypeScript's extension and
    // directory fallbacks. Other failures must remain visible to freshness.
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}


const MAX_FILE_BYTES = 1_000_000;
const MAX_INDEX_DETAIL_ITEMS = 200;
const MAX_DIRECTORY_ENTRIES_FOR_SORT = 100_000;
const DEFAULT_EXCLUDES = [
  ".git", ".hg", ".svn", "node_modules", "bower_components", "vendor",
  "dist", "build", "coverage", ".next", ".nuxt", ".output", "out",
  "target", "tmp", "temp", ".idea", ".vscode", ".turbo",
  ".cache", ".vercel", ".angular", ".svelte-kit", ".pytest_cache",
];

interface DiscoveredFile {
  relativePath: string;
  size: number;
  mtime: Date;
  hash: string;
  source: string;
}

interface IgnoreScope {
  directory: string;
  rules: ReturnType<typeof ignore>;
  mandatoryRules?: ReturnType<typeof ignore>;
  error?: string;
}

interface DiscoveryResult {
  files: DiscoveredFile[];
  presentPaths: Set<string>;
  protectedDirectories: Set<string>;
  scanned: number;
  skipped: number;
  failed: number;
  truncated: boolean;
  abortRequired: boolean;
  errors: string[];
  skippedFiles: string[];
}
export interface IndexOptions {
  /** Abort and roll back if discovery, parsing, or source snapshot validation is incomplete. */
  requireCompleteSnapshot?: boolean;
  /** Exact project-relative file/directory paths. Directory selections include descendants. */
  paths?: string[];
  /** Additional project-relative glob patterns; combined with paths as an intersection. */
  include?: string[];
  /** Maximum matching source files to read and index (1-10000). */
  maxFiles?: number;
  /** Maximum directory entries examined (1-100000). */
  maxProcessed?: number;
}
function normalizeScopePaths(paths: string[] = []): string[] {
  if (paths.length > 100) throw new Error("At most 100 index scope paths are allowed.");
  return paths.map((value) => {
    const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (!normalized || normalized.length > 500 || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) ||
      normalized.split("/").some((part) => part === ".." || part === ".")) {
      throw new Error("Index scope paths must be non-empty project-relative paths (max 500 characters) without traversal.");
    }
    return normalized;
  });
}
function normalizeIncludePatterns(patterns: string[] = []): string[] {
  if (patterns.length > 100) throw new Error("At most 100 index include patterns are allowed.");
  return patterns.map((pattern) => {
    const normalized = pattern.replaceAll("\\", "/").trim();
    if (!normalized || normalized.length > 500 || normalized.startsWith("/") ||
      /^[A-Za-z]:/.test(normalized) || normalized.startsWith("!") ||
      normalized.split("/").some((part) => part === "..")) {
      throw new Error("Include patterns must be project-relative glob patterns (max 500 characters) without negation or traversal.");
    }
    return normalized;
  });
}
function validateIndexOptions(options: IndexOptions, extraExcludes: string[]): void {
  if (extraExcludes.length > 100) throw new Error("At most 100 custom exclusion patterns are allowed.");
  if (extraExcludes.some((pattern) => typeof pattern !== "string" || !pattern.trim() || pattern.length > 500)) {
    throw new Error("Custom exclusion patterns must be non-empty strings no longer than 500 characters.");
  }
  if (options.maxFiles !== undefined && (!Number.isInteger(options.maxFiles) || options.maxFiles < 1 || options.maxFiles > 10_000)) {
    throw new Error("maxFiles must be an integer between 1 and 10000.");
  }
  if (options.maxProcessed !== undefined && (!Number.isInteger(options.maxProcessed) || options.maxProcessed < 1 || options.maxProcessed > 100_000)) {
    throw new Error("maxProcessed must be an integer between 1 and 100000.");
  }
}
function isWithinIndexScope(path: string, paths: string[], includeMatcher?: ReturnType<typeof ignore>): boolean {
  const pathMatch = paths.length === 0 || paths.some((selected) =>
    path === selected || path.startsWith(selected + "/"));
  return pathMatch && (includeMatcher === undefined || includeMatcher.ignores(path));
}

function loadIgnoreRules(
  directory: string,
  isRoot = false,
  extraExcludes: string[] = [],
  canonicalRoot = realpathSync(directory),
): IgnoreScope {
  const rules = ignore();
  let mandatoryRules: ReturnType<typeof ignore> | undefined;
  let error: string | undefined;
  if (isRoot) {
    mandatoryRules = ignore().add(DEFAULT_EXCLUDES).add([".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx"]);
    if (extraExcludes.some((pattern) => pattern.trimStart().startsWith("!"))) {
      throw new Error("Custom exclusion patterns cannot use negation (leading '!').");
    }
    rules.add(extraExcludes);
  }
  try {
    const ignoreFile = readFileWithinRoot(canonicalRoot, join(directory, ".gitignore"), { canonicalRoot, rejectFinalSymlink: true });
    rules.add(ignoreFile.content.toString("utf8"));
  } catch (cause) {
    const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      const directoryPath = relative(canonicalRoot, directory).replaceAll("\\", "/") || ".";
      error = directoryPath + "/.gitignore: " + (cause instanceof Error ? cause.message : String(cause));
    }
  }
  const scope: IgnoreScope = mandatoryRules === undefined ? { directory, rules } : { directory, rules, mandatoryRules };
  return error ? { ...scope, error } : scope;
}

function isIgnored(absolutePath: string, scopes: IgnoreScope[]): boolean {
  return scopes.some(({ directory, rules, mandatoryRules }) => {
    const scopedPath = relative(directory, absolutePath).replaceAll("\\", "/");
    if (mandatoryRules && (mandatoryRules.ignores(scopedPath) || mandatoryRules.ignores(scopedPath + "/"))) return true;
    return rules.ignores(scopedPath) || rules.ignores(scopedPath + "/");
  });
}

export function discoverFiles(
  root: string,
  extraExcludes: string[] = [],
  options: IndexOptions = {},
  openDirectory: (directory: string) => ReturnType<typeof opendirSync> = opendirSync,
): DiscoveryResult {
  validateIndexOptions(options, extraExcludes);
  const canonicalRoot = realpathSync(root);
  root = canonicalRoot;
  const selectedPaths = normalizeScopePaths(options.paths);
  const includePatterns = normalizeIncludePatterns(options.include);
  const includeMatcher = includePatterns.length ? ignore().add(includePatterns) : undefined;
  const output: DiscoveredFile[] = [];
  const presentPaths = new Set<string>();
  const protectedDirectories = new Set<string>();
  const errors: string[] = [];
  const skippedFiles: string[] = [];
  let scanned = 0;
  let skipped = 0;
  let failed = 0;
  let enumeratedEntries = 0;
  let abortRequired = false;
  let truncated = false;
  let stopped = false;
  const rootScope = loadIgnoreRules(root, true, extraExcludes, canonicalRoot);
  if (rootScope.error) {
    failed += 1;
    errors.push(rootScope.error);
    protectedDirectories.add("");
    truncated = true;
    abortRequired = true;
    stopped = true;
  }
  const walk = (directory: string, parentScopes: IgnoreScope[]): void => {
    if (stopped) return;
    const directoryPath = relative(root, directory).replaceAll("\\", "/");
    let directoryIdentity: ReturnType<typeof lstatSync>;
    try {
      directoryIdentity = assertDirectoryIdentity(directory, canonicalRoot);
    } catch (error) {
      failed += 1;
      errors.push((directoryPath || ".") + ": " + (error instanceof Error ? error.message : String(error)));
      protectedDirectories.add(directoryPath);
      return;
    }
    let scopes = parentScopes;
    if (directory !== root) {
      const localScope = loadIgnoreRules(directory, false, [], canonicalRoot);
      if (localScope.error) {
        failed += 1;
        errors.push(localScope.error);
        protectedDirectories.add(directoryPath);
        return;
      }
      scopes = [...parentScopes, localScope];
    }
    let handle: ReturnType<typeof opendirSync>;
    try {
      handle = openDirectory(directory);
    } catch (error) {
      failed += 1;
      errors.push((directoryPath || ".") + ": " + (error instanceof Error ? error.message : String(error)));
      protectedDirectories.add(directoryPath);
      return;
    }
    try {
      assertDirectoryIdentity(directory, canonicalRoot, directoryIdentity);
      // Sort each directory before selecting bounded candidates. If the
      // enumeration budget is exceeded, abort the whole update rather than
      // committing a filesystem-order-dependent partial selection.
      const entries: Dirent[] = [];
      let entry: Dirent | null;
      while (!stopped && (entry = handle.readSync()) !== null) {
        assertDirectoryIdentity(directory, canonicalRoot, directoryIdentity);
        if ((options.maxProcessed !== undefined && enumeratedEntries >= options.maxProcessed) ||
            entries.length >= MAX_DIRECTORY_ENTRIES_FOR_SORT) {
          truncated = true;
          abortRequired = true;
          stopped = true;
          // Traversal stops globally, so every unvisited indexed path is
          // unobserved. Protect the entire root scope in freshness reports.
          protectedDirectories.add("");
          break;
        }
        entries.push(entry);
        enumeratedEntries += 1;
      }
      assertDirectoryIdentity(directory, canonicalRoot, directoryIdentity);
      entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const entry of entries) {
        if (stopped) break;
        assertDirectoryIdentity(directory, canonicalRoot, directoryIdentity);
        const absolutePath = join(directory, entry.name);
        const relativePath = relative(root, absolutePath).replaceAll("\\", "/");
        if (isIgnored(absolutePath, scopes)) continue;
        if (entry.isDirectory() && selectedPaths.length > 0 &&
          !selectedPaths.some((selected) => selected === relativePath || selected.startsWith(relativePath + "/") || relativePath.startsWith(selected + "/"))) continue;
        const selected = isWithinIndexScope(relativePath, selectedPaths, includeMatcher);
        if (selected && isSupportedSourceFile(relativePath) &&
          options.maxFiles !== undefined && scanned >= options.maxFiles) {
          truncated = true;
          stopped = true;
          break;
        }
        if (entry.isSymbolicLink()) {
          // A directory symlink can hide previously indexed descendants. Protect
          // its lexical scope so a full reconciliation cannot mistake those
          // records for deleted files. Never follow the link to classify it.
          protectedDirectories.add(relativePath);
          if (selected && isSupportedSourceFile(relativePath)) {
            scanned += 1;
            skipped += 1;
            skippedFiles.push(relativePath + ": symbolic link");
          }
          continue;
        }
        if (entry.isDirectory()) {
          walk(absolutePath, scopes);
          continue;
        }
        if (!entry.isFile() || !isSupportedSourceFile(relativePath) || !selected) continue;
        presentPaths.add(relativePath);
        scanned += 1;
        try {
          const canonicalPath = realpathSync(absolutePath);
          const canonicalRelative = relative(canonicalRoot, canonicalPath).replaceAll("\\", "/");
          if (canonicalRelative === ".." || canonicalRelative.startsWith("../") || isAbsolute(canonicalRelative)) {
            throw new Error("Source path resolves outside the project root.");
          }
          const descriptor = openSync(canonicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          try {
            const stat = fstatSync(descriptor);
            if (!stat.isFile()) throw new Error("Source path must reference a regular file.");
            if (stat.size > MAX_FILE_BYTES) {
              skipped += 1;
              skippedFiles.push(relativePath + ": exceeds " + MAX_FILE_BYTES + " bytes");
              continue;
            }

            const verifiedPath = realpathSync(canonicalPath);
            const verifiedRelative = relative(canonicalRoot, verifiedPath).replaceAll("\\", "/");
            if (verifiedRelative === ".." || verifiedRelative.startsWith("../") || isAbsolute(verifiedRelative)) {
              throw new Error("Opened source path resolves outside the project root.");
            }
            const pathStat = statSync(verifiedPath);
            if (stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) {
              throw new Error("Source file changed during safe open; retry indexing.");
            }

            const content = readFileSync(descriptor);
            const afterRead = fstatSync(descriptor);
            const pathAfterRead = lstatSync(absolutePath);
            if (pathAfterRead.isSymbolicLink() || pathAfterRead.dev !== stat.dev || pathAfterRead.ino !== stat.ino ||
                pathAfterRead.size !== stat.size || pathAfterRead.mtimeMs !== stat.mtimeMs ||
                afterRead.dev !== stat.dev || afterRead.ino !== stat.ino ||
                afterRead.size !== stat.size || afterRead.mtimeMs !== stat.mtimeMs) {
              throw new Error("Source path or file changed while being read; retry indexing.");
            }
            assertDirectoryIdentity(directory, canonicalRoot, directoryIdentity);
            if (content.includes(0)) { skipped += 1; skippedFiles.push(relativePath + ": binary content"); continue; }
            const source = content.toString("utf8");
            output.push({
              relativePath,
              size: stat.size,
              mtime: stat.mtime,
              hash: createHash("sha256").update(content).digest("hex"),
              source,
            });
          } finally {
            closeSync(descriptor);
          }
        } catch (error) {
          failed += 1;
          errors.push(relativePath + ": " + (error instanceof Error ? error.message : String(error)));
          protectedDirectories.add(relativePath);
        }
      }
    } catch (error) {
      failed += 1;
      errors.push((directoryPath || ".") + ": " + (error instanceof Error ? error.message : String(error)));
      protectedDirectories.add(directoryPath);
    } finally {
      try { handle.closeSync(); } catch { /* The directory may already be closed. */ }
    }
  };
  walk(root, [rootScope]);
  return {
    files: output.sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0),
    presentPaths, protectedDirectories, scanned, skipped, failed, truncated, abortRequired,
    errors: errors.sort((a, b) => compareCodeUnits(a, b)),
    skippedFiles: skippedFiles.sort((a, b) => compareCodeUnits(a, b)),
  };
}
function stableIdentifier(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function languageForExtension(extension: string): string {
  return [".js", ".jsx", ".mjs", ".cjs"].includes(extension) ? "javascript" : "typescript";
}

function clearFileIndex(db: MemoryDatabase, fileId: number): void {
  const rows = db.prepare("SELECT id FROM symbols WHERE file_id = ?").all(fileId) as Array<{ id: number }>;
  const deleteFts = db.prepare("DELETE FROM symbols_fts WHERE rowid = ?");
  for (const row of rows) deleteFts.run(row.id);
  db.prepare("DELETE FROM symbols WHERE file_id = ?").run(fileId);
  db.prepare("DELETE FROM file_imports WHERE file_id = ?").run(fileId);
  db.prepare("DELETE FROM symbol_calls WHERE file_id = ?").run(fileId);
  db.prepare("DELETE FROM symbol_heritage WHERE file_id = ?").run(fileId);
}

interface PathAliasConfig {
  configDirectory: string;
  baseUrl: string;
  paths: Record<string, readonly string[]>;
}

function loadPathAliasConfig(root: string): PathAliasConfig | undefined {
  const configPath = join(root, "tsconfig.json");
  // TypeScript compares diagnostic source paths byte-for-byte on Windows;
  // keep its internal config identity in canonical slash form.
  const typescriptConfigPath = configPath.replaceAll("\\", "/");
  const read = ts.readConfigFile(typescriptConfigPath, (path) => readConfigTextSafely(path, root));
  if (read.error) return undefined;
  const configDirectory = dirname(configPath);
  const configHost: ts.ParseConfigHost = { ...ts.sys, readFile: (path) => readConfigTextSafely(path, root), readDirectory: () => [] };
  const parsed = ts.parseJsonConfigFileContent(read.config, configHost, configDirectory, undefined, typescriptConfigPath);
  const paths = parsed.options.paths;
  if (!paths) return undefined;
  return {
    configDirectory,
    baseUrl: parsed.options.baseUrl ? resolve(parsed.options.baseUrl) : configDirectory,
    paths,
  };
}

function matchPathAlias(specifier: string, config: PathAliasConfig): string[] | undefined {
  const matches = Object.entries(config.paths).flatMap(([pattern, targets]) => {
    const wildcard = pattern.indexOf("*");
    if (wildcard < 0) return pattern === specifier ? [{ exact: true, prefixLength: pattern.length, substitution: "", targets }] : [];
    const prefix = pattern.slice(0, wildcard);
    const suffix = pattern.slice(wildcard + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix) || specifier.length < prefix.length + suffix.length) return [];
    return [{ exact: false, prefixLength: prefix.length, substitution: specifier.slice(prefix.length, specifier.length - suffix.length), targets }];
  });
  if (matches.length === 0) return undefined;
  const exact = matches.filter((match) => match.exact);
  const selected = exact.length > 0
    ? exact
    : matches.filter((match) => match.prefixLength === Math.max(...matches.map((match) => match.prefixLength)));
  return selected.flatMap((match) => match.targets.map((target) =>
    resolve(config.baseUrl, target.replace("*", match.substitution)),
  ));
}

interface LocalPackage { root: string; exports: unknown; }

function readLocalPackages(rootPath: string, files: Array<{ id: number; path: string }>): Map<string, LocalPackage[]> {
  const root = resolve(rootPath);
  const packageRoots = new Set<string>([root]);
  for (const file of files) {
    let directory = dirname(resolve(root, file.path));
    while (directory === root || directory.startsWith(root + "/") || directory.startsWith(root + "\\")) {
      packageRoots.add(directory);
      if (directory === root) break;
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  const packages = new Map<string, LocalPackage[]>();
  for (const packageRoot of [...packageRoots].sort((a, b) => compareCodeUnits(a, b))) {
    try {
      const manifest = JSON.parse(readConfigBytesSafely(join(packageRoot, "package.json"), root).toString("utf8")) as { name?: unknown; exports?: unknown };
      if (typeof manifest.name !== "string" || !manifest.name) continue;
      const entries = packages.get(manifest.name) ?? [];
      entries.push({ root: packageRoot, exports: manifest.exports });
      packages.set(manifest.name, entries);
    } catch { /* Missing or invalid package manifests are ignored. */ }
  }
  return packages;
}

function packageSpecifierParts(specifier: string): { name: string; subpath: string } | undefined {
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    if (parts.length < 2 || !parts[0] || !parts[1]) return undefined;
    return { name: parts.slice(0, 2).join("/"), subpath: parts.length > 2 ? "./" + parts.slice(2).join("/") : "." };
  }
  if (!parts[0]) return undefined;
  return { name: parts[0], subpath: parts.length > 1 ? "./" + parts.slice(1).join("/") : "." };
}

function selectConditionalExport(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const conditions = value as Record<string, unknown>;
  for (const condition of ["types", "import", "node", "default", "require"]) {
    if (condition in conditions) {
      const selected = selectConditionalExport(conditions[condition]);
      if (selected) return selected;
    }
  }
  return undefined;
}

function selectPackageExport(exportsValue: unknown, subpath: string): string | undefined {
  if (typeof exportsValue === "string") return subpath === "." ? exportsValue : undefined;
  if (!exportsValue || typeof exportsValue !== "object" || Array.isArray(exportsValue)) return undefined;
  const exportsObject = exportsValue as Record<string, unknown>;
  const hasSubpathKeys = Object.keys(exportsObject).some((key) => key.startsWith("."));
  if (!hasSubpathKeys) return subpath === "." ? selectConditionalExport(exportsObject) : undefined;
  if (subpath in exportsObject) return selectConditionalExport(exportsObject[subpath]);
  const patterns = Object.keys(exportsObject).filter((key) => key.includes("*")).map((key) => {
    const wildcard = key.indexOf("*");
    return { key, prefix: key.slice(0, wildcard), suffix: key.slice(wildcard + 1) };
  }).filter(({ prefix, suffix }) => subpath.startsWith(prefix) && subpath.endsWith(suffix) &&
    subpath.length >= prefix.length + suffix.length)
    .sort((a, b) => b.prefix.length - a.prefix.length || b.suffix.length - a.suffix.length);
  const selected = patterns[0];
  if (!selected) return undefined;
  const substitution = subpath.slice(selected.prefix.length, subpath.length - selected.suffix.length);
  return selectConditionalExport(exportsObject[selected.key])?.replace("*", substitution);
}

function resolvePackageExportBases(specifier: string, packages: Map<string, LocalPackage[]>, rootPath: string): {
  recognized: boolean; bases: string[];
} {
  const parts = packageSpecifierParts(specifier);
  if (!parts) return { recognized: false, bases: [] };
  const localPackages = packages.get(parts.name);
  if (!localPackages || !localPackages.some((localPackage) => localPackage.exports !== undefined)) {
    return { recognized: false, bases: [] };
  }
  const bases: string[] = [];
  for (const localPackage of localPackages) {
    const target = selectPackageExport(localPackage.exports, parts.subpath);
    if (!target || !target.startsWith("./")) continue;
    const absoluteTarget = resolve(localPackage.root, target);
    const relativeToPackage = relative(localPackage.root, absoluteTarget).replaceAll("\\", "/");
    if (relativeToPackage === ".." || relativeToPackage.startsWith("../") || isAbsolute(relativeToPackage) ||
      absoluteTarget === localPackage.root) continue;
    const relativeToProject = relative(rootPath, absoluteTarget).replaceAll("\\", "/");
    if (relativeToProject === ".." || relativeToProject.startsWith("../") || isAbsolute(relativeToProject)) continue;
    bases.push(relativeToProject);
  }
  return { recognized: true, bases: [...new Set(bases)] };
}

function expandSourceCandidates(base: string): string[] {
  const extension = posix.extname(base);
  const aliases = extension === ".js" ? [base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx")]
    : extension === ".jsx" ? [base.replace(/\.jsx$/, ".tsx")]
    : extension === ".mjs" ? [base.replace(/\.mjs$/, ".mts")]
    : [];
  return extension
    ? [base, ...aliases]
    : [base, ...[".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].map((ext) => base + ext),
      ...["index.ts", "index.tsx", "index.js", "index.jsx"].map((file) => `${base}/${file}`)];
}

function hasExtendedTsConfig(rootPath: string): boolean {
  const config = ts.readConfigFile(join(rootPath, "tsconfig.json"), (path) => readConfigTextSafely(path, rootPath));
  return !config.error && Boolean(config.config && typeof config.config === "object" &&
    "extends" in config.config);
}

function resolveExtendedConfigPath(configPath: string, specifier: string, projectRoot: string, visitedConfigPaths: Set<string>): string {
  const absoluteSpecifier = isAbsolute(specifier);
  const relativeSpecifier = specifier.startsWith(".") || absoluteSpecifier;
  if (relativeSpecifier) {
    const base = absoluteSpecifier ? resolve(specifier) : resolve(dirname(configPath), specifier);
    const candidates = /\\.json$/i.test(base) ? [base] : [base, base + ".json", join(base, "tsconfig.json")];
    return candidates.find((candidate) => isExtendedConfigCandidate(candidate, projectRoot)) ?? candidates[0]!;
  }

  const parts = specifier.split("/");
  const packageName = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  const subpath = parts.slice(specifier.startsWith("@") ? 2 : 1).join("/");
  let directory = dirname(configPath);
  while (true) {
    const packageRoot = join(directory, "node_modules", packageName);
    const packageJson = join(packageRoot, "package.json");
    if (!subpath) visitedConfigPaths.add(resolve(packageJson));
    const candidates = subpath
      ? (/\\.json$/i.test(subpath)
          ? [join(packageRoot, subpath)]
          : [join(packageRoot, subpath), join(packageRoot, subpath + ".json"), join(packageRoot, subpath, "tsconfig.json")])
      : [join(packageRoot, "tsconfig.json")];
    try {
      if (!subpath) {
        const manifestValue: unknown = JSON.parse(readConfigBytesSafely(packageJson, projectRoot).toString("utf8"));
        if (!manifestValue || typeof manifestValue !== "object" || Array.isArray(manifestValue)) {
          // Keep malformed metadata in the traversal so freshness can report it.
          candidates.unshift(packageJson);
        } else {
          const manifest = manifestValue as { tsconfig?: unknown };
          if (typeof manifest.tsconfig === "string" && manifest.tsconfig.trim()) {
            candidates.unshift(join(packageRoot, manifest.tsconfig));
          } else if ("tsconfig" in manifest && typeof manifest.tsconfig !== "string") {
            candidates.unshift(packageJson);
          }
        }
      }
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "ENOENT" && code !== "ENOTDIR") candidates.unshift(packageJson);
    }
    const resolved = candidates.find((candidate) => isExtendedConfigCandidate(candidate, projectRoot));
    if (resolved) return resolved;
    const parent = dirname(directory);
    if (parent === directory) return candidates[0]!;
    directory = parent;
  }
}

function collectExtendedConfigPaths(rootPath: string): string[] {
  const rootConfig = resolve(rootPath, "tsconfig.json");
  const visited = new Set<string>();
  const visit = (configPath: string): void => {
    const normalized = resolve(configPath);
    if (visited.has(normalized)) return;
    visited.add(normalized);
    let config: unknown;
    try {
      const read = ts.readConfigFile(normalized, (path) => readConfigTextSafely(path, rootPath));
      config = read.config;
    } catch {
      return;
    }
    if (!config || typeof config !== "object" || !("extends" in config)) return;
    const value = (config as { extends?: unknown }).extends;
    const specifiers = Array.isArray(value) ? value : [value];
    for (const specifier of specifiers) {
      if (typeof specifier === "string" && specifier.trim()) {
        visit(resolveExtendedConfigPath(normalized, specifier, rootPath, visited));
      }
    }
  };
  visit(rootConfig);
  return [...visited].sort((a, b) => compareCodeUnits(a, b));
}

function inspectRelationsConfig(rootPath: string, files: Array<{ path: string }>): string[] {
  const packageDirectories = new Set<string>([""]);
  for (const file of files) {
    let directory = posix.dirname(file.path.replaceAll("\\", "/"));
    while (directory !== "." && directory !== "") {
      packageDirectories.add(directory);
      directory = posix.dirname(directory);
    }
  }
  const diagnostics: string[] = [];
  const reportReadFailure = (path: string, error: unknown): void => {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unsafe-or-unreadable";
    if (code === "ENOENT" && (path === resolve(rootPath, "tsconfig.json") || basename(path) === "package.json")) return;
    diagnostics.push(relative(rootPath, path).replaceAll("\\", "/") + ": configuration could not be safely read (" + code + ").");
  };

  for (const directory of [...packageDirectories].sort(compareCodeUnits)) {
    const path = directory
      ? resolve(rootPath, ...directory.split("/"), "package.json")
      : resolve(rootPath, "package.json");
    try {
      const parsed: unknown = JSON.parse(readConfigBytesSafely(path, rootPath).toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        diagnostics.push(relative(rootPath, path).replaceAll("\\", "/") + ": package configuration must contain a JSON object.");
      }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        diagnostics.push(relative(rootPath, path).replaceAll("\\", "/") + ": package configuration is invalid or unreadable.");
      }
    }
  }

  const rootConfig = resolve(rootPath, "tsconfig.json");
  for (const path of collectExtendedConfigPaths(rootPath)) {
    let text: string;
    try {
      text = readConfigBytesSafely(path, rootPath).toString("utf8");
    } catch (error) {
      reportReadFailure(path, error);
      continue;
    }
    const normalizedPath = path.replaceAll("\\", "/");
    const parsed = ts.parseConfigFileTextToJson(normalizedPath, text);
    if (parsed.error) {
      diagnostics.push(relative(rootPath, path).replaceAll("\\", "/") +
        (basename(path) === "package.json" ? ": invalid package configuration (" : ": invalid TypeScript configuration (") +
        ts.flattenDiagnosticMessageText(parsed.error.messageText, " ") + ").");
    } else if (basename(path) === "package.json") {
      const manifest = parsed.config as { tsconfig?: unknown } | null;
      if (manifest && typeof manifest === "object" && "tsconfig" in manifest &&
          (typeof manifest.tsconfig !== "string" || !manifest.tsconfig.trim())) {
        diagnostics.push(relative(rootPath, path).replaceAll("\\", "/") +
          ": invalid TypeScript extends package metadata (tsconfig must be a non-empty string).");
      }
    } else if (!parsed.config || typeof parsed.config !== "object" || Array.isArray(parsed.config)) {
      diagnostics.push(relative(rootPath, path).replaceAll("\\", "/") + ": TypeScript configuration must contain a JSON object.");
    }
  }
  return [...new Set(diagnostics)].sort(compareCodeUnits);
}

function computeRelationsConfigHash(rootPath: string, files: Array<{ path: string }>): string {
  const packageDirectories = new Set<string>([""]);
  for (const file of files) {
    let directory = posix.dirname(file.path.replaceAll("\\", "/"));
    while (directory !== "." && directory !== "") {
      packageDirectories.add(directory);
      directory = posix.dirname(directory);
    }
  }
  const configPaths = [
    ...[...packageDirectories].map((directory) =>
      directory ? resolve(rootPath, ...directory.split("/"), "package.json") : resolve(rootPath, "package.json")),
    ...collectExtendedConfigPaths(rootPath),
  ].sort((a, b) => compareCodeUnits(a, b));
  const hash = createHash("sha256");
  for (const absoluteConfigPath of configPaths) {
    const relativeConfigPath = relative(rootPath, absoluteConfigPath).replaceAll("\\", "/");
    const configIdentity = relativeConfigPath === ".." || relativeConfigPath.startsWith("../") || isAbsolute(relativeConfigPath)
      ? absoluteConfigPath
      : relativeConfigPath;
    hash.update(configIdentity).update("\\0");
    try {
      hash.update(readConfigBytesSafely(absoluteConfigPath, rootPath));
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
      hash.update(code === "ENOENT" ? "<missing>" : `<unreadable:${code}>`);
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

function rebuildRelations(db: MemoryDatabase, rootPath: string, indexRevision: number): number {
  db.prepare("DELETE FROM relations").run();
  const files = db.prepare("SELECT id, path FROM files").all() as Array<{ id: number; path: string }>;
  const byPath = new Map(files.map((file) => [file.path, file.id]));
  const fileById = new Map(files.map((file) => [file.id, file.path]));
  const insertRelation = db.prepare(`
    INSERT OR IGNORE INTO relations(source_kind, source_id, target_kind, target_id, kind, confidence, provenance, index_revision)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.prepare("DELETE FROM unresolved_imports").run();
  const insertUnresolved = db.prepare(`
    INSERT INTO unresolved_imports(source_file_id, module_specifier, status, candidates_json)
    VALUES (?, ?, ?, ?)
  `);
  const aliasConfig = loadPathAliasConfig(rootPath);
  const localPackages = readLocalPackages(rootPath, files);
  const resolveImportCandidates = (sourcePath: string, specifier: string): {
    recognized: boolean; candidates: Array<{ id: number; path: string }>;
  } => {
    let bases: string[];
    let recognized = true;
    if (specifier.startsWith(".")) {
      bases = [posix.normalize(posix.join(posix.dirname(sourcePath), specifier))];
    } else {
      const targets = aliasConfig ? matchPathAlias(specifier, aliasConfig) : undefined;
      if (targets) {
        bases = targets.flatMap((target) => {
          const candidate = relative(rootPath, target).replaceAll("\\", "/");
          return candidate === ".." || candidate.startsWith("../") || isAbsolute(candidate) ? [] : [candidate];
        });
      } else {
        const packageResolution = resolvePackageExportBases(specifier, localPackages, rootPath);
        recognized = packageResolution.recognized;
        bases = packageResolution.bases;
      }
    }
    const candidates = [...new Set(bases.flatMap(expandSourceCandidates))];
    return { recognized, candidates: candidates.flatMap((candidate) => {
      const id = byPath.get(candidate);
      return id === undefined ? [] : [{ id, path: candidate }];
    }) };
  };

  const resolvedImportTargets = new Map<string, number[]>();
  const imports = db.prepare("SELECT file_id, module_specifier FROM file_imports ORDER BY file_id, module_specifier").all() as Array<{ file_id: number; module_specifier: string }>;
  for (const item of imports) {
    const sourcePath = fileById.get(item.file_id);
    if (!sourcePath) continue;
    const resolution = resolveImportCandidates(sourcePath, item.module_specifier);
    if (!resolution.recognized) continue;
    const candidates = resolution.candidates.filter((candidate) => candidate.id !== item.file_id);
    if (candidates.length === 1) {
      resolvedImportTargets.set(`${item.file_id}:${item.module_specifier}`, [candidates[0]!.id]);
      insertRelation.run("file", item.file_id, "file", candidates[0]!.id, "IMPORTS", 1, "typescript-ast", indexRevision);
    } else {
      insertUnresolved.run(
        item.file_id,
        item.module_specifier,
        candidates.length === 0 ? "unresolved" : "ambiguous",
        JSON.stringify(candidates.map((candidate) => candidate.path).sort((a, b) => compareCodeUnits(a, b))),
      );
    }
  }

  const calls = db.prepare("SELECT file_id, caller_name, callee_name, module_specifier, imported_symbol_name FROM symbol_calls").all() as Array<{
    file_id: number;
    caller_name: string;
    callee_name: string;
    module_specifier: string | null;
    imported_symbol_name: string | null;
  }>;
  const symbols = db.prepare("SELECT id, file_id, name, exported FROM symbols").all() as Array<{
    id: number; file_id: number; name: string; exported: number;
  }>;
  const symbolMap = new Map<string, number>();
  const shortNames = new Map<string, number | null>();
  const exportedNames = new Map<string, number | null>();
  for (const symbol of symbols) {
    symbolMap.set(`${symbol.file_id}:${symbol.name}`, symbol.id);
    const shortKey = `${symbol.file_id}:${symbol.name.split(".").at(-1)}`;
    shortNames.set(shortKey, shortNames.has(shortKey) ? null : symbol.id);
    if (symbol.exported) {
      const exportedKey = `${symbol.file_id}:${symbol.name}`;
      exportedNames.set(exportedKey, exportedNames.has(exportedKey) ? null : symbol.id);
    }
  }

  const heritageRows = db.prepare("SELECT file_id, owner_name, relation_kind, target_name, module_specifier, imported_name FROM symbol_heritage").all() as Array<{
    file_id: number; owner_name: string; relation_kind: "EXTENDS" | "IMPLEMENTS";
    target_name: string; module_specifier: string | null; imported_name: string | null;
  }>;
  for (const heritage of heritageRows) {
    const sourceId = symbolMap.get(`${heritage.file_id}:${heritage.owner_name}`);
    if (sourceId === undefined) continue;
    let targetId: number | null | undefined;
    if (heritage.module_specifier && heritage.imported_name) {
      const targetFiles = resolvedImportTargets.get(`${heritage.file_id}:${heritage.module_specifier}`) ?? [];
      if (targetFiles.length !== 1) continue;
      targetId = exportedNames.get(`${targetFiles[0]}:${heritage.imported_name}`);
    } else {
      targetId = shortNames.get(`${heritage.file_id}:${heritage.target_name}`);
    }
    if (targetId !== undefined && targetId !== null && targetId !== sourceId) {
      insertRelation.run("symbol", sourceId, "symbol", targetId, heritage.relation_kind, 1, "typescript-ast-heritage", indexRevision);
    }
  }

  for (const call of calls) {
    const sourceId = symbolMap.get(`${call.file_id}:${call.caller_name}`);
    if (sourceId === undefined) continue;

    if (call.module_specifier && call.imported_symbol_name) {
      const targetFiles = resolvedImportTargets.get(`${call.file_id}:${call.module_specifier}`) ?? [];
      if (targetFiles.length !== 1) continue;
      const targetId = exportedNames.get(`${targetFiles[0]}:${call.imported_symbol_name}`);
      if (targetId !== undefined && targetId !== null && targetId !== sourceId) {
        insertRelation.run("symbol", sourceId, "symbol", targetId, "CALLS", 0.95, "typescript-ast-import-binding", indexRevision);
      }
      continue;
    }

    const targetId = shortNames.get(`${call.file_id}:${call.callee_name}`) ?? undefined;
    if (targetId !== undefined && targetId !== sourceId) {
      insertRelation.run("symbol", sourceId, "symbol", targetId, "CALLS", 0.95, "typescript-ast", indexRevision);
    }
  }
  db.prepare("DELETE FROM import_diagnostics").run();
  const insertImportDiagnostic = db.prepare(`
    INSERT OR IGNORE INTO import_diagnostics(
      source_file_id, module_specifier, diagnostic_code, kind, message, line, column_number, imported_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const importDiagnostics = analyzeImportDiagnostics(
    rootPath,
    files.map((file) => file.path),
    new Set(localPackages.keys()),
  );
  for (const diagnostic of importDiagnostics) {
    const sourceFileId = byPath.get(diagnostic.filePath);
    if (sourceFileId === undefined) continue;
    insertImportDiagnostic.run(
      sourceFileId, diagnostic.moduleSpecifier, diagnostic.code, diagnostic.kind,
      diagnostic.message, diagnostic.line, diagnostic.column, diagnostic.importedName,
    );
  }
  return (db.prepare("SELECT COUNT(*) AS count FROM relations").get() as { count: number }).count;
}


export interface IndexFreshness {
  status: "not-indexed" | "current" | "stale" | "incomplete";
  indexRevision: number;
  checkedFiles: number;
  addedFiles: number;
  changedFiles: number;
  deletedFiles: number;
  relationsConfigChanged: boolean;
  fileChanges: Array<{ path: string; status: "added" | "changed" | "deleted"; oldHash: string | null; newHash: string | null }>;
  fileChangesTotal: number;
  fileChangesTruncated: boolean;
  skippedFiles: string[];
  errors: string[];
  limits: { detailItems: number };
  totals: { skippedFiles: number; errors: number };
  truncated: { skippedFiles: boolean; errors: boolean };
  git: {
    status: "unavailable" | "unrecorded" | "current" | "changed";
    indexedCommit: string | null;
    currentCommit: string | null;
    indexedBranch: string | null;
    currentBranch: string | null;
    indexedDirty: boolean | null;
    currentDirty: boolean | null;
    indexedChangedPathCount: number | null;
    currentChangedPathCount: number | null;
    commitChanged: boolean;
    branchChanged: boolean;
    workingTreeChanged: boolean;
  };
}

const MAX_FRESHNESS_DETAIL_ITEMS = 200;

type IndexedGitMetadata = {
  indexed_commit: string | null;
  indexed_branch: string | null;
  indexed_worktree_dirty: number | null;
  indexed_worktree_status_hash: string | null;
  indexed_worktree_changed_paths: number | null;
};

function gitFreshness(project: IndexedGitMetadata, current: ReturnType<typeof getGitSnapshot>): IndexFreshness["git"] {
  const recorded = project.indexed_worktree_status_hash !== null;
  const available = current.available;
  const commitChanged = available && recorded && project.indexed_commit !== current.commit;
  const branchChanged = available && recorded && project.indexed_branch !== current.branch;
  const workingTreeChanged = available && recorded && project.indexed_worktree_status_hash !== current.statusHash;
  const status = !available ? "unavailable" : !recorded ? "unrecorded"
    : commitChanged || branchChanged || workingTreeChanged ? "changed" : "current";
  return {
    status,
    indexedCommit: project.indexed_commit,
    currentCommit: current.commit,
    indexedBranch: project.indexed_branch,
    currentBranch: current.branch,
    indexedDirty: project.indexed_worktree_dirty === null ? null : project.indexed_worktree_dirty !== 0,
    currentDirty: current.dirty,
    indexedChangedPathCount: project.indexed_worktree_changed_paths,
    currentChangedPathCount: current.changedPathCount,
    commitChanged,
    branchChanged,
    workingTreeChanged,
  };
}

/** @internal Optional discovery injection is reserved for deterministic filesystem-failure tests. */
export function getIndexFreshness(
  location: ProjectLocation,
  discover: (rootPath: string, explicitExcludes: string[]) => DiscoveryResult = discoverFiles,
): IndexFreshness {
  const db = openDatabase(location);
  try {
    const project = db.prepare("SELECT last_indexed_at, index_revision, index_excludes_json, relations_config_hash, indexed_commit, indexed_branch, indexed_worktree_dirty, indexed_worktree_status_hash, indexed_worktree_changed_paths FROM projects WHERE id = ?").get(location.id) as ({
      last_indexed_at: string | null; index_revision: number; index_excludes_json: string; relations_config_hash: string | null;
    } & IndexedGitMetadata) | undefined;
    if (!project) throw new Error("This repository has not been initialized. Run `cnm init` first.");
    const currentGit = getGitSnapshot(location.rootPath);
    const git = gitFreshness(project, currentGit);
    if (!project.last_indexed_at) {
      return { status: "not-indexed", indexRevision: project.index_revision, checkedFiles: 0, addedFiles: 0,
        changedFiles: 0, deletedFiles: 0, relationsConfigChanged: false, fileChanges: [], fileChangesTotal: 0, fileChangesTruncated: false,
        skippedFiles: [], errors: [], limits: { detailItems: MAX_FRESHNESS_DETAIL_ITEMS }, totals: { skippedFiles: 0, errors: 0 }, truncated: { skippedFiles: false, errors: false }, git };
    }
    const excludes = JSON.parse(project.index_excludes_json) as string[];
    const discovery = discover(location.rootPath, excludes);
    const indexed = db.prepare("SELECT path, content_hash FROM files ORDER BY path").all() as Array<{ path: string; content_hash: string }>;
    const indexedByPath = new Map(indexed.map((file) => [file.path, file.content_hash]));
    const relationsConfigChanged = computeRelationsConfigHash(location.rootPath, indexed) !== project.relations_config_hash;
    const relationsConfigErrors = inspectRelationsConfig(location.rootPath, indexed);
    let addedFiles = 0;
    let changedFiles = 0;
    let deletedFiles = 0;
    const fileChanges: IndexFreshness["fileChanges"] = [];
    for (const file of discovery.files) {
      const oldHash = indexedByPath.get(file.relativePath);
      if (oldHash === undefined) {
        addedFiles += 1;
        fileChanges.push({ path: file.relativePath, status: "added", oldHash: null, newHash: file.hash });
      } else if (oldHash !== file.hash) {
        changedFiles += 1;
        fileChanges.push({ path: file.relativePath, status: "changed", oldHash, newHash: file.hash });
      }
    }
    for (const file of indexed) {
      if (discovery.presentPaths.has(file.path)) continue;
      const protectedByReadFailure = [...discovery.protectedDirectories].some((directory) =>
        directory === "" || file.path === directory || file.path.startsWith(directory + "/"));
      if (!protectedByReadFailure) {
        deletedFiles += 1;
        fileChanges.push({ path: file.path, status: "deleted", oldHash: file.content_hash, newHash: null });
      }
    }
    fileChanges.sort((a, b) => compareCodeUnits(a.path, b.path) || compareCodeUnits(a.status, b.status));
    const gitMetadataUnavailable = git.status === "unavailable" && project.indexed_worktree_status_hash !== null;
    const incomplete = discovery.failed > 0 || discovery.skipped > 0 || discovery.truncated || discovery.abortRequired ||
      discovery.protectedDirectories.size > 0 || gitMetadataUnavailable || relationsConfigErrors.length > 0;
    const stale = addedFiles > 0 || changedFiles > 0 || deletedFiles > 0 || relationsConfigChanged || git.status === "changed" || git.status === "unrecorded";
    const freshnessErrors = [...discovery.errors, ...relationsConfigErrors].sort(compareCodeUnits);
    return {
      status: incomplete ? "incomplete" : stale ? "stale" : "current",
      indexRevision: project.index_revision,
      checkedFiles: discovery.scanned,
      addedFiles, changedFiles, deletedFiles, relationsConfigChanged,
      fileChanges: fileChanges.slice(0, MAX_FRESHNESS_DETAIL_ITEMS),
      fileChangesTotal: fileChanges.length,
      fileChangesTruncated: fileChanges.length > MAX_FRESHNESS_DETAIL_ITEMS,
      skippedFiles: discovery.skippedFiles.slice(0, MAX_FRESHNESS_DETAIL_ITEMS),
      errors: freshnessErrors.slice(0, MAX_FRESHNESS_DETAIL_ITEMS),
      limits: { detailItems: MAX_FRESHNESS_DETAIL_ITEMS },
      totals: { skippedFiles: discovery.skippedFiles.length, errors: freshnessErrors.length },
      truncated: {
        skippedFiles: discovery.skippedFiles.length > MAX_FRESHNESS_DETAIL_ITEMS,
        errors: freshnessErrors.length > MAX_FRESHNESS_DETAIL_ITEMS,
      },
      git,
    };
  } finally {
    db.close();
  }
}

export function indexProject(
  location: ProjectLocation,
  force = false,
  extraExcludes?: string[],
  options: IndexOptions = {},
): IndexSummary {
  const db = openDatabase(location);
  try {
    const excludes = extraExcludes ?? (() => {
      const row = db.prepare("SELECT index_excludes_json FROM projects WHERE id = ?").get(location.id) as { index_excludes_json: string } | undefined;
      return row ? JSON.parse(row.index_excludes_json) as string[] : [];
    })();
    const selective = Boolean(options.paths?.length || options.include?.length ||
      options.maxFiles !== undefined || options.maxProcessed !== undefined);
    return indexWithDatabase(db, location, force, excludes, {
      ...options,
      requireCompleteSnapshot: options.requireCompleteSnapshot ?? !selective,
    });
  } finally {
    db.close();
  }
}

/** Reconcile the working tree using the project's persisted exclusion rules. */
export function updateProjectIndex(location: ProjectLocation, options: IndexOptions = {}): IndexSummary {
  const db = openDatabase(location);
  try {
    const row = db.prepare("SELECT index_excludes_json FROM projects WHERE id = ?").get(location.id) as { index_excludes_json: string } | undefined;
    if (!row) throw new Error("This repository has not been initialized. Run `cnm init` first.");
    const excludes = JSON.parse(row.index_excludes_json) as string[];
    const selective = Boolean(options.paths?.length || options.include?.length ||
      options.maxFiles !== undefined || options.maxProcessed !== undefined);
    return indexWithDatabase(db, location, false, excludes, {
      ...options,
      requireCompleteSnapshot: options.requireCompleteSnapshot ?? !selective,
    });
  } finally {
    db.close();
  }
}

function sameDiscoveredSnapshot(left: DiscoveryResult, right: DiscoveryResult): boolean {
  if (left.failed !== 0 || left.skipped !== 0 || left.truncated || left.protectedDirectories.size !== 0 ||
      right.failed !== 0 || right.skipped !== 0 || right.truncated || right.protectedDirectories.size !== 0) return false;
  if (left.files.length !== right.files.length) return false;
  return left.files.every((file, index) =>
    file.relativePath === right.files[index]?.relativePath && file.hash === right.files[index]?.hash);
}

export function indexWithDatabase(
  db: MemoryDatabase,
  location: ProjectLocation,
  force = false,
  extraExcludes: string[] = [],
  options: IndexOptions = {},
  /** @internal Deterministic config-drift fault injection for tests only. */
  afterConfigPreflight?: () => void,
): IndexSummary {
  validateIndexOptions(options, extraExcludes);
  const gitBefore = getGitSnapshot(location.rootPath);
  const discovery = discoverFiles(location.rootPath, extraExcludes, options);
  const scoped = Boolean(options.paths?.length || options.include?.length ||
    options.maxFiles !== undefined || options.maxProcessed !== undefined);
  if (discovery.abortRequired) {
    throw new Error("Index update aborted: discovery could not safely complete; no index changes were committed.");
  }
  if (options.requireCompleteSnapshot &&
      (discovery.failed > 0 || discovery.skipped > 0 || discovery.truncated || discovery.protectedDirectories.size > 0)) {
    throw new Error("Index update aborted: source discovery is incomplete; no index changes were committed. Resolve skipped or unreadable files and retry.");
  }
  const { files: discovered, presentPaths } = discovery;
  const indexedConfigPaths = (db.prepare("SELECT path FROM files ORDER BY path").all() as Array<{ path: string }>)
    .map((file) => file.path);
  const configScopeFiles = scoped
    ? [...new Set([...indexedConfigPaths, ...discovered.map((file) => file.relativePath)])]
        .sort(compareCodeUnits).map((path) => ({ path }))
    : discovered.map((file) => ({ path: file.relativePath }));
  const initialRelationsConfigHash = computeRelationsConfigHash(location.rootPath, configScopeFiles);
  const configErrors = inspectRelationsConfig(location.rootPath, configScopeFiles);
  if (configErrors.length > 0) {
    throw new Error("Index update aborted: relation configuration is incomplete; no index changes were committed. " +
      configErrors.slice(0, MAX_INDEX_DETAIL_ITEMS).join(" "));
  }
  afterConfigPreflight?.();
  return db.transaction(() => {
    const projectState = db.prepare("SELECT relations_config_hash FROM projects WHERE id = ?").get(location.id) as {
      relations_config_hash: string | null;
    } | undefined;
    if (!projectState) throw new Error("Project record is missing; run cnm init first.");
    db.prepare("UPDATE projects SET index_excludes_json = ? WHERE id = ?").run(JSON.stringify(extraExcludes), location.id);
    const existing = db.prepare("SELECT id, stable_id, path, content_hash FROM files").all() as Array<{
      id: number; stable_id: string; path: string; content_hash: string;
    }>;
    const existingByPath = new Map(existing.map((file) => [file.path, file]));
    const summary: IndexSummary = {
      scanned: discovery.scanned, added: 0, updated: 0, unchanged: 0, deleted: 0,
      symbols: 0, relations: 0, skipped: discovery.skipped, failed: discovery.failed,
      errors: [...discovery.errors], skippedFiles: [...discovery.skippedFiles],
      totals: { errors: discovery.failed, skippedFiles: discovery.skipped },
      limits: { detailItems: MAX_INDEX_DETAIL_ITEMS },
      detailsTruncated: { errors: false, skippedFiles: false },
      truncated: discovery.truncated,
    };

    const updateFile = db.transaction((file: DiscoveredFile, oldFile?: { id: number; stable_id: string; path: string; content_hash: string }) => {
      const extension = extname(file.relativePath).toLowerCase();
      let fileId: number;
      if (oldFile) {
        fileId = oldFile.id;
        clearFileIndex(db, fileId);
        db.prepare(`UPDATE files SET extension = ?, language = ?, content_hash = ?, size_bytes = ?, modified_at = ?, indexed_at = ? WHERE id = ?`)
          .run(extension, languageForExtension(extension), file.hash, file.size, file.mtime.toISOString(), new Date().toISOString(), fileId);
      } else {
        const result = db.prepare(`INSERT INTO files(stable_id, path, extension, language, content_hash, size_bytes, modified_at, indexed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(stableIdentifier(["file", file.relativePath]), file.relativePath, extension, languageForExtension(extension), file.hash, file.size, file.mtime.toISOString(), new Date().toISOString());
        fileId = Number(result.lastInsertRowid);
      }

      const parsed = parseTypeScriptFile(file.relativePath, file.source);
      const insertSymbol = db.prepare(`INSERT INTO symbols(stable_id, file_id, name, kind, signature, start_line, end_line, exported)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertFts = db.prepare(`INSERT INTO symbols_fts(rowid, name, signature, file_path, kind) VALUES (?, ?, ?, ?, ?)`);
      const symbolOccurrences = new Map<string, number>();
      const fileStableId = oldFile?.stable_id ?? stableIdentifier(["file", file.relativePath]);
      for (const symbol of parsed.symbols) {
        const identity = JSON.stringify([fileStableId, symbol.name, symbol.kind, symbol.signature]);
        const occurrence = symbolOccurrences.get(identity) ?? 0;
        symbolOccurrences.set(identity, occurrence + 1);
        const symbolStableId = stableIdentifier(["symbol", fileStableId, symbol.name, symbol.kind, symbol.signature, occurrence]);
        const result = insertSymbol.run(symbolStableId, fileId, symbol.name, symbol.kind, symbol.signature, symbol.startLine, symbol.endLine, symbol.exported ? 1 : 0);
        insertFts.run(Number(result.lastInsertRowid), symbol.name, symbol.signature, file.relativePath, symbol.kind);
      }
      const insertImport = db.prepare("INSERT OR IGNORE INTO file_imports(file_id, module_specifier) VALUES (?, ?)");
      for (const specifier of parsed.imports) insertImport.run(fileId, specifier);
      const insertCall = db.prepare("INSERT OR IGNORE INTO symbol_calls(file_id, caller_name, callee_name, module_specifier, imported_symbol_name) VALUES (?, ?, ?, ?, ?)");
      const insertHeritage = db.prepare("INSERT INTO symbol_heritage(file_id, owner_name, relation_kind, target_name, module_specifier, imported_name) VALUES (?, ?, ?, ?, ?, ?)");
      for (const item of parsed.heritage) {
        insertHeritage.run(fileId, item.ownerName, item.relationKind, item.targetName, item.moduleSpecifier ?? null, item.importedName ?? null);
      }
      for (const call of parsed.calls) {
        if (call.callerName) {
          insertCall.run(fileId, call.callerName, call.calleeName, call.moduleSpecifier ?? null, call.importedSymbolName ?? null);
        }
      }
    });

    for (const file of discovered) {
      const oldFile = existingByPath.get(file.relativePath);
      if (!force && oldFile?.content_hash === file.hash) {
        summary.unchanged += 1;
        continue;
      }
      try {
        updateFile(file, oldFile);
        if (oldFile) summary.updated += 1;
        else summary.added += 1;
      } catch (error) {
        summary.failed += 1;
        summary.errors.push(file.relativePath + ": " + (error instanceof Error ? error.message : String(error)));
        if (options.requireCompleteSnapshot) {
          throw new Error("Index update aborted while parsing " + file.relativePath + "; no index changes were committed.");
        }
      }
    }

    const removeFile = db.transaction((fileId: number) => {
      clearFileIndex(db, fileId);
      db.prepare("DELETE FROM files WHERE id = ?").run(fileId);
    });
    for (const file of existing) {
      const isProtected = [...discovery.protectedDirectories].some((directory) =>
        directory === "" || file.path === directory || file.path.startsWith(directory + "/"),
      );
      if (!scoped && !presentPaths.has(file.path) && !isProtected) {
        removeFile(file.id);
        summary.deleted += 1;
      }
    }

    db.prepare("UPDATE projects SET index_revision = index_revision + 1 WHERE id = ?").run(location.id);
    const revisionRow = db.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number } | undefined;
    if (!revisionRow) throw new Error("Project record is missing; run cnm init first.");
    // Relationship resolution and import diagnostics depend on source files and
    // package/TypeScript configuration. Rebuild only when one of those inputs changed.
    const sourceIndexChanged = summary.added > 0 || summary.updated > 0 || summary.deleted > 0;
    const configFiles = db.prepare("SELECT path FROM files ORDER BY path").all() as Array<{ path: string }>;
    const currentRelationsConfigHash = computeRelationsConfigHash(location.rootPath, configFiles);
    // Extended configs may resolve outside the project tree; until their full
    // transitive dependency graph is fingerprinted, conservatively rebuild.
    const relationsNeedRebuild = sourceIndexChanged || hasExtendedTsConfig(location.rootPath) ||
      currentRelationsConfigHash !== projectState.relations_config_hash;
    if (relationsNeedRebuild) {
      summary.relations = rebuildRelations(db, location.rootPath, revisionRow.index_revision);
    } else {
      // Keep graph revision metadata aligned without re-resolving every import,
      // call, package export, and diagnostic for an unchanged source snapshot.
      db.prepare("UPDATE relations SET index_revision = ?").run(revisionRow.index_revision);
      summary.relations = (db.prepare("SELECT COUNT(*) AS count FROM relations").get() as { count: number }).count;
    }
    const verifiedRelationsConfigHash = computeRelationsConfigHash(location.rootPath, configScopeFiles);
    if (verifiedRelationsConfigHash !== initialRelationsConfigHash) {
      throw new Error("Index update aborted: relation configuration changed during indexing; no index changes were committed. Retry the update.");
    }
    db.prepare("UPDATE projects SET relations_config_hash = ? WHERE id = ?").run(currentRelationsConfigHash, location.id);
    summary.symbols = (db.prepare("SELECT COUNT(*) AS count FROM symbols").get() as { count: number }).count;
    if (options.requireCompleteSnapshot) {
      const finalDiscovery = discoverFiles(location.rootPath, extraExcludes, options);
      if (!sameDiscoveredSnapshot(discovery, finalDiscovery)) {
        throw new Error("Index update aborted: source files changed or discovery became incomplete during reconciliation; no index changes were committed. Retry the update.");
      }
    }
    const gitAfter = getGitSnapshot(location.rootPath);
    if (!sameGitSnapshot(gitBefore, gitAfter)) {
      throw new Error("Git repository state changed during indexing; rerun `cnm index` to capture a consistent snapshot.");
    }
    const now = new Date().toISOString();
    db.prepare("UPDATE projects SET last_indexed_at = ?, indexed_commit = ?, indexed_branch = ?, indexed_worktree_dirty = ?, indexed_worktree_status_hash = ?, indexed_worktree_changed_paths = ? WHERE id = ?")
      .run(now, gitAfter.available ? gitAfter.commit : null, gitAfter.available ? gitAfter.branch : null,
        gitAfter.available && gitAfter.dirty !== null ? (gitAfter.dirty ? 1 : 0) : null,
        gitAfter.available ? gitAfter.statusHash : null, gitAfter.available ? gitAfter.changedPathCount : null, location.id);
    summary.errors.sort((a, b) => compareCodeUnits(a, b));
    summary.skippedFiles.sort((a, b) => compareCodeUnits(a, b));
    summary.totals = { errors: summary.failed, skippedFiles: summary.skipped };
    summary.limits = { detailItems: MAX_INDEX_DETAIL_ITEMS };
    summary.detailsTruncated = {
      errors: summary.errors.length > MAX_INDEX_DETAIL_ITEMS,
      skippedFiles: summary.skippedFiles.length > MAX_INDEX_DETAIL_ITEMS,
    };
    summary.errors = summary.errors.slice(0, MAX_INDEX_DETAIL_ITEMS);
    summary.skippedFiles = summary.skippedFiles.slice(0, MAX_INDEX_DETAIL_ITEMS);
    return summary;
  })();
}
