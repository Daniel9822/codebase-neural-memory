import { createHash } from "node:crypto";
import { openDatabase, type MemoryDatabase } from "../storage/database.js";
import type { ProjectLocation } from "./project.js";

export type MemoryLifecycle = "active" | "superseded" | "archived";
export type MemoryEpistemicState = "observed" | "verified" | "inferred" | "user_asserted" | "planned" | "hypothesis" | "pending_validation";
export interface MemorySearchInput {
  query?: string | undefined;
  limit?: number | undefined;
  maxChars?: number | undefined;
  includeHistorical?: boolean | undefined;
  lifecycle?: MemoryLifecycle | undefined;
  type?: string | undefined;
  tag?: string | undefined;
  path?: string | undefined;
  symbol?: string | undefined;
  epistemicState?: MemoryEpistemicState | undefined;
  createdAfter?: string | undefined;
  createdBefore?: string | undefined;
  relatedKnowledgeId?: string | undefined;
  relationType?: "supports" | "contradicts" | "supersedes" | "depends_on" | "related_to" | "derived_from" | "affects" | undefined;
  cursor?: string | undefined;
}
type SearchRow = {
  knowledgeId: string; versionId: string; type: string; lifecycle: MemoryLifecycle; versionNumber: number;
  title: string; summary: string; epistemicState: MemoryEpistemicState; confidence: number | null;
  createdAt: string; tagsJson: string; aliasesJson: string; snippet: string | null; rank: number | null;
  exactId: number; exactTitle: number; exactPath: number; exactSymbol: number;
  sourcePaths: string; sourceSymbols: string;
};
function parseList(value: string): string[] {
  try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []; }
  catch { return []; }
}
function validDate(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.length > 40 || !Number.isFinite(Date.parse(value))) throw new Error("Invalid memory search " + field);
  return new Date(value).toISOString();
}
function encodeCursor(payload: { offset: number; filterHash: string; snapshotHash: string }): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}
function decodeCursor(cursor: string): { offset: number; filterHash: string; snapshotHash: string } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("Invalid cursor");
    const value = parsed as Record<string, unknown>;
    if (!Number.isInteger(value.offset) || (value.offset as number) < 0 || (value.offset as number) > 100000 ||
      typeof value.filterHash !== "string" || typeof value.snapshotHash !== "string") throw new Error("Invalid cursor");
    return { offset: value.offset as number, filterHash: value.filterHash, snapshotHash: value.snapshotHash };
  } catch {
    throw new Error("Invalid memory search cursor");
  }
}

