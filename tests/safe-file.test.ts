import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverFiles } from "../src/core/indexer.js";
import { readFileWithinRoot } from "../src/core/safe-file.js";

let temporaryDirectory = "";

afterEach(() => {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = "";
});

describe("safe project file reads", () => {
  it("reads regular files through a verified descriptor", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "cnm-safe-read-test-"));
    const root = join(temporaryDirectory, "repository");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "source.ts"), "export const safe = true;\\n");

    const result = readFileWithinRoot(root, join(root, "source.ts"));
    expect(result.content.toString("utf8")).toBe("export const safe = true;\\n");
    expect(result.stat.isFile()).toBe(true);
  });

  it("rejects a file symlink that resolves outside the project root", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "cnm-safe-read-test-"));
    const root = join(temporaryDirectory, "repository");
    const outside = join(temporaryDirectory, "outside.ts");
    mkdirSync(root, { recursive: true });
    writeFileSync(outside, "export const outside = true;\\n");
    symlinkSync(outside, join(root, "source.ts"));

    expect(() => readFileWithinRoot(root, join(root, "source.ts"))).toThrow(/outside the project root/i);
  });

  it("rejects directories instead of reading them as files", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "cnm-safe-read-test-"));
    const root = join(temporaryDirectory, "repository");
    mkdirSync(join(root, "source.ts"), { recursive: true });

    expect(() => readFileWithinRoot(root, join(root, "source.ts"))).toThrow();
  });

  it("marks discovery incomplete when root .gitignore resolves outside the project", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "cnm-safe-ignore-test-"));
    const root = join(temporaryDirectory, "repository");
    const outsideIgnore = join(temporaryDirectory, "outside.gitignore");
    mkdirSync(root, { recursive: true });
    writeFileSync(outsideIgnore, "keep.ts\n");
    writeFileSync(join(root, "keep.ts"), "export const keep = true;\n");
    symlinkSync(outsideIgnore, join(root, ".gitignore"));

    const discovery = discoverFiles(root);
    expect(discovery.abortRequired).toBe(true);
    expect(discovery.protectedDirectories.has("")).toBe(true);
    expect(discovery.failed).toBeGreaterThan(0);
  });
});
