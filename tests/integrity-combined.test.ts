import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureProject, openDatabase, type MemoryDatabase } from "../src/storage/database.js";
import type { ProjectLocation } from "../src/core/project.js";
import { getIndexFreshness, indexProject, indexWithDatabase, updateProjectIndex } from "../src/core/indexer.js";

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
  it("reports a symlinked package manifest encountered while resolving an extended config", () => {
    createProject();
    const packageDirectory = join(location.rootPath, "node_modules", "shared-config");
    const outsideManifest = join(temporaryDirectory, "outside-package.json");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(location.rootPath, "tsconfig.json"), JSON.stringify({ extends: "shared-config" }));
    writeFileSync(join(packageDirectory, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    writeFileSync(outsideManifest, JSON.stringify({ tsconfig: "tsconfig.json" }));
    symlinkSync(outsideManifest, join(packageDirectory, "package.json"), "file");
    writeFileSync(join(location.rootPath, "main.ts"), "export const value = true;");

    indexWithDatabase(database!, location);

    const freshness = getIndexFreshness(location);
    expect(freshness.status).toBe("incomplete");
    expect(freshness.errors.some((error) => error.includes("node_modules/shared-config/package.json"))).toBe(true);
  });

  it("refuses a full index when relation configuration is malformed instead of committing an incomplete graph", () => {
    createProject();
    writeFileSync(join(location.rootPath, "tsconfig.json"), '{"compilerOptions": {');
    writeFileSync(join(location.rootPath, "main.ts"), "export const value = true;");

    expect(() => indexProject(location)).toThrow(/relation configuration is incomplete/i);
    expect(database!.prepare("SELECT path FROM files").all()).toEqual([]);
    expect(database!.prepare("SELECT COUNT(*) AS count FROM relations").get()).toEqual({ count: 0 });
  });

  it("rejects a project-local extends path whose parent directory is a symlink", () => {
    createProject();
    const linkedConfigDirectory = join(location.rootPath, "configs");
    const outsideConfigDirectory = join(temporaryDirectory, "outside-configs");
    mkdirSync(outsideConfigDirectory, { recursive: true });
    writeFileSync(join(outsideConfigDirectory, "base.json"), JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["outside/*"] } },
    }));
    symlinkSync(outsideConfigDirectory, linkedConfigDirectory, "dir");
    writeFileSync(join(location.rootPath, "tsconfig.json"), JSON.stringify({ extends: "./configs/base.json" }));
    writeFileSync(join(location.rootPath, "main.ts"), "export function main() { return true; }");

    indexWithDatabase(database!, location);

    const freshness = getIndexFreshness(location);
    expect(freshness.status).toBe("incomplete");
    expect(freshness.errors.some((error) => error.includes("configs/base.json"))).toBe(true);
    expect(() => indexProject(location)).toThrow(/relation configuration is incomplete/i);
  });

});
