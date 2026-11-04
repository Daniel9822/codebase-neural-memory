import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { openDatabase } from "../storage/database.js";
import { getIndexFreshness, type IndexFreshness } from "./indexer.js";
import { compareGitCommits } from "./git.js";
import { readFileWithinRoot } from "./safe-file.js";
import type { ProjectLocation } from "./project.js";

export interface MemoryHealthInput { limit?: number | undefined; }
type EvidenceRow = {
  evidenceId: string;
  evidenceKind: "versioned" | "legacy";
  knowledgeId: string | null;
  title: string;
  sourcePath: string | null;
  sourceHash: string | null;
  commitSha: string | null;
  sourceSymbol: string | null;
  updatedAt: string;
};
type EvidenceAssessment = {
  evidenceId: string;
  evidenceKind: "versioned" | "legacy";
  knowledgeId: string | null;
  title: string;
  sourcePath: string | null;
  sourceSymbol: string | null;
  status: "current" | "stale" | "unknown";
  reason: string;
};
function count(db: ReturnType<typeof openDatabase>, sql: string, ...params: Array<string | number | null>): number {
  return (db.prepare(sql).get(...params) as { count: number }).count;
}
function tableExists(db: ReturnType<typeof openDatabase>, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function safeDisplayPath(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.replaceAll("\\", "/");
  if (isAbsolute(value) || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//") ||
      normalized.split("/").includes("..")) return null;
  return normalized.slice(0, 300);
}
function assessEvidence(location: ProjectLocation, row: EvidenceRow, freshness: IndexFreshness | null): EvidenceAssessment {
  const sourcePath = safeDisplayPath(row.sourcePath);
  let status: EvidenceAssessment["status"] = "unknown";
  let reason = "insufficient_provenance";
  if (row.sourcePath && !sourcePath) {
    reason = "unsafe_or_non_relative_path";
  } else if (sourcePath) {
    try {
      const read = readFileWithinRoot(location.rootPath, join(location.rootPath, sourcePath), {
        maxBytes: 128_000, rejectFinalSymlink: true, rejectHardLinks: true,
      });
      const currentHash = createHash("sha256").update(read.content).digest("hex");
      if (row.sourceHash) {
        const expectedHash = row.sourceHash.replace(/^sha256:/i, "");
        if (!/^[a-f0-9]{64}$/i.test(expectedHash)) {
          status = "unknown";
          reason = "unsupported_source_hash_format";
        } else {
          status = currentHash.toLowerCase() === expectedHash.toLowerCase() ? "current" : "stale";
          reason = status === "current" ? "source_hash_matches" : "source_hash_mismatch";
        }
      } else if (row.commitSha && freshness?.git.currentCommit && freshness.git.currentDirty === false) {
        const relationship = compareGitCommits(location.rootPath, row.commitSha, freshness.git.currentCommit);
        status = relationship === "current" ? "current" : ["ancestor", "ahead", "diverged"].includes(relationship) ? "stale" : "unknown";
        reason = "commit_" + relationship;
      } else if (row.commitSha) {
        reason = "commit_current_worktree_unverified";
      } else {
        reason = "source_hash_missing";
      }
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
      status = code === "ENOENT" ? "stale" : "unknown";
      reason = code === "ENOENT" ? "source_file_missing" : "source_file_unavailable";
    }
  } else if (row.commitSha && freshness?.git.currentCommit && freshness.git.currentDirty === false) {
    const relationship = compareGitCommits(location.rootPath, row.commitSha, freshness.git.currentCommit);
    status = relationship === "current" ? "current" : ["ancestor", "ahead", "diverged"].includes(relationship) ? "stale" : "unknown";
    reason = "commit_" + relationship;
  } else if (row.commitSha) {
    reason = "commit_current_worktree_unverified";
  }
  return {
    evidenceId: row.evidenceId, evidenceKind: row.evidenceKind, knowledgeId: row.knowledgeId,
    title: row.title.slice(0, 200), sourcePath, sourceSymbol: row.sourceSymbol?.slice(0, 200) ?? null,
    status, reason
  };
}

/** Read-only integrity, lifecycle, conflict, and bounded source-freshness report for one project. */
export function getMemoryHealth(location: ProjectLocation, input: MemoryHealthInput = {}) {
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid memory health limit");
  const db = openDatabase(location);
  let report: {
    schema: { status: string; currentVersion: number; appliedMigrations: number; lastAppliedAt: string | null };
    counts: Record<string, unknown>;
    epistemicStates: Record<string, number>;
    lifecycle: Record<string, number>;
    pendingTotal: number;
    pendingSamples: Array<Record<string, unknown>>;
    conflictTotal: number;
    conflictSamples: Array<Record<string, unknown>>;
    broken: {
      foreignKeyViolations: number | null; foreignKeyViolationsLowerBound: number; foreignKeyTruncated: boolean;
      currentVersionMismatches: number; orphanRelations: number; projectMismatchedRelations: number; projectMismatchedEvents: number;
      samples: Array<Record<string, unknown>>; samplesTruncated: boolean;
    };
    evidenceRows: EvidenceRow[];
    evidenceTotal: number;
    searchIndex: { status: string; migrationApplied: boolean; ftsRows: number; indexedVersions: number; knowledgeVersions: number; missingVersions: number; orphanedIndexedVersions: number; missingFtsRows: number; orphanedFtsRows: number };
  };
  try {
    const migration = db.prepare("SELECT COALESCE(MAX(version), 0) AS currentVersion, COUNT(*) AS appliedMigrations, MAX(applied_at) AS lastAppliedAt FROM schema_migrations")
      .get() as { currentVersion: number; appliedMigrations: number; lastAppliedAt: string | null };
    const lifecycleRows = db.prepare("SELECT lifecycle, COUNT(*) AS count FROM knowledge_items WHERE project_id=? GROUP BY lifecycle")
      .all(location.id) as Array<{ lifecycle: string; count: number }>;
    const lifecycle = Object.fromEntries(lifecycleRows.map((row) => [row.lifecycle, row.count]));
    const epistemicRows = db.prepare("SELECT v.epistemic_state AS state, COUNT(*) AS count FROM knowledge_items i JOIN knowledge_versions v ON v.id=i.current_version_id AND v.knowledge_id=i.id WHERE i.project_id=? AND i.lifecycle='active' GROUP BY v.epistemic_state")
      .all(location.id) as Array<{ state: string; count: number }>;
    const epistemicStates = Object.fromEntries(epistemicRows.map((row) => [row.state, row.count]));
    const pendingTotal = count(db,
      "SELECT COUNT(*) AS count FROM knowledge_items i JOIN knowledge_versions v ON v.id=i.current_version_id AND v.knowledge_id=i.id WHERE i.project_id=? AND i.lifecycle='active' AND v.epistemic_state IN ('pending_validation','hypothesis','planned')",
      location.id);
    const pendingSamples = db.prepare("SELECT i.id AS knowledgeId, v.id AS versionId, i.knowledge_type AS type, v.title, v.epistemic_state AS epistemicState, v.created_at AS createdAt FROM knowledge_items i JOIN knowledge_versions v ON v.id=i.current_version_id AND v.knowledge_id=i.id WHERE i.project_id=? AND i.lifecycle='active' AND v.epistemic_state IN ('pending_validation','hypothesis','planned') ORDER BY CASE v.epistemic_state WHEN 'pending_validation' THEN 0 WHEN 'hypothesis' THEN 1 ELSE 2 END, v.created_at DESC, i.id ASC LIMIT ?")
      .all(location.id, limit + 1) as Array<Record<string, unknown>>;
    const conflictTotal = count(db, "SELECT COUNT(*) AS count FROM knowledge_relations WHERE project_id=? AND relation_type='contradicts'", location.id);
    const conflictSamples = db.prepare("SELECT r.id AS relationId, r.source_knowledge_id AS sourceKnowledgeId, sv.title AS sourceTitle, r.target_knowledge_id AS targetKnowledgeId, tv.title AS targetTitle, r.created_at AS createdAt FROM knowledge_relations r JOIN knowledge_items s ON s.id=r.source_knowledge_id JOIN knowledge_versions sv ON sv.id=s.current_version_id AND sv.knowledge_id=s.id JOIN knowledge_items t ON t.id=r.target_knowledge_id JOIN knowledge_versions tv ON tv.id=t.current_version_id AND tv.knowledge_id=t.id WHERE r.project_id=? AND r.relation_type='contradicts' ORDER BY r.created_at DESC, r.id ASC LIMIT ?")
      .all(location.id, limit + 1) as Array<Record<string, unknown>>;

    const foreignKeySamples: Array<Record<string, unknown>> = [];
    let foreignKeyCount = 0, foreignKeyTruncated = false;
    for (const row of db.prepare("PRAGMA foreign_key_check").iterate() as Iterable<Record<string, unknown>>) {
      foreignKeyCount += 1;
      if (foreignKeySamples.length < limit) foreignKeySamples.push(row);
      else { foreignKeyTruncated = true; break; }
    }
    const currentVersionMismatches = count(db, "SELECT COUNT(*) AS count FROM knowledge_items i LEFT JOIN knowledge_versions v ON v.id=i.current_version_id AND v.knowledge_id=i.id WHERE i.project_id=? AND (i.current_version_id IS NULL OR v.id IS NULL)", location.id);
    const orphanRelations = count(db, "SELECT COUNT(*) AS count FROM knowledge_relations r LEFT JOIN knowledge_items s ON s.id=r.source_knowledge_id LEFT JOIN knowledge_items t ON t.id=r.target_knowledge_id WHERE r.project_id=? AND (s.id IS NULL OR t.id IS NULL)", location.id);
    const projectMismatchedRelations = count(db, "SELECT COUNT(*) AS count FROM knowledge_relations r JOIN knowledge_items s ON s.id=r.source_knowledge_id JOIN knowledge_items t ON t.id=r.target_knowledge_id WHERE r.project_id=? AND (s.project_id<>r.project_id OR t.project_id<>r.project_id)", location.id);
    const projectMismatchedEvents = count(db, "SELECT COUNT(*) AS count FROM knowledge_events e JOIN knowledge_items i ON i.id=e.knowledge_id WHERE e.project_id=? AND i.project_id<>e.project_id", location.id);
    const brokenSamples = [...foreignKeySamples];
    if (currentVersionMismatches && brokenSamples.length < limit) {
      const rows = db.prepare("SELECT i.id AS knowledgeId, i.current_version_id AS currentVersionId FROM knowledge_items i LEFT JOIN knowledge_versions v ON v.id=i.current_version_id AND v.knowledge_id=i.id WHERE i.project_id=? AND (i.current_version_id IS NULL OR v.id IS NULL) ORDER BY i.id LIMIT ?")
        .all(location.id, limit - brokenSamples.length) as Array<Record<string, unknown>>;
      brokenSamples.push(...rows.map((row) => ({ kind: "current_version_mismatch", ...row })));
    }
    if (orphanRelations && brokenSamples.length < limit) {
      const rows = db.prepare("SELECT r.id AS relationId, r.source_knowledge_id AS sourceKnowledgeId, r.target_knowledge_id AS targetKnowledgeId FROM knowledge_relations r LEFT JOIN knowledge_items s ON s.id=r.source_knowledge_id LEFT JOIN knowledge_items t ON t.id=r.target_knowledge_id WHERE r.project_id=? AND (s.id IS NULL OR t.id IS NULL) ORDER BY r.id LIMIT ?")
        .all(location.id, limit - brokenSamples.length) as Array<Record<string, unknown>>;
      brokenSamples.push(...rows.map((row) => ({ kind: "orphan_relation", ...row })));
    }
    if (projectMismatchedRelations && brokenSamples.length < limit) {
      const rows = db.prepare("SELECT r.id AS relationId, r.project_id AS relationProjectId, s.project_id AS sourceProjectId, t.project_id AS targetProjectId FROM knowledge_relations r JOIN knowledge_items s ON s.id=r.source_knowledge_id JOIN knowledge_items t ON t.id=r.target_knowledge_id WHERE r.project_id=? AND (s.project_id<>r.project_id OR t.project_id<>r.project_id) ORDER BY r.id LIMIT ?")
        .all(location.id, limit - brokenSamples.length) as Array<Record<string, unknown>>;
      brokenSamples.push(...rows.map((row) => ({ kind: "relation_project_mismatch", ...row })));
    }
    if (projectMismatchedEvents && brokenSamples.length < limit) {
      const rows = db.prepare("SELECT e.id AS eventId, e.project_id AS eventProjectId, i.project_id AS knowledgeProjectId FROM knowledge_events e JOIN knowledge_items i ON i.id=e.knowledge_id WHERE e.project_id=? AND i.project_id<>e.project_id ORDER BY e.id LIMIT ?")
        .all(location.id, limit - brokenSamples.length) as Array<Record<string, unknown>>;
      brokenSamples.push(...rows.map((row) => ({ kind: "event_project_mismatch", ...row })));
    }
    const legacyCount = tableExists(db, "memories") ? count(db, "SELECT COUNT(*) AS count FROM memories") : 0;
    const itemCount = count(db, "SELECT COUNT(*) AS count FROM knowledge_items WHERE project_id=?", location.id);
    const versionCount = count(db, "SELECT COUNT(*) AS count FROM knowledge_versions v JOIN knowledge_items i ON i.id=v.knowledge_id WHERE i.project_id=?", location.id);
    const fragmentCount = count(db, "SELECT COUNT(*) AS count FROM knowledge_fragments f JOIN knowledge_versions v ON v.id=f.version_id JOIN knowledge_items i ON i.id=v.knowledge_id WHERE i.project_id=?", location.id);
    const evidenceCount = count(db, "SELECT COUNT(*) AS count FROM knowledge_evidence e JOIN knowledge_versions v ON v.id=e.version_id JOIN knowledge_items i ON i.id=v.knowledge_id WHERE i.project_id=?", location.id);
    const relationCount = count(db, "SELECT COUNT(*) AS count FROM knowledge_relations WHERE project_id=?", location.id);
    const eventCount = count(db, "SELECT COUNT(*) AS count FROM knowledge_events WHERE project_id=?", location.id);
    const idempotencyCount = count(db, "SELECT COUNT(*) AS count FROM memory_idempotency WHERE project_id=?", location.id);
    const currentCount = count(db, "SELECT COUNT(*) AS count FROM knowledge_items WHERE project_id=? AND current_version_id IS NOT NULL", location.id);
    const sourceEvidenceCount = count(db, "SELECT COUNT(*) AS count FROM knowledge_evidence e JOIN knowledge_versions v ON v.id=e.version_id JOIN knowledge_items i ON i.id=v.knowledge_id WHERE i.project_id=? AND i.lifecycle='active' AND v.id=i.current_version_id AND (e.source_path IS NOT NULL OR e.commit_sha IS NOT NULL)", location.id);
    const versionedEvidenceRows = db.prepare("SELECT e.id AS evidenceId, 'versioned' AS evidenceKind, i.id AS knowledgeId, v.title, e.source_path AS sourcePath, e.source_hash AS sourceHash, e.commit_sha AS commitSha, e.source_symbol AS sourceSymbol, e.created_at AS updatedAt FROM knowledge_evidence e JOIN knowledge_versions v ON v.id=e.version_id JOIN knowledge_items i ON i.id=v.knowledge_id WHERE i.project_id=? AND i.lifecycle='active' AND v.id=i.current_version_id AND (e.source_path IS NOT NULL OR e.commit_sha IS NOT NULL) ORDER BY i.updated_at DESC, e.created_at DESC, e.id ASC LIMIT ?")
      .all(location.id, limit + 1) as EvidenceRow[];
    const legacySourceEvidenceCount = tableExists(db, "memories")
      ? count(db, "SELECT COUNT(*) AS count FROM memories WHERE status != 'rejected' AND (source_path IS NOT NULL OR commit_sha IS NOT NULL)") : 0;
    const legacyEvidenceRows = tableExists(db, "memories")
      ? db.prepare("SELECT id AS evidenceId, 'legacy' AS evidenceKind, NULL AS knowledgeId, title, source_path AS sourcePath, source_hash AS sourceHash, commit_sha AS commitSha, NULL AS sourceSymbol, updated_at AS updatedAt FROM memories WHERE status != 'rejected' AND (source_path IS NOT NULL OR commit_sha IS NOT NULL) ORDER BY updated_at DESC, id ASC LIMIT ?")
        .all(limit + 1) as EvidenceRow[]
      : [];
    const evidenceRows = [...versionedEvidenceRows, ...legacyEvidenceRows]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.evidenceId.localeCompare(b.evidenceId))
      .slice(0, limit + 1);

    const ftsExists = tableExists(db, "memory_search_fts");
    const markerExists = tableExists(db, "memory_search_indexed_versions");
    const ftsRows = ftsExists ? count(db, "SELECT COUNT(*) AS count FROM memory_search_fts") : 0;
    const indexedVersions = markerExists ? count(db, "SELECT COUNT(*) AS count FROM memory_search_indexed_versions") : 0;
    const searchMigrationApplied = count(db, "SELECT COUNT(*) AS count FROM schema_migrations WHERE version=14") > 0;
    const missingVersions = markerExists ? count(db, "SELECT COUNT(*) AS count FROM knowledge_versions v JOIN knowledge_items i ON i.id=v.knowledge_id LEFT JOIN memory_search_indexed_versions x ON x.version_id=v.id WHERE i.project_id=? AND x.version_id IS NULL", location.id) : versionCount;
    const orphanedIndexedVersions = markerExists ? count(db, "SELECT COUNT(*) AS count FROM memory_search_indexed_versions x LEFT JOIN knowledge_versions v ON v.id=x.version_id WHERE v.id IS NULL") : 0;
    const missingFtsRows = ftsExists && markerExists ? count(db, "SELECT COUNT(*) AS count FROM memory_search_indexed_versions x LEFT JOIN memory_search_fts f ON f.version_id=x.version_id WHERE f.version_id IS NULL") : 0;
    const orphanedFtsRows = ftsExists && markerExists ? count(db, "SELECT COUNT(*) AS count FROM memory_search_fts f LEFT JOIN memory_search_indexed_versions x ON x.version_id=f.version_id WHERE x.version_id IS NULL") : 0;
    const searchIndexStatus = !ftsExists && !markerExists && !searchMigrationApplied ? "not_initialized"
      : ftsExists && markerExists && searchMigrationApplied && ftsRows === indexedVersions && indexedVersions === versionCount &&
        missingVersions === 0 && orphanedIndexedVersions === 0 && missingFtsRows === 0 && orphanedFtsRows === 0
        ? "consistent" : "inconsistent";
    report = {
      schema: {
        status: migration.currentVersion >= 13 ? "current" : "incomplete",
        currentVersion: migration.currentVersion, appliedMigrations: migration.appliedMigrations,
        lastAppliedAt: migration.lastAppliedAt,
      },
      counts: {
        legacyMemories: legacyCount, knowledgeItems: itemCount, currentKnowledge: currentCount,
        versions: versionCount, fragments: fragmentCount, evidence: evidenceCount,
        sourceEvidence: sourceEvidenceCount, relations: relationCount, events: eventCount, idempotencyRecords: idempotencyCount,
      },
      epistemicStates, lifecycle, pendingTotal, pendingSamples,
      conflictTotal, conflictSamples,
      broken: {
        foreignKeyViolations: foreignKeyTruncated ? null : foreignKeyCount,
        foreignKeyViolationsLowerBound: foreignKeyCount, foreignKeyTruncated,
        currentVersionMismatches, orphanRelations, projectMismatchedRelations, projectMismatchedEvents,
        samples: brokenSamples, samplesTruncated: foreignKeyTruncated || foreignKeyCount > foreignKeySamples.length ||
          currentVersionMismatches + orphanRelations + projectMismatchedRelations + projectMismatchedEvents > Math.max(0, limit - foreignKeySamples.length),
      },
      evidenceRows, evidenceTotal: sourceEvidenceCount + legacySourceEvidenceCount,
      searchIndex: {
        status: searchIndexStatus, migrationApplied: searchMigrationApplied, ftsRows, indexedVersions, knowledgeVersions: versionCount,
        missingVersions, orphanedIndexedVersions, missingFtsRows, orphanedFtsRows,
      },
    };
  } finally { db.close(); }

  let indexFreshness: IndexFreshness | null = null;
  let indexFreshnessError = false;
  try { indexFreshness = getIndexFreshness(location); } catch { indexFreshnessError = true; }
  const evidenceSamples = report.evidenceRows.slice(0, limit).map((row) => assessEvidence(location, row, indexFreshness));
  const sourceCounts = {
    current: evidenceSamples.filter((item) => item.status === "current").length,
    stale: evidenceSamples.filter((item) => item.status === "stale").length,
    unknown: evidenceSamples.filter((item) => item.status === "unknown").length,
  };
  const evidenceTruncated = report.evidenceTotal > evidenceSamples.length;
  const sourceStatus = sourceCounts.stale > 0 ? "stale" : sourceCounts.unknown > 0 || evidenceTruncated ? "unknown"
    : sourceCounts.current > 0 ? "current" : "not_applicable";
  const warnings: string[] = [];
  if (report.schema.status !== "current") warnings.push("Schema migrations are incomplete.");
  if (Object.values(report.broken).some((value) => typeof value === "number" && value > 0)) warnings.push("Broken references or project-boundary mismatches were detected.");
  if (report.searchIndex.status === "inconsistent") warnings.push("The FTS search index and its version bookkeeping are inconsistent.");
  if (report.pendingTotal > 0) warnings.push("Current knowledge includes items pending validation.");
  if (report.conflictTotal > 0) warnings.push("Contradictory knowledge relations require review.");
  if (indexFreshnessError) warnings.push("Code-index freshness could not be checked.");
  else if (indexFreshness && indexFreshness.status !== "current") warnings.push("Code-index freshness is " + indexFreshness.status + ".");
  if (sourceCounts.stale > 0) warnings.push("Some sampled source evidence no longer matches the current source.");
  if (sourceCounts.unknown > 0) warnings.push("Some sampled source evidence could not be verified.");
  if (evidenceTruncated) warnings.push("The source-evidence sample is truncated; unexamined evidence is not asserted fresh.");
  const brokenCount = Number(report.broken.currentVersionMismatches) + Number(report.broken.orphanRelations) +
    Number(report.broken.projectMismatchedRelations) + Number(report.broken.projectMismatchedEvents) +
    Number(report.broken.foreignKeyViolationsLowerBound);
  const searchIndexInconsistent = report.searchIndex.status === "inconsistent";
  const status = brokenCount > 0 || searchIndexInconsistent || report.schema.status !== "current" ? "error"
    : warnings.length > 0 ? "warning" : "healthy";
  const result = {
    projectId: location.id, status, schema: report.schema, counts: report.counts, lifecycle: report.lifecycle,
    epistemicStates: report.epistemicStates,
    pendingValidation: {
      total: report.pendingTotal, samples: report.pendingSamples.slice(0, limit),
      truncated: report.pendingSamples.length > limit,
    },
    conflicts: { total: report.conflictTotal, samples: report.conflictSamples.slice(0, limit), truncated: report.conflictSamples.length > limit },
    brokenReferences: {
      foreignKeyViolations: report.broken.foreignKeyViolations,
      foreignKeyViolationsLowerBound: report.broken.foreignKeyViolationsLowerBound,
      foreignKeyTruncated: report.broken.foreignKeyTruncated,
      currentVersionMismatches: report.broken.currentVersionMismatches,
      orphanRelations: report.broken.orphanRelations,
      projectMismatchedRelations: report.broken.projectMismatchedRelations,
      projectMismatchedEvents: report.broken.projectMismatchedEvents,
      samples: report.broken.samples, truncated: report.broken.samplesTruncated,
    },
    searchIndex: report.searchIndex,
    sourceFreshness: {
      status: sourceStatus, indexStatus: indexFreshness?.status ?? "unavailable",
      sampled: evidenceSamples.length, total: report.evidenceTotal, counts: sourceCounts,
      samples: evidenceSamples, truncated: evidenceTruncated,
    },
    warnings, limit, maxChars: 12000,
    truncated: {
      pendingValidation: report.pendingSamples.length > limit,
      conflicts: report.conflictSamples.length > limit,
      sourceFreshness: evidenceTruncated,
      brokenReferences: Boolean(report.broken.samplesTruncated),
    },
    serializedChars: 0,
  };
  const sampleGroups = [
    result.sourceFreshness.samples,
    result.conflicts.samples,
    result.pendingValidation.samples,
    result.brokenReferences.samples,
  ];
  const measure = () => {
    for (let attempt = 0; attempt < 3; attempt++) result.serializedChars = JSON.stringify(result, null, 2).length;
  };
  measure();
  while (result.serializedChars > result.maxChars && sampleGroups.some((group) => group.length)) {
    [...sampleGroups].find((group) => group.length)?.pop();
    result.sourceFreshness.truncated = result.sourceFreshness.samples.length < Math.min(report.evidenceTotal, limit) || evidenceTruncated;
    result.conflicts.truncated = result.conflicts.samples.length < Math.min(report.conflictTotal, limit) || report.conflictTotal > limit;
    result.pendingValidation.truncated = result.pendingValidation.samples.length < Math.min(report.pendingTotal, limit) || report.pendingTotal > limit;
    result.brokenReferences.truncated = result.brokenReferences.samples.length < report.broken.samples.length || Boolean(report.broken.samplesTruncated);
    result.truncated.sourceFreshness = result.sourceFreshness.truncated;
    result.truncated.conflicts = result.conflicts.truncated;
    result.truncated.pendingValidation = result.pendingValidation.truncated;
    result.truncated.brokenReferences = result.brokenReferences.truncated;
    measure();
  }
  return result;
}
