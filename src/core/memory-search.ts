import { openDatabase, type MemoryDatabase } from "../storage/database.js";
import type { ProjectLocation } from "./project.js";

export type MemoryLifecycle = "active" | "superseded" | "archived";
export type MemoryEpistemicState = "observed" | "verified" | "inferred" | "user_asserted" | "planned" | "hypothesis" | "pending_validation";
export interface MemorySearchInput {
  query: string; limit?: number; maxChars?: number; includeHistorical?: boolean;
  lifecycle?: MemoryLifecycle; type?: string; epistemicState?: MemoryEpistemicState;
  createdAfter?: string; createdBefore?: string; relatedKnowledgeId?: string;
  relationType?: "supports" | "contradicts" | "supersedes" | "depends_on" | "related_to" | "derived_from" | "affects";
}
type SearchRow = {
  knowledgeId: string; versionId: string; type: string; lifecycle: MemoryLifecycle; versionNumber: number;
  title: string; summary: string; epistemicState: MemoryEpistemicState; confidence: number | null;
  createdAt: string; tagsJson: string; aliasesJson: string; snippet: string; rank: number;
  exactId: number; exactTitle: number; exactPath: number; exactSymbol: number; lexicalMatch: number;
  sourcePaths: string; sourceSymbols: string;
};
function parseList(value: string): string[] {
  try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []; }
  catch { return []; }
}
function validDate(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.length > 40 || !Number.isFinite(Date.parse(value))) throw new Error("Invalid memory search " + field);
  return value;
}

