import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildTaskContext, lookupTaskContextDetails } from "../src/core/context.js";
import { remember, proposeMemory } from "../src/core/memories.js";
import { ensureProject, openDatabase, type MemoryDatabase } from "../src/storage/database.js";
import type { ProjectLocation } from "../src/core/project.js";
import { indexWithDatabase } from "../src/core/indexer.js";

let temp = "";
let db: MemoryDatabase | undefined;
let location: ProjectLocation;

function setup(): void {
  temp = mkdtempSync(join(tmpdir(), "cnm-task-context-"));
  const rootPath = join(temp, "repo");
  mkdirSync(join(rootPath, "src"), { recursive: true });
  mkdirSync(join(rootPath, "tests"), { recursive: true });
  location = { id: "task-context-test", rootPath, dataDirectory: join(temp, "data"), databasePath: join(temp, "data", "memory.sqlite") };
  db = openDatabase(location);
  ensureProject(db, location);
  writeFileSync(join(rootPath, "src", "auth.ts"), "import { normalizeToken } from './token';\nimport './missing-module';\nexport function refreshAuthToken() { return normalizeToken(); }\n");
  writeFileSync(join(rootPath, "src", "token.ts"), "export function normalizeToken() { return true; }\n");
  writeFileSync(join(rootPath, "tests", "auth.test.ts"), "import { refreshAuthToken } from '../src/auth';\n");
  writeFileSync(join(rootPath, "tests", "billing.test.ts"), "export function calculatesInvoiceTotal() { return 42; }\\n");
  indexWithDatabase(db, location);
}

afterEach(() => {
  db?.close();
  db = undefined;
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = "";
});

describe("task-oriented context builder", () => {
  it("returns ranked source-backed symbols, dependencies, test paths, and lifecycle-labeled memories", () => {
    setup();
    remember(location, "Refresh auth token", "The refresh token must be rotated.", "decision", "src/auth.ts");
    proposeMemory(location, "Auth follow-up", "Review expiry edge cases.", "note");
    const result = buildTaskContext(location, "refresh auth token tests", { maxItems: 30, maxCharacters: 12000 });

    expect(result.anchors).toContain("refresh");
    expect(result.items.some((item) => item.kind === "symbol" && item.title.includes("refreshAuthToken"))).toBe(true);
    expect(result.items.some((item) => item.kind === "dependency" && item.source === "src/token.ts")).toBe(true);
    expect(result.items.some((item) => item.kind === "test" && item.source === "tests/auth.test.ts")).toBe(true);
    const mappedTest = result.items.find((item) => item.kind === "test" && item.source === "tests/auth.test.ts" && item.origin === "graph");
    expect(mappedTest?.signals).toContain("reverse-import-dependent");
    expect(mappedTest?.detail).toMatchObject({
      target: "src/auth.ts",
      relationship: "direct-or-transitive-import-dependent",
    });
    expect(result.items.some((item) => item.kind === "test" && item.source === "tests/billing.test.ts")).toBe(false);
    expect(result.items.some((item) => item.kind === "memory" && item.status === "confirmed")).toBe(true);
    expect(result.items.some((item) => item.kind === "memory" && item.status === "proposed")).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("Proposed memories"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("missing-module") && warning.includes("unresolved"))).toBe(true);
    expect(result.items.filter((item) => item.kind === "dependency" && item.source === "src/token.ts")).toHaveLength(1);
    expect(result.items.filter((item) => item.kind === "dependency").every((item) => item.detail !== undefined)).toBe(true);
    expect(result.budget.usedItems).toBeLessThanOrEqual(30);
    expect(result.budget.usedCharacters).toBe(JSON.stringify(result.items).length);
    expect(result.budget.usedCharacters).toBeLessThanOrEqual(12000);
  });

  it("retrieves requested details incrementally from a source already present in context", () => {
    setup();
    const context = buildTaskContext(location, "refresh auth token", { maxItems: 20, maxCharacters: 8000 });
    const followUp = lookupTaskContextDetails(location, context, ["src/auth.ts", "src/auth.ts"], { limit: 3 });

    expect(followUp).toHaveLength(1);
    expect(followUp[0].source).toBe("src/auth.ts");
    expect(followUp[0].signals).toContain("explicit-follow-up-lookup");
    expect((followUp[0].detail as { imports: unknown[] }).imports.length).toBeGreaterThan(0);
    expect(() => lookupTaskContextDetails(location, context, ["src/not-in-context.ts"])).toThrow("not referenced");
  });

  it("marks context as stale when indexed source files have changed", () => {
    setup();
    writeFileSync(join(location.rootPath, "src", "auth.ts"), "export function refreshAuthToken() { return false; }\\n");
    const result = buildTaskContext(location, "refresh auth token");
    expect(result.warnings.some((warning) => warning.includes("Indexed source is stale"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("changed: 1"))).toBe(true);
  });

  it("enforces item and character budgets and rejects invalid input", () => {
    setup();
    const result = buildTaskContext(location, "refresh auth token", { maxItems: 1, maxCharacters: 500 });
    expect(result.items).toHaveLength(1);
    expect(result.budget.usedItems).toBe(1);
    expect(result.budget.usedCharacters).toBe(JSON.stringify(result.items).length);
    expect(result.budget.usedCharacters).toBeLessThanOrEqual(500);
    expect(result.budget.truncated).toBe(true);
    const exactBudget = result.budget.usedCharacters;
    const exact = buildTaskContext(location, "refresh auth token", { maxItems: 1, maxCharacters: exactBudget });
    expect(exact.items).toHaveLength(1);
    expect(exact.budget.usedCharacters).toBe(exactBudget);
    const tooSmall = buildTaskContext(location, "refresh auth token", { maxItems: 1, maxCharacters: exactBudget - 1 });
    expect(tooSmall.items).not.toContainEqual(exact.items[0]);
    expect(tooSmall.budget.usedCharacters).toBe(JSON.stringify(tooSmall.items).length);
    expect(tooSmall.budget.usedCharacters).toBeLessThanOrEqual(exactBudget - 1);
    expect(() => buildTaskContext(location, "   ")).toThrow("Task description must not be empty");
    expect(() => buildTaskContext(location, "auth", { maxCharacters: 10 })).toThrow("maxCharacters");
    expect(() => lookupTaskContextDetails(location, result, ["src/auth.ts"], { limit: 0 })).toThrow("limit");
  });
});
