import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate, type MemoryDatabase } from "../src/storage/database.js";

let database: MemoryDatabase | undefined;
let temporaryDirectory: string | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
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

  it("rolls back partial v13 DDL and retries the legacy backfill after a failed migration", () => {
    database = new Database(":memory:") as MemoryDatabase;
    const projectId = "migration-retry-project";
    migrate(database, projectId);
    database.prepare(`
      INSERT INTO memories
        (id, category, title, content, status, author, created_at, updated_at)
      VALUES ('retry-legacy-memory', 'decision', 'Retry title', 'Retry content', 'confirmed',
        'legacy-author', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
    `).run();

    // Recreate the pre-v13 schema and introduce a conflicting partial table to
    // force the v13 transactional DDL/backfill to fail after schema creation starts.
    database.exec(`
      DROP TABLE knowledge_events;
      DROP TABLE knowledge_relations;
      DROP TABLE knowledge_evidence;
      DROP TABLE knowledge_fragments;
      DROP TABLE knowledge_versions;
      DROP TABLE knowledge_items;
      DROP TABLE memory_idempotency;
      DELETE FROM schema_migrations WHERE version = 13;
      CREATE TABLE knowledge_items (id TEXT PRIMARY KEY);
    `);

    expect(() => migrate(database!, projectId)).toThrow(/no (such )?column: project_id/i);
    expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 13").get())
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_versions'").get())
      .toBeUndefined();
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_events'").get())
      .toBeUndefined();

    // Removing the conflicting partial table permits a clean retry. The legacy
    // source row remains untouched and is imported exactly once.
    database.exec("DROP TABLE knowledge_items");
    migrate(database, projectId);
    expect(database.prepare("SELECT version FROM schema_migrations WHERE version = 13").get())
      .toEqual({ version: 13 });
    expect(database.prepare("SELECT id, project_id FROM knowledge_items WHERE id = 'retry-legacy-memory'").get())
      .toEqual({ id: "retry-legacy-memory", project_id: projectId });
    expect(database.prepare("SELECT title, version_number FROM knowledge_versions WHERE knowledge_id = 'retry-legacy-memory'").get())
      .toEqual({ title: "Retry title", version_number: 1 });
    expect(database.prepare("SELECT content FROM knowledge_fragments WHERE version_id = 'legacy-v1:retry-legacy-memory'").get())
      .toEqual({ content: "Retry content" });
    expect(database.prepare("SELECT event_type FROM knowledge_events WHERE knowledge_id = 'retry-legacy-memory'").get())
      .toEqual({ event_type: "legacy_import" });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });


  it("preserves every legacy lifecycle mapping and keeps unknown statuses pending validation", () => {
    database = new Database(":memory:") as MemoryDatabase;
    const projectId = "legacy-status-matrix-project";
    migrate(database, projectId);
    const statuses = [
      { id: "legacy-confirmed", status: "confirmed", lifecycle: "active", epistemic: "user_asserted" },
      { id: "legacy-proposed", status: "proposed", lifecycle: "active", epistemic: "pending_validation" },
      { id: "legacy-obsolete", status: "obsolete", lifecycle: "superseded", epistemic: "pending_validation" },
      { id: "legacy-rejected", status: "rejected", lifecycle: "archived", epistemic: "pending_validation" },
      { id: "legacy-unknown", status: "custom_legacy_state", lifecycle: "active", epistemic: "pending_validation" },
    ] as const;
    const insert = database.prepare(`
      INSERT INTO memories
        (id, category, title, content, status, source_path, source_hash, commit_sha, author, updated_by, created_at, updated_at)
      VALUES (?, 'decision', ?, ?, ?, ?, ?, ?, 'legacy-author', 'legacy-updater',
        '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
    `);
    for (const item of statuses) {
      insert.run(item.id, `Title for ${item.id}`, `Content for ${item.id}`, item.status,
        item.id === "legacy-confirmed" ? "src/legacy.ts" : null,
        item.id === "legacy-confirmed" ? "legacy-source-hash" : null,
        item.id === "legacy-confirmed" ? "legacy-commit" : null);
    }
    const legacyBefore = database.prepare(`
      SELECT id, category, title, content, status, source_path, source_hash, commit_sha,
        author, updated_by, created_at, updated_at FROM memories ORDER BY id
    `).all();

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
    migrate(database, projectId);

    const migrated = database.prepare(`
      SELECT i.id, i.lifecycle, i.legacy_status, v.epistemic_state AS epistemicState,
        v.title, f.content
      FROM knowledge_items i
      JOIN knowledge_versions v ON v.id = i.current_version_id AND v.knowledge_id = i.id
      JOIN knowledge_fragments f ON f.version_id = v.id AND f.ordinal = 0
      ORDER BY i.id
    `).all();
    const expected = [...statuses]
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
      .map(item => ({
        id: item.id, lifecycle: item.lifecycle, legacy_status: item.status,
        epistemicState: item.epistemic, title: `Title for ${item.id}`, content: `Content for ${item.id}`,
      }));
    expect(migrated).toEqual(expected);
    expect(database.prepare(`
      SELECT id, category, title, content, status, source_path, source_hash, commit_sha,
        author, updated_by, created_at, updated_at FROM memories ORDER BY id
    `).all()).toEqual(legacyBefore);
    expect(database.prepare("SELECT COUNT(*) AS count FROM knowledge_items").get()).toEqual({ count: 5 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM knowledge_versions").get()).toEqual({ count: 5 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM knowledge_fragments").get()).toEqual({ count: 5 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM knowledge_events WHERE event_type='legacy_import'").get())
      .toEqual({ count: 5 });
    expect(database.prepare("SELECT source_path, source_hash, commit_sha, actor, metadata_json FROM knowledge_evidence").get())
      .toMatchObject({
        source_path: "src/legacy.ts",
        source_hash: "legacy-source-hash",
        commit_sha: "legacy-commit",
        actor: "legacy-updater",
      });
    const metadata = database.prepare("SELECT metadata_json FROM knowledge_evidence").get() as { metadata_json: string };
    expect(JSON.parse(metadata.metadata_json)).toEqual({ legacyStatus: "confirmed" });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  });

  it("recovers a failed v13 migration after closing and reopening the on-disk database", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "cnm-migration-recovery-"));
    const databasePath = join(temporaryDirectory, "migration.sqlite");
    const projectId = "disk-migration-recovery-project";
    database = new Database(databasePath) as MemoryDatabase;
    database.pragma("foreign_keys = ON");
    migrate(database, projectId);
    database.prepare(`
      INSERT INTO memories
        (id, category, title, content, status, author, created_at, updated_at)
      VALUES ('disk-retry-memory', 'decision', 'Disk retry title', 'Disk retry content',
        'confirmed', 'disk-author', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
    `).run();

    database.exec(`
      DROP TABLE knowledge_events;
      DROP TABLE knowledge_relations;
      DROP TABLE knowledge_evidence;
      DROP TABLE knowledge_fragments;
      DROP TABLE knowledge_versions;
      DROP TABLE knowledge_items;
      DROP TABLE memory_idempotency;
      DELETE FROM schema_migrations WHERE version = 13;
      CREATE TABLE knowledge_items (id TEXT PRIMARY KEY);
    `);
    expect(() => migrate(database!, projectId)).toThrow(/no (such )?column: project_id/i);
    expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 13").get())
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_versions'").get())
      .toBeUndefined();

    database.close();
    database = new Database(databasePath) as MemoryDatabase;
    database.pragma("foreign_keys = ON");
    expect(database.prepare("SELECT version FROM schema_migrations WHERE version = 12").get()).toEqual({ version: 12 });
    expect(database.prepare("SELECT version FROM schema_migrations WHERE version = 13").get()).toBeUndefined();
    expect(database.prepare("PRAGMA table_info(knowledge_items)").all()).toHaveLength(1);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_versions'").get())
      .toBeUndefined();

    database.exec("DROP TABLE knowledge_items");
    migrate(database, projectId);
    migrate(database, projectId);
    expect(database.prepare("SELECT version FROM schema_migrations WHERE version = 13").get()).toEqual({ version: 13 });
    expect(database.prepare("SELECT id, project_id, legacy_status FROM knowledge_items").get()).toEqual({
      id: "disk-retry-memory", project_id: projectId, legacy_status: "confirmed",
    });
    expect(database.prepare("SELECT title, version_number FROM knowledge_versions WHERE knowledge_id = ?")
      .get("disk-retry-memory")).toEqual({ title: "Disk retry title", version_number: 1 });
    expect(database.prepare("SELECT content FROM knowledge_fragments WHERE version_id = ?")
      .get("legacy-v1:disk-retry-memory")).toEqual({ content: "Disk retry content" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM knowledge_events WHERE knowledge_id = ? AND event_type='legacy_import'")
      .get("disk-retry-memory")).toEqual({ count: 1 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  });


  it("assigns distinct deterministic stable IDs to legacy paths that normalize to the same path", () => {
    database = new Database(":memory:") as MemoryDatabase;
    database.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at)
      VALUES (1, 'old'), (2, 'old'), (3, 'old'), (4, 'old');
      CREATE TABLE files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        extension TEXT NOT NULL,
        language TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        modified_at TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );
      CREATE TABLE symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        signature TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        exported INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO files(path, extension, language, content_hash, size_bytes, modified_at, indexed_at)
      VALUES
        ('src\\\\legacy.ts', '.ts', 'typescript', 'hash-a', 10, 'old', 'old'),
        ('src/legacy.ts', '.ts', 'typescript', 'hash-b', 11, 'old', 'old');
      INSERT INTO symbols(file_id, name, kind, signature, start_line, end_line)
      VALUES
        (1, 'run', 'function', 'run()', 1, 2),
        (2, 'run', 'function', 'run()', 1, 2);
    `);

    migrate(database);

    const files = database.prepare("SELECT path, stable_id FROM files ORDER BY path").all() as Array<{ path: string; stable_id: string }>;
    const symbols = database.prepare("SELECT file_id, stable_id FROM symbols ORDER BY file_id").all() as Array<{ file_id: number; stable_id: string }>;
    expect(files).toHaveLength(2);
    expect(new Set(files.map((row) => row.stable_id)).size).toBe(2);
    expect(symbols).toHaveLength(2);
    expect(new Set(symbols.map((row) => row.stable_id)).size).toBe(2);
    expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=5").get())
      .toEqual({ count: 1 });
    expect(database.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);

    const firstFileIds = files.map((row) => row.stable_id);
    const firstSymbolIds = symbols.map((row) => row.stable_id);
    migrate(database);
    expect(database.prepare("SELECT path, stable_id FROM files ORDER BY path").all().map((row: any) => row.stable_id))
      .toEqual(firstFileIds);
    expect(database.prepare("SELECT file_id, stable_id FROM symbols ORDER BY file_id").all().map((row: any) => row.stable_id))
      .toEqual(firstSymbolIds);
  });

});
