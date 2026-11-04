import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureMemories } from "../src/core/memory-capture.js";
import { requestMemoryReview } from "../src/core/memory-review-request.js";
import { openDatabase } from "../src/storage/database.js";
import type { ProjectLocation } from "../src/core/project.js";

let root: string | undefined;
let location: ProjectLocation;
function setup(): void {
  root = mkdtempSync(join(tmpdir(), "cnm-review-request-"));
  const rootPath = resolve(root);
  location = { id: "review-request-project", rootPath, dataDirectory: join(rootPath, ".cnm-data"),
    databasePath: join(rootPath, ".cnm-data", "memory.sqlite") };
  openDatabase(location).close();
}
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

function capture(title: string, key: string): { knowledgeId: string; versionId: string } {
  const result = captureMemories(location, { idempotencyKey: key, items: [{
    title, content: "Review request fixture", type: "decision", epistemicState: "verified",
  }] });
  const knowledgeId = result.outcomes[0]!.knowledgeId;
  const db = openDatabase(location);
  const row = db.prepare("SELECT current_version_id AS versionId FROM knowledge_items WHERE id=?").get(knowledgeId) as { versionId: string };
  db.close();
  return { knowledgeId, versionId: row.versionId };
}
function request(item: { knowledgeId: string; versionId: string }, extra: Record<string, unknown> = {}) {
  return requestMemoryReview(location, {
    items: [{ knowledgeId: item.knowledgeId, expectedVersionId: item.versionId,
      reasonCode: "manual_review", reason: "Verify this knowledge item" }],
    ...extra,
  });
}
function counts() {
  const db = openDatabase(location);
  const result = {
    events: (db.prepare("SELECT COUNT(*) AS count FROM knowledge_events WHERE event_type='reconciliation_review_requested'").get() as { count: number }).count,
    idempotency: (db.prepare("SELECT COUNT(*) AS count FROM memory_idempotency WHERE operation='memory_reconcile_request_review'").get() as { count: number }).count,
    items: (db.prepare("SELECT COUNT(*) AS count FROM knowledge_items").get() as { count: number }).count,
    versions: (db.prepare("SELECT COUNT(*) AS count FROM knowledge_versions").get() as { count: number }).count,
  };
  db.close();
  return result;
}

