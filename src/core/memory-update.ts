import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { openDatabase } from "../storage/database.js";
import type { ProjectLocation } from "./project.js";
import type { KnowledgeEpistemicState, MemoryCaptureEvidence, MemoryCaptureFragment } from "./memory-capture.js";

export interface MemoryUpdateInput {
  knowledgeId: string;
  expectedVersionId: string;
  reason: string;
  actor?: string | undefined;
  title?: string | undefined;
  summary?: string | undefined;
  content?: string | undefined;
  epistemicState?: KnowledgeEpistemicState | undefined;
  confidence?: number | null | undefined;
  confidenceReason?: string | null | undefined;
  tags?: string[] | undefined;
  aliases?: string[] | undefined;
  fragments?: MemoryCaptureFragment[] | undefined;
  evidence?: MemoryCaptureEvidence[] | undefined;
}
export interface MemoryUpdateResult {
  status: "updated" | "conflict" | "no_op";
  knowledgeId: string;
  previousVersionId: string | null;
  currentVersionId: string | null;
  versionNumber?: number;
  reason: string;
}
const states = new Set(["observed","verified","inferred","user_asserted","planned","hypothesis","pending_validation"]);
const id = (prefix: string) => `${prefix}:${randomUUID()}`;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clean = (value: unknown, field: string, max: number, optional = false): string | undefined => {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string") throw new Error(`Invalid memory update ${field}`);
  const result = value.trim();
  if (!result && optional) return undefined;
  if (!result || result.length > max) throw new Error(`Invalid memory update ${field}`);
  return result;
};
function evidencePath(root: string, value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.replaceAll("\\", "/");
  if (normalized.includes("\0") || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) throw new Error("Evidence path must be project-relative");
  const rel = relative(root, resolve(root, normalized));
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) throw new Error("Evidence path escapes project root");
  return normalized;
}

