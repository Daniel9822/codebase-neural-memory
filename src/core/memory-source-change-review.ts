import { openDatabase } from "../storage/database.js";
import { getIndexFreshness } from "./indexer.js";
import type { ProjectLocation } from "./project.js";

export interface SourceChangeReviewInput {
  limit?: number | undefined;
}

export interface SourceChangeReviewResult {
  indexStatus: "not-indexed" | "current" | "stale" | "incomplete";
  indexRevision: number;
  changedPathsTotal: number;
  changedPathsReturned: number;
  matchedKnowledgeTotal: number;
  candidates: Array<{
    knowledgeId: string;
    versionId: string;
    title: string;
    sources: Array<{
      path: string;
      status: "added" | "changed" | "deleted";
      oldHash: string | null;
      newHash: string | null;
    }>;
    sourcesTruncated: boolean;
  }>;
  complete: boolean;
  truncated: boolean;
  limitations: string[];
}

/**
 * Match the indexer's deterministic file-change manifest to current, active
 * versioned evidence. This is discovery only: it never writes review events
 * or changes knowledge state. Incomplete discovery is explicitly non-exhaustive.
 */
export function previewSourceChangeReviews(
  location: ProjectLocation,
  input: SourceChangeReviewInput = {},
): SourceChangeReviewResult {
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Invalid source change review limit");
  }

  const projectDb = openDatabase(location);
  let initialized: { index_revision: number } | undefined;
  try {
    initialized = projectDb.prepare("SELECT index_revision FROM projects WHERE id = ?")
      .get(location.id) as { index_revision: number } | undefined;
  } finally {
    projectDb.close();
  }
  if (!initialized) {
    return {
      indexStatus: "not-indexed",
      indexRevision: 0,
      changedPathsTotal: 0,
      changedPathsReturned: 0,
      matchedKnowledgeTotal: 0,
      candidates: [],
      complete: false,
      truncated: false,
      limitations: ["index_not_initialized", "commit_only_provenance_not_matched"],
    };
  }

  const freshness = getIndexFreshness(location);
  const changes = freshness.fileChanges;
  const paths = [...new Set(changes.map((change) => change.path))];
  const limitations: string[] = ["commit_only_provenance_not_matched"];
  if (freshness.status === "not-indexed") limitations.push("index_not_initialized");
  if (freshness.status === "incomplete") limitations.push("index_discovery_incomplete");
  if (freshness.fileChangesTruncated) limitations.push("changed_path_manifest_truncated");
  if (freshness.totals.skippedFiles > 0) limitations.push("source_discovery_skipped_files");
  if (freshness.totals.errors > 0) limitations.push("source_discovery_errors");

  if (paths.length === 0) {
    const complete = freshness.status === "current" ||
      (freshness.status === "stale" && !freshness.fileChangesTruncated &&
        freshness.totals.skippedFiles === 0 && freshness.totals.errors === 0);
    return {
      indexStatus: freshness.status,
      indexRevision: freshness.indexRevision,
      changedPathsTotal: freshness.fileChangesTotal,
      changedPathsReturned: 0,
      matchedKnowledgeTotal: 0,
      candidates: [],
      complete,
      truncated: freshness.fileChangesTruncated,
      limitations,
    };
  }

  const db = openDatabase(location);
  try {
    const placeholders = paths.map(() => "?").join(", ");
    const total = (db.prepare(`
      SELECT COUNT(DISTINCT i.id) AS count
      FROM knowledge_evidence e
      JOIN knowledge_versions v ON v.id=e.version_id
      JOIN knowledge_items i ON i.id=v.knowledge_id
      WHERE i.project_id=? AND i.lifecycle='active'
        AND v.id=i.current_version_id AND e.source_path IN (${placeholders})
    `).get(location.id, ...paths) as { count: number }).count;

    const rows = db.prepare(`
      SELECT i.id AS knowledgeId, v.id AS versionId, v.title
      FROM knowledge_evidence e
      JOIN knowledge_versions v ON v.id=e.version_id
      JOIN knowledge_items i ON i.id=v.knowledge_id
      WHERE i.project_id=? AND i.lifecycle='active'
        AND v.id=i.current_version_id AND e.source_path IN (${placeholders})
      GROUP BY i.id, v.id, v.title
      ORDER BY i.id COLLATE BINARY ASC
      LIMIT ?
    `).all(location.id, ...paths, limit + 1) as Array<{
      knowledgeId: string; versionId: string; title: string;
    }>;

    const candidates = rows.slice(0, limit).map((row) => {
      const sourceRows = db.prepare(`
        SELECT DISTINCT source_path AS path
        FROM knowledge_evidence
        WHERE version_id=? AND source_path IN (${placeholders})
        ORDER BY source_path COLLATE BINARY ASC
        LIMIT 21
      `).all(row.versionId, ...paths) as Array<{ path: string }>;
      const sourceMap = new Map(changes.map((change) => [change.path, change]));
      const sources = sourceRows.slice(0, 20).flatMap(({ path }) => {
        const change = sourceMap.get(path);
        return change ? [{
          path,
          status: change.status,
          oldHash: change.oldHash,
          newHash: change.newHash,
        }] : [];
      });
      return {
        knowledgeId: row.knowledgeId,
        versionId: row.versionId,
        title: row.title.slice(0, 200),
        sources,
        sourcesTruncated: sourceRows.length > 20,
      };
    });

    const complete = freshness.status === "current" ||
      (freshness.status === "stale" && !freshness.fileChangesTruncated &&
        freshness.totals.skippedFiles === 0 && freshness.totals.errors === 0);
    return {
      indexStatus: freshness.status,
      indexRevision: freshness.indexRevision,
      changedPathsTotal: freshness.fileChangesTotal,
      changedPathsReturned: paths.length,
      matchedKnowledgeTotal: total,
      candidates,
      complete,
      truncated: freshness.fileChangesTruncated || total > candidates.length,
      limitations,
    };
  } finally {
    db.close();
  }
}
