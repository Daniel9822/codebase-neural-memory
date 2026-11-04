import { createHash, randomUUID } from "node:crypto";
import { openDatabase } from "../storage/database.js";
import type { ProjectLocation } from "./project.js";

export type MemoryReviewReasonCode = "stale_evidence" | "dependent_stale_evidence" | "manual_review";
export interface MemoryReviewRequestItem {
  knowledgeId: string;
  expectedVersionId: string;
  reasonCode: MemoryReviewReasonCode;
  reason: string;
}
export interface MemoryReviewRequestInput {
  dryRun?: boolean | undefined;
  idempotencyKey?: string | undefined;
  actor?: string | undefined;
  items: MemoryReviewRequestItem[];
}
export interface MemoryReviewRequestResult {
  status: "validated" | "applied" | "conflict";
  dryRun: boolean;
  applied: boolean;
  idempotentReplay: boolean;
  items: Array<{ knowledgeId: string; expectedVersionId: string; status: "ready" | "conflict"; currentVersionId: string | null }>;
  eventsCreated: number;
  returnedItems: number;
  totalItems: number;
  truncated: boolean;
  maxChars: number;
  serializedChars: number;
  reason?: string;
}

function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new Error(`Invalid memory review request ${field}`);
  }
  return value.trim();
}

