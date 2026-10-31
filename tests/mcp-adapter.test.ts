import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import type { ProjectLocation } from "../src/core/project.js";
import { indexWithDatabase } from "../src/core/indexer.js";
import { remember } from "../src/core/memories.js";
import { ensureProject, openDatabase, type MemoryDatabase } from "../src/storage/database.js";
import { createMcpServer } from "../src/adapters/mcp/server.js";

type JsonRpcMessage = Parameters<InMemoryTransport["send"]>[0];

class McpTestClient {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (message: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }>();
  private readonly clientTransport: InMemoryTransport;
  private readonly serverTransport: InMemoryTransport;
  private readonly server: ReturnType<typeof createMcpServer>;
  private connected = false;

  constructor(private readonly location: ProjectLocation) {
    this.server = createMcpServer(location);
    [this.clientTransport, this.serverTransport] = InMemoryTransport.createLinkedPair();
    this.clientTransport.onmessage = (message) => {
      if (!("id" in message) || typeof message.id !== "number") return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.resolve(message as unknown as Record<string, unknown>);
    };
  }

  async connect(): Promise<void> {
    await Promise.all([this.clientTransport.start(), this.server.connect(this.serverTransport)]);
    this.connected = true;
    await this.request("initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "cnm-mcp-adapter-tests", version: "1.0.0" },
    });
    await this.notify("notifications/initialized");
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    await this.clientTransport.send({
      jsonrpc: "2.0",
      id,
      method,
      params,
    } as JsonRpcMessage);
    return response;
  }

  async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    await this.clientTransport.send({ jsonrpc: "2.0", method, params } as JsonRpcMessage);
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    await this.server.close();
  }
}

let temporaryDirectory = "";
let database: MemoryDatabase | undefined;
let location: ProjectLocation;
let clients: McpTestClient[] = [];

function createProject(): void {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "cnm-mcp-adapter-test-"));
  const rootPath = join(temporaryDirectory, "repository");
  const dataDirectory = join(temporaryDirectory, "data");
  mkdirSync(rootPath, { recursive: true });
  location = {
    id: "mcp-adapter-test-project",
    rootPath,
    dataDirectory,
    databasePath: join(dataDirectory, "memory.sqlite"),
  };
  database = openDatabase(location);
  ensureProject(database, location);
  writeFileSync(join(rootPath, "main.ts"), 'import { helper } from "./helper";\nexport function target() { return helper(); }\n');
  writeFileSync(join(rootPath, "helper.ts"), "export function helper() { return true; }\n");
  indexWithDatabase(database, location);
  remember(location, "MCP adapter fixture", "A confirmed memory for protocol read tests", "decision", "main.ts");
}

async function connectClient(): Promise<McpTestClient> {
  const client = new McpTestClient(location);
  clients.push(client);
  await client.connect();
  return client;
}

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  clients = [];
  database?.close();
  database = undefined;
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = "";
});

