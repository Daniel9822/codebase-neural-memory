import { openDatabase } from "../storage/database.js";
import { getIndexFreshness } from "./indexer.js";
import type { ProjectLocation } from "./project.js";

export interface MemoryBootstrapInput {
  limit?: number | undefined;
  maxChars?: number | undefined;
  types?: string[] | undefined;
  includePending?: boolean | undefined;
}
function parseList(value: string): string[] {
  try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []; }
  catch { return []; }
}

/** Return compact current project knowledge with explicit epistemic and freshness boundaries. */
export function bootstrapMemory(location: ProjectLocation, input: MemoryBootstrapInput = {}) {
  const limit = input.limit ?? 10, maxChars = input.maxChars ?? 4000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("Invalid memory bootstrap limit");
  if (!Number.isInteger(maxChars) || maxChars < 500 || maxChars > 8000) throw new Error("Invalid memory bootstrap maxChars");
  if (input.includePending !== undefined && typeof input.includePending !== "boolean") throw new Error("Invalid memory bootstrap includePending");
  const types = input.types ?? [];
  if (!Array.isArray(types) || types.length > 20 || types.some((type) => typeof type !== "string" || !type.trim() || type.length > 64)) {
    throw new Error("Invalid memory bootstrap types");
  }
  const normalizedTypes = [...new Set(types.map((type) => type.trim()))].sort();
  const where = ["i.project_id = ?", "i.lifecycle = 'active'"];
  const params: Array<string | number> = [location.id];
  if (normalizedTypes.length) {
    where.push("i.knowledge_type IN (" + normalizedTypes.map(() => "?").join(", ") + ")");
    params.push(...normalizedTypes);
  }
  if (input.includePending === false) where.push("v.epistemic_state NOT IN ('pending_validation', 'hypothesis', 'planned')");
  const db = openDatabase(location);
  try {
    const from = " FROM knowledge_items i JOIN knowledge_versions v ON v.id=i.current_version_id AND v.knowledge_id=i.id WHERE " + where.join(" AND ");
    const totalCurrent = (db.prepare("SELECT COUNT(*) AS count" + from).get(...params) as { count: number }).count;
    const rows = db.prepare(`
      SELECT i.id AS knowledgeId, i.knowledge_type AS type, i.tags_json AS tagsJson, i.aliases_json AS aliasesJson,
        v.id AS versionId, v.version_number AS versionNumber, v.title,
        COALESCE(NULLIF(v.summary, ''), (SELECT substr(content, 1, 320) FROM knowledge_fragments WHERE version_id=v.id ORDER BY ordinal LIMIT 1), '') AS summary,
        v.epistemic_state AS epistemicState, v.confidence, i.updated_at AS updatedAt,
        COALESCE((SELECT group_concat(source_path, ', ') FROM knowledge_evidence WHERE version_id=v.id AND source_path IS NOT NULL), '') AS sourcePaths,
        COALESCE((SELECT group_concat(source_symbol, ', ') FROM knowledge_evidence WHERE version_id=v.id AND source_symbol IS NOT NULL), '') AS sourceSymbols
      ${from}
      ORDER BY CASE
        WHEN lower(i.knowledge_type) LIKE '%risk%' OR lower(i.knowledge_type) LIKE '%question%' THEN 0
        WHEN v.epistemic_state IN ('pending_validation','hypothesis') THEN 1
        WHEN v.epistemic_state='verified' THEN 2
        WHEN v.epistemic_state='user_asserted' THEN 3
        WHEN v.epistemic_state='observed' THEN 4
        WHEN v.epistemic_state='inferred' THEN 5 ELSE 6 END,
        v.created_at DESC, i.id ASC
      LIMIT ?
    `).all(...params, limit + 1) as Array<{
      knowledgeId: string; type: string; tagsJson: string; aliasesJson: string;
      versionId: string; versionNumber: number; title: string; summary: string;
      epistemicState: string; confidence: number | null; updatedAt: string; sourcePaths: string; sourceSymbols: string;
    }>;
    const highValue: Array<Record<string, unknown>> = [], openRisks: Array<Record<string, unknown>> = [], pendingValidation: Array<Record<string, unknown>> = [];
    for (const row of rows.slice(0, limit)) {
      const item = {
        knowledgeId: row.knowledgeId, versionId: row.versionId, versionNumber: row.versionNumber,
        type: row.type, title: row.title, summary: row.summary, epistemicState: row.epistemicState,
        confidence: row.confidence, updatedAt: row.updatedAt, tags: parseList(row.tagsJson), aliases: parseList(row.aliasesJson),
        sourcePaths: row.sourcePaths ? row.sourcePaths.split(", ").slice(0, 3) : [],
        sourceSymbols: row.sourceSymbols ? row.sourceSymbols.split(", ").slice(0, 3) : []
      };
      if (/(risk|question|issue|gotcha)/i.test(row.type + " " + row.title)) openRisks.push(item);
      else if (["pending_validation", "hypothesis", "planned"].includes(row.epistemicState)) pendingValidation.push(item);
      else highValue.push(item);
    }
    let result = {
      projectId: location.id, currentKnowledgeCount: totalCurrent, highValue, openRisks, pendingValidation,
      freshness: { codeIndex: "unknown" as string, sourceEvidence: "not_checked", warnings: [] as string[] },
      returned: highValue.length + openRisks.length + pendingValidation.length, limit, maxChars,
      includePending: input.includePending ?? true, truncated: rows.length > limit
    };
    try {
      const report = getIndexFreshness(location);
      result.freshness.codeIndex = report.status;
      if (report.status !== "current") result.freshness.warnings.push("Code index is " + report.status + ".");
    } catch (error) {
      result.freshness.codeIndex = "unavailable";
      result.freshness.warnings.push("Code-index freshness could not be checked: " + (error instanceof Error ? error.message : String(error)));
    }
    result.freshness.warnings.push("Source evidence freshness not checked.");
    const groups = [highValue, openRisks, pendingValidation];
    let serializedChars = JSON.stringify({ ...result, serializedChars: 0 }, null, 2).length;
    while (serializedChars > maxChars && groups.some((group) => group.length)) {
      [...groups].reverse().find((group) => group.length)!.pop();
      result = { ...result, returned: highValue.length + openRisks.length + pendingValidation.length, truncated: true };
      serializedChars = JSON.stringify({ ...result, serializedChars: 0 }, null, 2).length;
    }
    while (serializedChars > maxChars && result.freshness.warnings.length > 0) {
      result.freshness.warnings.pop();
      serializedChars = JSON.stringify({ ...result, serializedChars: 0 }, null, 2).length;
    }
    return { ...result, serializedChars: JSON.stringify({ ...result, serializedChars: 0 }, null, 2).length };
  } finally { db.close(); }
}
