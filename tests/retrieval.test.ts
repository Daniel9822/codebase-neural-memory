import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureProject, openDatabase, type MemoryDatabase } from "../src/storage/database.js";
import type { ProjectLocation } from "../src/core/project.js";
import { getIndexFreshness, indexWithDatabase } from "../src/core/indexer.js";
import { explainSymbol, getComponentMap, findDependencies, findImpact, findSymbolImpact, getFileDetails, getSourceExcerpt, getSymbolRelations, searchSymbols } from "../src/core/retrieval.js";
import { retrievalRelevanceCases } from "./fixtures/retrieval-relevance.js";

let temporaryDirectory = "";
let database: MemoryDatabase | undefined;
let location: ProjectLocation;

function createProject(): void {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "cnm-dependencies-test-"));
  const rootPath = join(temporaryDirectory, "repository");
  mkdirSync(rootPath, { recursive: true });
  location = {
    id: "dependencies-test-project",
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


describe("symbol retrieval contracts", () => {
  it("supports exact symbol lookup and partial lexical prefix search with source locations", () => {
    createProject();
    writeFileSync(join(location.rootPath, "totals.ts"),
      "export function calculateTotal(items: number[]): number {\n  return items.reduce((sum, item) => sum + item, 0);\n}\nexport function calculateAverage(items: number[]): number {\n  return calculateTotal(items) / items.length;\n}");
    indexWithDatabase(database!, location);

    expect(explainSymbol(location, "calculateTotal")).toMatchObject([
      { name: "calculateTotal", kind: "function", filePath: "totals.ts", startLine: 1, endLine: 3 },
    ]);
    expect(searchSymbols(location, "calcul")).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "calculateTotal", filePath: "totals.ts", startLine: 1, endLine: 3 }),
      expect.objectContaining({ name: "calculateAverage", filePath: "totals.ts", startLine: 4, endLine: 6 }),
    ]));
    expect(searchSymbols(location, "calcul", 1)).toHaveLength(1);
    expect(searchSymbols(location, "calculate average")).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "calculateAverage", rankingSignals: expect.arrayContaining(["name-term-coverage"]), searchMethod: "fts5" }),
    ]));
    expect(searchSymbols(location, "calculateTotal")[0]).toMatchObject({
      name: "calculateTotal", rankingSignals: expect.arrayContaining(["exact-name", "exported-symbol"]),
    });
  });

  it("orders equally ranked symbols by locale-independent code-unit path order", () => {
    createProject();
    for (const path of ["ä.ts", "a.ts", "Z.ts"]) {
      writeFileSync(join(location.rootPath, path), "export function findThing() { return true; }");
    }
    indexWithDatabase(database!, location);

    const hits = searchSymbols(location, "findThing", 10);
    expect(hits.map((hit) => hit.filePath)).toEqual(["Z.ts", "a.ts", "ä.ts"]);
  });

  it("escapes SQL LIKE wildcards in literal symbol-name queries", () => {
    createProject();
    writeFileSync(join(location.rootPath, "names.ts"), `
export function calculate_total(): number { return 1; }
export function calculateXtotal(): number { return 2; }
`);
    indexWithDatabase(database!, location);

    const hits = searchSymbols(location, "calculate_total", 20);
    expect(hits.map((hit) => hit.name)).toContain("calculate_total");
    expect(hits.map((hit) => hit.name)).not.toContain("calculateXtotal");
  });

  it("returns no results for empty or punctuation-only queries and rejects unsafe limits", () => {
    createProject();
    writeFileSync(join(location.rootPath, "plain.ts"), "export const value = true;");
    indexWithDatabase(database!, location);

    expect(searchSymbols(location, "")).toEqual([]);
    expect(searchSymbols(location, "!!!...///")).toEqual([]);
    expect(() => searchSymbols(location, "value", 0)).toThrow("Search limit must be a positive safe integer");
    expect(() => searchSymbols(location, "value", Number.MAX_SAFE_INTEGER + 1)).toThrow("Search limit must be a positive safe integer");
    expect(() => searchSymbols(location, "x".repeat(1_001))).toThrow("Search query must be a string no longer than 1000 characters.");
  });
});