describe("MCP adapter protocol contract", () => {
  it("discovers exactly ten tools and publishes the expected input schemas", async () => {
    createProject();
    const client = await connectClient();
    const response = await client.request("tools/list");
    const result = response.result as { tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }> };
    const tools = result.tools;

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "change_impact",
      "dependency_graph",
      "file_details",
      "index_freshness",
      "memory_freshness",
      "memory_recall",
      "project_map",
      "project_overview",
      "symbol_lookup",
      "task_context",
    ]);
    const schemas = Object.fromEntries(tools.map((tool) => [tool.name, Object.keys(tool.inputSchema.properties ?? {}).sort()]));
    expect(schemas).toEqual({
      project_overview: [],
      index_freshness: [],
      project_map: ["limit"],
      symbol_lookup: ["limit", "query"],
      dependency_graph: ["depth", "limit", "maxProcessed", "path"],
      file_details: ["limit", "path"],
      change_impact: ["limit", "maxProcessed", "path"],
      task_context: ["maxCharacters", "maxItems", "task"],
      memory_freshness: ["limit"],
      memory_recall: ["limit", "query"],
    });
  });

  it("executes at least one valid call for every tool and supports repeated calls", async () => {
    createProject();
    const client = await connectClient();
    const calls: Array<[string, Record<string, unknown>]> = [
      ["project_overview", {}],
      ["index_freshness", {}],
      ["project_map", { limit: 10 }],
      ["symbol_lookup", { query: "target", limit: 5 }],
      ["dependency_graph", { path: "main.ts", depth: 1 }],
      ["file_details", { path: "main.ts", limit: 10 }],
      ["change_impact", { path: "helper.ts", limit: 10 }],
      ["task_context", { task: "understand target helper", maxItems: 10 }],
      ["memory_freshness", {}],
      ["memory_recall", { query: "MCP adapter", limit: 5 }],
    ];

    for (const [name, args] of calls) {
      const response = await client.request("tools/call", { name, arguments: args });
      expect(response.error, name).toBeUndefined();
      const result = response.result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
      expect(result.isError, `${name}: ${JSON.stringify(result)}`).not.toBe(true);
      expect(result.content?.some((item) => item.type === "text" && typeof item.text === "string"), name).toBe(true);
      expect(() => JSON.parse(result.content![0]!.text!)).not.toThrow();
    }

    const first = await client.request("tools/call", { name: "project_overview", arguments: {} });
    const second = await client.request("tools/call", { name: "project_overview", arguments: {} });
    expect((first.result as { content: Array<{ text: string }> }).content[0]!.text)
      .toBe((second.result as { content: Array<{ text: string }> }).content[0]!.text);
  });

  it("rejects invalid arguments with an MCP error response", async () => {
    createProject();
    const client = await connectClient();
    const response = await client.request("tools/call", {
      name: "symbol_lookup",
      arguments: { query: "", limit: 0 },
    });

    const result = response.result as { isError?: boolean; content?: Array<{ text?: string }> } | undefined;
    expect(Boolean(response.error) || result?.isError === true).toBe(true);
    const errorText = response.error
      ? JSON.stringify(response.error)
      : (result?.content ?? []).map((item) => item.text ?? "").join("\n");
    expect(errorText.length).toBeGreaterThan(0);

    const coreError = await client.request("tools/call", {
      name: "dependency_graph",
      arguments: { path: "missing-from-index.ts" },
    });
    const coreResult = coreError.result as { isError?: boolean; content?: Array<{ text?: string }> } | undefined;
    expect(Boolean(coreError.error) || coreResult?.isError === true).toBe(true);
    expect((coreResult?.content ?? []).map((item) => item.text ?? "").join("\\n")).toContain("File not found in memory index");
  });

  it("does not change repository files, index revision, or durable memory records during read calls", async () => {
    createProject();
    const client = await connectClient();
    const sourceBefore = readFileSync(join(location.rootPath, "main.ts"), "utf8");
    const before = {
      memories: database!.prepare("SELECT id, title, content, status, source_path FROM memories ORDER BY id").all(),
      indexRevision: database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id),
      files: database!.prepare("SELECT path, content_hash FROM files ORDER BY path").all(),
    };

    for (const [name, args] of [
      ["project_overview", {}],
      ["index_freshness", {}],
      ["project_map", { limit: 1 }],
      ["symbol_lookup", { query: "target" }],
      ["dependency_graph", { path: "main.ts" }],
      ["file_details", { path: "main.ts" }],
      ["change_impact", { path: "helper.ts" }],
      ["task_context", { task: "target helper" }],
      ["memory_freshness", {}],
      ["memory_recall", {}],
    ] as Array<[string, Record<string, unknown>]>) {
      await client.request("tools/call", { name, arguments: args });
    }

    expect(readFileSync(join(location.rootPath, "main.ts"), "utf8")).toBe(sourceBefore);
    expect(database!.prepare("SELECT id, title, content, status, source_path FROM memories ORDER BY id").all()).toEqual(before.memories);
    expect(database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id)).toEqual(before.indexRevision);
    expect(database!.prepare("SELECT path, content_hash FROM files ORDER BY path").all()).toEqual(before.files);
  });

  it("supports clean close and a fresh reconnection", async () => {
    createProject();
    const first = await connectClient();
    expect((await first.request("tools/list")).result).toBeDefined();
    await first.close();

    const second = await connectClient();
    const response = await second.request("tools/call", { name: "project_overview", arguments: {} });
    expect(response.error).toBeUndefined();
    expect(response.result).toBeDefined();
  });
});
