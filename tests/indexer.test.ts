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
    expect(summary.scanned).toBe(2);
    expect(summary.skipped).toBe(1);
    expect(summary.skippedFiles).toEqual(["linked.ts: symbolic link"]);
    expect(indexedPaths).toEqual(["normal.ts"]);
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

});
