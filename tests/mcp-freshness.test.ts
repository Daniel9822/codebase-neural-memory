import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectLocation } from "../src/core/project.js";
import { indexWithDatabase } from "../src/core/indexer.js";
import { ensureProject, openDatabase, type MemoryDatabase } from "../src/storage/database.js";
import { readResponse } from "../src/adapters/mcp/server.js";

let temporaryDirectory = "";
let database: MemoryDatabase | undefined;
let location: ProjectLocation;

function createProject(): void {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "cnm-read-freshness-test-"));
  const rootPath = join(temporaryDirectory, "repository");
  mkdirSync(rootPath, { recursive: true });
  location = {
    id: "read-freshness-test-project",
    rootPath,
    dataDirectory: join(temporaryDirectory, "data"),
    databasePath: join(temporaryDirectory, "data", "memory.sqlite"),
  };
  database = openDatabase(location);
  ensureProject(database, location);
  writeFileSync(join(rootPath, "helper.ts"), "export function helper() { return true; }\n");
  indexWithDatabase(database, location);
}

afterEach(() => {
  database?.close();
  database = undefined;
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = "";
});

describe("post-read freshness validation", () => {
  it("refuses strict results when source changes during the operation", () => {
    createProject();
    const beforeRevision = (database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision;

    const response = readResponse(location, { strictFreshness: true }, () => {
      writeFileSync(join(location.rootPath, "helper.ts"), "export function changedDuringRead() { return false; }\n");
      return { result: "must not be served as current" };
    });

    expect(response.isError).toBe(true);
    const refusal = JSON.parse(response.content[0]!.text) as {
      status: string;
      readSnapshot: { preflightRevision: number; postReadRevision: number | null; failureReason: string | null };
    };
    expect(refusal.status).toBe("refused");
    expect(refusal.readSnapshot.preflightRevision).toBe(beforeRevision);
    expect(refusal.readSnapshot.postReadRevision).toBe(beforeRevision);
    expect(refusal.readSnapshot.failureReason).toBeNull();
    expect(response.content[0]!.text).not.toContain("must not be served as current");
  });

  it("warns in non-strict mode when source changes during the operation", () => {
    createProject();
    const response = readResponse(location, {}, () => {
      writeFileSync(join(location.rootPath, "helper.ts"), "export function changedDuringRead() { return false; }\n");
      return { result: "returned with warning" };
    });

    expect(response.isError).toBeUndefined();
    expect(response.content[0]!.text).toContain("returned with warning");
    expect(response.content.some((item) => item.text.includes("CNM POST-READ FRESHNESS WARNING"))).toBe(true);
  });
});
