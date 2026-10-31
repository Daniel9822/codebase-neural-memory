import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { ensureProject, openDatabase } from "../src/storage/database.js";
import { indexProject, getIndexFreshness } from "../src/core/indexer.js";
import { findDependencies, searchSymbols } from "../src/core/retrieval.js";
import type { ProjectLocation } from "../src/core/project.js";
import { retrievalRelevanceCases } from "../tests/fixtures/retrieval-relevance.js";

const scales = [
  { name: "small", modules: 25 },
  { name: "medium", modules: 100 },
  { name: "large", modules: 300 },
] as const;

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function summarize(values: number[]) {
  return {
    samples: values.length,
    medianMs: Number(percentile(values, 0.5).toFixed(3)),
    p95Ms: Number(percentile(values, 0.95).toFixed(3)),
  };
}

function measure<T>(operation: () => T, repetitions: number): { timings: number[]; last: T } {
  const timings: number[] = [];
  let last!: T;
  for (let index = 0; index < repetitions; index += 1) {
    const start = performance.now();
    last = operation();
    timings.push(performance.now() - start);
  }
  return { timings, last };
}

function writeDomainFixture(rootPath: string): void {
  const source = [
    "export function registerParticipant(participantId: string): boolean { return participantId.length > 0; }",
    "export function unregisterParticipant(participantId: string): boolean { return participantId.length === 0; }",
    "export function calculateTotal(values: number[]): number { return values.reduce((sum, value) => sum + value, 0); }",
    "export function calculateAverage(values: number[]): number { return calculateTotal(values) / values.length; }",
    "export function removeParticipant(participantId: string): boolean { return participantId.length > 0; }",
    "export function validateRegistration(input: string): boolean { return input.trim().length > 0; }",
    "export function saveTournament(id: string): boolean { return id.length > 0; }",
    "export function loadTournament(id: string): string { return id; }",
    "export function calculateStandings(scores: number[]): number { return scores.length; }",
    "export function parseTournamentDate(value: string): Date { return new Date(value); }",
    "export function determineWinner(scores: number[]): number { return Math.max(...scores); }",
  ].join("\n") + "\n";
  writeFileSync(join(rootPath, "domain.ts"), source);
}

function writeModule(rootPath: string, index: number): void {
  const suffix = String(index).padStart(4, "0");
  const previous = String(index - 1).padStart(4, "0");
  const importLine = index === 0 ? "" :
    "import { syntheticNode" + previous + " } from \"./module-" + previous + ".js\";\n";
  const expression = index === 0 ? "value + 1" : "syntheticNode" + previous + "(value) + 1";
  const source = importLine +
    "export function syntheticNode" + suffix + "(value: number): number {\n" +
    "  return " + expression + ";\n" +
    "}\n" +
    "export function auxiliary" + suffix + "(input: string): string {\n" +
    "  return input.trim().toLowerCase();\n" +
    "}\n";
  writeFileSync(join(rootPath, "src", "module-" + suffix + ".ts"), source);
}

function databaseBytes(path: string): number {
  return [path, path + "-wal", path + "-shm"].reduce((total, candidate) => {
    try { return total + statSync(candidate).size; } catch { return total; }
  }, 0);
}

