import { openDatabase } from "../storage/database.js";
import type { ProjectLocation } from "./project.js";
import type { SearchHit } from "../shared/types.js";

const DEFAULT_DEPENDENCY_RESULTS = 100;
const DEFAULT_DEPENDENCY_PROCESSED = 1_000;
const MAX_SEARCH_CANDIDATES = 1_000;
const MAX_SEARCH_RESULTS = 1_000;
const MAX_DEPENDENCY_RESULTS = 5_000;
const MAX_DEPENDENCY_PROCESSED = 10_000;
const MAX_DEPENDENCY_DEPTH = 100;

interface RankedSearchHit extends SearchHit {
  score: number;
  rankingSignals: string[];
  searchMethod: "fts5" | "like-fallback";
}

function tokenizeQuery(query: string): string[] {
  return [...new Set(query.match(/[\p{L}\p{N}_$]+/gu) ?? [])];
}

function isFtsUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /no such module:\s*fts5|fts5:\s*(?:syntax error|unknown special query)|malformed MATCH expression/i.test(error.message);
}

function rankSearchCandidates(
  rows: Array<SearchHit & { ftsRank?: number }>,
  tokens: string[],
  limit: number,
): RankedSearchHit[] {
  const normalizedTokens = tokens.map((token) => token.toLocaleLowerCase());
  return rows.map((row) => {
    const name = row.name.toLocaleLowerCase();
    const signature = row.signature.toLocaleLowerCase();
    const nameTokens = normalizedTokens.filter((token) => name.includes(token));
    const signatureTokens = normalizedTokens.filter((token) => signature.includes(token));
    const signals: string[] = [];
    let score = 0;
    if (normalizedTokens.length === 1 && name === normalizedTokens[0]) {
      score += 100;
      signals.push("exact-name");
    }
    if (normalizedTokens.every((token) => name.startsWith(token) || name.includes(token))) {
      score += 45;
      signals.push("all-query-terms-in-name");
    }
    if (nameTokens.length > 0) {
      score += 15 * nameTokens.length;
      signals.push("name-term-coverage");
    }
    if (signatureTokens.length > 0) {
      score += 5 * signatureTokens.length;
      signals.push("signature-term-coverage");
    }
    if (row.exported) {
      score += 3;
      signals.push("exported-symbol");
    }
    if (row.ftsRank !== undefined) {
      // FTS5 bm25 values are lower for better matches; use its rank only as a
      // small tie-break signal so lexical relevance remains explainable.
      const rankBonus = Number.isFinite(row.ftsRank) ? Math.max(0, Math.min(2, -Number(row.ftsRank))) : 0;
      score += rankBonus;
      signals.push("fts5-bm25");
    } else {
      signals.push("like-fallback");
    }
    return { ...row, score, rankingSignals: signals, searchMethod: row.ftsRank === undefined ? "like-fallback" : "fts5" };
  }).sort((a, b) =>
    b.score - a.score ||
    a.filePath.localeCompare(b.filePath) ||
    a.startLine - b.startLine ||
    a.name.localeCompare(b.name) ||
    a.kind.localeCompare(b.kind),
  ).slice(0, limit);
}

