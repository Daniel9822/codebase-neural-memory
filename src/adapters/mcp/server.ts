import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { getMemoryFreshnessReport, recallMemories, proposeMemory } from "../../core/memories.js";
import { getProjectMapReport, getProjectOverview, searchSymbols, findImpact, findDependencies, getFileDetails, getSourceExcerpt } from "../../core/retrieval.js";
import { getIndexFreshness, updateProjectIndex } from "../../core/indexer.js";
import { buildTaskContext } from "../../core/context.js";
import type { ProjectLocation } from "../../core/project.js";

export interface McpServerOptions {
  /** Reconcile a stale index before read operations. Disabled by default. */
  autoUpdate?: boolean;
  /** Refuse indexed reads unless the source/index snapshot is current. */
  strictFreshness?: boolean;
}

type TextBlock = { type: "text"; text: string };
type ToolResponse = { content: TextBlock[]; isError?: boolean };

function freshnessWarning(report: ReturnType<typeof getIndexFreshness>): string {
  const paths = report.fileChanges.slice(0, 20).map((change) => change.path);
  const details = paths.length > 0 ? paths.join(", ") : "specific paths unavailable";
  const suffix = report.fileChangesTruncated ? " (path list truncated)" : "";
  return [
    `CNM FRESHNESS WARNING: index status is ${report.status}; indexed results may be outdated or incomplete.`,
    `Changed source files: ${report.changedFiles}; added: ${report.addedFiles}; deleted: ${report.deletedFiles}.`,
    `Affected paths: ${details}${suffix}.`,
    "Run index_update and repeat the read before relying on indexed line ranges, hashes, symbols, or relationships.",
  ].join(" ");
}

/** Run a read behind one consistent freshness policy without changing legacy JSON payloads. */
function readResponse<T>(
  location: ProjectLocation,
  options: McpServerOptions,
  operation: () => T,
): ToolResponse {
  let freshness = getIndexFreshness(location);
  let refreshed = false;
  if (options.autoUpdate && freshness.status !== "current") {
    updateProjectIndex(location);
    freshness = getIndexFreshness(location);
    refreshed = true;
  }
  if (options.strictFreshness && freshness.status !== "current") {
    return {
      isError: true,
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "refused",
          staleness: freshness,
          hint: "Run index_update, resolve any unreadable/skipped files, then retry. Strict freshness never serves an unverified indexed result.",
        }, null, 2),
      }],
    };
  }
  const result = operation();
  const content: TextBlock[] = [{ type: "text", text: JSON.stringify(result, null, 2) }];
  if (freshness.status !== "current") content.push({ type: "text", text: freshnessWarning(freshness) });
  if (refreshed) content.push({ type: "text", text: "CNM AUTO-UPDATE: the index was incrementally reconciled before this read." });
  return { content };
}

/** Create the actual MCP adapter for a project. Exported to exercise the same
 * registration and handlers over the SDK's in-memory transport in tests. */
