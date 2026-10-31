import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureProject, openDatabase, type MemoryDatabase } from "../src/storage/database.js";
import type { ProjectLocation } from "../src/core/project.js";
import { indexWithDatabase } from "../src/core/indexer.js";
import { findDependencies, getSymbolRelations } from "../src/core/retrieval.js";

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

describe("findDependencies", () => {
  it("returns direct and transitive imports up to the requested depth without looping on cycles", () => {
    createProject();
    writeFileSync(join(location.rootPath, "a.ts"), 'import "./b";\nexport const a = true;');
    writeFileSync(join(location.rootPath, "b.ts"), 'import "./c";\nexport const b = true;');
    writeFileSync(join(location.rootPath, "c.ts"), 'import "./a";\nexport const c = true;');
    indexWithDatabase(database!, location);

    expect(findDependencies(location, "a.ts")).toEqual(["b.ts"]);
    expect(findDependencies(location, "a.ts", 2)).toEqual(["b.ts", "c.ts"]);
    expect(findDependencies(location, "a.ts", 10)).toEqual(["b.ts", "c.ts"]);
  });

  it("accepts paths with Windows separators and a leading ./", () => {
    createProject();
    mkdirSync(join(location.rootPath, "src"), { recursive: true });
    writeFileSync(join(location.rootPath, "src", "main.ts"), 'import "./helper";');
    writeFileSync(join(location.rootPath, "src", "helper.ts"), "export const helper = true;");
    indexWithDatabase(database!, location);

    expect(findDependencies(location, "src\\main.ts")).toEqual(["src/helper.ts"]);
    expect(findDependencies(location, "./src/main.ts")).toEqual(["src/helper.ts"]);
  });

  it("rejects invalid depth and reports files outside the index", () => {
    createProject();
    writeFileSync(join(location.rootPath, "main.ts"), "export const main = true;");
    indexWithDatabase(database!, location);

    expect(() => findDependencies(location, "main.ts", 0)).toThrow("Dependency depth must be a positive safe integer");
    expect(() => findDependencies(location, "missing.ts")).toThrow("File not found in memory index");
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