describe("getComponentMap", () => {
  it("aggregates directory import boundaries and reports directed shortest dependency distances", () => {
    createProject();
    mkdirSync(join(location.rootPath, "api"), { recursive: true });
    mkdirSync(join(location.rootPath, "core"), { recursive: true });
    mkdirSync(join(location.rootPath, "shared"), { recursive: true });
    writeFileSync(join(location.rootPath, "api", "handler.ts"), 'import { run } from "../core/runner"; export function handle() { return run(); }');
    writeFileSync(join(location.rootPath, "core", "runner.ts"), 'import { flag } from "../shared/flag"; export function run() { return flag; }');
    writeFileSync(join(location.rootPath, "shared", "flag.ts"), "export const flag = true;");
    writeFileSync(join(location.rootPath, "unrelated.ts"), "export const standalone = true;");
    indexWithDatabase(database!, location);

    expect(getComponentMap(location)).toMatchObject({
      totalComponents: 4,
      edges: [
        { from: "api", to: "core", imports: 1 },
        { from: "core", to: "shared", imports: 1 },
      ],
    });
    expect(getComponentMap(location, { from: "api", depth: 2 }).components).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "api", distanceFrom: 0 }),
      expect.objectContaining({ id: "core", distanceFrom: 1 }),
      expect.objectContaining({ id: "shared", distanceFrom: 2 }),
      expect.objectContaining({ id: "(root)", distanceFrom: null }),
    ]));
    expect(getComponentMap(location, { from: "unrelated.ts" }).from).toBe("(root)");
    expect(() => getComponentMap(location, { from: "missing" })).toThrow("Component not found in memory index");
    expect(() => getComponentMap(location, { limit: 101 })).toThrow("Component limit");
  });
});

describe("findDependencies", () => {
  it("returns direct and transitive imports up to the requested depth without looping on cycles", () => {
    createProject();
    writeFileSync(join(location.rootPath, "a.ts"), 'import "./b";\nexport const a = true;');
    writeFileSync(join(location.rootPath, "b.ts"), 'import "./c";\nexport const b = true;');
    writeFileSync(join(location.rootPath, "c.ts"), 'import "./a";\nexport const c = true;');
    indexWithDatabase(database!, location);

    expect(findDependencies(location, "a.ts")).toMatchObject({
      dependencies: [{ path: "b.ts", depth: 1, chain: ["a.ts", "b.ts"], evidence: {
        relation: "IMPORTS", provenance: "typescript-ast", confidence: 1, indexRevision: 1,
      } }],
      truncated: false,
    });
    expect(findDependencies(location, "a.ts", 2).dependencies).toMatchObject([
      {
        path: "b.ts", depth: 1, chain: ["a.ts", "b.ts"],
        chainEvidence: [{ relation: "IMPORTS", provenance: "typescript-ast", confidence: 1, indexRevision: 1 }],
      },
      {
        path: "c.ts", depth: 2, chain: ["a.ts", "b.ts", "c.ts"],
        chainEvidence: [
          { relation: "IMPORTS", provenance: "typescript-ast", confidence: 1, indexRevision: 1 },
          { relation: "IMPORTS", provenance: "typescript-ast", confidence: 1, indexRevision: 1 },
        ],
      },
    ]);
    expect(findDependencies(location, "a.ts", 10).dependencies.map((item) => item.path)).toEqual(["b.ts", "c.ts"]);
  }, 20_000);

  it("accepts paths with Windows separators and a leading ./", () => {
    createProject();
    mkdirSync(join(location.rootPath, "src"), { recursive: true });
    mkdirSync(join(location.rootPath, "tests"), { recursive: true });
    writeFileSync(join(location.rootPath, "src", "main.ts"), 'import "./helper";');
    writeFileSync(join(location.rootPath, "src", "helper.ts"), "export const helper = true;");
    indexWithDatabase(database!, location);

    expect(findDependencies(location, "src\\main.ts").dependencies.map((item) => item.path)).toEqual(["src/helper.ts"]);
    expect(findDependencies(location, "./src/main.ts").dependencies.map((item) => item.path)).toEqual(["src/helper.ts"]);
  });

  it("rejects invalid depth and reports files outside the index", () => {
    createProject();
    writeFileSync(join(location.rootPath, "main.ts"), "export const main = true;");
    indexWithDatabase(database!, location);

    expect(() => findDependencies(location, "main.ts", 0)).toThrow("Dependency depth must be a positive safe integer");
    expect(() => findDependencies(location, "main.ts", 1, 0)).toThrow("Dependency result limit must be a positive safe integer");
    expect(() => findDependencies(location, "main.ts", 1, 10, 0)).toThrow("Dependency processing limit must be a positive safe integer");
    expect(() => findDependencies(location, "missing.ts")).toThrow("File not found in memory index");
  });
});


