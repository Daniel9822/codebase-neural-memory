import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { openDatabase } from "../storage/database.js";
import type { ProjectLocation } from "./project.js";
import type { KnowledgeEpistemicState, MemoryCaptureEvidence } from "./memory-capture.js";
import { appendDependentReviewRequests } from "./memory-review-propagation.js";

export interface MemoryCorrectInput {
  knowledgeId: string;
  expectedVersionId: string;
  targetFragmentId: string;
  replacementContent: string;
  reason: string;
  correctionSource: "user" | "agent";
  epistemicState: KnowledgeEpistemicState;
  actor?: string | undefined;
  evidence?: MemoryCaptureEvidence[] | undefined;
}
export interface MemoryCorrectResult {
  status: "corrected" | "conflict" | "no_op";
  knowledgeId: string;
  previousVersionId: string;
  currentVersionId: string;
  targetFragmentId: string;
  correctionSource: "user" | "agent";
  versionNumber?: number;
  reason: string;
  dependentReviewRequests?: { created: number; total: number; truncated: boolean };
}
const states = new Set<KnowledgeEpistemicState>([
  "observed", "verified", "inferred", "user_asserted", "planned", "hypothesis", "pending_validation",
]);
const makeId = (prefix: string) => `${prefix}:${randomUUID()}`;
function required(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new Error(`Invalid memory correction ${field}`);
  }
  return value.trim();
}
function safeEvidencePath(root: string, value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.replaceAll("\\", "/");
  if (normalized.includes("\0") || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error("Evidence path must be project-relative");
  }
  const rel = relative(root, resolve(root, normalized));
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    throw new Error("Evidence path escapes project root");
  }
  return normalized;
}

