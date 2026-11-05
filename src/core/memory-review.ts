import { createHash, randomUUID } from "node:crypto";
import { openDatabase } from "../storage/database.js";
import type { ProjectLocation } from "./project.js";

export type MemoryReviewResolution = "reviewed_current" | "knowledge_updated" | "not_actionable";
export interface MemoryReviewQueueItem {
  requestEventId: string;
  knowledgeId: string;
  expectedVersionId: string;
  reasonCode: string;
  reason: string;
  actor: string | null;
  requestedAt: string;
  currentVersionId: string | null;
  status: "open" | "stale_version";
}
export interface MemoryReviewQueueResult {
  items: MemoryReviewQueueItem[];
  returnedItems: number;
  totalItems: number;
  truncated: boolean;
  limit: number;
}
export interface ResolveMemoryReviewInput {
  requestEventId: string;
  knowledgeId: string;
  expectedVersionId: string;
  resolution: MemoryReviewResolution;
  reason: string;
  actor?: string;
  idempotencyKey: string;
}
export interface ResolveMemoryReviewResult {
  status: "resolved" | "conflict";
  applied: boolean;
  idempotentReplay: boolean;
  requestEventId: string;
  knowledgeId: string;
  currentVersionId: string | null;
  resolution?: MemoryReviewResolution;
  reason?: string;
}

function required(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new Error(`Invalid memory review ${field}`);
  }
  return value.trim();
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Read the event-derived open review queue. This operation never writes. */
export function listMemoryReviews(location: ProjectLocation, rawLimit = 50): MemoryReviewQueueResult {
  const limit = Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 100 ? rawLimit : 50;
  const db = openDatabase(location);
  try {
    const rows = db.prepare(`
      SELECT e.id AS requestEventId, e.knowledge_id AS knowledgeId,
        e.version_id AS expectedVersionId, e.actor AS actor, e.reason AS reason,
        e.created_at AS requestedAt, e.payload_json AS payload,
        i.current_version_id AS currentVersionId
      FROM knowledge_events e
      JOIN knowledge_items i ON i.id=e.knowledge_id AND i.project_id=e.project_id
      WHERE e.project_id=? AND e.event_type='reconciliation_review_requested'
        AND NOT EXISTS (
          SELECT 1 FROM knowledge_events resolved
          WHERE resolved.project_id=e.project_id
            AND resolved.event_type='reconciliation_review_resolved'
            AND json_extract(resolved.payload_json, '$.requestEventId')=e.id
        )
      ORDER BY e.created_at COLLATE BINARY, e.id COLLATE BINARY
      LIMIT ?
    `).all(location.id, limit + 1) as Array<{
      requestEventId: string; knowledgeId: string; expectedVersionId: string | null;
      actor: string | null; reason: string | null; requestedAt: string;
      payload: string; currentVersionId: string | null;
    }>;
    const truncated = rows.length > limit;
    const selected = rows.slice(0, limit).map((row): MemoryReviewQueueItem => {
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(row.payload) as Record<string, unknown>; } catch { /* malformed legacy event remains visible */ }
      return {
        requestEventId: row.requestEventId,
        knowledgeId: row.knowledgeId,
        expectedVersionId: row.expectedVersionId ?? "",
        reasonCode: typeof payload.reasonCode === "string" ? payload.reasonCode : "unknown",
        reason: row.reason ?? "",
        actor: row.actor,
        requestedAt: row.requestedAt,
        currentVersionId: row.currentVersionId,
        status: row.currentVersionId === row.expectedVersionId ? "open" : "stale_version",
      };
    });
    return { items: selected, returnedItems: selected.length, totalItems: selected.length + (truncated ? 1 : 0), truncated, limit };
  } finally {
    db.close();
  }
}

