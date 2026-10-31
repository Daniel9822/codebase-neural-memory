import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureProject, openDatabase, type MemoryDatabase } from "../src/storage/database.js";
import type { ProjectLocation } from "../src/core/project.js";
import { indexWithDatabase } from "../src/core/indexer.js";

let temporaryDirectory = "";
let database: MemoryDatabase | undefined;
let location: ProjectLocation;

function createProject(): void {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "cnm-indexer-test-"));
  const rootPath = join(temporaryDirectory, "repository");
  mkdirSync(rootPath, { recursive: true });
  location = {
    id: "indexer-test-project",
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

describe("indexWithDatabase", () => {
  it("does not delete an indexed file just because it grows beyond the size limit", () => {
    createProject();
    const filePath = join(location.rootPath, "src", "large.ts");
    mkdirSync(join(location.rootPath, "src"), { recursive: true });
    writeFileSync(filePath, "export const retained = true;\n");

    const initial = indexWithDatabase(database!, location);
    expect(initial.added).toBe(1);

    writeFileSync(filePath, "export const retained = true;\n// " + "x".repeat(1_000_001));
    const next = indexWithDatabase(database!, location);

    expect(next.deleted).toBe(0);
    expect(database!.prepare("SELECT path FROM files WHERE path = ?").get("src/large.ts")).toEqual({
      path: "src/large.ts",
    });
  });

  it("honors nested .gitignore rules without ignoring sibling source files", () => {
    createProject();
    mkdirSync(join(location.rootPath, "src", "private"), { recursive: true });
    writeFileSync(join(location.rootPath, ".gitignore"), "root-secret.ts\n");
    writeFileSync(join(location.rootPath, "src", ".gitignore"), "private/\n*.generated.ts\n");
    writeFileSync(join(location.rootPath, "root-secret.ts"), "export const hidden = true;");
    writeFileSync(join(location.rootPath, "src", "private", "secret.ts"), "export const secret = true;");
    writeFileSync(join(location.rootPath, "src", "model.generated.ts"), "export const generated = true;");
    writeFileSync(join(location.rootPath, "src", "visible.ts"), "export const visible = true;");

    const summary = indexWithDatabase(database!, location);
    const indexedPaths = (database!.prepare("SELECT path FROM files ORDER BY path").all() as Array<{ path: string }>)
      .map((row) => row.path);

    expect(summary.added).toBe(1);
    expect(indexedPaths).toEqual(["src/visible.ts"]);
  });

  it("removes a file that was actually deleted from disk", () => {
    createProject();
    const filePath = join(location.rootPath, "gone.ts");
    writeFileSync(filePath, "export const gone = true;");
    indexWithDatabase(database!, location);
    rmSync(filePath);

    const summary = indexWithDatabase(database!, location);

    expect(summary.deleted).toBe(1);
    expect(database!.prepare("SELECT COUNT(*) AS count FROM files").get()).toEqual({ count: 0 });
  });

  it("skips unchanged content and updates changed symbols incrementally", () => {
    createProject();
    const filePath = join(location.rootPath, "service.ts");
    writeFileSync(filePath, "export function firstVersion() { return 1; }");

    const initial = indexWithDatabase(database!, location);
    const unchanged = indexWithDatabase(database!, location);
    writeFileSync(filePath, "export function secondVersion() { return 2; }");
    const updated = indexWithDatabase(database!, location);

    expect(initial.added).toBe(1);
    expect(unchanged.unchanged).toBe(1);
    expect(unchanged.updated).toBe(0);
    expect(updated.updated).toBe(1);
    expect(database!.prepare("SELECT name FROM symbols").all()).toEqual([{ name: "secondVersion" }]);
  });

  it("rebuilds a local import relation between indexed files", () => {
    createProject();
    mkdirSync(join(location.rootPath, "src"), { recursive: true });
    writeFileSync(join(location.rootPath, "src", "main.ts"), 'import { helper } from "./helper";\\nexport function run() { helper(); }');
    writeFileSync(join(location.rootPath, "src", "helper.ts"), "export function helper() { return true; }");

    const summary = indexWithDatabase(database!, location);
    const imports = database!.prepare("SELECT kind FROM relations WHERE kind = 'IMPORTS'").all();

    expect(summary.added).toBe(2);
    expect(imports).toEqual([{ kind: "IMPORTS" }]);
  });

});
