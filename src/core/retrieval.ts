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

export function getProjectMap(location: ProjectLocation, limit = 80): Array<{ path: string; imports: string[]; unresolvedImports: Array<{ specifier: string; status: string; candidates: string[] }> }> {
  const db = openDatabase(location);
  try {
    return db.prepare(`
      SELECT f.path AS path,
        COALESCE((SELECT json_group_array(target.path)
          FROM relations r JOIN files target ON r.target_kind = 'file' AND target.id = r.target_id
          WHERE r.source_kind = 'file' AND r.source_id = f.id AND r.kind = 'IMPORTS'), '[]') AS imports,
        COALESCE((SELECT json_group_array(json_object(
          'specifier', u.module_specifier, 'status', u.status, 'candidates', json(u.candidates_json)
        )) FROM unresolved_imports u WHERE u.source_file_id = f.id), '[]') AS unresolvedImports
      FROM files f ORDER BY f.path LIMIT ?
    `).all(limit).map((row: any) => ({
      path: row.path as string,
      imports: JSON.parse(row.imports as string) as string[],
      unresolvedImports: JSON.parse(row.unresolvedImports as string) as Array<{ specifier: string; status: string; candidates: string[] }>,
    }));
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


export function findDependencies(location: ProjectLocation, targetPath: string, maxDepth = 1): string[] {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) {
    throw new Error("Dependency depth must be a positive safe integer.");
  }
  const db = openDatabase(location);
  try {
    const normalized = targetPath.replaceAll("\\", "/").replace(/^\.\//, "");
    const target = db.prepare("SELECT id FROM files WHERE path = ?").get(normalized) as { id: number } | undefined;
    if (!target) throw new Error(`File not found in memory index: ${normalized}. Run cnm index.`);

    const queue: Array<{ id: number; depth: number }> = [{ id: target.id, depth: 0 }];
    const visited = new Set<number>([target.id]);
    const dependencies: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) continue;
      const imports = db.prepare(`
        SELECT target.id, target.path FROM relations r
        JOIN files target ON r.target_kind = 'file' AND target.id = r.target_id
        WHERE r.source_kind = 'file' AND r.source_id = ? AND r.kind = 'IMPORTS'
        ORDER BY target.path
      `).all(current.id) as Array<{ id: number; path: string }>;
      for (const item of imports) {
        if (visited.has(item.id)) continue;
        visited.add(item.id);
        dependencies.push(item.path);
        queue.push({ id: item.id, depth: current.depth + 1 });
      }
    }
    return dependencies.sort((a, b) => a.localeCompare(b));
  } finally {
    db.close();
  }
}


export interface SymbolRelationHit {
  direction: "outgoing" | "incoming";
  relation: string;
  symbolName: string;
  symbolKind: string;
  symbolFilePath: string;
  symbolStartLine: number;
  symbolEndLine: number;
  relatedSymbolName: string;
  relatedSymbolKind: string;
  relatedFilePath: string;
  relatedStartLine: number;
  relatedEndLine: number;
  confidence: number;
  provenance: string;
}

export function getSymbolRelations(location: ProjectLocation, name: string, limit = 50): SymbolRelationHit[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("Relation limit must be a positive safe integer.");
  }
  const db = openDatabase(location);
  try {
    return db.prepare(`
      SELECT * FROM (
        SELECT
          'outgoing' AS direction,
          r.kind AS relation,
          source.name AS symbolName,
          source.kind AS symbolKind,
          source_file.path AS symbolFilePath,
          source.start_line AS symbolStartLine,
          source.end_line AS symbolEndLine,
          target.name AS relatedSymbolName,
          target.kind AS relatedSymbolKind,
          target_file.path AS relatedFilePath,
          target.start_line AS relatedStartLine,
          target.end_line AS relatedEndLine,
          r.confidence AS confidence,
          r.provenance AS provenance
        FROM symbols source
        JOIN files source_file ON source_file.id = source.file_id
        JOIN relations r ON r.source_kind = 'symbol' AND r.source_id = source.id
        JOIN symbols target ON r.target_kind = 'symbol' AND target.id = r.target_id
        JOIN files target_file ON target_file.id = target.file_id
        WHERE source.name = ?
        UNION ALL
        SELECT
          'incoming' AS direction,
          r.kind AS relation,
          target.name AS symbolName,
          target.kind AS symbolKind,
          target_file.path AS symbolFilePath,
          target.start_line AS symbolStartLine,
          target.end_line AS symbolEndLine,
          source.name AS relatedSymbolName,
          source.kind AS relatedSymbolKind,
          source_file.path AS relatedFilePath,
          source.start_line AS relatedStartLine,
          source.end_line AS relatedEndLine,
          r.confidence AS confidence,
          r.provenance AS provenance
        FROM symbols target
        JOIN files target_file ON target_file.id = target.file_id
        JOIN relations r ON r.target_kind = 'symbol' AND r.target_id = target.id
        JOIN symbols source ON r.source_kind = 'symbol' AND source.id = r.source_id
        JOIN files source_file ON source_file.id = source.file_id
        WHERE target.name = ?
      )
      ORDER BY symbolFilePath, direction, relation, relatedFilePath, relatedSymbolName
      LIMIT ?
    `).all(name, name, limit) as SymbolRelationHit[];
  } finally {
    db.close();
  }
}
