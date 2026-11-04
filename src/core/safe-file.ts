import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface SafeFileRead {
  canonicalPath: string;
  stat: Stats;
  content: Buffer;
}

export interface SafeFileReadOptions {
  maxBytes?: number;
  canonicalRoot?: string;
  rejectFinalSymlink?: boolean;
  rejectHardLinks?: boolean;
}

function assertWithinRoot(root: string, target: string): void {
  const pathFromRoot = relative(root, target);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(".." + sep) || isAbsolute(pathFromRoot)) {
    throw new Error("File path resolves outside the project root.");
  }
}

/** Compare a by-handle stat against a by-path stat for identity.
 * On Windows, stat-by-path and fstat-by-handle report different st_dev values
 * for the same file (0 vs the volume serial number), so identity there is
 * judged by the file index alone; st_ino still detects replacement. */
export function sameFileIdentity(fdStats: Stats, pathStats: Stats): boolean {
  if (process.platform === "win32") return fdStats.ino === pathStats.ino;
  return fdStats.dev === pathStats.dev && fdStats.ino === pathStats.ino;
}

export function readFileWithinRoot(rootPath: string, candidatePath: string, options: SafeFileReadOptions = {}): SafeFileRead {
  const canonicalRoot = options.canonicalRoot ?? realpathSync(rootPath);
  const absolutePath = resolve(candidatePath);
  assertWithinRoot(canonicalRoot, absolutePath);
  if (options.rejectFinalSymlink && lstatSync(absolutePath).isSymbolicLink()) {
    throw new Error("Symlink file paths are not allowed.");
  }
  const beforeOpenPath = realpathSync(absolutePath);
  assertWithinRoot(canonicalRoot, beforeOpenPath);
  const descriptor = openSync(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const openedStat = fstatSync(descriptor);
    if (!openedStat.isFile()) throw new Error("Path must reference a regular file.");
    if (options.rejectHardLinks && openedStat.nlink > 1) {
      throw new Error("Hard-linked file paths are not allowed.");
    }
    if (options.maxBytes !== undefined && openedStat.size > options.maxBytes) {
      throw new Error(`File exceeds the ${options.maxBytes}-byte read limit.`);
    }
    const afterOpenPath = realpathSync(absolutePath);
    assertWithinRoot(canonicalRoot, afterOpenPath);
    const pathStat = statSync(afterOpenPath);
    if (!sameFileIdentity(openedStat, pathStat)) {
      throw new Error("File changed during safe open; retry the read.");
    }
    const content = readFileSync(descriptor);
    const afterReadStat = fstatSync(descriptor);
    if (afterReadStat.dev !== openedStat.dev || afterReadStat.ino !== openedStat.ino ||
        afterReadStat.size !== openedStat.size || afterReadStat.mtimeMs !== openedStat.mtimeMs) {
      throw new Error("File changed while being read; retry the read.");
    }
    const afterReadPath = realpathSync(absolutePath);
    assertWithinRoot(canonicalRoot, afterReadPath);
    if (options.rejectFinalSymlink && lstatSync(absolutePath).isSymbolicLink()) {
      throw new Error("Symlink file paths are not allowed.");
    }
    const finalPathStat = statSync(afterReadPath);
    if (!sameFileIdentity(afterReadStat, finalPathStat)) {
      throw new Error("File path changed during read; retry the read.");
    }
    return { canonicalPath: afterReadPath, stat: afterReadStat, content };
  } finally {
    closeSync(descriptor);
  }
}
