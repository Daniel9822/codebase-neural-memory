import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { readFileWithinRoot } from "./safe-file.js";
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
const DEFAULT_FILE_DETAIL_LIMIT = 100;
const MAX_FILE_DETAIL_LIMIT = 500;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface RankedSearchHit extends SearchHit {
  score: number;
  rankingSignals: string[];
  searchMethod: "fts5" | "like-fallback";
}

function tokenizeQuery(query: string): string[] {
  return [...new Set(query.match(/[\p{L}\p{N}_$]+/gu) ?? [])];
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => "\\" + character);
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
  const normalizedTokens = tokens.map((token) => token.toLowerCase());
  return rows.map((row) => {
    const name = row.name.toLowerCase();
    const signature = row.signature.toLowerCase();
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
    return { ...row, exported: Boolean(row.exported), score, rankingSignals: signals, searchMethod: (row.ftsRank === undefined ? "like-fallback" : "fts5") as RankedSearchHit["searchMethod"] };
  }).sort((a, b) =>
    b.score - a.score ||
    compareCodeUnits(a.filePath, b.filePath) ||
    a.startLine - b.startLine ||
    compareCodeUnits(a.name, b.name) ||
    compareCodeUnits(a.kind, b.kind) ||
    compareCodeUnits(a.signature, b.signature) ||
    a.endLine - b.endLine ||
    Number(b.exported) - Number(a.exported),
  ).slice(0, limit);
}

export interface SymbolSearchFilters {
  kind?: string;
  filePathPrefix?: string;
  exported?: boolean;
}

