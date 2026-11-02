import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { getMemoryFreshnessReport, recallMemoriesReport, proposeMemory, transitionMemory, type MemoryStatus } from "../../core/memories.js";
import { getComponentMap, getProjectMapReport, getProjectOverview, searchSymbols, findImpact, findDependencies, findSymbolImpact, getFileDetails, getSourceExcerpt } from "../../core/retrieval.js";
import { getIndexFreshness, updateProjectIndex, type IndexOptions } from "../../core/indexer.js";
import { buildTaskContext } from "../../core/context.js";
import { getGitBlame, getGitHistory } from "../../core/git.js";
import type { ProjectLocation } from "../../core/project.js";

export interface McpServerOptions {
  /** Reconcile a stale index before read operations. Disabled by default. */
  autoUpdate?: boolean;
  /** Refuse indexed reads unless the source/index snapshot is current. */
  strictFreshness?: boolean;
}

type TextBlock = { type: "text"; text: string };
type ToolResponse = { content: TextBlock[]; isError?: boolean };
const MAX_AUTO_UPDATE_FILE_CHANGES = 50;

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

function containsStaleSource(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsStaleSource);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.indexStatus === "stale") return true;
  return Object.values(record).some(containsStaleSource);
}

/** Run a read behind one consistent freshness policy without changing legacy JSON payloads. */
export function readResponse<T>(
  location: ProjectLocation,
  options: McpServerOptions,
  operation: () => T,
): ToolResponse {
  let freshness = getIndexFreshness(location);
  let refreshed = false;
  let autoUpdateSkippedReason: string | undefined;
  let autoUpdateFailureReason: string | undefined;
  if (options.autoUpdate && freshness.status !== "current") {
    if (freshness.status === "incomplete") {
      autoUpdateSkippedReason = "automatic refresh was skipped because file discovery is incomplete; resolve skipped/unreadable files and run index_update manually.";
    } else if (freshness.fileChangesTotal > MAX_AUTO_UPDATE_FILE_CHANGES) {
      autoUpdateSkippedReason = `automatic refresh was skipped because ${freshness.fileChangesTotal} source changes exceed the safety limit of ${MAX_AUTO_UPDATE_FILE_CHANGES}; run index_update explicitly.`;
    } else {
      try {
        updateProjectIndex(location);
        freshness = getIndexFreshness(location);
        refreshed = freshness.status === "current";
        if (!refreshed) {
          autoUpdateFailureReason = `post-update freshness verification returned status "${freshness.status}"; the read will not be treated as current.`;
        }
      } catch (error) {
        autoUpdateFailureReason = error instanceof Error ? error.message : String(error);
        // A failed refresh must never make the pre-refresh snapshot look current.
        // If the database is temporarily unavailable, retain the last known stale report
        // rather than allowing the freshness check itself to bypass strict refusal.
        try {
          freshness = getIndexFreshness(location);
        } catch (freshnessError) {
          const detail = freshnessError instanceof Error ? freshnessError.message : String(freshnessError);
          autoUpdateFailureReason += `; freshness re-check also failed: ${detail}`;
        }
      }
    }
  }
  if (options.strictFreshness && freshness.status !== "current") {
    return {
      isError: true,
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "refused",
          staleness: freshness,
          autoUpdate: {
            attempted: Boolean(options.autoUpdate && !autoUpdateSkippedReason),
            refreshed,
            skippedReason: autoUpdateSkippedReason ?? null,
            failureReason: autoUpdateFailureReason ?? null,
          },
          hint: "Run index_update, resolve any unreadable/skipped files, then retry. Strict freshness never serves an unverified indexed result.",
        }, null, 2),
      }],
    };
  }
  const result = operation();
  let postFreshness: ReturnType<typeof getIndexFreshness> | undefined;
  let postFreshnessFailure: string | undefined;
  try {
    postFreshness = getIndexFreshness(location);
  } catch (error) {
    postFreshnessFailure = error instanceof Error ? error.message : String(error);
  }
  const revisionChanged = postFreshness !== undefined && postFreshness.indexRevision !== freshness.indexRevision;
  const postReadInconsistent = postFreshnessFailure !== undefined ||
    postFreshness === undefined || postFreshness.status !== "current" || revisionChanged;
  if (options.strictFreshness && postReadInconsistent) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "refused",
          staleness: postFreshness ?? null,
          readSnapshot: {
            preflightRevision: freshness.indexRevision,
            postReadRevision: postFreshness?.indexRevision ?? null,
            revisionChanged,
            failureReason: postFreshnessFailure ?? null,
          },
          hint: "The source/index snapshot changed or could not be revalidated during the read. Retry after restoring a current, stable index.",
        }, null, 2),
      }],
    };
  }
  const content: TextBlock[] = [{ type: "text", text: JSON.stringify(result, null, 2) }];
  if (freshness.status !== "current") content.push({ type: "text", text: freshnessWarning(freshness) });
  else if (containsStaleSource(result)) content.push({ type: "text", text: "CNM SOURCE WARNING: at least one inline excerpt hash differs from the indexed hash (indexStatus: stale). The excerpt is actual working-tree text, but indexed metadata may describe older bytes; refresh the index and repeat the read." });
  if (postFreshnessFailure) content.push({ type: "text", text: `CNM POST-READ FRESHNESS WARNING: the post-read snapshot could not be checked (${postFreshnessFailure}); do not treat this result as verified current.` });
  else if (postFreshness && (postFreshness.status !== "current" || revisionChanged) && freshness.status === "current") {
    content.push({ type: "text", text: `CNM POST-READ FRESHNESS WARNING: snapshot consistency changed during the operation (status: ${postFreshness.status}; revision changed: ${revisionChanged}). Repeat the read after refreshing the index.` });
  } else if (revisionChanged) {
    content.push({ type: "text", text: "CNM POST-READ FRESHNESS WARNING: the index revision changed during the operation. The response may span multiple snapshots; repeat the read." });
  }
  if (autoUpdateSkippedReason) content.push({ type: "text", text: `CNM AUTO-UPDATE SKIPPED: ${autoUpdateSkippedReason}` });
  if (autoUpdateFailureReason) content.push({ type: "text", text: `CNM AUTO-UPDATE FAILED: ${autoUpdateFailureReason}. The previous index snapshot was preserved; do not rely on stale indexed results.` });
  if (refreshed && freshness.status === "current") content.push({ type: "text", text: "CNM AUTO-UPDATE: the index was incrementally reconciled and verified before this read." });
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
    description: "Incrementally reconcile the local source index, optionally restricted to project-relative paths or include globs and bounded by file/traversal budgets. maxFiles selects candidates deterministically and reports truncation. If maxProcessed is exceeded, the update aborts without writes rather than committing an enumeration-order-dependent partial selection. Selective updates never perform deletion reconciliation.",
    inputSchema: z.object({
      paths: z.array(z.string().min(1).max(500)).min(1).max(100).optional(),
      include: z.array(z.string().min(1).max(500)).min(1).max(100).optional(),
      maxFiles: z.number().int().min(1).max(10000).optional(),
      maxProcessed: z.number().int().min(1).max(100000).optional(),
    }),
  }, async ({ paths, include, maxFiles, maxProcessed }) => {
    const indexOptions: IndexOptions = {
      ...(paths === undefined ? {} : { paths }),
      ...(include === undefined ? {} : { include }),
      ...(maxFiles === undefined ? {} : { maxFiles }),
      ...(maxProcessed === undefined ? {} : { maxProcessed }),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(updateProjectIndex(location, indexOptions), null, 2) }],
    };
  });

  server.registerTool("component_map", {
    description: "Aggregate indexed file imports into deterministic first-directory groups. Reports directed cross-group import counts and optional shortest dependency distances. Groups are structural directory boundaries, not inferred semantic components.",
    inputSchema: z.object({
      from: z.string().min(1).max(500).optional(),
      depth: z.number().int().min(1).max(20).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      fileLimit: z.number().int().min(1).max(20).optional(),
    }),
  }, async ({ from, depth, limit, fileLimit }) => readResponse(location, options, () =>
    getComponentMap(location, {
      ...(from === undefined ? {} : { from }),
      ...(depth === undefined ? {} : { depth }),
      ...(limit === undefined ? {} : { limit }),
      ...(fileLimit === undefined ? {} : { fileLimit }),
    })));

  server.registerTool("project_map", {
    description: "List indexed source files and their locally resolved imports.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(200).optional() }),
  }, async ({ limit }) => readResponse(location, options, () => getProjectMapReport(location, limit ?? 80)));

  server.registerTool("symbol_lookup", {
    description: "Search indexed symbols with optional kind, project-relative path prefix, and export filters. includeSource returns bounded current source snippets with their own hashes and freshness status.",
    inputSchema: z.object({
      query: z.string().min(1).max(1000),
      limit: z.number().int().min(1).max(50).optional(),
      kind: z.string().min(1).max(40).optional(),
      filePath: z.string().min(1).max(500).optional(),
      exported: z.boolean().optional(),
      includeSource: z.object({ maxLines: z.number().int().min(1).max(100).optional() }).optional(),
    }),
  }, async ({ query, limit, kind, filePath, exported, includeSource }) => readResponse(location, options, () => {
    const normalizedPath = filePath?.replaceAll("\\", "/").replace(/^\.\//, "");
    const results = searchSymbols(location, query, 1000, {
      ...(kind === undefined ? {} : { kind }),
      ...(normalizedPath === undefined ? {} : { filePathPrefix: normalizedPath }),
      ...(exported === undefined ? {} : { exported }),
    }).slice(0, limit ?? 20);
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

  server.registerTool("git_history", {
    description: "Return bounded recent Git commit metadata and changed-path evidence. Commit boundaries do not identify coding sessions, and commit subjects do not prove developer intent.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(50).optional(),
      maxPaths: z.number().int().min(1).max(500).optional(),
    }),
  }, async ({ limit, maxPaths }) => ({
    content: [{
      type: "text",
      text: JSON.stringify(await getGitHistory(location.rootPath, limit ?? 20, maxPaths ?? 200), null, 2),
    }],
  }));

  server.registerTool("git_blame", {
    description: "Read bounded Git line attribution for a tracked project-relative file, including commit, author, date, and summary. This is historical attribution, not proof of why a change was made.",
    inputSchema: z.object({
      path: z.string().min(1).max(500),
      startLine: z.number().int().min(1),
      endLine: z.number().int().min(1),
    }).refine((input) => input.endLine >= input.startLine, {
      message: "endLine must be greater than or equal to startLine",
      path: ["endLine"],
    }).refine((input) => input.endLine - input.startLine < 200, {
      message: "Git blame range cannot exceed 200 lines",
      path: ["endLine"],
    }),
  }, async ({ path, startLine, endLine }) => ({
    content: [{ type: "text", text: JSON.stringify(await getGitBlame(location.rootPath, path, startLine, endLine), null, 2) }],
  }));

  server.registerTool("change_impact", {
    description: "Find indexed files that import a target file, recursively, with explicit result and processing limits.",
    inputSchema: z.object({
      path: z.string().min(1),
      limit: z.number().int().min(1).max(5000).optional(),
      maxProcessed: z.number().int().min(1).max(10000).optional(),
    }),
  }, async ({ path, limit, maxProcessed }) => readResponse(location, options, () =>
    findImpact(location, path, limit ?? 100, maxProcessed ?? 1000)));

  server.registerTool("symbol_impact", {
    description: "Traverse indexed symbol CALLS, EXTENDS, and IMPLEMENTS relationships to find incoming impact or outgoing dependencies with shortest distances, source locations, and per-edge evidence. Ambiguous symbol names are returned as candidates instead of being merged.",
    inputSchema: z.object({
      symbol: z.string().min(1).max(200),
      filePath: z.string().min(1).max(500).optional(),
      kind: z.string().min(1).max(100).optional(),
      startLine: z.number().int().min(1).optional(),
      direction: z.enum(["incoming", "outgoing"]).optional(),
      depth: z.number().int().min(1).max(20).optional(),
      limit: z.number().int().min(1).max(500).optional(),
      maxProcessed: z.number().int().min(1).max(10000).optional(),
      relationKinds: z.array(z.enum(["CALLS", "EXTENDS", "IMPLEMENTS"])).min(1).max(3).optional(),
    }),
  }, async ({ symbol, filePath, kind, startLine, direction, depth, limit, maxProcessed, relationKinds }) => readResponse(location, options, () =>
    findSymbolImpact(location, symbol, {
      ...(filePath === undefined ? {} : { filePath }),
      ...(kind === undefined ? {} : { kind }),
      ...(startLine === undefined ? {} : { startLine }),
      ...(direction === undefined ? {} : { direction }),
      ...(depth === undefined ? {} : { depth }),
      ...(limit === undefined ? {} : { limit }),
      ...(maxProcessed === undefined ? {} : { maxProcessed }),
      ...(relationKinds === undefined ? {} : { relationKinds }),
    })));

  server.registerTool("task_context", {
    description: "Build deterministic, bounded task context from indexed symbols, file relationships, local memories, and matching test paths. Results include ranking signals, lifecycle status, source references, and freshness warnings.",
    inputSchema: z.object({
      task: z.string().min(1),
      maxItems: z.number().int().min(1).max(100).optional(),
      maxCharacters: z.number().int().min(100).max(50000).optional(),
      symbolLimit: z.number().int().min(1).max(50).optional(),
      fileLimit: z.number().int().min(1).max(50).optional(),
      dependencyLimit: z.number().int().min(1).max(50).optional(),
      testLimit: z.number().int().min(1).max(50).optional(),
      memoryLimit: z.number().int().min(1).max(50).optional(),
      anchors: z.object({
        paths: z.array(z.string().min(1).max(500)).max(20).optional(),
        symbols: z.array(z.string().min(1).max(200)).max(20).optional(),
      }).refine((value) => Boolean(value.paths?.length || value.symbols?.length), {
        message: "anchors must include at least one path or symbol.",
      }).optional(),
    }),
  }, async ({ task, maxItems, maxCharacters, symbolLimit, fileLimit, dependencyLimit, testLimit, memoryLimit, anchors }) => readResponse(location, options, () =>
    buildTaskContext(location, task, {
      ...(maxItems === undefined ? {} : { maxItems }),
      ...(maxCharacters === undefined ? {} : { maxCharacters }),
      ...(symbolLimit === undefined ? {} : { symbolLimit }),
      ...(fileLimit === undefined ? {} : { fileLimit }),
      ...(dependencyLimit === undefined ? {} : { dependencyLimit }),
      ...(testLimit === undefined ? {} : { testLimit }),
      ...(memoryLimit === undefined ? {} : { memoryLimit }),
      ...(anchors === undefined ? {} : { anchors: { ...(anchors.paths === undefined ? {} : { paths: anchors.paths }), ...(anchors.symbols === undefined ? {} : { symbols: anchors.symbols }) } }),
    })));

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

  server.registerTool("memory_transition", {
    description: "Apply an explicit lifecycle transition to a project memory. The agent must call status=confirmed only after the user has clearly authorized confirmation; this tool does not infer or grant user approval. Valid transitions are proposed→confirmed/rejected, confirmed→obsolete, and obsolete→confirmed.",
    inputSchema: z.object({
      id: z.string().uuid(),
      status: z.enum(["proposed", "confirmed", "obsolete", "rejected"]),
    }),
  }, async ({ id, status }) => {
    const changed = transitionMemory(location, id, status as MemoryStatus);
    return {
      isError: !changed,
      content: [{ type: "text", text: JSON.stringify({
        id,
        status: changed ? status : "unchanged",
        transitioned: changed,
        requiresExplicitUserAuthorization: status === "confirmed",
      }, null, 2) }],
    };
  });

  server.registerTool("memory_freshness", {
    description: "Inspect source-file fingerprints and referenced Git commit ancestry for project memories without changing memory status.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(500).optional() }),
  }, async ({ limit }) => readResponse(location, options, () => getMemoryFreshnessReport(location, limit ?? 100)));

  server.registerTool("memory_recall", {
    description: "Retrieve project memories using natural-language lexical relevance or list mode. Returns candidate counts and an explicit truncation flag when the bounded recall window may omit eligible memories. Proposed, confirmed, and obsolete entries are discoverable by default; always respect each result's lifecycle status. Optional status/category filters narrow the results.",
    inputSchema: z.object({
      query: z.string().max(1000).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      status: z.enum(["proposed", "confirmed", "obsolete", "rejected"]).optional(),
      category: z.string().min(1).max(80).optional(),
      list: z.boolean().optional(),
    }),
  }, async ({ query, limit, status, category, list }) => readResponse(location, options, () =>
    recallMemoriesReport(location, query ?? "", limit ?? 20, {
      ...(status === undefined ? {} : { statuses: [status] }),
      ...(category === undefined ? {} : { category }),
      ...(list === undefined ? {} : { list }),
    })));

  return server;
}

export function startMcpServer(location: ProjectLocation): void {
  const options: McpServerOptions = {
    autoUpdate: process.env.CNM_MCP_AUTO_UPDATE === "1",
    strictFreshness: process.env.CNM_MCP_STRICT_FRESHNESS === "1",
  };
  serveStdio(() => createMcpServer(location, options));
}
