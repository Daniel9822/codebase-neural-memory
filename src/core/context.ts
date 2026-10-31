import { getFileDetails, searchSymbols } from "./retrieval.js";
import { inspectMemoryFreshness, recallMemories } from "./memories.js";
import type { ProjectLocation } from "./project.js";

export interface TaskContextOptions {
  maxItems?: number;
  maxCharacters?: number;
  symbolLimit?: number;
  memoryLimit?: number;
  fileLimit?: number;
}

export interface TaskContextResult {
  task: string;
  anchors: string[];
  items: Array<{
    kind: "symbol" | "file" | "memory" | "test";
    title: string;
    source: string;
    score: number;
    signals: string[];
    status?: string;
    detail?: unknown;
  }>;
  warnings: string[];
  followUp: string[];
  budget: { maxItems: number; maxCharacters: number; usedItems: number; usedCharacters: number; truncated: boolean };
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
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > MAX_ITEMS) throw new Error("maxItems must be between 1 and 100.");
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 100 || maxCharacters > MAX_CHARACTERS) throw new Error("maxCharacters must be between 100 and 50000.");
  for (const [name, value, max] of [["symbolLimit", symbolLimit, 50], ["memoryLimit", memoryLimit, 50], ["fileLimit", fileLimit, 50]] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${name} must be between 1 and ${max}.`);
  }

  const anchors = anchorsFor(normalizedTask);
  const candidates: TaskContextResult["items"] = [];
  const warnings: string[] = [];
  const symbols = searchSymbols(location, normalizedTask, symbolLimit);
  for (const symbol of symbols) {
    candidates.push({
      kind: "symbol",
      title: `${symbol.name} (${symbol.kind})`,
      source: `${symbol.filePath}:${symbol.startLine}-${symbol.endLine}`,
      score: symbol.score,
      signals: [...symbol.rankingSignals],
      detail: { signature: symbol.signature, exported: symbol.exported, searchMethod: symbol.searchMethod },
    });
  }

  const seenFiles = new Set<string>();
  for (const symbol of symbols) {
    if (seenFiles.has(symbol.filePath) || seenFiles.size >= fileLimit) continue;
    seenFiles.add(symbol.filePath);
    try {
      const detail = getFileDetails(location, symbol.filePath, 20);
      candidates.push({
        kind: "file",
        title: symbol.filePath,
        source: symbol.filePath,
        score: Math.max(1, symbol.score - 5),
        signals: ["contains-matching-symbol", "indexed-file"],
        detail: {
          indexRevision: detail.indexRevision,
          symbols: detail.symbols.slice(0, 10).map((entry) => ({ name: entry.name, kind: entry.kind, startLine: entry.startLine, endLine: entry.endLine })),
          imports: detail.imports.slice(0, 10),
          unresolvedImports: detail.unresolvedImports.slice(0, 5),
          relations: detail.relations.slice(0, 10),
        },
      });
      if (/(^|[/\\])tests?([/\\.-]|$)|\.(test|spec)\.[cm]?[jt]sx?$/i.test(symbol.filePath)) {
        candidates.push({
          kind: "test",
          title: `Test source: ${symbol.filePath}`,
          source: symbol.filePath,
          score: symbol.score + 2,
          signals: ["test-path", "lexical-match"],
          detail: { startLine: symbol.startLine, endLine: symbol.endLine },
        });
      }
    } catch {
      warnings.push(`Could not load indexed details for ${symbol.filePath}; the index may have changed.`);
    }
  }

  const memories = recallMemories(location, normalizedTask, memoryLimit);
  const freshness = inspectMemoryFreshness(location);
  const freshnessById = new Map(freshness.map((entry) => [entry.id, entry]));
  for (const memory of memories) {
    const sourceFreshness = freshnessById.get(memory.id);
    const signals = ["lexical-memory-match", `status:${memory.status}`];
    if (sourceFreshness?.requiresReview) signals.push(`source:${sourceFreshness.status}`);
    const statusPenalty = memory.status === "confirmed" ? 0 : memory.status === "proposed" ? -8 : -15;
    candidates.push({
      kind: "memory",
      title: memory.title,
      source: memory.sourcePath ?? `memory:${memory.id}`,
      score: 30 + statusPenalty,
      signals,
      status: memory.status,
      detail: { id: memory.id, category: memory.category, content: memory.content, author: memory.author, updatedBy: memory.updatedBy },
    });
    if (sourceFreshness?.requiresReview) warnings.push(`Memory "${memory.title}" requires review: source is ${sourceFreshness.status}.`);
  }
  if (symbols.length === 0) warnings.push("No indexed symbols matched the task lexically; consider a more specific follow-up query.");
  if (memories.some((memory) => memory.status === "proposed")) warnings.push("Proposed memories are suggestions, not confirmed project knowledge.");
  if (memories.some((memory) => memory.status === "obsolete")) warnings.push("Obsolete memories are included for traceability and must not be treated as current guidance.");

  candidates.sort((a, b) => b.score - a.score || a.source.localeCompare(b.source) || a.title.localeCompare(b.title));
  const items: TaskContextResult["items"] = [];
  let usedCharacters = 0;
  let truncated = false;
  for (const item of candidates) {
    if (items.length >= maxItems) { truncated = true; break; }
    const size = JSON.stringify(item).length;
    if (usedCharacters + size > maxCharacters) { truncated = true; continue; }
    items.push(item);
    usedCharacters += size;
  }
  if (truncated) warnings.push("Context was truncated to respect the configured item or character budget.");
  return {
    task: normalizedTask,
    anchors,
    items,
    warnings: [...new Set(warnings)],
    followUp: anchors.slice(0, 5).map((anchor) => `Inspect deeper details related to "${anchor}".`),
    budget: { maxItems, maxCharacters, usedItems: items.length, usedCharacters, truncated },
  };
}
