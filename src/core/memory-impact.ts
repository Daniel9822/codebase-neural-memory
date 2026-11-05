import { openDatabase } from "../storage/database.js";
import type { ProjectLocation } from "./project.js";

export interface MemoryImpactInput {
  knowledgeId: string;
  expectedVersionId?: string | undefined;
  maxDepth?: number | undefined;
  limit?: number | undefined;
  maxChars?: number | undefined;
}

type ImpactRelation = "depends_on" | "derived_from" | "affects" | "supports";
type ImpactPathStep = {
  relationId: string;
  relationType: ImpactRelation;
  fromKnowledgeId: string;
  toKnowledgeId: string;
  meaning: string;
};
type ImpactQueueEntry = {
  knowledgeId: string;
  depth: number;
  path: ImpactPathStep[];
};
type ImpactEdgeRow = {
  relationId: string;
  relationType: ImpactRelation;
  fromKnowledgeId: string;
  toKnowledgeId: string;
  knowledgeId: string;
  currentVersionId: string;
  title: string;
  epistemicState: string;
};

const MAX_EDGE_CANDIDATES = 1000;
const MAX_RESPONSE_CHARS = 12000;

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new Error("Invalid memory impact " + field);
  }
  return value.trim();
}

function relationMeaning(relationType: ImpactRelation): string {
  switch (relationType) {
    case "depends_on": return "dependent knowledge depends on the changed knowledge";
    case "derived_from": return "dependent knowledge was derived from the changed knowledge";
    case "affects": return "the changed knowledge affects this knowledge";
    case "supports": return "the changed knowledge supports this knowledge";
  }
}

/**
 * Discover active knowledge that may need review when one identity changes.
 *
 * This is a read-only, bounded breadth-first traversal. Direction is explicit:
 * depends_on/derived_from are traversed from dependency to dependent; affects
 * and supports are traversed from source to target. Symmetric/ambiguous links
 * such as related_to and contradicts are not treated as dependency edges.
 */
