#!/usr/bin/env node
import { Command } from "commander";
import { mkdirSync } from "node:fs";
import { basename } from "node:path";
import { ensureProject, openDatabase } from "../storage/database.js";
import { getProjectLocation, resolveProjectRoot } from "../core/project.js";
import { getIndexFreshness, indexProject } from "../core/indexer.js";
import { explainSymbol, getComponentMap, findDependencies, findImpact, findSymbolImpact, getFileDetails, getProjectMapReport, getProjectOverview, getSymbolRelations, searchSymbols } from "../core/retrieval.js";
import { deleteMemory, inspectMemoryFreshness, proposeMemory, recallMemories, remember, transitionMemory, updateMemory, type MemoryStatus } from "../core/memories.js";
import { startMcpServer } from "../adapters/mcp/server.js";
import { parsePositiveInteger } from "../shared/validation.js";
import { buildTaskContext } from "../core/context.js";
import { getGitBlame } from "../core/git.js";
import { checkAgentInstructions, ensureAgentInstructions, renderAgentInstructions, type AgentTool } from "../core/agents-md.js";

const program = new Command();

function currentLocation() {
  const root = resolveProjectRoot(process.cwd());
  return getProjectLocation(root);
}

function ensureInitialized() {
  const location = currentLocation();
  const db = openDatabase(location);
  try {
    const row = db.prepare("SELECT id FROM projects WHERE id = ?").get(location.id);
    if (!row) throw new Error("This repository is not initialized. Run `cnm init` first.");
  } finally {
    db.close();
  }
  return location;
}

program
  .name("cnm")
  .description("Local-first structural memory for software repositories and coding agents.")
  .version("0.1.0");

program.command("init")
  .description("Initialize private local memory for the current repository.")
  .action(() => {
    const location = currentLocation();
    mkdirSync(location.dataDirectory, { recursive: true });
    const db = openDatabase(location);
    try { ensureProject(db, location); } finally { db.close(); }
    console.log(`Initialized memory for ${basename(location.rootPath)}.`);
    console.log(`Private database: ${location.databasePath}`);
    const agentInstructions = ensureAgentInstructions(location);
    console.log(`Agent instructions: ${agentInstructions.status} (${agentInstructions.path}).`);
    if (agentInstructions.status === "outdated") {
      console.log("The CNM-managed section appears manually edited and was preserved. Run cnm agents-md --force to replace that section.");
    }
  });

program.command("agents-md")
  .description("Generate or check CNM agent instructions in the repository AGENTS.md.")
  .option("--check", "Check whether the managed instructions match this CNM version")
  .option("--force", "Refresh the CNM-managed section without replacing user-authored content")
  .option("--print", "Print the generated managed section without writing")
  .option("--tool <tool>", "Agent flavor: opencode, claude, cursor, or generic", "generic")
  .action((options: { check?: boolean; force?: boolean; print?: boolean; tool: AgentTool }) => {
    const location = currentLocation();
    if (options.print) {
      console.log(renderAgentInstructions(options.tool));
      return;
    }
    if (options.check) {
      const result = checkAgentInstructions(location, options.tool);
      if (result.status === "current") {
        console.log("AGENTS.md CNM instructions are current.");
        return;
      }
      console.error(result.status === "missing"
        ? "AGENTS.md is missing."
        : "AGENTS.md CNM instructions are missing or outdated.");
      process.exitCode = result.status === "missing" ? 2 : 1;
      return;
    }
    const result = ensureAgentInstructions(location, options.tool, Boolean(options.force));
    console.log(`AGENTS.md CNM instructions: ${result.status}.`);
  });

program.command("index")
  .description("Index JavaScript and TypeScript files; later runs update changed files only.")
  .option("--force", "Reparse every supported file")
  .option("--path <path>", "Select a project-relative file or directory (repeatable)", (value: string, previous: string[]) => [...previous, value], [])
  .option("--include <pattern>", "Select matching project-relative glob paths (repeatable)", (value: string, previous: string[]) => [...previous, value], [])
  .option("--exclude <pattern>", "Additional ignore pattern (repeatable)", (value: string, previous: string[]) => [...previous, value], [])
  .option("--max-files <number>", "Maximum selected source files to read (1-10000)", parsePositiveInteger)
  .option("--max-processed <number>", "Maximum directory entries to examine (1-100000)", parsePositiveInteger)
  .action((options: { force?: boolean; path: string[]; include: string[]; exclude: string[]; maxFiles?: number; maxProcessed?: number }) => {
    const location = ensureInitialized();
    const result = indexProject(location, Boolean(options.force),
      options.exclude.length === 0 ? undefined : options.exclude, {
      ...(options.path.length === 0 ? {} : { paths: options.path }),
      ...(options.include.length === 0 ? {} : { include: options.include }),
      ...(options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles }),
      ...(options.maxProcessed === undefined ? {} : { maxProcessed: options.maxProcessed }),
    });
    console.log("Index completed:");
    console.table(result);
    if (result.skippedFiles.length > 0) {
      console.log("Skipped files:");
      for (const skipped of result.skippedFiles) console.log("  - " + skipped);
    }
    if (result.errors.length > 0) {
      console.log("Files requiring attention:");
      for (const error of result.errors) console.log("  - " + error);
    }
  });

