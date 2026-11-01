import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ProjectLocation } from "../core/project.js";

export type MemoryDatabase = InstanceType<typeof Database>;

export function openDatabase(location: ProjectLocation): MemoryDatabase {
  mkdirSync(dirname(location.databasePath), { recursive: true });
  const db = new Database(location.databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db: MemoryDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      root_path TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_indexed_at TEXT,
      indexed_commit TEXT,
      indexed_branch TEXT,
      indexed_worktree_dirty INTEGER,
      indexed_worktree_status_hash TEXT,
      indexed_worktree_changed_paths INTEGER,
      index_revision INTEGER NOT NULL DEFAULT 0,
      index_excludes_json TEXT NOT NULL DEFAULT '[]',
      relations_config_hash TEXT
    );

    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stable_id TEXT,
      path TEXT NOT NULL UNIQUE,
      extension TEXT NOT NULL,
      language TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      modified_at TEXT NOT NULL,
      indexed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stable_id TEXT,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      signature TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      exported INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
      name, signature, file_path UNINDEXED, kind UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 2'
    );

    CREATE TABLE IF NOT EXISTS file_imports (
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      module_specifier TEXT NOT NULL,
      PRIMARY KEY (file_id, module_specifier)
    );

    CREATE TABLE IF NOT EXISTS symbol_calls (
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      caller_name TEXT NOT NULL,
      callee_name TEXT NOT NULL,
      module_specifier TEXT,
      imported_symbol_name TEXT,
      PRIMARY KEY (file_id, caller_name, callee_name)
    );

    CREATE TABLE IF NOT EXISTS symbol_heritage (
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      owner_name TEXT NOT NULL,
      relation_kind TEXT NOT NULL CHECK(relation_kind IN ('EXTENDS', 'IMPLEMENTS')),
      target_name TEXT NOT NULL,
      module_specifier TEXT,
      imported_name TEXT
    );

    CREATE TABLE IF NOT EXISTS relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_kind TEXT NOT NULL,
      source_id INTEGER NOT NULL,
      target_kind TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      provenance TEXT NOT NULL,
      index_revision INTEGER NOT NULL DEFAULT 0,
      UNIQUE(source_kind, source_id, target_kind, target_id, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_kind, target_id, kind);
    CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_kind, source_id, kind);

    CREATE TABLE IF NOT EXISTS unresolved_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      module_specifier TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('unresolved', 'ambiguous')),
      candidates_json TEXT NOT NULL DEFAULT '[]',
      UNIQUE(source_file_id, module_specifier)
    );
    CREATE INDEX IF NOT EXISTS idx_unresolved_imports_source ON unresolved_imports(source_file_id);

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmed',
      source_path TEXT,
      commit_sha TEXT,
      source_hash TEXT,
      author TEXT,
      updated_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
    CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
  `);

  const now = new Date().toISOString();
  db.prepare(`INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?)`).run(now);
  db.prepare(`INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, ?)`).run(now);

  const callColumns = db.prepare("PRAGMA table_info(symbol_calls)").all() as Array<{ name: string }>;
  const callColumnNames = new Set(callColumns.map((column) => column.name));
  if (!callColumnNames.has("module_specifier")) {
    db.exec("ALTER TABLE symbol_calls ADD COLUMN module_specifier TEXT");
  }
  if (!callColumnNames.has("imported_symbol_name")) {
    db.exec("ALTER TABLE symbol_calls ADD COLUMN imported_symbol_name TEXT");
  }
  db.prepare(`INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (3, ?)`).run(now);
  db.prepare(`INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (4, ?)`).run(now);

  const fileColumns = db.prepare("PRAGMA table_info(files)").all() as Array<{ name: string }>;
  const fileColumnNames = new Set(fileColumns.map((column) => column.name));
  if (!fileColumnNames.has("stable_id")) db.exec("ALTER TABLE files ADD COLUMN stable_id TEXT");

  const symbolColumns = db.prepare("PRAGMA table_info(symbols)").all() as Array<{ name: string }>;
  const symbolColumnNames = new Set(symbolColumns.map((column) => column.name));
  if (!symbolColumnNames.has("stable_id")) db.exec("ALTER TABLE symbols ADD COLUMN stable_id TEXT");

  const stableId = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const legacyFiles = db.prepare("SELECT id, path FROM files WHERE stable_id IS NULL ORDER BY path").all() as Array<{ id: number; path: string }>;
  const updateFileId = db.prepare("UPDATE files SET stable_id = ? WHERE id = ?");
  for (const file of legacyFiles) updateFileId.run(stableId(["file", file.path.replaceAll("\\", "/")]), file.id);

  const legacySymbols = db.prepare(`
    SELECT s.id, s.file_id, s.name, s.kind, s.signature
    FROM symbols s WHERE s.stable_id IS NULL ORDER BY s.file_id, s.name, s.kind, s.signature, s.id
  `).all() as Array<{ id: number; file_id: number; name: string; kind: string; signature: string }>;
  const fileStableIds = new Map((db.prepare("SELECT id, stable_id FROM files").all() as Array<{ id: number; stable_id: string }>).map((file) => [file.id, file.stable_id]));
  const occurrences = new Map<string, number>();
  const updateSymbolId = db.prepare("UPDATE symbols SET stable_id = ? WHERE id = ?");
  for (const symbol of legacySymbols) {
    const fileStableId = fileStableIds.get(symbol.file_id);
    if (!fileStableId) continue;
    const identity = JSON.stringify([fileStableId, symbol.name, symbol.kind, symbol.signature]);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    updateSymbolId.run(stableId(["symbol", fileStableId, symbol.name, symbol.kind, symbol.signature, occurrence]), symbol.id);
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_files_stable_id ON files(stable_id) WHERE stable_id IS NOT NULL");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_symbols_stable_id ON symbols(stable_id) WHERE stable_id IS NOT NULL");
  db.prepare(`INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (5, ?)`).run(now);

  const projectColumns = db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
  if (!projectColumns.some((column) => column.name === "index_revision")) {
    db.exec("ALTER TABLE projects ADD COLUMN index_revision INTEGER NOT NULL DEFAULT 0");
  }
  const relationColumns = db.prepare("PRAGMA table_info(relations)").all() as Array<{ name: string }>;
  if (!relationColumns.some((column) => column.name === "index_revision")) {
    db.exec("ALTER TABLE relations ADD COLUMN index_revision INTEGER NOT NULL DEFAULT 0");
  }
  db.prepare(`INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (6, ?)`).run(now);
  const latestProjectColumns = db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
  if (!latestProjectColumns.some((column) => column.name === "index_excludes_json")) {
    db.exec("ALTER TABLE projects ADD COLUMN index_excludes_json TEXT NOT NULL DEFAULT '[]'");
  }
  db.prepare(`INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (7, ?)`).run(now);

  const memoryColumns = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  if (!memoryColumns.some((column) => column.name === "source_hash")) {
    db.exec("ALTER TABLE memories ADD COLUMN source_hash TEXT");
  }
  db.prepare(`INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (8, ?)`).run(now);

  const latestMemoryColumns = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  if (!latestMemoryColumns.some((column) => column.name === "author")) {
    db.exec("ALTER TABLE memories ADD COLUMN author TEXT");
  }
  if (!latestMemoryColumns.some((column) => column.name === "updated_by")) {
    db.exec("ALTER TABLE memories ADD COLUMN updated_by TEXT");
  }
  db.prepare(`INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (9, ?)`).run(now);

  const gitProjectColumns = db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
  const gitProjectColumnNames = new Set(gitProjectColumns.map((column) => column.name));
  if (!gitProjectColumnNames.has("indexed_branch")) {
    db.exec("ALTER TABLE projects ADD COLUMN indexed_branch TEXT");
  }
  if (!gitProjectColumnNames.has("indexed_worktree_dirty")) {
    db.exec("ALTER TABLE projects ADD COLUMN indexed_worktree_dirty INTEGER");
  }
  if (!gitProjectColumnNames.has("indexed_worktree_status_hash")) {
    db.exec("ALTER TABLE projects ADD COLUMN indexed_worktree_status_hash TEXT");
  }
  if (!gitProjectColumnNames.has("indexed_worktree_changed_paths")) {
    db.exec("ALTER TABLE projects ADD COLUMN indexed_worktree_changed_paths INTEGER");
  }
  db.prepare(`INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (10, ?)`).run(now);

  db.exec(`
    CREATE TABLE IF NOT EXISTS import_diagnostics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      module_specifier TEXT NOT NULL,
      diagnostic_code INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('missing-package', 'missing-export')),
      message TEXT NOT NULL,
      line INTEGER NOT NULL,
      column_number INTEGER NOT NULL,
      imported_name TEXT,
      UNIQUE(source_file_id, module_specifier, diagnostic_code, line, column_number)
    );
    CREATE INDEX IF NOT EXISTS idx_import_diagnostics_source ON import_diagnostics(source_file_id);
  `);
  db.prepare(`INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (11, ?)`).run(now);

  const relationConfigColumns = db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
  if (!relationConfigColumns.some((column) => column.name === "relations_config_hash")) {
    db.exec("ALTER TABLE projects ADD COLUMN relations_config_hash TEXT");
  }
  db.prepare(`INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (12, ?)`).run(now);
}

export function ensureProject(db: MemoryDatabase, location: ProjectLocation): void {
  const now = new Date().toISOString();
  const name = location.rootPath.split(/[\\/]/).filter(Boolean).at(-1) || "project";
  db.prepare(`
    INSERT INTO projects(id, root_path, name, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET root_path = excluded.root_path, name = excluded.name
  `).run(location.id, location.rootPath, name, now);
}
