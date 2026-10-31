import Database from "better-sqlite3";
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
      indexed_commit TEXT
    );

    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      PRIMARY KEY (file_id, caller_name, callee_name)
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
      UNIQUE(source_kind, source_id, target_kind, target_id, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_kind, target_id, kind);
    CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_kind, source_id, kind);

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmed',
      source_path TEXT,
      commit_sha TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
    CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
  `);

  db.prepare(`INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?)`).run(new Date().toISOString());
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
