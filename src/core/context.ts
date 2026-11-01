import { findDependencies, findImpact, getFileDetails, searchSymbols } from "./retrieval.js";
import { inspectMemoryFreshness, recallMemories } from "./memories.js";
import type { ProjectLocation } from "./project.js";
import { openDatabase } from "../storage/database.js";
import { getIndexFreshness } from "./indexer.js";

export interface TaskContextOptions {
  maxItems?: number;
  maxCharacters?: number;
  symbolLimit?: number;
  memoryLimit?: number;
  fileLimit?: number;
  dependencyLimit?: number;
  testLimit?: number;
  anchors?: { paths?: string[]; symbols?: string[] };
}

export interface TaskContextItem {
  kind: "symbol" | "file" | "dependency" | "memory" | "test";
  origin: "anchor" | "graph" | "fallback";
  title: string;
  source: string;
  score: number;
  signals: string[];
  status?: string;
  detail?: unknown;
}

export interface TaskContextResult {
  task: string;
  anchors: string[];
  items: TaskContextItem[];
  warnings: string[];
  followUp: string[];
  budget: {
    maxItems: number;
    maxCharacters: number;
    usedItems: number;
    usedCharacters: number;
    truncated: boolean;
    perKind: Record<TaskContextItem["kind"], { limit: number; used: number }>;
    truncatedKinds: TaskContextItem["kind"][];
  };
}

const MAX_ITEMS = 100;
const MAX_CHARACTERS = 50_000;

