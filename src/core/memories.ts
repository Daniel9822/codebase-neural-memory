import { randomUUID } from "node:crypto";
import { openDatabase } from "../storage/database.js";
import type { ProjectLocation } from "./project.js";

export type MemoryStatus = "proposed" | "confirmed" | "obsolete" | "rejected";

export interface MemoryRecord {
  id: string;
  category: string;
  title: string;
  content: string;
  status: MemoryStatus;
  sourcePath: string | null;
  commitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryUpdate {
  category?: string;
  title?: string;
  content?: string;
  sourcePath?: string | null;
  commitSha?: string | null;
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
): string {
  const normalizedTitle = requireText(title, "title");
  const normalizedContent = requireText(content, "content");
  const normalizedCategory = requireText(category, "category");
  const normalizedSource = sourcePath === undefined ? null : requireText(sourcePath, "source path");
  const normalizedCommit = commitSha === undefined ? null : requireText(commitSha, "commit reference");
  const db = openDatabase(location);
  try {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO memories(id, category, title, content, status, source_path, commit_sha, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, normalizedCategory, normalizedTitle, normalizedContent, status, normalizedSource, normalizedCommit, now, now);
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
): string {
  return createMemory(location, title, content, category, "confirmed", sourcePath, commitSha);
}

/** Save a suggestion without treating it as confirmed knowledge. */
export function proposeMemory(
  location: ProjectLocation,
  title: string,
  content: string,
  category = "decision",
  sourcePath?: string,
  commitSha?: string,
): string {
  return createMemory(location, title, content, category, "proposed", sourcePath, commitSha);
}

/** Update only explicitly supplied fields. Returns false when the ID is not in this project. */
export function updateMemory(location: ProjectLocation, id: string, patch: MemoryUpdate): boolean {
  const fields: string[] = [];
  const values: Array<string | null> = [];
  if (patch.category !== undefined) { fields.push("category = ?"); values.push(requireText(patch.category, "category")); }
  if (patch.title !== undefined) { fields.push("title = ?"); values.push(requireText(patch.title, "title")); }
  if (patch.content !== undefined) { fields.push("content = ?"); values.push(requireText(patch.content, "content")); }
  if (patch.sourcePath !== undefined) {
    fields.push("source_path = ?");
    values.push(patch.sourcePath === null ? null : requireText(patch.sourcePath, "source path"));
  }
  if (patch.commitSha !== undefined) {
    fields.push("commit_sha = ?");
    values.push(patch.commitSha === null ? null : requireText(patch.commitSha, "commit reference"));
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

export function recallMemories(location: ProjectLocation, query = "", limit = 20): MemoryRecord[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Memory limit must be a positive safe integer no greater than 500");
  }
  const db = openDatabase(location);
  try {
    const rows = query.trim()
      ? db.prepare(`SELECT id, category, title, content, status, source_path AS sourcePath,
          commit_sha AS commitSha, created_at AS createdAt, updated_at AS updatedAt FROM memories
          WHERE status != 'rejected' AND (title LIKE ? OR content LIKE ? OR category LIKE ?)
          ORDER BY updated_at DESC, id LIMIT ?`).all(`%${query}%`, `%${query}%`, `%${query}%`, limit)
      : db.prepare(`SELECT id, category, title, content, status, source_path AS sourcePath,
          commit_sha AS commitSha, created_at AS createdAt, updated_at AS updatedAt FROM memories
          WHERE status != 'rejected' ORDER BY updated_at DESC, id LIMIT ?`).all(limit);
    return rows as MemoryRecord[];
  } finally {
    db.close();
  }
}
