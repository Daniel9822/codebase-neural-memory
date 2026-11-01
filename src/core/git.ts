import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const execFileAsync = promisify(execFile);

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


export interface GitBlameLine {
  line: number;
  originalLine: number;
  commit: string;
  author: string | null;
  authoredAt: string | null;
  summary: string | null;
  content: string;
}

export interface GitBlameResult {
  path: string;
  startLine: number;
  endLine: number;
  lines: GitBlameLine[];
  truncated: boolean;
}

/** Return bounded line-level attribution without blocking the MCP event loop. */
export async function getGitBlame(
  rootPath: string,
  filePath: string,
  startLine = 1,
  endLine = startLine + 99,
): Promise<GitBlameResult> {
  if (!Number.isSafeInteger(startLine) || startLine < 1 ||
      !Number.isSafeInteger(endLine) || endLine < startLine) {
    throw new Error("Git blame line range must contain positive, ordered safe integers.");
  }
  const requestedLines = endLine - startLine + 1;
  if (requestedLines > 200) throw new Error("Git blame range cannot exceed 200 lines.");

  const normalized = filePath.replaceAll("\\", "/");
  if (!normalized || normalized.length > 500 || normalized.startsWith("/") ||
      /^[a-zA-Z]:/.test(normalized) ||
      normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Git blame path must be a normalized project-relative file path.");
  }
  const absolutePath = resolve(rootPath, ...normalized.split("/"));
  const relativePath = relative(resolve(rootPath), absolutePath);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error("Git blame path must stay inside the project root.");
  }

  let output: string;
  try {
    // One subprocess only: do not collect a full Git snapshot (status, branch,
    // HEAD) just to answer a line-attribution query. Async execution keeps the
    // MCP event loop responsive; timeout and maxBuffer bound worst-case work.
    const result = await execFileAsync("git", [
      "--literal-pathspecs", "blame", "--line-porcelain", "--root", "--no-show-signature",
      "-L", `${startLine},${endLine}`, "--", normalized,
    ], {
      cwd: rootPath,
      encoding: "utf8",
      windowsHide: true,
      timeout: 2_500,
      maxBuffer: 2 * 1024 * 1024,
    });
    output = result.stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/not a git repository/i.test(detail)) {
      throw new Error("Git blame is unavailable because the project root is not a Git repository.");
    }
    throw new Error("Git blame failed or exceeded its 2.5-second execution budget; verify that the file is tracked and the requested line range exists.");
  }

  const records = output.split(/\r?\n/);
  const lines: GitBlameLine[] = [];
  for (let index = 0; index < records.length;) {
    const header = /^\^?([0-9a-f]{40,64}) (\d+) (\d+)(?: (\d+))?$/.exec(records[index] ?? "");
    if (!header) { index += 1; continue; }
    const commit = header[1]!;
    const originalLine = Number(header[2]);
    const finalLine = Number(header[3]);
    index += 1;
    let author: string | null = null;
    let authoredAt: string | null = null;
    let summary: string | null = null;
    let content = "";
    while (index < records.length) {
      const record = records[index++]!;
      if (record.startsWith("\t")) {
        content = record.slice(1);
        break;
      }
      if (record.startsWith("author ")) author = record.slice(7);
      else if (record.startsWith("author-time ")) {
        const timestamp = Number(record.slice(12));
        if (Number.isSafeInteger(timestamp) && timestamp > 0) authoredAt = new Date(timestamp * 1000).toISOString();
      } else if (record.startsWith("summary ")) summary = record.slice(8);
    }
    lines.push({ line: finalLine, originalLine, commit, author, authoredAt, summary, content });
  }
  if (lines.length === 0) throw new Error("Git blame returned no line attribution for the requested range.");
  return {
    path: normalized,
    startLine,
    endLine,
    lines,
    truncated: lines.length < requestedLines,
  };
}
