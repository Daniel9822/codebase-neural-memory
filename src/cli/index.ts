#!/usr/bin/env node
import { Command } from "commander";
import { mkdirSync } from "node:fs";
import { basename } from "node:path";
import { ensureProject, openDatabase } from "../storage/database.js";
import { getProjectLocation, resolveProjectRoot } from "../core/project.js";
import { getIndexFreshness, indexProject } from "../core/indexer.js";
import { explainSymbol, findDependencies, findImpact, getFileDetails, getProjectMap, getProjectOverview, getSymbolRelations, searchSymbols } from "../core/retrieval.js";
import { recallMemories, remember } from "../core/memories.js";
import { startMcpServer } from "../adapters/mcp/server.js";
import { parsePositiveInteger } from "../shared/validation.js";

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
    console.log("No files were added to or modified inside the repository.");
  });

program.command("index")
  .description("Index JavaScript and TypeScript files; later runs update changed files only.")
  .option("--force", "Reparse every supported file")
  .option("--exclude <pattern>", "Additional ignore pattern (repeatable)", (value: string, previous: string[]) => [...previous, value], [])
  .action((options: { force?: boolean; exclude: string[] }) => {
    const location = ensureInitialized();
    const result = indexProject(location, Boolean(options.force), options.exclude);
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
  .description("Check whether supported source files differ from the local index.")
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
  .description("Print indexed files and their resolved imports.")
  .option("--limit <number>", "Maximum number of files", parsePositiveInteger, 80)
  .action((options: { limit: number }) => {
    const rows = getProjectMap(ensureInitialized(), options.limit);
    for (const row of rows) {
      console.log(`\n${row.path}`);
      for (const dependency of row.imports) console.log(`  └─ imports ${dependency}`);
      for (const item of row.unresolvedImports) {
        const detail = item.status === "ambiguous" ? ` (candidates: ${item.candidates.join(", ")})` : "";
        console.log(`  └─ ${item.status} import ${item.specifier}${detail}`);
      }
    }
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
  .option("--limit <number>", "Maximum relationships", parsePositiveInteger, 50)
  .action((symbol: string, options: { limit: number }) => {
    const relations = getSymbolRelations(ensureInitialized(), symbol, options.limit);
    if (relations.length === 0) {
      console.log(`No indexed relationships found for ${symbol}. Try \`cnm explain ${symbol}\` or run \`cnm index\`.`);
      return;
    }
    console.log(JSON.stringify(relations, null, 2));
  });

program.command("impact <file>")
  .description("List files that depend on the specified indexed file.")
  .action((file: string) => {
    const affected = findImpact(ensureInitialized(), file);
    console.log(JSON.stringify({ file, affectedFiles: affected }, null, 2));
  });


program.command("dependencies <file>")
  .description("List files imported by the target, directly or up to a depth.")
  .option("--depth <number>", "Maximum dependency depth", parsePositiveInteger, 1)
  .option("--limit <number>", "Maximum unique dependency results", parsePositiveInteger, 100)
  .option("--max-processed <number>", "Maximum files expanded during traversal", parsePositiveInteger, 1000)
  .action((file: string, options: { depth: number; limit: number; maxProcessed: number }) => {
    const dependencies = findDependencies(ensureInitialized(), file, options.depth, options.limit, options.maxProcessed);
    console.log(JSON.stringify(dependencies, null, 2));
  });

program.command("file <path>")
  .description("Show indexed symbols, imports, references, and provenance for a source file.")
  .action((file: string) => {
    console.log(JSON.stringify(getFileDetails(ensureInitialized(), file), null, 2));
  });

program.command("remember <title> <content>")
  .description("Save an explicit, confirmed project decision or note locally.")
  .option("--category <category>", "Memory category", "decision")
  .option("--source <path>", "Optional source file path")
  .action((title: string, content: string, options: { category: string; source?: string }) => {
    const id = remember(ensureInitialized(), title, content, options.category, options.source);
    console.log(`Saved memory ${id}.`);
  });

program.command("memories [query]")
  .description("List local project memories, optionally filtered by text.")
  .option("--limit <number>", "Maximum results", parsePositiveInteger, 20)
  .action((query: string | undefined, options: { limit: number }) => {
    console.log(JSON.stringify(recallMemories(ensureInitialized(), query ?? "", options.limit), null, 2));
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