/** Append a complete immutable version only if the caller's expected version is still current. */
export function updateMemoryVersion(location: ProjectLocation, input: MemoryUpdateInput): MemoryUpdateResult {
  const knowledgeId = clean(input.knowledgeId, "knowledgeId", 128)!;
  const expectedVersionId = clean(input.expectedVersionId, "expectedVersionId", 128)!;
  const reason = clean(input.reason, "reason", 1000)!;
  const actor = clean(input.actor, "actor", 200, true) ?? null;
  if (input.epistemicState !== undefined && !states.has(input.epistemicState)) throw new Error("Invalid epistemic state");
  if (input.confidence !== undefined && input.confidence !== null &&
    (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) throw new Error("Confidence must be between 0 and 1");
  if (input.confidenceReason !== undefined && input.confidence === undefined) throw new Error("confidenceReason can only change together with confidence");
  const confidenceReason = input.confidenceReason === null ? null : clean(input.confidenceReason, "confidenceReason", 500, true) ?? null;
  if (input.confidence !== undefined && input.confidence !== null && !confidenceReason) throw new Error("Confidence reason is required");
  const title = clean(input.title, "title", 240, true);
  const summary = clean(input.summary, "summary", 1000, true);
  const content = clean(input.content, "content", 20000, true);
  const tags = input.tags?.map((v) => clean(v, "tag", 64)!);
  const aliases = input.aliases?.map((v) => clean(v, "alias", 64)!);
  if ((tags && tags.length > 20) || (aliases && aliases.length > 20)) throw new Error("Tags and aliases are limited to 20 entries");
  for (const [name, values] of [["tags", tags], ["aliases", aliases]] as const) {
    if (values && new Set(values.map((value) => value.normalize("NFKC").toLocaleLowerCase("en"))).size !== values.length) {
      throw new Error(`Duplicate normalized ${name}`);
    }
  }
  if (input.evidence && input.evidence.length > 10) throw new Error("Evidence is limited to 10 entries");
  for (const [index, evidence] of (input.evidence ?? []).entries()) {
    clean(evidence.evidenceType, `evidence[${index}].evidenceType`, 64);
    clean(evidence.sourcePath, `evidence[${index}].sourcePath`, 1000, true);
    clean(evidence.sourceHash, `evidence[${index}].sourceHash`, 256, true);
    clean(evidence.commitSha, `evidence[${index}].commitSha`, 128, true);
    clean(evidence.sourceSymbol, `evidence[${index}].sourceSymbol`, 500, true);
    clean(evidence.testCommand, `evidence[${index}].testCommand`, 1000, true);
    clean(evidence.testResult, `evidence[${index}].testResult`, 1000, true);
    clean(evidence.actor, `evidence[${index}].actor`, 200, true);
    if (evidence.metadata && (Object.keys(evidence.metadata).length > 20 || Object.entries(evidence.metadata).some(([key, value]) =>
      key.length > 64 || !(value === null || typeof value === "string" && value.length <= 1000 ||
        typeof value === "number" && Number.isFinite(value) || typeof value === "boolean")))) {
      throw new Error(`Invalid bounded metadata for evidence[${index}]`);
    }
  }
  const fragments = input.fragments?.map((f) => ({
    heading: clean(f.heading, "fragment heading", 240, true) ?? "",
    summary: clean(f.summary, "fragment summary", 1000, true) ?? "",
    content: clean(f.content, "fragment content", 8000)!,
  }));
  if (fragments && (fragments.length < 1 || fragments.length > 20)) throw new Error("Fragments must contain 1–20 entries");
  const db = openDatabase(location);
  try {
    return db.transaction((): MemoryUpdateResult => {
      const item = db.prepare(`
        SELECT i.id, i.project_id, i.current_version_id, i.tags_json, i.aliases_json,
               v.version_number, v.epistemic_state, v.confidence, v.confidence_reason,
               v.title, v.summary
        FROM knowledge_items i JOIN knowledge_versions v
          ON v.id = i.current_version_id AND v.knowledge_id = i.id
        WHERE i.id = ? AND i.project_id = ?
      `).get(knowledgeId, location.id) as {
        id: string; project_id: string; current_version_id: string; tags_json: string; aliases_json: string;
        version_number: number; epistemic_state: KnowledgeEpistemicState; confidence: number | null;
        confidence_reason: string | null; title: string; summary: string;
      } | undefined;
      if (!item) throw new Error("Knowledge item not found in this project");
      if (item.current_version_id !== expectedVersionId) return {
        status: "conflict", knowledgeId, previousVersionId: expectedVersionId,
        currentVersionId: item.current_version_id,
        reason: "The current version changed; reload the item and retry against its latest version.",
      };
      const oldFragments = db.prepare("SELECT heading, summary, content FROM knowledge_fragments WHERE version_id = ? ORDER BY ordinal")
        .all(item.current_version_id) as Array<{heading:string;summary:string;content:string}>;
      const oldEvidence = db.prepare(`
        SELECT evidence_type AS evidenceType, source_path AS sourcePath, source_hash AS sourceHash,
          commit_sha AS commitSha, source_symbol AS sourceSymbol, test_command AS testCommand,
          test_result AS testResult, actor, metadata_json AS metadataJson
        FROM knowledge_evidence WHERE version_id = ? ORDER BY id
      `).all(item.current_version_id) as Array<Record<string, string | null>>;
      const next = {
        title: title ?? item.title, summary: summary ?? item.summary,
        epistemicState: input.epistemicState ?? item.epistemic_state,
        confidence: input.confidence === undefined ? item.confidence : input.confidence,
        confidenceReason: input.confidence === undefined ? item.confidence_reason : confidenceReason,
        tags: tags ?? JSON.parse(item.tags_json) as string[],
        aliases: aliases ?? JSON.parse(item.aliases_json) as string[],
        fragments: fragments ?? oldFragments,
        evidence: [...oldEvidence.map((e) => ({
          evidenceType:e.evidenceType, sourcePath:e.sourcePath, sourceHash:e.sourceHash,
          commitSha:e.commitSha, sourceSymbol:e.sourceSymbol, testCommand:e.testCommand,
          testResult:e.testResult, actor:e.actor, metadata:JSON.parse(e.metadataJson ?? "{}"),
        })), ...(input.evidence ?? []).map((e) => ({
          evidenceType: clean(e.evidenceType,"evidenceType",64)!,
          sourcePath: evidencePath(location.rootPath,e.sourcePath),
          sourceHash:e.sourceHash ?? null, commitSha:e.commitSha ?? null,
          sourceSymbol:e.sourceSymbol ?? null, testCommand:e.testCommand ?? null,
          testResult:e.testResult ?? null, actor:e.actor ?? actor,
          metadata:e.metadata ?? {},
        }))],
      };
      if (content !== undefined) {
        if (fragments === undefined) next.fragments = [{heading:"",summary:next.summary,content}];
        else next.fragments = [{heading:"",summary:next.summary,content}, ...fragments];
      }
      if (next.evidence.length > 20) throw new Error("A version may contain at most 20 evidence entries");
      const current = {
        title:item.title, summary:item.summary, epistemicState:item.epistemic_state,
        confidence:item.confidence, confidenceReason:item.confidence_reason,
        tags:JSON.parse(item.tags_json), aliases:JSON.parse(item.aliases_json),
        fragments:oldFragments,
        evidence:oldEvidence.map((e) => ({
          evidenceType:e.evidenceType,sourcePath:e.sourcePath,sourceHash:e.sourceHash,
          commitSha:e.commitSha,sourceSymbol:e.sourceSymbol,testCommand:e.testCommand,
          testResult:e.testResult,actor:e.actor,metadata:JSON.parse(e.metadataJson ?? "{}"),
        })),
      };
      if (hash(current) === hash(next)) return {
        status:"no_op",knowledgeId,previousVersionId:expectedVersionId,
        currentVersionId:expectedVersionId,versionNumber:item.version_number,
        reason:"No material fields changed; no version or event was created.",
      };
      const versionId = id("version");
      const now = new Date().toISOString();
      const versionNumber = item.version_number + 1;
      db.prepare(`
        INSERT INTO knowledge_versions
          (id,knowledge_id,version_number,epistemic_state,confidence,confidence_reason,title,summary,created_by,change_reason,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(versionId,knowledgeId,versionNumber,next.epistemicState,next.confidence,next.confidenceReason,
        next.title,next.summary,actor,reason,now);
      const insertFragment = db.prepare("INSERT INTO knowledge_fragments(id,version_id,ordinal,heading,summary,content) VALUES (?,?,?,?,?,?)");
      next.fragments.forEach((f,i)=>insertFragment.run(id("fragment"),versionId,i,f.heading,f.summary,f.content));
      const insertEvidence = db.prepare(`
        INSERT INTO knowledge_evidence
          (id,version_id,evidence_type,source_path,source_hash,commit_sha,source_symbol,test_command,test_result,actor,metadata_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      next.evidence.forEach((e)=>insertEvidence.run(id("evidence"),versionId,e.evidenceType,
        e.sourcePath,e.sourceHash,e.commitSha,e.sourceSymbol,e.testCommand,e.testResult,e.actor,
        JSON.stringify(e.metadata),now));
      const changed = db.prepare(`
        UPDATE knowledge_items SET current_version_id=?,tags_json=?,aliases_json=?,updated_at=?
        WHERE id=? AND project_id=? AND current_version_id=?
      `).run(versionId,JSON.stringify(next.tags),JSON.stringify(next.aliases),now,knowledgeId,location.id,expectedVersionId);
      if (changed.changes !== 1) throw new Error("Concurrent memory update detected; no changes were committed");
      db.prepare(`
        INSERT INTO knowledge_events(id,project_id,knowledge_id,version_id,event_type,actor,reason,payload_json,created_at)
        VALUES (?,?,?,?, 'updated',?,?,?,?)
      `).run(id("event"),location.id,knowledgeId,versionId,actor,reason,
        JSON.stringify({previousVersionId:expectedVersionId,versionNumber}),now);
      return {status:"updated",knowledgeId,previousVersionId:expectedVersionId,currentVersionId:versionId,
        versionNumber,reason:"A new immutable version was appended and made current."};
    }).immediate();
  } finally { db.close(); }
}
