import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("supports additive custom exclusions without disabling mandatory safety exclusions", () => {
    createProject();
    mkdirSync(join(location.rootPath, "generated"), { recursive: true });
    writeFileSync(join(location.rootPath, "generated", "artifact.ts"), "export const generated = true;");
    writeFileSync(join(location.rootPath, "keep.ts"), "export const keep = true;");
    writeFileSync(join(location.rootPath, ".env"), "SECRET=value");
    writeFileSync(join(location.rootPath, "secret.key"), "private key");

    const summary = indexWithDatabase(database!, location, false, ["generated/"]);
    const indexedPaths = (database!.prepare("SELECT path FROM files ORDER BY path").all() as Array<{ path: string }>).map((row) => row.path);

    expect(summary.added).toBe(1);
    expect(indexedPaths).toEqual(["keep.ts"]);
  });

  it("skips file symlinks by default", () => {
    createProject();
    const outsidePath = join(temporaryDirectory, "outside.ts");
    writeFileSync(outsidePath, "export const outside = true;");
    symlinkSync(outsidePath, join(location.rootPath, "linked.ts"));
    writeFileSync(join(location.rootPath, "normal.ts"), "export const normal = true;");

    const summary = indexWithDatabase(database!, location);
    const indexedPaths = (database!.prepare("SELECT path FROM files ORDER BY path").all() as Array<{ path: string }>).map((row) => row.path);

    expect(summary.added).toBe(1);
    expect(indexedPaths).toEqual(["normal.ts"]);
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
    writeFileSync(join(location.rootPath, "src", "main.ts"), 'import { helper } from "./helper";\nexport function run() { helper(); }');
    writeFileSync(join(location.rootPath, "src", "helper.ts"), "export function helper() { return true; }");

    const summary = indexWithDatabase(database!, location);
    const imports = database!.prepare("SELECT kind FROM relations WHERE kind = 'IMPORTS'").all();

    expect(summary.added).toBe(2);
    expect(imports).toEqual([{ kind: "IMPORTS" }]);
  });


  it("rolls back the entire indexing run when relation rebuilding fails", () => {
    createProject();
    mkdirSync(join(location.rootPath, "src"), { recursive: true });
    const mainPath = join(location.rootPath, "src", "main.ts");
    const helperPath = join(location.rootPath, "src", "helper.ts");
    writeFileSync(mainPath, 'import { helper } from "./helper";\nexport function run() { helper(); }');
    writeFileSync(helperPath, "export function helper() { return 1; }");
    indexWithDatabase(database!, location);

    const oldHash = (database!.prepare("SELECT content_hash FROM files WHERE path = ?").get("src/helper.ts") as { content_hash: string }).content_hash;
    database!.exec("CREATE TRIGGER fail_relation_insert BEFORE INSERT ON relations BEGIN SELECT RAISE(ABORT, 'forced relation failure'); END;");
    writeFileSync(helperPath, "export function changedHelper() { return 2; }");
    writeFileSync(join(location.rootPath, "src", "new.ts"), "export const newFile = true;");

    expect(() => indexWithDatabase(database!, location)).toThrow("forced relation failure");

    const currentHash = (database!.prepare("SELECT content_hash FROM files WHERE path = ?").get("src/helper.ts") as { content_hash: string }).content_hash;
    const symbols = database!.prepare("SELECT name FROM symbols ORDER BY name").all();
    const fileCount = (database!.prepare("SELECT COUNT(*) AS count FROM files").get() as { count: number }).count;
    const relationCount = (database!.prepare("SELECT COUNT(*) AS count FROM relations").get() as { count: number }).count;

    expect(currentHash).toBe(oldHash);
    expect(symbols).toContainEqual({ name: "helper" });
    expect(symbols).not.toContainEqual({ name: "changedHelper" });
    expect(fileCount).toBe(2);
    expect(relationCount).toBe(1);
  });

  it("reports malformed files without aborting other files or replacing a valid index", () => {
    createProject();
    const validPath = join(location.rootPath, "valid.ts");
    const brokenPath = join(location.rootPath, "broken.ts");
    writeFileSync(validPath, "export function stable() { return true; }");
    writeFileSync(brokenPath, "export function broken( {");

    const first = indexWithDatabase(database!, location);
    expect(first.added).toBe(1);
    expect(first.failed).toBe(1);
    expect(first.errors.join(" ")).toMatch(/broken\.ts/);
    expect(database!.prepare("SELECT name FROM symbols").all()).toEqual([{ name: "stable" }]);

    writeFileSync(validPath, "export function stableChanged() { return true; }");
    writeFileSync(brokenPath, "export function broken() { return true; }");
    const recovered = indexWithDatabase(database!, location);
    expect(recovered.added).toBe(1);
    expect(recovered.updated).toBe(1);
    expect(recovered.failed).toBe(0);
    expect(database!.prepare("SELECT name FROM symbols ORDER BY name").all())
      .toEqual([{ name: "broken" }, { name: "stableChanged" }]);
  });

  it("skips binary source files and reports their paths", () => {
    createProject();
    writeFileSync(join(location.rootPath, "binary.ts"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(location.rootPath, "plain.ts"), "export const plain = true;");

    const summary = indexWithDatabase(database!, location);
    expect(summary.scanned).toBe(2);
    expect(summary.skipped).toBe(1);
    expect(summary.skippedFiles).toEqual(["binary.ts: binary content"]);
    expect(summary.added).toBe(1);
    expect(database!.prepare("SELECT path FROM files").all()).toEqual([{ path: "plain.ts" }]);
  });
  it("preserves the previous file index when an updated file becomes malformed", () => {
    createProject();
    const filePath = join(location.rootPath, "stable.ts");
    writeFileSync(filePath, "export function stable() { return true; }");
    indexWithDatabase(database!, location);
    const previous = database!.prepare("SELECT content_hash FROM files WHERE path = ?").get("stable.ts");

    writeFileSync(filePath, "export function stable( {");
    const summary = indexWithDatabase(database!, location);

    expect(summary.failed).toBe(1);
    expect(database!.prepare("SELECT content_hash FROM files WHERE path = ?").get("stable.ts")).toEqual(previous);
    expect(database!.prepare("SELECT name FROM symbols").all()).toEqual([{ name: "stable" }]);
  });

});
