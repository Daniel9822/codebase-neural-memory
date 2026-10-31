import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { inspectMemoryFreshness, recallMemories } from "../../core/memories.js";
import { getProjectMap, getProjectOverview, searchSymbols, findImpact, findDependencies, getFileDetails } from "../../core/retrieval.js";
import { getIndexFreshness } from "../../core/indexer.js";
import type { ProjectLocation } from "../../core/project.js";

export function startMcpServer(location: ProjectLocation): void {
  serveStdio(() => {
    const server = new McpServer({ name: "codebase-neural-memory", version: "0.1.0" });

    server.registerTool("project_overview", {
      description: "Return the local repository memory index summary.",
      inputSchema: z.object({}),
    }, async () => ({
      content: [{ type: "text", text: JSON.stringify(getProjectOverview(location), null, 2) }],
    }));

    server.registerTool("index_freshness", {
      description: "Compare supported working-tree source files with the local index without modifying it.",
      inputSchema: z.object({}),
    }, async () => ({
      content: [{ type: "text", text: JSON.stringify(getIndexFreshness(location), null, 2) }],
    }));

    server.registerTool("project_map", {
      description: "List indexed source files and their locally resolved imports.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(200).optional() }),
    }, async ({ limit }) => ({
      content: [{ type: "text", text: JSON.stringify(getProjectMap(location, limit ?? 80), null, 2) }],
    }));

    server.registerTool("symbol_lookup", {
      description: "Search indexed symbols. Results explain exact-name, name-term, signature, export, and FTS5 ranking signals.",
      inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(50).optional() }),
    }, async ({ query, limit }) => ({
      content: [{ type: "text", text: JSON.stringify(searchSymbols(location, query, limit ?? 20), null, 2) }],
    }));

    server.registerTool("dependency_graph", {
      description: "Traverse direct or transitive file imports with relation provenance, confidence, depth, dependency chains, and explicit truncation limits.",
      inputSchema: z.object({
        path: z.string().min(1),
        depth: z.number().int().min(1).max(20).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        maxProcessed: z.number().int().min(1).max(10000).optional(),
      }),
    }, async ({ path, depth, limit, maxProcessed }) => ({
      content: [{ type: "text", text: JSON.stringify(
        findDependencies(location, path, depth ?? 1, limit ?? 100, maxProcessed ?? 1000), null, 2,
      ) }],
    }));

    server.registerTool("file_details", {
      description: "Return bounded indexed file metadata, symbols, resolved and unresolved imports, symbol relationships, and relation provenance.",
      inputSchema: z.object({
        path: z.string().min(1),
        limit: z.number().int().min(1).max(500).optional(),
      }),
    }, async ({ path, limit }) => ({
      content: [{ type: "text", text: JSON.stringify(getFileDetails(location, path, limit ?? 100), null, 2) }],
    }));

    server.registerTool("change_impact", {
      description: "Find indexed files that import a target file, recursively, with explicit result and processing limits.",
      inputSchema: z.object({
        path: z.string().min(1),
        limit: z.number().int().min(1).max(5000).optional(),
        maxProcessed: z.number().int().min(1).max(10000).optional(),
      }),
    }, async ({ path, limit, maxProcessed }) => ({
      content: [{ type: "text", text: JSON.stringify(
        findImpact(location, path, limit ?? 100, maxProcessed ?? 1000), null, 2,
      ) }],
    }));

    server.registerTool("memory_freshness", {
      description: "Inspect source files linked to project memories and report changes or missing files without changing memory status.",
      inputSchema: z.object({}),
    }, async () => ({
      content: [{ type: "text", text: JSON.stringify(inspectMemoryFreshness(location), null, 2) }],
    }));

    server.registerTool("memory_recall", {
      description: "Retrieve non-rejected local project memories, including proposed, confirmed, and obsolete entries. Each result includes its lifecycle status; callers must distinguish statuses before using memories as confirmed context.",
      inputSchema: z.object({ query: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }),
    }, async ({ query, limit }) => ({
      content: [{ type: "text", text: JSON.stringify(recallMemories(location, query ?? "", limit ?? 20), null, 2) }],
    }));

    return server;
  });
}