/** Correct exactly one current fragment while preserving every other fragment and prior version. */
export function correctMemory(location: ProjectLocation, input: MemoryCorrectInput): MemoryCorrectResult {
  const knowledgeId = required(input.knowledgeId, "knowledgeId", 128);
  const expectedVersionId = required(input.expectedVersionId, "expectedVersionId", 128);
  const targetFragmentId = required(input.targetFragmentId, "targetFragmentId", 128);
  const replacementContent = required(input.replacementContent, "replacementContent", 8000);
  const reason = required(input.reason, "reason", 1000);
  const actor = input.actor === undefined ? null : required(input.actor, "actor", 200);
  if (input.correctionSource !== "user" && input.correctionSource !== "agent") {
    throw new Error("correctionSource must be user or agent");
  }
  if (!states.has(input.epistemicState)) throw new Error("Invalid epistemic state");
  if (input.correctionSource === "user" &&
      input.epistemicState !== "user_asserted" && input.epistemicState !== "pending_validation") {
    throw new Error("User corrections must be user_asserted or pending_validation");
  }
  if (input.correctionSource === "agent" && input.epistemicState === "verified" &&
      (!input.evidence || input.evidence.length === 0)) {
    throw new Error("Agent corrections marked verified require evidence");
  }
  if (input.evidence && input.evidence.length > 10) throw new Error("Evidence is limited to 10 entries");
  for (const [index, entry] of (input.evidence ?? []).entries()) {
    required(entry.evidenceType, `evidence[${index}].evidenceType`, 64);
    for (const [field, value, max] of [
      ["sourcePath", entry.sourcePath, 1000], ["sourceHash", entry.sourceHash, 256],
      ["commitSha", entry.commitSha, 128], ["sourceSymbol", entry.sourceSymbol, 500],
      ["testCommand", entry.testCommand, 1000], ["testResult", entry.testResult, 1000],
      ["actor", entry.actor, 200],
    ] as const) {
      if (value !== undefined) required(value, `evidence[${index}].${field}`, max);
    }
    if (entry.metadata !== undefined && (!entry.metadata || typeof entry.metadata !== "object" ||
        Array.isArray(entry.metadata) || Object.keys(entry.metadata).length > 20 ||
        Object.entries(entry.metadata).some(([key, value]) => key.length < 1 || key.length > 64 ||
          !(value === null || typeof value === "string" && value.length <= 1000 ||
            typeof value === "number" && Number.isFinite(value) || typeof value === "boolean")))) {
      throw new Error(`Invalid bounded correction evidence metadata at index ${index}`);
    }
  }
  const db = openDatabase(location);
  try {
    return db.transaction((): MemoryCorrectResult => {
      const item = db.prepare(`
        SELECT i.id, i.current_version_id, v.version_number, v.title, v.summary,
               v.confidence, v.confidence_reason, i.tags_json, i.aliases_json
        FROM knowledge_items i
        JOIN knowledge_versions v ON v.id = i.current_version_id AND v.knowledge_id = i.id
        WHERE i.id = ? AND i.project_id = ?
      `).get(knowledgeId, location.id) as {
        id: string; current_version_id: string; version_number: number; title: string; summary: string;
        confidence: number | null; confidence_reason: string | null; tags_json: string; aliases_json: string;
      } | undefined;
      if (!item) throw new Error("Knowledge item not found in this project");
      if (item.current_version_id !== expectedVersionId) return {
        status: "conflict", knowledgeId, previousVersionId: expectedVersionId,
        currentVersionId: item.current_version_id, targetFragmentId,
        correctionSource: input.correctionSource,
        reason: "The current version changed; reload the item before correcting it.",
      };
      const fragments = db.prepare(`
        SELECT id, ordinal, heading, summary, content FROM knowledge_fragments
        WHERE version_id = ? ORDER BY ordinal
      `).all(expectedVersionId) as Array<{
        id: string; ordinal: number; heading: string; summary: string; content: string;
      }>;
      const target = fragments.find(fragment => fragment.id === targetFragmentId);
      if (!target) throw new Error("Target fragment does not belong to the expected current version");
      if (target.content === replacementContent) return {
        status: "no_op", knowledgeId, previousVersionId: expectedVersionId,
        currentVersionId: expectedVersionId, targetFragmentId,
        correctionSource: input.correctionSource, versionNumber: item.version_number,
        reason: "Replacement content is identical; no version or event was created.",
      };
      const evidence = db.prepare(`
        SELECT evidence_type AS evidenceType, source_path AS sourcePath, source_hash AS sourceHash,
          commit_sha AS commitSha, source_symbol AS sourceSymbol, test_command AS testCommand,
          test_result AS testResult, actor, metadata_json AS metadataJson
        FROM knowledge_evidence WHERE version_id = ? ORDER BY id
      `).all(expectedVersionId) as Array<Record<string, string | null>>;
      const versionId = makeId("version");
      const versionNumber = item.version_number + 1;
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO knowledge_versions
          (id, knowledge_id, version_number, epistemic_state, confidence, confidence_reason,
           title, summary, created_by, change_reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(versionId, knowledgeId, versionNumber, input.epistemicState, item.confidence,
        item.confidence_reason, item.title, item.summary, actor, reason, now);
      const insertFragment = db.prepare(`
        INSERT INTO knowledge_fragments(id, version_id, ordinal, heading, summary, content)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const fragment of fragments) {
        insertFragment.run(makeId("fragment"), versionId, fragment.ordinal, fragment.heading,
          fragment.summary, fragment.id === targetFragmentId ? replacementContent : fragment.content);
      }
      const insertEvidence = db.prepare(`
        INSERT INTO knowledge_evidence
          (id, version_id, evidence_type, source_path, source_hash, commit_sha, source_symbol,
           test_command, test_result, actor, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const entry of evidence) {
        insertEvidence.run(makeId("evidence"), versionId, entry.evidenceType, entry.sourcePath,
          entry.sourceHash, entry.commitSha, entry.sourceSymbol, entry.testCommand,
          entry.testResult, entry.actor, entry.metadataJson ?? "{}", now);
      }
      for (const entry of input.evidence ?? []) {
        const evidenceType = required(entry.evidenceType, "evidenceType", 64);
        const sourcePath = entry.sourcePath === undefined ? null : safeEvidencePath(location.rootPath,
          required(entry.sourcePath, "evidence.sourcePath", 1000));
        const metadata = entry.metadata ?? {};
        if (Object.keys(metadata).length > 20 || Object.entries(metadata).some(([key, value]) =>
          key.length > 64 || !(value === null || typeof value === "string" && value.length <= 1000 ||
            typeof value === "number" && Number.isFinite(value) || typeof value === "boolean"))) {
          throw new Error("Invalid bounded correction evidence metadata");
        }
        insertEvidence.run(makeId("evidence"), versionId, evidenceType, sourcePath,
          entry.sourceHash ?? null, entry.commitSha ?? null, entry.sourceSymbol ?? null,
          entry.testCommand ?? null, entry.testResult ?? null, entry.actor ?? actor,
          JSON.stringify(metadata), now);
      }
      if (evidence.length + (input.evidence?.length ?? 0) > 20) {
        throw new Error("A version may contain at most 20 evidence entries");
      }
      const changed = db.prepare(`
        UPDATE knowledge_items SET current_version_id = ?, updated_at = ?
        WHERE id = ? AND project_id = ? AND current_version_id = ?
      `).run(versionId, now, knowledgeId, location.id, expectedVersionId);
      if (changed.changes !== 1) throw new Error("Concurrent memory correction detected");
      db.prepare(`
        INSERT INTO knowledge_events
          (id, project_id, knowledge_id, version_id, event_type, actor, reason, payload_json, created_at)
        VALUES (?, ?, ?, ?, 'corrected', ?, ?, ?, ?)
      `).run(makeId("event"), location.id, knowledgeId, versionId, actor, reason, JSON.stringify({
        previousVersionId: expectedVersionId, targetFragmentId, correctionSource: input.correctionSource,
        correctedOrdinal: target.ordinal, versionNumber,
      }), now);
      const dependentReviewRequests = appendDependentReviewRequests(
        db, location.id, knowledgeId, expectedVersionId, versionId, actor, now,
      );
      return {
        status: "corrected", knowledgeId, previousVersionId: expectedVersionId,
        currentVersionId: versionId, targetFragmentId,
        correctionSource: input.correctionSource, versionNumber, dependentReviewRequests,
        reason: "A corrected immutable version was appended; direct dependents were queued for review.",
      };
    }).immediate();
  } finally {
    db.close();
  }
}
