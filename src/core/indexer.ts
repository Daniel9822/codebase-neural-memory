import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, dirname, posix } from "node:path";
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

function loadIgnoreRules(root: string) {
  const rules = ignore().add(DEFAULT_EXCLUDES);
  try {
    rules.add(readFileSync(join(root, ".gitignore"), "utf8"));
  } catch {
    // A missing .gitignore is normal.
  }
  rules.add([".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx"]);
  return rules;
}

function discoverFiles(root: string): DiscoveredFile[] {
  const rules = loadIgnoreRules(root);
  const output: DiscoveredFile[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(root, absolutePath).replaceAll("\\", "/");
      if (rules.ignores(relativePath) || rules.ignores(`${relativePath}/`)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!entry.isFile() || !isSupportedSourceFile(relativePath)) continue;
      const stat = statSync(absolutePath);
      if (stat.size > MAX_FILE_BYTES) continue;
      const source = readFileSync(absolutePath, "utf8");
      output.push({
        relativePath,
        size: stat.size,
        mtime: stat.mtime,
        hash: createHash("sha256").update(source).digest("hex"),
        source,
      });
    }
  };
  walk(root);
  return output.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
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
}

function rebuildRelations(db: MemoryDatabase): number {
  db.prepare("DELETE FROM relations").run();
  const files = db.prepare("SELECT id, path FROM files").all() as Array<{ id: number; path: string }>;
  const byPath = new Map(files.map((file) => [file.path, file.id]));
  const fileById = new Map(files.map((file) => [file.id, file.path]));
  const insertRelation = db.prepare(`
    INSERT OR IGNORE INTO relations(source_kind, source_id, target_kind, target_id, kind, confidence, provenance)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const resolveImport = (sourcePath: string, specifier: string): number | undefined => {
    if (!specifier.startsWith(".")) return undefined;
    const base = posix.normalize(posix.join(posix.dirname(sourcePath), specifier));
    const extension = posix.extname(base);
    const aliases = extension === ".js" ? [base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx")]
      : extension === ".jsx" ? [base.replace(/\.jsx$/, ".tsx")]
      : extension === ".mjs" ? [base.replace(/\.mjs$/, ".mts")]
      : [];
    const candidates = extension
      ? [base, ...aliases]
      : [base, ...[".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].map((ext) => base + ext),
        ...["index.ts", "index.tsx", "index.js", "index.jsx"].map((file) => `${base}/${file}`)];
    for (const candidate of candidates) {
      const found = byPath.get(candidate);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  const imports = db.prepare("SELECT file_id, module_specifier FROM file_imports").all() as Array<{ file_id: number; module_specifier: string }>;
  for (const item of imports) {
    const sourcePath = fileById.get(item.file_id);
    if (!sourcePath) continue;
    const targetId = resolveImport(sourcePath, item.module_specifier);
    if (targetId !== undefined && targetId !== item.file_id) {
      insertRelation.run("file", item.file_id, "file", targetId, "IMPORTS", 1, "typescript-ast");
    }
  }

  const calls = db.prepare("SELECT file_id, caller_name, callee_name FROM symbol_calls").all() as Array<{
    file_id: number; caller_name: string; callee_name: string;
  }>;
  const symbols = db.prepare("SELECT id, file_id, name FROM symbols").all() as Array<{ id: number; file_id: number; name: string }>;
  const symbolMap = new Map<string, number>();
  const shortNames = new Map<string, number | null>();
  for (const symbol of symbols) {
    symbolMap.set(`${symbol.file_id}:${symbol.name}`, symbol.id);
    const shortKey = `${symbol.file_id}:${symbol.name.split(".").at(-1)}`;
    shortNames.set(shortKey, shortNames.has(shortKey) ? null : symbol.id);
  }
  for (const call of calls) {
    const sourceId = symbolMap.get(`${call.file_id}:${call.caller_name}`);
    const targetId = shortNames.get(`${call.file_id}:${call.callee_name}`) ?? undefined;
    if (sourceId !== undefined && targetId !== undefined && sourceId !== targetId) {
      insertRelation.run("symbol", sourceId, "symbol", targetId, "CALLS", 0.95, "typescript-ast");
    }
  }
  return (db.prepare("SELECT COUNT(*) AS count FROM relations").get() as { count: number }).count;
}

export function indexProject(location: ProjectLocation, force = false): IndexSummary {
  const db = openDatabase(location);
  try {
    return indexWithDatabase(db, location, force);
  } finally {
    db.close();
  }
}

export function indexWithDatabase(db: MemoryDatabase, location: ProjectLocation, force = false): IndexSummary {
  const discovered = discoverFiles(location.rootPath);
  const existing = db.prepare("SELECT id, path, content_hash FROM files").all() as Array<{
    id: number; path: string; content_hash: string;
  }>;
  const existingByPath = new Map(existing.map((file) => [file.path, file]));
  const foundPaths = new Set(discovered.map((file) => file.relativePath));
  const summary: IndexSummary = { scanned: discovered.length, added: 0, updated: 0, unchanged: 0, deleted: 0, symbols: 0, relations: 0 };

  const updateFile = db.transaction((file: DiscoveredFile, oldFile?: { id: number; path: string; content_hash: string }) => {
    const extension = extname(file.relativePath).toLowerCase();
    let fileId: number;
    if (oldFile) {
      fileId = oldFile.id;
      clearFileIndex(db, fileId);
      db.prepare(`UPDATE files SET extension = ?, language = ?, content_hash = ?, size_bytes = ?, modified_at = ?, indexed_at = ? WHERE id = ?`)
        .run(extension, languageForExtension(extension), file.hash, file.size, file.mtime.toISOString(), new Date().toISOString(), fileId);
    } else {
      const result = db.prepare(`INSERT INTO files(path, extension, language, content_hash, size_bytes, modified_at, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(file.relativePath, extension, languageForExtension(extension), file.hash, file.size, file.mtime.toISOString(), new Date().toISOString());
      fileId = Number(result.lastInsertRowid);
    }

    const parsed = parseTypeScriptFile(file.relativePath, file.source);
    const insertSymbol = db.prepare(`INSERT INTO symbols(file_id, name, kind, signature, start_line, end_line, exported)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insertFts = db.prepare(`INSERT INTO symbols_fts(rowid, name, signature, file_path, kind) VALUES (?, ?, ?, ?, ?)`);
    for (const symbol of parsed.symbols) {
      const result = insertSymbol.run(fileId, symbol.name, symbol.kind, symbol.signature, symbol.startLine, symbol.endLine, symbol.exported ? 1 : 0);
      insertFts.run(Number(result.lastInsertRowid), symbol.name, symbol.signature, file.relativePath, symbol.kind);
    }
    const insertImport = db.prepare("INSERT OR IGNORE INTO file_imports(file_id, module_specifier) VALUES (?, ?)");
    for (const specifier of parsed.imports) insertImport.run(fileId, specifier);
    const insertCall = db.prepare("INSERT OR IGNORE INTO symbol_calls(file_id, caller_name, callee_name) VALUES (?, ?, ?)");
    for (const call of parsed.calls) {
      if (call.callerName) insertCall.run(fileId, call.callerName, call.calleeName);
    }
  });

  for (const file of discovered) {
    const oldFile = existingByPath.get(file.relativePath);
    if (!force && oldFile?.content_hash === file.hash) {
      summary.unchanged += 1;
      continue;
    }
    updateFile(file, oldFile);
    if (oldFile) summary.updated += 1;
    else summary.added += 1;
  }

  const removeFile = db.transaction((fileId: number) => {
    clearFileIndex(db, fileId);
    db.prepare("DELETE FROM files WHERE id = ?").run(fileId);
  });
  for (const file of existing) {
    if (!foundPaths.has(file.path)) {
      removeFile(file.id);
      summary.deleted += 1;
    }
  }

  summary.relations = rebuildRelations(db);
  summary.symbols = (db.prepare("SELECT COUNT(*) AS count FROM symbols").get() as { count: number }).count;
  const now = new Date().toISOString();
  db.prepare("UPDATE projects SET last_indexed_at = ? WHERE id = ?").run(now, location.id);
  return summary;
}