describe("memory reconciliation request_review", () => {
  it("defaults to dry-run and creates neither events nor idempotency rows", () => {
    setup();
    const item = capture("Review me", "capture-review-dry");
    const before = counts();
    const result = request(item);
    expect(result).toMatchObject({ status: "validated", dryRun: true, applied: false, eventsCreated: 0 });
    expect(result.items[0]).toMatchObject({ knowledgeId: item.knowledgeId, status: "ready" });
    expect(counts()).toEqual(before);
  });

  it("appends one audit event per selected item and preserves knowledge/version rows", () => {
    setup();
    const first = capture("First review", "capture-review-first");
    const second = capture("Second review", "capture-review-second");
    const before = counts();
    const setupDb = openDatabase(location);
    setupDb.prepare("INSERT INTO knowledge_evidence (id, version_id, evidence_type, metadata_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("evidence-review-first", first.versionId, "test", "{}", "2026-11-04T00:00:00.000Z");
    setupDb.prepare("INSERT INTO knowledge_relations (id, project_id, source_knowledge_id, target_knowledge_id, relation_type, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("relation-review-first-second", location.id, first.knowledgeId, second.knowledgeId, "depends_on", "2026-11-04T00:00:00.000Z");
    setupDb.close();
    const result = requestMemoryReview(location, {
      dryRun: false, idempotencyKey: "review-batch-1", actor: "agent",
      items: [
        { knowledgeId: second.knowledgeId, expectedVersionId: second.versionId, reasonCode: "manual_review", reason: "Check second" },
        { knowledgeId: first.knowledgeId, expectedVersionId: first.versionId, reasonCode: "stale_evidence", reason: "Source changed" },
      ],
    });
    expect(result).toMatchObject({ status: "applied", applied: true, eventsCreated: 2, idempotentReplay: false });
    expect(counts()).toEqual({ ...before, events: 2, idempotency: 1 });
    const db = openDatabase(location);
    const rows = db.prepare("SELECT event_type AS eventType, version_id AS versionId, payload_json AS payload FROM knowledge_events WHERE event_type='reconciliation_review_requested' ORDER BY knowledge_id").all() as Array<{ eventType: string; versionId: string; payload: string }>;
    db.close();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.eventType === "reconciliation_review_requested")).toBe(true);
    expect(rows.some((row) => JSON.parse(row.payload).reasonCode === "stale_evidence")).toBe(true);
    const firstPayload = JSON.parse(rows.find((row) => row.versionId === first.versionId)!.payload);
    expect(firstPayload.sourceEvidenceIds).toEqual(["evidence-review-first"]);
    expect(firstPayload.relationIds).toEqual(["relation-review-first-second"]);
  });

  it("returns the stored result for same-key replay and rejects changed payloads", () => {
    setup();
    const item = capture("Idempotent review", "capture-review-idempotent");
    const input = { dryRun: false, idempotencyKey: "review-replay-1", items: [{
      knowledgeId: item.knowledgeId, expectedVersionId: item.versionId,
      reasonCode: "manual_review" as const, reason: "Review once",
    }] };
    const first = requestMemoryReview(location, input);
    const replay = requestMemoryReview(location, input);
    expect(first.status).toBe("applied");
    expect(replay).toMatchObject({ status: "applied", idempotentReplay: true, eventsCreated: 1 });
    expect(counts().events).toBe(1);
    const mismatch = requestMemoryReview(location, { ...input, items: [{ ...input.items[0]!, reason: "Different payload" }] });
    expect(mismatch).toMatchObject({ status: "conflict", applied: false, reason: "idempotency_key_payload_mismatch" });
    expect(counts().events).toBe(1);
  });

  it("aborts the whole batch if any expected version is stale or an item is outside the project", () => {
    setup();
    const valid = capture("Valid review", "capture-review-valid");
    const missing = { knowledgeId: "not-in-this-project", versionId: "foreign-version" };
    const before = counts();
    const result = requestMemoryReview(location, { dryRun: false, idempotencyKey: "review-conflict-1", items: [
      { knowledgeId: valid.knowledgeId, expectedVersionId: "stale-version", reasonCode: "manual_review", reason: "Stale expectation" },
      { knowledgeId: missing.knowledgeId, expectedVersionId: missing.versionId, reasonCode: "manual_review", reason: "Foreign item" },
    ] });
    expect(result).toMatchObject({ status: "conflict", applied: false, eventsCreated: 0 });
    expect(result.items.every((item) => item.status === "conflict")).toBe(true);
    expect(counts()).toEqual(before);
  });

  it("rolls back all events and idempotency when event insertion fails", () => {
    setup();
    const item = capture("Rollback review", "capture-review-rollback");
    const db = openDatabase(location);
    db.exec(`CREATE TRIGGER fail_review_event BEFORE INSERT ON knowledge_events
      WHEN NEW.event_type='reconciliation_review_requested'
      BEGIN SELECT RAISE(ABORT, 'injected review event failure'); END;`);
    db.close();
    const before = counts();
    expect(() => request(item, { dryRun: false, idempotencyKey: "review-rollback-1" })).toThrow("injected review event failure");
    expect(counts()).toEqual(before);
  });

  it("rejects duplicate IDs, missing apply keys, and invalid batch sizes", () => {
    setup();
    const item = capture("Invalid review", "capture-review-invalid");
    const entry = { knowledgeId: item.knowledgeId, expectedVersionId: item.versionId,
      reasonCode: "manual_review" as const, reason: "Review" };
    expect(() => requestMemoryReview(location, { dryRun: false, items: [entry] })).toThrow("idempotencyKey");
    expect(() => requestMemoryReview(location, { items: [entry, entry] })).toThrow("duplicate");
    expect(() => requestMemoryReview(location, { items: [] })).toThrow("1–100");
  });
});