export function searchSymbols(
  location: ProjectLocation,
  query: string,
  limit = 20,
  filters: SymbolSearchFilters = {},
): RankedSearchHit[] {
  if (typeof query !== "string" || query.length > 1_000) {
    throw new Error("Search query must be a string no longer than 1000 characters.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEARCH_RESULTS) {
    throw new Error("Search limit must be a positive safe integer no greater than 1000.");
  }
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];
  const db = openDatabase(location);
  try {
    const candidateLimit = Math.min(MAX_SEARCH_CANDIDATES, Math.max(limit, limit * 20));
    const filterConditions: string[] = [];
    const filterParameters: Array<string | number> = [];
    if (filters.kind !== undefined) {
      filterConditions.push("s.kind = ?");
      filterParameters.push(filters.kind);
    }
    if (filters.filePathPrefix !== undefined) {
      filterConditions.push("(f.path = ? OR substr(f.path, 1, length(?) + 1) = ? || '/')");
      filterParameters.push(filters.filePathPrefix, filters.filePathPrefix, filters.filePathPrefix);
    }
    if (filters.exported !== undefined) {
      filterConditions.push("s.exported = ?");
      filterParameters.push(filters.exported ? 1 : 0);
    }
    const filterSql = filterConditions.length > 0 ? ` AND ${filterConditions.join(" AND ")}` : "";
    const ftsQuery = tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(" OR ");
    try {
      const rows = tokens.some((token) => /[\\%_]/.test(token))
        ? []
        : db.prepare(`
        SELECT s.name, s.kind, s.signature, f.path AS filePath,
          s.start_line AS startLine, s.end_line AS endLine, s.exported AS exported,
          bm25(symbols_fts) AS ftsRank
        FROM symbols_fts
        JOIN symbols s ON s.id = symbols_fts.rowid
        JOIN files f ON f.id = s.file_id
        WHERE symbols_fts MATCH ?${filterSql}
        ORDER BY ftsRank, f.path, s.start_line, s.name, s.kind, s.signature, s.end_line, s.exported, s.id
        LIMIT ?
      `).all(ftsQuery, ...filterParameters, candidateLimit) as Array<SearchHit & { ftsRank: number }>;
      const fallbackParameters = tokens.flatMap((token) => [`%${escapeLikePattern(token)}%`, `%${escapeLikePattern(token)}%`]);
      const fallbackRows = db.prepare(`
        SELECT s.name, s.kind, s.signature, f.path AS filePath,
          s.start_line AS startLine, s.end_line AS endLine, s.exported AS exported
        FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE (${tokens.map(() => "(s.name LIKE ? ESCAPE '\\' OR s.signature LIKE ? ESCAPE '\\')").join(" OR ")})${filterSql}
        ORDER BY f.path, s.start_line, s.name, s.kind, s.signature, s.end_line, s.exported, s.id
        LIMIT ?
      `).all(...fallbackParameters, ...filterParameters, candidateLimit) as SearchHit[];
      const combined = new Map<string, SearchHit & { ftsRank?: number }>();
      for (const row of rows) combined.set(`${row.filePath}:${row.startLine}:${row.name}:${row.kind}:${row.signature}:${row.endLine}:${Number(row.exported)}`, row);
      for (const row of fallbackRows) {
        const key = `${row.filePath}:${row.startLine}:${row.name}:${row.kind}`;
        if (!combined.has(key)) combined.set(key, row);
      }
      return rankSearchCandidates([...combined.values()], tokens, limit);
    } catch (error) {
      if (!isFtsUnavailable(error)) throw error;
      const parameters = tokens.flatMap((token) => [`%${escapeLikePattern(token)}%`, `%${escapeLikePattern(token)}%`]);
      const rows = db.prepare(`
        SELECT s.name, s.kind, s.signature, f.path AS filePath,
          s.start_line AS startLine, s.end_line AS endLine, s.exported AS exported
        FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE (${tokens.map(() => "(s.name LIKE ? ESCAPE '\\' OR s.signature LIKE ? ESCAPE '\\')").join(" OR ")})${filterSql}
        ORDER BY f.path, s.start_line, s.name, s.kind
        LIMIT ?
      `).all(...parameters, ...filterParameters, candidateLimit) as SearchHit[];
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

/** @deprecated Prefer getProjectMapReport to retain exact totals and truncation metadata. */
export function getProjectMap(location: ProjectLocation, limit = 80): Array<{ path: string; imports: string[]; unresolvedImports: Array<{ specifier: string; status: string; candidates: string[] }> }> {
  const report = getProjectMapReport(location, limit);
  return report.files.map((file) => ({
    path: file.path,
    imports: file.imports,
    unresolvedImports: file.unresolvedImports.map((item) => ({
      specifier: item.specifier,
      status: item.status,
      candidates: item.candidates,
    })),
  }));
}

export interface ProjectMapReport {
  files: Array<{
    path: string;
    imports: string[];
    unresolvedImports: Array<{ specifier: string; status: string; candidates: string[]; candidatesTotal: number; candidatesTruncated: boolean }>;
    importDiagnostics: Array<{ specifier: string; kind: string; code: number; message: string; line: number; column: number; importedName: string | null }>;
    totals: { imports: number; unresolvedImports: number; importDiagnostics: number };
    truncated: { imports: boolean; unresolvedImports: boolean; importDiagnostics: boolean };
  }>;
  totalFiles: number;
  limit: number;
  truncated: boolean;
  perFileLimit: number;
  candidateLimit: number;
  candidateBudget: number;
  candidatePathsTotal: number;
  candidatePathsReturned: number;
  candidatePathsTruncated: boolean;
}

const MAX_PROJECT_MAP_PER_FILE = 200;
const MAX_PROJECT_MAP_CANDIDATES = 200;
const MAX_PROJECT_MAP_CANDIDATE_BUDGET = 2_000;

/** MCP-facing project map with deterministic per-file and global candidate budgets. */
export function getProjectMapReport(location: ProjectLocation, limit = 80): ProjectMapReport {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("Project map limit must be a positive safe integer no greater than 200");
  }
  const db = openDatabase(location);
  try {
    const totalFiles = (db.prepare("SELECT COUNT(*) AS count FROM files").get() as { count: number }).count;
    const rows = db.prepare(`
      SELECT f.id, f.path,
        (SELECT COUNT(*) FROM relations r WHERE r.source_kind = 'file' AND r.source_id = f.id AND r.kind = 'IMPORTS') AS importsTotal,
        (SELECT COUNT(*) FROM unresolved_imports u WHERE u.source_file_id = f.id) AS unresolvedTotal,
        (SELECT COUNT(*) FROM import_diagnostics d WHERE d.source_file_id = f.id) AS diagnosticsTotal,
        (SELECT COALESCE(SUM(json_array_length(u.candidates_json)), 0)
          FROM unresolved_imports u WHERE u.source_file_id = f.id) AS candidatePathsTotal,
        COALESCE((SELECT json_group_array(path) FROM (
          SELECT target.path AS path FROM relations r
          JOIN files target ON r.target_kind = 'file' AND target.id = r.target_id
          WHERE r.source_kind = 'file' AND r.source_id = f.id AND r.kind = 'IMPORTS'
          ORDER BY target.path LIMIT ?
        )), '[]') AS imports,
        COALESCE((SELECT json_group_array(json_object(
          'id', id, 'specifier', specifier, 'status', status, 'candidatesTotal', candidatesTotal
        )) FROM (
          SELECT u.id AS id, u.module_specifier AS specifier, u.status AS status,
            json_array_length(u.candidates_json) AS candidatesTotal
          FROM unresolved_imports u WHERE u.source_file_id = f.id
          ORDER BY u.module_specifier LIMIT ?
        )), '[]') AS unresolvedImports,
        COALESCE((SELECT json_group_array(json_object(
          'specifier', module_specifier, 'kind', kind, 'code', diagnostic_code,
          'message', message, 'line', line, 'column', column_number, 'importedName', imported_name
        )) FROM (
          SELECT module_specifier, kind, diagnostic_code, message, line, column_number, imported_name
          FROM import_diagnostics WHERE source_file_id = f.id
          ORDER BY line, column_number, diagnostic_code, module_specifier, kind, message LIMIT ?
        )), '[]') AS importDiagnostics
      FROM files f ORDER BY f.path LIMIT ?
    `).all(MAX_PROJECT_MAP_PER_FILE, MAX_PROJECT_MAP_PER_FILE, MAX_PROJECT_MAP_PER_FILE, limit) as Array<{
      id: number; path: string; importsTotal: number; unresolvedTotal: number; diagnosticsTotal: number;
      candidatePathsTotal: number; imports: string; unresolvedImports: string; importDiagnostics: string;
    }>;
    const selectedFileIds = rows.map((row) => row.id);
    const candidateRows = selectedFileIds.length === 0 ? [] : db.prepare(`
      WITH selected_unresolved AS (
        SELECT u.id, u.source_file_id, u.module_specifier, f.path AS file_path
        FROM unresolved_imports u JOIN files f ON f.id = u.source_file_id
        WHERE u.source_file_id IN (${selectedFileIds.map(() => "?").join(",")})
          AND u.id IN (
            SELECT limited.id FROM unresolved_imports limited
            WHERE limited.source_file_id = u.source_file_id
            ORDER BY limited.module_specifier LIMIT ${MAX_PROJECT_MAP_PER_FILE}
          )
      )
      SELECT selected_unresolved.id AS unresolvedId, candidate.value AS candidatePath
      FROM selected_unresolved
      JOIN unresolved_imports stored ON stored.id = selected_unresolved.id
      JOIN json_each(stored.candidates_json) AS candidate
      WHERE CAST(candidate.key AS INTEGER) < ${MAX_PROJECT_MAP_CANDIDATES}
      ORDER BY selected_unresolved.file_path, selected_unresolved.module_specifier,
        CAST(candidate.key AS INTEGER)
      LIMIT ?
    `).all(...selectedFileIds, MAX_PROJECT_MAP_CANDIDATE_BUDGET) as Array<{ unresolvedId: number; candidatePath: string }>;
    const candidatesByImport = new Map<number, string[]>();
    for (const candidate of candidateRows) {
      const values = candidatesByImport.get(candidate.unresolvedId) ?? [];
      values.push(candidate.candidatePath);
      candidatesByImport.set(candidate.unresolvedId, values);
    }
    const files = rows.map((row) => {
      const imports = JSON.parse(row.imports) as string[];
      const rawUnresolvedImports = JSON.parse(row.unresolvedImports) as Array<{
        id: number; specifier: string; status: string; candidatesTotal: number;
      }>;
      const unresolvedImports = rawUnresolvedImports.map((item) => {
        const candidates = candidatesByImport.get(item.id) ?? [];
        return {
          specifier: item.specifier,
          status: item.status,
          candidates,
          candidatesTotal: item.candidatesTotal,
          candidatesTruncated: candidates.length < item.candidatesTotal,
        };
      });
      const importDiagnostics = JSON.parse(row.importDiagnostics) as Array<{
        specifier: string; kind: string; code: number; message: string;
        line: number; column: number; importedName: string | null;
      }>;
      return {
        path: row.path, imports, unresolvedImports, importDiagnostics,
        totals: {
          imports: row.importsTotal,
          unresolvedImports: row.unresolvedTotal,
          importDiagnostics: row.diagnosticsTotal,
        },
        truncated: {
          imports: row.importsTotal > imports.length,
          unresolvedImports: row.unresolvedTotal > unresolvedImports.length,
          importDiagnostics: row.diagnosticsTotal > importDiagnostics.length,
        },
      };
    });
    const candidatePathsTotal = rows.reduce((total, row) => total + row.candidatePathsTotal, 0);
    return {
      files, totalFiles, limit, truncated: totalFiles > files.length,
      perFileLimit: MAX_PROJECT_MAP_PER_FILE,
      candidateLimit: MAX_PROJECT_MAP_CANDIDATES,
      candidateBudget: MAX_PROJECT_MAP_CANDIDATE_BUDGET,
      candidatePathsTotal,
      candidatePathsReturned: candidateRows.length,
      candidatePathsTruncated: candidatePathsTotal > candidateRows.length,
    };
  } finally {
    db.close();
  }
}

export function explainSymbol(location: ProjectLocation, name: string): SearchHit[] {
  if (typeof name !== "string" || !name.trim() || name.length > 200) {
    throw new Error("Symbol name must be non-empty and no longer than 200 characters.");
  }
  const db = openDatabase(location);
  try {
    return db.prepare(`
      SELECT s.name, s.kind, s.signature, f.path AS filePath,
        s.start_line AS startLine, s.end_line AS endLine, s.exported AS exported
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE s.name = ? OR s.name LIKE ?
      ORDER BY s.exported DESC, f.path, s.start_line, s.name, s.kind, s.signature, s.end_line, s.id LIMIT 20
    `).all(name, `%${name}%`) as SearchHit[];
  } finally {
    db.close();
  }
}

export interface ImpactResult {
  file: string;
  affectedFiles: string[];
  truncated: boolean;
  processedFiles: number;
  processedRelations: number;
  limits: { maxResults: number; maxProcessed: number };
}

const DEFAULT_IMPACT_RESULTS = 100;
const DEFAULT_IMPACT_PROCESSED = 1_000;
const MAX_IMPACT_RESULTS = 5_000;
const MAX_IMPACT_PROCESSED = 10_000;

export function findImpact(
  location: ProjectLocation,
  targetPath: string,
  maxResults = DEFAULT_IMPACT_RESULTS,
  maxProcessed = DEFAULT_IMPACT_PROCESSED,
): ImpactResult {
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > MAX_IMPACT_RESULTS) {
    throw new Error("Impact result limit must be a positive safe integer no greater than 5000.");
  }
  if (!Number.isSafeInteger(maxProcessed) || maxProcessed < 1 || maxProcessed > MAX_IMPACT_PROCESSED) {
    throw new Error("Impact processing limit must be a positive safe integer no greater than 10000.");
  }
  const db = openDatabase(location);
  try {
    const normalized = targetPath.replaceAll("\\", "/").replace(/^\.\//, "");
    const target = db.prepare("SELECT id FROM files WHERE path = ?").get(normalized) as { id: number } | undefined;
    if (!target) throw new Error(`File not found in memory index: ${normalized}. Run cnm index.`);
    const queue = [target.id];
    const visited = new Set<number>(queue);
    const affectedFiles: string[] = [];
    let processedFiles = 0;
    let processedRelations = 0;
    let truncated = false;
    while (queue.length > 0) {
      const current = queue.shift()!;
      processedFiles += 1;
      const remaining = maxProcessed - processedRelations;
      const dependents = db.prepare(`
        SELECT source.id, source.path FROM relations r
        JOIN files source ON r.source_kind = 'file' AND source.id = r.source_id
        WHERE r.target_kind = 'file' AND r.target_id = ? AND r.kind = 'IMPORTS'
        ORDER BY source.path
        LIMIT ?
      `).all(current, Math.max(1, remaining + 1)) as Array<{ id: number; path: string }>;
      for (const item of dependents) {
        if (processedRelations >= maxProcessed) { truncated = true; break; }
        processedRelations += 1;
        if (visited.has(item.id)) continue;
        if (affectedFiles.length >= maxResults) { truncated = true; break; }
        visited.add(item.id);
        affectedFiles.push(item.path);
        queue.push(item.id);
      }
      if (truncated) break;
    }
    if (queue.length > 0) truncated = true;
    return { file: normalized, affectedFiles, truncated, processedFiles, processedRelations, limits: { maxResults, maxProcessed } };
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
  /** Evidence for each adjacent file pair in `chain`, in traversal order. */
  chainEvidence: DependencyEvidence[];
  /** Evidence for the final edge (same value as the last chainEvidence item). */
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

    const queue: Array<{ id: number; path: string; depth: number; chain: string[]; chainEvidence: DependencyEvidence[] }> = [
      { id: target.id, path: normalized, depth: 0, chain: [normalized], chainEvidence: [] },
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
        const evidence: DependencyEvidence = {
          relation: "IMPORTS",
          provenance: item.provenance,
          confidence: item.confidence,
          indexRevision: item.indexRevision,
        };
        const chainEvidence = [...current.chainEvidence, evidence];
        dependencies.push({
          path: item.path,
          depth: current.depth + 1,
          chain,
          chainEvidence,
          evidence,
        });
        queue.push({ id: item.id, path: item.path, depth: current.depth + 1, chain, chainEvidence });
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
  unresolvedImports: Array<{ specifier: string; status: string; candidates: string[]; candidatesTotal: number; candidatesTruncated: boolean }>;
  importDiagnostics: Array<{ specifier: string; kind: string; code: number; message: string; line: number; column: number; importedName: string | null }>;
  relations: FileDetailRelation[];
  limits: { perCollection: number; candidatesPerImport: number; candidateBudget: number };
  totals: { symbols: number; imports: number; unresolvedImports: number; importDiagnostics: number; relations: number; candidatePaths: number };
  truncated: { symbols: boolean; imports: boolean; unresolvedImports: boolean; importDiagnostics: boolean; relations: boolean; candidatePaths: boolean };
}

export function getFileDetails(
  location: ProjectLocation,
  filePath: string,
  limit = DEFAULT_FILE_DETAIL_LIMIT,
): FileDetails {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FILE_DETAIL_LIMIT) {
    throw new Error("File detail limit must be a positive safe integer no greater than 500.");
  }
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  const db = openDatabase(location);
  try {
    const file = db.prepare(`
      SELECT id, stable_id AS stableId, path, language, extension, content_hash AS contentHash, indexed_at AS indexedAt
      FROM files WHERE path = ?
    `).get(normalized) as { id: number; stableId: string; path: string; language: string; extension: string; contentHash: string; indexedAt: string } | undefined;
    if (!file) throw new Error(`File not found in memory index: ${normalized}. Run cnm index.`);
    const project = db.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number };
    const totals = {
      symbols: (db.prepare("SELECT COUNT(*) AS count FROM symbols WHERE file_id = ?").get(file.id) as { count: number }).count,
      imports: (db.prepare("SELECT COUNT(*) AS count FROM relations WHERE source_kind = 'file' AND source_id = ? AND kind = 'IMPORTS'").get(file.id) as { count: number }).count,
      unresolvedImports: (db.prepare("SELECT COUNT(*) AS count FROM unresolved_imports WHERE source_file_id = ?").get(file.id) as { count: number }).count,
      importDiagnostics: (db.prepare("SELECT COUNT(*) AS count FROM import_diagnostics WHERE source_file_id = ?").get(file.id) as { count: number }).count,
      relations: (db.prepare(`SELECT COUNT(*) AS count FROM relations r
        JOIN symbols source ON r.source_kind = 'symbol' AND source.id = r.source_id
        JOIN symbols target ON r.target_kind = 'symbol' AND target.id = r.target_id
        WHERE source.file_id = ? OR target.file_id = ?`).get(file.id, file.id) as { count: number }).count,
    };
    const symbols = db.prepare(`
      SELECT s.stable_id AS stableId, s.name, s.kind, s.signature, f.path AS filePath,
        s.start_line AS startLine, s.end_line AS endLine, s.exported AS exported
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE s.file_id = ? ORDER BY s.start_line, s.name, s.kind, s.signature, s.end_line, s.id LIMIT ?
    `).all(file.id, limit) as FileDetailSymbol[];
    const imports = db.prepare(`
      SELECT target.path, r.provenance, r.confidence, r.index_revision AS indexRevision
      FROM relations r JOIN files target ON r.target_kind = 'file' AND target.id = r.target_id
      WHERE r.source_kind = 'file' AND r.source_id = ? AND r.kind = 'IMPORTS'
      ORDER BY target.path LIMIT ?
    `).all(file.id, limit) as FileDetails["imports"];
    const unresolvedRows = db.prepare(`
      SELECT id, module_specifier AS specifier, status,
        json_array_length(candidates_json) AS candidatesTotal
      FROM unresolved_imports WHERE source_file_id = ? ORDER BY module_specifier LIMIT ?
    `).all(file.id, limit) as Array<{
      id: number; specifier: string; status: string; candidatesTotal: number;
    }>;
    const candidateRows = unresolvedRows.length === 0 ? [] : db.prepare(`
      SELECT unresolved.id AS unresolvedId, candidate.value AS candidatePath
      FROM unresolved_imports AS unresolved
      JOIN json_each(unresolved.candidates_json) AS candidate
      WHERE unresolved.id IN (${unresolvedRows.map(() => "?").join(",")})
        AND CAST(candidate.key AS INTEGER) < 200
      ORDER BY unresolved.module_specifier, CAST(candidate.key AS INTEGER)
      LIMIT 2000
    `).all(...unresolvedRows.map((row) => row.id)) as Array<{
      unresolvedId: number; candidatePath: string;
    }>;
    const candidatesByImport = new Map<number, string[]>();
    for (const candidate of candidateRows) {
      const values = candidatesByImport.get(candidate.unresolvedId) ?? [];
      values.push(candidate.candidatePath);
      candidatesByImport.set(candidate.unresolvedId, values);
    }
    const unresolvedImports = unresolvedRows.map((row) => {
      const candidates = candidatesByImport.get(row.id) ?? [];
      return {
        specifier: row.specifier,
        status: row.status,
        candidates,
        candidatesTotal: row.candidatesTotal,
        candidatesTruncated: candidates.length < row.candidatesTotal,
      };
    });
    const candidatePathsTotal = unresolvedRows.reduce((total, row) => total + row.candidatesTotal, 0);
    const importDiagnostics = db.prepare(`
      SELECT module_specifier AS specifier, kind, diagnostic_code AS code, message, line,
        column_number AS "column", imported_name AS importedName
      FROM import_diagnostics WHERE source_file_id = ?
      ORDER BY line, column_number, diagnostic_code LIMIT ?
    `).all(file.id, limit) as FileDetails["importDiagnostics"];
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
      ORDER BY relation, sourceFilePath, sourceStartLine, sourceName, sourceKind,
        targetFilePath, targetStartLine, targetName, targetKind, r.provenance, r.confidence, r.index_revision
      LIMIT ?
    `).all(file.id, file.id, file.id, limit) as FileDetailRelation[];
    return {
      path: file.path, stableId: file.stableId, language: file.language, extension: file.extension,
      contentHash: file.contentHash, indexedAt: file.indexedAt, indexRevision: project.index_revision,
      symbols, imports, unresolvedImports, importDiagnostics, relations,
      limits: { perCollection: limit, candidatesPerImport: 200, candidateBudget: 2_000 },
      totals: { ...totals, candidatePaths: candidatePathsTotal },
      truncated: {
        symbols: totals.symbols > symbols.length,
        imports: totals.imports > imports.length,
        unresolvedImports: totals.unresolvedImports > unresolvedImports.length,
        importDiagnostics: totals.importDiagnostics > importDiagnostics.length,
        relations: totals.relations > relations.length,
        candidatePaths: candidatePathsTotal > candidateRows.length,
      },
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

const MAX_SYMBOL_RELATIONS = 500;

export function getSymbolRelations(location: ProjectLocation, name: string, limit = 50): SymbolRelationHit[] {
  if (typeof name !== "string" || !name.trim() || name.length > 200) {
    throw new Error("Symbol name must be non-empty and no longer than 200 characters.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SYMBOL_RELATIONS) {
    throw new Error(`Relation limit must be a positive safe integer no greater than ${MAX_SYMBOL_RELATIONS}.`);
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




export interface ComponentMapReport {
  components: Array<{ id: string; files: number; symbols: number; imports: number; importedBy: number; distanceFrom: number | null; sampleFiles: string[]; filesTruncated: boolean }>;
  edges: Array<{ from: string; to: string; imports: number }>;
  totalComponents: number; totalEdges: number; from: string | null; depth: number;
  truncated: { components: boolean; edges: boolean; files: boolean };
  limits: { maxComponents: number; maxEdges: number; maxFilesPerComponent: number };
}
const MAX_COMPONENT_MAP_COMPONENTS = 100;
const MAX_COMPONENT_MAP_EDGES = 500;
const MAX_COMPONENT_MAP_FILES = 20;
const COMPONENT_PATH_SQL = "CASE WHEN instr(path, '/') > 0 THEN substr(path, 1, instr(path, '/') - 1) ELSE '(root)' END";

/** Directory-boundary grouping of the import graph; this is structural, not semantic inference. */
export function getComponentMap(location: ProjectLocation, options: { from?: string; depth?: number; limit?: number; fileLimit?: number } = {}): ComponentMapReport {
  const limit = options.limit ?? 50, fileLimit = options.fileLimit ?? 10, depth = options.depth ?? 5;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_COMPONENT_MAP_COMPONENTS) throw new Error("Component limit must be a positive safe integer no greater than 100.");
  if (!Number.isSafeInteger(fileLimit) || fileLimit < 1 || fileLimit > MAX_COMPONENT_MAP_FILES) throw new Error("Component file limit must be a positive safe integer no greater than 20.");
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > 20) throw new Error("Component distance depth must be a positive safe integer no greater than 20.");
  const db = openDatabase(location);
  try {
    let from: string | null = null;
    if (options.from !== undefined) {
      const requested = options.from.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
      const indexedPath = db.prepare(`SELECT ${COMPONENT_PATH_SQL} AS id FROM files WHERE path = ? LIMIT 1`).get(requested) as { id: string } | undefined;
      const component = indexedPath?.id ?? requested;
      const exists = db.prepare(`SELECT 1 AS found FROM files WHERE ${COMPONENT_PATH_SQL} = ? LIMIT 1`).get(component) as { found: number } | undefined;
      if (!exists) throw new Error(`Component not found in memory index: ${options.from}`);
      from = component;
    }
    const totalComponents = (db.prepare(`SELECT COUNT(DISTINCT ${COMPONENT_PATH_SQL}) AS count FROM files`).get() as { count: number }).count;
    const componentRows = db.prepare(`
      SELECT ${COMPONENT_PATH_SQL} AS id, COUNT(DISTINCT f.id) AS files, COUNT(s.id) AS symbols
      FROM files f LEFT JOIN symbols s ON s.file_id = f.id
      GROUP BY ${COMPONENT_PATH_SQL}
      ORDER BY CASE WHEN ? IS NOT NULL AND ${COMPONENT_PATH_SQL} = ? THEN 0 ELSE 1 END, id
      LIMIT ?
    `).all(from, from, limit + 1) as Array<{ id: string; files: number; symbols: number }>;
    const selectedRows = componentRows.slice(0, limit);
    const componentIds = selectedRows.map((row) => row.id);
    const edgeRows = db.prepare(`
      SELECT source_component AS "from", target_component AS "to", COUNT(*) AS imports
      FROM (
        SELECT ${COMPONENT_PATH_SQL.replaceAll("path", "source.path")} AS source_component,
          ${COMPONENT_PATH_SQL.replaceAll("path", "target.path")} AS target_component
        FROM relations r
        JOIN files source ON r.source_kind = 'file' AND source.id = r.source_id
        JOIN files target ON r.target_kind = 'file' AND target.id = r.target_id
        WHERE r.kind = 'IMPORTS'
      )
      WHERE source_component <> target_component
      GROUP BY source_component, target_component
      ORDER BY source_component, target_component
      LIMIT ?
    `).all(MAX_COMPONENT_MAP_EDGES + 1) as Array<{ from: string; to: string; imports: number }>;
    const totalEdges = (db.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT source_component, target_component
        FROM (
          SELECT ${COMPONENT_PATH_SQL.replaceAll("path", "source.path")} AS source_component,
            ${COMPONENT_PATH_SQL.replaceAll("path", "target.path")} AS target_component
          FROM relations r
          JOIN files source ON r.source_kind = 'file' AND source.id = r.source_id
          JOIN files target ON r.target_kind = 'file' AND target.id = r.target_id
          WHERE r.kind = 'IMPORTS'
        )
        WHERE source_component <> target_component
        GROUP BY source_component, target_component
      )
    `).get() as { count: number }).count;
    const allEdges = edgeRows.slice(0, MAX_COMPONENT_MAP_EDGES);
    const distances = new Map<string, number>();
    if (from !== null) {
      distances.set(from, 0);
      const adjacency = new Map<string, string[]>();
      for (const edge of allEdges) { const targets = adjacency.get(edge.from) ?? []; targets.push(edge.to); adjacency.set(edge.from, targets); }
      const queue = [from];
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const current = queue[cursor]!, distance = distances.get(current)!;
        if (distance >= depth) continue;
        for (const target of adjacency.get(current) ?? []) if (!distances.has(target)) { distances.set(target, distance + 1); queue.push(target); }
      }
    }
    const outgoing = new Map<string, number>(), incoming = new Map<string, number>();
    for (const edge of allEdges) {
      outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1);
      incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    }
    const components = selectedRows.map((row) => {
      const samples = db.prepare(`SELECT path FROM files WHERE ${COMPONENT_PATH_SQL} = ? ORDER BY path LIMIT ?`).all(row.id, fileLimit + 1) as Array<{ path: string }>;
      return {
        id: row.id, files: Number(row.files), symbols: Number(row.symbols),
        imports: outgoing.get(row.id) ?? 0, importedBy: incoming.get(row.id) ?? 0,
        distanceFrom: from === null ? null : (distances.get(row.id) ?? null),
        sampleFiles: samples.slice(0, fileLimit).map((item) => item.path),
        filesTruncated: samples.length > fileLimit,
      };
    });
    const included = new Set(componentIds);
    const edges = allEdges.filter((edge) => included.has(edge.from) && included.has(edge.to));
    return {
      components, edges, totalComponents, totalEdges, from, depth,
      truncated: { components: totalComponents > components.length, edges: totalEdges > edges.length, files: components.some((item) => item.filesTruncated) },
      limits: { maxComponents: limit, maxEdges: MAX_COMPONENT_MAP_EDGES, maxFilesPerComponent: fileLimit },
    };
  } finally { db.close(); }
}