describe("findImpact", () => {
  it("returns known reverse dependents transitively and terminates on cycles and duplicate paths", () => {
    createProject();
    writeFileSync(join(location.rootPath, "target.ts"), "export const target = true;");
    writeFileSync(join(location.rootPath, "alpha.ts"), 'import "./target";\nimport "./gamma";');
    writeFileSync(join(location.rootPath, "beta.ts"), 'import "./target";\nimport "./alpha";');
    writeFileSync(join(location.rootPath, "gamma.ts"), 'import "./alpha";');
    indexWithDatabase(database!, location);

    const result = findImpact(location, "target.ts");
    expect(result.affectedFiles).toEqual(["alpha.ts", "beta.ts", "gamma.ts"]);
    expect(result).toMatchObject({
      file: "target.ts", truncated: false, processedFiles: 4,
      limits: { maxResults: 100, maxProcessed: 1000 },
    });
    expect(result.processedRelations).toBeGreaterThanOrEqual(4);
  });

  it("reports result and processing truncation and validates both limits", () => {
    createProject();
    writeFileSync(join(location.rootPath, "target.ts"), "export const target = true;");
    writeFileSync(join(location.rootPath, "a.ts"), 'import "./target";');
    writeFileSync(join(location.rootPath, "b.ts"), 'import "./target";');
    indexWithDatabase(database!, location);

    const byResults = findImpact(location, "target.ts", 1, 100);
    expect(byResults.affectedFiles).toHaveLength(1);
    expect(byResults.truncated).toBe(true);
    const byProcessing = findImpact(location, "target.ts", 10, 1);
    expect(byProcessing.processedRelations).toBe(1);
    expect(byProcessing.truncated).toBe(true);
    expect(() => findImpact(location, "target.ts", 0)).toThrow("Impact result limit must be a positive safe integer");
    expect(() => findImpact(location, "target.ts", 10, 0)).toThrow("Impact processing limit must be a positive safe integer");
    expect(() => findImpact(location, "missing.ts")).toThrow("File not found in memory index");
  });
});

describe("getSourceExcerpt", () => {
  it("returns bounded source lines and reports whether working-tree content matches the index", () => {
    createProject();
    writeFileSync(join(location.rootPath, "source.ts"), "export const first = 1;\nexport function second() {\n  return first;\n}\n");
    indexWithDatabase(database!, location);

    const excerpt = getSourceExcerpt(location, "source.ts", 2, 3, 500);
    expect(excerpt).toMatchObject({
      path: "source.ts", startLine: 2, endLine: 3, requestedStartLine: 2,
      requestedEndLine: 3, totalLines: 5, indexStatus: "current", truncated: false,
      limits: { maxLines: 200, maxCharacters: 500 },
    });
    expect(excerpt.content).toBe("export function second() {\n  return first;");
    expect(excerpt.contentHash).toBe(excerpt.indexedContentHash);

    writeFileSync(join(location.rootPath, "source.ts"), "export const first = 2;\nexport function second() {\n  return first;\n}\n");
    const stale = getSourceExcerpt(location, "source.ts", 1, 2, 500);
    expect(stale.indexStatus).toBe("stale");
    expect(stale.contentHash).not.toBe(stale.indexedContentHash);
  });

  it("rejects an indexed file replaced by a symlink outside the project", () => {
    createProject();
    const sourcePath = join(location.rootPath, "source.ts");
    const outsidePath = join(temporaryDirectory, "outside.ts");
    writeFileSync(sourcePath, "export const value = true;\n");
    indexWithDatabase(database!, location);

    writeFileSync(outsidePath, "export const secret = 'outside';\n");
    rmSync(sourcePath);
    symlinkSync(outsidePath, sourcePath);

    expect(() => getSourceExcerpt(location, "source.ts", 1, 1)).toThrow(/outside the project root/i);
  });

  it("rejects unindexed, traversal, invalid, and oversized source ranges", () => {
    createProject();
    writeFileSync(join(location.rootPath, "source.ts"), "export const value = true;\n");
    indexWithDatabase(database!, location);

    expect(() => getSourceExcerpt(location, "missing.ts", 1, 1)).toThrow("File not found in memory index");
    expect(() => getSourceExcerpt(location, "../outside.ts", 1, 1)).toThrow("project-relative");
    expect(() => getSourceExcerpt(location, "source.ts", 0, 1)).toThrow("startLine");
    expect(() => getSourceExcerpt(location, "source.ts", 2, 1)).toThrow("endLine");
    expect(() => getSourceExcerpt(location, "source.ts", 1, 201)).toThrow("cannot exceed 200 lines");
    expect(() => getSourceExcerpt(location, "source.ts", 1, 1, 20_001)).toThrow("maxCharacters");
  });
});

