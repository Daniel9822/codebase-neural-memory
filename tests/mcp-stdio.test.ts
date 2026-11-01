import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureProject, openDatabase, type MemoryDatabase } from "../src/storage/database.js";
import { getProjectLocation } from "../src/core/project.js";
import { indexWithDatabase } from "../src/core/indexer.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";

let temporaryDirectory = "";
let database: MemoryDatabase | undefined;
let previousXdgDataHome: string | undefined;
const processes: ChildProcessWithoutNullStreams[] = [];

function createInitializedRepository(): string {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "cnm-mcp-stdio-test-"));
  const rootPath = join(temporaryDirectory, "repository");
  const xdgDataHome = join(temporaryDirectory, "xdg-data");
  mkdirSync(rootPath, { recursive: true });
  previousXdgDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = xdgDataHome;

  const location = getProjectLocation(rootPath);
  database = openDatabase(location);
  ensureProject(database, location);
  writeFileSync(join(rootPath, "entry.ts"), "export function stdioProbe() { return true; }\n");
  indexWithDatabase(database, location);
  database.close();
  database = undefined;
  return rootPath;
}

function launchMcp(rootPath: string): {
  child: ChildProcessWithoutNullStreams;
  request: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  notify: (method: string, params?: Record<string, unknown>) => void;
} {
  const tsxCli = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const entrypoint = join(process.cwd(), "src", "cli", "index.ts");
  const child = spawn(process.execPath, [tsxCli, entrypoint, "mcp"], {
    cwd: rootPath,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  processes.push(child);

  const lines = createInterface({ input: child.stdout });
  let nextId = 1;
  const pending = new Map<number, {
    resolve: (message: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }>();
  lines.on("line", (line) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    request.resolve(message);
  });

  return {
    child,
    request(method, params = {}) {
      const id = nextId++;
      const response = new Promise<Record<string, unknown>>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return response;
    },
    notify(method, params = {}) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    },
  };
}

async function initialize(client: ReturnType<typeof launchMcp>): Promise<void> {
  const response = await client.request("initialize", {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "cnm-mcp-stdio-test", version: "1.0.0" },
  });
  expect(response.error).toBeUndefined();
  client.notify("notifications/initialized");
}

afterEach(async () => {
  for (const child of processes.splice(0)) {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  }
  database?.close();
  database = undefined;
  if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousXdgDataHome;
  previousXdgDataHome = undefined;
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = "";
});

describe("MCP stdio process lifecycle", () => {
  it("starts the real CLI server, serves requests, exits on EOF, and reconnects cleanly", async () => {
    const rootPath = createInitializedRepository();
    const first = launchMcp(rootPath);
    await initialize(first);

    const list = await first.request("tools/list");
    const tools = (list.result as { tools: Array<{ name: string }> }).tools;
    expect(tools).toHaveLength(11);
    expect(tools.map((tool) => tool.name)).toContain("source_excerpt");

    const call = await first.request("tools/call", {
      name: "symbol_lookup",
      arguments: { query: "stdioProbe" },
    });
    const result = call.result as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(result.isError).not.toBe(true);
    expect(result.content?.[0]?.text).toContain("stdioProbe");

    const excerpt = await first.request("tools/call", {
      name: "source_excerpt",
      arguments: { path: "entry.ts", startLine: 1, endLine: 1 },
    });
    const excerptResult = excerpt.result as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(excerptResult.isError).not.toBe(true);
    expect(excerptResult.content?.[0]?.text).toContain("export function stdioProbe");

    first.child.stdin.end();
    const [exitCode] = await once(first.child, "exit") as [number | null];
    expect(exitCode).toBe(0);

    const second = launchMcp(rootPath);
    await initialize(second);
    const overview = await second.request("tools/call", {
      name: "project_overview",
      arguments: {},
    });
    expect(overview.error).toBeUndefined();
    expect((overview.result as { isError?: boolean }).isError).not.toBe(true);

    second.child.stdin.end();
    const [secondExitCode] = await once(second.child, "exit") as [number | null];
    expect(secondExitCode).toBe(0);
  }, 20_000);
});
