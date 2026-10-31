import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGitSnapshot } from "../src/core/git.js";
import { getIndexFreshness, indexWithDatabase } from "../src/core/indexer.js";
import type { ProjectLocation } from "../src/core/project.js";
import { ensureProject, openDatabase, type MemoryDatabase } from "../src/storage/database.js";

let temporaryDirectory = "";
let database: MemoryDatabase | undefined;
let location: ProjectLocation;

function createProject(withGit = true): void {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "cnm-git-awareness-"));
  const rootPath = join(temporaryDirectory, "repository");
  mkdirSync(rootPath, { recursive: true });
  location = {
    id: "git-awareness-test-project",
    rootPath,
    dataDirectory: join(temporaryDirectory, "data"),
    databasePath: join(temporaryDirectory, "data", "memory.sqlite"),
  };
  if (withGit) {
    execFileSync("git", ["init"], { cwd: rootPath, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "cnm-tests@example.invalid"], { cwd: rootPath });
    execFileSync("git", ["config", "user.name", "CNM Tests"], { cwd: rootPath });
    writeFileSync(join(rootPath, "tracked.ts"), "export const tracked = 1;\n");
    execFileSync("git", ["add", "tracked.ts"], { cwd: rootPath });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: rootPath, stdio: "ignore" });
  }
  database = openDatabase(location);
  ensureProject(database, location);
}

afterEach(() => {
  database?.close();
  database = undefined;
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = "";
});

describe("Git-aware indexing and freshness", () => {
  it("records the commit, branch, and clean working-tree snapshot used by the index", () => {
    createProject();
    const before = getGitSnapshot(location.rootPath);
    expect(before.available).toBe(true);
    expect(before.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(before.branch).toBeTruthy();
    expect(before.dirty).toBe(false);

    indexWithDatabase(database!, location);

    const stored = database!.prepare(
      "SELECT indexed_commit, indexed_branch, indexed_worktree_dirty, indexed_worktree_status_hash, indexed_worktree_changed_paths FROM projects WHERE id = ?",
    ).get(location.id) as {
      indexed_commit: string;
      indexed_branch: string;
      indexed_worktree_dirty: number;
      indexed_worktree_status_hash: string;
      indexed_worktree_changed_paths: number;
    };
    expect(stored).toMatchObject({
      indexed_commit: before.commit,
      indexed_branch: before.branch,
      indexed_worktree_dirty: 0,
      indexed_worktree_status_hash: before.statusHash,
      indexed_worktree_changed_paths: 0,
    });
    expect(getIndexFreshness(location)).toMatchObject({
      status: "current",
      git: { status: "current", commitChanged: false, branchChanged: false, workingTreeChanged: false },
    });
  });

  it("detects uncommitted edits, then converges after indexing the edited tree", () => {
    createProject();
    indexWithDatabase(database!, location);

    writeFileSync(join(location.rootPath, "tracked.ts"), "export const tracked = 2;\n");
    expect(getIndexFreshness(location)).toMatchObject({
      status: "stale",
      changedFiles: 1,
      git: { status: "changed", workingTreeChanged: true, currentDirty: true },
    });

    indexWithDatabase(database!, location);
    expect(getIndexFreshness(location)).toMatchObject({
      status: "current",
      changedFiles: 0,
      git: { status: "current", workingTreeChanged: false, currentDirty: true },
    });
  });

  it("detects a new commit and a branch switch even when source file hashes are unchanged", () => {
    createProject();
    indexWithDatabase(database!, location);
    const indexed = getGitSnapshot(location.rootPath);

    execFileSync("git", ["commit", "--allow-empty", "-m", "metadata-only revision"], { cwd: location.rootPath, stdio: "ignore" });
    expect(getIndexFreshness(location)).toMatchObject({
      status: "stale",
      addedFiles: 0,
      changedFiles: 0,
      deletedFiles: 0,
      git: { status: "changed", commitChanged: true, branchChanged: false, workingTreeChanged: false },
    });

    indexWithDatabase(database!, location);
    execFileSync("git", ["switch", "-c", "phase7-check"], { cwd: location.rootPath, stdio: "ignore" });
    expect(getIndexFreshness(location)).toMatchObject({
      status: "stale",
      git: { status: "changed", commitChanged: false, branchChanged: true },
    });

    expect(indexed.commit).not.toBeNull();
  });

  it("reconciles a Git rename as one added path and one deleted path", () => {
    createProject();
    indexWithDatabase(database!, location);

    execFileSync("git", ["mv", "tracked.ts", "renamed.ts"], { cwd: location.rootPath });
    expect(getIndexFreshness(location)).toMatchObject({
      status: "stale",
      addedFiles: 1,
      deletedFiles: 1,
    });

    indexWithDatabase(database!, location);
    expect(database!.prepare("SELECT path FROM files ORDER BY path").all()).toEqual([{ path: "renamed.ts" }]);
    expect(getIndexFreshness(location).status).toBe("current");
  });

  it("keeps non-Git folders usable and reports Git metadata as unavailable", () => {
    createProject(false);
    writeFileSync(join(location.rootPath, "plain.ts"), "export const plain = true;\n");
    indexWithDatabase(database!, location);

    expect(getGitSnapshot(location.rootPath).available).toBe(false);
    expect(getIndexFreshness(location)).toMatchObject({
      status: "current",
      git: { status: "unavailable", currentCommit: null, currentBranch: null },
    });
  });

  it("applies migration v10 for Git worktree metadata columns", () => {
    createProject(false);
    const columns = database!.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    expect(names.has("indexed_branch")).toBe(true);
    expect(names.has("indexed_worktree_dirty")).toBe(true);
    expect(names.has("indexed_worktree_status_hash")).toBe(true);
    expect(names.has("indexed_worktree_changed_paths")).toBe(true);
    expect(database!.prepare("SELECT version FROM schema_migrations WHERE version = 10").get()).toEqual({ version: 10 });
  });
});