describe("getSymbolRelations", () => {
  it("returns incoming and outgoing symbol edges with source locations and evidence", () => {
    createProject();
    writeFileSync(join(location.rootPath, "base.ts"), "export class Base {}");
    writeFileSync(join(location.rootPath, "contract.ts"), "export interface Contract {}");
    writeFileSync(join(location.rootPath, "worker.ts"),
      'import { Base } from "./base";\nimport { Contract } from "./contract";\nexport class Worker extends Base implements Contract {}');
    indexWithDatabase(database!, location);

    expect(getSymbolRelations(location, "Worker")).toEqual([
      {
        direction: "outgoing", relation: "EXTENDS", symbolName: "Worker", symbolKind: "class",
        symbolFilePath: "worker.ts", symbolStartLine: 3, symbolEndLine: 3,
        relatedSymbolName: "Base", relatedSymbolKind: "class", relatedFilePath: "base.ts",
        relatedStartLine: 1, relatedEndLine: 1, confidence: 1, provenance: "typescript-ast-heritage", indexRevision: 1,
      },
      {
        direction: "outgoing", relation: "IMPLEMENTS", symbolName: "Worker", symbolKind: "class",
        symbolFilePath: "worker.ts", symbolStartLine: 3, symbolEndLine: 3,
        relatedSymbolName: "Contract", relatedSymbolKind: "interface", relatedFilePath: "contract.ts",
        relatedStartLine: 1, relatedEndLine: 1, confidence: 1, provenance: "typescript-ast-heritage", indexRevision: 1,
      },
    ]);
    expect(() => getSymbolRelations(location, "Worker", 501)).toThrow("Relation limit must be a positive safe integer no greater than 500.");
    expect(() => getSymbolRelations(location, "Worker", 0)).toThrow("Relation limit must be a positive safe integer no greater than 500.");
    expect(getSymbolRelations(location, "Base")).toEqual([
      {
        direction: "incoming", relation: "EXTENDS", symbolName: "Base", symbolKind: "class",
        symbolFilePath: "base.ts", symbolStartLine: 1, symbolEndLine: 1,
        relatedSymbolName: "Worker", relatedSymbolKind: "class", relatedFilePath: "worker.ts",
        relatedStartLine: 3, relatedEndLine: 3, confidence: 1, provenance: "typescript-ast-heritage", indexRevision: 1,
      },
    ]);
  });


  it("advances the project revision and exposes it on graph relations", () => {
    createProject();
    writeFileSync(join(location.rootPath, "base.ts"), "export class Base {}");
    writeFileSync(join(location.rootPath, "child.ts"), 'import { Base } from "./base";\nexport class Child extends Base {}');

    indexWithDatabase(database!, location);
    expect(database!.prepare("SELECT DISTINCT index_revision FROM relations").all()).toEqual([{ index_revision: 1 }]);
    expect(getSymbolRelations(location, "Child")[0]).toMatchObject({ indexRevision: 1 });

    indexWithDatabase(database!, location);
    expect(database!.prepare("SELECT DISTINCT index_revision FROM relations").all()).toEqual([{ index_revision: 2 }]);
    expect(getSymbolRelations(location, "Child")[0]).toMatchObject({ indexRevision: 2 });
    expect(database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id)).toEqual({ index_revision: 2 });
  });

  it("rolls back the revision and previous graph when relation rebuilding fails", () => {
    createProject();
    writeFileSync(join(location.rootPath, "base.ts"), "export class Base {}");
    writeFileSync(join(location.rootPath, "child.ts"), 'import { Base } from "./base";\nexport class Child extends Base {}');
    indexWithDatabase(database!, location);
    const before = database!.prepare("SELECT id, index_revision FROM relations ORDER BY id").all();
    writeFileSync(join(location.rootPath, "child.ts"), 'import { Base } from "./base";\nexport class Child extends Base { changed() {} }');
    database!.exec("CREATE TRIGGER reject_relation_insert BEFORE INSERT ON relations BEGIN SELECT RAISE(ABORT, 'forced relation failure'); END;");

    expect(() => indexWithDatabase(database!, location)).toThrow("forced relation failure");
    expect(database!.prepare("SELECT id, index_revision FROM relations ORDER BY id").all()).toEqual(before);
    expect(database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id)).toEqual({ index_revision: 1 });
  });

  it("returns no results for unknown names and validates limits", () => {
    createProject();
    writeFileSync(join(location.rootPath, "plain.ts"), "export const value = true;");
    indexWithDatabase(database!, location);
    expect(getSymbolRelations(location, "Missing")).toEqual([]);
    expect(() => getSymbolRelations(location, "value", 0)).toThrow("Relation limit must be a positive safe integer");
  });

  it("keeps same-named symbols scoped to their own files", () => {
    createProject();
    mkdirSync(join(location.rootPath, "one"), { recursive: true });
    mkdirSync(join(location.rootPath, "two"), { recursive: true });
    writeFileSync(join(location.rootPath, "one", "base.ts"), "export class Base {}");
    writeFileSync(join(location.rootPath, "one", "child.ts"), 'import { Base } from "./base";\nexport class Child extends Base {}');
    writeFileSync(join(location.rootPath, "two", "base.ts"), "export class Base {}");
    indexWithDatabase(database!, location);

    expect(getSymbolRelations(location, "Base")).toHaveLength(1);
    expect(getSymbolRelations(location, "Base")[0]).toMatchObject({
      direction: "incoming", symbolFilePath: "one/base.ts", relatedFilePath: "one/child.ts",
    });
  });
});

