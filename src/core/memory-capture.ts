import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { openDatabase } from "../storage/database.js";
import type { ProjectLocation } from "./project.js";

export type KnowledgeEpistemicState =
  | "observed" | "verified" | "inferred" | "user_asserted"
  | "planned" | "hypothesis" | "pending_validation";

export interface MemoryCaptureEvidence {
  evidenceType: string;
  sourcePath?: string;
  sourceHash?: string;
  commitSha?: string;
  sourceSymbol?: string;
  testCommand?: string;
  testResult?: string;
  actor?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface MemoryCaptureFragment {
  heading?: string;
  summary?: string;
  content: string;
}

export interface MemoryCaptureItem {
  title: string;
  content: string;
  type: string;
  summary?: string;
  epistemicState: KnowledgeEpistemicState;
  confidence?: number;
  confidenceReason?: string;
  tags?: string[];
  aliases?: string[];
  fragments?: MemoryCaptureFragment[];
  evidence?: MemoryCaptureEvidence[];
}

export interface MemoryCaptureInput {
  idempotencyKey: string;
  items: MemoryCaptureItem[];
  actor?: string;
  origin?: string;
}

export interface MemoryCaptureOutcome {
  inputIndex: number;
  operation: "created" | "duplicate" | "conflict";
  knowledgeId: string;
  reason: string;
}

export interface MemoryCaptureResult {
  idempotentReplay: boolean;
  outcomes: MemoryCaptureOutcome[];
  created: number;
  duplicates: number;
  conflicts: number;
}

const EPISTEMIC_STATES = new Set<KnowledgeEpistemicState>([
  "observed", "verified", "inferred", "user_asserted", "planned", "hypothesis", "pending_validation",
]);
const MAX_ITEMS = 20;
const MAX_TEXT = 20_000;
const MAX_TAGS = 20;
const MAX_ALIASES = 20;
const MAX_FRAGMENTS = 20;
const MAX_EVIDENCE = 10;

function text(value: unknown, field: string, max: number, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string") throw new Error(`Invalid memory capture ${field}: expected text`);
  const normalized = value.trim();
  if (!normalized && optional) return undefined;
  if (!normalized) throw new Error(`Invalid memory capture ${field}: must not be blank`);
  if (normalized.length > max) throw new Error(`Invalid memory capture ${field}: exceeds ${max} characters`);
  return normalized;
}

function textList(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`Invalid memory capture ${field}: expected at most ${maxItems} entries`);
  }
  const result = value.map((entry, index) => text(entry, `${field}[${index}]`, maxLength)!);
  if (new Set(result.map(normalize)).size !== result.length) {
    throw new Error(`Invalid memory capture ${field}: duplicate entries`);
  }
  return result;
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
}