/** Resolve one review request by appending an immutable event with optimistic-version and idempotency guards. */
export function resolveMemoryReview(location: ProjectLocation, raw: ResolveMemoryReviewInput): ResolveMemoryReviewResult {
  const input: ResolveMemoryReviewInput = {
    requestEventId: required(raw?.requestEventId, "requestEventId", 128),
    knowledgeId: required(raw?.knowledgeId, "knowledgeId", 128),
    expectedVersionId: required(raw?.expectedVersionId, "expectedVersionId", 128),
    resolution: raw?.resolution,
    reason: required(raw?.reason, "reason", 500),
    idempotencyKey: required(raw?.idempotencyKey, "idempotencyKey", 128),
    ...(raw?.actor === undefined ? {} : { actor: required(raw.actor, "actor", 200) }),
  };
  if (!["reviewed_current", "knowledge_updated", "not_actionable"].includes(input.resolution)) {
    throw new Error("Invalid memory review resolution");
  }
  const requestHash = digest({ projectId: location.id, ...input });
  const db = openDatabase(location);
  try {
    const execute = db.transaction((): ResolveMemoryReviewResult => {
      const prior = db.prepare(`
        SELECT request_hash AS requestHash, result_json AS resultJson
        FROM memory_idempotency
        WHERE project_id=? AND operation='memory_review_resolve' AND idempotency_key=?
      `).get(location.id, input.idempotencyKey) as { requestHash: string; resultJson: string } | undefined;
      if (prior) {
        if (prior.requestHash !== requestHash) return {
          status: "conflict", applied: false, idempotentReplay: false,
          requestEventId: input.requestEventId, knowledgeId: input.knowledgeId,
          currentVersionId: null, reason: "idempotency_key_payload_mismatch",
        };
        return { ...(JSON.parse(prior.resultJson) as ResolveMemoryReviewResult), idempotentReplay: true };
      }
      const request = db.prepare(`
        SELECT e.version_id AS versionId, i.current_version_id AS currentVersionId
        FROM knowledge_events e JOIN knowledge_items i
          ON i.id=e.knowledge_id AND i.project_id=e.project_id
        WHERE e.id=? AND e.project_id=? AND e.knowledge_id=?
          AND e.event_type='reconciliation_review_requested'
      `).get(input.requestEventId, location.id, input.knowledgeId) as {
        versionId: string | null; currentVersionId: string | null;
      } | undefined;
      if (!request || request.versionId !== input.expectedVersionId ||
          request.currentVersionId !== input.expectedVersionId) {
        return { status: "conflict", applied: false, idempotentReplay: false,
          requestEventId: input.requestEventId, knowledgeId: input.knowledgeId,
          currentVersionId: request?.currentVersionId ?? null, reason: "request_missing_or_version_changed" };
      }
      const alreadyResolved = db.prepare(`
        SELECT 1 FROM knowledge_events
        WHERE project_id=? AND event_type='reconciliation_review_resolved'
          AND json_extract(payload_json, '$.requestEventId')=? LIMIT 1
      `).get(location.id, input.requestEventId);
      if (alreadyResolved) return { status: "conflict", applied: false, idempotentReplay: false,
        requestEventId: input.requestEventId, knowledgeId: input.knowledgeId,
        currentVersionId: request.currentVersionId, reason: "review_already_resolved" };
      const now = new Date().toISOString();
      const result: ResolveMemoryReviewResult = {
        status: "resolved", applied: true, idempotentReplay: false,
        requestEventId: input.requestEventId, knowledgeId: input.knowledgeId,
        currentVersionId: request.currentVersionId, resolution: input.resolution,
      };
      db.prepare(`
        INSERT INTO knowledge_events
          (id, project_id, knowledge_id, version_id, event_type, actor, reason, payload_json, created_at)
        VALUES (?, ?, ?, ?, 'reconciliation_review_resolved', ?, ?, ?, ?)
      `).run(`event:${randomUUID()}`, location.id, input.knowledgeId, input.expectedVersionId,
        input.actor ?? null, input.reason, JSON.stringify({
          schemaVersion: 1, operation: "resolve_review", requestEventId: input.requestEventId,
          expectedVersionId: input.expectedVersionId, resolution: input.resolution,
        }), now);
      db.prepare(`
        INSERT INTO memory_idempotency(project_id, operation, idempotency_key, request_hash, result_json, created_at)
        VALUES (?, 'memory_review_resolve', ?, ?, ?, ?)
      `).run(location.id, input.idempotencyKey, requestHash, JSON.stringify(result), now);
      return result;
    });
    return execute.immediate();
  } finally {
    db.close();
  }
}
