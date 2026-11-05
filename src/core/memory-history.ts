import { openDatabase } from "../storage/database.js";
import type { ProjectLocation } from "./project.js";

export interface MemoryHistoryInput {
  knowledgeId: string;
  versionLimit?: number | undefined;
  eventLimit?: number | undefined;
  maxChars?: number | undefined;
  beforeVersionNumber?: number | undefined;
  beforeEventCreatedAt?: string | undefined;
  beforeEventId?: string | undefined;
}

export interface MemoryHistoryResult {
  knowledgeId: string;
  lifecycle: "active" | "superseded" | "archived";
  currentVersionId: string | null;
  versions: Array<{
    id: string;
    versionNumber: number;
    title: string;
    summary: string;
    epistemicState: string;
    confidence: number | null;
    confidenceReason: string | null;
    createdBy: string | null;
    changeReason: string | null;
    createdAt: string;
    fragmentCount: number;
    evidenceCount: number;
  }>;
  events: Array<{
    id: string;
    versionId: string | null;
    eventType: string;
    actor: string | null;
    reason: string | null;
    payload: Record<string, unknown>;
    createdAt: string;
  }>;
  totalVersions: number;
  totalEvents: number;
  truncated: boolean;
  maxChars: number;
  serializedChars: number;
  budgetOmittedVersions: number;
  budgetOmittedEvents: number;
  pagination: {
    versionLimit: number;
    eventLimit: number;
    versionsReturned: number;
    eventsReturned: number;
    hasMoreVersions: boolean;
    hasMoreEvents: boolean;
    nextBeforeVersionNumber: number | null;
    nextBeforeEvent: { createdAt: string; id: string } | null;
  };
}

const positiveInteger = (value: number | undefined, fallback: number, max: number, field: string): number => {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > max) throw new Error(`Invalid memory history ${field}`);
  return result;
};

