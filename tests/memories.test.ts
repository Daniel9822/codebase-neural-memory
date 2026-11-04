import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexWithDatabase } from "../src/core/indexer.js";
import { deleteMemory, getMemoryFreshnessReport, inspectMemoryFreshness, proposeMemory, remember, recallMemories, recallMemoriesReport, transitionMemory, updateMemory } from "../src/core/memories.js";
import type { ProjectLocation } from "../src/core/project.js";
import { ensureProject, migrate, openDatabase, type MemoryDatabase } from "../src/storage/database.js";

let temporaryDirectory = "";
let database: MemoryDatabase | undefined;
let location: ProjectLocation;

function createProject(): void {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "cnm-knowledge-origin-test-"));
  const rootPath = join(temporaryDirectory, "repository");
  mkdirSync(rootPath, { recursive: true });
  location = {
    id: "knowledge-origin-test-project",
    rootPath,
    dataDirectory: join(temporaryDirectory, "data"),
    databasePath: join(temporaryDirectory, "data", "memory.sqlite"),
  };
  database = openDatabase(location);
  ensureProject(database, location);
}

afterEach(() => {
  database?.close();
  database = undefined;
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = "";
});

describe("human-confirmed knowledge and parser-derived graph facts", () => {
  it("stores explicit human memories separately from parser-derived relations", () => {
    createProject();
    writeFileSync(join(location.rootPath, "main.ts"), 'import "./dependency";');
    writeFileSync(join(location.rootPath, "dependency.ts"), "export const dependency = true;");

    indexWithDatabase(database!, location);
    const parserRelations = database!.prepare(
      "SELECT source_kind, target_kind, kind, confidence, provenance FROM relations",
    ).all();
    expect(parserRelations).toEqual([{
      source_kind: "file",
      target_kind: "file",
      kind: "IMPORTS",
      confidence: 1,
      provenance: "typescript-ast",
    }]);

    const memoryId = remember(
      location,
      "Keep the domain boundary explicit",
      "The billing module must not own customer identity.",
      "decision",
    );
    const memories = recallMemories(location, "domain boundary");

    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      id: memoryId,
      category: "decision",
      title: "Keep the domain boundary explicit",
      content: "The billing module must not own customer identity.",
      status: "confirmed",
      sourcePath: null,
    });
    expect(database!.prepare("SELECT COUNT(*) AS count FROM relations").get()).toEqual({ count: 1 });
    expect(database!.prepare("SELECT COUNT(*) AS count FROM memories").get()).toEqual({ count: 1 });
  });
});