const MAX_SOURCE_EXCERPT_LINES = 200;
const MAX_SOURCE_EXCERPT_CHARACTERS = 20_000;
const MAX_INDEXED_SOURCE_BYTES = 1_048_576;

export interface SourceExcerpt {
  path: string;
  startLine: number;
  endLine: number;
  requestedStartLine: number;
  requestedEndLine: number;
  totalLines: number;
  content: string;
  contentHash: string;
  indexedContentHash: string;
  indexStatus: "current" | "stale";
  indexedAt: string;
  truncated: boolean;
  limits: { maxLines: number; maxCharacters: number };
}

/** Read a bounded excerpt from an indexed file and explicitly compare it with indexed bytes. */
export function getSourceExcerpt(
  location: ProjectLocation,
  filePath: string,
  startLine: number,
  endLine: number,
  maxCharacters = 12_000,
): SourceExcerpt {
  if (typeof filePath !== "string" || !filePath.trim() || filePath.includes("\0")) {
    throw new Error("Source excerpt path must be a non-empty project-relative path.");
  }
  if (!Number.isSafeInteger(startLine) || startLine < 1) {
    throw new Error("Source excerpt startLine must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(endLine) || endLine < startLine) {
    throw new Error("Source excerpt endLine must be a safe integer greater than or equal to startLine.");
  }
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 100 || maxCharacters > MAX_SOURCE_EXCERPT_CHARACTERS) {
    throw new Error(`Source excerpt maxCharacters must be between 100 and ${MAX_SOURCE_EXCERPT_CHARACTERS}.`);
  }
  if (endLine - startLine + 1 > MAX_SOURCE_EXCERPT_LINES) {
    throw new Error(`Source excerpt range cannot exceed ${MAX_SOURCE_EXCERPT_LINES} lines.`);
  }

  const normalized = filePath.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized) ||
      normalized.split("/").some((segment) => segment === ".." || segment === "")) {
    throw new Error("Source excerpt path must be a normalized project-relative path.");
  }
  const absolutePath = resolve(location.rootPath, normalized);
  const lexicalRelative = relative(location.rootPath, absolutePath);
  if (lexicalRelative === ".." || lexicalRelative.startsWith(".." + sep) || isAbsolute(lexicalRelative)) {
    throw new Error("Source excerpt path must stay inside the project root.");
  }

  const db = openDatabase(location);
  let indexedFile: { path: string; contentHash: string; indexedAt: string } | undefined;
  try {
    indexedFile = db.prepare(
      "SELECT path, content_hash AS contentHash, indexed_at AS indexedAt FROM files WHERE path = ?",
    ).get(normalized) as { path: string; contentHash: string; indexedAt: string } | undefined;
  } finally {
    db.close();
  }
  if (!indexedFile) throw new Error(`File not found in memory index: ${normalized}. Run cnm index.`);

  let source: string;
  try {
    const safeRead = readFileWithinRoot(location.rootPath, absolutePath, {
      maxBytes: MAX_INDEXED_SOURCE_BYTES,
      rejectFinalSymlink: true,
    });
    source = safeRead.content.toString("utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error(`Source file is missing or cannot be resolved: ${normalized}.`);
    }
    if (error instanceof Error && error.message === "File path resolves outside the project root.") {
      throw new Error("Source excerpt path resolves outside the project root.");
    }
    if (error instanceof Error && error.message === "Symlink file paths are not allowed.") {
      throw new Error("Source excerpt path is a symlink or resolves outside the project root.");
    }
    if (error instanceof Error && error.message === "Path must reference a regular file.") {
      throw new Error("Source excerpt path must reference a regular file.");
    }
    if (error instanceof Error && error.message.startsWith("File exceeds ")) {
      throw new Error(`Source file exceeds the ${MAX_INDEXED_SOURCE_BYTES}-byte read limit.`);
    }
    throw error;
  }
  const contentHash = createHash("sha256").update(source).digest("hex");
  const sourceLines = source.split(/\r?\n/);
  if (startLine > sourceLines.length) {
    throw new Error(`Source excerpt startLine ${startLine} exceeds the file's ${sourceLines.length} lines.`);
  }
  const effectiveEndLine = Math.min(endLine, sourceLines.length);
  const selected = sourceLines.slice(startLine - 1, effectiveEndLine);
  const output: string[] = [];
  let usedCharacters = 0;
  let truncated = endLine > sourceLines.length;
  for (const line of selected) {
    const separatorCharacters = output.length === 0 ? 0 : 1;
    const available = maxCharacters - usedCharacters - separatorCharacters;
    if (available <= 0) { truncated = true; break; }
    if (line.length > available) {
      output.push(line.slice(0, available));
      usedCharacters += available + separatorCharacters;
      truncated = true;
      break;
    }
    output.push(line);
    usedCharacters += line.length + separatorCharacters;
  }

  return {
    path: indexedFile.path,
    startLine,
    endLine: startLine + output.length - 1,
    requestedStartLine: startLine,
    requestedEndLine: endLine,
    totalLines: sourceLines.length,
    content: output.join("\n"),
    contentHash,
    indexedContentHash: indexedFile.contentHash,
    indexStatus: contentHash === indexedFile.contentHash ? "current" : "stale",
    indexedAt: indexedFile.indexedAt,
    truncated,
    limits: { maxLines: MAX_SOURCE_EXCERPT_LINES, maxCharacters },
  };
}


