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


  it("upgrades a populated version-one snapshot and preserves rows with normalized path collisions", () => {
    database = new Database(":memory:") as MemoryDatabase;
    database.pragma("foreign_keys = ON");
    const projectId = "legacy-v1-project";
    database.exec([
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
      "INSERT INTO schema_migrations(version, applied_at) VALUES (1, 'legacy-v1');",
      "CREATE TABLE projects (id TEXT PRIMARY KEY, root_path TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, last_indexed_at TEXT, indexed_commit TEXT);",
      "CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, extension TEXT NOT NULL, language TEXT NOT NULL, content_hash TEXT NOT NULL, size_bytes INTEGER NOT NULL, modified_at TEXT NOT NULL, indexed_at TEXT NOT NULL);",
      "CREATE TABLE symbols (id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE, name TEXT NOT NULL, kind TEXT NOT NULL, signature TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, exported INTEGER NOT NULL DEFAULT 0);",
      "CREATE TABLE symbol_calls (file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE, caller_name TEXT NOT NULL, callee_name TEXT NOT NULL, PRIMARY KEY(file_id, caller_name, callee_name));",
      "CREATE TABLE relations (id INTEGER PRIMARY KEY AUTOINCREMENT, source_kind TEXT NOT NULL, source_id INTEGER NOT NULL, target_kind TEXT NOT NULL, target_id INTEGER NOT NULL, kind TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1.0, provenance TEXT NOT NULL, UNIQUE(source_kind, source_id, target_kind, target_id, kind));",
      "CREATE TABLE memories (id TEXT PRIMARY KEY, category TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'confirmed', source_path TEXT, commit_sha TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);",
      "INSERT INTO projects(id, root_path, name, created_at, last_indexed_at, indexed_commit) VALUES ('legacy-v1-project', '/legacy/repo', 'repo', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 'legacy-commit');"
    ].join("\n"));

    const insertFile = database.prepare("INSERT INTO files(id, path, extension, language, content_hash, size_bytes, modified_at, indexed_at) VALUES (?, ?, '.ts', 'typescript', ?, 100, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')");
    insertFile.run(10, "src\\collision.ts", "hash-backslash");
    insertFile.run(11, "src/collision.ts", "hash-slash");
    insertFile.run(12, "src/legacy.ts", "hash-normal");

    const insertSymbol = database.prepare("INSERT INTO symbols(id, file_id, name, kind, signature, start_line, end_line, exported) VALUES (?, ?, 'open', 'function', 'open(): void', ?, ?, 1)");
    insertSymbol.run(101, 10, 1, 1);
    insertSymbol.run(102, 10, 2, 2);
    insertSymbol.run(103, 11, 1, 1);
    insertSymbol.run(104, 12, 1, 1);
    database.prepare("INSERT INTO symbol_calls(file_id, caller_name, callee_name) VALUES (12, 'caller', 'open')").run();
    database.prepare("INSERT INTO relations(source_kind, source_id, target_kind, target_id, kind, confidence, provenance) VALUES ('file', 12, 'symbol', 104, 'contains', 1.0, 'legacy-v1')").run();
    database.prepare("INSERT INTO memories(id, category, title, content, status, source_path, commit_sha, created_at, updated_at) VALUES ('legacy-v1-memory', 'decision', 'V1 title', 'V1 content', 'confirmed', 'src/legacy.ts', 'legacy-source', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')").run();

    const originalFiles = database.prepare("SELECT id, path, content_hash FROM files ORDER BY id").all();
    const originalSymbols = database.prepare("SELECT id, file_id, name, signature, start_line, end_line FROM symbols ORDER BY id").all();
    const originalRelations = database.prepare("SELECT source_kind, source_id, target_kind, target_id, kind, provenance FROM relations").all();

    migrate(database, projectId);

    expect(database.prepare("SELECT id, path, content_hash FROM files ORDER BY id").all()).toEqual(originalFiles);
    expect(database.prepare("SELECT id, file_id, name, signature, start_line, end_line FROM symbols ORDER BY id").all())
      .toEqual(originalSymbols);
    expect(database.prepare("SELECT source_kind, source_id, target_kind, target_id, kind, provenance FROM relations").all())
      .toEqual(originalRelations);

    const filesAfter = database.prepare("SELECT id, path, stable_id AS stableId FROM files ORDER BY id").all() as Array<{
      id: number; path: string; stableId: string;
    }>;
    expect(filesAfter).toHaveLength(3);
    expect(filesAfter.every(file => file.stableId.length > 0)).toBe(true);
    expect(new Set(filesAfter.map(file => file.stableId)).size).toBe(3);
    const normalizedCollision = filesAfter.filter(file => file.path.replaceAll("\\", "/") === "src/collision.ts");
    expect(normalizedCollision).toHaveLength(2);
    expect(new Set(normalizedCollision.map(file => file.stableId)).size).toBe(2);

    const symbolsAfter = database.prepare("SELECT id, file_id AS fileId, stable_id AS stableId FROM symbols ORDER BY id").all() as Array<{
      id: number; fileId: number; stableId: string;
    }>;
    expect(symbolsAfter).toHaveLength(4);
    expect(symbolsAfter.every(symbol => symbol.stableId.length > 0)).toBe(true);
    expect(new Set(symbolsAfter.map(symbol => symbol.stableId)).size).toBe(4);
    expect(new Set(symbolsAfter.filter(symbol => symbol.fileId === 10).map(symbol => symbol.stableId)).size).toBe(2);

    expect(database.prepare("SELECT module_specifier, imported_symbol_name FROM symbol_calls").get())
      .toEqual({ module_specifier: null, imported_symbol_name: null });
    expect(database.prepare("SELECT index_revision FROM relations").get()).toEqual({ index_revision: 0 });
    expect(database.prepare("SELECT index_revision, index_excludes_json, relations_config_hash FROM projects").get())
      .toEqual({ index_revision: 0, index_excludes_json: "[]", relations_config_hash: null });
    expect(database.prepare("SELECT version FROM schema_migrations ORDER BY version").all())
      .toEqual(Array.from({ length: 13 }, (_, index) => ({ version: index + 1 })));
    expect(database.prepare("SELECT project_id FROM knowledge_items WHERE id='legacy-v1-memory'")
      .get()).toEqual({ project_id: projectId });
    expect(database.prepare("SELECT COUNT(*) AS count FROM projects WHERE id=?").get(projectId))
      .toEqual({ count: 1 });
    expect(database.prepare("SELECT title, version_number FROM knowledge_versions WHERE knowledge_id='legacy-v1-memory'")
      .get()).toEqual({ title: "V1 title", version_number: 1 });
    expect(database.prepare("SELECT content FROM knowledge_fragments WHERE version_id='legacy-v1:legacy-v1-memory'")
      .get()).toEqual({ content: "V1 content" });

    const stableIdsBeforeRetry = {
      files: database.prepare("SELECT id, stable_id FROM files ORDER BY id").all(),
      symbols: database.prepare("SELECT id, stable_id FROM symbols ORDER BY id").all(),
    };
    // Simulate a prior v5 backfill that wrote duplicate IDs but failed before
    // creating its uniqueness indexes or committing the v13 marker. The retry
    // must repair both file IDs and dependent symbol IDs without losing rows.
    // Recreate the pre-v13 state explicitly. Disable FK enforcement only
    // while dropping the dependent v13 tables; restore it before retrying the
    // migration so the final FK check covers the rebuilt schema and data.
    database.pragma("foreign_keys = OFF");
    database.exec(`
      DROP INDEX idx_files_stable_id;
      DROP INDEX idx_symbols_stable_id;
      UPDATE files SET stable_id = (SELECT stable_id FROM files WHERE id = 11) WHERE id IN (10, 12);
      UPDATE symbols SET stable_id = (SELECT stable_id FROM symbols WHERE id = 101) WHERE id IN (103, 104);
      DROP TABLE knowledge_events;
      DROP TABLE knowledge_relations;
      DROP TABLE knowledge_evidence;
      DROP TABLE knowledge_fragments;
      DROP TABLE knowledge_versions;
      DROP TABLE knowledge_items;
      DROP TABLE memory_idempotency;
      DELETE FROM schema_migrations WHERE version = 13;
    `);
    database.pragma("foreign_keys = ON");
    expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=13").get())
      .toEqual({ count: 0 });
    migrate(database, projectId);
    expect({
      files: database.prepare("SELECT id, stable_id FROM files ORDER BY id").all(),
      symbols: database.prepare("SELECT id, stable_id FROM symbols ORDER BY id").all(),
    }).toEqual(stableIdsBeforeRetry);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  });


  it("upgrades a populated version-six snapshot and preserves indexed and memory source rows", () => {
    database = new Database(":memory:") as MemoryDatabase;
    database.pragma("foreign_keys = ON");
    database.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at) VALUES (1, 'v6'), (2, 'v6'), (3, 'v6'), (4, 'v6'), (5, 'v6'), (6, 'v6');
      CREATE TABLE projects (id TEXT PRIMARY KEY, root_path TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, last_indexed_at TEXT, indexed_commit TEXT, index_revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, stable_id TEXT, path TEXT NOT NULL UNIQUE, extension TEXT NOT NULL, language TEXT NOT NULL, content_hash TEXT NOT NULL, size_bytes INTEGER NOT NULL, modified_at TEXT NOT NULL, indexed_at TEXT NOT NULL);
      CREATE TABLE symbols (id INTEGER PRIMARY KEY AUTOINCREMENT, stable_id TEXT, file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE, name TEXT NOT NULL, kind TEXT NOT NULL, signature TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, exported INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE symbol_calls (file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE, caller_name TEXT NOT NULL, callee_name TEXT NOT NULL, module_specifier TEXT, imported_symbol_name TEXT, PRIMARY KEY(file_id, caller_name, callee_name));
      CREATE TABLE relations (id INTEGER PRIMARY KEY AUTOINCREMENT, source_kind TEXT NOT NULL, source_id INTEGER NOT NULL, target_kind TEXT NOT NULL, target_id INTEGER NOT NULL, kind TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1.0, provenance TEXT NOT NULL, index_revision INTEGER NOT NULL DEFAULT 0, UNIQUE(source_kind, source_id, target_kind, target_id, kind));
      CREATE TABLE memories (id TEXT PRIMARY KEY, category TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'confirmed', source_path TEXT, commit_sha TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO projects(id, root_path, name, created_at, last_indexed_at, indexed_commit, index_revision) VALUES ('v6-project', '/legacy/v6', 'legacy-v6', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 'v6-commit', 6);
      INSERT INTO files(id, stable_id, path, extension, language, content_hash, size_bytes, modified_at, indexed_at) VALUES (41, 'v6-file-stable-id', 'src/v6.ts', '.ts', 'typescript', 'v6-file-hash', 128, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
      INSERT INTO symbols(id, stable_id, file_id, name, kind, signature, start_line, end_line, exported) VALUES (51, 'v6-symbol-stable-id', 41, 'loadV6', 'function', 'loadV6(): string', 3, 8, 1);
      INSERT INTO symbol_calls(file_id, caller_name, callee_name, module_specifier, imported_symbol_name) VALUES (41, 'bootstrap', 'loadV6', './v6.js', 'loadV6');
      INSERT INTO relations(source_kind, source_id, target_kind, target_id, kind, confidence, provenance, index_revision) VALUES ('file', 41, 'symbol', 51, 'contains', 0.9, 'v6-snapshot', 6);
      INSERT INTO memories(id, category, title, content, status, source_path, commit_sha, created_at, updated_at) VALUES ('v6-memory', 'decision', 'V6 decision', 'Preserve this legacy decision', 'confirmed', 'src/v6.ts', 'v6-commit', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
    `);
    const snapshot = () => ({
      project: database!.prepare("SELECT id, root_path, name, created_at, last_indexed_at, indexed_commit, index_revision FROM projects").all(),
      files: database!.prepare("SELECT id, stable_id, path, extension, language, content_hash, size_bytes, modified_at, indexed_at FROM files").all(),
      symbols: database!.prepare("SELECT id, file_id, name, kind, signature, start_line, end_line, exported FROM symbols").all(),
      calls: database!.prepare("SELECT file_id, caller_name, callee_name, module_specifier, imported_symbol_name FROM symbol_calls").all(),
      relations: database!.prepare("SELECT source_kind, source_id, target_kind, target_id, kind, confidence, provenance, index_revision FROM relations").all(),
      memories: database!.prepare("SELECT id, category, title, content, status, source_path, commit_sha, created_at, updated_at FROM memories").all(),
    });
    const sourceSnapshot = snapshot();
    migrate(database, "v6-project");
    expect(snapshot()).toEqual(sourceSnapshot);
    expect(database.prepare("SELECT id, stable_id FROM files ORDER BY id").all())
      .toEqual([{ id: 41, stable_id: "v6-file-stable-id" }]);
    const symbolIds = database.prepare("SELECT id, stable_id FROM symbols ORDER BY id").all() as Array<{ id: number; stable_id: string }>;
    expect(symbolIds).toHaveLength(1);
    expect(symbolIds[0].stable_id).toMatch(/^[a-f0-9]{64}$/);
    expect(database.prepare("SELECT project_id, legacy_status FROM knowledge_items WHERE id='v6-memory'").get())
      .toEqual({ project_id: "v6-project", legacy_status: "confirmed" });
    expect(database.prepare("SELECT title, version_number FROM knowledge_versions WHERE knowledge_id='v6-memory'").get())
      .toEqual({ title: "V6 decision", version_number: 1 });
    expect(database.prepare("SELECT content FROM knowledge_fragments WHERE version_id='legacy-v1:v6-memory'").get())
      .toEqual({ content: "Preserve this legacy decision" });
    expect(database.prepare("SELECT version FROM schema_migrations ORDER BY version").all())
      .toEqual(Array.from({ length: 13 }, (_, index) => ({ version: index + 1 })));
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    const stableIds = {
      files: database.prepare("SELECT id, stable_id FROM files ORDER BY id").all(),
      symbols: database.prepare("SELECT id, stable_id FROM symbols ORDER BY id").all(),
    };
    migrate(database);
    expect({
      files: database.prepare("SELECT id, stable_id FROM files ORDER BY id").all(),
      symbols: database.prepare("SELECT id, stable_id FROM symbols ORDER BY id").all(),
    }).toEqual(stableIds);
    expect(database.prepare("SELECT COUNT(*) AS count FROM knowledge_events WHERE knowledge_id='v6-memory' AND event_type='legacy_import'").get())
      .toEqual({ count: 1 });
  });


  it("upgrades a populated version-ten snapshot and preserves indexed and legacy knowledge rows", () => {
    database = new Database(":memory:") as MemoryDatabase;
    database.pragma("foreign_keys = ON");
    database.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at)
        VALUES (1, 'v10'), (2, 'v10'), (3, 'v10'), (4, 'v10'), (5, 'v10'),
          (6, 'v10'), (7, 'v10'), (8, 'v10'), (9, 'v10'), (10, 'v10');
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, root_path TEXT NOT NULL, name TEXT NOT NULL,
        created_at TEXT NOT NULL, last_indexed_at TEXT, indexed_commit TEXT,
        indexed_branch TEXT, indexed_worktree_dirty INTEGER,
        indexed_worktree_status_hash TEXT, indexed_worktree_changed_paths INTEGER,
        index_revision INTEGER NOT NULL DEFAULT 0, index_excludes_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE files (
        id INTEGER PRIMARY KEY AUTOINCREMENT, stable_id TEXT, path TEXT NOT NULL UNIQUE,
        extension TEXT NOT NULL, language TEXT NOT NULL, content_hash TEXT NOT NULL,
        size_bytes INTEGER NOT NULL, modified_at TEXT NOT NULL, indexed_at TEXT NOT NULL
      );
      CREATE TABLE symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT, stable_id TEXT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        name TEXT NOT NULL, kind TEXT NOT NULL, signature TEXT NOT NULL,
        start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, exported INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE symbol_calls (
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        caller_name TEXT NOT NULL, callee_name TEXT NOT NULL,
        module_specifier TEXT, imported_symbol_name TEXT,
        PRIMARY KEY(file_id, caller_name, callee_name)
      );
      CREATE TABLE relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source_kind TEXT NOT NULL, source_id INTEGER NOT NULL,
        target_kind TEXT NOT NULL, target_id INTEGER NOT NULL, kind TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0, provenance TEXT NOT NULL,
        index_revision INTEGER NOT NULL DEFAULT 0,
        UNIQUE(source_kind, source_id, target_kind, target_id, kind)
      );
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, category TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'confirmed', source_path TEXT, commit_sha TEXT,
        source_hash TEXT, author TEXT, updated_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO projects (
        id, root_path, name, created_at, last_indexed_at, indexed_commit, indexed_branch,
        indexed_worktree_dirty, indexed_worktree_status_hash, indexed_worktree_changed_paths,
        index_revision, index_excludes_json
      ) VALUES (
        'v10-project', '/legacy/v10', 'legacy-v10', '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z', 'v10-commit', 'main', 1, 'worktree-hash', 2, 10, '["dist"]'
      );
      INSERT INTO files(id, stable_id, path, extension, language, content_hash, size_bytes, modified_at, indexed_at)
        VALUES (101, 'v10-file-stable-id', 'src/v10.ts', '.ts', 'typescript', 'v10-file-hash',
          256, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
      INSERT INTO symbols(id, stable_id, file_id, name, kind, signature, start_line, end_line, exported)
        VALUES (201, 'v10-symbol-legacy-id', 101, 'loadV10', 'function', 'loadV10(): string', 4, 9, 1);
      INSERT INTO symbol_calls(file_id, caller_name, callee_name, module_specifier, imported_symbol_name)
        VALUES (101, 'bootstrap', 'loadV10', './v10.js', 'loadV10');
      INSERT INTO relations(source_kind, source_id, target_kind, target_id, kind, confidence, provenance, index_revision)
        VALUES ('file', 101, 'symbol', 201, 'contains', 0.95, 'v10-snapshot', 10);
      INSERT INTO memories(
        id, category, title, content, status, source_path, commit_sha, source_hash,
        author, updated_by, created_at, updated_at
      ) VALUES (
        'v10-memory', 'decision', 'V10 decision', 'Preserve this v10 knowledge', 'confirmed',
        'src/v10.ts', 'v10-commit', 'v10-source-hash', 'original-author', 'last-editor',
        '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'
      );
    `);

    const sourceSnapshot = {
      project: database.prepare(`SELECT id, root_path, name, created_at, last_indexed_at, indexed_commit,
        indexed_branch, indexed_worktree_dirty, indexed_worktree_status_hash,
        indexed_worktree_changed_paths, index_revision, index_excludes_json FROM projects`).all(),
      files: database.prepare("SELECT id, stable_id, path, content_hash FROM files").all(),
      symbols: database.prepare("SELECT id, file_id, name, signature, start_line, end_line FROM symbols").all(),
      calls: database.prepare("SELECT file_id, caller_name, callee_name, module_specifier, imported_symbol_name FROM symbol_calls").all(),
      relations: database.prepare("SELECT source_kind, source_id, target_kind, target_id, kind, confidence, provenance, index_revision FROM relations").all(),
      memories: database.prepare(`SELECT id, category, title, content, status, source_path, commit_sha,
        source_hash, author, updated_by, created_at, updated_at FROM memories`).all(),
    };

    migrate(database, "v10-project");

    expect({
      project: database.prepare(`SELECT id, root_path, name, created_at, last_indexed_at, indexed_commit,
        indexed_branch, indexed_worktree_dirty, indexed_worktree_status_hash,
        indexed_worktree_changed_paths, index_revision, index_excludes_json FROM projects`).all(),
      files: database.prepare("SELECT id, stable_id, path, content_hash FROM files").all(),
      symbols: database.prepare("SELECT id, file_id, name, signature, start_line, end_line FROM symbols").all(),
      calls: database.prepare("SELECT file_id, caller_name, callee_name, module_specifier, imported_symbol_name FROM symbol_calls").all(),
      relations: database.prepare("SELECT source_kind, source_id, target_kind, target_id, kind, confidence, provenance, index_revision FROM relations").all(),
      memories: database.prepare(`SELECT id, category, title, content, status, source_path, commit_sha,
        source_hash, author, updated_by, created_at, updated_at FROM memories`).all(),
    }).toEqual(sourceSnapshot);

    expect(database.prepare("SELECT relations_config_hash FROM projects WHERE id='v10-project'").get())
      .toEqual({ relations_config_hash: null });
    expect(database.prepare("PRAGMA table_info(import_diagnostics)").all().map((column: any) => column.name))
      .toEqual(expect.arrayContaining([
        "source_file_id", "module_specifier", "diagnostic_code", "kind", "message",
        "line", "column_number", "imported_name",
      ]));
    expect(database.prepare("SELECT project_id, legacy_status FROM knowledge_items WHERE id='v10-memory'").get())
      .toEqual({ project_id: "v10-project", legacy_status: "confirmed" });
    expect(database.prepare("SELECT title, version_number FROM knowledge_versions WHERE knowledge_id='v10-memory'").get())
      .toEqual({ title: "V10 decision", version_number: 1 });
    expect(database.prepare("SELECT content FROM knowledge_fragments WHERE version_id='legacy-v1:v10-memory'").get())
      .toEqual({ content: "Preserve this v10 knowledge" });
    expect(database.prepare("SELECT version FROM schema_migrations ORDER BY version").all())
      .toEqual(Array.from({ length: 13 }, (_, index) => ({ version: index + 1 })));
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);

    const stableIds = {
      files: database.prepare("SELECT id, stable_id FROM files ORDER BY id").all(),
      symbols: database.prepare("SELECT id, stable_id FROM symbols ORDER BY id").all(),
    };
    migrate(database);
    expect({
      files: database.prepare("SELECT id, stable_id FROM files ORDER BY id").all(),
      symbols: database.prepare("SELECT id, stable_id FROM symbols ORDER BY id").all(),
    }).toEqual(stableIds);
    expect(database.prepare("SELECT COUNT(*) AS count FROM knowledge_events WHERE knowledge_id='v10-memory' AND event_type='legacy_import'").get())
      .toEqual({ count: 1 });
  });


});
