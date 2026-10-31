import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexWithDatabase } from "../src/core/indexer.js";
import { remember, recallMemories } from "../src/core/memories.js";
import type { ProjectLocation } from "../src/core/project.js";
import { ensureProject, openDatabase, type MemoryDatabase } from "../src/storage/database.js";

let temporaryDirectory = "";
let database: MemoryDatabase | undefined;
let location: ProjectLocation;

function createProject(): void {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "cnm-knowledge-origin-test-"));
  const rootPath = join(temporaryDirectory, "repository");
  mkdirSync(rootPath, { recursive: true });
  location = {
    id: "knowledge-origin-test-project",
    rootPath,
    dataDirectory: join(temporaryDirectory, "data"),
    databasePath: join(temporaryDirectory, "data", "memory.sqlite"),
  };
  database = openDatabase(location);
  ensureProject(database, location);
}

afterEach(() => {
  database?.close();
  database = undefined;
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = "";
});

describe("human-confirmed knowledge and parser-derived graph facts", () => {
  it("stores explicit human memories separately from parser-derived relations", () => {
    createProject();
    writeFileSync(join(location.rootPath, "main.ts"), 'import "./dependency";');
    writeFileSync(join(location.rootPath, "dependency.ts"), "export const dependency = true;");

    indexWithDatabase(database!, location);
    const parserRelations = database!.prepare(
      "SELECT source_kind, target_kind, kind, confidence, provenance FROM relations",
    ).all();
    expect(parserRelations).toEqual([{
      source_kind: "file",
      target_kind: "file",
      kind: "IMPORTS",
      confidence: 1,
      provenance: "typescript-ast",
    }]);

    const memoryId = remember(
      location,
      "Keep the domain boundary explicit",
      "The billing module must not own customer identity.",
      "decision",
    );
    const memories = recallMemories(location, "domain boundary");

    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      id: memoryId,
      category: "decision",
      title: "Keep the domain boundary explicit",
      content: "The billing module must not own customer identity.",
      status: "confirmed",
      sourcePath: null,
    });
    expect(database!.prepare("SELECT COUNT(*) AS count FROM relations").get()).toEqual({ count: 1 });
    expect(database!.prepare("SELECT COUNT(*) AS count FROM memories").get()).toEqual({ count: 1 });
  });
});
