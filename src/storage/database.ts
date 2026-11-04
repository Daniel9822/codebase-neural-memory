import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ProjectLocation } from "../core/project.js";

export type MemoryDatabase = InstanceType<typeof Database>;

export function openDatabase(location: ProjectLocation): MemoryDatabase {
  mkdirSync(dirname(location.databasePath), { recursive: true });
  const db = new Database(location.databasePath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    migrate(db, location.id);
    return db;
  } catch (error) {
    // A failed pragma or migration must not leak the connection. In particular,
    // lock contention during migration otherwise leaves the SQLite file open
    // and prevents cleanup/recovery on Windows.
    db.close();
    throw error;
  }
}

export function migrate(db: MemoryDatabase, projectId?: string): void {
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

  // Version 13: introduce versioned knowledge while preserving the legacy memories table.
  // DDL and backfill are one transaction so an interrupted migration can be safely retried.
  const migrateKnowledgeV13 = db.transaction(() => {
    if (db.prepare("SELECT 1 FROM schema_migrations WHERE version = 13").get()) return;
    db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_items (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        knowledge_type TEXT NOT NULL,
        lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active', 'superseded', 'archived')),
        current_version_id TEXT,
        legacy_status TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        aliases_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(current_version_id, id) REFERENCES knowledge_versions(id, knowledge_id)
          DEFERRABLE INITIALLY DEFERRED
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_items_project_lifecycle
        ON knowledge_items(project_id, lifecycle, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_knowledge_items_project_type
        ON knowledge_items(project_id, knowledge_type, lifecycle);

      CREATE TABLE IF NOT EXISTS knowledge_versions (
        id TEXT PRIMARY KEY,
        knowledge_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
        version_number INTEGER NOT NULL CHECK(version_number > 0),
        epistemic_state TEXT NOT NULL CHECK(epistemic_state IN (
          'observed', 'verified', 'inferred', 'user_asserted', 'planned',
          'hypothesis', 'pending_validation'
        )),
        confidence REAL CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
        confidence_reason TEXT,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        created_by TEXT,
        change_reason TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(knowledge_id, version_number),
        UNIQUE(id, knowledge_id)
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_versions_item
        ON knowledge_versions(knowledge_id, version_number DESC);

      CREATE TABLE IF NOT EXISTS knowledge_fragments (
        id TEXT PRIMARY KEY,
        version_id TEXT NOT NULL REFERENCES knowledge_versions(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        heading TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        UNIQUE(version_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_fragments_version
        ON knowledge_fragments(version_id, ordinal);

      CREATE TABLE IF NOT EXISTS knowledge_evidence (
        id TEXT PRIMARY KEY,
        version_id TEXT NOT NULL REFERENCES knowledge_versions(id) ON DELETE CASCADE,
        evidence_type TEXT NOT NULL,
        source_path TEXT,
        source_hash TEXT,
        commit_sha TEXT,
        source_symbol TEXT,
        test_command TEXT,
        test_result TEXT,
        actor TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_evidence_version
        ON knowledge_evidence(version_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_evidence_source
        ON knowledge_evidence(source_path, source_hash);

      CREATE TABLE IF NOT EXISTS knowledge_relations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        source_knowledge_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
        target_knowledge_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL CHECK(relation_type IN (
          'supports', 'contradicts', 'supersedes', 'depends_on',
          'related_to', 'derived_from', 'affects'
        )),
        created_by TEXT,
        reason TEXT,
        created_at TEXT NOT NULL,
        CHECK(source_knowledge_id <> target_knowledge_id),
        UNIQUE(source_knowledge_id, target_knowledge_id, relation_type)
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_relations_source
        ON knowledge_relations(project_id, source_knowledge_id, relation_type);
      CREATE INDEX IF NOT EXISTS idx_knowledge_relations_target
        ON knowledge_relations(project_id, target_knowledge_id, relation_type);

      CREATE TABLE IF NOT EXISTS knowledge_events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        knowledge_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
        version_id TEXT REFERENCES knowledge_versions(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        actor TEXT,
        reason TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_events_item
        ON knowledge_events(project_id, knowledge_id, created_at, id);

      CREATE TABLE IF NOT EXISTS memory_idempotency (
        project_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(project_id, operation, idempotency_key)
      );

      CREATE TRIGGER IF NOT EXISTS knowledge_versions_no_update
      BEFORE UPDATE ON knowledge_versions
      BEGIN SELECT RAISE(ABORT, 'knowledge versions are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS knowledge_versions_no_delete
      BEFORE DELETE ON knowledge_versions
      BEGIN SELECT RAISE(ABORT, 'knowledge versions are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS knowledge_fragments_no_update
      BEFORE UPDATE ON knowledge_fragments
      BEGIN SELECT RAISE(ABORT, 'knowledge fragments are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS knowledge_fragments_no_delete
      BEFORE DELETE ON knowledge_fragments
      BEGIN SELECT RAISE(ABORT, 'knowledge fragments are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS knowledge_evidence_no_update
      BEFORE UPDATE ON knowledge_evidence
      BEGIN SELECT RAISE(ABORT, 'knowledge evidence is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS knowledge_evidence_no_delete
      BEFORE DELETE ON knowledge_evidence
      BEGIN SELECT RAISE(ABORT, 'knowledge evidence is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS knowledge_events_no_update
      BEFORE UPDATE ON knowledge_events
      BEGIN SELECT RAISE(ABORT, 'knowledge events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS knowledge_events_no_delete
      BEFORE DELETE ON knowledge_events
      BEGIN SELECT RAISE(ABORT, 'knowledge events are append-only'); END;
    `);

    const legacyRows = db.prepare(`
      SELECT id, category, title, content, status, source_path, commit_sha,
             source_hash, author, updated_by, created_at, updated_at
      FROM memories ORDER BY created_at, id
    `).all() as Array<{
      id: string; category: string; title: string; content: string; status: string;
      source_path: string | null; commit_sha: string | null; source_hash: string | null;
      author: string | null; updated_by: string | null; created_at: string; updated_at: string;
    }>;
    const existingProject = db.prepare("SELECT id FROM projects ORDER BY created_at, id LIMIT 1").get() as { id: string } | undefined;
    // openDatabase supplies the project identity derived from the database path.
    // This is essential on first open: ensureProject runs after migrations, so
    // a legacy database can legitimately have an empty projects table here.
    const migrationProjectId = projectId ?? existingProject?.id ?? "legacy-unassigned";
    const insertItem = db.prepare(`
      INSERT OR IGNORE INTO knowledge_items
        (id, project_id, knowledge_type, lifecycle, current_version_id, legacy_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertVersion = db.prepare(`
      INSERT OR IGNORE INTO knowledge_versions
        (id, knowledge_id, version_number, epistemic_state, confidence, confidence_reason,
         title, created_by, change_reason, created_at)
      VALUES (?, ?, 1, ?, NULL, NULL, ?, ?, 'Imported from legacy memories without changing its meaning', ?)
    `);
    const insertFragment = db.prepare(`
      INSERT OR IGNORE INTO knowledge_fragments(id, version_id, ordinal, content)
      VALUES (?, ?, 0, ?)
    `);
    const insertEvidence = db.prepare(`
      INSERT OR IGNORE INTO knowledge_evidence
        (id, version_id, evidence_type, source_path, source_hash, commit_sha, actor, metadata_json, created_at)
      VALUES (?, ?, 'legacy_source_reference', ?, ?, ?, ?, ?, ?)
    `);
    const insertEvent = db.prepare(`
      INSERT OR IGNORE INTO knowledge_events
        (id, project_id, knowledge_id, version_id, event_type, actor, reason, payload_json, created_at)
      VALUES (?, ?, ?, ?, 'legacy_import', ?, 'Preserved during schema v13 migration', ?, ?)
    `);

    for (const row of legacyRows) {
      const lifecycle = row.status === "obsolete" ? "superseded"
        : row.status === "rejected" ? "archived" : "active";
      const epistemicState = row.status === "confirmed" ? "user_asserted" : "pending_validation";
      const versionId = `legacy-v1:${row.id}`;
      insertItem.run(row.id, migrationProjectId, row.category, lifecycle, versionId, row.status, row.created_at, row.updated_at);
      insertVersion.run(versionId, row.id, epistemicState, row.title, row.author, row.created_at);
      insertFragment.run(`legacy-fragment:${row.id}:0`, versionId, row.content);
      if (row.source_path !== null || row.source_hash !== null || row.commit_sha !== null) {
        insertEvidence.run(
          `legacy-evidence:${row.id}:0`, versionId, row.source_path, row.source_hash,
          row.commit_sha, row.updated_by ?? row.author,
          JSON.stringify({ legacyStatus: row.status }), row.updated_at,
        );
      }
      insertEvent.run(
        `legacy-event:${row.id}:0`, migrationProjectId, row.id, versionId, row.updated_by ?? row.author,
        JSON.stringify({ legacyStatus: row.status, originalId: row.id }), row.updated_at,
      );
    }
    db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (13, ?)").run(now);
  });

  migrateKnowledgeV13();
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
