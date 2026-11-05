import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/database.js";
import { captureMemories } from "../src/core/memory-capture.js";
import { updateMemoryVersion } from "../src/core/memory-update.js";
import { searchMemories } from "../src/core/memory-search.js";
import { bootstrapMemory } from "../src/core/memory-bootstrap.js";
import type { ProjectLocation } from "../src/core/project.js";

let root: string | undefined;
let location: ProjectLocation;
function setup(): void {
  root = mkdtempSync(join(tmpdir(), "cnm-memory-search-"));
  const rootPath = resolve(root);
  location = { id: "search-test-project", rootPath, dataDirectory: join(rootPath, ".cnm-data"), databasePath: join(rootPath, ".cnm-data", "memory.sqlite") };
  openDatabase(location).close();
}
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

function capture(idempotencyKey: string, item: {
  title: string; content: string; type?: string; summary?: string; epistemicState?: "observed" | "verified" | "inferred" | "user_asserted" | "planned" | "hypothesis" | "pending_validation";
  tags?: string[]; aliases?: string[]; sourcePath?: string; sourceHash?: string; sourceSymbol?: string;
}): string {
  const result = captureMemories(location, {
    idempotencyKey,
    items: [{
      title: item.title, content: item.content, type: item.type ?? "architecture",
      summary: item.summary ?? "", epistemicState: item.epistemicState ?? "verified",
      tags: item.tags, aliases: item.aliases,
      evidence: item.sourcePath || item.sourceSymbol ? [{
        evidenceType: "source_reference", sourcePath: item.sourcePath, sourceHash: item.sourceHash, sourceSymbol: item.sourceSymbol,
      }] : [],
    }],
  });
  return result.outcomes[0]!.knowledgeId;
}