program.command("freshness")
  .description("Check source-file hashes and Git revision/worktree state against the local index.")
  .action(() => {
    console.log(JSON.stringify(getIndexFreshness(ensureInitialized()), null, 2));
  });

program.command("status")
  .description("Show local memory and index statistics.")
  .action(() => {
    const overview = getProjectOverview(ensureInitialized());
    console.log(JSON.stringify(overview, null, 2));
  });

program.command("map")
  .description("Print a bounded report of indexed files, imports, unresolved candidates, and import diagnostics.")
  .option("--limit <number>", "Maximum number of files (1-200)", parsePositiveInteger, 80)
  .action((options: { limit: number }) => {
    const report = getProjectMapReport(ensureInitialized(), options.limit);
    for (const row of report.files) {
      console.log(`\n${row.path}`);
      for (const dependency of row.imports) console.log(`  └─ imports ${dependency}`);
      if (row.truncated.imports) console.log(`  └─ imports truncated (${row.totals.imports} total; ${report.perFileLimit} returned)`);
      for (const item of row.unresolvedImports) {
        const detail = item.candidates.length > 0 ? ` (candidates: ${item.candidates.join(", ")}${item.candidatesTruncated ? ", …" : ""})` : "";
        const omitted = item.candidatesTruncated ? ` [${item.candidatesTotal} total; bounded output]` : "";
        console.log(`  └─ ${item.status} import ${item.specifier}${detail}${omitted}`);
      }
      if (row.truncated.unresolvedImports) console.log(`  └─ unresolved imports truncated (${row.totals.unresolvedImports} total)`);
      for (const diagnostic of row.importDiagnostics) {
        console.log(`  └─ TS${diagnostic.code} ${diagnostic.kind} at ${diagnostic.line}:${diagnostic.column}: ${diagnostic.message}`);
      }
      if (row.truncated.importDiagnostics) console.log(`  └─ import diagnostics truncated (${row.totals.importDiagnostics} total)`);
    }
    if (report.truncated || report.candidatePathsTruncated) {
      console.log("\nProject map output was truncated:");
      console.log(`  files: ${report.files.length}/${report.totalFiles} (limit ${report.limit})`);
      console.log(`  candidate paths: ${report.candidatePathsReturned}/${report.candidatePathsTotal} (global budget ${report.candidateBudget})`);
    }
  });

program.command("components")
  .description("Summarize first-directory import groups and shortest dependency distances between them.")
  .option("--from <component-or-path>", "Optional source directory group or indexed file path")
  .option("--depth <number>", "Maximum dependency distance (1-20)", parsePositiveInteger, 5)
  .option("--limit <number>", "Maximum component groups (1-100)", parsePositiveInteger, 50)
  .option("--file-limit <number>", "Sample files per group (1-20)", parsePositiveInteger, 10)
  .action((options: { from?: string; depth: number; limit: number; fileLimit: number }) => {
    console.log(JSON.stringify(getComponentMap(ensureInitialized(), {
      ...(options.from === undefined ? {} : { from: options.from }),
      depth: options.depth, limit: options.limit, fileLimit: options.fileLimit,
    }), null, 2));
  });

program.command("search <query>")
  .description("Search indexed symbols using exact-name, name-term, signature, export, and FTS5 ranking signals.")
  .option("--limit <number>", "Maximum results", parsePositiveInteger, 20)
  .action((query: string, options: { limit: number }) => {
    const hits = searchSymbols(ensureInitialized(), query, options.limit);
    if (hits.length === 0) {
      console.log("No matching symbols. Try a broader query or run `cnm index`.");
      return;
    }
    for (const hit of hits) {
      console.log(`${hit.kind} ${hit.name} — ${hit.filePath}:${hit.startLine}-${hit.endLine}${hit.exported ? " [exported]" : ""}`);
      console.log(`  ${hit.signature}`);
      console.log(`  score: ${hit.score.toFixed(2)}; method: ${hit.searchMethod}; signals: ${hit.rankingSignals.join(", ")}`);
    }
  });

program.command("explain <symbol>")
  .description("Show indexed definitions for a symbol name.")
  .action((symbol: string) => {
    const hits = explainSymbol(ensureInitialized(), symbol);
    if (hits.length === 0) console.log(`No definition found for ${symbol}.`);
    else console.log(JSON.stringify(hits, null, 2));
  });

