import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureMemories } from "../src/core/memory-capture.js";
import { getMemoryImpact } from "../src/core/memory-impact.js";
import { openDatabase } from "../src/storage/database.js";
import type { ProjectLocation } from "../src/core/project.js";

let root: string | undefined;
let location: ProjectLocation;

function setup(): void {
  root = mkdtempSync(join(tmpdir(), "cnm-memory-impact-"));
  const rootPath = resolve(root);
  location = {
    id: "memory-impact-test-project",
    rootPath,
    dataDirectory: join(rootPath, ".cnm-data"),
    databasePath: join(rootPath, ".cnm-data", "memory.sqlite"),
  };
  openDatabase(location).close();
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function capture(idempotencyKey: string, title: string): { knowledgeId: string; versionId: string } {
  const result = captureMemories(location, {
    idempotencyKey,
    items: [{
      title,
      content: "Relationship impact fixture: " + idempotencyKey,
      type: "decision",
      epistemicState: "verified",
    }],
  });
  const outcome = result.outcomes[0]!;
  const db = openDatabase(location);
  try {
    const row = db.prepare("SELECT current_version_id AS versionId FROM knowledge_items WHERE id=?")
      .get(outcome.knowledgeId) as { versionId: string };
    return { knowledgeId: outcome.knowledgeId, versionId: row.versionId };
  } finally {
    db.close();
  }
}

function relate(id: string, source: string, target: string, relationType: string): void {
  const db = openDatabase(location);
  try {
    db.prepare(`
      INSERT INTO knowledge_relations
        (id, project_id, source_knowledge_id, target_knowledge_id, relation_type, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, location.id, source, target, relationType, "Impact graph fixture", "2026-11-05T00:00:00.000Z");
  } finally {
    db.close();
  }
}

describe("bounded read-only memory relationship impact", () => {
  it("follows directed dependency and impact edges transitively with deterministic paths", () => {
    setup();
    const rootMemory = capture("impact-root", "Changed source decision");
    const dependent = capture("impact-dependent", "Dependent architecture decision");
    const derived = capture("impact-derived", "Derived implementation decision");
    const affected = capture("impact-affected", "Affected rollout decision");
    const supported = capture("impact-supported", "Supported operational decision");
    const unrelated = capture("impact-unrelated", "Unrelated convention");
    const contradiction = capture("impact-contradiction", "Contradictory alternative");

    relate("impact-edge-depends", dependent.knowledgeId, rootMemory.knowledgeId, "depends_on");
    relate("impact-edge-derived", derived.knowledgeId, dependent.knowledgeId, "derived_from");
    relate("impact-edge-affects", rootMemory.knowledgeId, affected.knowledgeId, "affects");
    relate("impact-edge-supports", rootMemory.knowledgeId, supported.knowledgeId, "supports");
    relate("impact-edge-related", unrelated.knowledgeId, rootMemory.knowledgeId, "related_to");
    relate("impact-edge-contradicts", rootMemory.knowledgeId, contradiction.knowledgeId, "contradicts");
    relate("impact-edge-cycle", rootMemory.knowledgeId, derived.knowledgeId, "depends_on");

    const db = openDatabase(location);
    const before = {
      items: db.prepare("SELECT COUNT(*) AS count FROM knowledge_items").get(),
      versions: db.prepare("SELECT COUNT(*) AS count FROM knowledge_versions").get(),
      relations: db.prepare("SELECT COUNT(*) AS count FROM knowledge_relations").get(),
      events: db.prepare("SELECT COUNT(*) AS count FROM knowledge_events").get(),
    };
    db.close();

    const report = getMemoryImpact(location, {
      knowledgeId: rootMemory.knowledgeId,
      expectedVersionId: rootMemory.versionId,
      maxDepth: 3,
      limit: 20,
    });

    expect(report).toMatchObject({
      status: "ready",
      mode: "read_only",
      projectId: location.id,
      root: { knowledgeId: rootMemory.knowledgeId, currentVersionId: rootMemory.versionId },
      totalImpacted: 4,
      returned: 4,
      truncated: false,
    });
    const byId = new Map(report.impacted.map(item => [item.knowledgeId, item]));
    expect([...byId.keys()].sort()).toEqual([
      dependent.knowledgeId,
      derived.knowledgeId,
      affected.knowledgeId,
      supported.knowledgeId,
    ].sort());
    expect(byId.get(dependent.knowledgeId)).toMatchObject({
      depth: 1,
      path: [{
        relationId: "impact-edge-depends",
        relationType: "depends_on",
        fromKnowledgeId: rootMemory.knowledgeId,
        toKnowledgeId: dependent.knowledgeId,
      }],
    });
    expect(byId.get(derived.knowledgeId)).toMatchObject({
      depth: 2,
      path: [
        { relationId: "impact-edge-depends", fromKnowledgeId: rootMemory.knowledgeId, toKnowledgeId: dependent.knowledgeId },
        { relationId: "impact-edge-derived", relationType: "derived_from", fromKnowledgeId: dependent.knowledgeId, toKnowledgeId: derived.knowledgeId },
      ],
    });
    expect(byId.get(affected.knowledgeId)?.path[0]).toMatchObject({
      relationId: "impact-edge-affects",
      fromKnowledgeId: rootMemory.knowledgeId,
      toKnowledgeId: affected.knowledgeId,
    });
    expect(byId.get(supported.knowledgeId)?.path[0]).toMatchObject({
      relationId: "impact-edge-supports",
      fromKnowledgeId: rootMemory.knowledgeId,
      toKnowledgeId: supported.knowledgeId,
    });
    expect(byId.has(unrelated.knowledgeId)).toBe(false);
    expect(byId.has(contradiction.knowledgeId)).toBe(false);
    expect(report.serializedChars).toBe(JSON.stringify({ ...report, serializedChars: 0 }).length);

    const verify = openDatabase(location);
    try {
      expect({
        items: verify.prepare("SELECT COUNT(*) AS count FROM knowledge_items").get(),
        versions: verify.prepare("SELECT COUNT(*) AS count FROM knowledge_versions").get(),
        relations: verify.prepare("SELECT COUNT(*) AS count FROM knowledge_relations").get(),
        events: verify.prepare("SELECT COUNT(*) AS count FROM knowledge_events").get(),
      }).toEqual(before);
    } finally {
      verify.close();
    }
  });

  it("bounds depth and result count and reports truncation when more traversal remains", () => {
    setup();
    const rootMemory = capture("impact-bounds-root", "Bounds root");
    const first = capture("impact-bounds-first", "Bounds first");
    const second = capture("impact-bounds-second", "Bounds second");
    const third = capture("impact-bounds-third", "Bounds third");
    relate("impact-bounds-a", first.knowledgeId, rootMemory.knowledgeId, "depends_on");
    relate("impact-bounds-b", second.knowledgeId, rootMemory.knowledgeId, "depends_on");
    relate("impact-bounds-c", third.knowledgeId, first.knowledgeId, "depends_on");

    const shallow = getMemoryImpact(location, { knowledgeId: rootMemory.knowledgeId, maxDepth: 1, limit: 10 });
    expect(shallow.impacted.map(item => item.depth)).toEqual([1, 1]);
    expect(shallow.truncated).toBe(false);
    const bounded = getMemoryImpact(location, { knowledgeId: rootMemory.knowledgeId, maxDepth: 3, limit: 1 });
    expect(bounded.returned).toBe(1);
    expect(bounded.totalImpacted).toBeNull();
    expect(bounded.truncated).toBe(true);
    expect(bounded.serializedChars).toBeLessThanOrEqual(bounded.maxChars);
  });

  it("returns a conflict when the caller's expected root version is stale and validates bounds", () => {
    setup();
    const rootMemory = capture("impact-stale-root", "Stale impact root");
    const stale = getMemoryImpact(location, {
      knowledgeId: rootMemory.knowledgeId,
      expectedVersionId: "old-version-id",
    });
    expect(stale).toMatchObject({
      status: "conflict",
      expectedVersionId: "old-version-id",
      root: { currentVersionId: rootMemory.versionId },
      impacted: [],
    });
    expect(() => getMemoryImpact(location, { knowledgeId: rootMemory.knowledgeId, maxDepth: 0 })).toThrow("maxDepth");
    expect(() => getMemoryImpact(location, { knowledgeId: rootMemory.knowledgeId, limit: 101 })).toThrow("limit");
    expect(() => getMemoryImpact(location, { knowledgeId: rootMemory.knowledgeId, maxChars: 900 })).toThrow("maxChars");
    expect(() => getMemoryImpact(location, { knowledgeId: "not-in-project" })).toThrow("not found in this project");
  });
});