export function getMemoryImpact(location: ProjectLocation, rawInput: MemoryImpactInput) {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    throw new Error("Invalid memory impact input");
  }
  const knowledgeId = requiredText(rawInput.knowledgeId, "knowledgeId", 128);
  const expectedVersionId = rawInput.expectedVersionId === undefined
    ? undefined : requiredText(rawInput.expectedVersionId, "expectedVersionId", 128);
  const maxDepth = rawInput.maxDepth ?? 3;
  const limit = rawInput.limit ?? 50;
  const maxChars = rawInput.maxChars ?? MAX_RESPONSE_CHARS;
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 5) {
    throw new Error("Invalid memory impact maxDepth");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Invalid memory impact limit");
  }
  if (!Number.isInteger(maxChars) || maxChars < 1000 || maxChars > MAX_RESPONSE_CHARS) {
    throw new Error("Invalid memory impact maxChars");
  }

  const db = openDatabase(location);
  try {
    const execute = db.transaction(() => {
      const root = db.prepare(`
        SELECT i.id AS knowledgeId, i.current_version_id AS currentVersionId,
          i.lifecycle, v.title, v.epistemic_state AS epistemicState
        FROM knowledge_items i
        JOIN knowledge_versions v ON v.id=i.current_version_id AND v.knowledge_id=i.id
        WHERE i.id=? AND i.project_id=?
      `).get(knowledgeId, location.id) as {
        knowledgeId: string;
        currentVersionId: string;
        lifecycle: string;
        title: string;
        epistemicState: string;
      } | undefined;
      if (!root) throw new Error("Knowledge item not found in this project");

      const rootResult = {
        knowledgeId: root.knowledgeId,
        currentVersionId: root.currentVersionId,
        lifecycle: root.lifecycle,
        title: root.title.slice(0, 200),
        epistemicState: root.epistemicState,
      };
      if (expectedVersionId !== undefined && expectedVersionId !== root.currentVersionId) {
        return {
          status: "conflict" as const,
          mode: "read_only" as const,
          projectId: location.id,
          root: rootResult,
          expectedVersionId,
          impacted: [],
          totalImpacted: 0,
          returned: 0,
          limit,
          maxDepth,
          truncated: false,
          maxChars,
          serializedChars: 0,
          reason: "The current version changed; rerun impact discovery against the latest version.",
        };
      }

      const queue: ImpactQueueEntry[] = [{ knowledgeId, depth: 0, path: [] }];
      const visited = new Set<string>([knowledgeId]);
      const impacted: Array<{
        knowledgeId: string;
        currentVersionId: string;
        title: string;
        epistemicState: string;
        depth: number;
        path: ImpactPathStep[];
      }> = [];
      let scannedEdges = 0;
      let truncated = false;
      let stop = false;

      const findEdges = db.prepare(`
        SELECT r.id AS relationId, r.relation_type AS relationType,
          CASE WHEN r.relation_type IN ('depends_on','derived_from')
            THEN r.target_knowledge_id ELSE r.source_knowledge_id END AS fromKnowledgeId,
          CASE WHEN r.relation_type IN ('depends_on','derived_from')
            THEN r.source_knowledge_id ELSE r.target_knowledge_id END AS toKnowledgeId,
          impacted.id AS knowledgeId, impacted.current_version_id AS currentVersionId,
          v.title, v.epistemic_state AS epistemicState
        FROM knowledge_relations r
        JOIN knowledge_items source ON source.id=r.source_knowledge_id
          AND source.project_id=r.project_id
        JOIN knowledge_items target ON target.id=r.target_knowledge_id
          AND target.project_id=r.project_id
        JOIN knowledge_items impacted ON impacted.id=CASE
          WHEN r.relation_type IN ('depends_on','derived_from') THEN r.source_knowledge_id
          ELSE r.target_knowledge_id END
          AND impacted.project_id=r.project_id AND impacted.lifecycle='active'
        JOIN knowledge_versions v ON v.id=impacted.current_version_id
          AND v.knowledge_id=impacted.id
        WHERE r.project_id=? AND (
          (r.relation_type IN ('depends_on','derived_from') AND r.target_knowledge_id=?) OR
          (r.relation_type IN ('affects','supports') AND r.source_knowledge_id=?)
        )
        ORDER BY impacted.id COLLATE BINARY ASC, r.relation_type COLLATE BINARY ASC,
          r.id COLLATE BINARY ASC
        LIMIT ?
      `);

      for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
        const current = queue[queueIndex]!;
        if (current.depth >= maxDepth) continue;
        const remainingEdges = MAX_EDGE_CANDIDATES - scannedEdges;
        if (remainingEdges <= 0) {
          truncated = true;
          break;
        }
        const rows = findEdges.all(location.id, current.knowledgeId, current.knowledgeId, remainingEdges + 1) as ImpactEdgeRow[];
        const boundedRows = rows.length > remainingEdges ? rows.slice(0, remainingEdges) : rows;
        if (rows.length > remainingEdges) truncated = true;
        scannedEdges += boundedRows.length;

        for (let edgeIndex = 0; edgeIndex < boundedRows.length; edgeIndex++) {
          const edge = boundedRows[edgeIndex]!;
          if (visited.has(edge.knowledgeId)) continue;
          visited.add(edge.knowledgeId);
          const pathStep: ImpactPathStep = {
            relationId: edge.relationId,
            relationType: edge.relationType,
            fromKnowledgeId: edge.fromKnowledgeId,
            toKnowledgeId: edge.toKnowledgeId,
            meaning: relationMeaning(edge.relationType),
          };
          const path = [...current.path, pathStep];
          impacted.push({
            knowledgeId: edge.knowledgeId,
            currentVersionId: edge.currentVersionId,
            title: edge.title.slice(0, 200),
            epistemicState: edge.epistemicState,
            depth: current.depth + 1,
            path,
          });
          queue.push({ knowledgeId: edge.knowledgeId, depth: current.depth + 1, path });
          if (impacted.length >= limit) {
            const expandableQueueRemains = queue.slice(queueIndex + 1).some(entry => entry.depth < maxDepth);
            if (edgeIndex < boundedRows.length - 1 || expandableQueueRemains) truncated = true;
            stop = true;
            break;
          }
        }
        if (stop) break;
      }

      const result = {
        status: "ready" as const,
        mode: "read_only" as const,
        projectId: location.id,
        root: rootResult,
        impacted,
        totalImpacted: truncated ? null : impacted.length,
        returned: impacted.length,
        limit,
        maxDepth,
        truncated,
        maxChars,
        serializedChars: 0,
      };
      let serialized = JSON.stringify(result).length;
      while (serialized > maxChars && result.impacted.length > 0) {
        result.impacted.pop();
        result.returned = result.impacted.length;
        result.totalImpacted = null;
        result.truncated = true;
        serialized = JSON.stringify(result).length;
      }
      if (serialized > maxChars) throw new Error("Memory impact response metadata exceeds its character budget");
      result.serializedChars = serialized;
      return result;
    });
    return execute.deferred();
  } finally {
    db.close();
  }
}