describe("getIndexFreshness", () => {
  it("detects added, changed, and deleted source files without changing the index revision", () => {
    createProject();
    writeFileSync(join(location.rootPath, "changed.ts"), "export const before = true;");
    writeFileSync(join(location.rootPath, "deleted.ts"), "export const removed = true;");
    indexWithDatabase(database!, location);
    const beforeRevision = (database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision;

    writeFileSync(join(location.rootPath, "changed.ts"), "export const after = true;");
    writeFileSync(join(location.rootPath, "added.ts"), "export const added = true;");
    rmSync(join(location.rootPath, "deleted.ts"));

    expect(getIndexFreshness(location)).toMatchObject({
      status: "stale", indexRevision: beforeRevision, addedFiles: 1, changedFiles: 1, deletedFiles: 1,
    });
    expect(database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id)).toEqual({ index_revision: beforeRevision });
    expect(database!.prepare("SELECT path, content_hash FROM files WHERE path = 'changed.ts'").all()).toHaveLength(1);
    expect(database!.prepare("SELECT path FROM files ORDER BY path").all()).toEqual([
      { path: "changed.ts" }, { path: "deleted.ts" },
    ]);
  });

  it("honors persisted custom exclusions and reports a current index", () => {
    createProject();
    writeFileSync(join(location.rootPath, "included.ts"), "export const included = true;");
    writeFileSync(join(location.rootPath, "generated.ts"), "export const generated = true;");
    indexWithDatabase(database!, location, false, ["generated.ts"]);

    expect(getIndexFreshness(location)).toMatchObject({
      status: "current", addedFiles: 0, changedFiles: 0, deletedFiles: 0, skippedFiles: [], errors: [],
    });
  });

  it("marks discovery as incomplete when a supported file is skipped", () => {
    createProject();
    writeFileSync(join(location.rootPath, "large.ts"), "export const small = true;");
    indexWithDatabase(database!, location);
    writeFileSync(join(location.rootPath, "large.ts"), "x".repeat(1_000_001));

    expect(getIndexFreshness(location)).toMatchObject({
      status: "incomplete",
      skippedFiles: ["large.ts: exceeds 1000000 bytes"],
    });
  });

  it("reports an unindexed project without treating every source file as a delta", () => {
    createProject();
    writeFileSync(join(location.rootPath, "main.ts"), "export const main = true;");
    expect(getIndexFreshness(location)).toMatchObject({ status: "not-indexed", checkedFiles: 0 });
  });
});