program.command("relations <symbol>")
  .description("Show incoming and outgoing symbol relationships with evidence.")
  .option("--limit <number>", "Maximum relationships (1-500)", parsePositiveInteger, 50)
  .action((symbol: string, options: { limit: number }) => {
    const relations = getSymbolRelations(ensureInitialized(), symbol, options.limit);
    if (relations.length === 0) {
      console.log(`No indexed relationships found for ${symbol}. Try \`cnm explain ${symbol}\` or run \`cnm index\`.`);
      return;
    }
    console.log(JSON.stringify(relations, null, 2));
  });

program.command("symbol-impact <symbol>")
  .description("Traverse symbol callers or dependencies with shortest relation distances and edge evidence.")
  .option("--file <path>", "Disambiguate the symbol by project-relative file path")
  .option("--kind <kind>", "Disambiguate by symbol kind")
  .option("--start-line <number>", "Disambiguate by symbol start line", parsePositiveInteger)
  .option("--direction <direction>", "Traversal direction: incoming or outgoing", "incoming")
  .option("--depth <number>", "Maximum relation distance (1-20)", parsePositiveInteger, 3)
  .option("--limit <number>", "Maximum unique symbols (1-500)", parsePositiveInteger, 100)
  .option("--max-processed <number>", "Maximum symbol relations examined (1-10000)", parsePositiveInteger, 1000)
  .option("--relation <kind>", "Relationship type to include (repeatable)", (value: string, previous: string[]) => [...previous, value], [])
  .action((symbol: string, options: { file?: string; kind?: string; startLine?: number; direction: string; depth: number; limit: number; maxProcessed: number; relation: string[] }) => {
    console.log(JSON.stringify(findSymbolImpact(ensureInitialized(), symbol, {
      ...(options.file === undefined ? {} : { filePath: options.file }),
      ...(options.kind === undefined ? {} : { kind: options.kind }),
      ...(options.startLine === undefined ? {} : { startLine: options.startLine }),
      direction: options.direction as "incoming" | "outgoing",
      depth: options.depth, limit: options.limit, maxProcessed: options.maxProcessed,
      ...(options.relation.length === 0 ? {} : { relationKinds: options.relation as Array<"CALLS" | "EXTENDS" | "IMPLEMENTS"> }),
    }), null, 2));
  });

program.command("impact <file>")
  .description("List files that depend on the specified indexed file, with explicit traversal limits.")
  .option("--limit <number>", "Maximum affected files (1-5000)", parsePositiveInteger, 100)
  .option("--max-processed <number>", "Maximum reverse dependency edges examined (1-10000)", parsePositiveInteger, 1000)
  .action((file: string, options: { limit: number; maxProcessed: number }) => {
    console.log(JSON.stringify(findImpact(ensureInitialized(), file, options.limit, options.maxProcessed), null, 2));
  });


program.command("blame <file>")
  .description("Show bounded Git line attribution for a tracked project file.")
  .option("--start-line <number>", "First line to attribute", parsePositiveInteger, 1)
  .option("--end-line <number>", "Last line to attribute (maximum 200-line range)", parsePositiveInteger, 100)
  .action(async (file: string, options: { startLine: number; endLine: number }) => {
    console.log(JSON.stringify(await getGitBlame(ensureInitialized().rootPath, file, options.startLine, options.endLine), null, 2));
  });

program.command("dependencies <file>")
  .description("List files imported by the target, directly or up to a depth.")
  .option("--depth <number>", "Maximum dependency depth", parsePositiveInteger, 1)
  .option("--limit <number>", "Maximum unique dependency results", parsePositiveInteger, 100)
  .option("--max-processed <number>", "Maximum import edges examined during traversal", parsePositiveInteger, 1000)
  .action((file: string, options: { depth: number; limit: number; maxProcessed: number }) => {
    const dependencies = findDependencies(ensureInitialized(), file, options.depth, options.limit, options.maxProcessed);
    console.log(JSON.stringify(dependencies, null, 2));
  });

program.command("file <path>")
  .description("Show bounded indexed symbols, imports, references, and provenance for a source file.")
  .option("--limit <number>", "Maximum items per collection (1-500)", parsePositiveInteger, 100)
  .action((file: string, options: { limit: number }) => {
    console.log(JSON.stringify(getFileDetails(ensureInitialized(), file, options.limit), null, 2));
  });

program.command("remember <title> <content>")
  .description("Save an explicit, confirmed project decision or note locally.")
  .option("--category <category>", "Memory category", "decision")
  .option("--source <path>", "Optional source file path")
  .option("--commit <sha>", "Optional source Git commit")
  .option("--author <identity>", "Optional memory author identity")
  .action((title: string, content: string, options: { category: string; source?: string; commit?: string; author?: string }) => {
    const id = remember(ensureInitialized(), title, content, options.category, options.source, options.commit, options.author);
    console.log(`Saved memory ${id}.`);
  });

