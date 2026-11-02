import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverFiles } from "../src/core/indexer.js";

let temporaryDirectory = "";

afterEach(() => {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = "";
});

describe("safe project file reads", () => {
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
