import { openDatabase } from "../storage/database.js";
import { getMemoryHealth } from "./memory-health.js";
import type { ProjectLocation } from "./project.js";

export interface MemoryReconcileInput {
  limit?: number | undefined;
}

/**
 * Produce a deterministic, read-only reconciliation preview.
 *
 * Duplicate candidates are deliberately conservative: only active current
 * versions with the same normalized title are grouped. A match is a review
 * signal, never permission to merge or delete knowledge.
 */
export function previewMemoryReconciliation(location: ProjectLocation, input: MemoryReconcileInput = {}) {
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Invalid memory reconcile limit");
  }

  const health = getMemoryHealth(location, { limit });
  const db = openDatabase(location);
  let duplicateCandidates: Array<{ normalizedTitle: string; knowledgeIds: string[]; titles: string[] }> = [];
  let duplicateTotal = 0;
  let dependentReview: Array<{ knowledgeId: string; title: string; relatedKnowledgeId: string; relationType: string }> = [];
  let dependentReviewTotal = 0;

  try {
    const groups = db.prepare(`
      SELECT lower(trim(v.title)) AS normalizedTitle, COUNT(*) AS itemCount
      FROM knowledge_items i
      JOIN knowledge_versions v ON v.id=i.current_version_id AND v.knowledge_id=i.id
      WHERE i.project_id=? AND i.lifecycle='active' AND trim(v.title)<>''
      GROUP BY lower(trim(v.title))
      HAVING COUNT(*) > 1
      ORDER BY lower(trim(v.title)) COLLATE BINARY ASC
      LIMIT ?
    `).all(location.id, limit + 1) as Array<{ normalizedTitle: string; itemCount: number }>;
    duplicateTotal = db.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT lower(trim(v.title))
        FROM knowledge_items i
        JOIN knowledge_versions v ON v.id=i.current_version_id AND v.knowledge_id=i.id
        WHERE i.project_id=? AND i.lifecycle='active' AND trim(v.title)<>''
        GROUP BY lower(trim(v.title)) HAVING COUNT(*) > 1
      )
    `).get(location.id) as number extends never ? never : { count: number } as { count: number };

    duplicateCandidates = groups.slice(0, limit).map((group) => {
      const rows = db.prepare(`
        SELECT i.id AS knowledgeId, v.title AS title
        FROM knowledge_items i
        JOIN knowledge_versions v ON v.id=i.current_version_id AND v.knowledge_id=i.id
        WHERE i.project_id=? AND i.lifecycle='active' AND lower(trim(v.title))=?
        ORDER BY i.id COLLATE BINARY ASC
        LIMIT 20
      `).all(location.id, group.normalizedTitle) as Array<{ knowledgeId: string; title: string }>;
      return { normalizedTitle: group.normalizedTitle, knowledgeIds: rows.map((row) => row.knowledgeId), titles: rows.map((row) => row.title) };
    });

    const staleIds = health.sourceFreshness.samples
      .filter((sample) => sample.status === "stale" && sample.knowledgeId)
      .map((sample) => sample.knowledgeId as string);
    if (staleIds.length > 0) {
      const placeholders = staleIds.map(() => "?").join(",");
      const rows = db.prepare(`
        SELECT DISTINCT i.id AS knowledgeId, v.title AS title,
          related.id AS relatedKnowledgeId, r.relation_type AS relationType
        FROM knowledge_relations r
        JOIN knowledge_items i ON i.id=r.source_knowledge_id
        JOIN knowledge_versions v ON v.id=i.current_version_id AND v.knowledge_id=i.id
        JOIN knowledge_items related ON related.id=r.target_knowledge_id
        WHERE r.project_id=? AND i.project_id=? AND related.project_id=?
          AND r.relation_type IN ('depends_on','derived_from','affects')
          AND (i.id IN (${placeholders}) OR related.id IN (${placeholders}))
        ORDER BY i.id COLLATE BINARY ASC, related.id COLLATE BINARY ASC, r.relation_type COLLATE BINARY ASC
        LIMIT ?
      `).all(location.id, location.id, location.id, ...staleIds, ...staleIds, limit + 1) as Array<{
        knowledgeId: string; title: string; relatedKnowledgeId: string; relationType: string;
      }>;
      dependentReviewTotal = rows.length > limit ? limit + 1 : rows.length;
      dependentReview = rows.slice(0, limit);
    }

    const result = {
      projectId: location.id,
      mode: "dry_run" as const,
      applied: false,
      summary: {
        staleEvidence: health.sourceFreshness.counts.stale,
        duplicateCandidateGroups: duplicateTotal,
        contradictions: health.conflicts.total,
        orphanRelations: health.brokenReferences.orphanRelations,
        dependentReviewCandidates: dependentReviewTotal,
      },
      staleEvidence: health.sourceFreshness.samples.filter((sample) => sample.status === "stale"),
      duplicateCandidates,
      contradictions: health.conflicts.samples,
      orphanRelations: health.brokenReferences.samples.filter((sample) =>
        typeof sample === "object" && sample !== null && "kind" in sample && sample.kind === "orphan_relation"),
      dependentReview,
      truncation: {
        staleEvidence: health.sourceFreshness.truncated,
        duplicateCandidates: duplicateTotal > duplicateCandidates.length,
        contradictions: health.conflicts.truncated,
        orphanRelations: health.brokenReferences.truncated,
        dependentReview: dependentReviewTotal > limit,
      },
      limit,
      maxChars: 12000,
    };
    while (JSON.stringify(result).length > result.maxChars &&
      (result.dependentReview.length || result.duplicateCandidates.length || result.staleEvidence.length || result.contradictions.length || result.orphanRelations.length)) {
      if (result.dependentReview.length) result.dependentReview.pop();
      else if (result.duplicateCandidates.length) result.duplicateCandidates.pop();
      else if (result.staleEvidence.length) result.staleEvidence.pop();
      else if (result.contradictions.length) result.contradictions.pop();
      else result.orphanRelations.pop();
    }
    return { ...result, serializedChars: JSON.stringify(result).length };
  } finally {
    db.close();
  }
}
