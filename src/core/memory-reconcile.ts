import { openDatabase } from "../storage/database.js";
import { getMemoryHealth } from "./memory-health.js";
import { previewSourceChangeReviews } from "./memory-source-change-review.js";
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
  const sourceChangeReview = previewSourceChangeReviews(location, { limit });
  const db = openDatabase(location);
  let duplicateCandidates: Array<{ normalizedTitle: string; knowledgeIds: string[]; titles: string[] }> = [];
  let duplicateTotal = 0;
  let dependentReview: Array<{ knowledgeId: string; title: string; relatedKnowledgeId: string; staleKnowledgeId: string; relationType: string; relationId: string }> = [];
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
    duplicateTotal = (db.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT lower(trim(v.title))
        FROM knowledge_items i
        JOIN knowledge_versions v ON v.id=i.current_version_id AND v.knowledge_id=i.id
        WHERE i.project_id=? AND i.lifecycle='active' AND trim(v.title)<>''
        GROUP BY lower(trim(v.title)) HAVING COUNT(*) > 1
      )
    `).get(location.id) as { count: number }).count;

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

    const staleIds = [...new Set(health.sourceFreshness.samples
      .filter((sample) => sample.status === "stale" && sample.knowledgeId)
      .map((sample) => sample.knowledgeId as string))].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    if (staleIds.length > 0) {
      const placeholders = staleIds.map(() => "?").join(",");
      // Relations are directed: depends_on/derived_from point from dependent
      // knowledge to its source; affects points from the cause to the affected
      // knowledge. Only the directionally dependent side is proposed for review.
      const dependentReviewBase = `
        WITH directional_candidates AS (
          SELECT dependent.id AS knowledgeId, v.title AS title,
            stale.id AS relatedKnowledgeId, stale.id AS staleKnowledgeId,
            r.relation_type AS relationType, r.id AS relationId,
            ROW_NUMBER() OVER (
              PARTITION BY dependent.id
              ORDER BY stale.id COLLATE BINARY ASC, r.relation_type COLLATE BINARY ASC,
                r.id COLLATE BINARY ASC
            ) AS candidateRank
          FROM knowledge_relations r
          JOIN knowledge_items source ON source.id=r.source_knowledge_id
          JOIN knowledge_items target ON target.id=r.target_knowledge_id
          JOIN knowledge_items dependent ON (
            (r.relation_type IN ('depends_on','derived_from') AND dependent.id=source.id)
            OR (r.relation_type='affects' AND dependent.id=target.id)
          )
          JOIN knowledge_items stale ON (
            (r.relation_type IN ('depends_on','derived_from') AND stale.id=target.id)
            OR (r.relation_type='affects' AND stale.id=source.id)
          )
          JOIN knowledge_versions v ON v.id=dependent.current_version_id AND v.knowledge_id=dependent.id
          WHERE r.project_id=? AND source.project_id=? AND target.project_id=?
            AND dependent.lifecycle='active'
            AND (
              (r.relation_type IN ('depends_on','derived_from') AND stale.id IN (${placeholders}))
              OR (r.relation_type='affects' AND stale.id IN (${placeholders}))
            )
        )
        SELECT knowledgeId, title, relatedKnowledgeId, staleKnowledgeId, relationType, relationId
        FROM directional_candidates
        WHERE candidateRank=1
      `;
      const parameters = [location.id, location.id, location.id, ...staleIds, ...staleIds];
      dependentReviewTotal = (db.prepare(`SELECT COUNT(*) AS count FROM (${dependentReviewBase})`)
        .get(...parameters) as { count: number }).count;
      dependentReview = db.prepare(`
        ${dependentReviewBase}
        ORDER BY knowledgeId COLLATE BINARY ASC, staleKnowledgeId COLLATE BINARY ASC,
          relationType COLLATE BINARY ASC, relationId COLLATE BINARY ASC
        LIMIT ?
      `).all(...parameters, limit) as Array<{
        knowledgeId: string; title: string; relatedKnowledgeId: string;
        staleKnowledgeId: string; relationType: string; relationId: string;
      }>;
    }

    const result = {
      projectId: location.id,
      mode: "dry_run" as const,
      applied: false,
      summary: {
        staleEvidenceSampled: health.sourceFreshness.counts.stale,
        duplicateCandidateGroups: duplicateTotal,
        contradictions: health.conflicts.total,
        orphanRelations: health.brokenReferences.orphanRelations,
        dependentReviewCandidates: dependentReviewTotal,
        sourceChangeReviewCandidates: sourceChangeReview.matchedKnowledgeTotal,
        dependentReviewScope: "sampled_stale_evidence" as const,
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
        dependentReview: dependentReviewTotal > limit || health.sourceFreshness.truncated,\n        sourceChangeReview: sourceChangeReview.truncated,
      },
      limit,
      maxChars: 12000,
    };
    while (JSON.stringify(result, null, 2).length > result.maxChars &&
      (result.dependentReview.length || result.sourceChangeReview.candidates.length || result.duplicateCandidates.length || result.staleEvidence.length || result.contradictions.length || result.orphanRelations.length)) {
      if (result.dependentReview.length) result.dependentReview.pop();
      else if (result.sourceChangeReview.candidates.length) result.sourceChangeReview.candidates.pop();\n      else if (result.duplicateCandidates.length) result.duplicateCandidates.pop();
      else if (result.staleEvidence.length) result.staleEvidence.pop();
      else if (result.contradictions.length) result.contradictions.pop();
      else result.orphanRelations.pop();
    }
    result.truncation.dependentReview ||= result.dependentReview.length < dependentReviewTotal;\n    result.sourceChangeReview.truncated ||= result.sourceChangeReview.candidates.length < result.sourceChangeReview.matchedKnowledgeTotal;\n    result.truncation.sourceChangeReview = result.sourceChangeReview.truncated;
    result.truncation.duplicateCandidates ||= result.duplicateCandidates.length < duplicateTotal;
    result.truncation.staleEvidence ||= result.staleEvidence.length < health.sourceFreshness.samples.filter((sample) => sample.status === "stale").length;
    result.truncation.contradictions ||= result.contradictions.length < health.conflicts.samples.length;
    result.truncation.orphanRelations ||= result.orphanRelations.length < health.brokenReferences.samples.filter((sample) => typeof sample === "object" && sample !== null && "kind" in sample && sample.kind === "orphan_relation").length;
    return { ...result, serializedChars: JSON.stringify(result, null, 2).length };
  } finally {
    db.close();
  }
}