describe("bounded dependency traversal and file details", () => {
  it("reports truncation when result or processing budgets are reached", () => {
    createProject();
    writeFileSync(join(location.rootPath, "root.ts"), 'import "./a";\nimport "./b";');
    writeFileSync(join(location.rootPath, "a.ts"), 'import "./leaf";');
    writeFileSync(join(location.rootPath, "b.ts"), 'export const b = true;');
    writeFileSync(join(location.rootPath, "leaf.ts"), "export const leaf = true;");
    indexWithDatabase(database!, location);

    const byResults = findDependencies(location, "root.ts", 3, 1, 100);
    expect(byResults.dependencies).toHaveLength(1);
    expect(byResults.truncated).toBe(true);
    const byProcessing = findDependencies(location, "root.ts", 3, 10, 1);
    expect(byProcessing.processedFiles).toBe(1);
    expect(byProcessing.processedRelations).toBe(1);
    expect(byProcessing.truncated).toBe(true);
  });

  it("returns only indexed file facts with imports, symbols, references, and provenance", () => {
    createProject();
    writeFileSync(join(location.rootPath, "base.ts"), "export class Base {}");
    writeFileSync(join(location.rootPath, "worker.ts"),
      'import { Base } from "./base";\nexport class Worker extends Base {}');
    indexWithDatabase(database!, location);

    expect(getFileDetails(location, "base.ts").relations).toEqual([expect.objectContaining({
      direction: "incoming", relation: "EXTENDS", sourceName: "Worker", targetName: "Base",
    })]);
    expect(getFileDetails(location, "worker.ts")).toMatchObject({
      path: "worker.ts",
      language: "typescript",
      indexRevision: 1,
      symbols: [{ name: "Worker", kind: "class", filePath: "worker.ts" }],
      imports: [{ path: "base.ts", provenance: "typescript-ast", confidence: 1, indexRevision: 1 }],
      relations: [{
        direction: "outgoing", relation: "EXTENDS", sourceName: "Worker", targetName: "Base",
        sourceFilePath: "worker.ts", targetFilePath: "base.ts", provenance: "typescript-ast-heritage",
      }],
    });
  });
});

describe("bounded file detail retrieval", () => {
  it("returns bounded TypeScript package and named-export diagnostics", () => {
    createProject();
    const packageRoot = join(location.rootPath, "node_modules", "fixture-package");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "fixture-package", types: "index.d.ts" }));
    writeFileSync(join(packageRoot, "index.d.ts"), "export declare const present: boolean;");
    writeFileSync(join(location.rootPath, "imports.ts"), [
      'import { missing } from "fixture-package";',
      'import { absent } from "not-installed-fixture";',
      "void missing; void absent;",
    ].join("\n"));
    indexWithDatabase(database!, location);

    const details = getFileDetails(location, "imports.ts");
    expect(details.importDiagnostics).toEqual([
      expect.objectContaining({ specifier: "fixture-package", kind: "missing-export", code: 2305, importedName: "missing", line: 1 }),
      expect.objectContaining({ specifier: "not-installed-fixture", kind: "missing-package", code: 2307, line: 2 }),
    ]);
    expect(details.totals.importDiagnostics).toBe(2);
    expect(details.truncated.importDiagnostics).toBe(false);
    expect(getFileDetails(location, "imports.ts", 1).importDiagnostics).toHaveLength(1);
    expect(getFileDetails(location, "imports.ts", 1).truncated.importDiagnostics).toBe(true);
  });

  it("limits every collection and reports totals and truncation", () => {
    createProject();
    writeFileSync(join(location.rootPath, "many.ts"), `
export function first() {}
export function second() {}
export function third() {}
`);
    indexWithDatabase(database!, location);

    const details = getFileDetails(location, "many.ts", 1);
    expect(details.symbols).toHaveLength(1);
    expect(details.totals.symbols).toBe(3);
    expect(details.limits).toEqual({ perCollection: 1, candidatesPerImport: 200, candidateBudget: 2_000 });
    expect(details.truncated).toMatchObject({ symbols: true, imports: false, unresolvedImports: false, relations: false });
    expect(() => getFileDetails(location, "many.ts", 0)).toThrow("File detail limit must be a positive safe integer");
    expect(() => getFileDetails(location, "many.ts", 501)).toThrow("File detail limit must be a positive safe integer");
  });
});