describe("versioned memory search and bootstrap", () => {
  it("searches titles, summaries, fragments, aliases, tags, paths, and symbols with match explanations", () => {
    setup();
    const id = capture("search-all-fields", {
      title: "Verified descriptor boundary",
      summary: "Protect filesystem access against symlink substitution.",
      content: "The reader validates the opened descriptor before consuming bytes.",
      tags: ["filesystem-security"], aliases: ["safe source open"],
      sourcePath: "src/core/secure-reader.ts", sourceSymbol: "openVerifiedFile",
    });
    for (const query of ["descriptor boundary", "symlink substitution", "opened descriptor", "safe source open",
      "filesystem security", "architecture", "src/core/secure-reader.ts", "openVerifiedFile", id]) {
      const result = searchMemories(location, { query });
      expect(result.results.some((entry) => entry.knowledgeId === id), query).toBe(true);
    }
    const exact = searchMemories(location, { query: "Verified descriptor boundary" });
    expect(exact.results[0]?.matchedBy).toContain("exact-title");
    expect(exact.results[0]?.matchedBy).toContain("lexical");
  });

  it("defaults to active current versions and makes historical versions explicit", () => {
    setup();
    const id = capture("search-history-seed", {
      title: "Versioned search fixture", content: "Initial version body", epistemicState: "observed",
    });
    const db = openDatabase(location);
    const current = (db.prepare("SELECT current_version_id AS id FROM knowledge_items WHERE id=?").get(id) as { id: string }).id;
    db.close();
    updateMemoryVersion(location, {
      knowledgeId: id, expectedVersionId: current, reason: "Record the verified correction",
      content: "Revised version body", epistemicState: "verified",
    });
    const currentOnly = searchMemories(location, { query: "Versioned search fixture" });
    const history = searchMemories(location, { query: "Versioned search fixture", includeHistorical: true });
    expect(currentOnly.results).toHaveLength(1);
    expect(currentOnly.results[0]?.versionNumber).toBe(2);
    expect(history.results).toHaveLength(2);
    expect(history.results.map((entry) => entry.versionNumber).sort()).toEqual([1, 2]);
  });

  it("applies type, epistemic, relation filters without leaking other projects", () => {
    setup();
    const target = capture("search-filter-target", {
      title: "Filtered memory", content: "Unique searchable token", type: "decision", epistemicState: "hypothesis",
    });
    const other = capture("search-filter-other", {
      title: "Filtered memory elsewhere", content: "Unique searchable token", type: "convention", epistemicState: "verified",
    });
    const db = openDatabase(location);
    try {
      db.prepare("INSERT INTO knowledge_relations (id, project_id, source_knowledge_id, target_knowledge_id, relation_type, reason, created_at) VALUES (?, ?, ?, ?, 'supports', 'test relation', ?)")
        .run("relation:test", location.id, other, target, new Date().toISOString());
    } finally { db.close(); }
    const filtered = searchMemories(location, {
      query: "Unique searchable token", type: "decision", epistemicState: "hypothesis",
      relatedKnowledgeId: other, relationType: "supports", createdAfter: "2000-01-01T00:00:00.000Z", createdBefore: "2999-01-01T00:00:00.000Z",
    });
    expect(filtered.results.map((entry) => entry.knowledgeId)).toEqual([target]);
    expect(searchMemories({ ...location, id: "different-project" }, { query: "Unique searchable token" }).results).toEqual([]);
    expect(() => searchMemories(location, { query: "x", relationType: "supports" })).toThrow("requires relatedKnowledgeId");
    expect(() => searchMemories(location, { query: "x", createdAfter: "not-a-date" })).toThrow("createdAfter");
  });

  it("browses high-value knowledge, filters metadata, and paginates with a snapshot-bound cursor", () => {
    setup();
    const first = capture("browse-first", {
      title: "First browse fixture", content: "First searchable body", type: "decision",
      tags: ["browse-tag"], sourcePath: "src/core/search-fixture.ts", sourceSymbol: "searchFixture",
    });
    const second = capture("browse-second", {
      title: "Second browse fixture", content: "Second searchable body", type: "architecture",
    });
    const pageOne = searchMemories(location, { limit: 1 });
    expect(pageOne.browsing).toBe(true);
    expect(pageOne.results).toHaveLength(1);
    expect(pageOne.nextCursor).toBeTruthy();
    const pageTwo = searchMemories(location, { limit: 1, cursor: pageOne.nextCursor });
    expect(pageTwo.results).toHaveLength(1);
    expect(pageTwo.results[0]?.knowledgeId).not.toBe(pageOne.results[0]?.knowledgeId);
    expect(() => searchMemories(location, { query: "different filter", limit: 1, cursor: pageOne.nextCursor }))
      .toThrow("does not match");
    expect(() => searchMemories({ ...location, id: "other-project" }, { limit: 1, cursor: pageOne.nextCursor }))
      .toThrow("does not match");
    expect(searchMemories(location, { tag: "browse-tag" }).results.map((item) => item.knowledgeId)).toContain(first);
    expect(searchMemories(location, { path: "src/core/search-fixture.ts" }).results.map((item) => item.knowledgeId)).toContain(first);
    expect(searchMemories(location, { symbol: "searchFixture" }).results.map((item) => item.knowledgeId)).toContain(first);
    expect(searchMemories(location, { type: "decision" }).results.map((item) => item.knowledgeId)).toContain(first);
    expect(searchMemories(location, { type: "architecture" }).results.map((item) => item.knowledgeId)).toContain(second);
    const sourceBacked = searchMemories(location, { tag: "browse-tag" }).results.find((item) => item.knowledgeId === first);
    expect(sourceBacked?.sourceEvidenceFreshness).toMatchObject({
      checked: true, status: "stale", reasons: ["source_file_missing"],
    });
    const withoutEvidence = searchMemories(location, { type: "architecture" }).results.find((item) => item.knowledgeId === second);
    expect(withoutEvidence?.sourceEvidenceFreshness).toMatchObject({
      checked: true, status: "not_checked", evidenceTotal: 0, reasons: ["no_source_evidence"],
    });
  });

  it("backfills existing versions and indexes later immutable versions through the update trigger", () => {
    setup();
    const id = capture("search-backfill", {
      title: "Backfill source map", content: "Original body", tags: ["migration"],
    });
    expect(searchMemories(location, { query: "Backfill source map" }).results).toHaveLength(1);
    const db = openDatabase(location);
    const current = (db.prepare("SELECT current_version_id AS id FROM knowledge_items WHERE id=?").get(id) as { id: string }).id;
    db.close();
    updateMemoryVersion(location, {
      knowledgeId: id, expectedVersionId: current, reason: "Append another version",
      content: "New body with distinctive phrase", tags: ["migration", "updated"],
    });
    const next = searchMemories(location, { query: "distinctive phrase" });
    expect(next.results[0]?.knowledgeId).toBe(id);
    expect(next.results[0]?.versionNumber).toBe(2);
    const verify = openDatabase(location);
    try {
      const indexed = verify.prepare("SELECT COUNT(*) AS count FROM memory_search_fts WHERE knowledge_id=?").get(id) as { count: number };
      expect(indexed.count).toBe(2);
      const bookkeeping = verify.prepare("SELECT COUNT(*) AS count FROM memory_search_indexed_versions").get() as { count: number };
      expect(bookkeeping.count).toBe(2);
    } finally { verify.close(); }
  });

  it("builds compact categorized bootstrap context with freshness limits and character bounds", () => {
    setup();
    capture("bootstrap-verified", { title: "Verified architecture", content: "Stable project design", epistemicState: "verified" });
    capture("bootstrap-risk", { title: "Open deployment risk", content: "Deployment behavior needs investigation", type: "risk", epistemicState: "inferred" });
    capture("bootstrap-pending", { title: "Pending validation item", content: "This hypothesis needs a test", epistemicState: "pending_validation" });
    const result = bootstrapMemory(location, { limit: 10, maxChars: 3000 });
    expect(result.highValue.some((entry) => entry.title === "Verified architecture")).toBe(true);
    expect(result.openRisks.some((entry) => entry.title === "Open deployment risk")).toBe(true);
    expect(result.pendingValidation.some((entry) => entry.title === "Pending validation item")).toBe(true);
    const withoutPending = bootstrapMemory(location, { limit: 10, maxChars: 3000, includePending: false });
    expect(withoutPending.pendingValidation).toHaveLength(0);
    expect(bootstrapMemory(location, { limit: 10, types: ["risk"] }).currentKnowledgeCount).toBe(1);
    expect(result.freshness.sourceEvidence).toBe("per_item_bounded");
    expect(result.serializedChars).toBeLessThanOrEqual(3000);
    expect(() => bootstrapMemory(location, { limit: 21 })).toThrow("limit");
    expect(() => bootstrapMemory(location, { maxChars: 499 })).toThrow("maxChars");
  });

  it("keeps the lazy FTS5 migration consistent across repeated queries and database reopen", () => {
    setup();
    const id = capture("fts-reopen-integrity", {
      title: "FTS reopen integrity fixture",
      content: "Distinctive source phrase survives migration and reopening.",
      tags: ["fts-recovery"],
      sourcePath: "src/core/fts-recovery.ts",
      sourceSymbol: "recoverSearchIndex",
    });
    expect(searchMemories(location, { query: "Distinctive source phrase" }).results[0]?.knowledgeId).toBe(id);

    const first = openDatabase(location);
    try {
      expect(first.prepare("SELECT version FROM schema_migrations WHERE version=14").get()).toEqual({ version: 14 });
      expect(first.prepare("SELECT COUNT(*) AS count FROM memory_search_fts WHERE knowledge_id=?").get(id))
        .toEqual({ count: 1 });
      expect(first.prepare("SELECT COUNT(*) AS count FROM memory_search_indexed_versions").get()).toEqual({ count: 1 });
      first.prepare("INSERT INTO memory_search_fts(memory_search_fts) VALUES ('integrity-check')").run();
    } finally {
      first.close();
    }

    const reopened = openDatabase(location);
    try {
      expect(searchMemories(location, { query: "recoverSearchIndex" }).results[0]?.knowledgeId).toBe(id);
      expect(reopened.prepare("SELECT COUNT(*) AS count FROM memory_search_fts WHERE knowledge_id=?").get(id))
        .toEqual({ count: 1 });
      expect(reopened.prepare("SELECT COUNT(*) AS count FROM memory_search_indexed_versions").get()).toEqual({ count: 1 });
      reopened.prepare("INSERT INTO memory_search_fts(memory_search_fts) VALUES ('integrity-check')").run();
      expect(reopened.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(reopened.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    } finally {
      reopened.close();
    }
  });


  it("fails closed when FTS rows are missing or duplicated despite matching row totals", () => {
    setup();
    const missing = capture("fts-drift-missing", {
      title: "Missing FTS row fixture",
      content: "This version must not silently disappear from search.",
    });
    const duplicate = capture("fts-drift-duplicate", {
      title: "Duplicate FTS row fixture",
      content: "This version must have exactly one search row.",
    });
    expect(searchMemories(location, { query: "FTS row fixture" }).results).toHaveLength(2);

    const db = openDatabase(location);
    try {
      const versions = db.prepare("SELECT id, knowledge_id AS knowledgeId FROM knowledge_versions ORDER BY knowledge_id").all() as Array<{
        id: string; knowledgeId: string;
      }>;
      const missingVersion = versions.find(version => version.knowledgeId === missing)!;
      const duplicateVersion = versions.find(version => version.knowledgeId === duplicate)!;
      const duplicateRow = db.prepare("SELECT * FROM memory_search_fts WHERE version_id=?").get(duplicateVersion.id) as Record<string, unknown>;
      db.prepare("DELETE FROM memory_search_fts WHERE version_id=?").run(missingVersion.id);
      const columns = Object.keys(duplicateRow);
      const placeholders = columns.map(() => "?").join(",");
      db.prepare(`INSERT INTO memory_search_fts(${columns.join(",")}) VALUES (${placeholders})`)
        .run(...columns.map(column => duplicateRow[column]));
      expect(db.prepare("SELECT COUNT(*) AS count FROM memory_search_fts").get()).toEqual({ count: 2 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM memory_search_indexed_versions").get()).toEqual({ count: 2 });
    } finally {
      db.close();
    }

    expect(() => searchMemories(location, { query: "FTS row fixture" }))
      .toThrow(/memory search index is inconsistent/i);

    const verify = openDatabase(location);
    try {
      expect(verify.prepare("SELECT COUNT(*) AS count FROM memory_search_fts").get()).toEqual({ count: 2 });
      expect(verify.prepare("SELECT COUNT(*) AS count FROM memory_search_indexed_versions").get()).toEqual({ count: 2 });
    } finally {
      verify.close();
    }
  });

  it("restores missing bookkeeping from an existing FTS row without inserting a duplicate", () => {
    setup();
    const id = capture("fts-marker-recovery", {
      title: "FTS marker recovery fixture",
      content: "The existing FTS row is preserved while its marker is restored.",
    });
    expect(searchMemories(location, { query: "FTS marker recovery" }).results[0]?.knowledgeId).toBe(id);
    const db = openDatabase(location);
    try {
      const versionId = (db.prepare("SELECT version_id AS versionId FROM memory_search_fts WHERE knowledge_id=?").get(id) as { versionId: string }).versionId;
      db.prepare("DELETE FROM memory_search_indexed_versions WHERE version_id=?").run(versionId);
    } finally {
      db.close();
    }

    expect(searchMemories(location, { query: "FTS marker recovery" }).results[0]?.knowledgeId).toBe(id);
    const verify = openDatabase(location);
    try {
      expect(verify.prepare("SELECT COUNT(*) AS count FROM memory_search_fts WHERE knowledge_id=?").get(id))
        .toEqual({ count: 1 });
      expect(verify.prepare("SELECT COUNT(*) AS count FROM memory_search_indexed_versions").get()).toEqual({ count: 1 });
    } finally {
      verify.close();
    }
  });


  it("surfaces current and stale source evidence in search and bootstrap without mutating memory history", () => {
    setup();
    mkdirSync(join(location.rootPath, "src"), { recursive: true });
    const sourcePath = "src/search-evidence-fixture.ts";
    const originalSource = "export const searchEvidence = true;\\n";
    writeFileSync(join(location.rootPath, sourcePath), originalSource);
    const sourceHash = createHash("sha256").update(originalSource).digest("hex");
    const id = capture("search-evidence-freshness", {
      title: "Source evidence freshness fixture",
      content: "Search and bootstrap should disclose stale source evidence.",
      sourcePath,
      sourceHash,
    });

    const beforeDb = openDatabase(location);
    const before = {
      items: beforeDb.prepare("SELECT COUNT(*) AS count FROM knowledge_items").get(),
      versions: beforeDb.prepare("SELECT COUNT(*) AS count FROM knowledge_versions").get(),
      fragments: beforeDb.prepare("SELECT COUNT(*) AS count FROM knowledge_fragments").get(),
      evidence: beforeDb.prepare("SELECT COUNT(*) AS count FROM knowledge_evidence").get(),
      events: beforeDb.prepare("SELECT COUNT(*) AS count FROM knowledge_events").get(),
    };
    beforeDb.close();

    const currentSearch = searchMemories(location, { query: "Source evidence freshness fixture" });
    expect(currentSearch.results[0]?.knowledgeId).toBe(id);
    expect(currentSearch.results[0]?.sourceEvidenceFreshness).toMatchObject({
      checked: true, status: "current", evidenceTotal: 1, sampledEvidence: 1, truncated: false,
    });
    expect(currentSearch.sourceEvidenceFreshness).toBe("per_result_bounded");
    expect(currentSearch.sourceEvidenceFreshnessScope).toBe("returned_results_only");

    const currentBootstrap = bootstrapMemory(location, { limit: 10 });
    const currentItem = currentBootstrap.highValue.find((entry) => entry.knowledgeId === id);
    expect(currentItem?.sourceEvidenceFreshness).toMatchObject({
      checked: true, status: "current", evidenceTotal: 1, sampledEvidence: 1, truncated: false,
    });
    expect(currentBootstrap.freshness.sourceEvidence).toBe("per_item_bounded");

    writeFileSync(join(location.rootPath, sourcePath), "export const searchEvidence = false;\\n");
    const staleSearch = searchMemories(location, { query: "Source evidence freshness fixture" });
    expect(staleSearch.results[0]?.sourceEvidenceFreshness).toMatchObject({
      checked: true, status: "stale", evidenceTotal: 1, sampledEvidence: 1, truncated: false,
      reasons: ["source_hash_mismatch"],
    });
    const staleBootstrap = bootstrapMemory(location, { limit: 10 });
    const staleItem = staleBootstrap.highValue.find((entry) => entry.knowledgeId === id);
    expect(staleItem?.sourceEvidenceFreshness).toMatchObject({
      checked: true, status: "stale", reasons: ["source_hash_mismatch"],
    });

    const afterDb = openDatabase(location);
    const after = {
      items: afterDb.prepare("SELECT COUNT(*) AS count FROM knowledge_items").get(),
      versions: afterDb.prepare("SELECT COUNT(*) AS count FROM knowledge_versions").get(),
      fragments: afterDb.prepare("SELECT COUNT(*) AS count FROM knowledge_fragments").get(),
      evidence: afterDb.prepare("SELECT COUNT(*) AS count FROM knowledge_evidence").get(),
      events: afterDb.prepare("SELECT COUNT(*) AS count FROM knowledge_events").get(),
    };
    afterDb.close();
    expect(after).toEqual(before);
  });

  it("keeps evidence freshness unknown when per-version evidence exceeds the sample bound", () => {
    setup();
    mkdirSync(join(location.rootPath, "src"), { recursive: true });
    const sourcePath = "src/bounded-evidence.ts";
    const source = "export const boundedEvidence = true;\\n";
    writeFileSync(join(location.rootPath, sourcePath), source);
    const sourceHash = createHash("sha256").update(source).digest("hex");
    const id = capture("search-evidence-sample-bound", {
      title: "Bounded evidence freshness fixture", content: "Evidence sampling is bounded.",
      sourcePath, sourceHash,
    });
    const db = openDatabase(location);
    try {
      const versionId = (db.prepare("SELECT current_version_id AS versionId FROM knowledge_items WHERE id=?")
        .get(id) as { versionId: string }).versionId;
      const insert = db.prepare(`
        INSERT INTO knowledge_evidence
          (id, version_id, evidence_type, source_path, source_hash, created_at)
        VALUES (?, ?, 'source_reference', ?, ?, ?)
      `);
      for (let index = 0; index < 3; index++) {
        insert.run("bounded-extra-evidence-" + index, versionId, sourcePath, sourceHash,
          new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString());
      }
    } finally {
      db.close();
    }

    const result = searchMemories(location, { query: "Bounded evidence freshness fixture" });
    expect(result.results[0]?.sourceEvidenceFreshness).toMatchObject({
      checked: true, status: "unknown", evidenceTotal: 4, sampledEvidence: 3, truncated: true,
    });
    expect(result.results[0]?.sourceEvidenceFreshness.reasons).toContain("evidence_sample_truncated");
  });

});
