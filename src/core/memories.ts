import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { openDatabase } from "../storage/database.js";
import type { ProjectLocation } from "./project.js";
import { compareGitCommits, getGitSnapshot, type GitCommitRelationship } from "./git.js";
import { readFileWithinRoot } from "./safe-file.js";

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}


export type MemoryStatus = "proposed" | "confirmed" | "obsolete" | "rejected";

export interface MemoryRecord {
  id: string;
  category: string;
  title: string;
  content: string;
  status: MemoryStatus;
  sourcePath: string | null;
  commitSha: string | null;
  sourceHash: string | null;
  author: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryUpdate {
  category?: string;
  title?: string;
  content?: string;
  sourcePath?: string | null;
  commitSha?: string | null;
  author?: string | null;
}


function sourceFingerprint(location: ProjectLocation, sourcePath: string | null | undefined): string | null {
  if (sourcePath == null) return null;
  const normalized = sourcePath.replaceAll("\\", "/");
  if (isAbsolute(normalized)) throw new Error("Memory source path must be relative to the project root");
  const absolutePath = resolve(location.rootPath, normalized);
  const relativePath = relative(location.rootPath, absolutePath);
  if (relativePath === ".." || relativePath.startsWith(".." + sep) || isAbsolute(relativePath)) {
    throw new Error("Memory source path must stay inside the project root");
  }
  try {
    const source = readFileWithinRoot(location.rootPath, absolutePath, { rejectFinalSymlink: true });
    return createHash("sha256").update(source.content).digest("hex");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    if (error instanceof Error && error.message === "File path resolves outside the project root.") {
      throw new Error("Memory source path must resolve inside the project root");
    }
    if (error instanceof Error && (
      error.message === "Path must reference a regular file." ||
      error.message === "Symlink file paths are not allowed." ||
      error.message.includes("ELOOP") ||
      error.message.includes("changed during safe open") ||
      error.message.includes("changed while being read")
    )) {
      throw new Error("Memory source path must reference a file");
    }
    throw new Error("Memory source path could not be safely verified");

  }
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Memory ${field} must not be empty`);
  return normalized;
}

function createMemory(
  location: ProjectLocation,
  title: string,
  content: string,
  category: string,
  status: "proposed" | "confirmed",
  sourcePath?: string,
  commitSha?: string,
  author?: string,
): string {
  const normalizedTitle = requireText(title, "title");
  const normalizedContent = requireText(content, "content");
  const normalizedCategory = requireText(category, "category");
  const normalizedSource = sourcePath === undefined ? null : requireText(sourcePath, "source path");
  const normalizedCommit = commitSha === undefined ? null : requireText(commitSha, "commit reference");
  const normalizedAuthor = author === undefined ? null : requireText(author, "author");
  const db = openDatabase(location);
  try {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO memories(id, category, title, content, status, source_path, commit_sha, source_hash, author, updated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, normalizedCategory, normalizedTitle, normalizedContent, status, normalizedSource, normalizedCommit, sourceFingerprint(location, normalizedSource), normalizedAuthor, normalizedAuthor, now, now);
    return id;
  } finally {
    db.close();
  }
}

/** Save knowledge explicitly confirmed by the person invoking this operation. */
export function remember(
  location: ProjectLocation,
  title: string,
  content: string,
  category = "decision",
  sourcePath?: string,
  commitSha?: string,
  author?: string,
): string {
  return createMemory(location, title, content, category, "confirmed", sourcePath, commitSha, author);
}

/** Save a suggestion without treating it as confirmed knowledge. */
export function proposeMemory(
  location: ProjectLocation,
  title: string,
  content: string,
  category = "decision",
  sourcePath?: string,
  commitSha?: string,
  author?: string,
): string {
  return createMemory(location, title, content, category, "proposed", sourcePath, commitSha, author);
}

/** Update only explicitly supplied fields. Returns false when the ID is not in this project. */
export function updateMemory(location: ProjectLocation, id: string, patch: MemoryUpdate): boolean {
  const fields: string[] = [];
  const values: Array<string | null> = [];
  if (patch.category !== undefined) { fields.push("category = ?"); values.push(requireText(patch.category, "category")); }
  if (patch.title !== undefined) { fields.push("title = ?"); values.push(requireText(patch.title, "title")); }
  if (patch.content !== undefined) { fields.push("content = ?"); values.push(requireText(patch.content, "content")); }
  if (patch.sourcePath !== undefined) {
    const normalizedSource = patch.sourcePath === null ? null : requireText(patch.sourcePath, "source path");
    fields.push("source_path = ?");
    values.push(normalizedSource);
    fields.push("source_hash = ?");
    values.push(sourceFingerprint(location, normalizedSource));
  }
  if (patch.commitSha !== undefined) {
    fields.push("commit_sha = ?");
    values.push(patch.commitSha === null ? null : requireText(patch.commitSha, "commit reference"));
  }
  if (patch.author !== undefined) {
    fields.push("updated_by = ?");
    values.push(patch.author === null ? null : requireText(patch.author, "author"));
  }
  if (fields.length === 0) throw new Error("At least one memory field must be supplied for update");
  fields.push("updated_at = ?");
  values.push(new Date().toISOString());
  values.push(id);
  const db = openDatabase(location);
  try {
    return db.prepare(`UPDATE memories SET ${fields.join(", ")} WHERE id = ?`).run(...values).changes > 0;
  } finally {
    db.close();
  }
}

const allowedTransitions: Record<MemoryStatus, readonly MemoryStatus[]> = {
  proposed: ["confirmed", "rejected"],
  confirmed: ["obsolete"],
  obsolete: ["confirmed"],
  rejected: [],
};

/** Apply an explicit lifecycle transition. Rejected suggestions are terminal. */
export function transitionMemory(location: ProjectLocation, id: string, nextStatus: MemoryStatus): boolean {
  if (!["proposed", "confirmed", "obsolete", "rejected"].includes(nextStatus)) {
    throw new Error(`Unsupported memory status: ${String(nextStatus)}`);
  }
  const db = openDatabase(location);
  try {
    const current = db.prepare("SELECT status FROM memories WHERE id = ?").get(id) as { status: MemoryStatus } | undefined;
    if (!current) return false;
    if (!allowedTransitions[current.status]?.includes(nextStatus)) {
      throw new Error(`Invalid memory status transition: ${current.status} -> ${nextStatus}`);
    }
    return db.prepare("UPDATE memories SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
      .run(nextStatus, new Date().toISOString(), id, current.status).changes > 0;
  } finally {
    db.close();
  }
}

/** Delete a memory only from the selected project's database. */
export function deleteMemory(location: ProjectLocation, id: string): boolean {
  const db = openDatabase(location);
  try {
    return db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes > 0;
  } finally {
    db.close();
  }
}

export interface MemorySourceFreshness {
  id: string;
  title: string;
  sourcePath: string | null;
  status: "not-linked" | "current" | "changed" | "missing" | "untracked" | "unsafe";
  requiresReview: boolean;
  commitSha: string | null;
  commitStatus: GitCommitRelationship;
  commitRequiresReview: boolean;
}

/** Inspect source and Git provenance without changing memory content or lifecycle status. */
export function inspectMemoryFreshness(location: ProjectLocation, limit?: number): MemorySourceFreshness[] {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)) {
    throw new Error("Memory freshness limit must be a positive safe integer no greater than 500");
  }
  const db = openDatabase(location);
  try {
    const sql = "SELECT id, title, source_path AS sourcePath, source_hash AS sourceHash, commit_sha AS commitSha FROM memories WHERE status != 'rejected' AND (source_path IS NOT NULL OR commit_sha IS NOT NULL) ORDER BY updated_at DESC, id" +
      (limit === undefined ? "" : " LIMIT ?");
    const rows = (limit === undefined ? db.prepare(sql).all() : db.prepare(sql).all(limit)) as Array<{
      id: string; title: string; sourcePath: string | null; sourceHash: string | null; commitSha: string | null;
    }>;
    const git = getGitSnapshot(location.rootPath);
    return rows.map((row) => {
      const commitStatus = compareGitCommits(location.rootPath, row.commitSha, git.available ? git.commit : null);
      const commitRequiresReview = commitStatus !== "not-referenced" && commitStatus !== "current";
      const base = {
        id: row.id,
        title: row.title,
        sourcePath: row.sourcePath,
        commitSha: row.commitSha,
        commitStatus,
        commitRequiresReview,
      };
      if (row.sourcePath === null) {
        return { ...base, status: "not-linked", requiresReview: commitRequiresReview };
      }

      let currentHash: string | null;
      try {
        currentHash = sourceFingerprint(location, row.sourcePath);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Memory source path")) {
          return { ...base, status: "unsafe", requiresReview: true };
        }
        throw error;
      }
      if (currentHash === null) return { ...base, status: "missing", requiresReview: true };
      if (row.sourceHash === null) return { ...base, status: "untracked", requiresReview: true };
      const status = currentHash === row.sourceHash ? "current" : "changed";
      return { ...base, status, requiresReview: status === "changed" || commitRequiresReview };
    });
  } finally {
    db.close();
  }
}

export interface MemoryFreshnessReport {
  records: MemorySourceFreshness[];
  total: number;
  limit: number;
  truncated: boolean;
}

/** Bounded MCP-facing view; the CLI's legacy inspection remains complete. */
export function getMemoryFreshnessReport(location: ProjectLocation, limit = 100): MemoryFreshnessReport {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Memory freshness limit must be a positive safe integer no greater than 500");
  }
  const db = openDatabase(location);
  let total: number;
  try {
    total = (db.prepare("SELECT COUNT(*) AS count FROM memories WHERE status != 'rejected' AND (source_path IS NOT NULL OR commit_sha IS NOT NULL)").get() as { count: number }).count;
  } finally {
    db.close();
  }
  const records = inspectMemoryFreshness(location, limit);
  return { records, total, limit, truncated: total > records.length };
}

export interface MemoryRecallOptions {
  statuses?: MemoryStatus[];
  category?: string;
  list?: boolean;
}

function normalizeMemoryText(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, " ").trim();
}

const MEMORY_QUERY_STOP_WORDS = new Set([
  "a", "al", "algo", "como", "con", "de", "del", "el", "en", "es", "esta", "este",
  "la", "las", "lo", "los", "mas", "o", "para", "por", "que", "se", "sin", "su",
  "un", "una", "uno", "y", "how", "does", "the", "what", "when", "where", "why", "is", "are", "of", "to", "and", "this", "that", "with", "from", "about",
]);

function memoryMatchScore(row: MemoryRecord, query: string, tokens: string[]): number {
  const title = normalizeMemoryText(row.title);
  const content = normalizeMemoryText(row.content);
  const category = normalizeMemoryText(row.category);
  const combined = `${title} ${content} ${category}`;
  if (!tokens.some((token) => combined.includes(token))) return 0;
  let score = 0;
  if (title.includes(query)) score += 12;
  if (content.includes(query)) score += 5;
  for (const token of tokens) {
    if (title.split(" ").some((word) => word === token)) score += 5;
    else if (title.split(" ").some((word) => word.startsWith(token))) score += 3;
    else if (title.includes(token)) score += 2;
    if (content.split(" ").some((word) => word === token)) score += 2;
    else if (content.includes(token)) score += 1;
    if (category.includes(token)) score += 1;
  }
  if (row.status === "confirmed") score += 0.5;
  return score;
}

/** Retrieve project memories by natural-language lexical relevance and lifecycle filters.
 * Proposed entries are discoverable by default but remain explicitly unconfirmed. */
export function recallMemories(
  location: ProjectLocation,
  query = "",
  limit = 20,
  options: MemoryRecallOptions = {},
): MemoryRecord[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Memory limit must be a positive safe integer no greater than 500");
  }
  const db = openDatabase(location);
  try {
    const includeRejected = options.statuses?.includes("rejected") ?? false;
    const rows = db.prepare(`SELECT id, category, title, content, status, source_path AS sourcePath,
      commit_sha AS commitSha, source_hash AS sourceHash, author, updated_by AS updatedBy,
      created_at AS createdAt, updated_at AS updatedAt FROM memories
      ${includeRejected ? "" : "WHERE status != 'rejected'"} ORDER BY updated_at DESC, id LIMIT 5000`).all() as MemoryRecord[];
    const statuses = options.statuses ? new Set(options.statuses) : null;
    const category = options.category ? normalizeMemoryText(options.category) : null;
    const filtered = rows.filter((row) =>
      (!statuses || statuses.has(row.status)) &&
      (!category || normalizeMemoryText(row.category) === category),
    );
    const normalizedQuery = normalizeMemoryText(query);
    if (!normalizedQuery || options.list) return filtered.slice(0, limit);
    const tokens = [...new Set(normalizedQuery.split(" ").filter((token) =>
      token.length > 1 && !MEMORY_QUERY_STOP_WORDS.has(token)))];
    if (tokens.length === 0) return filtered.slice(0, limit);
    return filtered
      .map((row) => ({ row, score: memoryMatchScore(row, normalizedQuery, tokens) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score ||
        compareCodeUnits(right.row.updatedAt, left.row.updatedAt) ||
        compareCodeUnits(left.row.id, right.row.id))
      .slice(0, limit)
      .map((item) => item.row);
  } finally {
    db.close();
  }
}