function validateInput(input: MemoryCaptureInput): MemoryCaptureInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid memory capture input");
  const idempotencyKey = text(input.idempotencyKey, "idempotencyKey", 128)!;
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > MAX_ITEMS) {
    throw new Error(`Memory capture requires 1–${MAX_ITEMS} items`);
  }
  const actor = text(input.actor, "actor", 200, true);
  const origin = text(input.origin, "origin", 200, true);
  const items = input.items.map((raw, index): MemoryCaptureItem => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Invalid memory capture item ${index}`);
    const title = text(raw.title, `items[${index}].title`, 240)!;
    const content = text(raw.content, `items[${index}].content`, MAX_TEXT)!;
    const type = text(raw.type, `items[${index}].type`, 64)!;
    if (!EPISTEMIC_STATES.has(raw.epistemicState)) throw new Error(`Invalid epistemic state for item ${index}`);
    if (raw.confidence !== undefined && (typeof raw.confidence !== "number" || !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1)) {
      throw new Error(`Invalid confidence for item ${index}: expected a number from 0 to 1`);
    }
    const confidenceReason = text(raw.confidenceReason, `items[${index}].confidenceReason`, 500, true);
    if (raw.confidence !== undefined && !confidenceReason) throw new Error(`Confidence reason is required for item ${index}`);
    const tags = textList(raw.tags, `items[${index}].tags`, MAX_TAGS, 64);
    const aliases = textList(raw.aliases, `items[${index}].aliases`, MAX_ALIASES, 64);
    const fragments = raw.fragments === undefined ? [{ content }] : raw.fragments;
    if (!Array.isArray(fragments) || fragments.length < 1 || fragments.length > MAX_FRAGMENTS) {
      throw new Error(`Invalid fragments for item ${index}: expected 1–${MAX_FRAGMENTS}`);
    }
    const normalizedFragments = fragments.map((fragment, fragmentIndex) => ({
      heading: text(fragment.heading, `items[${index}].fragments[${fragmentIndex}].heading`, 240, true) ?? "",
      summary: text(fragment.summary, `items[${index}].fragments[${fragmentIndex}].summary`, 1_000, true) ?? "",
      content: text(fragment.content, `items[${index}].fragments[${fragmentIndex}].content`, 8_000)!,
    }));
    const evidence = raw.evidence ?? [];
    if (!Array.isArray(evidence) || evidence.length > MAX_EVIDENCE) {
      throw new Error(`Invalid evidence for item ${index}: expected at most ${MAX_EVIDENCE} entries`);
    }
    const normalizedEvidence = evidence.map((entry, evidenceIndex) => {
      const field = `items[${index}].evidence[${evidenceIndex}]`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Invalid ${field}`);
      if (entry.metadata !== undefined && (!entry.metadata || typeof entry.metadata !== "object" || Array.isArray(entry.metadata) ||
        Object.keys(entry.metadata).length > 20 || Object.entries(entry.metadata).some(([key, v]) =>
          key.length > 64 || !(v === null || typeof v === "string" && v.length <= 1_000 || typeof v === "number" && Number.isFinite(v) || typeof v === "boolean")))) {
        throw new Error(`Invalid bounded metadata for ${field}`);
      }
      return {
        evidenceType: text(entry.evidenceType, `${field}.evidenceType`, 64)!,
        sourcePath: text(entry.sourcePath, `${field}.sourcePath`, 1_000, true),
        sourceHash: text(entry.sourceHash, `${field}.sourceHash`, 256, true),
        commitSha: text(entry.commitSha, `${field}.commitSha`, 128, true),
        sourceSymbol: text(entry.sourceSymbol, `${field}.sourceSymbol`, 500, true),
        testCommand: text(entry.testCommand, `${field}.testCommand`, 1_000, true),
        testResult: text(entry.testResult, `${field}.testResult`, 1_000, true),
        actor: text(entry.actor, `${field}.actor`, 200, true),
        metadata: entry.metadata ?? {},
      };
    });
    return {
      title, content, type, epistemicState: raw.epistemicState,
      summary: text(raw.summary, `items[${index}].summary`, 1_000, true) ?? "",
      confidence: raw.confidence,
      confidenceReason,
      tags, aliases, fragments: normalizedFragments, evidence: normalizedEvidence,
    };
  });
  return { idempotencyKey, items, actor, origin };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

function stableHash(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value));
  if (serialized === undefined) throw new Error("Memory capture payload could not be serialized deterministically");
  return createHash("sha256").update(serialized).digest("hex");
}

function newId(prefix: string): string {
  return `${prefix}:${randomUUID()}`;
}

function normalizeEvidencePath(rootPath: string, sourcePath: string | undefined): string | null {
  if (sourcePath === undefined) return null;
  const normalized = sourcePath.replaceAll("\\", "/");
  if (normalized.includes("\0") || normalized.startsWith("/") || normalized.startsWith("\\") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error("Memory evidence sourcePath must be project-relative");
  }
  const absolutePath = resolve(rootPath, normalized);
  const relativePath = relative(rootPath, absolutePath);
  if (relativePath === ".." || relativePath.startsWith(".." + sep) || isAbsolute(relativePath)) {
    throw new Error("Memory evidence sourcePath must stay inside the project root");
  }
  return normalized;
}
/**
 * Capture small, explicitly supplied knowledge units into the versioned store.
 * Exact normalized-title matches are conservative: equal content is a duplicate;
 * different content is surfaced as a conflict and is never auto-merged.
 */