describe("explicit memory lifecycle", () => {
  it("stores optional source path and commit metadata and supports explicit updates", () => {
    createProject();
    const id = remember(location, "Initial decision", "Use the adapter boundary.", "decision", "src/adapter.ts", "abc123", "Ada Lovelace");
    expect(recallMemories(location)[0]).toMatchObject({
      id, status: "confirmed", sourcePath: "src/adapter.ts", commitSha: "abc123", author: "Ada Lovelace", updatedBy: "Ada Lovelace",
    });

    expect(updateMemory(location, id, {
      title: "Revised decision",
      content: "Keep the adapter boundary stable.",
      category: "architecture",
      sourcePath: "src/core/adapter.ts",
      commitSha: "def456",
      author: "Grace Hopper",
    })).toBe(true);
    expect(recallMemories(location, "Revised decision")[0]).toMatchObject({
      id,
      title: "Revised decision",
      content: "Keep the adapter boundary stable.",
      category: "architecture",
      sourcePath: "src/core/adapter.ts",
      commitSha: "def456",
      author: "Ada Lovelace",
      updatedBy: "Grace Hopper",
      status: "confirmed",
    });
    expect(() => updateMemory(location, id, {})).toThrow("At least one memory field");
    expect(() => updateMemory(location, id, { title: "   " })).toThrow("title must not be empty");
    expect(updateMemory(location, "missing-memory", { title: "No row" })).toBe(false);
  });

  it("requires explicit approval or rejection for proposed memories and enforces transitions", () => {
    createProject();
    const proposed = proposeMemory(location, "Potential rule", "Review before adoption.", "decision", undefined, undefined, "Project Maintainer");
    expect(recallMemories(location)[0]).toMatchObject({ id: proposed, status: "proposed", author: "Project Maintainer", updatedBy: "Project Maintainer" });

    expect(() => transitionMemory(location, proposed, "obsolete")).toThrow("Invalid memory status transition");
    expect(transitionMemory(location, proposed, "confirmed")).toBe(true);
    expect(recallMemories(location)[0]).toMatchObject({ id: proposed, status: "confirmed" });
    expect(transitionMemory(location, proposed, "obsolete")).toBe(true);
    expect(recallMemories(location)[0]).toMatchObject({ id: proposed, status: "obsolete" });
    expect(transitionMemory(location, proposed, "confirmed")).toBe(true);
    expect(() => transitionMemory(location, proposed, "rejected")).toThrow("Invalid memory status transition");

    const rejected = proposeMemory(location, "Rejected suggestion", "Do not adopt.");
    expect(transitionMemory(location, rejected, "rejected")).toBe(true);
    expect(recallMemories(location).some((memory) => memory.id === rejected)).toBe(false);
    expect(() => transitionMemory(location, rejected, "confirmed")).toThrow("Invalid memory status transition");
    expect(() => transitionMemory(location, proposed, "unknown" as never)).toThrow("Unsupported memory status");
    expect(transitionMemory(location, "missing-memory", "confirmed")).toBe(false);
  });

  it("detects changed and missing source files without changing memory status", () => {
    createProject();
    writeFileSync(join(location.rootPath, "src.ts"), "export const value = 1;");
    const id = remember(location, "Source-backed decision", "Keep this source boundary.", "decision", "src.ts");
    expect(recallMemories(location)[0]).toMatchObject({ id, sourceHash: expect.any(String) });
    expect(inspectMemoryFreshness(location)).toMatchObject([{ id, status: "current", requiresReview: false }]);

    writeFileSync(join(location.rootPath, "src.ts"), "export const value = 2;");
    expect(inspectMemoryFreshness(location)).toMatchObject([{ id, status: "changed", requiresReview: true }]);
    expect(recallMemories(location)[0]).toMatchObject({ id, status: "confirmed" });

    rmSync(join(location.rootPath, "src.ts"));
    expect(inspectMemoryFreshness(location)).toMatchObject([{ id, status: "missing", requiresReview: true }]);
    expect(recallMemories(location)[0]).toMatchObject({ id, status: "confirmed" });
  });

  it("bounds memory freshness work and supports targeted freshness for selected context memories", () => {
    createProject();
    writeFileSync(join(location.rootPath, "older.ts"), "export function older() { return true; }");
    writeFileSync(join(location.rootPath, "newer.ts"), "export function newer() { return true; }");
    const olderId = remember(location, "Older source decision", "Review the older source.", "decision", "older.ts");
    remember(location, "Newer source decision", "Review the newer source.", "decision", "newer.ts");

    expect(inspectMemoryFreshness(location, 1)).toHaveLength(1);
    expect(inspectMemoryFreshness(location, 1, [olderId])).toMatchObject([
      { id: olderId, status: "current", requiresReview: false },
    ]);
    const report = getMemoryFreshnessReport(location, 1);
    expect(report).toMatchObject({ total: 2, limit: 1, truncated: true });
    expect(report.records).toHaveLength(1);
    expect(getMemoryFreshnessReport(location)).toMatchObject({ total: 2, limit: 100, truncated: false });
    expect(() => inspectMemoryFreshness(location, 1, Array.from({ length: 51 }, (_, index) => String(index))))
      .toThrow(/at most 50/i);
    expect(() => inspectMemoryFreshness(location, 501)).toThrow(/no greater than 500/i);
  });

  it("requires review for legacy source references and flags symlink escapes safely", () => {
    createProject();
    writeFileSync(join(location.rootPath, "source.ts"), "export const value = 1;");
    const id = remember(location, "Tracked decision", "Keep this boundary.", "decision", "source.ts");
    database!.prepare("UPDATE memories SET source_hash = NULL WHERE id = ?").run(id);
    expect(inspectMemoryFreshness(location)).toMatchObject([
      { id, status: "untracked", requiresReview: true },
    ]);

    const outside = join(temporaryDirectory, "outside.ts");
    writeFileSync(outside, "export const secret = true;");
    rmSync(join(location.rootPath, "source.ts"));
    symlinkSync(outside, join(location.rootPath, "source.ts"));
    expect(inspectMemoryFreshness(location)).toMatchObject([
      { id, status: "unsafe", requiresReview: true },
    ]);
    expect(recallMemories(location)[0]).toMatchObject({ id, status: "confirmed" });
  });

  it("marks a source reference replaced by a directory as unsafe and requiring review", () => {
    createProject();
    writeFileSync(join(location.rootPath, "source.ts"), "export const value = 1;");
    const id = remember(location, "Directory-replaced source", "Review this source before reuse.", "decision", "source.ts");

    rmSync(join(location.rootPath, "source.ts"));
    mkdirSync(join(location.rootPath, "source.ts"));

    expect(inspectMemoryFreshness(location)).toMatchObject([
      { id, status: "unsafe", requiresReview: true },
    ]);
    expect(recallMemories(location)[0]).toMatchObject({ id, status: "confirmed" });
  });

  it("rejects source paths that traverse outside the project root", () => {
    createProject();
    expect(() => remember(location, "Unsafe reference", "Do not accept traversal.", "decision", "../outside.ts"))
      .toThrow("must stay inside the project root");
  });

  it("deletes memories only from the selected project's database", () => {
    createProject();
    const id = remember(location, "Project A note", "Scoped note.");
    const otherLocation: ProjectLocation = {
      id: "other-memory-project",
      rootPath: join(temporaryDirectory, "other-repository"),
      dataDirectory: join(temporaryDirectory, "other-data"),
      databasePath: join(temporaryDirectory, "other-data", "memory.sqlite"),
    };
    mkdirSync(otherLocation.rootPath, { recursive: true });
    const otherDb = openDatabase(otherLocation);
    try { ensureProject(otherDb, otherLocation); } finally { otherDb.close(); }
    const otherId = remember(otherLocation, "Project B note", "Separate note.");

    expect(deleteMemory(location, otherId)).toBe(false);
    expect(recallMemories(otherLocation)[0]).toMatchObject({ id: otherId });
    expect(deleteMemory(location, id)).toBe(true);
    expect(deleteMemory(location, id)).toBe(false);
    expect(recallMemories(location)).toEqual([]);
    expect(recallMemories(otherLocation)[0]).toMatchObject({ id: otherId });
  });

  it("finds memories from natural-language terms and exposes lifecycle/category filters", () => {
    createProject();
    const confirmed = remember(location, "Play command execution pipeline", "The handlePlay flow validates input, dispatches the command, and records the result.", "convention");
    const proposed = proposeMemory(location, "Potential play handler gotcha", "The play handler may need a retry guard.", "gotcha");
    remember(location, "Billing architecture boundary", "Billing does not own user identity.", "architectural");

    expect(recallMemories(location, "how does the play command work")).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: confirmed, status: "confirmed" })]),
    );
    expect(recallMemories(location, "", 20, { list: true }).map((item) => item.id))
      .toContain(proposed);
    expect(recallMemories(location, "", 20, { statuses: ["proposed"] })).toEqual([
      expect.objectContaining({ id: proposed, status: "proposed" }),
    ]);
    expect(recallMemories(location, "", 20, { category: "architectural" })).toEqual(
      expect.arrayContaining([expect.objectContaining({ category: "architectural" })]),
    );
  });

  it("reports when memory recall exceeds its bounded candidate window", () => {
    createProject();
    const insert = database!.prepare(`INSERT INTO memories
      (id, category, title, content, status, source_path, commit_sha, source_hash, author, updated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`);
    const insertBulkMemories = database!.transaction(() => {
      for (let index = 0; index < 5_000; index += 1) {
        const timestamp = new Date(Date.UTC(2025, 0, 1, 0, 0, index % 60)).toISOString();
        insert.run(`bulk-${String(index).padStart(4, "0")}`, "note", `Unrelated note ${index}`, "No matching terms here.", "confirmed", timestamp, timestamp);
      }
      insert.run("old-match", "decision", "Legacy deployment invariant", "The deployment invariant must remain stable.", "confirmed", "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z");
    });
    insertBulkMemories();

    const report = recallMemoriesReport(location, "deployment invariant", 20);
    expect(report.records).toEqual([]);
    expect(report).toMatchObject({ totalEligible: 5_001, processedCandidates: 5_000, limit: 20, truncated: true });
  });
  it("validates recall limits", () => {
    createProject();
    expect(() => recallMemories(location, "", 0)).toThrow("Memory limit");
    expect(() => recallMemories(location, "", 501)).toThrow("Memory limit");
  });
});


