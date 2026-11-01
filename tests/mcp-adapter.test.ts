import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  constructor(private readonly location: ProjectLocation, options: { autoUpdate?: boolean; strictFreshness?: boolean } = {}) {
    this.server = createMcpServer(location, options);
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

async function connectClient(options: { autoUpdate?: boolean; strictFreshness?: boolean } = {}): Promise<McpTestClient> {
  const client = new McpTestClient(location, options);
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
  it("discovers exactly sixteen tools and publishes the expected input schemas", async () => {
    createProject();
    const client = await connectClient();
    const response = await client.request("tools/list");
    const result = response.result as { tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }> };
    const tools = result.tools;

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "change_impact",
      "dependency_graph",
      "file_details",
      "git_blame",
      "index_freshness",
      "index_update",
      "memory_freshness",
      "memory_propose",
      "memory_recall",
      "memory_transition",
      "project_map",
      "project_overview",
      "source_excerpt",
      "symbol_impact",
      "symbol_lookup",
      "task_context",
    ]);
    const schemas = Object.fromEntries(tools.map((tool) => [tool.name, Object.keys(tool.inputSchema.properties ?? {}).sort()]));
    expect(schemas).toEqual({
      project_overview: [],
      index_freshness: [],
      index_update: [],
      project_map: ["limit"],
      symbol_lookup: ["exported", "filePath", "includeSource", "kind", "limit", "query"],
      dependency_graph: ["depth", "limit", "maxProcessed", "path"],
      file_details: ["inlineSnippets", "limit", "path", "snippetLimit", "snippetMaxLines"],
      source_excerpt: ["endLine", "maxCharacters", "path", "startLine"],
      git_blame: ["endLine", "path", "startLine"],
      change_impact: ["limit", "maxProcessed", "path"],
      symbol_impact: ["depth", "direction", "filePath", "kind", "limit", "maxProcessed", "relationKinds", "startLine", "symbol"],
      task_context: ["anchors", "dependencyLimit", "fileLimit", "maxCharacters", "maxItems", "memoryLimit", "symbolLimit", "task", "testLimit"],
      memory_freshness: ["limit"],
      memory_propose: ["category", "commitSha", "content", "sourcePath", "title"],
      memory_recall: ["category", "limit", "list", "query", "status"],
      memory_transition: ["id", "status"],
    });
  });

  it("executes a valid bounded Git blame call and rejects invalid ranges", async () => {
    createProject();
    execFileSync("git", ["init"], { cwd: location.rootPath, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "cnm-tests@example.invalid"], { cwd: location.rootPath });
    execFileSync("git", ["config", "user.name", "CNM MCP Tests"], { cwd: location.rootPath });
    execFileSync("git", ["add", "main.ts"], { cwd: location.rootPath });
    execFileSync("git", ["commit", "-m", "add MCP fixture"], { cwd: location.rootPath, stdio: "ignore" });

    const client = await connectClient();
    const valid = await client.request("tools/call", {
      name: "git_blame",
      arguments: { path: "main.ts", startLine: 1, endLine: 2 },
    });
    const validResult = valid.result as { isError?: boolean; content?: Array<{ text?: string }> } | undefined;
    expect(validResult?.isError).not.toBe(true);
    expect(validResult?.content?.[0]?.text).toContain("CNM MCP Tests");

    const invalid = await client.request("tools/call", {
      name: "git_blame",
      arguments: { path: "../outside.ts", startLine: 1, endLine: 2 },
    });
    const invalidResult = invalid.result as { isError?: boolean } | undefined;
    expect(Boolean(invalid.error) || invalidResult?.isError === true).toBe(true);
  }, 20_000);

  it("executes at least one valid call for every tool and supports repeated calls", async () => {
    createProject();
    const client = await connectClient();
    const calls: Array<[string, Record<string, unknown>]> = [
      ["project_overview", {}],
      ["index_freshness", {}],
      ["index_update", {}],
      ["project_map", { limit: 10 }],
      ["symbol_lookup", { query: "target", limit: 5, includeSource: { maxLines: 5 } }],
      ["dependency_graph", { path: "main.ts", depth: 1 }],
      ["file_details", { path: "main.ts", limit: 10, inlineSnippets: true, snippetLimit: 1 }],
      ["source_excerpt", { path: "main.ts", startLine: 1, endLine: 2 }],
      ["change_impact", { path: "helper.ts", limit: 10 }],
      ["symbol_impact", { symbol: "helper", filePath: "helper.ts", direction: "incoming", depth: 2 }],
      ["task_context", { task: "understand target helper", maxItems: 10 }],
      ["task_context", { task: "understand target helper", maxItems: 10, symbolLimit: 5, fileLimit: 3, dependencyLimit: 4, testLimit: 2, memoryLimit: 6 }],
      ["memory_freshness", {}],
      ["memory_propose", { title: "Suggested invariant", content: "Agent suggestions remain unconfirmed." }],
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

    const proposal = await client.request("tools/call", {
      name: "memory_propose",
      arguments: { title: "Explicit approval fixture", content: "This proposal needs user approval." },
    });
    const proposalData = JSON.parse((proposal.result as { content: Array<{ text: string }> }).content[0]!.text) as { id: string; status: string };
    expect(proposalData.status).toBe("proposed");
    const confirmation = await client.request("tools/call", {
      name: "memory_transition",
      arguments: { id: proposalData.id, status: "confirmed" },
    });
    const confirmationData = JSON.parse((confirmation.result as { content: Array<{ text: string }> }).content[0]!.text) as { transitioned: boolean; status: string };
    expect(confirmationData).toMatchObject({ transitioned: true, status: "confirmed" });

    const first = await client.request("tools/call", { name: "project_overview", arguments: {} });
    const second = await client.request("tools/call", { name: "project_overview", arguments: {} });
    expect((first.result as { content: Array<{ text: string }> }).content[0]!.text)
      .toBe((second.result as { content: Array<{ text: string }> }).content[0]!.text);
  });

  it("returns verified inline snippets and restricts anchored task context to anchor/graph items", async () => {
    createProject();
    const client = await connectClient();

    const symbols = await client.request("tools/call", {
      name: "symbol_lookup",
      arguments: { query: "target", includeSource: { maxLines: 5 } },
    });
    const symbolItems = JSON.parse((symbols.result as { content: Array<{ text: string }> }).content[0]!.text) as Array<{ source?: { content: string; indexStatus: string } }>;
    expect(symbolItems[0]?.source?.content).toContain("function target");
    expect(symbolItems[0]?.source?.indexStatus).toBe("current");

    const details = await client.request("tools/call", {
      name: "file_details",
      arguments: { path: "main.ts", inlineSnippets: true, snippetLimit: 2 },
    });
    const fileResult = JSON.parse((details.result as { content: Array<{ text: string }> }).content[0]!.text) as {
      symbols: Array<{ source?: { content: string; indexStatus: string } }>;
      inlineSnippets: { included: number };
    };
    expect(fileResult.inlineSnippets.included).toBeGreaterThan(0);
    expect(fileResult.symbols[0]?.source?.indexStatus).toBe("current");

    const anchored = await client.request("tools/call", {
      name: "task_context",
      arguments: { task: "unrelated broad task terms", anchors: { paths: ["main.ts"] } },
    });
    const context = JSON.parse((anchored.result as { content: Array<{ text: string }> }).content[0]!.text) as {
      items: Array<{ source: string; origin: string }>;
    };
    expect(context.items).toContainEqual(expect.objectContaining({ source: "main.ts", origin: "anchor" }));
    expect(context.items.every((item) => item.origin === "anchor" || item.origin === "graph")).toBe(true);
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

    const invalidSymbolImpact = await client.request("tools/call", {
      name: "symbol_impact",
      arguments: { symbol: "target", direction: "sideways" },
    });
    const invalidSymbolImpactResult = invalidSymbolImpact.result as { isError?: boolean } | undefined;
    expect(Boolean(invalidSymbolImpact.error) || invalidSymbolImpactResult?.isError === true).toBe(true);
    const invalidBudget = await client.request("tools/call", {
      name: "task_context",
      arguments: { task: "target helper", dependencyLimit: 51 },
    });
    const invalidBudgetResult = invalidBudget.result as { isError?: boolean } | undefined;
    expect(Boolean(invalidBudget.error) || invalidBudgetResult?.isError === true).toBe(true);

    const coreError = await client.request("tools/call", {
      name: "dependency_graph",
      arguments: { path: "missing-from-index.ts" },
    });
    const coreResult = coreError.result as { isError?: boolean; content?: Array<{ text?: string }> } | undefined;
    expect(Boolean(coreError.error) || coreResult?.isError === true).toBe(true);
    expect((coreResult?.content ?? []).map((item) => item.text ?? "").join("\n")).toContain("File not found in memory index");
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
      ["source_excerpt", { path: "main.ts", startLine: 1, endLine: 2 }],
      ["change_impact", { path: "helper.ts" }],
      ["symbol_impact", { symbol: "helper", filePath: "helper.ts" }],
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

  it("supports explicit incremental index updates and stores agent memories as proposed", async () => {
    createProject();
    const client = await connectClient();
    indexWithDatabase(database!, location, false, ["excluded.ts"]);
    const initialRevision = (database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision;
    writeFileSync(join(location.rootPath, "helper.ts"), "export function helper() { return false; }\n");
    writeFileSync(join(location.rootPath, "excluded.ts"), "export function shouldStayExcluded() {}\n");

    const update = await client.request("tools/call", { name: "index_update", arguments: {} });
    const updateResult = update.result as { content: Array<{ text: string }> };
    expect(JSON.parse(updateResult.content[0]!.text)).toMatchObject({ updated: 1, unchanged: 1 });
    expect((database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision).toBe(initialRevision + 1);
    expect(database!.prepare("SELECT path FROM files WHERE path = 'excluded.ts'").get()).toBeUndefined();

    const filtered = await client.request("tools/call", {
      name: "symbol_lookup",
      arguments: { query: "helper", kind: "function", filePath: "helper.ts", exported: true, limit: 5 },
    });
    const filteredResult = filtered.result as { content: Array<{ text: string }> };
    expect(JSON.parse(filteredResult.content[0]!.text)).toEqual([
      expect.objectContaining({ name: "helper", kind: "function", filePath: "helper.ts", exported: true }),
    ]);

    const proposal = await client.request("tools/call", {
      name: "memory_propose",
      arguments: { title: "Agent suggestion", content: "Review before adopting.", sourcePath: "main.ts" },
    });
    const proposalResult = proposal.result as { content: Array<{ text: string }> };
    const saved = JSON.parse(proposalResult.content[0]!.text) as { id: string; status: string; requiresHumanConfirmation: boolean };
    expect(saved).toMatchObject({ status: "proposed", requiresHumanConfirmation: true });
    expect(database!.prepare("SELECT status FROM memories WHERE id = ?").get(saved.id)).toEqual({ status: "proposed" });
  });

  it("returns semantic import diagnostics through file_details", async () => {
    createProject();
    const packageRoot = join(location.rootPath, "node_modules", "fixture-package");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "fixture-package", types: "index.d.ts" }));
    writeFileSync(join(packageRoot, "index.d.ts"), "export declare const present: boolean;");
    writeFileSync(join(location.rootPath, "imports.ts"), [
      'import { missing } from "fixture-package";',
      'import { absent } from "not-installed-fixture";',
      "void missing; void absent;",
    ].join("\n"));
    indexWithDatabase(database!, location);

    const client = await connectClient();
    const response = await client.request("tools/call", {
      name: "file_details",
      arguments: { path: "imports.ts" },
    });
    const result = response.result as { content: Array<{ text: string }> };
    const details = JSON.parse(result.content[0]!.text);
    expect(details.importDiagnostics).toEqual([
      expect.objectContaining({ specifier: "fixture-package", kind: "missing-export", importedName: "missing" }),
      expect.objectContaining({ specifier: "not-installed-fixture", kind: "missing-package" }),
    ]);
  });

  it("warns on stale reads, refuses them in strict mode, and refreshes them when auto-update is enabled", async () => {
    createProject();
    const warningClient = await connectClient();
    writeFileSync(join(location.rootPath, "helper.ts"), "export function refreshedHelper() { return true; }\n");

    const warning = await warningClient.request("tools/call", {
      name: "symbol_lookup",
      arguments: { query: "helper", limit: 5 },
    });
    const warningResult = warning.result as { content: Array<{ text: string }> };
    expect(warningResult.content[1]?.text).toContain("CNM FRESHNESS WARNING");
    expect(warningResult.content[1]?.text).toContain("helper.ts");

    await warningClient.close();
    const strictClient = await connectClient({ strictFreshness: true });
    const refused = await strictClient.request("tools/call", {
      name: "symbol_lookup",
      arguments: { query: "helper", limit: 5 },
    });
    expect((refused.result as { isError?: boolean }).isError).toBe(true);
    expect((refused.result as { content: Array<{ text: string }> }).content[0]!.text).toContain('"status": "refused"');

    await strictClient.close();
    const autoClient = await connectClient({ autoUpdate: true });
    const refreshed = await autoClient.request("tools/call", {
      name: "symbol_lookup",
      arguments: { query: "refreshedHelper", limit: 5 },
    });
    const refreshedResult = refreshed.result as { content: Array<{ text: string }> };
    expect(JSON.parse(refreshedResult.content[0]!.text)).toEqual([
      expect.objectContaining({ name: "refreshedHelper", filePath: "helper.ts" }),
    ]);
    expect(refreshedResult.content.some((item) => item.text.includes("CNM AUTO-UPDATE"))).toBe(true);
  });

  it("refuses strict reads when discovery is incomplete and preserves the prior index", async () => {
    createProject();
    const client = await connectClient({ autoUpdate: true, strictFreshness: true });
    const outside = join(temporaryDirectory, "outside.ts");
    writeFileSync(outside, "export const outside = true;");
    symlinkSync(outside, join(location.rootPath, "linked.ts"));
    writeFileSync(join(location.rootPath, "helper.ts"), "export function changedHelper() { return false; }");
    const beforeRevision = (database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision;

    const response = await client.request("tools/call", {
      name: "symbol_lookup",
      arguments: { query: "helper", limit: 5 },
    });
    const result = response.result as { isError?: boolean; content: Array<{ text: string }> };
    const refusal = JSON.parse(result.content[0]!.text) as { status: string; autoUpdate: { skippedReason: string | null } };
    expect(result.isError).toBe(true);
    expect(refusal.status).toBe("refused");
    expect(refusal.autoUpdate.skippedReason).toContain("discovery is incomplete");
    expect((database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision).toBe(beforeRevision);
  });

  it("skips automatic refresh above fifty changed files and refuses strict reads", async () => {
    createProject();
    const client = await connectClient({ autoUpdate: true, strictFreshness: true });
    for (let index = 0; index < 51; index += 1) {
      writeFileSync(join(location.rootPath, `changed-${index}.ts`), `export const changed${index} = true;`);
    }
    const beforeRevision = (database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision;

    const response = await client.request("tools/call", {
      name: "project_overview",
      arguments: {},
    });
    const result = response.result as { isError?: boolean; content: Array<{ text: string }> };
    const refusal = JSON.parse(result.content[0]!.text) as { status: string; autoUpdate: { skippedReason: string | null } };
    expect(result.isError).toBe(true);
    expect(refusal.status).toBe("refused");
    expect(refusal.autoUpdate.skippedReason).toContain("exceed the safety limit of 50");
    expect((database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision).toBe(beforeRevision);
  });

  it("rolls back failed automatic refresh and refuses strict reads with the failure reason", async () => {
    createProject();
    const client = await connectClient({ autoUpdate: true, strictFreshness: true });
    const beforeRevision = (database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision;
    const beforeHash = database!.prepare("SELECT content_hash FROM files WHERE path = 'helper.ts'").get() as { content_hash: string };
    database!.exec("CREATE TRIGGER fail_auto_refresh BEFORE INSERT ON relations BEGIN SELECT RAISE(ABORT, 'forced auto-refresh failure'); END;");
    writeFileSync(join(location.rootPath, "helper.ts"), "export function changedHelper() { return false; }");

    const response = await client.request("tools/call", {
      name: "symbol_lookup",
      arguments: { query: "helper", limit: 5 },
    });
    const result = response.result as { isError?: boolean; content: Array<{ text: string }> };
    const refusal = JSON.parse(result.content[0]!.text) as { status: string; autoUpdate: { failureReason: string | null } };
    expect(result.isError).toBe(true);
    expect(refusal.status).toBe("refused");
    expect(refusal.autoUpdate.failureReason).toContain("forced auto-refresh failure");
    expect(database!.prepare("SELECT content_hash FROM files WHERE path = 'helper.ts'").get()).toEqual(beforeHash);
    expect((database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision).toBe(beforeRevision);
  });

  it("serializes concurrent auto-refresh reads into one verified index revision", async () => {
    createProject();
    const client = await connectClient({ autoUpdate: true, strictFreshness: true });
    writeFileSync(join(location.rootPath, "helper.ts"), "export function changedHelper() { return false; }");
    const beforeRevision = (database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision;

    const [first, second] = await Promise.all([
      client.request("tools/call", { name: "symbol_lookup", arguments: { query: "changedHelper", limit: 5 } }),
      client.request("tools/call", { name: "project_overview", arguments: {} }),
    ]);
    for (const response of [first, second]) {
      const result = response.result as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).not.toBe(true);
    }
    expect((database!.prepare("SELECT index_revision FROM projects WHERE id = ?").get(location.id) as { index_revision: number }).index_revision).toBe(beforeRevision + 1);
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