/** Lazily create and backfill FTS5 so existing schema-v13 databases upgrade safely. */
export function ensureMemorySearchIndex(db: MemoryDatabase): void {
  const setup = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_search_indexed_versions (version_id TEXT PRIMARY KEY);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_search_fts USING fts5(
        knowledge_id, version_id UNINDEXED, project_id UNINDEXED, knowledge_type,
        title, summary, body, aliases, tags, source_paths, source_symbols,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS knowledge_items_memory_search_update
      AFTER UPDATE OF current_version_id, tags_json, aliases_json, knowledge_type ON knowledge_items
      WHEN NEW.current_version_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM memory_search_indexed_versions WHERE version_id = NEW.current_version_id)
      BEGIN
        INSERT INTO memory_search_fts(
          knowledge_id, version_id, project_id, knowledge_type, title, summary, body, aliases, tags, source_paths, source_symbols
        )
        SELECT NEW.id, v.id, NEW.project_id, NEW.knowledge_type, v.title, v.summary,
          COALESCE((SELECT group_concat(heading || ' ' || summary || ' ' || content, ' ') FROM knowledge_fragments WHERE version_id = v.id), ''),
          REPLACE(NEW.aliases_json, '"', ' '), REPLACE(NEW.tags_json, '"', ' '),
          COALESCE((SELECT group_concat(source_path, ' ') FROM knowledge_evidence WHERE version_id = v.id AND source_path IS NOT NULL), ''),
          COALESCE((SELECT group_concat(source_symbol, ' ') FROM knowledge_evidence WHERE version_id = v.id AND source_symbol IS NOT NULL), '')
        FROM knowledge_versions v WHERE v.id = NEW.current_version_id AND v.knowledge_id = NEW.id;
        INSERT OR IGNORE INTO memory_search_indexed_versions(version_id)
          SELECT v.id FROM knowledge_versions v WHERE v.id = NEW.current_version_id AND v.knowledge_id = NEW.id;
      END;
    `);
    db.exec(`
      INSERT INTO memory_search_fts(
        knowledge_id, version_id, project_id, knowledge_type, title, summary, body, aliases, tags, source_paths, source_symbols
      )
      SELECT i.id, v.id, i.project_id, i.knowledge_type, v.title, v.summary,
        COALESCE((SELECT group_concat(heading || ' ' || summary || ' ' || content, ' ') FROM knowledge_fragments WHERE version_id = v.id), ''),
        REPLACE(i.aliases_json, '"', ' '), REPLACE(i.tags_json, '"', ' '),
        COALESCE((SELECT group_concat(source_path, ' ') FROM knowledge_evidence WHERE version_id = v.id AND source_path IS NOT NULL), ''),
        COALESCE((SELECT group_concat(source_symbol, ' ') FROM knowledge_evidence WHERE version_id = v.id AND source_symbol IS NOT NULL), '')
      FROM knowledge_items i JOIN knowledge_versions v ON v.knowledge_id = i.id
      WHERE NOT EXISTS (SELECT 1 FROM memory_search_indexed_versions f WHERE f.version_id = v.id)
      ORDER BY i.project_id, i.id, v.version_number;
      INSERT OR IGNORE INTO memory_search_indexed_versions(version_id)
        SELECT f.version_id FROM memory_search_fts f;
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (14, datetime('now'));
    `);
  });
  setup.immediate();
}

/** Search/browse immutable project knowledge with bounded FTS5 ranking and snapshot-bound pagination. */
export function searchMemories(location: ProjectLocation, input: MemorySearchInput = {}) {
  if (!input || typeof input !== "object") throw new Error("Invalid memory search input");
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (query.length > 1000) throw new Error("Memory search query exceeds 1000 characters");
  const tokens = [...new Set(query.normalize("NFKC").match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 12);
  if (query && tokens.length === 0) throw new Error("Memory search query must contain searchable letters or numbers");
  const structuredQuery = query.includes("/") || query.includes("\\") || /^knowledge:/i.test(query) ||
    /^[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+$/u.test(query);
  const matchExpression = tokens.map((token) => '"' + token.replaceAll('"', '""') + '"*').join(structuredQuery ? " AND " : " OR ");
  const searching = query.length > 0;
  const limit = input.limit ?? 10, maxChars = input.maxChars ?? 12000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Invalid memory search limit");
  if (!Number.isInteger(maxChars) || maxChars < 500 || maxChars > 12000) throw new Error("Invalid memory search maxChars");
  if (input.includeHistorical !== undefined && typeof input.includeHistorical !== "boolean") throw new Error("Invalid memory search includeHistorical");
  if (input.lifecycle !== undefined && !["active", "superseded", "archived"].includes(input.lifecycle)) throw new Error("Invalid memory search lifecycle");
  const validateFilter = (value: string | undefined, field: string, max: number) => {
    if (value !== undefined && (!value.trim() || value.length > max)) throw new Error("Invalid memory search " + field);
  };
  validateFilter(input.type, "type", 64);
  validateFilter(input.tag, "tag", 64);
  validateFilter(input.path, "path", 1024);
  validateFilter(input.symbol, "symbol", 512);
  if (input.path && (input.path.startsWith("/") || input.path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(input.path) || input.path.split(/[\\/]/).includes(".."))) {
    throw new Error("Memory search path must be project-relative");
  }
  const states = ["observed", "verified", "inferred", "user_asserted", "planned", "hypothesis", "pending_validation"];
  if (input.epistemicState !== undefined && !states.includes(input.epistemicState)) throw new Error("Invalid memory search epistemicState");
  if (input.relatedKnowledgeId !== undefined && (!input.relatedKnowledgeId.trim() || input.relatedKnowledgeId.length > 128)) throw new Error("Invalid memory search relatedKnowledgeId");
  if (input.relationType !== undefined && !["supports", "contradicts", "supersedes", "depends_on", "related_to", "derived_from", "affects"].includes(input.relationType)) throw new Error("Invalid memory search relationType");
  if (input.relationType !== undefined && input.relatedKnowledgeId === undefined) throw new Error("relationType requires relatedKnowledgeId");
  if (input.cursor !== undefined && (!input.cursor || input.cursor.length > 2048)) throw new Error("Invalid memory search cursor");
  const createdAfter = validDate(input.createdAfter, "createdAfter"), createdBefore = validDate(input.createdBefore, "createdBefore");
  if (createdAfter && createdBefore && createdAfter > createdBefore) throw new Error("createdAfter must not be later than createdBefore");

  const db = openDatabase(location);
  try {
    ensureMemorySearchIndex(db);
    const snapshot = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM knowledge_items WHERE project_id = ?) AS itemCount,
        (SELECT COALESCE(MAX(updated_at), '') FROM knowledge_items WHERE project_id = ?) AS itemUpdated,
        (SELECT COUNT(*) FROM knowledge_relations WHERE project_id = ?) AS relationCount,
        (SELECT COALESCE(MAX(created_at), '') FROM knowledge_relations WHERE project_id = ?) AS relationCreated
    `).get(location.id, location.id, location.id, location.id) as Record<string, number | string>;
    const snapshotHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    const filterHash = createHash("sha256").update(JSON.stringify({
      projectId: location.id, query, includeHistorical: input.includeHistorical ?? false, lifecycle: input.lifecycle ?? "active",
      type: input.type ?? null, tag: input.tag ?? null, path: input.path ?? null, symbol: input.symbol ?? null,
      epistemicState: input.epistemicState ?? null, createdAfter: createdAfter ?? null, createdBefore: createdBefore ?? null,
      relatedKnowledgeId: input.relatedKnowledgeId ?? null, relationType: input.relationType ?? null, limit, maxChars
    })).digest("hex");
    let offset = 0;
    if (input.cursor) {
      const cursor = decodeCursor(input.cursor);
      if (cursor.filterHash !== filterHash) throw new Error("Memory search cursor does not match the query or filters");
      if (cursor.snapshotHash !== snapshotHash) throw new Error("Memory search cursor is stale; restart from the first page");
      offset = cursor.offset;
    }

    const where = ["memory_search_fts.project_id = ?", "i.lifecycle = COALESCE(?, 'active')", "(? = 1 OR v.id = i.current_version_id)"];
    const whereParams: Array<string | number | null> = [
      location.id, input.lifecycle ?? null, input.includeHistorical ? 1 : 0
    ];
    if (searching) { where.push("memory_search_fts MATCH ?"); whereParams.push(matchExpression); }
    if (input.type !== undefined) { where.push("i.knowledge_type = ?"); whereParams.push(input.type.trim()); }
    if (input.tag !== undefined) {
      where.push("EXISTS (SELECT 1 FROM json_each(i.tags_json) AS tag_filter WHERE tag_filter.value = ?)");
      whereParams.push(input.tag.trim());
    }
    if (input.path !== undefined) {
      where.push("EXISTS (SELECT 1 FROM knowledge_evidence e WHERE e.version_id = v.id AND e.source_path = ?)");
      whereParams.push(input.path.replaceAll("\\", "/"));
    }
    if (input.symbol !== undefined) {
      where.push("EXISTS (SELECT 1 FROM knowledge_evidence e WHERE e.version_id = v.id AND e.source_symbol = ?)");
      whereParams.push(input.symbol.trim());
    }
    if (input.epistemicState !== undefined) { where.push("v.epistemic_state = ?"); whereParams.push(input.epistemicState); }
    if (createdAfter !== undefined) { where.push("v.created_at >= ?"); whereParams.push(createdAfter); }
    if (createdBefore !== undefined) { where.push("v.created_at <= ?"); whereParams.push(createdBefore); }
    if (input.relatedKnowledgeId !== undefined) {
      where.push("EXISTS (SELECT 1 FROM knowledge_relations r WHERE r.project_id = i.project_id AND ((r.source_knowledge_id = i.id AND r.target_knowledge_id = ?) OR (r.target_knowledge_id = i.id AND r.source_knowledge_id = ?)) AND (? IS NULL OR r.relation_type = ?))");
      whereParams.push(input.relatedKnowledgeId, input.relatedKnowledgeId, input.relationType ?? null, input.relationType ?? null);
    }
    const from = " FROM memory_search_fts JOIN knowledge_items i ON i.id=memory_search_fts.knowledge_id AND i.project_id=memory_search_fts.project_id JOIN knowledge_versions v ON v.id=memory_search_fts.version_id AND v.knowledge_id=i.id WHERE " + where.join(" AND ");
    const candidateLimit = 1000;
    const exactPath = input.path ?? (query.includes("/") || query.includes("\\") ? query.replaceAll("\\", "/") : "");
    const exactSymbol = input.symbol ?? query;
    const rows = db.prepare(`
      SELECT i.id AS knowledgeId, v.id AS versionId, i.knowledge_type AS type, i.lifecycle,
        v.version_number AS versionNumber, v.title, v.summary, v.epistemic_state AS epistemicState,
        v.confidence, v.created_at AS createdAt, i.tags_json AS tagsJson, i.aliases_json AS aliasesJson,
        CASE WHEN ? = 1 THEN snippet(memory_search_fts, 6, '[', ']', ' … ', 16)
          ELSE COALESCE(NULLIF(v.summary, ''), (SELECT substr(content, 1, 320) FROM knowledge_fragments WHERE version_id = v.id ORDER BY ordinal LIMIT 1), '') END AS snippet,
        CASE WHEN ? = 1 THEN bm25(memory_search_fts, 0, 0, 0, 3, 8, 5, 1, 7, 5, 6, 7) ELSE 0 END AS rank,
        CASE WHEN i.id = ? AND ? = 1 THEN 1 ELSE 0 END AS exactId,
        CASE WHEN lower(v.title) = lower(?) AND ? = 1 THEN 1 ELSE 0 END AS exactTitle,
        CASE WHEN EXISTS (SELECT 1 FROM knowledge_evidence e WHERE e.version_id=v.id AND e.source_path=?) THEN 1 ELSE 0 END AS exactPath,
        CASE WHEN EXISTS (SELECT 1 FROM knowledge_evidence e WHERE e.version_id=v.id AND e.source_symbol=?) THEN 1 ELSE 0 END AS exactSymbol,
        COALESCE((SELECT group_concat(source_path, ', ') FROM knowledge_evidence WHERE version_id=v.id AND source_path IS NOT NULL), '') AS sourcePaths,
        COALESCE((SELECT group_concat(source_symbol, ', ') FROM knowledge_evidence WHERE version_id=v.id AND source_symbol IS NOT NULL), '') AS sourceSymbols
      ${from}
      ORDER BY exactId DESC, exactTitle DESC, exactPath DESC, exactSymbol DESC, rank ASC,
        CASE v.epistemic_state WHEN 'verified' THEN 0 WHEN 'user_asserted' THEN 1 WHEN 'observed' THEN 2
          WHEN 'inferred' THEN 3 WHEN 'pending_validation' THEN 4 WHEN 'hypothesis' THEN 5 ELSE 6 END,
        v.created_at DESC, i.id ASC, v.version_number DESC
      LIMIT ? OFFSET ?
    `).all(searching ? 1 : 0, searching ? 1 : 0, query, searching ? 1 : 0, query, searching ? 1 : 0,
      exactPath, exactSymbol, ...whereParams, candidateLimit + 1, offset) as SearchRow[];
    const candidateWindowTruncated = rows.length > candidateLimit;
    const candidates = rows.slice(0, candidateLimit);
    const results = candidates.slice(0, limit).map((row) => {
      const matchedBy: string[] = [];
      if (row.exactId) matchedBy.push("exact-knowledge-id");
      if (row.exactTitle) matchedBy.push("exact-title");
      if (row.exactPath) matchedBy.push("exact-source-path");
      if (row.exactSymbol) matchedBy.push("exact-source-symbol");
      if (searching && (row.exactTitle || (!row.exactId && !row.exactPath && !row.exactSymbol))) matchedBy.push("lexical");
      if (input.type) matchedBy.push("type-filter");
      if (input.tag) matchedBy.push("tag-filter");
      if (input.path) matchedBy.push("path-filter");
      if (input.symbol) matchedBy.push("symbol-filter");
      if (input.epistemicState) matchedBy.push("epistemic-filter");
      if (input.relatedKnowledgeId) matchedBy.push("relation-filter");
      if (!searching && matchedBy.length === 0) matchedBy.push("high-value-current-browse");
      return {
        knowledgeId: row.knowledgeId, versionId: row.versionId, type: row.type, lifecycle: row.lifecycle,
        versionNumber: row.versionNumber, title: row.title, summary: row.summary,
        epistemicState: row.epistemicState, confidence: row.confidence, createdAt: row.createdAt,
        tags: parseList(row.tagsJson), aliases: parseList(row.aliasesJson),
        sourcePaths: row.sourcePaths ? row.sourcePaths.split(", ").slice(0, 3) : [],
        sourceSymbols: row.sourceSymbols ? row.sourceSymbols.split(", ").slice(0, 3) : [],
        snippet: (row.snippet ?? "").slice(0, 500), matchedBy, relevance: Number((-(row.rank ?? 0)).toFixed(6))
      };
    });
    const buildResult = () => {
      const hasMore = candidates.length > results.length || candidateWindowTruncated;
      return {
        query: query.slice(0, 128), queryTruncated: query.length > 128, browsing: !searching, results, returned: results.length,
        totalMatches: offset === 0 && !candidateWindowTruncated ? candidates.length : null,
        candidateCount: candidates.length, candidateWindow: candidateLimit, candidateWindowTruncated,
        limit, maxChars, serializedChars: 0,
        truncated: hasMore,
        nextCursor: hasMore && results.length > 0 ? encodeCursor({ offset: offset + results.length, filterHash, snapshotHash }) : undefined,
        includeHistorical: input.includeHistorical ?? false,
        sourceEvidenceFreshness: "not_checked" as const,
        budgetExceeded: results.length === 0 && candidates.length > 0
      };
    };
    const finalize = () => {
      const value = buildResult();
      for (let attempt = 0; attempt < 3; attempt++) value.serializedChars = JSON.stringify(value, null, 2).length;
      return value;
    };
    let finalResult = finalize();
    while (finalResult.serializedChars > maxChars && results.length > 0) {
      results.pop();
      finalResult = finalize();
    }
    return finalResult;
  } finally { db.close(); }
}
