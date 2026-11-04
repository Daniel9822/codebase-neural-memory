import { mkdtempSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureMemories } from "../src/core/memory-capture.js";
import { requestMemoryReview } from "../src/core/memory-review-request.js";
import { updateMemoryVersion } from "../src/core/memory-update.js";
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

  it("recovers a committed apply when the caller loses its response, and rejects changed payloads", () => {
    setup();
    const item = capture("Idempotent review", "capture-review-idempotent");
    const input = { dryRun: false, idempotencyKey: "review-replay-1", items: [{
      knowledgeId: item.knowledgeId, expectedVersionId: item.versionId,
      reasonCode: "manual_review" as const, reason: "Review once",
    }] };
    // Simulate the commit succeeding while the caller loses the response.
    // Retrying with the same key must recover the stored result without another event.
    requestMemoryReview(location, input);
    const replay = requestMemoryReview(location, input);
    expect(replay).toMatchObject({ status: "applied", idempotentReplay: true, eventsCreated: 1 });
    expect(counts().events).toBe(1);
    expect(counts().idempotency).toBe(1);
    const mismatch = requestMemoryReview(location, { ...input, items: [{ ...input.items[0]!, reason: "Different payload" }] });
    expect(mismatch).toMatchObject({ status: "conflict", applied: false, reason: "idempotency_key_payload_mismatch" });
    expect(counts().events).toBe(1);
  });

  it("detects a version advanced through an independent SQLite connection before reconciliation apply", () => {
    setup();
    const item = capture("Concurrent review", "capture-review-concurrent");
    const writer = openDatabase(location);
    const initialPointer = writer.prepare("SELECT current_version_id AS versionId FROM knowledge_items WHERE id=?")
      .get(item.knowledgeId) as { versionId: string };
    writer.close();

    // updateMemoryVersion opens its own SQLite connection and commits a new current version.
    const advanced = updateMemoryVersion(location, {
      knowledgeId: item.knowledgeId,
      expectedVersionId: initialPointer.versionId,
      reason: "Concurrent writer committed a newer version",
      summary: "Advanced by independent connection",
    });
    expect(advanced.status).toBe("updated");

    const observer = openDatabase(location);
    const committedPointer = observer.prepare("SELECT current_version_id AS versionId FROM knowledge_items WHERE id=?")
      .get(item.knowledgeId) as { versionId: string };
    observer.close();
    expect(committedPointer.versionId).toBe(advanced.currentVersionId);

    const before = counts();
    const result = requestMemoryReview(location, {
      dryRun: false, idempotencyKey: "review-independent-connection-stale",
      items: [{ knowledgeId: item.knowledgeId, expectedVersionId: item.versionId,
        reasonCode: "manual_review", reason: "Must not review a stale version" }],
    });
    expect(result).toMatchObject({ status: "conflict", applied: false, eventsCreated: 0 });
    expect(result.items[0]).toMatchObject({ status: "conflict", currentVersionId: advanced.currentVersionId });
    expect(counts()).toEqual(before);
  });

  it("recovers atomically when the process exits immediately after commit but before returning a response", () => {
    setup();
    const item = capture("Process boundary review", "capture-review-process-boundary");
    const input = { dryRun: false, idempotencyKey: "review-process-boundary-1", items: [{
      knowledgeId: item.knowledgeId, expectedVersionId: item.versionId,
      reasonCode: "manual_review" as const, reason: "Recover after process termination",
    }] };
    const script = `
      import { requestMemoryReview } from "./src/core/memory-review-request.js";
      const location = JSON.parse(process.env.CNM_TEST_LOCATION ?? "null");
      const input = JSON.parse(process.env.CNM_TEST_INPUT ?? "null");
      requestMemoryReview(location, input);
      process.exit(73);
    `;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env, CNM_TEST_LOCATION: JSON.stringify(location), CNM_TEST_INPUT: JSON.stringify(input) },
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(73);

    // The child committed the event and idempotency row, then terminated before sending a result.
    const replay = requestMemoryReview(location, input);
    expect(replay).toMatchObject({ status: "applied", idempotentReplay: true, eventsCreated: 1 });
    expect(counts().events).toBe(1);
    expect(counts().idempotency).toBe(1);
  });

  it("rejects apply while an independent process holds a write lock, then succeeds on retry", async () => {
    setup();
    const item = capture("Cross-process lock contention", "capture-review-lock-contention");
    const input = {
      dryRun: false,
      idempotencyKey: "review-cross-process-lock-1",
      items: [{ knowledgeId: item.knowledgeId, expectedVersionId: item.versionId,
        reasonCode: "manual_review" as const, reason: "Retry after the competing writer releases its lock" }],
    };
    const before = counts();
    const script = `
      import { openDatabase } from "./src/storage/database.js";
      const location = JSON.parse(process.env.CNM_TEST_LOCATION ?? "null");
      const db = openDatabase(location);
      db.exec("BEGIN IMMEDIATE");
      process.stdout.write("LOCKED\\n");
      setTimeout(() => {
        try { db.exec("ROLLBACK"); } finally { db.close(); }
        process.exit(0);
      }, 6500);
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CNM_TEST_LOCATION: JSON.stringify(location) },
    });
    child.stdout.setEncoding("utf8");
    const childExit = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
    try {
      const lockAcquired = new Promise<void>((resolve, reject) => {
        child.stdout.once("data", (chunk: string) => {
          if (chunk.includes("LOCKED")) resolve();
          else reject(new Error("Unexpected lock-holder output: " + chunk));
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => reject(new Error("Lock-holder exited before acquiring lock: " + code + "/" + signal)));
      });
      await lockAcquired;

      // Do not reopen the database while the writer owns the lock: openDatabase performs migrations.
      // Capture the failure but wait for the lock-holder to close its SQLite handle before asserting;
      // otherwise a failed assertion can trigger Windows cleanup while the child still owns the WAL.
      let lockError: unknown;
      try {
        requestMemoryReview(location, input);
      } catch (error) {
        lockError = error;
      }

      const [exitCode, signal] = await childExit;
      expect(exitCode).toBe(0);
      expect(signal).toBeNull();
      expect(lockError).toBeInstanceOf(Error);
      expect(String(lockError)).toMatch(/database is locked/i);
      expect(counts()).toEqual(before);

      const retry = requestMemoryReview(location, input);
      expect(retry).toMatchObject({ status: "applied", applied: true, idempotentReplay: false, eventsCreated: 1 });
      expect(counts().events).toBe(1);
      expect(counts().idempotency).toBe(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      if (child.exitCode === null && child.signalCode === null) await childExit;
    }
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
  it("preserves evidence, relations, fragments, and current-version pointers during apply", () => {
    setup();
    const first = capture("Preserve graph first", "capture-preserve-first");
    const second = capture("Preserve graph second", "capture-preserve-second");
    const db = openDatabase(location);
    db.prepare("INSERT INTO knowledge_evidence (id, version_id, evidence_type, metadata_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("evidence-preserve", first.versionId, "test", "{}", "2026-11-04T00:00:00.000Z");
    db.prepare("INSERT INTO knowledge_relations (id, project_id, source_knowledge_id, target_knowledge_id, relation_type, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("relation-preserve", location.id, first.knowledgeId, second.knowledgeId, "depends_on", "2026-11-04T00:00:00.000Z");
    const snapshot = () => ({
      evidence: db.prepare("SELECT id, version_id AS versionId FROM knowledge_evidence ORDER BY id").all(),
      relations: db.prepare("SELECT id, source_knowledge_id AS sourceId, target_knowledge_id AS targetId FROM knowledge_relations ORDER BY id").all(),
      fragments: db.prepare("SELECT id, version_id AS versionId, content FROM knowledge_fragments ORDER BY id").all(),
      pointers: db.prepare("SELECT id, current_version_id AS versionId FROM knowledge_items ORDER BY id").all(),
    });
    const before = snapshot();
    db.close();
    const result = requestMemoryReview(location, { dryRun: false, idempotencyKey: "preserve-graph-1", items: [
      { knowledgeId: first.knowledgeId, expectedVersionId: first.versionId, reasonCode: "manual_review", reason: "Check preservation" },
    ] });
    expect(result.status).toBe("applied");
    const verify = openDatabase(location);
    expect({
      evidence: verify.prepare("SELECT id, version_id AS versionId FROM knowledge_evidence ORDER BY id").all(),
      relations: verify.prepare("SELECT id, source_knowledge_id AS sourceId, target_knowledge_id AS targetId FROM knowledge_relations ORDER BY id").all(),
      fragments: verify.prepare("SELECT id, version_id AS versionId, content FROM knowledge_fragments ORDER BY id").all(),
      pointers: verify.prepare("SELECT id, current_version_id AS versionId FROM knowledge_items ORDER BY id").all(),
    }).toEqual(before);
    verify.close();
  });

  it("enforces append-only behavior for reconciliation review events", () => {
    setup();
    const item = capture("Append-only review event", "capture-append-only-review");
    request(item, { dryRun: false, idempotencyKey: "append-only-review-1" });
    const db = openDatabase(location);
    const eventId = (db.prepare("SELECT id FROM knowledge_events WHERE event_type='reconciliation_review_requested'").get() as { id: string }).id;
    expect(() => db.prepare("UPDATE knowledge_events SET reason='rewritten' WHERE id=?").run(eventId))
      .toThrow("knowledge events are append-only");
    expect(() => db.prepare("DELETE FROM knowledge_events WHERE id=?").run(eventId))
      .toThrow("knowledge events are append-only");
    db.close();
    expect(counts().events).toBe(1);
  });

});
