import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureMemories } from "../src/core/memory-capture.js";
import { previewMemoryReconciliation } from "../src/core/memory-reconcile.js";
import { openDatabase } from "../src/storage/database.js";
import type { ProjectLocation } from "../src/core/project.js";

let root: string | undefined;
let location: ProjectLocation;
function setup(): void {
  root = mkdtempSync(join(tmpdir(), "cnm-memory-reconcile-"));
  const rootPath = resolve(root);
  location = {
    id: "reconcile-test-project", rootPath, dataDirectory: join(rootPath, ".cnm-data"),
    databasePath: join(rootPath, ".cnm-data", "memory.sqlite"),
  };
  openDatabase(location).close();
}
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

function capture(title: string, key: string, source?: { path: string; hash: string }): string {
  const result = captureMemories(location, {
    idempotencyKey: key,
    items: [{
      title, content: "Reconciliation fixture " + key, type: "decision", epistemicState: "verified",
      evidence: source ? [{ evidenceType: "source_reference", sourcePath: source.path, sourceHash: source.hash }] : [],
    }],
  });
  return result.outcomes[0]!.knowledgeId;
}

describe("memory reconciliation preview", () => {
  it("reports conservative duplicate-title candidates deterministically and never mutates knowledge", () => {
    setup();
    const first = "reconcile-duplicate-one";
    const second = "reconcile-duplicate-two";
    const db = openDatabase(location);
    const now = new Date().toISOString();
    for (const [id, versionId, title] of [
      [first, first + "-v1", "Same decision"],
      [second, second + "-v1", " same DECISION "],
    ]) {
      db.prepare("INSERT INTO knowledge_items(id, project_id, knowledge_type, lifecycle, created_at, updated_at) VALUES (?, ?, 'decision', 'active', ?, ?)")
        .run(id, location.id, now, now);
      db.prepare("INSERT INTO knowledge_versions(id, knowledge_id, version_number, epistemic_state, title, created_at) VALUES (?, ?, 1, 'verified', ?, ?)")
        .run(versionId, id, title, now);
      db.prepare("UPDATE knowledge_items SET current_version_id=? WHERE id=?").run(versionId, id);
    }
    const before = {
      items: (db.prepare("SELECT COUNT(*) AS count FROM knowledge_items").get() as { count: number }).count,
      versions: (db.prepare("SELECT COUNT(*) AS count FROM knowledge_versions").get() as { count: number }).count,
      events: (db.prepare("SELECT COUNT(*) AS count FROM knowledge_events").get() as { count: number }).count,
    };
    db.close();

    const report = previewMemoryReconciliation(location, { limit: 10 });
    expect(report.mode).toBe("dry_run");
    expect(report.applied).toBe(false);
    expect(report.duplicateCandidates).toContainEqual({
      normalizedTitle: "same decision",
      knowledgeIds: [first, second].sort(),
      titles: expect.arrayContaining(["Same decision", " same DECISION "]),
    });

    const verify = openDatabase(location);
    const after = {
      items: (verify.prepare("SELECT COUNT(*) AS count FROM knowledge_items").get() as { count: number }).count,
      versions: (verify.prepare("SELECT COUNT(*) AS count FROM knowledge_versions").get() as { count: number }).count,
      events: (verify.prepare("SELECT COUNT(*) AS count FROM knowledge_events").get() as { count: number }).count,
    };
    verify.close();
    expect(after).toEqual(before);
  });

  it("reports stale source evidence and bounded dependent-knowledge review candidates", () => {
    setup();
    const sourcePath = "src/reconcile-source.ts";
    mkdirSync(join(location.rootPath, "src"), { recursive: true });
    const original = "export const current = true;\\n";
    writeFileSync(join(location.rootPath, sourcePath), original);
    const source = capture("Source-backed decision", "reconcile-source", {
      path: sourcePath, hash: createHash("sha256").update(original).digest("hex"),
    });
    const dependent = capture("Dependent decision", "reconcile-dependent");
    const db = openDatabase(location);
    db.prepare("INSERT INTO knowledge_relations(id, project_id, source_knowledge_id, target_knowledge_id, relation_type, reason, created_at) VALUES (?, ?, ?, ?, 'depends_on', ?, ?)")
      .run("reconcile-dependency", location.id, dependent, source, "Depends on source-backed decision", new Date().toISOString());
    db.close();
    writeFileSync(join(location.rootPath, sourcePath), "export const current = false;\\n");

    const report = previewMemoryReconciliation(location, { limit: 5 });
    expect(report.staleEvidence.some((item) => item.knowledgeId === source)).toBe(true);
    expect(report.dependentReview).toContainEqual(expect.objectContaining({
      knowledgeId: dependent, relatedKnowledgeId: source, relationType: "depends_on",
    }));
  });


  it("traverses dependent-review candidates in the declared direction of each relation", () => {
    setup();
    const sourcePath = "src/directed-impact-source.ts";
    mkdirSync(join(location.rootPath, "src"), { recursive: true });
    const original = "export const direction = 'before';\\n";
    writeFileSync(join(location.rootPath, sourcePath), original);
    const staleSource = capture("Directed impact source", "directed-impact-source", {
      path: sourcePath, hash: createHash("sha256").update(original).digest("hex"),
    });
    const dependsOn = capture("Depends on stale source", "directed-impact-depends");
    const derivedFrom = capture("Derived from stale source", "directed-impact-derived");
    const affected = capture("Affected by stale source", "directed-impact-affected");
    const inverseDependsOn = capture("Stale source depends on this", "directed-impact-inverse-depends");
    const inverseDerivedFrom = capture("Stale source derived from this", "directed-impact-inverse-derived");
    const inverseAffects = capture("This affects stale source", "directed-impact-inverse-affects");
    const related = capture("Only related to stale source", "directed-impact-related");

    const relations = [
      ["directed-depends-on", dependsOn, staleSource, "depends_on"],
      ["directed-derived-from", derivedFrom, staleSource, "derived_from"],
      ["directed-affects", staleSource, affected, "affects"],
      // These reverse orientations must not mark the other endpoint dependent.
      ["inverse-depends-on", staleSource, inverseDependsOn, "depends_on"],
      ["inverse-derived-from", staleSource, inverseDerivedFrom, "derived_from"],
      ["inverse-affects", inverseAffects, staleSource, "affects"],
      ["non-propagating-related-to", staleSource, related, "related_to"],
    ] as const;
    const db = openDatabase(location);
    const insert = db.prepare(`
      INSERT INTO knowledge_relations
        (id, project_id, source_knowledge_id, target_knowledge_id, relation_type, reason, created_at)
      VALUES (?, ?, ?, ?, ?, 'direction regression fixture', ?)
    `);
    for (const [id, source, target, relationType] of relations) {
      insert.run(id, location.id, source, target, relationType, new Date().toISOString());
    }
    db.close();
    writeFileSync(join(location.rootPath, sourcePath), "export const direction = 'after';\\n");

    const report = previewMemoryReconciliation(location, { limit: 20 });
    expect(report.staleEvidence.some((item) => item.knowledgeId === staleSource)).toBe(true);
    expect(report.dependentReview.map((item) => item.knowledgeId)).toEqual(
      [dependsOn, derivedFrom, affected].sort(),
    );
    expect(report.dependentReview).toEqual(expect.arrayContaining([
      expect.objectContaining({
        knowledgeId: dependsOn, relatedKnowledgeId: staleSource, staleKnowledgeId: staleSource,
        relationType: "depends_on", relationId: "directed-depends-on",
      }),
      expect.objectContaining({
        knowledgeId: derivedFrom, relatedKnowledgeId: staleSource, staleKnowledgeId: staleSource,
        relationType: "derived_from", relationId: "directed-derived-from",
      }),
      expect.objectContaining({
        knowledgeId: affected, relatedKnowledgeId: staleSource, staleKnowledgeId: staleSource,
        relationType: "affects", relationId: "directed-affects",
      }),
    ]));
    expect(report.summary.dependentReviewCandidates).toBe(3);
    expect(report.truncation.dependentReview).toBe(false);
  });

  it("rejects invalid limits", () => {
    setup();
    expect(() => previewMemoryReconciliation(location, { limit: 0 })).toThrow("limit");
    expect(() => previewMemoryReconciliation(location, { limit: 101 })).toThrow("limit");
  });
});