describe("labeled retrieval relevance corpus", () => {
  it("places each labeled relevant symbol first for its fixture query", () => {
    createProject();
    writeFileSync(join(location.rootPath, "participants.ts"), `
export function registerParticipant(participantId: string): boolean {
  return participantId.length > 0;
}
export function unregisterParticipant(participantId: string): boolean {
  return participantId.length === 0;
}
export function calculateTotal(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}
export function calculateAverage(values: number[]): number {
  return calculateTotal(values) / values.length;
}
export function removeParticipant(participantId: string): boolean { return participantId.length > 0; }
export function validateRegistration(input: string): boolean { return input.trim().length > 0; }
export function saveTournament(id: string): boolean { return id.length > 0; }
export function loadTournament(id: string): string { return id; }
export function calculateStandings(scores: number[]): number { return scores.length; }
export function parseTournamentDate(value: string): Date { return new Date(value); }
export function determineWinner(scores: number[]): number { return Math.max(...scores); }
`);
    indexWithDatabase(database!, location);

    expect(searchSymbols(location, "ticipant")[0]).toMatchObject({
      name: "registerParticipant", searchMethod: "like-fallback",
    });
    for (const fixture of retrievalRelevanceCases) {
      const results = searchSymbols(location, fixture.query, 10);
      expect(results[0]?.name, fixture.query).toBe(fixture.expectedTop);
      expect(results.some((result) => (fixture.relevant as readonly string[]).includes(result.name))).toBe(true);
    }
  });
});