/** Lazily create and backfill FTS5 so existing schema-v13 databases upgrade safely. */
export function ensureMemorySearchIndex(db: MemoryDatabase): void {
  const setup = db.transaction(() => {
    db.exec(\`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_search_fts USING fts5(
        knowledge_id UNINDEXED, version_id UNINDEXED, project_id UNINDEXED, knowledge_type UNINDEXED,
        title, summary, body, aliases, tags, source_paths, source_symbols,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS knowledge_items_memory_search_update
      AFTER UPDATE OF current_version_id, tags_json, aliases_json, knowledge_type ON knowledge_items
      WHEN NEW.current_version_id IS NOT NULL
      BEGIN
        DELETE FROM memory_search_fts WHERE version_id = NEW.current_version_id;
        INSERT INTO memory_search_fts(
          knowledge_id, version_id, project_id, knowledge_type, title, summary, body, aliases, tags, source_paths, source_symbols
        )
        SELECT NEW.id, v.id, NEW.project_id, NEW.knowledge_type, v.title, v.summary,
          COALESCE((SELECT group_concat(heading || ' ' || summary || ' ' || content, ' ') FROM knowledge_fragments WHERE version_id = v.id), ''),
          REPLACE(NEW.aliases_json, '"', ' '), REPLACE(NEW.tags_json, '"', ' '),
          COALESCE((SELECT group_concat(source_path, ' ') FROM knowledge_evidence WHERE version_id = v.id AND source_path IS NOT NULL), ''),
          COALESCE((SELECT group_concat(source_symbol, ' ') FROM knowledge_evidence WHERE version_id = v.id AND source_symbol IS NOT NULL), '')
        FROM knowledge_versions v WHERE v.id = NEW.current_version_id AND v.knowledge_id = NEW.id;
      END;
    \`);
    db.exec(\`
      INSERT INTO memory_search_fts(
        knowledge_id, version_id, project_id, knowledge_type, title, summary, body, aliases, tags, source_paths, source_symbols
      )
      SELECT i.id, v.id, i.project_id, i.knowledge_type, v.title, v.summary,
        COALESCE((SELECT group_concat(heading || ' ' || summary || ' ' || content, ' ') FROM knowledge_fragments WHERE version_id = v.id), ''),
        REPLACE(i.aliases_json, '"', ' '), REPLACE(i.tags_json, '"', ' '),
        COALESCE((SELECT group_concat(source_path, ' ') FROM knowledge_evidence WHERE version_id = v.id AND source_path IS NOT NULL), ''),
        COALESCE((SELECT group_concat(source_symbol, ' ') FROM knowledge_evidence WHERE version_id = v.id AND source_symbol IS NOT NULL), '')
      FROM knowledge_items i JOIN knowledge_versions v ON v.knowledge_id = i.id
      WHERE NOT EXISTS (SELECT 1 FROM memory_search_fts f WHERE f.version_id = v.id)
      ORDER BY i.project_id, i.id, v.version_number;
    \`);
  });
  setup.immediate();
}

/** Search immutable knowledge versions with bounded FTS5 ranking and explicit match evidence. */
export function searchMemories(location: ProjectLocation, input: MemorySearchInput) {
  if (!input || typeof input !== "object") throw new Error("Invalid memory search input");
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query || query.length > 1000) throw new Error("Memory search query must contain 1–1000 characters");
  const tokens = [...new Set(query.normalize("NFKC").match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 12);
  if (tokens.length === 0) throw new Error("Memory search query must contain searchable letters or numbers");
  const matchExpression = tokens.map((token) => '"' + token.replaceAll('"', '""') + '"*').join(" OR ");
  const limit = input.limit ?? 20, maxChars = input.maxChars ?? 12000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Invalid memory search limit");
  if (!Number.isInteger(maxChars) || maxChars < 1000 || maxChars > 20000) throw new Error("Invalid memory search maxChars");
  if (input.lifecycle !== undefined && !["active", "superseded", "archived"].includes(input.lifecycle)) throw new Error("Invalid memory search lifecycle");
  if (input.type !== undefined && (!input.type.trim() || input.type.length > 64)) throw new Error("Invalid memory search type");
  const states = ["observed", "verified", "inferred", "user_asserted", "planned", "hypothesis", "pending_validation"];
  if (input.epistemicState !== undefined && !states.includes(input.epistemicState)) throw new Error("Invalid memory search epistemicState");
  if (input.relatedKnowledgeId !== undefined && (!input.relatedKnowledgeId.trim() || input.relatedKnowledgeId.length > 128)) throw new Error("Invalid memory search relatedKnowledgeId");
  if (input.relationType !== undefined && !["supports", "contradicts", "supersedes", "depends_on", "related_to", "derived_from", "affects"].includes(input.relationType)) throw new Error("Invalid memory search relationType");
  if (input.relationType !== undefined && input.relatedKnowledgeId === undefined) throw new Error("relationType requires relatedKnowledgeId");
  const createdAfter = validDate(input.createdAfter, "createdAfter"), createdBefore = validDate(input.createdBefore, "createdBefore");
  if (createdAfter && createdBefore && createdAfter > createdBefore) throw new Error("createdAfter must not be later than createdBefore");

  const db = openDatabase(location);
  try {
    ensureMemorySearchIndex(db);
    const where = [
      "memory_search_fts.project_id = ?",
      "(memory_search_fts MATCH ? OR i.id = ? OR EXISTS (SELECT 1 FROM knowledge_evidence e WHERE e.version_id = v.id AND (e.source_path = ? OR e.source_symbol = ?)))",
      "(? = 1 OR v.id = i.current_version_id)",
      "i.lifecycle = COALESCE(?, 'active')",
      "(? IS NULL OR i.knowledge_type = ?)",
      "(? IS NULL OR v.epistemic_state = ?)",
      "(? IS NULL OR v.created_at >= ?)",
      "(? IS NULL OR v.created_at <= ?)",
      "(? IS NULL OR EXISTS (SELECT 1 FROM knowledge_relations r WHERE r.project_id = i.project_id AND ((r.source_knowledge_id = i.id AND r.target_knowledge_id = ?) OR (r.target_knowledge_id = i.id AND r.source_knowledge_id = ?)) AND (? IS NULL OR r.relation_type = ?)))"
    ];
    const params = [
      location.id, matchExpression || '""', query, query, query,
      input.includeHistorical ? 1 : 0, input.lifecycle ?? null,
      input.type ?? null, input.type ?? null, input.epistemicState ?? null, input.epistemicState ?? null,
      createdAfter ?? null, createdAfter ?? null, createdBefore ?? null, createdBefore ?? null,
      input.relatedKnowledgeId ?? null, input.relatedKnowledgeId ?? "", input.relatedKnowledgeId ?? "",
      input.relationType ?? null, input.relationType ?? null
    ];
    const from = " FROM memory_search_fts JOIN knowledge_items i ON i.id=memory_search_fts.knowledge_id AND i.project_id=memory_search_fts.project_id JOIN knowledge_versions v ON v.id=memory_search_fts.version_id AND v.knowledge_id=i.id WHERE " + where.join(" AND ");
    const totalMatches = (db.prepare("SELECT COUNT(*) AS count" + from).get(...params) as { count: number }).count;
    const rows = db.prepare(\`
      SELECT i.id AS knowledgeId, v.id AS versionId, i.knowledge_type AS type, i.lifecycle,
        v.version_number AS versionNumber, v.title, v.summary, v.epistemic_state AS epistemicState,
        v.confidence, v.created_at AS createdAt, i.tags_json AS tagsJson, i.aliases_json AS aliasesJson,
        snippet(memory_search_fts, 6, '[', ']', ' … ', 16) AS snippet,
        bm25(memory_search_fts, 0, 0, 0, 0, 8, 5, 1, 7, 5, 6, 7) AS rank,
        CASE WHEN memory_search_fts MATCH ? THEN 1 ELSE 0 END AS lexicalMatch,
        CASE WHEN i.id = ? THEN 1 ELSE 0 END AS exactId,
        CASE WHEN lower(v.title) = lower(?) THEN 1 ELSE 0 END AS exactTitle,
        CASE WHEN EXISTS (SELECT 1 FROM knowledge_evidence e WHERE e.version_id=v.id AND e.source_path=?) THEN 1 ELSE 0 END AS exactPath,
        CASE WHEN EXISTS (SELECT 1 FROM knowledge_evidence e WHERE e.version_id=v.id AND e.source_symbol=?) THEN 1 ELSE 0 END AS exactSymbol,
        COALESCE((SELECT group_concat(source_path, ', ') FROM knowledge_evidence WHERE version_id=v.id AND source_path IS NOT NULL), '') AS sourcePaths,
        COALESCE((SELECT group_concat(source_symbol, ', ') FROM knowledge_evidence WHERE version_id=v.id AND source_symbol IS NOT NULL), '') AS sourceSymbols
      \${from}
      ORDER BY exactId DESC, exactTitle DESC, exactPath DESC, exactSymbol DESC, rank ASC,
        v.created_at DESC, i.id ASC, v.version_number DESC
      LIMIT ?
    \`).all(...params, query, query, query, query, limit + 1) as SearchRow[];
    const results = rows.slice(0, limit).map((row) => {
      const matchedBy: string[] = [];
      if (row.exactId) matchedBy.push("exact-knowledge-id");
      if (row.exactTitle) matchedBy.push("exact-title");
      if (row.exactPath) matchedBy.push("exact-source-path");
      if (row.exactSymbol) matchedBy.push("exact-source-symbol");
      if (row.lexicalMatch) matchedBy.push("lexical");
      return {
        knowledgeId: row.knowledgeId, versionId: row.versionId, type: row.type, lifecycle: row.lifecycle,
        versionNumber: row.versionNumber, title: row.title, summary: row.summary,
        epistemicState: row.epistemicState, confidence: row.confidence, createdAt: row.createdAt,
        tags: parseList(row.tagsJson), aliases: parseList(row.aliasesJson),
        sourcePaths: row.sourcePaths ? row.sourcePaths.split(", ").slice(0, 3) : [],
        sourceSymbols: row.sourceSymbols ? row.sourceSymbols.split(", ").slice(0, 3) : [],
        snippet: row.snippet.slice(0, 500), matchedBy, relevance: Number((-row.rank).toFixed(6))
      };
    });
    const buildResult = () => ({ query, results, returned: results.length, totalMatches, limit, maxChars,
      serializedChars: 0, truncated: results.length < totalMatches, includeHistorical: input.includeHistorical ?? false,
      sourceEvidenceFreshness: "not_checked" as const });
    let serializedChars = JSON.stringify(buildResult()).length;
    while (results.length && serializedChars > maxChars) {
      results.pop();
      serializedChars = JSON.stringify(buildResult()).length;
    }
    return { ...buildResult(), serializedChars: JSON.stringify(buildResult()).length };
  } finally { db.close(); }
}