export function createMcpServer(location: ProjectLocation, options: McpServerOptions = {}): McpServer {
  const server = new McpServer({ name: "codebase-neural-memory", version: "0.1.0" });

  server.registerTool("project_overview", {
    description: "Return the local repository memory index summary. The response includes a separate freshness warning when the source/index snapshot is not current.",
    inputSchema: z.object({}),
  }, async () => readResponse(location, options, () => getProjectOverview(location)));

  server.registerTool("index_freshness", {
    description: "Compare supported working-tree source files with the local index without modifying it. Reports changed paths and old/new SHA-256 hashes.",
    inputSchema: z.object({}),
  }, async () => ({
    content: [{ type: "text", text: JSON.stringify(getIndexFreshness(location), null, 2) }],
  }));

  server.registerTool("index_update", {
    description: "Incrementally reconcile the local source index with the current working tree, preserving the project's configured exclusions. This is an explicit local write operation; unchanged files are skipped.",
    inputSchema: z.object({}),
  }, async () => ({
    content: [{ type: "text", text: JSON.stringify(updateProjectIndex(location), null, 2) }],
  }));

  server.registerTool("project_map", {
    description: "List indexed source files and their locally resolved imports.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(200).optional() }),
  }, async ({ limit }) => readResponse(location, options, () => getProjectMapReport(location, limit ?? 80)));

  server.registerTool("symbol_lookup", {
    description: "Search indexed symbols with optional kind, project-relative path prefix, and export filters. includeSource returns bounded current source snippets with their own hashes and freshness status.",
    inputSchema: z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(50).optional(),
      kind: z.string().min(1).max(40).optional(),
      filePath: z.string().min(1).max(500).optional(),
      exported: z.boolean().optional(),
      includeSource: z.object({ maxLines: z.number().int().min(1).max(100).optional() }).optional(),
    }),
  }, async ({ query, limit, kind, filePath, exported, includeSource }) => readResponse(location, options, () => {
    const normalizedPath = filePath?.replaceAll("\\", "/").replace(/^\.\//, "");
    const results = searchSymbols(location, query, 1000).filter((item) =>
      (kind === undefined || item.kind === kind) &&
      (normalizedPath === undefined || item.filePath === normalizedPath || item.filePath.startsWith(normalizedPath.endsWith("/") ? normalizedPath : normalizedPath + "/")) &&
      (exported === undefined || item.exported === exported),
    ).slice(0, limit ?? 20);
    if (!includeSource) return results;
    const maxLines = includeSource.maxLines ?? 60;
    return results.map((item) => ({
      ...item,
      source: getSourceExcerpt(location, item.filePath, item.startLine, Math.min(item.endLine, item.startLine + maxLines - 1), 8_000),
    }));
  }));

  server.registerTool("dependency_graph", {
    description: "Traverse direct or transitive file imports with relation provenance, confidence, depth, dependency chains, and explicit truncation limits.",
    inputSchema: z.object({
      path: z.string().min(1),
      depth: z.number().int().min(1).max(20).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      maxProcessed: z.number().int().min(1).max(10000).optional(),
    }),
  }, async ({ path, depth, limit, maxProcessed }) => readResponse(location, options, () =>
    findDependencies(location, path, depth ?? 1, limit ?? 100, maxProcessed ?? 1000)));

  server.registerTool("file_details", {
    description: "Return bounded indexed file metadata, symbols, resolved and unresolved imports, symbol relationships, and relation provenance. inlineSnippets adds bounded source for the first snippetLimit symbols.",
    inputSchema: z.object({
      path: z.string().min(1),
      limit: z.number().int().min(1).max(500).optional(),
      inlineSnippets: z.boolean().optional(),
      snippetLimit: z.number().int().min(1).max(10).optional(),
      snippetMaxLines: z.number().int().min(1).max(100).optional(),
    }),
  }, async ({ path, limit, inlineSnippets, snippetLimit, snippetMaxLines }) => readResponse(location, options, () => {
    const details = getFileDetails(location, path, limit ?? 100);
    if (!inlineSnippets) return details;
    const count = Math.min(snippetLimit ?? 3, details.symbols.length);
    const maxLines = snippetMaxLines ?? 60;
    return {
      ...details,
      symbols: details.symbols.map((symbol, index) => index < count ? ({
        ...symbol,
        source: getSourceExcerpt(location, symbol.filePath, symbol.startLine,
          Math.min(symbol.endLine, symbol.startLine + maxLines - 1), 8_000),
      }) : symbol),
      inlineSnippets: { included: count, maxLines },
    };
  }));

  server.registerTool("source_excerpt", {
    description: "Read a bounded line range from an indexed source file inside the project root. Returns current source text, line bounds, SHA-256 freshness against the index, and truncation metadata.",
    inputSchema: z.object({
      path: z.string().min(1),
      startLine: z.number().int().min(1),
      endLine: z.number().int().min(1),
      maxCharacters: z.number().int().min(100).max(20_000).optional(),
    }).refine((input) => input.endLine >= input.startLine, {
      message: "endLine must be greater than or equal to startLine",
      path: ["endLine"],
    }).refine((input) => input.endLine - input.startLine < 200, {
      message: "Source excerpt range cannot exceed 200 lines",
      path: ["endLine"],
    }),
  }, async ({ path, startLine, endLine, maxCharacters }) => readResponse(location, options, () =>
    getSourceExcerpt(location, path, startLine, endLine, maxCharacters ?? 12_000)));

  server.registerTool("change_impact", {
    description: "Find indexed files that import a target file, recursively, with explicit result and processing limits.",
    inputSchema: z.object({
      path: z.string().min(1),
      limit: z.number().int().min(1).max(5000).optional(),
      maxProcessed: z.number().int().min(1).max(10000).optional(),
    }),
  }, async ({ path, limit, maxProcessed }) => readResponse(location, options, () =>
    findImpact(location, path, limit ?? 100, maxProcessed ?? 1000)));

  server.registerTool("task_context", {
    description: "Build deterministic, bounded task context from indexed symbols, file relationships, local memories, and matching test paths. Results include ranking signals, lifecycle status, source references, and freshness warnings.",
    inputSchema: z.object({
      task: z.string().min(1),
      maxItems: z.number().int().min(1).max(100).optional(),
      maxCharacters: z.number().int().min(100).max(50000).optional(),
    }),
  }, async ({ task, maxItems, maxCharacters }) => readResponse(location, options, () =>
    buildTaskContext(location, task, { ...(maxItems === undefined ? {} : { maxItems }), ...(maxCharacters === undefined ? {} : { maxCharacters }) })));

  server.registerTool("memory_propose", {
    description: "Persist an agent-suggested project memory in proposed status. It is never confirmed automatically and requires explicit human review.",
    inputSchema: z.object({
      title: z.string().min(1).max(300),
      content: z.string().min(1).max(10000),
      category: z.string().min(1).max(80).optional(),
      sourcePath: z.string().min(1).max(500).optional(),
      commitSha: z.string().min(1).max(100).optional(),
    }),
  }, async ({ title, content, category, sourcePath, commitSha }) => ({
    content: [{ type: "text", text: JSON.stringify({
      id: proposeMemory(location, title, content, category ?? "decision", sourcePath, commitSha),
      status: "proposed",
      requiresHumanConfirmation: true,
    }, null, 2) }],
  }));

  server.registerTool("memory_freshness", {
    description: "Inspect source-file fingerprints and referenced Git commit ancestry for project memories without changing memory status.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(500).optional() }),
  }, async ({ limit }) => readResponse(location, options, () => getMemoryFreshnessReport(location, limit ?? 100)));

  server.registerTool("memory_recall", {
    description: "Retrieve non-rejected local project memories, including proposed, confirmed, and obsolete entries. Each result includes its lifecycle status; callers must distinguish statuses before using memories as confirmed context.",
    inputSchema: z.object({ query: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }),
  }, async ({ query, limit }) => readResponse(location, options, () =>
    recallMemories(location, query ?? "", limit ?? 20)));

  return server;
}

export function startMcpServer(location: ProjectLocation): void {
  const options: McpServerOptions = {
    autoUpdate: process.env.CNM_MCP_AUTO_UPDATE === "1",
    strictFreshness: process.env.CNM_MCP_STRICT_FRESHNESS === "1",
  };
  serveStdio(() => createMcpServer(location, options));
}
