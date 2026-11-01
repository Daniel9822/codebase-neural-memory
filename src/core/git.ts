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
  // Keep the root check path-format independent on Windows. Porcelain v2
  // includes both HEAD and branch metadata, avoiding separate subprocesses
  // for rev-parse HEAD and symbolic-ref on every freshness/index operation.
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

  const porcelain = runGit(rootPath, ["status", "--porcelain=v2", "--branch", "--untracked-files=all"]);
  if (porcelain === null) {
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

  const records = porcelain.split("\n");
  const statusRecords: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const line = records[index] ?? "";
    if (!line || line.startsWith("#")) continue;
    statusRecords.push(line);
    // Porcelain v2 rename/copy records carry the original path on the next line.
    if (line.startsWith("2 ")) index += 1;
  }
  const branchHead = records.find((line) => line.startsWith("# branch.head "))?.slice("# branch.head ".length);
  const branchOid = records.find((line) => line.startsWith("# branch.oid "))?.slice("# branch.oid ".length);
  return {
    available: true,
    repositoryRoot,
    commit: branchOid && /^[0-9a-f]{40,64}$/i.test(branchOid) ? branchOid : null,
    branch: branchHead && branchHead !== "(detached)" ? branchHead : null,
    dirty: statusRecords.length > 0,
    changedPathCount: statusRecords.length,
    statusHash: createHash("sha256").update(statusRecords.join("\n")).digest("hex"),
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


export interface GitHistoryEntry {
  commit: string;
  authoredAt: string;
  author: string;
  subject: string;
  files: Array<{ status: string; path: string; previousPath?: string }>;
}

export interface GitHistoryResult {
  commits: GitHistoryEntry[];
  truncated: boolean;
  truncatedPaths: boolean;
}

/**
 * Return bounded commit and changed-path evidence. Commit boundaries are not
 * developer sessions, and commit subjects are not proof of intent.
 */
export async function getGitHistory(
  rootPath: string,
  limit = 20,
  maxPaths = 200,
): Promise<GitHistoryResult> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("Git history limit must be between 1 and 50 commits.");
  }
  if (!Number.isSafeInteger(maxPaths) || maxPaths < 1 || maxPaths > 500) {
    throw new Error("Git history maxPaths must be between 1 and 500 paths.");
  }

  let output: string;
  try {
    const result = await execFileAsync("git", [
      "log", "--no-show-signature", "--no-decorate", "--date=iso-strict",
      `--format=%x1e%H%x1f%aI%x1f%an%x1f%s`,
      "-z", "--name-status", "-n", String(limit + 1),
    ], {
      cwd: rootPath,
      encoding: "utf8",
      windowsHide: true,
      timeout: 3_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    output = result.stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/not a git repository/i.test(detail)) {
      throw new Error("Git history is unavailable because the project root is not a Git repository.");
    }
    throw new Error("Git history failed or exceeded its 3-second execution budget; narrow the request or verify repository availability.");
  }

  const tokens = output.split("\0");
  const commits: GitHistoryEntry[] = [];
  let current: GitHistoryEntry | null = null;
  let totalPaths = 0;
  let truncatedPaths = false;
  for (let index = 0; index < tokens.length;) {
    let token = tokens[index++] ?? "";
    const marker = token.indexOf("\x1e");
    if (marker >= 0) {
      if (current) commits.push(current);
      const metadata = token.slice(marker + 1).replace(/^\r?\n/, "");
      const [commit, authoredAt, author, ...subjectParts] = metadata.split("\x1f");
      if (!commit || !/^[0-9a-f]{40,64}$/i.test(commit) || !authoredAt || !author) {
        current = null;
        continue;
      }
      current = {
        commit,
        authoredAt,
        author,
        subject: subjectParts.join("\x1f"),
        files: [],
      };
      continue;
    }
    if (!current || !token) continue;
    const status = token.replace(/^\r?\n/, "");
    if (!/^(?:A|M|D|T|U|X|B|R\d{1,3}|C\d{1,3})$/.test(status)) continue;
    const path = tokens[index++] ?? "";
    let previousPath: string | undefined;
    if (/^[RC]/.test(status)) previousPath = tokens[index++] ?? "";
    if (totalPaths >= maxPaths) {
      truncatedPaths = true;
      continue;
    }
    current.files.push({ status, path, ...(previousPath ? { previousPath } : {}) });
    totalPaths += 1;
  }
  if (current) commits.push(current);
  const truncated = commits.length > limit;
  return {
    commits: commits.slice(0, limit),
    truncated,
    truncatedPaths,
  };
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
