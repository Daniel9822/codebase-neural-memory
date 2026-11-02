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
    if (openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
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
    if (afterReadStat.dev !== finalPathStat.dev || afterReadStat.ino !== finalPathStat.ino) {
      throw new Error("File path changed during read; retry the read.");
    }
    return { canonicalPath: afterReadPath, stat: afterReadStat, content };
  } finally {
    closeSync(descriptor);
  }
}
