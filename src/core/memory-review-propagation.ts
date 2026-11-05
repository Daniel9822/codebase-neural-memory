import { randomUUID } from "node:crypto";
import type { MemoryDatabase } from "../storage/database.js";

export interface DependentReviewPropagationResult {
  created: number;
  total: number;
  truncated: boolean;
}

/**
 * Append bounded review requests for direct active dependents after a source
 * knowledge version changes. The caller owns the surrounding write transaction.
 * No dependent content, version, lifecycle, evidence, or relation is modified.
 */
export function appendDependentReviewRequests(
  db: MemoryDatabase,
  projectId: string,
  changedKnowledgeId: string,
  previousVersionId: string,
  currentVersionId: string,
  actor: string | null,
  now: string,
): DependentReviewPropagationResult {
  const total = (db.prepare(`
    SELECT COUNT(DISTINCT dependent.id) AS count
    FROM knowledge_relations r
    JOIN knowledge_items source ON source.id=r.source_knowledge_id AND source.project_id=?
    JOIN knowledge_items target ON target.id=r.target_knowledge_id AND target.project_id=?
    JOIN knowledge_items dependent ON (
      (r.relation_type IN ('depends_on','derived_from') AND dependent.id=source.id)
      OR (r.relation_type='affects' AND dependent.id=target.id)
    ) AND dependent.project_id=? AND dependent.lifecycle='active'
    WHERE r.project_id=? AND (
      (r.relation_type IN ('depends_on','derived_from') AND target.id=?)
      OR (r.relation_type='affects' AND source.id=?)
    )
      AND dependent.id<>?
      AND NOT EXISTS (
        SELECT 1 FROM knowledge_events request
        WHERE request.project_id=? AND request.knowledge_id=dependent.id
          AND request.event_type='reconciliation_review_requested'
          AND request.version_id=dependent.current_version_id
          AND NOT EXISTS (
            SELECT 1 FROM knowledge_events resolved
            WHERE resolved.project_id=request.project_id
              AND resolved.event_type='reconciliation_review_resolved'
              AND json_extract(resolved.payload_json,'$.requestEventId')=request.id
          )
      )
  `).get(projectId, projectId, projectId, projectId,
    changedKnowledgeId, changedKnowledgeId, changedKnowledgeId, projectId) as { count: number }).count;
  const candidates = db.prepare(`
    SELECT DISTINCT dependent.id AS knowledgeId, dependent.current_version_id AS currentVersionId
    FROM knowledge_relations r
    JOIN knowledge_items source ON source.id=r.source_knowledge_id AND source.project_id=?
    JOIN knowledge_items target ON target.id=r.target_knowledge_id AND target.project_id=?
    JOIN knowledge_items dependent ON (
      (r.relation_type IN ('depends_on','derived_from') AND dependent.id=source.id)
      OR (r.relation_type='affects' AND dependent.id=target.id)
    ) AND dependent.project_id=? AND dependent.lifecycle='active'
    WHERE r.project_id=? AND (
      (r.relation_type IN ('depends_on','derived_from') AND target.id=?)
      OR (r.relation_type='affects' AND source.id=?)
    )
      AND dependent.id<>?
      AND NOT EXISTS (
        SELECT 1 FROM knowledge_events request
        WHERE request.project_id=? AND request.knowledge_id=dependent.id
          AND request.event_type='reconciliation_review_requested'
          AND request.version_id=dependent.current_version_id
          AND NOT EXISTS (
            SELECT 1 FROM knowledge_events resolved
            WHERE resolved.project_id=request.project_id
              AND resolved.event_type='reconciliation_review_resolved'
              AND json_extract(resolved.payload_json,'$.requestEventId')=request.id
          )
      )
    ORDER BY dependent.id COLLATE BINARY
    LIMIT 101
  `).all(projectId, projectId, projectId, projectId,
    changedKnowledgeId, changedKnowledgeId, changedKnowledgeId, projectId) as Array<{
      knowledgeId: string; currentVersionId: string;
    }>;

  const selected = candidates.slice(0, 100);
  for (const candidate of selected) {
    const relations = db.prepare(`
      SELECT r.id, r.relation_type AS relationType
      FROM knowledge_relations r
      JOIN knowledge_items source ON source.id=r.source_knowledge_id AND source.project_id=?
      JOIN knowledge_items target ON target.id=r.target_knowledge_id AND target.project_id=?
      WHERE r.project_id=? AND (
        (r.relation_type IN ('depends_on','derived_from') AND source.id=? AND target.id=?)
        OR (r.relation_type='affects' AND source.id=? AND target.id=?)
      )
      ORDER BY r.id COLLATE BINARY LIMIT 21
    `).all(projectId, projectId, projectId,
      candidate.knowledgeId, changedKnowledgeId,
      changedKnowledgeId, candidate.knowledgeId) as Array<{id:string;relationType:string}>;
    const eventId = `event:${randomUUID()}`;
    db.prepare(`
      INSERT INTO knowledge_events
        (id, project_id, knowledge_id, version_id, event_type, actor, reason, payload_json, created_at)
      VALUES (?, ?, ?, ?, 'reconciliation_review_requested', ?, ?, ?, ?)
    `).run(eventId, projectId, candidate.knowledgeId, candidate.currentVersionId,
      actor, "A directly related source knowledge item changed and requires review.",
      JSON.stringify({
        schemaVersion: 1,
        operation: "dependent_change_propagation",
        reasonCode: "dependent_stale_evidence",
        expectedVersionId: candidate.currentVersionId,
        changedKnowledgeId,
        previousSourceVersionId: previousVersionId,
        currentSourceVersionId: currentVersionId,
        relationIds: relations.slice(0, 20).map((row) => row.id),
        relationIdsTruncated: relations.length > 20,
      }), now);
  }
  return { created: selected.length, total, truncated: total > 100 };
}