function validate(input: MemoryReviewRequestInput): { dryRun: boolean; items: MemoryReviewRequestItem[]; idempotencyKey?: string; actor?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input) || !Array.isArray(input.items) ||
      input.items.length < 1 || input.items.length > 100) {
    throw new Error("Memory review request requires 1–100 items");
  }
  const dryRun = input.dryRun ?? true;
  if (typeof dryRun !== "boolean") throw new Error("Invalid memory review request dryRun");
  const idempotencyKey = input.idempotencyKey === undefined ? undefined : boundedText(input.idempotencyKey, "idempotencyKey", 128);
  if (!dryRun && !idempotencyKey) throw new Error("Apply requires an idempotencyKey");
  const actor = input.actor === undefined ? undefined : boundedText(input.actor, "actor", 200);
  const items = input.items.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Invalid memory review request item ${index}`);
    const knowledgeId = boundedText(raw.knowledgeId, `items[${index}].knowledgeId`, 128);
    const expectedVersionId = boundedText(raw.expectedVersionId, `items[${index}].expectedVersionId`, 128);
    const reason = boundedText(raw.reason, `items[${index}].reason`, 500);
    const reasonCode = raw.reasonCode;
    if (reasonCode !== "stale_evidence" && reasonCode !== "dependent_stale_evidence" && reasonCode !== "manual_review") {
      throw new Error(`Invalid memory review request items[${index}].reasonCode`);
    }
    return { knowledgeId, expectedVersionId, reasonCode, reason };
  });
  if (new Set(items.map((item) => item.knowledgeId)).size !== items.length) {
    throw new Error("Memory review request contains duplicate knowledge IDs");
  }
  items.sort((a, b) => a.knowledgeId.localeCompare(b.knowledgeId, "en"));
  return { dryRun, items, ...(idempotencyKey === undefined ? {} : { idempotencyKey }), ...(actor === undefined ? {} : { actor }) };
}

function hashRequest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const RESPONSE_MAX_CHARS = 12_000;

function boundResult(result: Omit<MemoryReviewRequestResult, "returnedItems" | "totalItems" | "truncated" | "maxChars" | "serializedChars">): MemoryReviewRequestResult {
  const totalItems = result.items.length;
  const bounded = { ...result, items: [...result.items], returnedItems: totalItems,
    totalItems, truncated: false, maxChars: RESPONSE_MAX_CHARS, serializedChars: 0 };
  while (JSON.stringify(bounded).length > RESPONSE_MAX_CHARS && bounded.items.length > 0) {
    bounded.items.pop();
    bounded.truncated = true;
    bounded.returnedItems = bounded.items.length;
  }
  bounded.truncated ||= bounded.returnedItems < totalItems;
  bounded.serializedChars = JSON.stringify(bounded).length;
  return bounded;
}

/**
 * Append event-only review requests. Knowledge content and lifecycle are never changed.
 * Dry-run is the default; apply is explicit, project-scoped, idempotent, and atomic.
 */
export function requestMemoryReview(location: ProjectLocation, rawInput: MemoryReviewRequestInput): MemoryReviewRequestResult {
  const input = validate(rawInput);
  const requestHash = hashRequest({ projectId: location.id, actor: input.actor ?? null, items: input.items });
  const db = openDatabase(location);
  try {
    const execute = db.transaction((): MemoryReviewRequestResult => {
      if (!input.dryRun) {
        const prior = db.prepare(`
          SELECT request_hash AS requestHash, result_json AS resultJson
          FROM memory_idempotency
          WHERE project_id=? AND operation='memory_reconcile_request_review' AND idempotency_key=?
        `).get(location.id, input.idempotencyKey!) as { requestHash: string; resultJson: string } | undefined;
        if (prior) {
          if (prior.requestHash !== requestHash) {
            return boundResult({ status: "conflict", dryRun: false, applied: false, idempotentReplay: false,
              items: [], eventsCreated: 0, reason: "idempotency_key_payload_mismatch" });
          }
          return boundResult({ ...(JSON.parse(prior.resultJson) as MemoryReviewRequestResult), idempotentReplay: true });
        }
      }

      const checked = input.items.map((item) => {
        const row = db.prepare(`
          SELECT i.current_version_id AS currentVersionId
          FROM knowledge_items i
          JOIN knowledge_versions v ON v.id=i.current_version_id AND v.knowledge_id=i.id
          WHERE i.id=? AND i.project_id=? AND i.lifecycle='active'
        `).get(item.knowledgeId, location.id) as { currentVersionId: string } | undefined;
        const currentVersionId = row?.currentVersionId ?? null;
        return { knowledgeId: item.knowledgeId, expectedVersionId: item.expectedVersionId,
          status: currentVersionId === item.expectedVersionId ? "ready" as const : "conflict" as const, currentVersionId };
      });
      const hasConflict = checked.some((item) => item.status === "conflict");
      if (hasConflict) return boundResult({ status: "conflict", dryRun: input.dryRun, applied: false,
        idempotentReplay: false, items: checked, eventsCreated: 0, reason: "missing_foreign_or_changed_knowledge" });
      if (input.dryRun) return boundResult({ status: "validated", dryRun: true, applied: false,
        idempotentReplay: false, items: checked, eventsCreated: 0 });

      const now = new Date().toISOString();
      for (const item of input.items) {
        const sourceEvidenceRows = db.prepare(`
          SELECT id FROM knowledge_evidence WHERE version_id=? ORDER BY id COLLATE BINARY LIMIT 21
        `).all(item.expectedVersionId) as Array<{ id: string }>;
        const relationRows = db.prepare(`
          SELECT r.id FROM knowledge_relations r
          JOIN knowledge_items source ON source.id=r.source_knowledge_id
          JOIN knowledge_items target ON target.id=r.target_knowledge_id
          WHERE r.project_id=? AND source.project_id=? AND target.project_id=?
            AND (r.source_knowledge_id=? OR r.target_knowledge_id=?)
          ORDER BY r.id COLLATE BINARY LIMIT 21
        `).all(location.id, location.id, location.id, item.knowledgeId, item.knowledgeId) as Array<{ id: string }>;
        db.prepare(`
          INSERT INTO knowledge_events
            (id, project_id, knowledge_id, version_id, event_type, actor, reason, payload_json, created_at)
          VALUES (?, ?, ?, ?, 'reconciliation_review_requested', ?, ?, ?, ?)
        `).run(`event:${randomUUID()}`, location.id, item.knowledgeId, item.expectedVersionId,
          input.actor ?? null, item.reason, JSON.stringify({
            schemaVersion: 1, operation: "request_review", requestHash,
            reasonCode: item.reasonCode, expectedVersionId: item.expectedVersionId,
            sourceEvidenceIds: sourceEvidenceRows.slice(0, 20).map((row) => row.id),
            sourceEvidenceTruncated: sourceEvidenceRows.length > 20,
            relationIds: relationRows.slice(0, 20).map((row) => row.id),
            relationIdsTruncated: relationRows.length > 20,
          }), now);
      }
      const result: MemoryReviewRequestResult = {
        status: "applied", dryRun: false, applied: true, idempotentReplay: false,
        items: checked, eventsCreated: input.items.length,
      };
      db.prepare(`
        INSERT INTO memory_idempotency(project_id, operation, idempotency_key, request_hash, result_json, created_at)
        VALUES (?, 'memory_reconcile_request_review', ?, ?, ?, ?)
      `).run(location.id, input.idempotencyKey!, requestHash, JSON.stringify(result), now);
      return boundResult(result);
    });
    return input.dryRun ? execute() : execute.immediate();
  } finally {
    db.close();
  }
}