program.command("propose <title> <content>")
  .description("Save a project knowledge suggestion as proposed, not confirmed.")
  .option("--category <category>", "Memory category", "decision")
  .option("--source <path>", "Optional source file path")
  .option("--commit <sha>", "Optional source Git commit")
  .option("--author <identity>", "Optional memory author identity")
  .action((title: string, content: string, options: { category: string; source?: string; commit?: string; author?: string }) => {
    const id = proposeMemory(ensureInitialized(), title, content, options.category, options.source, options.commit, options.author);
    console.log(`Saved proposed memory ${id}; it requires explicit confirmation.`);
  });

const memory = program.command("memory").description("Manage the lifecycle of an existing project memory.");

memory.command("update <id>")
  .description("Update explicitly supplied fields on a project memory.")
  .option("--category <category>", "New category")
  .option("--title <title>", "New title")
  .option("--content <content>", "New content")
  .option("--source <path>", "New source file path")
  .option("--commit <sha>", "New source Git commit")
  .option("--author <identity>", "Identity of the person making this update")
  .action((id: string, options: { category?: string; title?: string; content?: string; source?: string; commit?: string; author?: string }) => {
    const patch = {
      ...(options.category === undefined ? {} : { category: options.category }),
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(options.content === undefined ? {} : { content: options.content }),
      ...(options.source === undefined ? {} : { sourcePath: options.source }),
      ...(options.commit === undefined ? {} : { commitSha: options.commit }),
      ...(options.author === undefined ? {} : { author: options.author }),
    };
    const changed = updateMemory(ensureInitialized(), id, patch);
    if (!changed) throw new Error(`Memory not found: ${id}`);
    console.log(`Updated memory ${id}.`);
  });

memory.command("transition <id> <status>")
  .description("Explicitly transition a memory to confirmed, obsolete, or rejected.")
  .action((id: string, status: string) => {
    const changed = transitionMemory(ensureInitialized(), id, status as MemoryStatus);
    if (!changed) throw new Error(`Memory not found or transition was not applied: ${id}`);
    console.log(`Memory ${id} is now ${status}.`);
  });

memory.command("freshness")
  .description("Check source-file fingerprints and referenced Git commits for project memories.")
  .action(() => {
    console.log(JSON.stringify(inspectMemoryFreshness(ensureInitialized()), null, 2));
  });

memory.command("delete <id>")
  .description("Delete a memory from this project's local database.")
  .action((id: string) => {
    if (!deleteMemory(ensureInitialized(), id)) throw new Error(`Memory not found: ${id}`);
    console.log(`Deleted memory ${id}.`);
  });

program.command("memories [query]")
  .description("List local project memories, optionally filtered by text.")
  .option("--limit <number>", "Maximum results", parsePositiveInteger, 20)
  .action((query: string | undefined, options: { limit: number }) => {
    console.log(JSON.stringify(recallMemories(ensureInitialized(), query ?? "", options.limit), null, 2));
  });

program.command("context <task>")
  .description("Build bounded, explainable local context for a natural-language task.")
  .option("--max-items <number>", "Maximum context items (1-100)", parsePositiveInteger, 20)
  .option("--max-characters <number>", "Maximum serialized item characters (100-50000)", parsePositiveInteger, 12000)
  .option("--symbol-limit <number>", "Maximum symbol candidates (1-50)", parsePositiveInteger, 20)
  .option("--file-limit <number>", "Maximum file candidates (1-50)", parsePositiveInteger, 10)
  .option("--dependency-limit <number>", "Maximum dependency candidates (1-50)", parsePositiveInteger, 20)
  .option("--test-limit <number>", "Maximum test candidates (1-50)", parsePositiveInteger, 20)
  .option("--memory-limit <number>", "Maximum memory candidates (1-50)", parsePositiveInteger, 20)
  .action((task: string, options: { maxItems: number; maxCharacters: number; symbolLimit: number; fileLimit: number; dependencyLimit: number; testLimit: number; memoryLimit: number }) => {
    console.log(JSON.stringify(buildTaskContext(ensureInitialized(), task, {
      maxItems: options.maxItems, maxCharacters: options.maxCharacters,
      symbolLimit: options.symbolLimit, fileLimit: options.fileLimit,
      dependencyLimit: options.dependencyLimit, testLimit: options.testLimit, memoryLimit: options.memoryLimit,
    }), null, 2));
  });

program.command("mcp")
  .description("Start the local MCP stdio server for this repository.")
  .action(() => {
    startMcpServer(ensureInitialized());
  });

program.showHelpAfterError();
program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
