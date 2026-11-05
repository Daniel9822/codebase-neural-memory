import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureMemories } from "../src/core/memory-capture.js";
import { requestMemoryReview } from "../src/core/memory-review-request.js";
import { listMemoryReviews, resolveMemoryReview } from "../src/core/memory-review.js";
import { updateMemoryVersion } from "../src/core/memory-update.js";
import { openDatabase } from "../src/storage/database.js";
import type { ProjectLocation } from "../src/core/project.js";

let root: string | undefined;
let location: ProjectLocation;
function setup(): void {
  root = mkdtempSync(join(tmpdir(), "cnm-review-lifecycle-"));
  const rootPath = resolve(root);
  location = { id: "review-lifecycle-project", rootPath, dataDirectory: join(rootPath, ".cnm-data"),
    databasePath: join(rootPath, ".cnm-data", "memory.sqlite") };
  openDatabase(location).close();
}
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

function capture(key: string): { knowledgeId: string; versionId: string } {
  const result = captureMemories(location, { idempotencyKey: key, items: [{
    title: "Review lifecycle fixture", content: "Persistent review queue", type: "decision", epistemicState: "verified",
  }] });
  const knowledgeId = result.outcomes[0]!.knowledgeId;
  const db = openDatabase(location);
  const row = db.prepare("SELECT current_version_id AS versionId FROM knowledge_items WHERE id=?")
    .get(knowledgeId) as { versionId: string };
  db.close();
  return { knowledgeId, versionId: row.versionId };
}

function request(item: { knowledgeId: string; versionId: string }): string {
  requestMemoryReview(location, { dryRun: false, idempotencyKey: "request-review-1", items: [{
    knowledgeId: item.knowledgeId, expectedVersionId: item.versionId,
    reasonCode: "manual_review", reason: "Check this knowledge item",
  }] });
  const db = openDatabase(location);
  const row = db.prepare("SELECT id FROM knowledge_events WHERE event_type='reconciliation_review_requested'")
    .get() as { id: string };
  db.close();
  return row.id;
}

describe("persistent memory review lifecycle", () => {
  it("lists requested reviews without writes and resolves them with an immutable event", () => {
    setup();
    const item = capture("capture-review-lifecycle");
    const requestEventId = request(item);
    expect(listMemoryReviews(location)).toMatchObject({
      returnedItems: 1, totalItems: 1, truncated: false,
      items: [{ requestEventId, knowledgeId: item.knowledgeId, status: "open" }],
    });
    const before = openDatabase(location);
    const beforeCounts = {
      items: (before.prepare("SELECT COUNT(*) AS n FROM knowledge_items").get() as { n: number }).n,
      versions: (before.prepare("SELECT COUNT(*) AS n FROM knowledge_versions").get() as { n: number }).n,
    };
    before.close();

    const input = {
      requestEventId, knowledgeId: item.knowledgeId, expectedVersionId: item.versionId,
      resolution: "reviewed_current" as const, reason: "Reviewed against current source",
      actor: "test-agent", idempotencyKey: "resolve-review-1",
    };
    expect(resolveMemoryReview(location, input)).toMatchObject({ status: "resolved", applied: true, idempotentReplay: false });
    expect(resolveMemoryReview(location, input)).toMatchObject({ status: "resolved", applied: true, idempotentReplay: true });
    expect(listMemoryReviews(location)).toMatchObject({ returnedItems: 0, totalItems: 0, items: [] });

    const after = openDatabase(location);
    expect(after.prepare("SELECT COUNT(*) AS n FROM knowledge_items").get()).toEqual({ n: beforeCounts.items });
    expect(after.prepare("SELECT COUNT(*) AS n FROM knowledge_versions").get()).toEqual({ n: beforeCounts.versions });
    const event = after.prepare("SELECT event_type AS type, payload_json AS payload FROM knowledge_events WHERE event_type='reconciliation_review_resolved'")
      .get() as { type: string; payload: string };
    after.close();
    expect(event.type).toBe("reconciliation_review_resolved");
    expect(JSON.parse(event.payload)).toMatchObject({ requestEventId, resolution: "reviewed_current" });
  });

  it("keeps stale-version requests visible and refuses resolution against an advanced version", () => {
    setup();
    const item = capture("capture-review-stale");
    const requestEventId = request(item);
    const advanced = updateMemoryVersion(location, {
      knowledgeId: item.knowledgeId, expectedVersionId: item.versionId,
      reason: "Advance while review is pending", summary: "New current version",
    });
    expect(advanced.status).toBe("updated");
    expect(listMemoryReviews(location).items[0]).toMatchObject({ requestEventId, status: "stale_version" });
    const result = resolveMemoryReview(location, {
      requestEventId, knowledgeId: item.knowledgeId, expectedVersionId: item.versionId,
      resolution: "reviewed_current", reason: "Attempt stale resolution", idempotencyKey: "resolve-stale-review",
    });
    expect(result).toMatchObject({ status: "conflict", applied: false, currentVersionId: advanced.currentVersionId,
      reason: "request_missing_or_version_changed" });
    expect(listMemoryReviews(location).items).toHaveLength(1);
  });

  it("rejects reuse of an idempotency key with a different resolution payload", () => {
    setup();
    const item = capture("capture-review-idempotency");
    const requestEventId = request(item);
    const base = {
      requestEventId, knowledgeId: item.knowledgeId, expectedVersionId: item.versionId,
      resolution: "not_actionable" as const, reason: "No action required", idempotencyKey: "resolve-key-reuse",
    };
    expect(resolveMemoryReview(location, base).status).toBe("resolved");
    expect(resolveMemoryReview(location, { ...base, reason: "Changed reason" })).toMatchObject({
      status: "conflict", applied: false, reason: "idempotency_key_payload_mismatch",
    });
  });
});
