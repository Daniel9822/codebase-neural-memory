import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureProject, openDatabase, type MemoryDatabase } from "../src/storage/database.js";
import type { ProjectLocation } from "../src/core/project.js";
import { getIndexFreshness, indexProject, indexWithDatabase, updateProjectIndex } from "../src/core/indexer.js";
import { analyzeImportDiagnostics } from "../src/core/import-diagnostics.js";

let temporaryDirectory = "";
let database: MemoryDatabase | undefined;
let location: ProjectLocation;

function createProject(): void {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "cnm-integrity-combined-"));
  const rootPath = join(temporaryDirectory, "repository");
  mkdirSync(rootPath, { recursive: true });
  location = {
    id: "integrity-combined-test",
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

describe("integrated CNM integrity regressions", () => {
  it("does not destructively reconcile when symlink replacement, source drift, and relation-config drift coincide", () => {
    createProject();
    const nestedDirectory = join(location.rootPath, "z-scope");
    const savedDirectory = join(temporaryDirectory, "saved-scope");
    const outsideDirectory = join(temporaryDirectory, "outside-scope");

    mkdirSync(nestedDirectory, { recursive: true });
    writeFileSync(join(location.rootPath, "a-source.ts"), "export function original() { return true; }\n");
    writeFileSync(join(nestedDirectory, "nested.ts"), "export function retained() { return true; }\n");
    writeFileSync(join(location.rootPath, "tsconfig.json"), JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
    }));

    const initial = indexWithDatabase(database!, location);
    expect(initial.added).toBe(2);

    writeFileSync(join(location.rootPath, "a-source.ts"), "export function changed() { return true; }\n");
    writeFileSync(join(location.rootPath, "tsconfig.json"), JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["different/*"] } },
    }));
    renameSync(nestedDirectory, savedDirectory);
    mkdirSync(outsideDirectory, { recursive: true });
    writeFileSync(join(outsideDirectory, "outside.ts"), "export function outside() { return true; }\n");
    symlinkSync(outsideDirectory, nestedDirectory, "dir");

    expect(() => updateProjectIndex(location)).toThrow(/discovery is incomplete/i);

    const freshness = getIndexFreshness(location);
    expect(freshness.status).toBe("incomplete");
    expect(freshness.relationsConfigChanged).toBe(true);
    expect(freshness.changedFiles).toBe(1);
    expect(freshness.deletedFiles).toBe(0);

    const indexedPaths = (database!.prepare("SELECT path FROM files ORDER BY path").all() as Array<{ path: string }>)
      .map((row) => row.path);
    expect(indexedPaths).toEqual(["a-source.ts", "z-scope/nested.ts"]);
    expect(database!.prepare("SELECT name FROM symbols ORDER BY name").all()).toEqual([
      { name: "original" },
      { name: "retained" },
    ]);
  });
  it("reports symlinked package manifests and refuses scoped updates without destroying the prior graph", () => {
    createProject();
    const packageDirectory = join(location.rootPath, "node_modules", "shared-config");
    const packageManifest = join(packageDirectory, "package.json");
    const outsideManifest = join(temporaryDirectory, "outside-package.json");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(location.rootPath, "tsconfig.json"), JSON.stringify({ extends: "shared-config" }));
    writeFileSync(join(packageDirectory, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    writeFileSync(packageManifest, JSON.stringify({ tsconfig: "tsconfig.json" }));
    writeFileSync(outsideManifest, JSON.stringify({ tsconfig: "tsconfig.json" }));
    writeFileSync(join(location.rootPath, "main.ts"), "export function main() { return true; }");
    indexProject(location);
    const beforeRevision = (database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision;

    rmSync(packageManifest);
    symlinkSync(outsideManifest, packageManifest, "file");

    const freshness = getIndexFreshness(location);
    expect(freshness.status).toBe("incomplete");
    expect(freshness.errors.some((error) => error.includes("node_modules/shared-config/package.json"))).toBe(true);
    expect(() => updateProjectIndex(location, { paths: ["main.ts"] })).toThrow(/relation configuration is incomplete/i);
    expect((database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision)
      .toBe(beforeRevision);
    expect(database!.prepare("SELECT path FROM files").all()).toEqual([{ path: "main.ts" }]);
  });

  it("refuses a full index when relation configuration is malformed instead of committing an incomplete graph", () => {
    createProject();
    writeFileSync(join(location.rootPath, "tsconfig.json"), '{"compilerOptions": {');
    writeFileSync(join(location.rootPath, "main.ts"), "export const value = true;");

    expect(() => indexProject(location)).toThrow(/relation configuration is incomplete/i);
    expect(database!.prepare("SELECT path FROM files").all()).toEqual([]);
    expect(database!.prepare("SELECT COUNT(*) AS count FROM relations").get()).toEqual({ count: 0 });
  });

  it("protects indexed descendants when an ignored directory is replaced by a symlink", () => {
    createProject();
    const indexedDirectory = join(location.rootPath, "src");
    const savedDirectory = join(temporaryDirectory, "saved-src");
    const outsideDirectory = join(temporaryDirectory, "outside-src");
    mkdirSync(indexedDirectory, { recursive: true });
    mkdirSync(outsideDirectory, { recursive: true });
    writeFileSync(join(indexedDirectory, "main.ts"), "export function main() { return true; }");
    indexProject(location);
    const beforeRevision = (database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision;

    writeFileSync(join(location.rootPath, ".gitignore"), "src/");
    renameSync(indexedDirectory, savedDirectory);
    writeFileSync(join(outsideDirectory, "main.ts"), "export function main() { return false; }");
    symlinkSync(outsideDirectory, indexedDirectory, "dir");

    expect(() => indexProject(location)).toThrow(/source discovery is incomplete/i);
    const freshness = getIndexFreshness(location);
    expect(freshness.status).toBe("incomplete");
    expect(freshness.deletedFiles).toBe(0);
    expect((database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision)
      .toBe(beforeRevision);
    expect(database!.prepare("SELECT path FROM files").all()).toEqual([{ path: "src/main.ts" }]);
  });

  it("rejects project-local extends through symlinked parent directories and preserves the existing index", () => {
    createProject();
    const linkedConfigDirectory = join(location.rootPath, "configs");
    const savedConfigDirectory = join(temporaryDirectory, "saved-configs");
    const outsideConfigDirectory = join(temporaryDirectory, "outside-configs");
    mkdirSync(linkedConfigDirectory, { recursive: true });
    mkdirSync(outsideConfigDirectory, { recursive: true });
    writeFileSync(join(linkedConfigDirectory, "base.json"), JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
    }));
    writeFileSync(join(outsideConfigDirectory, "base.json"), JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["outside/*"] } },
    }));
    writeFileSync(join(location.rootPath, ".gitignore"), "configs/");
    writeFileSync(join(location.rootPath, "tsconfig.json"), JSON.stringify({ extends: "./configs/base.json" }));
    writeFileSync(join(location.rootPath, "main.ts"), "export function main() { return true; }");
    indexProject(location);
    const beforeRevision = (database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision;

    renameSync(linkedConfigDirectory, savedConfigDirectory);
    symlinkSync(outsideConfigDirectory, linkedConfigDirectory, "dir");

    const freshness = getIndexFreshness(location);
    expect(freshness.status).toBe("incomplete");
    expect(freshness.errors.some((error) => error.includes("configs/base.json"))).toBe(true);
    expect(() => updateProjectIndex(location, { paths: ["main.ts"] })).toThrow(/relation configuration is incomplete/i);
    expect((database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision)
      .toBe(beforeRevision);
    expect(database!.prepare("SELECT path FROM files").all()).toEqual([{ path: "main.ts" }]);
  });

  it("fingerprints package metadata that selects an extended TypeScript config", () => {
    createProject();
    const packageDirectory = join(location.rootPath, "node_modules", "shared-config");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ tsconfig: "base-a.json" }));
    writeFileSync(join(packageDirectory, "base-a.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    writeFileSync(join(packageDirectory, "base-b.json"), JSON.stringify({ compilerOptions: { strict: false } }));
    writeFileSync(join(location.rootPath, "tsconfig.json"), JSON.stringify({ extends: "shared-config" }));
    writeFileSync(join(location.rootPath, "main.ts"), "export function main() { return true; }");

    indexWithDatabase(database!, location);
    expect(getIndexFreshness(location).status).toBe("current");

    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ tsconfig: "base-b.json" }));
    const freshness = getIndexFreshness(location);
    expect(freshness.status).toBe("stale");
    expect(freshness.relationsConfigChanged).toBe(true);
  });

  it("fingerprints only node_modules manifests consulted by semantic TypeScript resolution", () => {
    createProject();
    const packageDirectory = join(location.rootPath, "node_modules", "semantic-fixture");
    const unusedPackageDirectory = join(location.rootPath, "node_modules", "unused-fixture");
    mkdirSync(packageDirectory, { recursive: true });
    mkdirSync(unusedPackageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ types: "./index-a.d.ts" }));
    writeFileSync(join(packageDirectory, "index-a.d.ts"), "export declare const onlyA: string;");
    writeFileSync(join(packageDirectory, "index-b.d.ts"), "export declare const onlyB: string;");
    writeFileSync(join(unusedPackageDirectory, "package.json"), JSON.stringify({ name: "unused-fixture", version: "1.0.0" }));
    writeFileSync(join(location.rootPath, "main.ts"), 'import { onlyA } from "semantic-fixture";\nexport const value = onlyA;');

    indexWithDatabase(database!, location);
    expect(getIndexFreshness(location).status).toBe("current");

    writeFileSync(join(unusedPackageDirectory, "package.json"), JSON.stringify({ name: "unused-fixture", version: "2.0.0" }));
    expect(getIndexFreshness(location).status).toBe("current");

    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ types: "./index-b.d.ts" }));
    const freshness = getIndexFreshness(location);
    expect(freshness.status).toBe("stale");
    expect(freshness.relationsConfigChanged).toBe(true);
  });

  it("fails closed when a consulted semantic dependency manifest becomes a symlink", () => {
    createProject();
    const packageDirectory = join(location.rootPath, "node_modules", "semantic-fixture");
    const packageManifest = join(packageDirectory, "package.json");
    const outsideManifest = join(temporaryDirectory, "outside-semantic-package.json");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(packageManifest, JSON.stringify({ types: "./index.d.ts" }));
    writeFileSync(join(packageDirectory, "index.d.ts"), "export declare const value: string;");
    writeFileSync(outsideManifest, JSON.stringify({ types: "./outside.d.ts" }));
    writeFileSync(join(location.rootPath, "main.ts"), 'import { value } from "semantic-fixture";\nexport const result = value;');
    indexWithDatabase(database!, location);
    const beforeRevision = (database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision;

    rmSync(packageManifest);
    symlinkSync(outsideManifest, packageManifest, "file");

    const freshness = getIndexFreshness(location);
    expect(freshness.status).toBe("incomplete");
    expect(freshness.errors.some((error) => error.includes("semantic-fixture/package.json"))).toBe(true);
    expect(() => updateProjectIndex(location, { paths: ["main.ts"] })).toThrow(/relation configuration is incomplete/i);
    expect((database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision)
      .toBe(beforeRevision);

    rmSync(packageManifest);
    writeFileSync(packageManifest, "{ invalid package metadata");
    const malformedFreshness = getIndexFreshness(location);
    expect(malformedFreshness.status).toBe("incomplete");
    expect(malformedFreshness.errors.some((error) => error.includes("invalid JSON"))).toBe(true);
    expect(() => updateProjectIndex(location, { paths: ["main.ts"] })).toThrow(/relation configuration is incomplete/i);
    expect((database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision)
      .toBe(beforeRevision);
  });

  it("resolves declarations through an approved package-manager directory symlink", () => {
    createProject();
    const externalPackage = join(temporaryDirectory, "external-semantic-package");
    const packageDirectory = join(location.rootPath, "node_modules", "linked-fixture");
    mkdirSync(externalPackage, { recursive: true });
    mkdirSync(join(location.rootPath, "node_modules"), { recursive: true });
    writeFileSync(join(externalPackage, "package.json"), JSON.stringify({ types: "./index.d.ts" }));
    writeFileSync(join(externalPackage, "index.d.ts"), "export declare const linkedValue: string;");
    symlinkSync(externalPackage, packageDirectory, "dir");
    writeFileSync(join(location.rootPath, "main.ts"), 'import { linkedValue } from "linked-fixture";\\nexport const result = linkedValue;');

    const diagnostics = analyzeImportDiagnostics(location.rootPath, ["main.ts"]);
    expect(diagnostics.some((diagnostic) => diagnostic.moduleSpecifier === "linked-fixture")).toBe(false);
  });

  it("does not let TypeScript import diagnostics consume a symlinked dependency declaration", () => {
    createProject();
    const packageDirectory = join(location.rootPath, "node_modules", "unsafe-fixture");
    const outsideSource = join(temporaryDirectory, "outside.ts");
    const packageEntry = join(packageDirectory, "index.d.ts");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(location.rootPath, "main.ts"), 'import { value } from "unsafe-fixture";\nexport const result = value;');
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ types: "./index.d.ts" }));
    writeFileSync(outsideSource, "export declare const value: string;");
    symlinkSync(outsideSource, packageEntry, "file");

    const diagnostics = analyzeImportDiagnostics(location.rootPath, ["main.ts"]);
    expect(diagnostics.some((diagnostic) => diagnostic.moduleSpecifier === "unsafe-fixture")).toBe(true);
  });

  it("continues to support an explicitly external TypeScript extends target", () => {
    createProject();
    const externalConfig = join(temporaryDirectory, "outside-tsconfig.json");
    writeFileSync(externalConfig, JSON.stringify({ compilerOptions: { strict: true } }));
    writeFileSync(join(location.rootPath, "tsconfig.json"), JSON.stringify({ extends: externalConfig }));
    writeFileSync(join(location.rootPath, "main.ts"), "export function main() { return true; }");

    const summary = indexProject(location);
    expect(summary.added).toBe(1);
    expect(getIndexFreshness(location).status).toBe("current");
  });

  it("continues to support package-manager symlinks under node_modules", () => {
    createProject();
    const externalPackage = join(temporaryDirectory, "external-config-package");
    const packageDirectory = join(location.rootPath, "node_modules", "shared-config");
    mkdirSync(externalPackage, { recursive: true });
    mkdirSync(join(location.rootPath, "node_modules"), { recursive: true });
    writeFileSync(join(externalPackage, "package.json"), JSON.stringify({ tsconfig: "tsconfig.json" }));
    writeFileSync(join(externalPackage, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    symlinkSync(externalPackage, packageDirectory, "dir");
    writeFileSync(join(location.rootPath, "tsconfig.json"), JSON.stringify({ extends: "shared-config" }));
    writeFileSync(join(location.rootPath, "main.ts"), "export function main() { return true; }");

    const summary = indexProject(location);
    expect(summary.added).toBe(1);
    expect(getIndexFreshness(location).status).toBe("current");
  });

});
