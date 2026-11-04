import { openDatabase } from "../storage/database.js";
import { getIndexFreshness } from "./indexer.js";
import type { ProjectLocation } from "./project.js";

export interface MemoryBootstrapInput { maxItems?: number | undefined; maxChars?: number | undefined; }
function parseList(value: string): string[] {
  try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []; }
  catch { return []; }
}

/** Return compact current project knowledge with explicit epistemic and freshness boundaries. */
export function bootstrapMemory(location: ProjectLocation, input: MemoryBootstrapInput = {}) {
  const maxItems = input.maxItems ?? 20, maxChars = input.maxChars ?? 8000;
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 50) throw new Error("Invalid memory bootstrap maxItems");
  if (!Number.isInteger(maxChars) || maxChars < 1000 || maxChars > 16000) throw new Error("Invalid memory bootstrap maxChars");
  const db = openDatabase(location);
  try {
    const totalCurrent = (db.prepare("SELECT COUNT(*) AS count FROM knowledge_items WHERE project_id=? AND lifecycle='active' AND current_version_id IS NOT NULL")
      .get(location.id) as { count: number }).count;
    const rows = db.prepare(`
      SELECT i.id AS knowledgeId, i.knowledge_type AS type, i.tags_json AS tagsJson, i.aliases_json AS aliasesJson,
        v.id AS versionId, v.version_number AS versionNumber, v.title, v.summary,
        v.epistemic_state AS epistemicState, v.confidence, i.updated_at AS updatedAt,
        COALESCE((SELECT group_concat(source_path, ', ') FROM knowledge_evidence WHERE version_id=v.id AND source_path IS NOT NULL), '') AS sourcePaths,
        COALESCE((SELECT group_concat(source_symbol, ', ') FROM knowledge_evidence WHERE version_id=v.id AND source_symbol IS NOT NULL), '') AS sourceSymbols
      FROM knowledge_items i JOIN knowledge_versions v ON v.id=i.current_version_id AND v.knowledge_id=i.id
      WHERE i.project_id=? AND i.lifecycle='active'
      ORDER BY CASE
        WHEN lower(i.knowledge_type) LIKE '%risk%' OR lower(i.knowledge_type) LIKE '%question%' THEN 0
        WHEN v.epistemic_state IN ('pending_validation','hypothesis') THEN 1
        WHEN v.epistemic_state='verified' THEN 2
        WHEN v.epistemic_state='user_asserted' THEN 3
        WHEN v.epistemic_state='observed' THEN 4
        WHEN v.epistemic_state='inferred' THEN 5 ELSE 6 END,
        v.created_at DESC, i.id ASC
      LIMIT ?
    `).all(location.id, maxItems + 1) as Array<{
      knowledgeId: string; type: string; tagsJson: string; aliasesJson: string;
      versionId: string; versionNumber: number; title: string; summary: string;
      epistemicState: string; confidence: number | null; updatedAt: string; sourcePaths: string; sourceSymbols: string;
    }>;
    const highValue: Array<Record<string, unknown>> = [], openRisks: Array<Record<string, unknown>> = [], pendingValidation: Array<Record<string, unknown>> = [];
    for (const row of rows.slice(0, maxItems)) {
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
      returned: highValue.length + openRisks.length + pendingValidation.length, maxItems, maxChars, truncated: rows.length > maxItems
    };
    try {
      const report = getIndexFreshness(location);
      result.freshness.codeIndex = report.status;
      if (report.status !== "current") result.freshness.warnings.push("The code index is " + report.status + "; refresh it before relying on indexed source relationships.");
    } catch (error) {
      result.freshness.codeIndex = "unavailable";
      result.freshness.warnings.push("Code-index freshness could not be checked: " + (error instanceof Error ? error.message : String(error)));
    }
    result.freshness.warnings.push("Source-file and Git evidence attached to knowledge items has not yet been reconciled by memory_health.");
    const groups = [highValue, openRisks, pendingValidation];
    let serializedChars = JSON.stringify({ ...result, serializedChars: 0 }).length;
    while (serializedChars > maxChars && groups.some((group) => group.length)) {
      [...groups].reverse().find((group) => group.length)!.pop();
      result = { ...result, returned: highValue.length + openRisks.length + pendingValidation.length, truncated: true };
      serializedChars = JSON.stringify({ ...result, serializedChars: 0 }).length;
    }
    return { ...result, serializedChars: JSON.stringify({ ...result, serializedChars: 0 }).length };
  } finally { db.close(); }
}