export function searchSymbols(location: ProjectLocation, query: string, limit = 20): RankedSearchHit[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEARCH_RESULTS) {
    throw new Error("Search limit must be a positive safe integer no greater than 1000.");
  }
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];
  const db = openDatabase(location);
  try {
    const candidateLimit = Math.min(MAX_SEARCH_CANDIDATES, Math.max(limit, limit * 20));
    const ftsQuery = tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(" OR ");
    try {
      const rows = db.prepare(`
        SELECT s.name, s.kind, s.signature, f.path AS filePath,
          s.start_line AS startLine, s.end_line AS endLine, s.exported AS exported,
          bm25(symbols_fts) AS ftsRank
        FROM symbols_fts
        JOIN symbols s ON s.id = symbols_fts.rowid
        JOIN files f ON f.id = s.file_id
        WHERE symbols_fts MATCH ?
        ORDER BY ftsRank, f.path, s.start_line, s.name
        LIMIT ?
      `).all(ftsQuery, candidateLimit) as Array<SearchHit & { ftsRank: number }>;
      const fallbackParameters = tokens.flatMap((token) => [`%${token}%`, `%${token}%`]);
      const fallbackRows = db.prepare(`
        SELECT s.name, s.kind, s.signature, f.path AS filePath,
          s.start_line AS startLine, s.end_line AS endLine, s.exported AS exported
        FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE ${tokens.map(() => "(s.name LIKE ? OR s.signature LIKE ?)").join(" OR ")}
        ORDER BY f.path, s.start_line, s.name
        LIMIT ?
      `).all(...fallbackParameters, candidateLimit) as SearchHit[];
      const combined = new Map<string, SearchHit & { ftsRank?: number }>();
      for (const row of rows) combined.set(`${row.filePath}:${row.startLine}:${row.name}:${row.kind}`, row);
      for (const row of fallbackRows) {
        const key = `${row.filePath}:${row.startLine}:${row.name}:${row.kind}`;
        if (!combined.has(key)) combined.set(key, row);
      }
      return rankSearchCandidates([...combined.values()], tokens, limit);
    } catch (error) {
      if (!isFtsUnavailable(error)) throw error;
      const parameters = tokens.flatMap((token) => [`%${token}%`, `%${token}%`]);
      const rows = db.prepare(`
        SELECT s.name, s.kind, s.signature, f.path AS filePath,
          s.start_line AS startLine, s.end_line AS endLine, s.exported AS exported
        FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE ${tokens.map(() => "(s.name LIKE ? OR s.signature LIKE ?)").join(" OR ")}
        ORDER BY f.path, s.start_line, s.name
        LIMIT ?
      `).all(...parameters, candidateLimit) as SearchHit[];
      return rankSearchCandidates(rows.map((row) => ({ ...row })), tokens, limit);
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
  indexRevision: number;
}

export function getProjectOverview(location: ProjectLocation): ProjectOverview {
  const db = openDatabase(location);
  try {
    const project = db.prepare("SELECT name, root_path, last_indexed_at, index_revision FROM projects WHERE id = ?").get(location.id) as {
      name: string; root_path: string; last_indexed_at: string | null; index_revision: number;
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
      indexRevision: project.index_revision,
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
      ORDER BY s.exported DESC, f.path, s.start_line LIMIT 20
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
        ORDER BY source.path
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

export interface DependencyEvidence {
  relation: "IMPORTS";
  provenance: string;
  confidence: number;
  indexRevision: number;
}

export interface DependencyHit {
  path: string;
  depth: number;
  chain: string[];
  evidence: DependencyEvidence;
}

export interface DependencyResult {
  file: string;
  maxDepth: number;
  dependencies: DependencyHit[];
  truncated: boolean;
  processedFiles: number;
  processedRelations: number;
  limits: { maxResults: number; maxProcessed: number };
}

export function findDependencies(
  location: ProjectLocation,
  targetPath: string,
  maxDepth = 1,
  maxResults = DEFAULT_DEPENDENCY_RESULTS,
  maxProcessed = DEFAULT_DEPENDENCY_PROCESSED,
): DependencyResult {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > MAX_DEPENDENCY_DEPTH) {
    throw new Error("Dependency depth must be a positive safe integer no greater than 100.");
  }
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > MAX_DEPENDENCY_RESULTS) {
    throw new Error("Dependency result limit must be a positive safe integer no greater than 5000.");
  }
  if (!Number.isSafeInteger(maxProcessed) || maxProcessed < 1 || maxProcessed > MAX_DEPENDENCY_PROCESSED) {
    throw new Error("Dependency processing limit must be a positive safe integer no greater than 10000.");
  }
  const db = openDatabase(location);
  try {
    const normalized = targetPath.replaceAll("\\", "/").replace(/^\.\//, "");
    const target = db.prepare("SELECT id FROM files WHERE path = ?").get(normalized) as { id: number } | undefined;
    if (!target) throw new Error(`File not found in memory index: ${normalized}. Run cnm index.`);

    const queue: Array<{ id: number; path: string; depth: number; chain: string[] }> = [
      { id: target.id, path: normalized, depth: 0, chain: [normalized] },
    ];
    const visited = new Set<number>([target.id]);
    const dependencies: DependencyHit[] = [];
    let processedFiles = 0;
    let processedRelations = 0;
    let truncated = false;
    while (queue.length > 0) {
      const current = queue.shift()!;
      processedFiles += 1;
      if (current.depth >= maxDepth) continue;
      const remaining = maxResults - dependencies.length;
      const imports = db.prepare(`
        SELECT target.id, target.path, r.provenance, r.confidence, r.index_revision AS indexRevision
        FROM relations r
        JOIN files target ON r.target_kind = 'file' AND target.id = r.target_id
        WHERE r.source_kind = 'file' AND r.source_id = ? AND r.kind = 'IMPORTS'
        ORDER BY target.path
        LIMIT ?
      `).all(current.id, Math.max(1, maxProcessed - processedRelations + 1)) as Array<{
        id: number; path: string; provenance: string; confidence: number; indexRevision: number;
      }>;
      for (const item of imports) {
        if (processedRelations >= maxProcessed) { truncated = true; break; }
        processedRelations += 1;
        if (visited.has(item.id)) continue;
        if (dependencies.length >= maxResults) { truncated = true; break; }
        visited.add(item.id);
        const chain = [...current.chain, item.path];
        dependencies.push({
          path: item.path,
          depth: current.depth + 1,
          chain,
          evidence: {
            relation: "IMPORTS",
            provenance: item.provenance,
            confidence: item.confidence,
            indexRevision: item.indexRevision,
          },
        });
        queue.push({ id: item.id, path: item.path, depth: current.depth + 1, chain });
      }
      if (truncated) break;
    }
    if (queue.some((item) => item.depth < maxDepth)) truncated = true;
    return { file: normalized, maxDepth, dependencies, truncated, processedFiles, processedRelations, limits: { maxResults, maxProcessed } };
  } finally {
    db.close();
  }
}

export interface FileDetailSymbol extends SearchHit {
  stableId: string;
}

export interface FileDetailRelation {
  direction: "outgoing" | "incoming";
  relation: string;
  sourceName: string;
  sourceKind: string;
  sourceFilePath: string;
  sourceStartLine: number;
  targetName: string;
  targetKind: string;
  targetFilePath: string;
  targetStartLine: number;
  confidence: number;
  provenance: string;
  indexRevision: number;
}

export interface FileDetails {
  path: string;
  stableId: string;
  language: string;
  extension: string;
  contentHash: string;
  indexedAt: string;
  indexRevision: number;
  symbols: FileDetailSymbol[];
  imports: Array<{ path: string; provenance: string; confidence: number; indexRevision: number }>;
  unresolvedImports: Array<{ specifier: string; status: string; candidates: string[] }>;
  relations: FileDetailRelation[];
}

export function getFileDetails(location: ProjectLocation, filePath: string): FileDetails {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  const db = openDatabase(location);
  try {
    const file = db.prepare(`
      SELECT id, stable_id AS stableId, path, language, extension, content_hash AS contentHash, indexed_at AS indexedAt
      FROM files WHERE path = ?
    `).get(normalized) as { id: number; stableId: string; path: string; language: string; extension: string; contentHash: string; indexedAt: string } | undefined;
    if (!file) throw new Error(`File not found in memory index: ${normalized}. Run cnm index.`);
    const project = db.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number };
    const symbols = db.prepare(`
      SELECT s.stable_id AS stableId, s.name, s.kind, s.signature, f.path AS filePath,
        s.start_line AS startLine, s.end_line AS endLine, s.exported AS exported
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE s.file_id = ? ORDER BY s.start_line, s.name, s.kind
    `).all(file.id) as FileDetailSymbol[];
    const imports = db.prepare(`
      SELECT target.path, r.provenance, r.confidence, r.index_revision AS indexRevision
      FROM relations r JOIN files target ON r.target_kind = 'file' AND target.id = r.target_id
      WHERE r.source_kind = 'file' AND r.source_id = ? AND r.kind = 'IMPORTS'
      ORDER BY target.path
    `).all(file.id) as FileDetails["imports"];
    const unresolvedImports = db.prepare(`
      SELECT module_specifier AS specifier, status, candidates_json AS candidatesJson
      FROM unresolved_imports WHERE source_file_id = ? ORDER BY module_specifier
    `).all(file.id).map((row: any) => ({
      specifier: row.specifier as string,
      status: row.status as string,
      candidates: JSON.parse(row.candidatesJson as string) as string[],
    }));
    const relations = db.prepare(`
      SELECT CASE WHEN source.file_id = ? THEN 'outgoing' ELSE 'incoming' END AS direction,
        r.kind AS relation,
        source.name AS sourceName, source.kind AS sourceKind, source_file.path AS sourceFilePath,
        source.start_line AS sourceStartLine,
        target.name AS targetName, target.kind AS targetKind, target_file.path AS targetFilePath,
        target.start_line AS targetStartLine,
        r.confidence AS confidence, r.provenance AS provenance, r.index_revision AS indexRevision
      FROM relations r
      JOIN symbols source ON r.source_kind = 'symbol' AND source.id = r.source_id
      JOIN files source_file ON source_file.id = source.file_id
      JOIN symbols target ON r.target_kind = 'symbol' AND target.id = r.target_id
      JOIN files target_file ON target_file.id = target.file_id
      WHERE source.file_id = ? OR target.file_id = ?
      ORDER BY relation, sourceFilePath, sourceStartLine, targetFilePath, targetStartLine
    `).all(file.id, file.id, file.id) as FileDetailRelation[];
    return {
      path: file.path, stableId: file.stableId, language: file.language, extension: file.extension,
      contentHash: file.contentHash, indexedAt: file.indexedAt, indexRevision: project.index_revision,
      symbols, imports, unresolvedImports, relations,
    };
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
  indexRevision: number;
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
          r.provenance AS provenance,
          r.index_revision AS indexRevision
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
          r.provenance AS provenance,
          r.index_revision AS indexRevision
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