export function captureMemories(location: ProjectLocation, rawInput: MemoryCaptureInput): MemoryCaptureResult {
  const input = validateInput(rawInput);
  const requestHash = stableHash({ ...input, idempotencyKey: undefined });
  const db = openDatabase(location);
  try {
    const transaction = db.transaction((): MemoryCaptureResult => {
      const prior = db.prepare(`
        SELECT request_hash AS requestHash, result_json AS resultJson
        FROM memory_idempotency
        WHERE project_id = ? AND operation = 'memory_capture' AND idempotency_key = ?
      `).get(location.id, input.idempotencyKey) as { requestHash: string; resultJson: string } | undefined;
      if (prior) {
        if (prior.requestHash !== requestHash) throw new Error("Idempotency key was already used with a different memory capture payload");
        return { ...(JSON.parse(prior.resultJson) as MemoryCaptureResult), idempotentReplay: true };
      }

      const outcomes: MemoryCaptureOutcome[] = [];
      for (const [inputIndex, item] of input.items.entries()) {
        const candidates = db.prepare(`
          SELECT i.id, v.id AS versionId, v.title, v.summary, i.tags_json, i.aliases_json
          FROM knowledge_items i
          JOIN knowledge_versions v ON v.id = i.current_version_id AND v.knowledge_id = i.id
          WHERE i.project_id = ? AND i.knowledge_type = ? AND i.lifecycle = 'active'
          ORDER BY i.created_at, i.id
        `).all(location.id, item.type) as Array<{
          id: string; versionId: string; title: string; summary: string; tags_json: string; aliases_json: string;
        }>;
        const candidate = candidates.find((row) =>
          normalize(row.title) === normalize(item.title) ||
          (JSON.parse(row.aliases_json) as string[]).some((alias) => normalize(alias) === normalize(item.title)) ||
          item.aliases.some((alias) => normalize(alias) === normalize(row.title)));
        if (candidate) {
          const storedFragments = db.prepare(`
            SELECT heading, summary, content FROM knowledge_fragments
            WHERE version_id = ? ORDER BY ordinal
          `).all(candidate.versionId) as Array<{ heading: string; summary: string; content: string }>;
          const expectedFragments = [
            { heading: "", summary: item.summary ?? "", content: item.content },
            ...(item.fragments ?? []).map((fragment) => ({
              heading: fragment.heading ?? "", summary: fragment.summary ?? "", content: fragment.content,
            })),
          ];
          const storedEvidence = db.prepare(`
            SELECT evidence_type AS evidenceType, source_path AS sourcePath, source_hash AS sourceHash,
                   commit_sha AS commitSha, source_symbol AS sourceSymbol, test_command AS testCommand,
                   test_result AS testResult, actor, metadata_json AS metadataJson
            FROM knowledge_evidence WHERE version_id = ? ORDER BY id
          `).all(candidate.versionId) as Array<{
            evidenceType: string; sourcePath: string | null; sourceHash: string | null;
            commitSha: string | null; sourceSymbol: string | null; testCommand: string | null;
            testResult: string | null; actor: string | null; metadataJson: string;
          }>;
          const expectedEvidence = (item.evidence ?? []).map((evidence) => ({
            evidenceType: evidence.evidenceType,
            sourcePath: normalizeEvidencePath(location.rootPath, evidence.sourcePath),
            sourceHash: evidence.sourceHash ?? null,
            commitSha: evidence.commitSha ?? null,
            sourceSymbol: evidence.sourceSymbol ?? null,
            testCommand: evidence.testCommand ?? null,
            testResult: evidence.testResult ?? null,
            actor: evidence.actor ?? input.actor ?? null,
            metadataJson: JSON.stringify(canonicalize(evidence.metadata ?? {})),
          })).sort((left, right) => stableHash(left).localeCompare(stableHash(right)));
          const normalizedStoredEvidence = storedEvidence.map((evidence) => ({
            evidenceType: evidence.evidenceType, sourcePath: evidence.sourcePath,
            sourceHash: evidence.sourceHash, commitSha: evidence.commitSha,
            sourceSymbol: evidence.sourceSymbol, testCommand: evidence.testCommand,
            testResult: evidence.testResult, actor: evidence.actor,
            metadataJson: JSON.stringify(canonicalize(JSON.parse(evidence.metadataJson))),
          })).sort((left, right) => stableHash(left).localeCompare(stableHash(right)));
          const sameContent = normalize(candidate.summary) === normalize(item.summary) &&
            stableHash(storedFragments.map((fragment) => ({
              heading: normalize(fragment.heading), summary: normalize(fragment.summary), content: normalize(fragment.content),
            }))) === stableHash(expectedFragments.map((fragment) => ({
              heading: normalize(fragment.heading), summary: normalize(fragment.summary), content: normalize(fragment.content),
            }))) &&
            stableHash(JSON.parse(candidate.tags_json).map(normalize).sort()) === stableHash(item.tags.map(normalize).sort()) &&
            stableHash(JSON.parse(candidate.aliases_json).map(normalize).sort()) === stableHash(item.aliases.map(normalize).sort()) &&
            stableHash(normalizedStoredEvidence) === stableHash(expectedEvidence);
          outcomes.push({
            inputIndex,
            operation: sameContent ? "duplicate" : "conflict",
            knowledgeId: candidate.id,
            reason: sameContent
              ? "An active knowledge item with the same normalized identity and content already exists."
              : "An active knowledge item has the same normalized identity but different content; no automatic merge was performed.",
          });
          continue;
        }

        const knowledgeId = newId("knowledge");
        const versionId = newId("version");
        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO knowledge_items
            (id, project_id, knowledge_type, lifecycle, current_version_id, tags_json, aliases_json, created_at, updated_at)
          VALUES (?, ?, ?, 'active', NULL, ?, ?, ?, ?)
        `).run(knowledgeId, location.id, item.type, JSON.stringify(item.tags), JSON.stringify(item.aliases), now, now);
        db.prepare(`
          INSERT INTO knowledge_versions
            (id, knowledge_id, version_number, epistemic_state, confidence, confidence_reason,
             title, summary, created_by, change_reason, created_at)
          VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 'Captured through memory_capture', ?)
        `).run(versionId, knowledgeId, item.epistemicState, item.confidence ?? null,
          item.confidenceReason ?? null, item.title, item.summary, input.actor ?? null, now);
        const insertFragment = db.prepare(`
          INSERT INTO knowledge_fragments(id, version_id, ordinal, heading, summary, content)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        const persistedFragments = [{ heading: "", summary: item.summary ?? "", content: item.content }, ...(item.fragments ?? [])];
        for (const [ordinal, fragment] of persistedFragments.entries()) {
          insertFragment.run(newId("fragment"), versionId, ordinal, fragment.heading ?? "",
            fragment.summary ?? "", fragment.content);
        }
        const insertEvidence = db.prepare(`
          INSERT INTO knowledge_evidence
            (id, version_id, evidence_type, source_path, source_hash, commit_sha, source_symbol,
             test_command, test_result, actor, metadata_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const evidence of item.evidence ?? []) {
          insertEvidence.run(newId("evidence"), versionId, evidence.evidenceType,
            normalizeEvidencePath(location.rootPath, evidence.sourcePath), evidence.sourceHash ?? null, evidence.commitSha ?? null,
            evidence.sourceSymbol ?? null, evidence.testCommand ?? null, evidence.testResult ?? null,
            evidence.actor ?? input.actor ?? null, JSON.stringify(evidence.metadata ?? {}), now);
        }
        db.prepare("UPDATE knowledge_items SET current_version_id = ? WHERE id = ?")
          .run(versionId, knowledgeId);
        db.prepare(`
          INSERT INTO knowledge_events
            (id, project_id, knowledge_id, version_id, event_type, actor, reason, payload_json, created_at)
          VALUES (?, ?, ?, ?, 'captured', ?, ?, ?, ?)
        `).run(newId("event"), location.id, knowledgeId, versionId, input.actor ?? null,
          "Captured through memory_capture", JSON.stringify({ origin: input.origin ?? null, inputIndex }), now);
        outcomes.push({
          inputIndex, operation: "created", knowledgeId,
          reason: "No active item with the same normalized identity was found; a new versioned knowledge item was created.",
        });
      }
      const result: MemoryCaptureResult = {
        idempotentReplay: false,
        outcomes,
        created: outcomes.filter((outcome) => outcome.operation === "created").length,
        duplicates: outcomes.filter((outcome) => outcome.operation === "duplicate").length,
        conflicts: outcomes.filter((outcome) => outcome.operation === "conflict").length,
      };
      db.prepare(`
        INSERT INTO memory_idempotency(project_id, operation, idempotency_key, request_hash, result_json, created_at)
        VALUES (?, 'memory_capture', ?, ?, ?, ?)
      `).run(location.id, input.idempotencyKey, requestHash, JSON.stringify(result), new Date().toISOString());
      return result;
    });
    return transaction();
  } finally {
    db.close();
  }
}