/** Read immutable versions and append-only events for one identity in the current project. */
export function getMemoryHistory(location: ProjectLocation, input: MemoryHistoryInput): MemoryHistoryResult {
  if (!input || typeof input !== "object") throw new Error("Invalid memory history input");
  if (typeof input.knowledgeId !== "string" || !input.knowledgeId.trim() || input.knowledgeId.length > 128) {
    throw new Error("Invalid memory history knowledgeId");
  }
  const knowledgeId = input.knowledgeId.trim();
  const versionLimit = positiveInteger(input.versionLimit, 20, 50, "versionLimit");
  const eventLimit = positiveInteger(input.eventLimit, 20, 50, "eventLimit");
  const maxChars = positiveInteger(input.maxChars, 12_000, 12_000, "maxChars");
  if (maxChars < 500) throw new Error("Invalid memory history maxChars");
  const beforeVersionNumber = input.beforeVersionNumber;
  if (beforeVersionNumber !== undefined && (!Number.isInteger(beforeVersionNumber) || beforeVersionNumber < 1)) {
    throw new Error("Invalid memory history beforeVersionNumber");
  }
  const hasEventCursor = input.beforeEventCreatedAt !== undefined || input.beforeEventId !== undefined;
  if (hasEventCursor && (!input.beforeEventCreatedAt || !input.beforeEventId ||
      input.beforeEventCreatedAt.length > 40 || input.beforeEventId.length > 128)) {
    throw new Error("Event pagination requires a valid beforeEventCreatedAt and beforeEventId");
  }

  const db = openDatabase(location);
  try {
    const item = db.prepare(`
      SELECT lifecycle, current_version_id AS currentVersionId
      FROM knowledge_items WHERE id = ? AND project_id = ?
    `).get(knowledgeId, location.id) as { lifecycle: MemoryHistoryResult["lifecycle"]; currentVersionId: string | null } | undefined;
    if (!item) throw new Error("Knowledge item not found in this project");

    const versionRows = db.prepare(`
      SELECT v.id, v.version_number AS versionNumber, v.title, v.summary,
             v.epistemic_state AS epistemicState, v.confidence,
             v.confidence_reason AS confidenceReason, v.created_by AS createdBy,
             v.change_reason AS changeReason, v.created_at AS createdAt,
             (SELECT COUNT(*) FROM knowledge_fragments f WHERE f.version_id = v.id) AS fragmentCount,
             (SELECT COUNT(*) FROM knowledge_evidence e WHERE e.version_id = v.id) AS evidenceCount
      FROM knowledge_versions v
      WHERE v.knowledge_id = ? ${beforeVersionNumber === undefined ? "" : "AND v.version_number < ?"}
      ORDER BY v.version_number DESC
      LIMIT ?
    `).all(...(beforeVersionNumber === undefined
      ? [knowledgeId, versionLimit + 1]
      : [knowledgeId, beforeVersionNumber, versionLimit + 1])) as MemoryHistoryResult["versions"];

    const eventRows = db.prepare(`
      SELECT id, version_id AS versionId, event_type AS eventType, actor, reason,
             payload_json AS payloadJson, created_at AS createdAt
      FROM knowledge_events
      WHERE project_id = ? AND knowledge_id = ?
        ${hasEventCursor ? "AND (created_at < ? OR (created_at = ? AND id < ?))" : ""}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...(hasEventCursor
      ? [location.id, knowledgeId, input.beforeEventCreatedAt!, input.beforeEventCreatedAt!, input.beforeEventId!, eventLimit + 1]
      : [location.id, knowledgeId, eventLimit + 1])) as Array<{
        id: string; versionId: string | null; eventType: string; actor: string | null;
        reason: string | null; payloadJson: string; createdAt: string;
      }>;

    const totalVersions = (db.prepare("SELECT COUNT(*) AS count FROM knowledge_versions WHERE knowledge_id=?").get(knowledgeId) as { count: number }).count;
    const totalEvents = (db.prepare("SELECT COUNT(*) AS count FROM knowledge_events WHERE project_id=? AND knowledge_id=?").get(location.id, knowledgeId) as { count: number }).count;
    const hasMoreVersions = versionRows.length > versionLimit;
    const hasMoreEvents = eventRows.length > eventLimit;
    const versions = versionRows.slice(0, versionLimit);
    const events = eventRows.slice(0, eventLimit).map((event) => {
      let payload: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(event.payloadJson);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        payload = parsed as Record<string, unknown>;
      } catch {
        throw new Error(`Invalid event payload for history event ${event.id}`);
      }
      return {
        id: event.id, versionId: event.versionId, eventType: event.eventType,
        actor: event.actor, reason: event.reason, payload, createdAt: event.createdAt,
      };
    });

    const result: MemoryHistoryResult = {
      knowledgeId, lifecycle: item.lifecycle, currentVersionId: item.currentVersionId,
      versions, events, totalVersions, totalEvents, truncated: false, maxChars, serializedChars: 0,
      budgetOmittedVersions: 0, budgetOmittedEvents: 0,
      pagination: {
        versionLimit, eventLimit, versionsReturned: versions.length, eventsReturned: events.length,
        hasMoreVersions, hasMoreEvents,
        nextBeforeVersionNumber: hasMoreVersions ? versions.at(-1)?.versionNumber ?? null : null,
        nextBeforeEvent: hasMoreEvents && events.length > 0
          ? { createdAt: events.at(-1)!.createdAt, id: events.at(-1)!.id } : null,
      },
    };
    const measure = (): number => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const length = JSON.stringify(result).length;
        if (result.serializedChars === length) return length;
        result.serializedChars = length;
      }
      return JSON.stringify(result).length;
    };
    let individuallyOversizedEventCursor: { createdAt: string; id: string } | null = null;
    while (measure() > maxChars) {
      result.truncated = true;
      // Keep each stream independently ordered and page-able; remove the older tail
      // from the larger serialized stream first, with events winning ties.
      const removeEvent = !individuallyOversizedEventCursor && result.events.length > 0 &&
        (result.versions.length === 0 || JSON.stringify(result.events).length >= JSON.stringify(result.versions).length);
      if (removeEvent) {
        const removed = result.events.pop()!;
        result.budgetOmittedEvents++;
        result.pagination.hasMoreEvents = true;
        result.pagination.nextBeforeEvent = { createdAt: removed.createdAt, id: removed.id };

        // An event that cannot fit even by itself must be consumed by the cursor.
        // Otherwise it would be fetched forever and block access to older events.
        const isolatedEventResponse = {
          ...result,
          versions: [],
          events: [removed],
          serializedChars: 0,
          budgetOmittedVersions: 0,
          budgetOmittedEvents: 1,
          pagination: {
            ...result.pagination,
            versionsReturned: 0,
            eventsReturned: 1,
            nextBeforeVersionNumber: null,
            nextBeforeEvent: { createdAt: removed.createdAt, id: removed.id },
          },
        };
        if (JSON.stringify(isolatedEventResponse).length > maxChars) {
          individuallyOversizedEventCursor = { createdAt: removed.createdAt, id: removed.id };
        }
      } else if (result.versions.length > 0) {
        const removed = result.versions.pop()!;
        result.budgetOmittedVersions++;
        result.pagination.hasMoreVersions = true;
        result.pagination.nextBeforeVersionNumber = removed.versionNumber;
      } else {
        throw new Error("Memory history response metadata exceeds its character budget");
      }
      result.pagination.versionsReturned = result.versions.length;
      result.pagination.eventsReturned = result.events.length;
      // Normally a budget-trimmed tail is returned on the next page. An individually
      // oversized event is the exception: advance past it to avoid a permanent loop.
      if (result.versions.length > 0 && result.pagination.hasMoreVersions) {
        result.pagination.nextBeforeVersionNumber = result.versions.at(-1)!.versionNumber;
      }
      if (result.events.length > 0 && result.pagination.hasMoreEvents && !individuallyOversizedEventCursor) {
        const last = result.events.at(-1)!;
        result.pagination.nextBeforeEvent = { createdAt: last.createdAt, id: last.id };
      }
    }
    if (individuallyOversizedEventCursor) {
      result.pagination.nextBeforeEvent = individuallyOversizedEventCursor;
    }
    result.serializedChars = JSON.stringify(result).length;
    return result;
  } finally {
    db.close();
  }
}
