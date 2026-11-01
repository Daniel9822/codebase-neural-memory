import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

export interface GitSnapshot {
  available: boolean;
  repositoryRoot: string | null;
  commit: string | null;
  branch: string | null;
  dirty: boolean | null;
  changedPathCount: number | null;
  statusHash: string | null;
}

function runGit(rootPath: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: rootPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trimEnd();
  } catch {
    return null;
  }
}

/** Read only the repository identity and working-tree state; never changes Git metadata. */
export function getGitSnapshot(rootPath: string): GitSnapshot {
  // Do not parse or realpath Git's --show-toplevel output: Git for Windows may
  // report MSYS paths (/c/...) while Node expects Win32 paths. --show-prefix
  // is path-format independent and is empty only when cwd is the repo root.
  const prefix = runGit(rootPath, ["rev-parse", "--show-prefix"]);
  if (prefix === null || prefix.length > 0) {
    return {
      available: false,
      repositoryRoot: null,
      commit: null,
      branch: null,
      dirty: null,
      changedPathCount: null,
      statusHash: null,
    };
  }

  let repositoryRoot: string;
  try {
    repositoryRoot = realpathSync(rootPath);
  } catch {
    return {
      available: false,
      repositoryRoot: null,
      commit: null,
      branch: null,
      dirty: null,
      changedPathCount: null,
      statusHash: null,
    };
  }

  const status = runGit(rootPath, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status === null) {
    return {
      available: false,
      repositoryRoot,
      commit: null,
      branch: null,
      dirty: null,
      changedPathCount: null,
      statusHash: null,
    };
  }

  return {
    available: true,
    repositoryRoot,
    commit: runGit(rootPath, ["rev-parse", "--verify", "HEAD"]) || null,
    branch: runGit(rootPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]) || null,
    dirty: status.length > 0,
    changedPathCount: status.length === 0 ? 0 : status.split("\n").filter(Boolean).length,
    statusHash: createHash("sha256").update(status).digest("hex"),
  };
}

export function sameGitSnapshot(left: GitSnapshot, right: GitSnapshot): boolean {
  return left.available === right.available &&
    left.repositoryRoot === right.repositoryRoot &&
    left.commit === right.commit &&
    left.branch === right.branch &&
    left.dirty === right.dirty &&
    left.changedPathCount === right.changedPathCount &&
    left.statusHash === right.statusHash;
}

export type GitCommitRelationship = "not-referenced" | "unavailable" | "unknown" | "current" | "ancestor" | "ahead" | "diverged";

function isAncestor(rootPath: string, candidate: string, descendant: string): boolean | null {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", candidate, descendant], {
      cwd: rootPath,
      stdio: "ignore",
      windowsHide: true,
    });
    return true;
  } catch (error) {
    const status = (error as { status?: number }).status;
    return status === 1 ? false : null;
  }
}

/** Compare a memory's recorded commit with the current checkout without changing Git state. */
export function compareGitCommits(
  rootPath: string,
  referenceCommit: string | null,
  currentCommit: string | null,
): GitCommitRelationship {
  if (referenceCommit === null) return "not-referenced";
  if (!currentCommit) return "unavailable";
  if (!/^[0-9a-f]{7,64}$/i.test(referenceCommit)) return "unknown";

  const resolvedReference = runGit(rootPath, ["rev-parse", "--verify", referenceCommit + "^{commit}"]);
  if (!resolvedReference) return "unknown";
  if (resolvedReference === currentCommit) return "current";

  const referenceIsAncestor = isAncestor(rootPath, resolvedReference, currentCommit);
  if (referenceIsAncestor === true) return "ancestor";
  const currentIsAncestor = isAncestor(rootPath, currentCommit, resolvedReference);
  if (currentIsAncestor === true) return "ahead";
  if (referenceIsAncestor === false && currentIsAncestor === false) return "diverged";
  return "unknown";
}