export type SymbolImpactRelationKind = "CALLS" | "EXTENDS" | "IMPLEMENTS";
export type SymbolImpactDirection = "incoming" | "outgoing";
export interface SymbolImpactOptions {
  filePath?: string; kind?: string; startLine?: number; direction?: SymbolImpactDirection;
  depth?: number; limit?: number; maxProcessed?: number; relationKinds?: SymbolImpactRelationKind[];
}
export interface SymbolImpactSymbol {
  stableId: string; name: string; kind: string; filePath: string; startLine: number; endLine: number;
}
export interface SymbolImpactEvidence {
  relation: SymbolImpactRelationKind; source: SymbolImpactSymbol; target: SymbolImpactSymbol;
  confidence: number; provenance: string; indexRevision: number;
}
export interface SymbolImpactHit extends SymbolImpactSymbol {
  distance: number; relation: SymbolImpactRelationKind; path: SymbolImpactSymbol[]; chainEvidence: SymbolImpactEvidence[];
}
export interface SymbolImpactReport {
  target: SymbolImpactSymbol | null; ambiguous: boolean; candidates: SymbolImpactSymbol[];
  direction: SymbolImpactDirection; results: SymbolImpactHit[]; processedRelations: number; truncated: boolean;
  limits: { depth: number; maxResults: number; maxProcessed: number; relationKinds: SymbolImpactRelationKind[] };
}
const DEFAULT_SYMBOL_IMPACT_DEPTH = 3;
const DEFAULT_SYMBOL_IMPACT_RESULTS = 100;
const DEFAULT_SYMBOL_IMPACT_PROCESSED = 1_000;
const MAX_SYMBOL_IMPACT_DEPTH = 20;
const MAX_SYMBOL_IMPACT_RESULTS = 500;
const MAX_SYMBOL_IMPACT_PROCESSED = 10_000;

