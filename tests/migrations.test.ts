import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate, type MemoryDatabase } from "../src/storage/database.js";

let database: MemoryDatabase | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe("database migrations", () => {
  it("upgrades a version 6 database through the latest schema and preserves existing project data", () => {
    database = new Database(":memory:") as MemoryDatabase;
    database.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, root_path TEXT NOT NULL, name TEXT NOT NULL,
        created_at TEXT NOT NULL, last_indexed_at TEXT, indexed_commit TEXT,
        index_revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_kind TEXT NOT NULL, source_id INTEGER NOT NULL,
        target_kind TEXT NOT NULL, target_id INTEGER NOT NULL,
        kind TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1.0,
        provenance TEXT NOT NULL, index_revision INTEGER NOT NULL DEFAULT 0,
        UNIQUE(source_kind, source_id, target_kind, target_id, kind)
      );
      INSERT INTO projects(id, root_path, name, created_at, index_revision)
      VALUES ('legacy-project', '/repo', 'repo', '2026-01-01T00:00:00.000Z', 6);
      INSERT INTO schema_migrations(version, applied_at)
      VALUES (1, 'old'), (2, 'old'), (3, 'old'), (4, 'old'), (5, 'old'), (6, 'old');
    `);

    migrate(database);

    const columns = database.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string; dflt_value: string | null }>;
    expect(columns.find((column) => column.name === "index_excludes_json")?.dflt_value).toBe("'[]'");
    expect(database.prepare("SELECT id, index_revision, index_excludes_json FROM projects").get()).toEqual({
      id: "legacy-project", index_revision: 6, index_excludes_json: "[]",
    });
    expect(database.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }, { version: 12 }, { version: 13 },
    ]);
  });

  it("keeps the v9 migration idempotent and adds memory author provenance", () => {
    database = new Database(":memory:") as MemoryDatabase;
    migrate(database);
    migrate(database);
    for (const version of [8, 9, 10, 11, 12, 13]) expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = ?").get(version)).toEqual({ count: 1 });
    expect(database.prepare("PRAGMA table_info(projects)").all()
      .filter((column: any) => column.name === "index_excludes_json")).toHaveLength(1);
    const memoryColumns = database.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
    for (const name of ["source_hash", "author", "updated_by"]) expect(memoryColumns.some((column) => column.name === name)).toBe(true);
    const diagnosticColumns = database.prepare("PRAGMA table_info(import_diagnostics)").all() as Array<{ name: string }>;
    for (const name of ["source_file_id", "module_specifier", "diagnostic_code", "kind", "message", "line", "column_number", "imported_name"]) {
      expect(diagnosticColumns.some((column) => column.name === name)).toBe(true);
    }
    const projectColumns = database.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
    for (const name of ["indexed_branch", "indexed_worktree_dirty", "indexed_worktree_status_hash", "indexed_worktree_changed_paths"]) {
      expect(projectColumns.some((column) => column.name === name)).toBe(true);
    }
    expect(projectColumns.some((column) => column.name === "relations_config_hash")).toBe(true);
  });

  it("assigns legacy backfill to the database project when projects is still empty", () => {
    database = new Database(":memory:") as MemoryDatabase;
    const databaseProjectId = "project-derived-from-database-location";
    migrate(database, databaseProjectId);

    database.prepare(`
      INSERT INTO memories
        (id, category, title, content, status, created_at, updated_at)
      VALUES ('legacy-without-project-row', 'decision', 'Legacy title', 'Legacy content',
        'confirmed', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
    `).run();

    // Recreate the pre-v13 state with no projects row, as on first open of an
    // older per-project database before ensureProject has run.
    database.exec(`
      DROP TABLE knowledge_events;
      DROP TABLE knowledge_relations;
      DROP TABLE knowledge_evidence;
      DROP TABLE knowledge_fragments;
      DROP TABLE knowledge_versions;
      DROP TABLE knowledge_items;
      DROP TABLE memory_idempotency;
      DELETE FROM schema_migrations WHERE version = 13;
    `);

    migrate(database, databaseProjectId);

    expect(database.prepare(
      "SELECT project_id FROM knowledge_items WHERE id = 'legacy-without-project-row'"
    ).get()).toEqual({ project_id: databaseProjectId });
    expect(database.prepare(
      "SELECT project_id FROM knowledge_events WHERE knowledge_id = 'legacy-without-project-row'"
    ).get()).toEqual({ project_id: databaseProjectId });
    expect(database.prepare("SELECT COUNT(*) AS count FROM projects").get()).toEqual({ count: 0 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