function anchorsFor(task: string): string[] {
  return [...new Set((task.match(/[\p{L}\p{N}_$-]+/gu) ?? [])
    .filter((word) => word.length >= 3)
    .map((word) => word.replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .map((word) => word.toLocaleLowerCase()))].slice(0, 20);
}

function itemIdentity(item: TaskContextItem): string {
  if (item.kind === "symbol") return `${item.kind}:${item.source}:${item.title}`;
  if (item.kind === "memory" && item.detail && typeof item.detail === "object" && "id" in item.detail) {
    return `memory:${String((item.detail as { id: unknown }).id)}`;
  }
  return `${item.kind}:${item.source}`;
}

const TASK_CONTEXT_KINDS: TaskContextItem["kind"][] = ["symbol", "file", "dependency", "test", "memory"];

function boundedItems(
  candidates: TaskContextItem[],
  maxItems: number,
  maxCharacters: number,
  perKindLimits: Record<TaskContextItem["kind"], number>,
) {
  const unique = new Map<string, TaskContextItem>();
  for (const item of candidates) {
    const key = itemIdentity(item);
    const previous = unique.get(key);
    if (!previous || item.score > previous.score) unique.set(key, item);
  }
  const ranked = [...unique.values()].sort((a, b) =>
    b.score - a.score || a.source.localeCompare(b.source) || a.title.localeCompare(b.title));
  const items: TaskContextItem[] = [];
  // maxCharacters is the exact character length of JSON.stringify(items), including
  // the array brackets, commas, quotes, and serialized item fields.
  let usedCharacters = JSON.stringify(items).length;
  let truncated = false;
  const usedByKind: Record<TaskContextItem["kind"], number> = { symbol: 0, file: 0, dependency: 0, test: 0, memory: 0 };
  const truncatedKinds = new Set<TaskContextItem["kind"]>();
  for (const item of ranked) {
    if (items.length >= maxItems) { truncated = true; break; }
    if (usedByKind[item.kind] >= perKindLimits[item.kind]) {
      truncated = true;
      truncatedKinds.add(item.kind);
      continue;
    }
    const candidate = [...items, item];
    const candidateCharacters = JSON.stringify(candidate).length;
    if (candidateCharacters > maxCharacters) { truncated = true; continue; }
    items.push(item);
    usedByKind[item.kind] += 1;
    usedCharacters = candidateCharacters;
  }
  return { items, usedCharacters, usedByKind, truncatedKinds: [...truncatedKinds], truncated };
}

/** Build deterministic, bounded task context from the local index and project memories. */
export function buildTaskContext(
  location: ProjectLocation,
  task: string,
  options: TaskContextOptions = {},
): TaskContextResult {
  const normalizedTask = task.trim();
  if (!normalizedTask) throw new Error("Task description must not be empty.");
  const maxItems = options.maxItems ?? 20;
  const maxCharacters = options.maxCharacters ?? 12_000;
  const symbolLimit = options.symbolLimit ?? 20;
  const memoryLimit = options.memoryLimit ?? 20;
  const fileLimit = options.fileLimit ?? 10;
  const dependencyLimit = options.dependencyLimit ?? 20;
  const testLimit = options.testLimit ?? 20;
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > MAX_ITEMS) throw new Error("maxItems must be between 1 and 100.");
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 100 || maxCharacters > MAX_CHARACTERS) throw new Error("maxCharacters must be between 100 and 50000.");
  for (const [name, value, max] of [
    ["symbolLimit", symbolLimit, 50], ["memoryLimit", memoryLimit, 50], ["fileLimit", fileLimit, 50],
    ["dependencyLimit", dependencyLimit, 50], ["testLimit", testLimit, 50],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${name} must be between 1 and ${max}.`);
  }

  const lexicalAnchors = anchorsFor(normalizedTask);
  const explicitAnchorMode = options.anchors !== undefined;
  const anchorPaths = [...new Set((options.anchors?.paths ?? []).map((path) => {
    const normalized = path.trim().replaceAll("\\", "/");
    return normalized.startsWith("./") ? normalized.slice(2) : normalized;
  }))];
  const anchorSymbols = [...new Set((options.anchors?.symbols ?? []).map((symbol) => symbol.trim()).filter(Boolean))];
  if (explicitAnchorMode && anchorPaths.length + anchorSymbols.length === 0) throw new Error("anchors must include at least one path or symbol.");
  if (anchorPaths.length > 20 || anchorSymbols.length > 20 || anchorPaths.some((path) => !path || path.startsWith("/") || path.split("/").some((part) => part === ".." || part === ""))) {
    throw new Error("anchors accepts up to 20 normalized project-relative paths and 20 non-empty symbol names.");
  }
  const anchors = explicitAnchorMode ? [...anchorSymbols, ...anchorPaths] : lexicalAnchors;
  const candidates: TaskContextItem[] = [];
  const warnings: string[] = [];
  const indexFreshness = getIndexFreshness(location);
  if (indexFreshness.status !== "current") {
    warnings.push(`Indexed source is ${indexFreshness.status}; context may omit newer or unreadable files (added: ${indexFreshness.addedFiles}, changed: ${indexFreshness.changedFiles}, deleted: ${indexFreshness.deletedFiles}).`);
  }
  const symbolMatches = explicitAnchorMode
    ? anchorSymbols.flatMap((name) => searchSymbols(location, name, symbolLimit + 1).filter((symbol) => symbol.name === name))
    : searchSymbols(location, normalizedTask, symbolLimit + 1);
  const symbolCandidatesTruncated = symbolMatches.length > symbolLimit;
  const symbols = symbolMatches.slice(0, symbolLimit);
  const fileCandidatesTruncated = new Set(symbolMatches.map((symbol) => symbol.filePath)).size > fileLimit;
  for (const symbol of symbols) {
    candidates.push({
      kind: "symbol",
      origin: explicitAnchorMode ? "anchor" : "fallback",
      title: `${symbol.name} (${symbol.kind})`,
      source: `${symbol.filePath}:${symbol.startLine}-${symbol.endLine}`,
      score: symbol.score,
      signals: [...symbol.rankingSignals],
      detail: { signature: symbol.signature, exported: symbol.exported, searchMethod: symbol.searchMethod },
    });
  }

  const seenFiles = new Set<string>();
  const seenImpactFiles = new Set<string>();
  const seenDependencyPaths = new Set<string>();
  const seenTestPaths = new Set<string>();
  let testCandidatesTruncated = false;
  let dependencyCandidatesTruncated = false;
  const addTestCandidate = (item: TaskContextItem) => {
    if (seenTestPaths.has(item.source)) return;
    if (seenTestPaths.size >= testLimit) { testCandidatesTruncated = true; return; }
    seenTestPaths.add(item.source);
    candidates.push(item);
  };
  const addDependencyCandidate = (item: TaskContextItem) => {
    if (seenDependencyPaths.has(item.source)) return;
    if (seenDependencyPaths.size >= dependencyLimit) { dependencyCandidatesTruncated = true; return; }
    seenDependencyPaths.add(item.source);
    candidates.push(item);
  };
  for (const symbol of symbols) {
    if (/(^|[/\\])tests?([/\\.-]|$)|\.(test|spec)\.[cm]?[jt]sx?$/i.test(symbol.filePath)) {
      addTestCandidate({
        kind: "test", origin: explicitAnchorMode ? "anchor" : "fallback", title: `Test source: ${symbol.filePath}`, source: symbol.filePath,
        score: symbol.score + 2, signals: ["test-path", "lexical-match"],
        detail: { startLine: symbol.startLine, endLine: symbol.endLine },
      });
    }
    if (seenFiles.has(symbol.filePath) || seenFiles.size >= fileLimit) continue;
    seenFiles.add(symbol.filePath);
    try {
      const detail = getFileDetails(location, symbol.filePath, 20);
      candidates.push({
        kind: "file", origin: explicitAnchorMode ? "anchor" : "fallback", title: symbol.filePath, source: symbol.filePath,
        score: Math.max(1, symbol.score - 5),
        signals: ["contains-matching-symbol", "indexed-file"],
        detail: {
          indexRevision: detail.indexRevision,
          contentHash: detail.contentHash,
          symbols: detail.symbols.slice(0, 10).map((entry) => ({ name: entry.name, kind: entry.kind, startLine: entry.startLine, endLine: entry.endLine })),
          imports: detail.imports.slice(0, 10),
          unresolvedImports: detail.unresolvedImports.slice(0, 5),
          relations: detail.relations.slice(0, 10),
        },
      });
      for (const unresolved of detail.unresolvedImports) {
        const ambiguous = /ambiguous/i.test(unresolved.status) || unresolved.candidates.length > 1;
        warnings.push(`Import "${unresolved.specifier}" in ${symbol.filePath} is ${ambiguous ? "ambiguous" : "unresolved"}; candidates: ${unresolved.candidates.length ? unresolved.candidates.join(", ") : "none"}.`);
      }
      const remainingDependencies = dependencyLimit - seenDependencyPaths.size;
      if (remainingDependencies > 0) {
        const dependencies = findDependencies(location, symbol.filePath, 1, Math.min(20, remainingDependencies), 100);
        for (const dependency of dependencies.dependencies) {
          addDependencyCandidate({
            kind: "dependency", origin: "graph", title: dependency.path, source: dependency.path,
            score: Math.max(1, symbol.score - 10 - dependency.depth),
            signals: ["direct-import", "dependency-of-matching-file"],
            detail: { from: symbol.filePath, chain: dependency.chain, evidence: dependency.evidence },
          });
        }
        if (dependencies.truncated) {
          dependencyCandidatesTruncated = true;
          warnings.push(`Dependency results for ${symbol.filePath} were truncated by retrieval limits.`);
        }
      }
      if (dependencies.truncated) warnings.push(`Dependency results for ${symbol.filePath} were truncated by retrieval limits.`);
      // Map the indexed source file back to tests through actual reverse-import
      // relations, rather than relying only on test filenames containing task words.
      if (!seenImpactFiles.has(symbol.filePath)) {
        seenImpactFiles.add(symbol.filePath);
        const impacted = findImpact(location, symbol.filePath, 20, 100);
        for (const path of impacted.affectedFiles) {
          // Recognize tests under test directories and colocated *.test/spec.* files.
          if (!/(^|[/\\])tests?([/\\.-]|$)|\.(test|spec)\.[cm]?[jt]sx?$/i.test(path)) continue;
          candidates.push({
          addTestCandidate({
            kind: "test", origin: "graph", title: `Import-dependent test: ${path}`, source: path,
            score: symbol.score + 3,
            signals: ["reverse-import-dependent", "test-to-source-file"],
            detail: { target: symbol.filePath, relationship: "direct-or-transitive-import-dependent" },
          });
        }
        if (impacted.truncated) warnings.push(`Test dependency lookup for ${symbol.filePath} was truncated by retrieval limits.`);
      }
      if (/(^|[/\\])tests?([/\\.-]|$)|\.(test|spec)\.[cm]?[jt]sx?$/i.test(symbol.filePath)) {
        candidates.push({
          kind: "test", origin: explicitAnchorMode ? "anchor" : "fallback", title: `Test source: ${symbol.filePath}`, source: symbol.filePath,
          score: symbol.score + 2, signals: ["test-path", "lexical-match"],
          detail: { startLine: symbol.startLine, endLine: symbol.endLine },
        });
      }
    } catch {
      warnings.push(`Could not load indexed details for ${symbol.filePath}; the index may have changed.`);
    }
  }

  for (const path of anchorPaths) {
    const detail = getFileDetails(location, path, 20);
    candidates.push({
      kind: "file", origin: "anchor", title: path, source: path, score: 100,
      signals: ["explicit-path-anchor", "indexed-file"],
      detail: {
        indexRevision: detail.indexRevision, contentHash: detail.contentHash,
        symbols: detail.symbols.slice(0, 10).map((entry) => ({ name: entry.name, kind: entry.kind, startLine: entry.startLine, endLine: entry.endLine })),
        imports: detail.imports.slice(0, 10), unresolvedImports: detail.unresolvedImports.slice(0, 5),
        relations: detail.relations.slice(0, 10),
      },
    });
    const remainingDependencies = dependencyLimit - seenDependencyPaths.size;
    if (remainingDependencies > 0) {
      const dependencies = findDependencies(location, path, 1, Math.min(20, remainingDependencies), 100);
      for (const dependency of dependencies.dependencies) {
        addDependencyCandidate({
          kind: "dependency", origin: "graph", title: dependency.path, source: dependency.path,
          score: Math.max(1, 90 - dependency.depth), signals: ["direct-import", "dependency-of-explicit-path-anchor"],
          detail: { from: path, chain: dependency.chain, evidence: dependency.evidence },
        });
      }
      if (dependencies.truncated) {
        dependencyCandidatesTruncated = true;
        warnings.push(`Dependency results for ${path} were truncated by retrieval limits.`);
      }
    }
  }

  const testDb = openDatabase(location);
  let testPaths: string[];
  try {
    testPaths = (testDb.prepare(`
      SELECT path FROM files
      WHERE lower(path) LIKE '%test%' OR lower(path) LIKE '%spec%'
      ORDER BY path LIMIT 500
    `).all() as Array<{ path: string }>).map((row) => row.path)
      .filter((path) => /(^|[/\\])tests?([/\\.-]|$)|\.(test|spec)\.[cm]?[jt]sx?$/i.test(path));
  } finally { testDb.close(); }
  for (const path of testPaths) {
    const matchingAnchors = explicitAnchorMode ? [] : anchors.filter((anchor) => path.toLocaleLowerCase().includes(anchor));
    // Do not add every test in the repository: a test path must match at least
    // one lexical task anchor to be considered a task-context candidate.
    if (matchingAnchors.length === 0) continue;
    addTestCandidate({
      kind: "test", origin: "fallback", title: `Test source: ${path}`, source: path,
      score: 12 + matchingAnchors.length * 8,
      signals: ["test-path", "task-anchor-in-path"],
      detail: { matchingAnchors },
    });
  }
  if (testCandidatesTruncated) warnings.push(`Test candidates were truncated at the configured testLimit of ${testLimit}.`);
  if (dependencyCandidatesTruncated) warnings.push(`Dependency candidates were truncated at the configured dependencyLimit of ${dependencyLimit}.`);

  const matchedMemories = (explicitAnchorMode ? [] : recallMemories(location, "", 500))
    .map((memory) => ({ memory, matches: anchors.filter((anchor) =>
      `${memory.title} ${memory.content} ${memory.category}`.toLocaleLowerCase().includes(anchor)).length }))
    .filter((entry) => entry.matches > 0)
    .sort((a, b) => b.matches - a.matches || b.memory.updatedAt.localeCompare(a.memory.updatedAt)
      || a.memory.id.localeCompare(b.memory.id));
  const memoryCandidatesTruncated = matchedMemories.length > memoryLimit;
  const memories = matchedMemories.slice(0, memoryLimit).map((entry) => entry.memory);
  const freshness = inspectMemoryFreshness(location);
  const freshnessById = new Map(freshness.map((entry) => [entry.id, entry]));
  for (const memory of memories) {
    const sourceFreshness = freshnessById.get(memory.id);
    const signals = ["lexical-memory-match", `status:${memory.status}`];
    if (sourceFreshness?.requiresReview) signals.push(`source:${sourceFreshness.status}`);
    const statusPenalty = memory.status === "confirmed" ? 0 : memory.status === "proposed" ? -8 : -15;
    candidates.push({
      kind: "memory", origin: "fallback", title: memory.title, source: memory.sourcePath ?? `memory:${memory.id}`,
      score: 30 + statusPenalty, signals, status: memory.status,
      detail: { id: memory.id, category: memory.category, content: memory.content, author: memory.author, updatedBy: memory.updatedBy },
    });
    if (sourceFreshness?.requiresReview) warnings.push(`Memory "${memory.title}" requires review: source is ${sourceFreshness.status}.`);
  }
  if (symbols.length === 0 && !explicitAnchorMode) warnings.push("No indexed symbols matched the task lexically; consider a more specific follow-up query.");
  if (memories.some((memory) => memory.status === "proposed")) warnings.push("Proposed memories are suggestions, not confirmed project knowledge.");
  if (memories.some((memory) => memory.status === "obsolete")) warnings.push("Obsolete memories are included for traceability and must not be treated as current guidance.");

  const perKindLimits: Record<TaskContextItem["kind"], number> = {
    symbol: symbolLimit, file: fileLimit, dependency: dependencyLimit, test: testLimit, memory: memoryLimit,
  };
  const bounded = boundedItems(candidates, maxItems, maxCharacters, perKindLimits);
  const truncatedKinds = new Set<TaskContextItem["kind"]>(bounded.truncatedKinds);
  if (symbolCandidatesTruncated) truncatedKinds.add("symbol");
  if (fileCandidatesTruncated) truncatedKinds.add("file");
  if (dependencyCandidatesTruncated) truncatedKinds.add("dependency");
  if (testCandidatesTruncated) truncatedKinds.add("test");
  if (memoryCandidatesTruncated) truncatedKinds.add("memory");
  if (bounded.truncated) warnings.push("Context was truncated to respect the configured item or character budget.");
  if (truncatedKinds.size > 0) warnings.push(`Per-kind context budgets truncated: ${[...truncatedKinds].join(", ")}.`);
  return {
    task: normalizedTask, anchors, items: bounded.items, warnings: [...new Set(warnings)],
    followUp: anchors.slice(0, 5).map((anchor) => `Inspect deeper details related to "${anchor}".`),
    budget: {
      maxItems, maxCharacters, usedItems: bounded.items.length, usedCharacters: bounded.usedCharacters,
      truncated: bounded.truncated || truncatedKinds.size > 0,
      perKind: Object.fromEntries(TASK_CONTEXT_KINDS.map((kind) => [kind, { limit: perKindLimits[kind], used: bounded.usedByKind[kind] }])) as Record<TaskContextItem["kind"], { limit: number; used: number }>,
      truncatedKinds: [...truncatedKinds],
    },
  };
}

/**
 * Retrieve additional details for a previously built context. This reads only the
 * requested indexed files and does not rerun task ranking, symbol search, or memory recall.
 */
export function lookupTaskContextDetails(
  location: ProjectLocation,
  context: TaskContextResult,
  sourcePaths: string[],
  options: { limit?: number; maxCharacters?: number } = {},
): TaskContextItem[] {
  const limit = options.limit ?? 5;
  const maxCharacters = options.maxCharacters ?? 8_000;
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0 || sourcePaths.length > 20) {
    throw new Error("sourcePaths must contain between 1 and 20 paths.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("limit must be between 1 and 20.");
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 100 || maxCharacters > MAX_CHARACTERS) {
    throw new Error("maxCharacters must be between 100 and 50000.");
  }
  const knownSources = new Set(context.items.map((item) => item.source.split(":")[0]));
  const uniquePaths = [...new Set(sourcePaths.map((path) => path.replaceAll("\\", "/").replace(/^\.\//, "")))];
  const results: TaskContextItem[] = [];
  let used = 0;
  for (const path of uniquePaths) {
    if (results.length >= limit) break;
    if (!knownSources.has(path) && !context.items.some((item) => item.source === path || item.title === path)) {
      throw new Error(`Follow-up path is not referenced by the existing context: ${path}.`);
    }
    const detail = getFileDetails(location, path, Math.min(20, limit));
    const item: TaskContextItem = {
      kind: "file", origin: "anchor", title: path, source: path, score: 1,
      signals: ["explicit-follow-up-lookup", "existing-context-source"],
      detail: {
        indexRevision: detail.indexRevision, contentHash: detail.contentHash,
        symbols: detail.symbols, imports: detail.imports, unresolvedImports: detail.unresolvedImports,
        relations: detail.relations, totals: detail.totals, truncated: detail.truncated,
      },
    };
    const size = JSON.stringify(item).length;
    if (used + size > maxCharacters) continue;
    results.push(item);
    used += size;
  }
  return results;
}
