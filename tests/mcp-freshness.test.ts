import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  it("refuses strict results when a separate database connection advances the index during the read", () => {
    createProject();
    const beforeRevision = (database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision;
    const secondHandlerDatabase = openDatabase(location);
    try {
      const response = readResponse(location, { strictFreshness: true }, () => {
        indexWithDatabase(secondHandlerDatabase, location, true);
        return { result: "must not span two index revisions" };
      });

      expect(response.isError).toBe(true);
      const refusal = JSON.parse(response.content[0]!.text) as {
        status: string;
        readSnapshot: { preflightRevision: number; postReadRevision: number | null; revisionChanged: boolean };
      };
      expect(refusal.status).toBe("refused");
      expect(refusal.readSnapshot.preflightRevision).toBe(beforeRevision);
      expect(refusal.readSnapshot.postReadRevision).toBeGreaterThan(beforeRevision);
      expect(refusal.readSnapshot.revisionChanged).toBe(true);
      expect(response.content[0]!.text).not.toContain("must not span two index revisions");
    } finally {
      secondHandlerDatabase.close();
    }
  });

  it("refuses a strict read when discovery becomes incomplete during the operation", () => {
    createProject();
    const sourceDirectory = join(location.rootPath, "src");
    const savedDirectory = join(temporaryDirectory, "saved-src");
    const outsideDirectory = join(temporaryDirectory, "outside-src");
    mkdirSync(sourceDirectory, { recursive: true });
    writeFileSync(join(sourceDirectory, "nested.ts"), "export const nested = true;");
    indexWithDatabase(database!, location);

    const response = readResponse(location, { strictFreshness: true }, () => {
      renameSync(sourceDirectory, savedDirectory);
      mkdirSync(outsideDirectory, { recursive: true });
      writeFileSync(join(outsideDirectory, "outside.ts"), "export const outside = true;");
      symlinkSync(outsideDirectory, sourceDirectory, "dir");
      return { result: "must not be served after discovery becomes incomplete" };
    });

    expect(response.isError).toBe(true);
    const refusal = JSON.parse(response.content[0]!.text) as {
      status: string;
      staleness: { status: string };
    };
    expect(refusal.status).toBe("refused");
    expect(refusal.staleness.status).toBe("incomplete");
    expect(response.content[0]!.text).not.toContain("must not be served after discovery becomes incomplete");
  });

  it("refuses strict results when an independent Node process advances the index during the read", () => {
    createProject();
    const beforeRevision = (database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision;
    const writerScript = `
      import Database from "better-sqlite3";
      const db = new Database(${JSON.stringify(location.databasePath)});
      try {
        db.prepare("UPDATE projects SET index_revision = index_revision + 1 WHERE id = ?").run(${JSON.stringify(location.id)});
      } finally {
        db.close();
      }
    `;

    const response = readResponse(location, { strictFreshness: true }, () => {
      const writer = spawnSync(process.execPath, ["--input-type=module", "-e", writerScript], {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(writer.error).toBeUndefined();
      expect(writer.status, writer.stderr).toBe(0);
      return { result: "must not span independent process revisions" };
    });

    expect(response.isError).toBe(true);
    const refusal = JSON.parse(response.content[0]!.text) as {
      status: string;
      readSnapshot: { preflightRevision: number; postReadRevision: number | null; revisionChanged: boolean };
    };
    expect(refusal.status).toBe("refused");
    expect(refusal.readSnapshot.preflightRevision).toBe(beforeRevision);
    expect(refusal.readSnapshot.postReadRevision).toBe(beforeRevision + 1);
    expect(refusal.readSnapshot.revisionChanged).toBe(true);
    expect(response.content[0]!.text).not.toContain("must not span independent process revisions");
  });

  it("surfaces cross-process writer contention and recovers after the lock is released", () => {
    createProject();
    const beforeRevision = (database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision;
    const writerScript = `
      import Database from "better-sqlite3";
      const db = new Database(${JSON.stringify(location.databasePath)});
      db.pragma("busy_timeout = 100");
      try {
        db.prepare("UPDATE projects SET index_revision = index_revision + 1 WHERE id = ?").run(${JSON.stringify(location.id)});
      } catch (error) {
        console.error(error.code ?? error.message);
        process.exitCode = 2;
      } finally {
        db.close();
      }
    `;

    database!.exec("BEGIN IMMEDIATE");
    let blockedWriter;
    try {
      blockedWriter = spawnSync(process.execPath, ["--input-type=module", "-e", writerScript], {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 15_000,
      });
    } finally {
      database!.exec("ROLLBACK");
    }

    expect(blockedWriter!.error).toBeUndefined();
    expect(blockedWriter!.status).toBe(2);
    expect(blockedWriter!.stderr).toContain("SQLITE_BUSY");
    const afterBlockedWriter = (database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision;
    expect(afterBlockedWriter).toBe(beforeRevision);

    const recoveryScript = writerScript.replace("busy_timeout = 100", "busy_timeout = 5_000");
    const recoveredWriter = spawnSync(process.execPath, ["--input-type=module", "-e", recoveryScript], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(recoveredWriter.error).toBeUndefined();
    expect(recoveredWriter.status, recoveredWriter.stderr).toBe(0);
    const afterRecovery = (database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision;
    expect(afterRecovery).toBe(beforeRevision + 1);
  });

});
