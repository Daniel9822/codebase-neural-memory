import { mkdtempSync, rmSync } from "node:fs";
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
  tags?: string[]; aliases?: string[]; sourcePath?: string; sourceSymbol?: string;
}): string {
  const result = captureMemories(location, {
    idempotencyKey,
    items: [{
      title: item.title, content: item.content, type: item.type ?? "architecture",
      summary: item.summary ?? "", epistemicState: item.epistemicState ?? "verified",
      tags: item.tags, aliases: item.aliases,
      evidence: item.sourcePath || item.sourceSymbol ? [{
        evidenceType: "source_reference", sourcePath: item.sourcePath, sourceSymbol: item.sourceSymbol,
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
    } finally { verify.close(); }
  });

  it("builds compact categorized bootstrap context with freshness limits and character bounds", () => {
    setup();
    capture("bootstrap-verified", { title: "Verified architecture", content: "Stable project design", epistemicState: "verified" });
    capture("bootstrap-risk", { title: "Open deployment risk", content: "Deployment behavior needs investigation", type: "risk", epistemicState: "inferred" });
    capture("bootstrap-pending", { title: "Pending validation item", content: "This hypothesis needs a test", epistemicState: "pending_validation" });
    const result = bootstrapMemory(location, { maxItems: 10, maxChars: 3000 });
    expect(result.highValue.some((entry) => entry.title === "Verified architecture")).toBe(true);
    expect(result.openRisks.some((entry) => entry.title === "Open deployment risk")).toBe(true);
    expect(result.pendingValidation.some((entry) => entry.title === "Pending validation item")).toBe(true);
    expect(result.freshness.sourceEvidence).toBe("not_checked");
    expect(result.serializedChars).toBeLessThanOrEqual(3000);
    expect(() => bootstrapMemory(location, { maxItems: 51 })).toThrow("maxItems");
    expect(() => bootstrapMemory(location, { maxChars: 999 })).toThrow("maxChars");
  });
});