/** Traverse symbol CALLS/EXTENDS/IMPLEMENTS edges and report shortest relation distances. */
export function findSymbolImpact(location: ProjectLocation, name: string, options: SymbolImpactOptions = {}): SymbolImpactReport {
  const normalizedName = name.trim();
  if (!normalizedName || normalizedName.length > 200) throw new Error("Symbol name must be non-empty and no longer than 200 characters.");
  const direction = options.direction ?? "incoming";
  if (direction !== "incoming" && direction !== "outgoing") throw new Error("Symbol impact direction must be incoming or outgoing.");
  const depth = options.depth ?? DEFAULT_SYMBOL_IMPACT_DEPTH;
  const limit = options.limit ?? DEFAULT_SYMBOL_IMPACT_RESULTS;
  const maxProcessed = options.maxProcessed ?? DEFAULT_SYMBOL_IMPACT_PROCESSED;
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > MAX_SYMBOL_IMPACT_DEPTH) throw new Error("Symbol impact depth must be between 1 and 20.");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SYMBOL_IMPACT_RESULTS) throw new Error("Symbol impact result limit must be between 1 and 500.");
  if (!Number.isSafeInteger(maxProcessed) || maxProcessed < 1 || maxProcessed > MAX_SYMBOL_IMPACT_PROCESSED) throw new Error("Symbol impact processing limit must be between 1 and 10000.");

  let normalizedPath: string | undefined;
  if (options.filePath !== undefined) {
    normalizedPath = options.filePath.trim().replaceAll("\\", "/").replace(/^\.\//, "");
    if (!normalizedPath || normalizedPath.length > 500 || normalizedPath.startsWith("/") || /^[a-zA-Z]:/.test(normalizedPath)
      || normalizedPath.split("/").some((part) => part === ".." || part === "" || part === ".")) {
      throw new Error("Symbol impact filePath must be a normalized project-relative path.");
    }
  }
  if (options.kind !== undefined && (!options.kind.trim() || options.kind.length > 100)) throw new Error("Symbol impact kind must be a non-empty string no longer than 100 characters.");
  if (options.startLine !== undefined && (!Number.isSafeInteger(options.startLine) || options.startLine < 1)) throw new Error("Symbol impact startLine must be a positive safe integer.");

  const allowedKinds: SymbolImpactRelationKind[] = ["CALLS", "EXTENDS", "IMPLEMENTS"];
  const relationKinds = options.relationKinds ?? allowedKinds;
  if (!Array.isArray(relationKinds) || relationKinds.length < 1 || relationKinds.length > allowedKinds.length
    || relationKinds.some((relation) => !allowedKinds.includes(relation)) || new Set(relationKinds).size !== relationKinds.length) {
    throw new Error("Symbol impact relationKinds must contain unique CALLS, EXTENDS, or IMPLEMENTS values.");
  }

  const db = openDatabase(location);
  try {
    const conditions = ["s.name = ?"];
    const parameters: Array<string | number> = [normalizedName];
    if (normalizedPath !== undefined) { conditions.push("f.path = ?"); parameters.push(normalizedPath); }
    if (options.kind !== undefined) { conditions.push("s.kind = ?"); parameters.push(options.kind.trim()); }
    if (options.startLine !== undefined) { conditions.push("s.start_line = ?"); parameters.push(options.startLine); }
    const rootRows = db.prepare(`
      SELECT s.id, s.stable_id AS stableId, s.name, s.kind, f.path AS filePath,
        s.start_line AS startLine, s.end_line AS endLine
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY f.path, s.start_line, s.kind, s.stable_id
      LIMIT 51
    `).all(...parameters) as Array<{
      id: number; stableId: string; name: string; kind: string; filePath: string; startLine: number; endLine: number;
    }>;
    if (rootRows.length === 0) throw new Error(`Symbol not found in index: ${normalizedName}${normalizedPath ? ` in ${normalizedPath}` : ""}.`);
    const toSymbol = (row: typeof rootRows[number]): SymbolImpactSymbol => ({
      stableId: row.stableId, name: row.name, kind: row.kind, filePath: row.filePath, startLine: row.startLine, endLine: row.endLine,
    });
    if (rootRows.length > 1) {
      return {
        target: null, ambiguous: true, candidates: rootRows.slice(0, 50).map(toSymbol), direction,
        results: [], processedRelations: 0, truncated: rootRows.length > 50,
        limits: { depth, maxResults: limit, maxProcessed, relationKinds: [...relationKinds] },
      };
    }

    const root = rootRows[0]!;
    const target = toSymbol(root);
    const relationPlaceholders = relationKinds.map(() => "?").join(", ");
    const nextOrder = direction === "incoming"
      ? "source_file.path, source.start_line, source.name, source.stable_id"
      : "target_file.path, target.start_line, target.name, target.stable_id";
    const edgeQuery = db.prepare(`
      SELECT
        source.id AS sourceId, source.stable_id AS sourceStableId, source.name AS sourceName,
        source.kind AS sourceKind, source_file.path AS sourceFilePath,
        source.start_line AS sourceStartLine, source.end_line AS sourceEndLine,
        target.id AS targetId, target.stable_id AS targetStableId, target.name AS targetName,
        target.kind AS targetKind, target_file.path AS targetFilePath,
        target.start_line AS targetStartLine, target.end_line AS targetEndLine,
        r.kind AS relation, r.confidence AS confidence, r.provenance AS provenance,
        r.index_revision AS indexRevision
      FROM relations r
      JOIN symbols source ON r.source_kind = 'symbol' AND source.id = r.source_id
      JOIN files source_file ON source_file.id = source.file_id
      JOIN symbols target ON r.target_kind = 'symbol' AND target.id = r.target_id
      JOIN files target_file ON target_file.id = target.file_id
      WHERE ${direction === "incoming" ? "r.target_kind = 'symbol' AND r.target_id = ?" : "r.source_kind = 'symbol' AND r.source_id = ?"}
        AND r.kind IN (${relationPlaceholders})
      ORDER BY r.kind, ${nextOrder}
      LIMIT ?
    `);
    type EdgeRow = {
      sourceId: number; sourceStableId: string; sourceName: string; sourceKind: string;
      sourceFilePath: string; sourceStartLine: number; sourceEndLine: number;
      targetId: number; targetStableId: string; targetName: string; targetKind: string;
      targetFilePath: string; targetStartLine: number; targetEndLine: number;
      relation: SymbolImpactRelationKind; confidence: number; provenance: string; indexRevision: number;
    };
    const visited = new Set<number>([root.id]);
    const queue: Array<{ id: number; distance: number; path: SymbolImpactSymbol[]; chainEvidence: SymbolImpactEvidence[] }> = [
      { id: root.id, distance: 0, path: [target], chainEvidence: [] },
    ];
    const results: SymbolImpactHit[] = [];
    let processedRelations = 0;
    let truncated = false;

    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor]!;
      if (current.distance >= depth) continue;
      const remaining = maxProcessed - processedRelations;
      const rows = edgeQuery.all(current.id, ...relationKinds, remaining + 1) as EdgeRow[];
      if (rows.length > remaining) truncated = true;
      for (const row of rows.slice(0, remaining)) {
        processedRelations += 1;
        const source: SymbolImpactSymbol = {
          stableId: row.sourceStableId, name: row.sourceName, kind: row.sourceKind,
          filePath: row.sourceFilePath, startLine: row.sourceStartLine, endLine: row.sourceEndLine,
        };
        const relatedTarget: SymbolImpactSymbol = {
          stableId: row.targetStableId, name: row.targetName, kind: row.targetKind,
          filePath: row.targetFilePath, startLine: row.targetStartLine, endLine: row.targetEndLine,
        };
        const nextId = direction === "incoming" ? row.sourceId : row.targetId;
        const nextSymbol = direction === "incoming" ? source : relatedTarget;
        if (visited.has(nextId)) continue;
        if (results.length >= limit) { truncated = true; break; }
        visited.add(nextId);
        const evidence: SymbolImpactEvidence = {
          relation: row.relation, source, target: relatedTarget,
          confidence: row.confidence, provenance: row.provenance, indexRevision: row.indexRevision,
        };
        const path = [...current.path, nextSymbol];
        const chainEvidence = [...current.chainEvidence, evidence];
        results.push({ ...nextSymbol, distance: current.distance + 1, relation: row.relation, path, chainEvidence });
        queue.push({ id: nextId, distance: current.distance + 1, path, chainEvidence });
      }
      if (truncated && (processedRelations >= maxProcessed || results.length >= limit)) break;
    }

    return {
      target, ambiguous: false, candidates: [], direction, results, processedRelations, truncated,
      limits: { depth, maxResults: limit, maxProcessed, relationKinds: [...relationKinds] },
    };
  } finally {
    db.close();
  }
}