describe("findSymbolImpact", () => {
  it("traverses incoming and outgoing symbol relations with shortest distances and edge evidence", () => {
    createProject();
    writeFileSync(join(location.rootPath, "target.ts"), "export function target() { return true; }\n");
    writeFileSync(join(location.rootPath, "middle.ts"), 'import { target } from "./target";\nexport function middle() { return target(); }\n');
    writeFileSync(join(location.rootPath, "outer.ts"), 'import { middle } from "./middle";\nexport function outer() { return middle(); }\n');
    writeFileSync(join(location.rootPath, "base.ts"), "export class Base {}\n");
    writeFileSync(join(location.rootPath, "contract.ts"), "export interface Contract {}\n");
    writeFileSync(join(location.rootPath, "child.ts"), 'import { Base } from "./base";\nimport { Contract } from "./contract";\nexport class Child extends Base implements Contract {}\n');
    indexWithDatabase(database!, location);

    const incoming = findSymbolImpact(location, "target", { filePath: "target.ts", depth: 2 });
    expect(incoming).toMatchObject({
      target: { name: "target", filePath: "target.ts" },
      ambiguous: false, direction: "incoming", truncated: false,
      results: [
        { name: "middle", filePath: "middle.ts", distance: 1, relation: "CALLS" },
        { name: "outer", filePath: "outer.ts", distance: 2, relation: "CALLS" },
      ],
    });
    expect(incoming.results[0]?.path.map((symbol) => symbol.name)).toEqual(["target", "middle"]);
    expect(incoming.results[1]?.path.map((symbol) => symbol.name)).toEqual(["target", "middle", "outer"]);
    expect(incoming.results[1]?.chainEvidence).toHaveLength(2);
    expect(incoming.results[0]?.chainEvidence[0]).toMatchObject({
      relation: "CALLS", source: { name: "middle" }, target: { name: "target" },
      provenance: "typescript-ast-import-binding", confidence: 0.95, indexRevision: 1,
    });

    const outgoing = findSymbolImpact(location, "outer", { filePath: "outer.ts", direction: "outgoing", depth: 2 });
    expect(outgoing.results.map((item) => [item.name, item.distance])).toEqual([["middle", 1], ["target", 2]]);

    expect(findSymbolImpact(location, "Base", { filePath: "base.ts" }).results).toMatchObject([
      { name: "Child", relation: "EXTENDS", distance: 1 },
    ]);
    expect(findSymbolImpact(location, "Contract", { filePath: "contract.ts" }).results).toMatchObject([
      { name: "Child", relation: "IMPLEMENTS", distance: 1 },
    ]);
  });

  it("reports ambiguous roots and supports exact path, kind, line, and relation filters", () => {
    createProject();
    mkdirSync(join(location.rootPath, "one"), { recursive: true });
    mkdirSync(join(location.rootPath, "two"), { recursive: true });
    writeFileSync(join(location.rootPath, "one", "shared.ts"), "export function shared() { return true; }\n");
    writeFileSync(join(location.rootPath, "two", "shared.ts"), "export function shared() { return false; }\n");
    writeFileSync(join(location.rootPath, "caller.ts"), 'import { shared } from "./one/shared";\nexport function caller() { return shared(); }\n');
    indexWithDatabase(database!, location);

    const ambiguous = findSymbolImpact(location, "shared");
    expect(ambiguous).toMatchObject({ ambiguous: true, target: null, results: [], processedRelations: 0 });
    expect(ambiguous.candidates.map((item) => item.filePath)).toEqual(["one/shared.ts", "two/shared.ts"]);
    const scoped = findSymbolImpact(location, "shared", { filePath: "one/shared.ts", kind: "function", startLine: 1, relationKinds: ["CALLS"] });
    expect(scoped.ambiguous).toBe(false);
    expect(scoped.results).toMatchObject([{ name: "caller", distance: 1, relation: "CALLS" }]);
    expect(findSymbolImpact(location, "shared", { filePath: "one/shared.ts", relationKinds: ["EXTENDS"] }).results).toEqual([]);
  });

  it("maps concrete test cases to the imported symbols they call", () => {
    createProject();
    mkdirSync(join(location.rootPath, "src"), { recursive: true });
    mkdirSync(join(location.rootPath, "tests"), { recursive: true });
    writeFileSync(join(location.rootPath, "src", "auth.ts"), "export function refreshAuthToken() { return true; }\n");
    writeFileSync(join(location.rootPath, "tests", "auth.test.ts"), `import { it } from "vitest";
import { refreshAuthToken } from "../src/auth";
describe("auth", () => {
  it("refreshes tokens", () => {
    refreshAuthToken();
  });
});
`);
    indexWithDatabase(database!, location);

    const impact = findSymbolImpact(location, "refreshAuthToken", {
      filePath: "src/auth.ts",
      depth: 1,
      relationKinds: ["CALLS"],
    });
    expect(impact.results).toMatchObject([{
      name: expect.stringContaining("test-case: refreshes tokens#1"),
      kind: "test-case",
      filePath: "tests/auth.test.ts",
      distance: 1,
      relation: "CALLS",
      chainEvidence: [{
        source: { kind: "test-case", filePath: "tests/auth.test.ts" },
        target: { name: "refreshAuthToken", filePath: "src/auth.ts" },
      }],
    }]);
  });

  it("enforces result and processing limits and rejects unsafe inputs", () => {
    createProject();
    writeFileSync(join(location.rootPath, "target.ts"), "export function target() { return true; }\n");
    writeFileSync(join(location.rootPath, "a.ts"), 'import { target } from "./target";\nexport function callerA() { return target(); }\n');
    writeFileSync(join(location.rootPath, "b.ts"), 'import { target } from "./target";\nexport function callerB() { return target(); }\n');
    indexWithDatabase(database!, location);

    const byResults = findSymbolImpact(location, "target", { filePath: "target.ts", limit: 1 });
    expect(byResults.results).toHaveLength(1);
    expect(byResults.truncated).toBe(true);
    const byProcessing = findSymbolImpact(location, "target", { filePath: "target.ts", maxProcessed: 1 });
    expect(byProcessing.processedRelations).toBe(1);
    expect(byProcessing.truncated).toBe(true);

    expect(() => findSymbolImpact(location, "missing")).toThrow("Symbol not found in index");
    expect(() => findSymbolImpact(location, "target", { depth: 0 })).toThrow("depth");
    expect(() => findSymbolImpact(location, "target", { limit: 501 })).toThrow("result limit");
    expect(() => findSymbolImpact(location, "target", { maxProcessed: 10_001 })).toThrow("processing limit");
    expect(() => findSymbolImpact(location, "target", { filePath: "../target.ts" })).toThrow("project-relative");
    expect(() => findSymbolImpact(location, "target", { startLine: 0 })).toThrow("startLine");
    expect(() => findSymbolImpact(location, "target", { relationKinds: [] })).toThrow("relationKinds");
  });
});
