import { randomUUID } from "node:crypto";
import { openDatabase } from "../storage/database.js";
import type { ProjectLocation } from "./project.js";

export interface MemoryRecord {
  id: string;
  category: string;
  title: string;
  content: string;
  status: string;
  sourcePath: string | null;
  createdAt: string;
  updatedAt: string;
}

export function remember(location: ProjectLocation, title: string, content: string, category = "decision", sourcePath?: string): string {
  const db = openDatabase(location);
  try {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO memories(id, category, title, content, status, source_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'confirmed', ?, ?, ?)`)
      .run(id, category, title, content, sourcePath ?? null, now, now);
    return id;
  } finally {
    db.close();
  }
}

export function recallMemories(location: ProjectLocation, query = "", limit = 20): MemoryRecord[] {
  const db = openDatabase(location);
  try {
    const rows = query.trim()
      ? db.prepare(`SELECT id, category, title, content, status, source_path AS sourcePath,
          created_at AS createdAt, updated_at AS updatedAt FROM memories
          WHERE status != 'rejected' AND (title LIKE ? OR content LIKE ? OR category LIKE ?)
          ORDER BY updated_at DESC LIMIT ?`).all(`%${query}%`, `%${query}%`, `%${query}%`, limit)
      : db.prepare(`SELECT id, category, title, content, status, source_path AS sourcePath,
          created_at AS createdAt, updated_at AS updatedAt FROM memories
          WHERE status != 'rejected' ORDER BY updated_at DESC LIMIT ?`).all(limit);
    return rows as MemoryRecord[];
  } finally {
    db.close();
  }
}
