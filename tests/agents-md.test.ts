import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAgentInstructions, ensureAgentInstructions } from "../src/core/agents-md.js";
import type { ProjectLocation } from "../src/core/project.js";

let temporaryDirectory = "";

function createProject(): ProjectLocation {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "cnm-agents-md-"));
  const rootPath = join(temporaryDirectory, "repository");
  mkdirSync(rootPath, { recursive: true });
  return {
    id: "agents-md-test",
    rootPath,
    dataDirectory: join(temporaryDirectory, "data"),
    databasePath: join(temporaryDirectory, "data", "memory.sqlite"),
  };
}

afterEach(() => {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = "";
});

describe("generated agent instructions", () => {
  it("creates AGENTS.md by default and is idempotent", () => {
    const location = createProject();
    expect(checkAgentInstructions(location).status).toBe("missing");
    expect(ensureAgentInstructions(location)).toMatchObject({ status: "created" });
    const first = readFileSync(join(location.rootPath, "AGENTS.md"), "utf8");
    expect(first).toContain("memory_recall");
    expect(first).toContain("memory_transition");
    expect(first).toContain("index_freshness");
    expect(first).toContain("source_excerpt");
    expect(ensureAgentInstructions(location)).toMatchObject({ status: "current" });
    expect(readFileSync(join(location.rootPath, "AGENTS.md"), "utf8")).toBe(first);
    expect(checkAgentInstructions(location).status).toBe("current");
  });

  it("preserves existing user-authored instructions and manages only the CNM block", () => {
    const location = createProject();
    const path = join(location.rootPath, "AGENTS.md");
    writeFileSync(path, "# My project rules\n\nKeep the existing workflow.\n", "utf8");
    expect(ensureAgentInstructions(location, "opencode").status).toBe("updated");
    const first = readFileSync(path, "utf8");
    expect(first.startsWith("# My project rules")).toBe(true);
    expect(first).toContain("Keep the existing workflow.");
    expect(first).toContain("tool=opencode");
    expect(ensureAgentInstructions(location, "opencode").status).toBe("current");
    expect(readFileSync(path, "utf8")).toBe(first);
    expect(ensureAgentInstructions(location, "claude").status).toBe("updated");
    const updated = readFileSync(path, "utf8");
    expect(updated.startsWith("# My project rules")).toBe(true);
    expect(updated.match(/cnm:agent-instructions:start/g)).toHaveLength(1);
    expect(updated).toContain("tool=claude");
    expect(updated).not.toContain("tool=opencode");
  });

  it("detects manual edits to the managed section without changing user content", () => {
    const location = createProject();
    ensureAgentInstructions(location);
    const path = join(location.rootPath, "AGENTS.md");
    const original = readFileSync(path, "utf8");
    writeFileSync(path, original.replace("MCP-first source retrieval", "Broken instructions"), "utf8");
    expect(checkAgentInstructions(location).status).toBe("outdated");
    expect(ensureAgentInstructions(location).status).toBe("updated");
    expect(checkAgentInstructions(location).status).toBe("current");
  });
});
