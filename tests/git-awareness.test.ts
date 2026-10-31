import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGitSnapshot } from "../src/core/git.js";
import { inspectMemoryFreshness, remember } from "../src/core/memories.js";
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

  it("compares memory commit references with HEAD ancestry without changing memory lifecycle", () => {
    createProject();
    const initial = getGitSnapshot(location.rootPath);
    const initialBranch = initial.branch;
    expect(initial.commit).not.toBeNull();
    expect(initialBranch).toBeTruthy();
    const originalMemory = remember(location, "Original source decision", "Review when its source revision advances.", "decision", "tracked.ts", initial.commit ?? undefined);
    expect(inspectMemoryFreshness(location)).toMatchObject([{
      id: originalMemory, commitStatus: "current", commitRequiresReview: false, requiresReview: false,
    }]);

    execFileSync("git", ["commit", "--allow-empty", "-m", "advance main"], { cwd: location.rootPath, stdio: "ignore" });
    expect(inspectMemoryFreshness(location)).toMatchObject([{
      id: originalMemory, status: "current", commitStatus: "ancestor", commitRequiresReview: true, requiresReview: true,
    }]);

    execFileSync("git", ["switch", "-c", "memory-provenance-side"], { cwd: location.rootPath, stdio: "ignore" });
    execFileSync("git", ["commit", "--allow-empty", "-m", "side revision"], { cwd: location.rootPath, stdio: "ignore" });
    const sideCommit = getGitSnapshot(location.rootPath).commit;
    expect(sideCommit).not.toBeNull();
    const sideMemory = remember(location, "Side branch decision", "This note references a side-branch commit.", "decision", undefined, sideCommit ?? undefined);
    execFileSync("git", ["switch", initialBranch!], { cwd: location.rootPath, stdio: "ignore" });
    expect(inspectMemoryFreshness(location).find((item) => item.id === sideMemory)).toMatchObject({
      status: "not-linked", commitStatus: "ahead", commitRequiresReview: true, requiresReview: true,
    });

    execFileSync("git", ["commit", "--allow-empty", "-m", "diverge main"], { cwd: location.rootPath, stdio: "ignore" });
    expect(inspectMemoryFreshness(location).find((item) => item.id === sideMemory)).toMatchObject({
      status: "not-linked", commitStatus: "diverged", commitRequiresReview: true, requiresReview: true,
    });
    expect(inspectMemoryFreshness(location).find((item) => item.id === originalMemory)).toMatchObject({
      commitStatus: "ancestor", requiresReview: true,
    });
  });

  it("marks an unavailable or invalid memory commit reference for review", () => {
    createProject(false);
    writeFileSync(join(location.rootPath, "plain.ts"), "export const plain = true;");
    const id = remember(location, "Unresolvable source revision", "Review this commit reference.", "decision", "plain.ts", "not-a-commit");
    expect(inspectMemoryFreshness(location)).toMatchObject([{
      id, status: "current", commitStatus: "unavailable", commitRequiresReview: true, requiresReview: true,
    }]);
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

  it("converges incremental reconciliation and forced reindex after rename, deletion, and branch changes", () => {
    createProject();
    writeFileSync(join(location.rootPath, "tracked.ts"), 'import { helper } from "./helper";\nexport const tracked = helper;\n');
    writeFileSync(join(location.rootPath, "helper.ts"), "export const helper = 1;\n");
    writeFileSync(join(location.rootPath, "temporary.ts"), "export const temporary = true;\n");
    execFileSync("git", ["add", "-A"], { cwd: location.rootPath });
    execFileSync("git", ["commit", "-m", "add indexed source graph"], { cwd: location.rootPath, stdio: "ignore" });
    indexWithDatabase(database!, location);

    execFileSync("git", ["mv", "helper.ts", "renamed.ts"], { cwd: location.rootPath });
    writeFileSync(join(location.rootPath, "tracked.ts"), 'import { helper } from "./renamed";\nexport const tracked = helper + 1;\n');
    rmSync(join(location.rootPath, "temporary.ts"));
    execFileSync("git", ["add", "-A"], { cwd: location.rootPath });
    execFileSync("git", ["commit", "-m", "rename and delete indexed source"], { cwd: location.rootPath, stdio: "ignore" });
    indexWithDatabase(database!, location);

    const logicalSnapshot = () => ({
      files: database!.prepare("SELECT path, stable_id, content_hash FROM files ORDER BY path").all(),
      symbols: database!.prepare("SELECT f.path, s.stable_id, s.name, s.kind, s.signature, s.start_line, s.end_line, s.exported FROM symbols s JOIN files f ON f.id = s.file_id ORDER BY f.path, s.name").all(),
      imports: database!.prepare("SELECT f.path, i.module_specifier FROM file_imports i JOIN files f ON f.id = i.file_id ORDER BY f.path, i.module_specifier").all(),
      calls: database!.prepare("SELECT f.path, c.caller_name, c.callee_name, c.module_specifier, c.imported_symbol_name FROM symbol_calls c JOIN files f ON f.id = c.file_id ORDER BY f.path, c.caller_name, c.callee_name").all(),
      heritage: database!.prepare("SELECT f.path, h.owner_name, h.relation_kind, h.target_name, h.module_specifier, h.imported_name FROM symbol_heritage h JOIN files f ON f.id = h.file_id ORDER BY f.path, h.owner_name, h.relation_kind, h.target_name").all(),
      relations: database!.prepare("SELECT r.source_kind, CASE r.source_kind WHEN 'file' THEN (SELECT stable_id FROM files WHERE id = r.source_id) ELSE (SELECT stable_id FROM symbols WHERE id = r.source_id) END AS source_stable_id, r.target_kind, CASE r.target_kind WHEN 'file' THEN (SELECT stable_id FROM files WHERE id = r.target_id) ELSE (SELECT stable_id FROM symbols WHERE id = r.target_id) END AS target_stable_id, r.kind, r.confidence, r.provenance FROM relations r ORDER BY r.kind, source_stable_id, target_stable_id").all(),
      unresolved: database!.prepare("SELECT f.path, u.module_specifier, u.status, u.candidates_json FROM unresolved_imports u JOIN files f ON f.id = u.source_file_id ORDER BY f.path, u.module_specifier").all(),
      fts: database!.prepare("SELECT name, signature, file_path, kind FROM symbols_fts ORDER BY file_path, name, signature").all(),
    });
    const afterIncremental = logicalSnapshot();
    indexWithDatabase(database!, location, true);
    expect(logicalSnapshot()).toEqual(afterIncremental);

    const originalBranch = getGitSnapshot(location.rootPath).branch;
    expect(originalBranch).toBeTruthy();
    execFileSync("git", ["switch", "-c", "phase7-alternate"], { cwd: location.rootPath, stdio: "ignore" });
    writeFileSync(join(location.rootPath, "alternate.ts"), "export const alternate = true;\n");
    execFileSync("git", ["add", "-A"], { cwd: location.rootPath });
    execFileSync("git", ["commit", "-m", "alternate branch source"], { cwd: location.rootPath, stdio: "ignore" });
    execFileSync("git", ["switch", originalBranch!], { cwd: location.rootPath, stdio: "ignore" });
    indexWithDatabase(database!, location);
    const afterBranchReconciliation = logicalSnapshot();
    indexWithDatabase(database!, location, true);
    expect(logicalSnapshot()).toEqual(afterBranchReconciliation);
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
