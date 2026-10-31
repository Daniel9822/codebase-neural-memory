import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { extname, join, relative, dirname, posix, resolve, isAbsolute } from "node:path";
import ts from "typescript";
import ignore from "ignore";
import type { ProjectLocation } from "./project.js";
import { isSupportedSourceFile, parseTypeScriptFile } from "./typescript-parser.js";
import type { IndexSummary } from "../shared/types.js";
import { openDatabase, type MemoryDatabase } from "../storage/database.js";

const MAX_FILE_BYTES = 1_000_000;
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
}

interface DiscoveryResult {
  files: DiscoveredFile[];
  presentPaths: Set<string>;
  protectedDirectories: Set<string>;
  scanned: number;
  skipped: number;
  failed: number;
  errors: string[];
  skippedFiles: string[];
}

function loadIgnoreRules(directory: string, isRoot = false, extraExcludes: string[] = []): IgnoreScope {
  const rules = ignore();
  let mandatoryRules: ReturnType<typeof ignore> | undefined;
  if (isRoot) {
    mandatoryRules = ignore().add(DEFAULT_EXCLUDES).add([".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx"]);
    if (extraExcludes.some((pattern) => pattern.trimStart().startsWith("!"))) {
      throw new Error("Custom exclusion patterns cannot use negation (leading '!').");
    }
    rules.add(extraExcludes);
  }
  try {
    rules.add(readFileSync(join(directory, ".gitignore"), "utf8"));
  } catch {
    // A missing .gitignore is normal.
  }
  return mandatoryRules === undefined ? { directory, rules } : { directory, rules, mandatoryRules };
}

function isIgnored(absolutePath: string, scopes: IgnoreScope[]): boolean {
  return scopes.some(({ directory, rules, mandatoryRules }) => {
    const scopedPath = relative(directory, absolutePath).replaceAll("\\", "/");
    if (mandatoryRules && (mandatoryRules.ignores(scopedPath) || mandatoryRules.ignores(scopedPath + "/"))) return true;
    return rules.ignores(scopedPath) || rules.ignores(scopedPath + "/");
  });
}

