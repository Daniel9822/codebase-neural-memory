import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildTaskContext } from "../src/core/context.js";
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
  writeFileSync(join(rootPath, "src", "auth.ts"), "export function refreshAuthToken() { return true; }\n");
  writeFileSync(join(rootPath, "tests", "auth.test.ts"), "import { refreshAuthToken } from '../src/auth';\n");
  indexWithDatabase(db, location);
}

afterEach(() => {
  db?.close();
  db = undefined;
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = "";
});

describe("task-oriented context builder", () => {
  it("returns ranked source-backed symbols, test paths, and lifecycle-labeled memories", () => {
    setup();
    remember(location, "Refresh auth token", "The refresh token must be rotated.", "decision", "src/auth.ts");
    proposeMemory(location, "Auth follow-up", "Review expiry edge cases.", "note");
    const result = buildTaskContext(location, "refresh auth token tests", { maxItems: 20, maxCharacters: 8000 });

    expect(result.anchors).toContain("refresh");
    expect(result.items.some((item) => item.kind === "symbol" && item.title.includes("refreshAuthToken"))).toBe(true);
    expect(result.items.some((item) => item.kind === "test" && item.source.includes("auth.test.ts"))).toBe(true);
    expect(result.items.some((item) => item.kind === "memory" && item.status === "confirmed")).toBe(true);
    expect(result.items.some((item) => item.kind === "memory" && item.status === "proposed")).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("Proposed memories"))).toBe(true);
    expect(result.budget.usedItems).toBeLessThanOrEqual(20);
    expect(result.budget.usedCharacters).toBeLessThanOrEqual(8000);
  });

  it("enforces item and character budgets and rejects invalid input", () => {
    setup();
    const result = buildTaskContext(location, "refresh auth token", { maxItems: 1, maxCharacters: 500 });
    expect(result.items).toHaveLength(1);
    expect(result.budget.usedItems).toBe(1);
    expect(result.budget.usedCharacters).toBeLessThanOrEqual(500);
    expect(result.budget.truncated).toBe(true);
    expect(() => buildTaskContext(location, "   ")).toThrow("Task description must not be empty");
    expect(() => buildTaskContext(location, "auth", { maxCharacters: 10 })).toThrow("maxCharacters");
  });
});
