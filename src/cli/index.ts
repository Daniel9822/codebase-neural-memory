#!/usr/bin/env node
import { Command } from "commander";
import { mkdirSync } from "node:fs";
import { basename } from "node:path";
import { ensureProject, openDatabase } from "../storage/database.js";
import { getProjectLocation, resolveProjectRoot } from "../core/project.js";
import { indexProject } from "../core/indexer.js";
import { explainSymbol, findImpact, getProjectMap, getProjectOverview, searchSymbols } from "../core/retrieval.js";
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
  .action((options: { force?: boolean }) => {
    const location = ensureInitialized();
    const result = indexProject(location, Boolean(options.force));
    console.log("Index completed:");
    console.table(result);
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
    }
  });

program.command("search <query>")
  .description("Search indexed functions, classes, interfaces, and types.")
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

program.command("impact <file>")
  .description("List files that depend on the specified indexed file.")
  .action((file: string) => {
    const affected = findImpact(ensureInitialized(), file);
    console.log(JSON.stringify({ file, affectedFiles: affected }, null, 2));
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