function discoverFiles(root: string, extraExcludes: string[] = []): DiscoveryResult {
  const output: DiscoveredFile[] = [];
  const presentPaths = new Set<string>();
  const protectedDirectories = new Set<string>();
  const errors: string[] = [];
  const skippedFiles: string[] = [];
  let scanned = 0;
  let skipped = 0;
  let failed = 0;
  const rootScope = loadIgnoreRules(root, true, extraExcludes);
  const walk = (directory: string, parentScopes: IgnoreScope[]): void => {
    const directoryPath = relative(root, directory).replaceAll("\\", "/");
    const scopes = directory === root ? parentScopes : [...parentScopes, loadIgnoreRules(directory)];
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      failed += 1;
      errors.push((directoryPath || ".") + ": " + (error instanceof Error ? error.message : String(error)));
      protectedDirectories.add(directoryPath);
      return;
    }
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(root, absolutePath).replaceAll("\\", "/");
      if (isIgnored(absolutePath, scopes)) continue;
      if (entry.isSymbolicLink()) {
        if (isSupportedSourceFile(relativePath)) {
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
      if (!entry.isFile() || !isSupportedSourceFile(relativePath)) continue;
      presentPaths.add(relativePath);
      scanned += 1;
      try {
        const stat = statSync(absolutePath);
        if (stat.size > MAX_FILE_BYTES) { skipped += 1; skippedFiles.push(relativePath + ": exceeds " + MAX_FILE_BYTES + " bytes"); continue; }
        const content = readFileSync(absolutePath);
        if (content.includes(0)) { skipped += 1; skippedFiles.push(relativePath + ": binary content"); continue; }
        const source = content.toString("utf8");
        output.push({
          relativePath,
          size: stat.size,
          mtime: stat.mtime,
          hash: createHash("sha256").update(content).digest("hex"),
          source,
        });
      } catch (error) {
        failed += 1;
        errors.push(relativePath + ": " + (error instanceof Error ? error.message : String(error)));
      }
    }
  };
  walk(root, [rootScope]);
  return {
    files: output.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    presentPaths, protectedDirectories, scanned, skipped, failed, errors, skippedFiles,
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
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) return undefined;
  const configDirectory = dirname(configPath);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, configDirectory, undefined, configPath);
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
  for (const packageRoot of [...packageRoots].sort((a, b) => a.localeCompare(b))) {
    try {
      const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { name?: unknown; exports?: unknown };
      if (typeof manifest.name !== "string" || !manifest.name || manifest.exports === undefined) continue;
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
  if (!localPackages) return { recognized: false, bases: [] };
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

function rebuildRelations(db: MemoryDatabase, rootPath: string): number {
  db.prepare("DELETE FROM relations").run();
  const files = db.prepare("SELECT id, path FROM files").all() as Array<{ id: number; path: string }>;
  const byPath = new Map(files.map((file) => [file.path, file.id]));
  const fileById = new Map(files.map((file) => [file.id, file.path]));
  const insertRelation = db.prepare(`
    INSERT OR IGNORE INTO relations(source_kind, source_id, target_kind, target_id, kind, confidence, provenance)
    VALUES (?, ?, ?, ?, ?, ?, ?)
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
      insertRelation.run("file", item.file_id, "file", candidates[0]!.id, "IMPORTS", 1, "typescript-ast");
    } else {
      insertUnresolved.run(
        item.file_id,
        item.module_specifier,
        candidates.length === 0 ? "unresolved" : "ambiguous",
        JSON.stringify(candidates.map((candidate) => candidate.path).sort((a, b) => a.localeCompare(b))),
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
      insertRelation.run("symbol", sourceId, "symbol", targetId, heritage.relation_kind, 1, "typescript-ast-heritage");
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
        insertRelation.run("symbol", sourceId, "symbol", targetId, "CALLS", 0.95, "typescript-ast-import-binding");
      }
      continue;
    }

    const targetId = shortNames.get(`${call.file_id}:${call.callee_name}`) ?? undefined;
    if (targetId !== undefined && targetId !== sourceId) {
      insertRelation.run("symbol", sourceId, "symbol", targetId, "CALLS", 0.95, "typescript-ast");
    }
  }
  return (db.prepare("SELECT COUNT(*) AS count FROM relations").get() as { count: number }).count;
}

export function indexProject(location: ProjectLocation, force = false, extraExcludes: string[] = []): IndexSummary {
  const db = openDatabase(location);
  try {
    return indexWithDatabase(db, location, force, extraExcludes);
  } finally {
    db.close();
  }
}

export function indexWithDatabase(db: MemoryDatabase, location: ProjectLocation, force = false, extraExcludes: string[] = []): IndexSummary {
  const discovery = discoverFiles(location.rootPath, extraExcludes);
  const { files: discovered, presentPaths } = discovery;
  return db.transaction(() => {
    const existing = db.prepare("SELECT id, stable_id, path, content_hash FROM files").all() as Array<{
      id: number; stable_id: string; path: string; content_hash: string;
    }>;
    const existingByPath = new Map(existing.map((file) => [file.path, file]));
    const summary: IndexSummary = {
      scanned: discovery.scanned, added: 0, updated: 0, unchanged: 0, deleted: 0,
      symbols: 0, relations: 0, skipped: discovery.skipped, failed: discovery.failed,
      errors: [...discovery.errors], skippedFiles: [...discovery.skippedFiles],
    };

    const updateFile = db.transaction((file: DiscoveredFile, oldFile?: { id: number; path: string; content_hash: string }) => {
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
      if (!presentPaths.has(file.path) && !isProtected) {
        removeFile(file.id);
        summary.deleted += 1;
      }
    }

    summary.relations = rebuildRelations(db, location.rootPath);
    summary.symbols = (db.prepare("SELECT COUNT(*) AS count FROM symbols").get() as { count: number }).count;
    const now = new Date().toISOString();
    db.prepare("UPDATE projects SET last_indexed_at = ? WHERE id = ?").run(now, location.id);
    return summary;
  })();
}
