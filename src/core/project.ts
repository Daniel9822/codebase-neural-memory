import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ProjectLocation {
  id: string;
  rootPath: string;
  dataDirectory: string;
  databasePath: string;
}

export function resolveProjectRoot(startDirectory = process.cwd()): string {
  const start = resolve(startDirectory);
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: start,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    if (root) return realpathSync(root);
  } catch {
    // A repository without Git metadata is still a valid project.
  }

  let current = start;
  while (true) {
    if (existsSync(join(current, ".git"))) return realpathSync(current);
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return realpathSync(start);
}

export function getApplicationDataDirectory(): string {
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "CodebaseNeuralMemory");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "CodebaseNeuralMemory");
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "codebase-neural-memory");
}

export function getProjectLocation(rootPath: string): ProjectLocation {
  const canonicalRoot = realpathSync(rootPath);
  const id = createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 20);
  const dataDirectory = join(getApplicationDataDirectory(), "projects", id);
  return {
    id,
    rootPath: canonicalRoot,
    dataDirectory,
    databasePath: join(dataDirectory, "memory.sqlite"),
  };
}
