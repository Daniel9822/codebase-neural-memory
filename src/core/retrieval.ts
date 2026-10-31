import { openDatabase } from "../storage/database.js";
import type { ProjectLocation } from "./project.js";
import type { SearchHit } from "../shared/types.js";

export function searchSymbols(location: ProjectLocation, query: string, limit = 20): SearchHit[] {
  const db = openDatabase(location);
  try {
    const tokens = query.match(/[\p{L}\p{N}_$]+/gu) ?? [];
    if (tokens.length === 0) return [];
    const ftsQuery = tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(" AND ");
    try {
      return db.prepare(`
        SELECT s.name, s.kind, s.signature, f.path AS filePath,
          s.start_line AS startLine, s.end_line AS endLine, s.exported AS exported
        FROM symbols_fts fts
        JOIN symbols s ON s.id = fts.rowid
        JOIN files f ON f.id = s.file_id
        WHERE symbols_fts MATCH ?
        ORDER BY s.exported DESC, s.name
        LIMIT ?
      `).all(ftsQuery, limit) as SearchHit[];
    } catch {
      const like = `%${tokens[0]}%`;
      return db.prepare(`
        SELECT s.name, s.kind, s.signature, f.path AS filePath,
          s.start_line AS startLine, s.end_line AS endLine, s.exported AS exported
        FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE s.name LIKE ? OR s.signature LIKE ?
        ORDER BY s.exported DESC, s.name LIMIT ?
      `).all(like, like, limit) as SearchHit[];
    }
  } finally {
    db.close();
  }
}

export interface ProjectOverview {
  name: string;
  rootPath: string;
  lastIndexedAt: string | null;
  files: number;
  symbols: number;
  relations: number;
}

export function getProjectOverview(location: ProjectLocation): ProjectOverview {
  const db = openDatabase(location);
  try {
    const project = db.prepare("SELECT name, root_path, last_indexed_at FROM projects WHERE id = ?").get(location.id) as {
      name: string; root_path: string; last_indexed_at: string | null;
    } | undefined;
    if (!project) throw new Error("This repository has not been initialized. Run `cnm init` first.");
    const count = (sql: string) => (db.prepare(sql).get() as { count: number }).count;
    return {
      name: project.name,
      rootPath: project.root_path,
      lastIndexedAt: project.last_indexed_at,
      files: count("SELECT COUNT(*) AS count FROM files"),
      symbols: count("SELECT COUNT(*) AS count FROM symbols"),
      relations: count("SELECT COUNT(*) AS count FROM relations"),
    };
  } finally {
    db.close();
  }
}

export function getProjectMap(location: ProjectLocation, limit = 80): Array<{ path: string; imports: string[] }> {
  const db = openDatabase(location);
  try {
    return db.prepare(`
      SELECT f.path AS path,
        COALESCE((SELECT json_group_array(target.path)
          FROM relations r JOIN files target ON r.target_kind = 'file' AND target.id = r.target_id
          WHERE r.source_kind = 'file' AND r.source_id = f.id AND r.kind = 'IMPORTS'), '[]') AS imports
      FROM files f ORDER BY f.path LIMIT ?
    `).all(limit).map((row: any) => ({ path: row.path as string, imports: JSON.parse(row.imports as string) as string[] }));
  } finally {
    db.close();
  }
}

export function explainSymbol(location: ProjectLocation, name: string): SearchHit[] {
  const db = openDatabase(location);
  try {
    return db.prepare(`
      SELECT s.name, s.kind, s.signature, f.path AS filePath,
        s.start_line AS startLine, s.end_line AS endLine, s.exported AS exported
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE s.name = ? OR s.name LIKE ?
      ORDER BY s.exported DESC LIMIT 20
    `).all(name, `%${name}%`) as SearchHit[];
  } finally {
    db.close();
  }
}

export function findImpact(location: ProjectLocation, targetPath: string): string[] {
  const db = openDatabase(location);
  try {
    const normalized = targetPath.replaceAll("\\", "/").replace(/^\.\//, "");
    const target = db.prepare("SELECT id FROM files WHERE path = ?").get(normalized) as { id: number } | undefined;
    if (!target) throw new Error(`File not found in memory index: ${normalized}. Run cnm index.`);
    const queue = [target.id];
    const visited = new Set<number>(queue);
    const affected: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const dependents = db.prepare(`
        SELECT source.id, source.path FROM relations r
        JOIN files source ON r.source_kind = 'file' AND source.id = r.source_id
        WHERE r.target_kind = 'file' AND r.target_id = ? AND r.kind = 'IMPORTS'
      `).all(current) as Array<{ id: number; path: string }>;
      for (const item of dependents) {
        if (visited.has(item.id)) continue;
        visited.add(item.id);
        affected.push(item.path);
        queue.push(item.id);
      }
    }
    return affected;
  } finally {
    db.close();
  }
}
