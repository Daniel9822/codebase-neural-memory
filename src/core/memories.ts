import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { openDatabase } from "../storage/database.js";
import type { ProjectLocation } from "./project.js";
import { compareGitCommits, getGitSnapshot, type GitCommitRelationship } from "./git.js";

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
  if (!existsSync(absolutePath)) return null;
  const canonicalRoot = realpathSync(location.rootPath);
  const canonicalPath = realpathSync(absolutePath);
  const canonicalRelative = relative(canonicalRoot, canonicalPath);
  if (canonicalRelative === ".." || canonicalRelative.startsWith(".." + sep) || isAbsolute(canonicalRelative)) {
    throw new Error("Memory source path must resolve inside the project root");
  }
  if (!statSync(canonicalPath).isFile()) throw new Error("Memory source path must reference a file");
  return createHash("sha256").update(readFileSync(canonicalPath)).digest("hex");
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
        if (error instanceof Error && (error.message === "Memory source path must resolve inside the project root" || error.message === "Memory source path must reference a file")) {
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

export function recallMemories(location: ProjectLocation, query = "", limit = 20): MemoryRecord[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Memory limit must be a positive safe integer no greater than 500");
  }
  const db = openDatabase(location);
  try {
    const rows = query.trim()
      ? db.prepare(`SELECT id, category, title, content, status, source_path AS sourcePath,
          commit_sha AS commitSha, source_hash AS sourceHash, author, updated_by AS updatedBy, created_at AS createdAt, updated_at AS updatedAt FROM memories
          WHERE status != 'rejected' AND (title LIKE ? OR content LIKE ? OR category LIKE ?)
          ORDER BY updated_at DESC, id LIMIT ?`).all(`%${query}%`, `%${query}%`, `%${query}%`, limit)
      : db.prepare(`SELECT id, category, title, content, status, source_path AS sourcePath,
          commit_sha AS commitSha, source_hash AS sourceHash, author, updated_by AS updatedBy, created_at AS createdAt, updated_at AS updatedAt FROM memories
          WHERE status != 'rejected' ORDER BY updated_at DESC, id LIMIT ?`).all(limit);
    return rows as MemoryRecord[];
  } finally {
    db.close();
  }
}
