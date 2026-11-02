import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, opendirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureProject, openDatabase, type MemoryDatabase } from "../src/storage/database.js";
import type { ProjectLocation } from "../src/core/project.js";
import { discoverFiles, getIndexFreshness, indexProject, indexWithDatabase, updateProjectIndex } from "../src/core/indexer.js";
import { getProjectMapReport } from "../src/core/retrieval.js";

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
  it("reindexes only an explicitly selected file and preserves every out-of-scope record", () => {
    createProject();
    mkdirSync(join(location.rootPath, "src"), { recursive: true });
    writeFileSync(join(location.rootPath, "src", "a.ts"), "export function before() { return true; }");
    writeFileSync(join(location.rootPath, "src", "b.ts"), "export function untouched() { return true; }");
    indexWithDatabase(database!, location);

    writeFileSync(join(location.rootPath, "src", "a.ts"), "export function after() { return true; }");
    rmSync(join(location.rootPath, "src", "b.ts"));
    const summary = indexWithDatabase(database!, location, false, [], { paths: ["src/a.ts"] });

    expect(summary.updated).toBe(1);
    expect(summary.deleted).toBe(0);
    expect(database!.prepare("SELECT path FROM files ORDER BY path").all()).toEqual([
      { path: "src/a.ts" }, { path: "src/b.ts" },
    ]);
    expect(database!.prepare("SELECT name FROM symbols ORDER BY name").all()).toEqual([
      { name: "after" }, { name: "untouched" },
    ]);
  });

  it("selects directory descendants and intersects path selectors with include globs", () => {
    createProject();
    mkdirSync(join(location.rootPath, "src", "nested"), { recursive: true });
    mkdirSync(join(location.rootPath, "tests"), { recursive: true });
    writeFileSync(join(location.rootPath, "src", "root.ts"), "export const root = true;");
    writeFileSync(join(location.rootPath, "src", "nested", "match.ts"), "export const match = true;");
    writeFileSync(join(location.rootPath, "src", "nested", "skip.js"), "export const skip = true;");
    writeFileSync(join(location.rootPath, "tests", "test.ts"), "export const test = true;");

    const summary = indexWithDatabase(database!, location, false, [], {
      paths: ["src"], include: ["src/**/*.ts"],
    });

    expect(summary.added).toBe(2);
    expect(database!.prepare("SELECT path FROM files ORDER BY path").all()).toEqual([
      { path: "src/nested/match.ts" }, { path: "src/root.ts" },
    ]);
  });

  it("allows bounded MCP-style reconciliation to commit processed files and report the remaining scope", () => {
    createProject();
    writeFileSync(join(location.rootPath, "a.ts"), "export function beforeA() { return true; }");
    writeFileSync(join(location.rootPath, "b.ts"), "export function beforeB() { return true; }");
    indexWithDatabase(database!, location);
    writeFileSync(join(location.rootPath, "a.ts"), "export function afterA() { return true; }");
    writeFileSync(join(location.rootPath, "b.ts"), "export function afterB() { return true; }");

    const summary = updateProjectIndex(location, { paths: ["a.ts", "b.ts"], maxFiles: 1 });

    expect(summary.updated).toBe(1);
    expect(summary.truncated).toBe(true);
    expect(summary.deleted).toBe(0);
    expect(database!.prepare("SELECT name FROM symbols ORDER BY name").all()).toEqual([
      { name: "afterA" }, { name: "beforeB" },
    ]);
  });

  it("stops at maxFiles and reports truncation without deleting unselected files", () => {
    createProject();
    writeFileSync(join(location.rootPath, "a.ts"), "export const a = true;");
    writeFileSync(join(location.rootPath, "b.ts"), "export const b = true;");
    writeFileSync(join(location.rootPath, "c.ts"), "export const c = true;");

    const summary = indexWithDatabase(database!, location, false, [], { maxFiles: 1 });

    expect(summary.scanned).toBe(1);
    expect(summary.added).toBe(1);
    expect(summary.truncated).toBe(true);
    expect(summary.deleted).toBe(0);
    expect(database!.prepare("SELECT path FROM files").all()).toEqual([{ path: "a.ts" }]);
  });

  it("aborts without writes when maxProcessed cannot enumerate a complete deterministic candidate set", () => {
    createProject();
    writeFileSync(join(location.rootPath, "a.ts"), "export const a = true;");
    writeFileSync(join(location.rootPath, "b.ts"), "export const b = true;");

    const discovery = discoverFiles(location.rootPath, [], { maxProcessed: 1 });
    expect(discovery.abortRequired).toBe(true);
    expect(discovery.protectedDirectories.has("")).toBe(true);
    expect(() => indexWithDatabase(database!, location, false, [], { maxProcessed: 1 }))
      .toThrow(/discovery could not safely complete/i);
    expect(database!.prepare("SELECT path FROM files ORDER BY path").all()).toEqual([]);
  });

  it("reports incomplete freshness without deleting indexed paths when a directory exceeds the sorting cap", () => {
    createProject();
    writeFileSync(join(location.rootPath, "main.ts"), "export function main() { return true; }");
    indexWithDatabase(database!, location);
    const beforeRevision = (database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision;
    const entries = Array.from({ length: 100_001 }, (_, index) => ({
      name: `entry-${String(index).padStart(6, "0")}.ts`,
    }));
    const openDirectory = () => {
      let cursor = 0;
      return {
        readSync: () => entries[cursor++] ?? null,
        closeSync: () => undefined,
      } as unknown as ReturnType<typeof opendirSync>;
    };
    const freshness = getIndexFreshness(location, (rootPath, excludes) =>
      discoverFiles(rootPath, excludes, {}, openDirectory));

    expect(freshness.status).toBe("incomplete");
    expect(freshness.checkedFiles).toBe(0);
    expect(freshness.deletedFiles).toBe(0);
    expect(freshness.fileChanges).toEqual([]);
    expect((database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision)
      .toBe(beforeRevision);
  }, 30_000);

  it("selects the same maxFiles subset regardless of directory insertion order", () => {
    createProject();
    for (const name of ["z.ts", "m.ts", "a.ts"]) {
      writeFileSync(join(location.rootPath, name), `export const ${name.replace(".ts", "")} = true;`);
    }
    const first = discoverFiles(location.rootPath, [], { maxFiles: 2 }).files.map((file) => file.relativePath);

    const secondRoot = join(temporaryDirectory, "second-repository");
    mkdirSync(secondRoot, { recursive: true });
    for (const name of ["a.ts", "z.ts", "m.ts"]) {
      writeFileSync(join(secondRoot, name), `export const ${name.replace(".ts", "")} = true;`);
    }
    const second = discoverFiles(secondRoot, [], { maxFiles: 2 }).files.map((file) => file.relativePath);

    expect(first).toEqual(["a.ts", "m.ts"]);
    expect(second).toEqual(first);
  });

  it("rejects traversal paths and invalid processing limits", () => {
    createProject();
    expect(() => indexWithDatabase(database!, location, false, [], { paths: ["../outside.ts"] }))
      .toThrow("project-relative");
    expect(() => indexWithDatabase(database!, location, false, [], { maxFiles: 10_001 }))
      .toThrow("maxFiles");
    expect(() => indexWithDatabase(database!, location, false, [], { maxProcessed: 0 }))
      .toThrow("maxProcessed");
    expect(() => indexWithDatabase(database!, location, false, [], { include: ["../outside/**/*.ts"] }))
      .toThrow("Include patterns");
    expect(() => indexWithDatabase(database!, location, false, Array.from({ length: 101 }, (_, i) => `ignored-${i}/`)))
      .toThrow("At most 100 custom exclusion patterns");
    expect(() => indexWithDatabase(database!, location, false, ["x".repeat(501)]))
      .toThrow("no longer than 500 characters");
    expect(() => indexWithDatabase(database!, location, false, [], { paths: Array.from({ length: 101 }, (_, i) => `src/${i}.ts`) }))
      .toThrow("At most 100 index scope paths");
  });
  it("keeps stable file and symbol identifiers across forced reindex and line shifts", () => {
    createProject();
    const filePath = join(location.rootPath, "src", "stable.ts");
    mkdirSync(join(location.rootPath, "src"), { recursive: true });
    writeFileSync(filePath, ["export function stable(value: string) { return value; }", ""].join("\n"));
    const initial = indexWithDatabase(database!, location);
    expect(initial.added).toBe(1);

    const beforeFile = database!.prepare("SELECT stable_id FROM files WHERE path = ?").get("src/stable.ts") as { stable_id: string };
    const beforeSymbol = database!.prepare("SELECT stable_id FROM symbols WHERE name = ?").get("stable") as { stable_id: string };

    writeFileSync(filePath, ["// a harmless line shift", "export function stable(value: string) { return value; }", ""].join("\n"));
    indexWithDatabase(database!, location, true);

    const afterFile = database!.prepare("SELECT stable_id FROM files WHERE path = ?").get("src/stable.ts") as { stable_id: string };
    const afterSymbol = database!.prepare("SELECT stable_id FROM symbols WHERE name = ?").get("stable") as { stable_id: string };
    expect(afterFile.stable_id).toBe(beforeFile.stable_id);
    expect(afterSymbol.stable_id).toBe(beforeSymbol.stable_id);
  });

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

  it("preserves indexed files when the root .gitignore is replaced by a symlink", () => {
    createProject();
    writeFileSync(join(location.rootPath, ".gitignore"), "");
    writeFileSync(join(location.rootPath, "a.ts"), "export const a = true;");
    writeFileSync(join(location.rootPath, "b.ts"), "export const b = true;");
    updateProjectIndex(location);

    const before = database!.prepare("SELECT path FROM files ORDER BY path").all() as Array<{ path: string }>;
    expect(before).toEqual([{ path: "a.ts" }, { path: "b.ts" }]);

    const savedIgnore = join(temporaryDirectory, "saved.gitignore");
    const outsideIgnore = join(temporaryDirectory, "outside.gitignore");
    renameSync(join(location.rootPath, ".gitignore"), savedIgnore);
    writeFileSync(outsideIgnore, "*.ts\n");
    symlinkSync(outsideIgnore, join(location.rootPath, ".gitignore"));

    expect(() => updateProjectIndex(location)).toThrow(/discovery could not safely complete/i);
    const after = database!.prepare("SELECT path FROM files ORDER BY path").all() as Array<{ path: string }>;
    expect(after).toEqual(before);
  });

  it("preserves indexed descendants when a nested .gitignore is replaced by a symlink", () => {
    createProject();
    mkdirSync(join(location.rootPath, "src", "nested"), { recursive: true });
    writeFileSync(join(location.rootPath, "src", ".gitignore"), "");
    writeFileSync(join(location.rootPath, "src", "nested", "keep.ts"), "export const keep = true;");
    writeFileSync(join(location.rootPath, "root.ts"), "export const root = true;");
    updateProjectIndex(location);

    const before = database!.prepare("SELECT path FROM files ORDER BY path").all() as Array<{ path: string }>;
    expect(before.map((row) => row.path)).toEqual(["root.ts", "src/nested/keep.ts"]);

    const savedIgnore = join(temporaryDirectory, "saved-nested.gitignore");
    const outsideIgnore = join(temporaryDirectory, "outside-nested.gitignore");
    renameSync(join(location.rootPath, "src", ".gitignore"), savedIgnore);
    writeFileSync(outsideIgnore, "*.ts\n");
    symlinkSync(outsideIgnore, join(location.rootPath, "src", ".gitignore"));
    writeFileSync(join(location.rootPath, "new-root.ts"), "export const added = true;");

    const summary = updateProjectIndex(location, { requireCompleteSnapshot: false });
    const after = database!.prepare("SELECT path FROM files ORDER BY path").all() as Array<{ path: string }>;

    expect(after.map((row) => row.path)).toContain("src/nested/keep.ts");
    expect(after.map((row) => row.path)).toContain("new-root.ts");
    expect(summary.failed).toBeGreaterThan(0);
    expect(summary.deleted).toBe(0);
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
    expect(summary.scanned).toBe(2);
    expect(summary.skipped).toBe(1);
    expect(summary.skippedFiles).toEqual(["linked.ts: symbolic link"]);
    expect(indexedPaths).toEqual(["normal.ts"]);
  });

  it("preserves indexed descendants when a directory is replaced by a symlink", () => {
    createProject();
    const sourceDirectory = join(location.rootPath, "src");
    const movedDirectory = join(temporaryDirectory, "saved-src");
    const outsideDirectory = join(temporaryDirectory, "outside-src");
    mkdirSync(sourceDirectory, { recursive: true });
    writeFileSync(join(sourceDirectory, "nested.ts"), "export const nested = true;");
    updateProjectIndex(location);

    const before = database!.prepare("SELECT path FROM files ORDER BY path").all() as Array<{ path: string }>;
    expect(before).toEqual([{ path: "src/nested.ts" }]);

    renameSync(sourceDirectory, movedDirectory);
    mkdirSync(outsideDirectory, { recursive: true });
    writeFileSync(join(outsideDirectory, "outside.ts"), "export const outside = true;");
    symlinkSync(outsideDirectory, sourceDirectory, "dir");

    expect(() => updateProjectIndex(location)).toThrow(/discovery is incomplete/i);
    expect(() => indexProject(location)).toThrow(/discovery is incomplete/i);
    const after = database!.prepare("SELECT path FROM files ORDER BY path").all() as Array<{ path: string }>;
    expect(after).toEqual([{ path: "src/nested.ts" }]);
  });

  it("fails closed when a directory is swapped during open and restored before identity recheck", () => {
    createProject();
    const sourceDirectory = join(location.rootPath, "src");
    const movedDirectory = join(temporaryDirectory, "saved-src");
    const outsideDirectory = join(temporaryDirectory, "outside-src");
    mkdirSync(sourceDirectory, { recursive: true });
    writeFileSync(join(sourceDirectory, "inside.ts"), "export const inside = true;");
    mkdirSync(outsideDirectory, { recursive: true });
    writeFileSync(join(outsideDirectory, "outside.ts"), "export const outside = true;");
    indexProject(location);

    const beforeRevision = (database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision;
    const beforeFiles = database!.prepare("SELECT path, content_hash FROM files ORDER BY path").all();
    let replaced = false;
    const freshness = getIndexFreshness(location, (rootPath, excludes) =>
      discoverFiles(rootPath, excludes, {}, (directory) => {
        if (!replaced && directory === sourceDirectory) {
          replaced = true;
          renameSync(sourceDirectory, movedDirectory);
          symlinkSync(outsideDirectory, sourceDirectory, "dir");
          const handle = opendirSync(directory);
          rmSync(sourceDirectory);
          renameSync(movedDirectory, sourceDirectory);
          return handle;
        }
        return opendirSync(directory);
      }));

    expect(replaced).toBe(true);
    expect(freshness.status).toBe("incomplete");
    expect(freshness.deletedFiles).toBe(0);
    expect(freshness.fileChanges).toEqual([]);
    expect(database!.prepare("SELECT path, content_hash FROM files ORDER BY path").all()).toEqual(beforeFiles);
    expect((database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision)
      .toBe(beforeRevision);
  });

  it("fails closed when a directory is replaced between classification and open", () => {
    createProject();
    const sourceDirectory = join(location.rootPath, "src");
    const movedDirectory = join(temporaryDirectory, "saved-src");
    const outsideDirectory = join(temporaryDirectory, "outside-src");
    mkdirSync(sourceDirectory, { recursive: true });
    writeFileSync(join(sourceDirectory, "inside.ts"), "export const inside = true;");
    mkdirSync(outsideDirectory, { recursive: true });
    writeFileSync(join(outsideDirectory, "outside.ts"), "export const outside = true;");

    let replaced = false;
    const discovery = discoverFiles(location.rootPath, [], {}, (directory) => {
      if (!replaced && directory === sourceDirectory) {
        replaced = true;
        renameSync(sourceDirectory, movedDirectory);
        symlinkSync(outsideDirectory, sourceDirectory, "dir");
      }
      return opendirSync(directory);
    });
    expect(replaced).toBe(true);
    expect(discovery.failed).toBeGreaterThan(0);
    expect(discovery.protectedDirectories.has("src")).toBe(true);
    expect(discovery.files).toEqual([]);
  });

  it("preserves the complete indexed record when a source file is replaced by a symlink", () => {
    createProject();
    const sourcePath = join(location.rootPath, "source.ts");
    const consumerPath = join(location.rootPath, "consumer.ts");
    const outsidePath = join(temporaryDirectory, "outside.ts");
    writeFileSync(sourcePath, "export function retained() { return true; }");
    writeFileSync(consumerPath, 'import { retained } from "./source";\nexport function consume() { return retained(); }');
    indexProject(location);

    const beforeRevision = (database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision;
    const beforeFiles = database!.prepare("SELECT path, content_hash FROM files ORDER BY path").all();
    const beforeSymbols = database!.prepare("SELECT f.path, s.name, s.signature FROM symbols s JOIN files f ON f.id = s.file_id ORDER BY f.path, s.name").all();
    const beforeFts = database!.prepare("SELECT file_path, name, signature FROM symbols_fts ORDER BY file_path, name").all();
    const beforeRelations = database!.prepare("SELECT source_kind, source_id, target_kind, target_id, kind, confidence, provenance FROM relations ORDER BY kind, source_id, target_id").all();
    expect(beforeSymbols.length).toBeGreaterThan(0);
    expect(beforeFts.length).toBeGreaterThan(0);
    expect(beforeRelations.length).toBeGreaterThan(0);

    rmSync(sourcePath);
    writeFileSync(outsidePath, "export function outside() { return false; }");
    symlinkSync(outsidePath, sourcePath, "file");

    const freshness = getIndexFreshness(location);
    expect(freshness.status).toBe("incomplete");
    expect(freshness.deletedFiles).toBe(0);
    expect(freshness.skippedFiles).toContain("source.ts: symbolic link");
    expect(() => updateProjectIndex(location)).toThrow(/source discovery is incomplete/i);

    expect(database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id))
      .toEqual({ index_revision: beforeRevision });
    expect(database!.prepare("SELECT path, content_hash FROM files ORDER BY path").all()).toEqual(beforeFiles);
    expect(database!.prepare("SELECT f.path, s.name, s.signature FROM symbols s JOIN files f ON f.id = s.file_id ORDER BY f.path, s.name").all()).toEqual(beforeSymbols);
    expect(database!.prepare("SELECT file_path, name, signature FROM symbols_fts ORDER BY file_path, name").all()).toEqual(beforeFts);
    expect(database!.prepare("SELECT source_kind, source_id, target_kind, target_id, kind, confidence, provenance FROM relations ORDER BY kind, source_id, target_id").all()).toEqual(beforeRelations);
  });

  it("removes stale symbols, FTS entries, and graph relations when a file is deleted", () => {
    createProject();
    const gonePath = join(location.rootPath, "gone.ts");
    const mainPath = join(location.rootPath, "main.ts");
    writeFileSync(gonePath, "export function gone() { return true; }");
    writeFileSync(mainPath, 'import { gone } from "./gone";\nexport function run() { gone(); }');
    indexWithDatabase(database!, location);

    expect(database!.prepare("SELECT COUNT(*) AS count FROM relations WHERE kind = 'IMPORTS'").get()).toEqual({ count: 1 });
    expect(database!.prepare("SELECT COUNT(*) AS count FROM symbols_fts WHERE name = 'gone'").get()).toEqual({ count: 1 });

    rmSync(gonePath);
    const summary = indexWithDatabase(database!, location);

    expect(summary.deleted).toBe(1);
    expect(database!.prepare("SELECT path FROM files ORDER BY path").all()).toEqual([{ path: "main.ts" }]);
    expect(database!.prepare("SELECT name FROM symbols ORDER BY name").all()).toEqual([{ name: "run" }]);
    expect(database!.prepare("SELECT COUNT(*) AS count FROM symbols_fts WHERE name = 'gone'").get()).toEqual({ count: 0 });
    expect(database!.prepare("SELECT COUNT(*) AS count FROM relations").get()).toEqual({ count: 0 });
  });

  it("produces the same logical index after a forced reindex", () => {
    createProject();
    mkdirSync(join(location.rootPath, "src"), { recursive: true });
    writeFileSync(join(location.rootPath, "src", "main.ts"), 'import { helper } from "./helper";\nexport function run() { return true; }');
    writeFileSync(join(location.rootPath, "src", "helper.ts"), "export function helper() { return true; }");

    indexWithDatabase(database!, location);
    const snapshot = () => ({
      files: database!.prepare("SELECT path, content_hash FROM files ORDER BY path").all(),
      symbols: database!.prepare("SELECT file_id, name, kind, signature, start_line, end_line, exported FROM symbols ORDER BY file_id, name").all(),
      imports: database!.prepare("SELECT file_id, module_specifier FROM file_imports ORDER BY file_id, module_specifier").all(),
      calls: database!.prepare("SELECT file_id, caller_name, callee_name FROM symbol_calls ORDER BY file_id, caller_name, callee_name").all(),
      relations: database!.prepare("SELECT source_kind, source_id, target_kind, target_id, kind, confidence, provenance FROM relations ORDER BY kind, source_kind, source_id, target_kind, target_id").all(),
      fts: database!.prepare("SELECT name, signature, file_path, kind FROM symbols_fts ORDER BY file_path, name").all(),
    });
    const before = snapshot();

    const forced = indexWithDatabase(database!, location, true);

    expect(forced.updated).toBe(2);
    expect(snapshot()).toEqual(before);
  });

  it("skips unchanged content and updates changed symbols incrementally", () => {
    createProject();
    const filePath = join(location.rootPath, "service.ts");
    writeFileSync(filePath, 'import { helper } from "./helper";\nexport function firstVersion() { return helper(); }');
    writeFileSync(join(location.rootPath, "helper.ts"), "export function helper() { return 1; }");

    const initial = indexWithDatabase(database!, location);
    const initialRelations = database!.prepare("SELECT COUNT(*) AS count FROM relations").get() as { count: number };
    expect(initialRelations.count).toBeGreaterThan(0);
    const unchanged = indexWithDatabase(database!, location);
    const graphAfterUnchanged = database!.prepare("SELECT index_revision FROM relations").all();
    writeFileSync(filePath, 'import { helper } from "./helper";\nexport function secondVersion() { return helper(); }');
    const updated = indexWithDatabase(database!, location);

    expect(initial.added).toBe(2);
    expect(unchanged.unchanged).toBe(2);
    expect(unchanged.updated).toBe(0);
    expect(graphAfterUnchanged.every((row) => (row as { index_revision: number }).index_revision === 2)).toBe(true);
    expect(updated.updated).toBe(1);
    expect(database!.prepare("SELECT name FROM symbols WHERE file_id = (SELECT id FROM files WHERE path = 'service.ts')").all())
      .toEqual([{ name: "secondVersion" }]);
  });

  it("refuses to consume a TypeScript config through a final symlink", () => {
    createProject();
    mkdirSync(join(location.rootPath, "src"), { recursive: true });
    writeFileSync(join(location.rootPath, "src", "main.ts"),
      'import { helper } from "@/helper";\nexport function run() { return helper(); }');
    writeFileSync(join(location.rootPath, "src", "helper.ts"), "export function helper() { return true; }");
    writeFileSync(join(location.rootPath, "tsconfig.json"), JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
    }));
    indexProject(location);
    const beforeRevision = (database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision;
    expect(database!.prepare("SELECT COUNT(*) AS count FROM relations WHERE kind = 'IMPORTS'").get())
      .toEqual({ count: 1 });

    const outsideConfig = join(temporaryDirectory, "outside-tsconfig.json");
    writeFileSync(outsideConfig, JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["repository/src/*"] } },
    }));
    rmSync(join(location.rootPath, "tsconfig.json"));
    symlinkSync(outsideConfig, join(location.rootPath, "tsconfig.json"));

    const freshness = getIndexFreshness(location);
    expect(freshness.status).toBe("incomplete");
    expect(freshness.errors.some((error) => error.includes("tsconfig.json"))).toBe(true);
    expect(() => updateProjectIndex(location, { paths: ["src/main.ts"] })).toThrow(/relation configuration is incomplete/i);
    expect((database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision)
      .toBe(beforeRevision);
    expect(database!.prepare("SELECT COUNT(*) AS count FROM relations WHERE kind = 'IMPORTS'").get())
      .toEqual({ count: 1 });
  });

  it("marks malformed package metadata for an extended config as incomplete", () => {
    createProject();
    const packageDirectory = join(location.rootPath, "node_modules", "shared-config");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(location.rootPath, "tsconfig.json"), JSON.stringify({ extends: "shared-config" }));
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ tsconfig: "tsconfig.json" }));
    writeFileSync(join(packageDirectory, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    writeFileSync(join(location.rootPath, "main.ts"), "export const value = true;");
    indexProject(location);

    writeFileSync(join(packageDirectory, "package.json"), '{"tsconfig": ');
    const freshness = getIndexFreshness(location);
    expect(freshness.status).toBe("incomplete");
    expect(freshness.errors.some((error) => error.includes("node_modules/shared-config/package.json"))).toBe(true);
    expect(() => updateProjectIndex(location, { paths: ["main.ts"] })).toThrow(/relation configuration is incomplete/i);
  });

  it("marks non-string package tsconfig metadata for an extended config as incomplete", () => {
    createProject();
    const packageDirectory = join(location.rootPath, "node_modules", "shared-config");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(location.rootPath, "tsconfig.json"), JSON.stringify({ extends: "shared-config" }));
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ tsconfig: "tsconfig.json" }));
    writeFileSync(join(packageDirectory, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    writeFileSync(join(location.rootPath, "main.ts"), "export const value = true;");
    indexProject(location);

    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ tsconfig: 42 }));
    const freshness = getIndexFreshness(location);
    expect(freshness.status).toBe("incomplete");
    expect(freshness.errors.some((error) => error.includes("node_modules/shared-config/package.json"))).toBe(true);
    expect(() => updateProjectIndex(location, { paths: ["main.ts"] })).toThrow(/relation configuration is incomplete/i);
  });

  it("does not consume an extended TypeScript config through a final symlink", () => {
    createProject();
    mkdirSync(join(location.rootPath, "src"), { recursive: true });
    writeFileSync(join(location.rootPath, "src", "main.ts"),
      'import { helper } from "@/helper";\nexport function run() { return helper(); }');
    writeFileSync(join(location.rootPath, "src", "helper.ts"), "export function helper() { return true; }");
    writeFileSync(join(location.rootPath, "tsconfig.json"), JSON.stringify({ extends: "./tsconfig.base.json" }));
    writeFileSync(join(location.rootPath, "tsconfig.base.json"), JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: {} },
    }));
    indexProject(location);
    expect(database!.prepare("SELECT COUNT(*) AS count FROM relations WHERE kind = 'IMPORTS'").get())
      .toEqual({ count: 0 });
    const beforeRevision = (database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision;

    const outsideConfig = join(temporaryDirectory, "outside-tsconfig.json");
    writeFileSync(outsideConfig, JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["repository/src/*"] } },
    }));
    rmSync(join(location.rootPath, "tsconfig.base.json"));
    symlinkSync(outsideConfig, join(location.rootPath, "tsconfig.base.json"));

    const freshness = getIndexFreshness(location);
    expect(freshness.status).toBe("incomplete");
    expect(freshness.errors.some((error) => error.includes("tsconfig.base.json"))).toBe(true);
    expect(() => updateProjectIndex(location, { paths: ["src/main.ts"] })).toThrow(/relation configuration is incomplete/i);
    expect((database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision)
      .toBe(beforeRevision);
  });

  it("marks malformed TypeScript relation configuration as incomplete", () => {
    createProject();
    writeFileSync(join(location.rootPath, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
    writeFileSync(join(location.rootPath, "main.ts"), "export const value = true;");
    indexProject(location);

    writeFileSync(join(location.rootPath, "tsconfig.json"), '{"compilerOptions": {');
    const freshness = getIndexFreshness(location);
    expect(freshness.status).toBe("incomplete");
    expect(freshness.errors.some((error) => error.includes("tsconfig.json") && error.includes("invalid TypeScript configuration"))).toBe(true);
    expect(() => updateProjectIndex(location, { paths: ["main.ts"] })).toThrow(/relation configuration is incomplete/i);
  });

  it("marks missing extended TypeScript configuration as incomplete", () => {
    createProject();
    writeFileSync(join(location.rootPath, "tsconfig.json"), JSON.stringify({ extends: "./tsconfig.missing.json" }));
    writeFileSync(join(location.rootPath, "tsconfig.missing.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    writeFileSync(join(location.rootPath, "main.ts"), "export const value = true;");
    indexProject(location);

    rmSync(join(location.rootPath, "tsconfig.missing.json"));
    const freshness = getIndexFreshness(location);
    expect(freshness.status).toBe("incomplete");
    expect(freshness.errors.some((error) => error.includes("tsconfig.missing.json") && error.includes("ENOENT"))).toBe(true);
    expect(() => updateProjectIndex(location, { paths: ["main.ts"] })).toThrow(/relation configuration is incomplete/i);
  });

  it("rolls back a scoped update when relation configuration changes after preflight", () => {
    createProject();
    mkdirSync(join(location.rootPath, "src"), { recursive: true });
    writeFileSync(join(location.rootPath, "src", "main.ts"),
      'import { helper } from "@/helper";\nexport function run() { return helper(); }');
    writeFileSync(join(location.rootPath, "src", "helper.ts"), "export function helper() { return true; }");
    const configPath = join(location.rootPath, "tsconfig.json");
    writeFileSync(configPath, JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
    }));
    indexProject(location);
    const beforeRevision = (database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision;
    const beforeHash = (database!.prepare("SELECT content_hash FROM files WHERE path = 'src/main.ts'").get() as { content_hash: string }).content_hash;
    const beforeRelations = database!.prepare("SELECT kind, source_id, target_id FROM relations ORDER BY kind, source_id, target_id").all();

    writeFileSync(join(location.rootPath, "src", "main.ts"),
      'import { helper } from "@/helper";\nexport function run() { return helper() ? false : true; }');
    expect(() => indexWithDatabase(database!, location, false, [], { paths: ["src/main.ts"] }, () => {
      writeFileSync(configPath, JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["generated/*"] } },
      }));
    })).toThrow(/relation configuration changed during indexing/i);

    expect((database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision)
      .toBe(beforeRevision);
    expect((database!.prepare("SELECT content_hash FROM files WHERE path = 'src/main.ts'").get() as { content_hash: string }).content_hash)
      .toBe(beforeHash);
    expect(database!.prepare("SELECT kind, source_id, target_id FROM relations ORDER BY kind, source_id, target_id").all())
      .toEqual(beforeRelations);
    expect(getIndexFreshness(location).status).toBe("stale");
  });

  it("marks malformed package manifests used by relation resolution as incomplete", () => {
    createProject();
    writeFileSync(join(location.rootPath, "package.json"), JSON.stringify({ name: "fixture" }));
    writeFileSync(join(location.rootPath, "main.ts"), "export const value = true;");
    indexProject(location);

    writeFileSync(join(location.rootPath, "package.json"), '{"name": ');
    const freshness = getIndexFreshness(location);
    expect(freshness.status).toBe("incomplete");
    expect(freshness.errors.some((error) => error.includes("package.json") && error.includes("invalid or unreadable"))).toBe(true);
    expect(() => updateProjectIndex(location, { paths: ["main.ts"] })).toThrow(/relation configuration is incomplete/i);
  });

  it("rebuilds graph relations when TypeScript/package configuration changes without source edits", () => {
    createProject();
    mkdirSync(join(location.rootPath, "src"), { recursive: true });
    writeFileSync(join(location.rootPath, "src", "main.ts"),
      'import { helper } from "@/helper";\nexport function run() { return helper(); }');
    writeFileSync(join(location.rootPath, "src", "helper.ts"), "export function helper() { return true; }");
    writeFileSync(join(location.rootPath, "tsconfig.json"), JSON.stringify({ extends: "./tsconfig.base.json" }));
    writeFileSync(join(location.rootPath, "tsconfig.base.json"), JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: {} },
    }));

    indexWithDatabase(database!, location);
    expect(database!.prepare("SELECT COUNT(*) AS count FROM relations WHERE kind = 'IMPORTS'").get())
      .toEqual({ count: 0 });
    const before = database!.prepare("SELECT relations_config_hash FROM projects WHERE id = ?")
      .get(location.id) as { relations_config_hash: string };

    writeFileSync(join(location.rootPath, "tsconfig.base.json"), JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
    }));
    const stale = getIndexFreshness(location);
    expect(stale.status).toBe("stale");
    expect(stale.relationsConfigChanged).toBe(true);

    const refreshed = indexWithDatabase(database!, location);
    const after = database!.prepare("SELECT relations_config_hash FROM projects WHERE id = ?")
      .get(location.id) as { relations_config_hash: string };

    expect(refreshed.unchanged).toBe(2);
    expect(after.relations_config_hash).not.toBe(before.relations_config_hash);
    expect(getIndexFreshness(location).relationsConfigChanged).toBe(false);
    expect(database!.prepare("SELECT COUNT(*) AS count FROM relations WHERE kind = 'IMPORTS'").get())
      .toEqual({ count: 1 });
  });

  it("records missing and ambiguous relative imports without guessing a target", () => {
    createProject();
    mkdirSync(join(location.rootPath, "src"), { recursive: true });
    writeFileSync(join(location.rootPath, "src", "main.ts"), 'import "./missing";\nimport "./shared";');
    writeFileSync(join(location.rootPath, "src", "shared.ts"), "export const shared = true;");
    writeFileSync(join(location.rootPath, "src", "shared.tsx"), "export const sharedView = true;");

    indexWithDatabase(database!, location);

    expect(database!.prepare("SELECT kind FROM relations WHERE kind = 'IMPORTS'").all()).toEqual([]);
    expect(database!.prepare("SELECT module_specifier, status, candidates_json FROM unresolved_imports ORDER BY module_specifier").all())
      .toEqual([
        { module_specifier: "./missing", status: "unresolved", candidates_json: "[]" },
        { module_specifier: "./shared", status: "ambiguous", candidates_json: JSON.stringify(["src/shared.ts", "src/shared.tsx"]) },
      ]);
  });

  it("removes unresolved import diagnostics when their source file is deleted", () => {
    createProject();
    const sourcePath = join(location.rootPath, "source.ts");
    writeFileSync(sourcePath, 'import "./missing";');
    indexWithDatabase(database!, location);
    expect(database!.prepare("SELECT COUNT(*) AS count FROM unresolved_imports").get()).toEqual({ count: 1 });

    rmSync(sourcePath);
    indexWithDatabase(database!, location);

    expect(database!.prepare("SELECT COUNT(*) AS count FROM unresolved_imports").get()).toEqual({ count: 0 });
  });

  it("resolves explicit tsconfig paths aliases to indexed files", () => {
    createProject();
    mkdirSync(join(location.rootPath, "src"), { recursive: true });
    writeFileSync(join(location.rootPath, "tsconfig.json"), JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
    }));
    writeFileSync(join(location.rootPath, "src", "main.ts"), 'import { helper } from "@/helper";');
    writeFileSync(join(location.rootPath, "src", "helper.ts"), "export const helper = true;");
    writeFileSync(join(location.rootPath, "src", "external.ts"), 'import "some-package";');

    indexWithDatabase(database!, location);

    expect(database!.prepare("SELECT source.path AS source, target.path AS target FROM relations r JOIN files source ON r.source_kind = 'file' AND source.id = r.source_id JOIN files target ON r.target_kind = 'file' AND target.id = r.target_id WHERE r.kind = 'IMPORTS'").all())
      .toEqual([{ source: "src/main.ts", target: "src/helper.ts" }]);
    expect(database!.prepare("SELECT module_specifier FROM unresolved_imports").all()).toEqual([]);
  });

  it("marks tsconfig aliases with multiple indexed targets as ambiguous", () => {
    createProject();
    mkdirSync(join(location.rootPath, "src"), { recursive: true });
    mkdirSync(join(location.rootPath, "legacy"), { recursive: true });
    writeFileSync(join(location.rootPath, "tsconfig.json"), JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*", "legacy/*"] } },
    }));
    writeFileSync(join(location.rootPath, "main.ts"), 'import "@/shared";');
    writeFileSync(join(location.rootPath, "src", "shared.ts"), "export const current = true;");
    writeFileSync(join(location.rootPath, "legacy", "shared.ts"), "export const legacy = true;");

    indexWithDatabase(database!, location);

    expect(database!.prepare("SELECT kind FROM relations WHERE kind = 'IMPORTS'").all()).toEqual([]);
    expect(database!.prepare("SELECT module_specifier, status, candidates_json FROM unresolved_imports").all())
      .toEqual([{
        module_specifier: "@/shared",
        status: "ambiguous",
        candidates_json: JSON.stringify(["legacy/shared.ts", "src/shared.ts"]),
      }]);
  });

  it("resolves local package root and subpath exports, preferring the types condition", () => {
    createProject();
    const packageRoot = join(location.rootPath, "packages", "utils");
    mkdirSync(join(packageRoot, "src", "features"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
      name: "@local/utils",
      exports: {
        ".": { types: "./src/index.d.ts", import: "./src/index.ts" },
        "./format": "./src/format.ts",
        "./features/*": "./src/features/*.ts",
      },
    }));
    writeFileSync(join(location.rootPath, "main.ts"), 'import "@local/utils";\nimport "@local/utils/format";\nimport "@local/utils/features/one";');
    writeFileSync(join(packageRoot, "src", "index.d.ts"), "export declare const utility: string;");
    writeFileSync(join(packageRoot, "src", "index.ts"), "export const utility = 'runtime';");
    writeFileSync(join(packageRoot, "src", "format.ts"), "export function format() {}");
    writeFileSync(join(packageRoot, "src", "features", "one.ts"), "export const feature = true;");

    indexWithDatabase(database!, location);

    expect(database!.prepare("SELECT source.path AS source, target.path AS target FROM relations r JOIN files source ON r.source_kind = 'file' AND source.id = r.source_id JOIN files target ON r.target_kind = 'file' AND target.id = r.target_id WHERE r.kind = 'IMPORTS' ORDER BY target.path").all())
      .toEqual([
        { source: "main.ts", target: "packages/utils/src/features/one.ts" },
        { source: "main.ts", target: "packages/utils/src/format.ts" },
        { source: "main.ts", target: "packages/utils/src/index.d.ts" },
      ]);
    expect(database!.prepare("SELECT module_specifier FROM unresolved_imports").all()).toEqual([]);
  });

  it("reports missing, ambiguous, and unsafe local package export targets without guessing", () => {
    createProject();
    const packageRoot = join(location.rootPath, "packages", "utils");
    mkdirSync(join(packageRoot, "src"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
      name: "local-utils",
      exports: {
        ".": "./src/missing.ts",
        "./shared": "./src/shared",
        "./outside": "../outside.ts",
      },
    }));
    writeFileSync(join(location.rootPath, "main.ts"),
      'import "local-utils";\nimport "local-utils/shared";\nimport "local-utils/outside";\nimport "external-package";');
    writeFileSync(join(packageRoot, "src", "shared.ts"), "export const current = true;");
    writeFileSync(join(packageRoot, "src", "shared.tsx"), "export const legacy = true;");

    indexWithDatabase(database!, location);

    expect(database!.prepare("SELECT kind FROM relations WHERE kind = 'IMPORTS'").all()).toEqual([]);
    expect(database!.prepare("SELECT module_specifier, status, candidates_json FROM unresolved_imports ORDER BY module_specifier").all())
      .toEqual([
        { module_specifier: "local-utils", status: "unresolved", candidates_json: "[]" },
        { module_specifier: "local-utils/outside", status: "unresolved", candidates_json: "[]" },
        {
          module_specifier: "local-utils/shared",
          status: "ambiguous",
          candidates_json: JSON.stringify(["packages/utils/src/shared.ts", "packages/utils/src/shared.tsx"]),
        },
      ]);
  });

  it("detects missing external packages and invalid named exports without flagging built-ins", () => {
    createProject();
    const packageRoot = join(location.rootPath, "node_modules", "installed-package");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
      name: "installed-package",
      types: "index.d.ts",
    }));
    writeFileSync(join(packageRoot, "index.d.ts"), "export declare const known: string;");
    writeFileSync(join(location.rootPath, "main.ts"), [
      'import { known } from "installed-package";',
      'import { absent } from "installed-package";',
      'import { missing } from "not-installed-package";',
      'import { readFile } from "node:fs";',
      "void known; void absent; void missing; void readFile;",
    ].join("\n"));

    indexWithDatabase(database!, location);

    const diagnostics = database!.prepare(`
      SELECT module_specifier, diagnostic_code, kind, imported_name, line
      FROM import_diagnostics ORDER BY line, diagnostic_code
    `).all();
    expect(diagnostics).toEqual([
      {
        module_specifier: "installed-package",
        diagnostic_code: 2305,
        kind: "missing-export",
        imported_name: "absent",
        line: 2,
      },
      {
        module_specifier: "not-installed-package",
        diagnostic_code: 2307,
        kind: "missing-package",
        imported_name: null,
        line: 3,
      },
    ]);

    const report = getProjectMapReport(location, 10);
    expect(report.files[0]?.importDiagnostics).toEqual([
      expect.objectContaining({ specifier: "installed-package", kind: "missing-export", importedName: "absent", line: 2 }),
      expect.objectContaining({ specifier: "not-installed-package", kind: "missing-package", line: 3 }),
    ]);
  });

  it("does not report invalid bindings from baseUrl-resolved local modules as external exports", () => {
    createProject();
    mkdirSync(join(location.rootPath, "src"), { recursive: true });
    writeFileSync(join(location.rootPath, "tsconfig.json"), JSON.stringify({
      compilerOptions: { baseUrl: ".", module: "NodeNext", moduleResolution: "NodeNext" },
    }));
    writeFileSync(join(location.rootPath, "src", "local.ts"), "export const present = true;");
    writeFileSync(join(location.rootPath, "main.ts"), [
      'import { absent } from "src/local";',
      "void absent;",
    ].join("\n"));

    indexWithDatabase(database!, location);

    expect(database!.prepare("SELECT COUNT(*) AS count FROM import_diagnostics").get()).toEqual({ count: 0 });
  });

  it("does not misclassify local workspace packages without exports maps", () => {
    createProject();
    const packageRoot = join(location.rootPath, "packages", "shared-local");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "shared-local", main: "index.ts" }));
    writeFileSync(join(packageRoot, "index.ts"), "export const shared = true;");
    writeFileSync(join(location.rootPath, "main.ts"), [
      'import { shared } from "shared-local";',
      "void shared;",
    ].join("\n"));

    indexWithDatabase(database!, location);

    expect(database!.prepare("SELECT COUNT(*) AS count FROM unresolved_imports").get()).toEqual({ count: 0 });
    expect(database!.prepare("SELECT COUNT(*) AS count FROM import_diagnostics").get()).toEqual({ count: 0 });
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


  it("resolves calls through imported named exports, including aliased bindings", () => {
    createProject();
    writeFileSync(join(location.rootPath, "main.ts"),
      'import { helper as runHelper } from "./helper";\nexport function caller() { runHelper(); }');
    writeFileSync(join(location.rootPath, "helper.ts"),
      "export function helper() { return true; }");

    indexWithDatabase(database!, location);

    expect(database!.prepare(`
      SELECT source.name AS caller, target.name AS callee, r.provenance
      FROM relations r
      JOIN symbols source ON r.source_kind = 'symbol' AND source.id = r.source_id
      JOIN symbols target ON r.target_kind = 'symbol' AND target.id = r.target_id
      WHERE r.kind = 'CALLS'
    `).all()).toEqual([{
      caller: "caller",
      callee: "helper",
      provenance: "typescript-ast-import-binding",
    }]);
  });

  it("resolves each imported binding against its own module when names overlap", () => {
    createProject();
    writeFileSync(join(location.rootPath, "main.ts"),
      'import { shared as callFirst } from "./first";\nimport { shared as callSecond } from "./second";\nexport function caller() { callFirst(); callSecond(); }');
    writeFileSync(join(location.rootPath, "first.ts"), "export function shared() { return 1; }");
    writeFileSync(join(location.rootPath, "second.ts"), "export function shared() { return 2; }");

    indexWithDatabase(database!, location);

    expect(database!.prepare(`
      SELECT targetFile.path AS target
      FROM relations r
      JOIN symbols source ON r.source_kind = 'symbol' AND source.id = r.source_id
      JOIN symbols target ON r.target_kind = 'symbol' AND target.id = r.target_id
      JOIN files targetFile ON targetFile.id = target.file_id
      WHERE r.kind = 'CALLS' AND source.name = 'caller'
      ORDER BY targetFile.path
    `).all()).toEqual([{ target: "first.ts" }, { target: "second.ts" }]);
  });

  it("does not resolve imported calls when a local parameter shadows the import", () => {
    createProject();
    writeFileSync(join(location.rootPath, "main.ts"),
      'import { helper as runHelper } from "./helper";\nexport function caller(runHelper: () => void) { runHelper(); }');
    writeFileSync(join(location.rootPath, "helper.ts"),
      "export function helper() { return true; }");

    indexWithDatabase(database!, location);

    expect(database!.prepare("SELECT kind FROM relations WHERE kind = 'CALLS'").all()).toEqual([]);
  });

  it("does not create cross-file calls to non-exported symbols", () => {
    createProject();
    writeFileSync(join(location.rootPath, "main.ts"),
      'import { helper } from "./helper";\nexport function caller() { helper(); }');
    writeFileSync(join(location.rootPath, "helper.ts"),
      "function helper() { return true; }");

    indexWithDatabase(database!, location);

    expect(database!.prepare("SELECT kind FROM relations WHERE kind = 'CALLS'").all()).toEqual([]);
  });

  it("resolves same-file and imported class heritage relationships", () => {
    createProject();
    writeFileSync(join(location.rootPath, "contracts.ts"), "export interface Contract {}");
    writeFileSync(join(location.rootPath, "base.ts"), "export class Base {}");
    writeFileSync(join(location.rootPath, "worker.ts"),
      'import { Base as Parent } from "./base";\nimport { Contract } from "./contracts";\nclass LocalBase {}\nexport class Worker extends Parent implements Contract {}\nexport class LocalWorker extends LocalBase {}');

    indexWithDatabase(database!, location);

    expect(database!.prepare("SELECT owner_name, relation_kind, target_name, module_specifier, imported_name FROM symbol_heritage ORDER BY owner_name, relation_kind").all()).toEqual([
      { owner_name: "LocalWorker", relation_kind: "EXTENDS", target_name: "LocalBase", module_specifier: null, imported_name: null },
      { owner_name: "Worker", relation_kind: "EXTENDS", target_name: "Parent", module_specifier: "./base", imported_name: "Base" },
      { owner_name: "Worker", relation_kind: "IMPLEMENTS", target_name: "Contract", module_specifier: "./contracts", imported_name: "Contract" },
    ]);

    expect(database!.prepare(`
      SELECT source.name AS source, target.name AS target, r.kind, r.provenance
      FROM relations r
      JOIN symbols source ON r.source_kind = 'symbol' AND source.id = r.source_id
      JOIN symbols target ON r.target_kind = 'symbol' AND target.id = r.target_id
      WHERE r.kind IN ('EXTENDS', 'IMPLEMENTS')
      ORDER BY r.kind, source.name
    `).all()).toEqual([
      { source: "LocalWorker", target: "LocalBase", kind: "EXTENDS", provenance: "typescript-ast-heritage" },
      { source: "Worker", target: "Base", kind: "EXTENDS", provenance: "typescript-ast-heritage" },
      { source: "Worker", target: "Contract", kind: "IMPLEMENTS", provenance: "typescript-ast-heritage" },
    ]);
  });

  it("does not guess heritage targets for ambiguous or non-exported imported symbols", () => {
    createProject();
    writeFileSync(join(location.rootPath, "worker.ts"),
      'import { Base } from "./base";\nexport class Worker extends Base {}');
    writeFileSync(join(location.rootPath, "base.ts"), "class Base {}");
    writeFileSync(join(location.rootPath, "base.tsx"), "export class Base {}");

    indexWithDatabase(database!, location);

    expect(database!.prepare("SELECT kind FROM relations WHERE kind IN ('EXTENDS', 'IMPLEMENTS')").all()).toEqual([]);
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
    expect(relationCount).toBe(2);
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


  it("keeps summary counters consistent with discovered files and persisted index rows", () => {
    createProject();
    writeFileSync(join(location.rootPath, "valid.ts"), "export function valid() { return true; }");
    writeFileSync(join(location.rootPath, "binary.ts"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(location.rootPath, "broken.ts"), "export function broken( {");
    writeFileSync(join(location.rootPath, "large.ts"), "export const large = true;\n// " + "x".repeat(1_000_001));

    const summary = indexWithDatabase(database!, location);
    const persistedSymbols = (database!.prepare("SELECT COUNT(*) AS count FROM symbols").get() as { count: number }).count;
    const persistedRelations = (database!.prepare("SELECT COUNT(*) AS count FROM relations").get() as { count: number }).count;
    const persistedFiles = (database!.prepare("SELECT COUNT(*) AS count FROM files").get() as { count: number }).count;

    expect(summary.scanned).toBe(4);
    expect(summary.added + summary.updated + summary.unchanged).toBe(persistedFiles);
    expect(summary.skipped).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.symbols).toBe(persistedSymbols);
    expect(summary.relations).toBe(persistedRelations);
    expect(summary.errors.join(" ")).toMatch(/broken\.ts/);
    expect(summary.skippedFiles).toHaveLength(2);
    expect(summary.skippedFiles).toEqual(expect.arrayContaining([
      "binary.ts: binary content",
      "large.ts: exceeds 1000000 bytes",
    ]));
  });

  it("reports discovery diagnostics in deterministic path order", () => {
    createProject();
    writeFileSync(join(location.rootPath, "z-broken.ts"), "export function broken( {");
    writeFileSync(join(location.rootPath, "a-broken.ts"), "export function broken( {");
    writeFileSync(join(location.rootPath, "z-binary.ts"), Buffer.from([0, 1, 2]));
    writeFileSync(join(location.rootPath, "a-binary.ts"), Buffer.from([0, 1, 2]));

    const summary = indexWithDatabase(database!, location);

    expect(summary.errors.map((error) => error.split(":")[0])).toEqual([
      "a-broken.ts",
      "z-broken.ts",
    ]);
    expect(summary.skippedFiles).toEqual([
      "a-binary.ts: binary content",
      "z-binary.ts: binary content",
    ]);
  });


  it("rebuilds typed directed graph relations idempotently and removes stale edges after source changes", () => {
    createProject();
    writeFileSync(join(location.rootPath, "base.ts"), "export class Base {}");
    writeFileSync(join(location.rootPath, "contract.ts"), "export interface Contract {}");
    writeFileSync(join(location.rootPath, "helper.ts"), "export function helper() { return true; }");
    const workerPath = join(location.rootPath, "worker.ts");
    writeFileSync(workerPath, [
      'import { Base } from "./base";',
      'import { Contract } from "./contract";',
      'import { helper } from "./helper";',
      "export function run() { helper(); }",
      "export class Worker extends Base implements Contract {}",
    ].join("\n"));

    indexWithDatabase(database!, location);

    const relationSnapshot = () => database!.prepare(`
      SELECT source.stable_id AS source_id, r.source_kind, r.kind,
        target.stable_id AS target_id, r.target_kind, r.confidence, r.provenance
      FROM relations r
      JOIN files source ON r.source_kind = 'file' AND source.id = r.source_id
        OR r.source_kind = 'symbol' AND source.id = (
          SELECT file_id FROM symbols WHERE id = r.source_id
        )
      JOIN files target ON r.target_kind = 'file' AND target.id = r.target_id
        OR r.target_kind = 'symbol' AND target.id = (
          SELECT file_id FROM symbols WHERE id = r.target_id
        )
      ORDER BY r.kind, source_id, target_id
    `).all();

    const rows = database!.prepare(`
      SELECT r.source_kind, r.target_kind, r.kind, r.confidence, r.provenance,
        source.name AS source_name, target.name AS target_name
      FROM relations r
      LEFT JOIN symbols source ON r.source_kind = 'symbol' AND source.id = r.source_id
      LEFT JOIN symbols target ON r.target_kind = 'symbol' AND target.id = r.target_id
      ORDER BY r.kind, source_name, target_name
    `).all();

    expect(rows).toEqual([
      { source_kind: "symbol", target_kind: "symbol", kind: "CALLS", confidence: 0.95, provenance: "typescript-ast-import-binding", source_name: "run", target_name: "helper" },
      { source_kind: "symbol", target_kind: "symbol", kind: "EXTENDS", confidence: 1, provenance: "typescript-ast-heritage", source_name: "Worker", target_name: "Base" },
      { source_kind: "symbol", target_kind: "symbol", kind: "IMPLEMENTS", confidence: 1, provenance: "typescript-ast-heritage", source_name: "Worker", target_name: "Contract" },
      { source_kind: "file", target_kind: "file", kind: "IMPORTS", confidence: 1, provenance: "typescript-ast", source_name: null, target_name: null },
      { source_kind: "file", target_kind: "file", kind: "IMPORTS", confidence: 1, provenance: "typescript-ast", source_name: null, target_name: null },
      { source_kind: "file", target_kind: "file", kind: "IMPORTS", confidence: 1, provenance: "typescript-ast", source_name: null, target_name: null },
    ]);

    const before = relationSnapshot();
    indexWithDatabase(database!, location, true);
    expect(relationSnapshot()).toEqual(before);
    expect(database!.prepare("SELECT COUNT(*) AS count FROM relations").get()).toEqual({ count: 6 });

    writeFileSync(workerPath, "export function run() { return true; }");
    indexWithDatabase(database!, location);
    expect(database!.prepare("SELECT COUNT(*) AS count FROM relations").get()).toEqual({ count: 0 });
  });

});
