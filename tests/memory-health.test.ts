import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/database.js";
import { captureMemories } from "../src/core/memory-capture.js";
import { searchMemories } from "../src/core/memory-search.js";
import { getMemoryHealth } from "../src/core/memory-health.js";
import type { ProjectLocation } from "../src/core/project.js";

let root: string | undefined;
let location: ProjectLocation;
function setup(): void {
  root = mkdtempSync(join(tmpdir(), "cnm-memory-health-"));
  const rootPath = resolve(root);
  location = {
    id: "health-test-project", rootPath, dataDirectory: join(rootPath, ".cnm-data"),
    databasePath: join(rootPath, ".cnm-data", "memory.sqlite"),
  };
  openDatabase(location).close();
}
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

function capture(title: string, options: {
  epistemicState?: "observed" | "verified" | "inferred" | "user_asserted" | "planned" | "hypothesis" | "pending_validation";
  sourcePath?: string; sourceHash?: string; commitSha?: string;
} = {}): string {
  const result = captureMemories(location, {
    idempotencyKey: "health-" + title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    items: [{
      title, content: "Health fixture content for " + title, type: "decision",
      epistemicState: options.epistemicState ?? "verified",
      evidence: options.sourcePath || options.sourceHash || options.commitSha ? [{
        evidenceType: "source_reference", sourcePath: options.sourcePath,
        sourceHash: options.sourceHash, commitSha: options.commitSha,
      }] : [],
    }],
  });
  return result.outcomes[0]!.knowledgeId;
}

describe("memory health", () => {
  it("reports lifecycle, epistemic, pending, conflict, and lazy search-index state without changing knowledge", () => {
    setup();
    const verified = capture("Verified health decision");
    const pending = capture("Pending health question", { epistemicState: "pending_validation" });
    const db = openDatabase(location);
    db.prepare("INSERT INTO knowledge_relations(id, project_id, source_knowledge_id, target_knowledge_id, relation_type, reason, created_at) VALUES (?, ?, ?, ?, 'contradicts', ?, ?)")
      .run("health-conflict", location.id, verified, pending, "Review contradictory assumptions", new Date().toISOString());
    const before = {
      items: (db.prepare("SELECT COUNT(*) AS count FROM knowledge_items").get() as { count: number }).count,
      versions: (db.prepare("SELECT COUNT(*) AS count FROM knowledge_versions").get() as { count: number }).count,
      relations: (db.prepare("SELECT COUNT(*) AS count FROM knowledge_relations").get() as { count: number }).count,
    };
    db.close();

    const report = getMemoryHealth(location, { limit: 10 });
    const verify = openDatabase(location);
    const after = {
      items: (verify.prepare("SELECT COUNT(*) AS count FROM knowledge_items").get() as { count: number }).count,
      versions: (verify.prepare("SELECT COUNT(*) AS count FROM knowledge_versions").get() as { count: number }).count,
      relations: (verify.prepare("SELECT COUNT(*) AS count FROM knowledge_relations").get() as { count: number }).count,
    };
    verify.close();

    expect(report.status).toBe("warning");
    expect(report.counts.knowledgeItems).toBe(2);
    expect(report.pendingValidation.total).toBe(1);
    expect(report.pendingValidation.samples[0]?.knowledgeId).toBe(pending);
    expect(report.conflicts.total).toBe(1);
    expect(report.conflicts.samples[0]?.relationId).toBe("health-conflict");
    expect(report.searchIndex.status).toBe("not_initialized");
    expect(after).toEqual(before);
  });

  it("checks source evidence hashes and never claims an incomplete sample is fully fresh", () => {
    setup();
    const sourcePath = "src/health-fixture.ts";
    mkdirSync(join(location.rootPath, "src"), { recursive: true });
    const original = "export const healthFixture = true;\n";
    writeFileSync(join(location.rootPath, sourcePath), original);
    const sourceHash = createHash("sha256").update(original).digest("hex");
    const id = capture("Source-backed health decision", { sourcePath, sourceHash });
    const current = getMemoryHealth(location, { limit: 10 });
    expect(current.sourceFreshness.counts.current).toBe(1);
    expect(current.sourceFreshness.samples[0]).toMatchObject({ knowledgeId: id, status: "current", reason: "source_hash_matches" });

    writeFileSync(join(location.rootPath, sourcePath), "export const healthFixture = false;\n");
    const stale = getMemoryHealth(location, { limit: 10 });
    expect(stale.sourceFreshness.status).toBe("stale");
    expect(stale.sourceFreshness.counts.stale).toBe(1);
    expect(stale.sourceFreshness.samples[0]?.reason).toBe("source_hash_mismatch");
  });

  it("reports unknown when the bounded source-evidence sample is truncated", () => {
    setup();
    mkdirSync(join(location.rootPath, "src"), { recursive: true });
    for (const name of ["one", "two"]) {
      const sourcePath = "src/" + name + ".ts";
      const content = "export const " + name + " = true;\\n";
      writeFileSync(join(location.rootPath, sourcePath), content);
      capture("Source evidence " + name, {
        sourcePath, sourceHash: createHash("sha256").update(content).digest("hex"),
      });
    }
    const report = getMemoryHealth(location, { limit: 1 });
    expect(report.sourceFreshness.sampled).toBe(1);
    expect(report.sourceFreshness.total).toBe(2);
    expect(report.sourceFreshness.status).toBe("unknown");
    expect(report.sourceFreshness.truncated).toBe(true);
    expect(report.warnings).toContain("The source-evidence sample is truncated; unexamined evidence is not asserted fresh.");
  });

  it("detects orphaned relation references even when legacy/corrupt data bypassed foreign keys", () => {
    setup();
    const source = capture("Orphan relation source");
    const db = openDatabase(location);
    db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO knowledge_relations(id, project_id, source_knowledge_id, target_knowledge_id, relation_type, created_at) VALUES (?, ?, ?, ?, 'related_to', ?)")
      .run("orphan-health-relation", location.id, source, "missing-knowledge-id", new Date().toISOString());
    db.close();

    const report = getMemoryHealth(location, { limit: 5 });
    expect(report.status).toBe("error");
    expect(report.brokenReferences.foreignKeyViolationsLowerBound).toBeGreaterThan(0);
    expect(report.brokenReferences.orphanRelations).toBe(1);
  });

  it("checks FTS bookkeeping after search and validates sample bounds", () => {
    setup();
    capture("Indexed health fixture");
    searchMemories(location, { query: "health fixture" });
    const report = getMemoryHealth(location, { limit: 1 });
    expect(report.searchIndex.status).toBe("consistent");
    expect(report.searchIndex.indexedVersions).toBe(1);
    expect(report.serializedChars).toBeLessThanOrEqual(report.maxChars);
    const db = openDatabase(location);
    db.prepare("DELETE FROM memory_search_fts WHERE version_id=(SELECT id FROM knowledge_versions LIMIT 1)").run();
    db.close();
    const inconsistent = getMemoryHealth(location, { limit: 1 });
    expect(inconsistent.searchIndex.status).toBe("inconsistent");
    expect(inconsistent.searchIndex.missingFtsRows).toBe(1);
    expect(() => searchMemories(location, { query: "health fixture" }))
      .toThrow(/memory search index is inconsistent/i);
    expect(() => getMemoryHealth(location, { limit: 101 })).toThrow("limit");
    expect(() => getMemoryHealth(location, { limit: 0 })).toThrow("limit");
  });
});
