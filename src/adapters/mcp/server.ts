import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { recallMemories } from "../../core/memories.js";
import { getProjectMap, getProjectOverview, searchSymbols, findImpact } from "../../core/retrieval.js";
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

    server.registerTool("project_map", {
      description: "List indexed source files and their locally resolved imports.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(200).optional() }),
    }, async ({ limit }) => ({
      content: [{ type: "text", text: JSON.stringify(getProjectMap(location, limit ?? 80), null, 2) }],
    }));

    server.registerTool("symbol_lookup", {
      description: "Search indexed functions, classes, interfaces, and types.",
      inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(50).optional() }),
    }, async ({ query, limit }) => ({
      content: [{ type: "text", text: JSON.stringify(searchSymbols(location, query, limit ?? 20), null, 2) }],
    }));

    server.registerTool("change_impact", {
      description: "Find indexed files that import a target file, recursively.",
      inputSchema: z.object({ path: z.string().min(1) }),
    }, async ({ path }) => ({
      content: [{ type: "text", text: JSON.stringify({ path, affectedFiles: findImpact(location, path) }, null, 2) }],
    }));

    server.registerTool("memory_recall", {
      description: "Retrieve confirmed local project decisions and notes.",
      inputSchema: z.object({ query: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }),
    }, async ({ query, limit }) => ({
      content: [{ type: "text", text: JSON.stringify(recallMemories(location, query ?? "", limit ?? 20), null, 2) }],
    }));

    return server;
  });
}
