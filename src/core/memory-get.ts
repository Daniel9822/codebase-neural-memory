import { openDatabase } from "../storage/database.js";
import type { ProjectLocation } from "./project.js";

export interface MemoryGetInput {
  knowledgeId: string;
  versionId?: string | undefined;
  includeEvidence?: boolean | undefined;
}
export interface MemoryExpandInput {
  knowledgeId: string;
  versionId?: string | undefined;
  fragmentIds?: string[] | undefined;
  beforeOrdinal?: number | undefined;
  limit?: number | undefined;
  maxChars?: number | undefined;
}
type VersionRow = {
  id: string; versionNumber: number; title: string; summary: string; epistemicState: string;
  confidence: number | null; confidenceReason: string | null; createdBy: string | null;
  changeReason: string | null; createdAt: string;
};
function requiredText(value: unknown, field: string, max = 128): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Invalid memory ${field}`);
  return value.trim();
}
function readVersion(db: ReturnType<typeof openDatabase>, knowledgeId: string, versionId: string): VersionRow {
  const row = db.prepare(`
    SELECT id, version_number AS versionNumber, title, summary,
      epistemic_state AS epistemicState, confidence, confidence_reason AS confidenceReason,
      created_by AS createdBy, change_reason AS changeReason, created_at AS createdAt
    FROM knowledge_versions WHERE knowledge_id = ? AND id = ?
  `).get(knowledgeId, versionId) as VersionRow | undefined;
  if (!row) throw new Error(versionId ? "Memory version not found in this project" : "Memory has no version in this project");
  return row;
}

/** Return the identity, selected/current immutable version, and optional bounded evidence metadata. */
export function getMemory(location: ProjectLocation, input: MemoryGetInput) {
  const knowledgeId = requiredText(input?.knowledgeId, "knowledgeId");
  if (input.versionId !== undefined) requiredText(input.versionId, "versionId");
  const db = openDatabase(location);
  try {
    const item = db.prepare(`
      SELECT id, knowledge_type AS type, lifecycle, current_version_id AS currentVersionId,
        tags_json AS tagsJson, aliases_json AS aliasesJson, created_at AS createdAt, updated_at AS updatedAt
      FROM knowledge_items WHERE id = ? AND project_id = ?
    `).get(knowledgeId, location.id) as {
      id: string; type: string; lifecycle: string; currentVersionId: string | null;
      tagsJson: string; aliasesJson: string; createdAt: string; updatedAt: string;
    } | undefined;
    if (!item) throw new Error("Knowledge item not found in this project");
    const versionId = input.versionId ?? item.currentVersionId;
    if (!versionId) throw new Error("Knowledge item has no current version in this project");
    const version = readVersion(db, knowledgeId, versionId);
    const fragmentCount = (db.prepare("SELECT COUNT(*) AS count FROM knowledge_fragments WHERE version_id = ?")
      .get(version.id) as { count: number }).count;
    const evidence = input.includeEvidence ? db.prepare(`
      SELECT id, evidence_type AS evidenceType, source_path AS sourcePath, source_hash AS sourceHash,
        commit_sha AS commitSha, source_symbol AS sourceSymbol, test_command AS testCommand,
        test_result AS testResult, actor, metadata_json AS metadataJson, created_at AS createdAt
      FROM knowledge_evidence WHERE version_id = ? ORDER BY created_at, id LIMIT 20
    `).all(version.id).map((row) => {
      const entry = row as Record<string, unknown> & { metadataJson: string };
      let metadata: unknown;
      try { metadata = JSON.parse(entry.metadataJson); } catch { throw new Error("Invalid memory evidence metadata"); }
      const { metadataJson: _metadataJson, ...fields } = entry;
      return { ...fields, metadata };
    }) : undefined;
    return {
      knowledgeId: item.id, type: item.type, lifecycle: item.lifecycle,
      currentVersionId: item.currentVersionId, selectedVersionId: version.id,
      version, tags: JSON.parse(item.tagsJson) as string[], aliases: JSON.parse(item.aliasesJson) as string[],
      fragmentCount, ...(evidence ? { evidence, evidenceReturned: evidence.length } : {}),
      createdAt: item.createdAt, updatedAt: item.updatedAt,
    };
  } finally { db.close(); }
}

/** Expand only requested fragments or one bounded ordinal page from a selected/current version. */
export function expandMemory(location: ProjectLocation, input: MemoryExpandInput) {
  const knowledgeId = requiredText(input?.knowledgeId, "knowledgeId");
  if (input.versionId !== undefined) requiredText(input.versionId, "versionId");
  const limit = input.limit ?? 10;
  const maxChars = input.maxChars ?? 8000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("Invalid memory expand limit");
  if (!Number.isInteger(maxChars) || maxChars < 500 || maxChars > 12000) throw new Error("Invalid memory expand maxChars");
  const ids = input.fragmentIds;
  if (ids !== undefined && (!Array.isArray(ids) || ids.length < 1 || ids.length > 20 ||
    ids.some((id) => typeof id !== "string" || !id.trim() || id.length > 128) || new Set(ids).size !== ids.length)) {
    throw new Error("fragmentIds must contain 1–20 unique fragment IDs");
  }
  if (ids !== undefined && input.beforeOrdinal !== undefined) throw new Error("Use fragmentIds or beforeOrdinal, not both");
  if (input.beforeOrdinal !== undefined && (!Number.isInteger(input.beforeOrdinal) || input.beforeOrdinal < 0)) {
    throw new Error("Invalid memory expand beforeOrdinal");
  }
  const db = openDatabase(location);
  try {
    const item = db.prepare("SELECT current_version_id AS currentVersionId FROM knowledge_items WHERE id=? AND project_id=?")
      .get(knowledgeId, location.id) as { currentVersionId: string | null } | undefined;
    if (!item) throw new Error("Knowledge item not found in this project");
    const version = readVersion(db, knowledgeId, input.versionId);
    const rows = ids
      ? db.prepare(`SELECT id, ordinal, heading, summary, content FROM knowledge_fragments
          WHERE version_id=? AND id IN (${ids.map(() => "?").join(",")}) ORDER BY ordinal`).all(version.id, ...ids)
      : db.prepare(`SELECT id, ordinal, heading, summary, content FROM knowledge_fragments
          WHERE version_id=? AND ordinal > ? ORDER BY ordinal LIMIT ?`).all(version.id, input.beforeOrdinal ?? -1, limit + 1);
    const candidates = rows as Array<{ id: string; ordinal: number; heading: string; summary: string; content: string }>;
    if (ids && candidates.length !== ids.length) throw new Error("One or more fragment IDs do not belong to the selected version");
    const hasMore = !ids && candidates.length > limit;
    const page = candidates.slice(0, ids ? 20 : limit);
    const fragments: typeof page = [];
    let serializedChars = 2; // Include the brackets in the serialized fragment array.
    for (const fragment of page) {
      const nextChars = JSON.stringify(fragment).length + (fragments.length ? 1 : 0);
      if (serializedChars + nextChars > maxChars) {
        if (fragments.length === 0) throw new Error("A requested fragment exceeds the memory expand character budget");
        break;
      }
      fragments.push(fragment);
      serializedChars += nextChars;
    }
    const omittedByBudget = fragments.length < page.length;
    return {
      knowledgeId, selectedVersionId: version.id, currentVersionId: item.currentVersionId,
      fragments, returned: fragments.length, limit, maxChars, serializedChars,
      hasMore: omittedByBudget || hasMore,
      nextBeforeOrdinal: fragments.length > 0 && (omittedByBudget || hasMore) ? fragments.at(-1)!.ordinal : null,
      truncatedByCharacterBudget: omittedByBudget,
    };
  } finally { db.close(); }
}