function peakRssBytes(): number {
  const maximum = process.resourceUsage().maxRSS;
  return Math.round(maximum * 1024);
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function runCase(scale: typeof scales[number]) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "cnm-benchmark-" + scale.name + "-"));
  const rootPath = join(temporaryDirectory, "repository");
  mkdirSync(join(rootPath, "src"), { recursive: true });
  const location: ProjectLocation = {
    id: "benchmark-" + scale.name,
    rootPath,
    dataDirectory: join(temporaryDirectory, "data"),
    databasePath: join(temporaryDirectory, "data", "memory.sqlite"),
  };

  try {
    writeDomainFixture(rootPath);
    for (let index = 0; index < scale.modules; index += 1) writeModule(rootPath, index);

    const db = openDatabase(location);
    try { ensureProject(db, location); } finally { db.close(); }

    const rssBeforeBytes = process.memoryUsage().rss;
    const initialStart = performance.now();
    const initial = indexProject(location);
    const initialIndexMs = performance.now() - initialStart;

    const unchangedStart = performance.now();
    const unchanged = indexProject(location);
    const unchangedIndexMs = performance.now() - unchangedStart;

    const lastSuffix = String(scale.modules - 1).padStart(4, "0");
    const changedPath = join(rootPath, "src", "module-" + lastSuffix + ".ts");
    writeFileSync(changedPath, readFileSync(changedPath, "utf8") + "\n// deterministic incremental-index benchmark mutation\n");
    const changedStart = performance.now();
    const changed = indexProject(location);
    const changedIndexMs = performance.now() - changedStart;

    const search = measure(() => searchSymbols(location, "calculateAverage", 20), 25);
    const graph = measure(
      () => findDependencies(location, "src/module-" + lastSuffix + ".ts", 5, 100, 1000),
      25,
    );
    const freshness = measure(() => getIndexFreshness(location), 10);

    const relevance = retrievalRelevanceCases.map((fixture) => {
      const results = searchSymbols(location, fixture.query, 10);
      const relevant = new Set<string>(fixture.relevant);
      const topFive = results.slice(0, 5);
      const relevantAtFive = topFive.filter((result) => relevant.has(result.name)).length;
      const firstRelevant = results.findIndex((result) => relevant.has(result.name));
      return {
        query: fixture.query,
        expectedTop: fixture.expectedTop,
        actualTop: results[0]?.name ?? null,
        topFiveRelevant: relevantAtFive,
        relevantTotal: relevant.size,
        precisionAt5: relevantAtFive / 5,
        recallAt5: relevantAtFive / relevant.size,
        reciprocalRank: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
        top1Correct: results[0]?.name === fixture.expectedTop,
      };
    });

    return {
      name: scale.name,
      sourceFiles: scale.modules + 1,
      generatedModules: scale.modules,
      initialIndex: {
        elapsedMs: Number(initialIndexMs.toFixed(3)),
        addedFiles: initial.added,
        symbols: initial.symbols,
        relations: initial.relations,
      },
      unchangedIndex: {
        elapsedMs: Number(unchangedIndexMs.toFixed(3)),
        unchangedFiles: unchanged.unchanged,
        updatedFiles: unchanged.updated,
      },
      changedIndex: {
        elapsedMs: Number(changedIndexMs.toFixed(3)),
        updatedFiles: changed.updated,
        unchangedFiles: changed.unchanged,
      },
      searchLatency: summarize(search.timings),
      graphLatency: summarize(graph.timings),
      freshnessLatency: summarize(freshness.timings),
      graphResultCount: graph.last.dependencies.length,
      retrievalEvaluation: {
        queryCount: relevance.length,
        top1Accuracy: mean(relevance.map((item) => item.top1Correct ? 1 : 0)),
        meanPrecisionAt5: mean(relevance.map((item) => item.precisionAt5)),
        meanRecallAt5: mean(relevance.map((item) => item.recallAt5)),
        meanReciprocalRank: mean(relevance.map((item) => item.reciprocalRank)),
        cases: relevance,
      },
      databaseBytes: databaseBytes(location.databasePath),
      rssBeforeBytes,
      rssAfterBytes: process.memoryUsage().rss,
      processPeakRssBytes: peakRssBytes(),
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function findFirstSource(rootPath: string, currentPath = rootPath): string | null {
  const ignored = new Set([".git", "node_modules", "dist", "coverage", ".cnm"]);
  const entries = readdirSync(currentPath, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (ignored.has(entry.name)) continue;
      const nested = findFirstSource(rootPath, join(currentPath, entry.name));
      if (nested) return nested;
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      return relative(rootPath, join(currentPath, entry.name)).replaceAll("\\", "/");
    }
  }
  return null;
}

function runWorkspaceCase() {
  const rootPath = resolve(process.cwd());
  const sourcePath = existsSync(join(rootPath, "src", "core", "indexer.ts"))
    ? "src/core/indexer.ts"
    : findFirstSource(rootPath);
  if (!sourcePath) return null;

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "cnm-benchmark-workspace-"));
  const location: ProjectLocation = {
    id: "benchmark-real-workspace",
    rootPath,
    dataDirectory: join(temporaryDirectory, "data"),
    databasePath: join(temporaryDirectory, "data", "memory.sqlite"),
  };
  try {
    const db = openDatabase(location);
    try { ensureProject(db, location); } finally { db.close(); }

    const rssBeforeBytes = process.memoryUsage().rss;
    const initialStart = performance.now();
    const initial = indexProject(location);
    const initialIndexMs = performance.now() - initialStart;
    const unchangedStart = performance.now();
    const unchanged = indexProject(location);
    const unchangedIndexMs = performance.now() - unchangedStart;
    const search = measure(() => searchSymbols(location, "indexProject", 20), 25);
    const graph = measure(() => findDependencies(location, sourcePath, 5, 100, 1000), 25);
    const freshness = measure(() => getIndexFreshness(location), 10);

    return {
      repository: basename(rootPath),
      sourceFiles: initial.added + initial.updated + initial.unchanged,
      graphStartPath: sourcePath,
      initialIndexMs: Number(initialIndexMs.toFixed(3)),
      unchangedIndexMs: Number(unchangedIndexMs.toFixed(3)),
      unchangedFiles: unchanged.unchanged,
      searchLatency: summarize(search.timings),
      searchResultCount: search.last.length,
      graphLatency: summarize(graph.timings),
      graphResultCount: graph.last.dependencies.length,
      freshnessLatency: summarize(freshness.timings),
      databaseBytes: databaseBytes(location.databasePath),
      rssBeforeBytes,
      rssAfterBytes: process.memoryUsage().rss,
      processPeakRssBytes: peakRssBytes(),
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  methodology: {
    fixture: "deterministic TypeScript module chain plus a labeled domain retrieval corpus",
    scales: scales.map(({ name, modules }) => ({ name, sourceFiles: modules + 1 })),
    samples: { search: 25, graph: 25, freshness: 10 },
    note: "Measurements are descriptive and machine-dependent. No performance threshold or improvement claim is implied.",
  },
  cases: scales.map(runCase),
  realRepository: runWorkspaceCase(),
  processPeakRssBytes: peakRssBytes(),
};

process.stdout.write(JSON.stringify(report, null, 2) + "\n");
