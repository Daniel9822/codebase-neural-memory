import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexWithDatabase } from "../src/core/indexer.js";
import { deleteMemory, inspectMemoryFreshness, proposeMemory, remember, recallMemories, transitionMemory, updateMemory } from "../src/core/memories.js";
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


describe("explicit memory lifecycle", () => {
  it("stores optional source path and commit metadata and supports explicit updates", () => {
    createProject();
    const id = remember(location, "Initial decision", "Use the adapter boundary.", "decision", "src/adapter.ts", "abc123");
    expect(recallMemories(location)[0]).toMatchObject({
      id, status: "confirmed", sourcePath: "src/adapter.ts", commitSha: "abc123",
    });

    expect(updateMemory(location, id, {
      title: "Revised decision",
      content: "Keep the adapter boundary stable.",
      category: "architecture",
      sourcePath: "src/core/adapter.ts",
      commitSha: "def456",
    })).toBe(true);
    expect(recallMemories(location, "Revised decision")[0]).toMatchObject({
      id,
      title: "Revised decision",
      content: "Keep the adapter boundary stable.",
      category: "architecture",
      sourcePath: "src/core/adapter.ts",
      commitSha: "def456",
      status: "confirmed",
    });
    expect(() => updateMemory(location, id, {})).toThrow("At least one memory field");
    expect(() => updateMemory(location, id, { title: "   " })).toThrow("title must not be empty");
    expect(updateMemory(location, "missing-memory", { title: "No row" })).toBe(false);
  });

  it("requires explicit approval or rejection for proposed memories and enforces transitions", () => {
    createProject();
    const proposed = proposeMemory(location, "Potential rule", "Review before adoption.", "decision");
    expect(recallMemories(location)[0]).toMatchObject({ id: proposed, status: "proposed" });

    expect(() => transitionMemory(location, proposed, "obsolete")).toThrow("Invalid memory status transition");
    expect(transitionMemory(location, proposed, "confirmed")).toBe(true);
    expect(recallMemories(location)[0]).toMatchObject({ id: proposed, status: "confirmed" });
    expect(transitionMemory(location, proposed, "obsolete")).toBe(true);
    expect(recallMemories(location)[0]).toMatchObject({ id: proposed, status: "obsolete" });
    expect(transitionMemory(location, proposed, "confirmed")).toBe(true);
    expect(() => transitionMemory(location, proposed, "rejected")).toThrow("Invalid memory status transition");

    const rejected = proposeMemory(location, "Rejected suggestion", "Do not adopt.");
    expect(transitionMemory(location, rejected, "rejected")).toBe(true);
    expect(recallMemories(location).some((memory) => memory.id === rejected)).toBe(false);
    expect(() => transitionMemory(location, rejected, "confirmed")).toThrow("Invalid memory status transition");
    expect(() => transitionMemory(location, proposed, "unknown" as never)).toThrow("Unsupported memory status");
    expect(transitionMemory(location, "missing-memory", "confirmed")).toBe(false);
  });

  it("detects changed and missing source files without changing memory status", () => {
    createProject();
    writeFileSync(join(location.rootPath, "src.ts"), "export const value = 1;");
    const id = remember(location, "Source-backed decision", "Keep this source boundary.", "decision", "src.ts");
    expect(recallMemories(location)[0]).toMatchObject({ id, sourceHash: expect.any(String) });
    expect(inspectMemoryFreshness(location)).toMatchObject([{ id, status: "current", requiresReview: false }]);

    writeFileSync(join(location.rootPath, "src.ts"), "export const value = 2;");
    expect(inspectMemoryFreshness(location)).toMatchObject([{ id, status: "changed", requiresReview: true }]);
    expect(recallMemories(location)[0]).toMatchObject({ id, status: "confirmed" });

    rmSync(join(location.rootPath, "src.ts"));
    expect(inspectMemoryFreshness(location)).toMatchObject([{ id, status: "missing", requiresReview: true }]);
    expect(recallMemories(location)[0]).toMatchObject({ id, status: "confirmed" });
  });

  it("requires review for legacy source references and flags symlink escapes safely", () => {
    createProject();
    writeFileSync(join(location.rootPath, "source.ts"), "export const value = 1;");
    const id = remember(location, "Tracked decision", "Keep this boundary.", "decision", "source.ts");
    database!.prepare("UPDATE memories SET source_hash = NULL WHERE id = ?").run(id);
    expect(inspectMemoryFreshness(location)).toMatchObject([
      { id, status: "untracked", requiresReview: true },
    ]);

    const outside = join(temporaryDirectory, "outside.ts");
    writeFileSync(outside, "export const secret = true;");
    rmSync(join(location.rootPath, "source.ts"));
    symlinkSync(outside, join(location.rootPath, "source.ts"));
    expect(inspectMemoryFreshness(location)).toMatchObject([
      { id, status: "unsafe", requiresReview: true },
    ]);
    expect(recallMemories(location)[0]).toMatchObject({ id, status: "confirmed" });
  });

  it("rejects source paths that traverse outside the project root", () => {
    createProject();
    expect(() => remember(location, "Unsafe reference", "Do not accept traversal.", "decision", "../outside.ts"))
      .toThrow("must stay inside the project root");
  });

  it("deletes memories only from the selected project's database", () => {
    createProject();
    const id = remember(location, "Project A note", "Scoped note.");
    const otherLocation: ProjectLocation = {
      id: "other-memory-project",
      rootPath: join(temporaryDirectory, "other-repository"),
      dataDirectory: join(temporaryDirectory, "other-data"),
      databasePath: join(temporaryDirectory, "other-data", "memory.sqlite"),
    };
    mkdirSync(otherLocation.rootPath, { recursive: true });
    const otherDb = openDatabase(otherLocation);
    try { ensureProject(otherDb, otherLocation); } finally { otherDb.close(); }
    const otherId = remember(otherLocation, "Project B note", "Separate note.");

    expect(deleteMemory(location, otherId)).toBe(false);
    expect(recallMemories(otherLocation)[0]).toMatchObject({ id: otherId });
    expect(deleteMemory(location, id)).toBe(true);
    expect(deleteMemory(location, id)).toBe(false);
    expect(recallMemories(location)).toEqual([]);
    expect(recallMemories(otherLocation)[0]).toMatchObject({ id: otherId });
  });

  it("validates recall limits", () => {
    createProject();
    expect(() => recallMemories(location, "", 0)).toThrow("Memory limit");
    expect(() => recallMemories(location, "", 501)).toThrow("Memory limit");
  });
});