describe("versioned knowledge schema migration v13", () => {
  it("preserves legacy memories and imports their lifecycle, content, and provenance", () => {
    createProject();
    const insert = database!.prepare(`
      INSERT INTO memories
        (id, category, title, content, status, source_path, commit_sha, source_hash,
         author, updated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const timestamp = "2026-11-03T12:00:00.000Z";
    insert.run("legacy-confirmed", "decision", "Confirmed title", "Confirmed body", "confirmed",
      "src/decision.ts", "abc123", "hash-confirmed", "Original author", "Updater", timestamp, timestamp);
    insert.run("legacy-proposed", "hypothesis", "Proposed title", "Proposed body", "proposed",
      null, null, null, "Agent", "Agent", timestamp, timestamp);
    insert.run("legacy-obsolete", "architecture", "Obsolete title", "Obsolete body", "obsolete",
      null, null, null, null, null, timestamp, timestamp);
    insert.run("legacy-rejected", "note", "Rejected title", "Rejected body", "rejected",
      null, null, null, null, null, timestamp, timestamp);

    // Recreate the pre-v13 state while retaining the real populated legacy table.
    database!.exec(`
      DROP TABLE knowledge_events;
      DROP TABLE knowledge_relations;
      DROP TABLE knowledge_evidence;
      DROP TABLE knowledge_fragments;
      DROP TABLE knowledge_versions;
      DROP TABLE knowledge_items;
      DROP TABLE memory_idempotency;
      DELETE FROM schema_migrations WHERE version = 13;
    `);
    migrate(database!);

    const legacyRows = database!.prepare("SELECT id, title, content, status, author, updated_by FROM memories ORDER BY id").all();
    expect(legacyRows).toEqual([
      { id: "legacy-confirmed", title: "Confirmed title", content: "Confirmed body", status: "confirmed", author: "Original author", updated_by: "Updater" },
      { id: "legacy-obsolete", title: "Obsolete title", content: "Obsolete body", status: "obsolete", author: null, updated_by: null },
      { id: "legacy-proposed", title: "Proposed title", content: "Proposed body", status: "proposed", author: "Agent", updated_by: "Agent" },
      { id: "legacy-rejected", title: "Rejected title", content: "Rejected body", status: "rejected", author: null, updated_by: null },
    ]);
    expect(database!.prepare("SELECT COUNT(*) AS count FROM knowledge_items").get()).toEqual({ count: 4 });
    expect(database!.prepare("SELECT COUNT(*) AS count FROM knowledge_versions").get()).toEqual({ count: 4 });
    expect(database!.prepare("SELECT COUNT(*) AS count FROM knowledge_fragments").get()).toEqual({ count: 4 });
    expect(database!.prepare("SELECT COUNT(*) AS count FROM knowledge_events WHERE event_type = 'legacy_import'").get())
      .toEqual({ count: 4 });

    expect(database!.prepare("SELECT id, lifecycle, legacy_status, current_version_id FROM knowledge_items WHERE id = ?").get("legacy-confirmed"))
      .toEqual({
        id: "legacy-confirmed", lifecycle: "active", legacy_status: "confirmed",
        current_version_id: "legacy-v1:legacy-confirmed",
      });
    expect(database!.prepare("SELECT epistemic_state, title FROM knowledge_versions WHERE knowledge_id = ?").get("legacy-confirmed"))
      .toEqual({ epistemic_state: "user_asserted", title: "Confirmed title" });
    expect(database!.prepare("SELECT content FROM knowledge_fragments WHERE version_id = ?").get("legacy-v1:legacy-confirmed"))
      .toEqual({ content: "Confirmed body" });
    expect(database!.prepare("SELECT source_path, source_hash, commit_sha, actor FROM knowledge_evidence WHERE version_id = ?").get("legacy-v1:legacy-confirmed"))
      .toEqual({
        source_path: "src/decision.ts", source_hash: "hash-confirmed",
        commit_sha: "abc123", actor: "Updater",
      });
    expect(database!.prepare("SELECT lifecycle FROM knowledge_items WHERE id = ?").get("legacy-proposed"))
      .toEqual({ lifecycle: "active" });
    expect(database!.prepare("SELECT epistemic_state FROM knowledge_versions WHERE knowledge_id = ?").get("legacy-proposed"))
      .toEqual({ epistemic_state: "pending_validation" });
    expect(database!.prepare("SELECT lifecycle, legacy_status FROM knowledge_items WHERE id = ?").get("legacy-obsolete"))
      .toEqual({ lifecycle: "superseded", legacy_status: "obsolete" });
    expect(database!.prepare("SELECT epistemic_state FROM knowledge_versions WHERE knowledge_id = ?").get("legacy-obsolete"))
      .toEqual({ epistemic_state: "pending_validation" });
    expect(database!.prepare("SELECT lifecycle, legacy_status FROM knowledge_items WHERE id = ?").get("legacy-rejected"))
      .toEqual({ lifecycle: "archived", legacy_status: "rejected" });
    expect(database!.prepare("SELECT epistemic_state FROM knowledge_versions WHERE knowledge_id = ?").get("legacy-rejected"))
      .toEqual({ epistemic_state: "pending_validation" });
    expect(database!.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database!.prepare("SELECT COUNT(*) AS count FROM knowledge_evidence").get()).toEqual({ count: 1 });
    expect(database!.prepare("SELECT version FROM schema_migrations WHERE version = 13").get()).toEqual({ version: 13 });

    expect(() => database!.prepare("UPDATE knowledge_versions SET title = 'tampered' WHERE id = ?")
      .run("legacy-v1:legacy-confirmed")).toThrow("knowledge versions are immutable");
    expect(() => database!.prepare("DELETE FROM knowledge_versions WHERE id = ?")
      .run("legacy-v1:legacy-confirmed")).toThrow("knowledge versions are immutable");
    expect(() => database!.prepare("UPDATE knowledge_fragments SET content = 'tampered' WHERE id = ?")
      .run("legacy-fragment:legacy-confirmed:0")).toThrow("knowledge fragments are immutable");
    expect(() => database!.prepare("DELETE FROM knowledge_events WHERE id = ?")
      .run("legacy-event:legacy-confirmed:0")).toThrow("knowledge events are append-only");
    expect(database!.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    // Re-running migrate must not duplicate imported versions, fragments, evidence, or events.
    migrate(database!);
    expect(database!.prepare("SELECT COUNT(*) AS count FROM knowledge_versions").get()).toEqual({ count: 4 });
    expect(database!.prepare("SELECT COUNT(*) AS count FROM knowledge_events WHERE event_type = 'legacy_import'").get())
      .toEqual({ count: 4 });
  });
});


describe("empty database schema v13", () => {
  it("creates the versioned knowledge tables without requiring legacy rows", () => {
    createProject();
    const tables = database!.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'knowledge_items', 'knowledge_versions', 'knowledge_fragments',
        'knowledge_evidence', 'knowledge_relations', 'knowledge_events',
        'memory_idempotency'
      ) ORDER BY name
    `).all() as Array<{ name: string }>;
    expect(tables.map((table) => table.name)).toEqual([
      "knowledge_events", "knowledge_evidence", "knowledge_fragments",
      "knowledge_items", "knowledge_relations", "knowledge_versions",
      "memory_idempotency",
    ]);
    expect(database!.prepare("SELECT version FROM schema_migrations WHERE version = 13").get()).toEqual({ version: 13 });
    expect(database!.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
