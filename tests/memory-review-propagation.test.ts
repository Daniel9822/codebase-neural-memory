import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/database.js";
import { captureMemories } from "../src/core/memory-capture.js";
import { updateMemoryVersion } from "../src/core/memory-update.js";
import { correctMemory } from "../src/core/memory-correct.js";
import { listMemoryReviews } from "../src/core/memory-review.js";
import type { ProjectLocation } from "../src/core/project.js";

let root: string | undefined;
let location: ProjectLocation;
function setup(): void {
  root = mkdtempSync(join(tmpdir(), "cnm-review-propagation-"));
  const rootPath = resolve(root);
  location = { id: "review-propagation-project", rootPath,
    dataDirectory: join(rootPath, ".cnm-data"), databasePath: join(rootPath, ".cnm-data", "memory.sqlite") };
  openDatabase(location).close();
}
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

function capture(title: string, content: string): { knowledgeId: string; versionId: string; fragmentId: string } {
  const result = captureMemories(location, { idempotencyKey: `seed-${title}`,
    items: [{ title, content, type: "architecture", epistemicState: "observed" }] });
  const knowledgeId = result.outcomes[0]!.knowledgeId;
  const db = openDatabase(location);
  try {
    const item = db.prepare("SELECT current_version_id AS versionId FROM knowledge_items WHERE id=?")
      .get(knowledgeId) as { versionId: string };
    const fragment = db.prepare("SELECT id FROM knowledge_fragments WHERE version_id=? ORDER BY ordinal LIMIT 1")
      .get(item.versionId) as { id: string };
    return { knowledgeId, versionId: item.versionId, fragmentId: fragment.id };
  } finally { db.close(); }
}

function relate(source: string, target: string, relationType: string): void {
  const db = openDatabase(location);
  try {
    db.prepare(`INSERT INTO knowledge_relations
      (id, project_id, source_knowledge_id, target_knowledge_id, relation_type, created_by, reason, created_at)
      VALUES (?, ?, ?, ?, ?, 'test', 'directed propagation fixture', '2026-11-05T00:00:00.000Z')`)
      .run(`relation:${source}:${target}:${relationType}`, location.id, source, target, relationType);
  } finally { db.close(); }
}

describe("transactional dependent review propagation", () => {
  it("queues only direct dependents with defined relation direction after update", () => {
    setup();
    const source = capture("Source", "Initial source.");
    const dependsOn = capture("Depends on source", "Dependent A.");
    const derivedFrom = capture("Derived from source", "Dependent B.");
    const affected = capture("Affected by source", "Dependent C.");
    const reversed = capture("Reverse edge", "Must not be queued.");
    const ignored = capture("Unsupported relation", "Must not be queued.");
    relate(dependsOn.knowledgeId, source.knowledgeId, "depends_on");
    relate(derivedFrom.knowledgeId, source.knowledgeId, "derived_from");
    relate(source.knowledgeId, affected.knowledgeId, "affects");
    relate(source.knowledgeId, reversed.knowledgeId, "depends_on");
    relate(source.knowledgeId, ignored.knowledgeId, "supports");

    const result = updateMemoryVersion(location, {
      knowledgeId: source.knowledgeId, expectedVersionId: source.versionId,
      reason: "Source behavior changed", content: "Updated source.",
    });
    expect(result).toMatchObject({ status: "updated", dependentReviewRequests: { created: 3, total: 3, truncated: false } });
    const queue = listMemoryReviews(location, 100);
    expect(queue.items.map((item) => item.knowledgeId).sort()).toEqual([
      dependsOn.knowledgeId, derivedFrom.knowledgeId, affected.knowledgeId,
    ].sort());
    expect(queue.items.every((item) => item.status === "open" && item.reasonCode === "dependent_stale_evidence")).toBe(true);

    const db = openDatabase(location);
    try {
      expect(db.prepare("SELECT current_version_id FROM knowledge_items WHERE id=?").get(dependsOn.knowledgeId))
        .toEqual({ current_version_id: dependsOn.versionId });
      const payload = db.prepare(`SELECT payload_json FROM knowledge_events
        WHERE knowledge_id=? AND event_type='reconciliation_review_requested'`).get(dependsOn.knowledgeId) as {payload_json:string};
      expect(JSON.parse(payload.payload_json)).toMatchObject({
        operation: "dependent_change_propagation", changedKnowledgeId: source.knowledgeId,
        previousSourceVersionId: source.versionId, currentSourceVersionId: result.currentVersionId,
      });
    } finally { db.close(); }

    const next = updateMemoryVersion(location, {
      knowledgeId: source.knowledgeId, expectedVersionId: result.currentVersionId!,
      reason: "Second source change", content: "Second update.",
    });
    expect(next.dependentReviewRequests).toMatchObject({ created: 0, total: 0, truncated: false });
    expect(listMemoryReviews(location, 100).items).toHaveLength(3);
  });

  it("queues direct dependents in the same transaction after a targeted correction", () => {
    setup();
    const source = capture("Corrected source", "Original statement.");
    const dependent = capture("Correction dependent", "Derived claim.");
    relate(dependent.knowledgeId, source.knowledgeId, "derived_from");
    const result = correctMemory(location, {
      knowledgeId: source.knowledgeId, expectedVersionId: source.versionId,
      targetFragmentId: source.fragmentId, replacementContent: "Corrected statement.",
      reason: "User corrected source", correctionSource: "user", epistemicState: "user_asserted",
    });
    expect(result).toMatchObject({ status: "corrected", dependentReviewRequests: { created: 1, total: 1, truncated: false } });
    expect(listMemoryReviews(location, 100).items).toMatchObject([
      { knowledgeId: dependent.knowledgeId, expectedVersionId: dependent.versionId, status: "open",
        reasonCode: "dependent_stale_evidence" },
    ]);
  });
});
