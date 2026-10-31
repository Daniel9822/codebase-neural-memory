import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureProject, openDatabase, type MemoryDatabase } from "../src/storage/database.js";
import type { ProjectLocation } from "../src/core/project.js";
import { getIndexFreshness, indexWithDatabase } from "../src/core/indexer.js";
import { explainSymbol, findDependencies, findImpact, getFileDetails, getSymbolRelations, searchSymbols } from "../src/core/retrieval.js";
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
  });

  it("accepts paths with Windows separators and a leading ./", () => {
    createProject();
    mkdirSync(join(location.rootPath, "src"), { recursive: true });
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
    writeFileSync(join(location.rootPath, "alpha.ts"), 'import "./target";\\nimport "./gamma";');
    writeFileSync(join(location.rootPath, "beta.ts"), 'import "./target";\\nimport "./alpha";');
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
    expect(details.limits).toEqual({ perCollection: 1 });
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
