import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import type { ProjectLocation } from "../src/core/project.js";
import { indexWithDatabase } from "../src/core/indexer.js";
import { remember } from "../src/core/memories.js";
import { createMcpServer } from "../src/adapters/mcp/server.js";
import { ensureProject, openDatabase, type MemoryDatabase } from "../src/storage/database.js";

type JsonRpcMessage = Parameters<InMemoryTransport["send"]>[0];

class ProtocolClient {
  private id = 1;
  private readonly pending = new Map<number, (value: Record<string, unknown>) => void>();
  private readonly server: ReturnType<typeof createMcpServer>;
  private readonly pair = InMemoryTransport.createLinkedPair();
  private readonly clientTransport = this.pair[0];
  private readonly serverTransport = this.pair[1];

  constructor(private readonly location: ProjectLocation) {
    this.server = createMcpServer(location);
    this.clientTransport.onmessage = (message) => {
      if (!("id" in message) || typeof message.id !== "number") return;
      const resolve = this.pending.get(message.id);
      if (resolve) {
        this.pending.delete(message.id);
        resolve(message as unknown as Record<string, unknown>);
      }
    };
  }

  async connect(): Promise<void> {
    await Promise.all([this.clientTransport.start(), this.server.connect(this.serverTransport)]);
    await this.request("initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "cnm-block3-tests", version: "1.0.0" },
    });
    await this.clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" } as JsonRpcMessage);
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.id++;
    const response = new Promise<Record<string, unknown>>((resolve) => this.pending.set(id, resolve));
    await this.clientTransport.send({ jsonrpc: "2.0", id, method, params } as JsonRpcMessage);
    return response;
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const response = await this.request("tools/call", { name, arguments: args });
    return JSON.parse((response.result as { content: Array<{ text: string }> }).content[0]!.text);
  }

  async close(): Promise<void> {
    await this.server.close();
  }
}

const temporaryDirectories: string[] = [];
const clients: ProtocolClient[] = [];
const databases: MemoryDatabase[] = [];

function createProject(label: string): { location: ProjectLocation; root: string } {
  const temporary = mkdtempSync(join(tmpdir(), `cnm-block3-${label}-`));
  temporaryDirectories.push(temporary);
  const root = join(temporary, "repository");
  const data = join(temporary, "data");
  mkdirSync(root, { recursive: true });
  const location: ProjectLocation = {
    id: `block3-${label}`,
    rootPath: root,
    dataDirectory: data,
    databasePath: join(data, "memory.sqlite"),
  };
  const db = openDatabase(location);
  databases.push(db);
  ensureProject(db, location);
  return { location, root };
}

async function connect(location: ProjectLocation): Promise<ProtocolClient> {
  const client = new ProtocolClient(location);
  clients.push(client);
  await client.connect();
  return client;
}

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  clients.length = 0;
  for (const db of databases) db.close();
  databases.length = 0;
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.length = 0;
});

describe("MCP bounded output and project isolation", () => {
  it("reports exact totals and truncation for freshness and project-map collections", async () => {
    const { location, root } = createProject("bounds");
    const importLines: string[] = [];
    for (let i = 0; i < 205; i += 1) {
      const name = `mod-${String(i).padStart(3, "0")}`;
      writeFileSync(join(root, `${name}.ts`), `export const value${i} = ${i};\n`);
      importLines.push(`import { value${i} } from "./${name}";`);
    }
    writeFileSync(join(root, "entry.ts"), importLines.join("\n") + "\nexport const total = 205;\n");
    indexWithDatabase(databases[0]!, location);

    const unreadableDirectories: string[] = [];
    const canEnforceDirectoryPermissions =
      process.platform !== "win32" && process.getuid?.() !== 0;

    for (let i = 0; i < 205; i += 1) {
      const blocked = join(root, `blocked-${String(i).padStart(3, "0")}`);
      mkdirSync(blocked);

      if (canEnforceDirectoryPermissions) {
        chmodSync(blocked, 0);
        unreadableDirectories.push(blocked);
      }
      if (i < 200) symlinkSync(join(root, "entry.ts"), join(root, `skipped-${String(i).padStart(3, "0")}.ts`));
      remember(location, `Linked memory ${i}`, "Boundary fixture", "decision", "entry.ts");
    }

    const client = await connect(location);
    const exactFreshness = await client.call("index_freshness");
    expect(exactFreshness.totals.skippedFiles).toBe(200);
    expect(exactFreshness.skippedFiles).toHaveLength(200);
    expect(exactFreshness.truncated.skippedFiles).toBe(false);
    const expectedErrors = canEnforceDirectoryPermissions ? 205 : 0;
    expect(exactFreshness.totals.errors).toBe(expectedErrors);
    expect(exactFreshness.errors).toHaveLength(Math.min(expectedErrors, 200));
    expect(exactFreshness.truncated.errors).toBe(expectedErrors > 200);
    for (let i = 200; i < 205; i += 1) {
      symlinkSync(join(root, "entry.ts"), join(root, `skipped-${String(i).padStart(3, "0")}.ts`));
    }
    const overLimitFreshness = await client.call("index_freshness");
    expect(overLimitFreshness.totals.skippedFiles).toBe(205);
    expect(overLimitFreshness.skippedFiles).toHaveLength(200);
    expect(overLimitFreshness.truncated.skippedFiles).toBe(true);
    for (const blocked of unreadableDirectories) chmodSync(blocked, 0o700);

    const memories = await client.call("memory_freshness", { limit: 100 });
    expect(memories.total).toBe(205);
    expect(memories.records).toHaveLength(100);
    expect(memories.truncated).toBe(true);
    const completeMemories = await client.call("memory_freshness", { limit: 205 });
    expect(completeMemories.records).toHaveLength(205);
    expect(completeMemories.truncated).toBe(false);

    const map = await client.call("project_map", { limit: 10 });
    expect(map.totalFiles).toBe(206);
    expect(map.files).toHaveLength(10);
    expect(map.truncated).toBe(true);
    const entry = map.files.find((file: { path: string }) => file.path === "entry.ts");
    expect(entry).toBeDefined();
    expect(entry.totals.imports).toBe(205);
    expect(entry.imports).toHaveLength(200);
    expect(entry.truncated.imports).toBe(true);
  }, 15_000);

  it("applies a deterministic global candidate budget before decoding candidate arrays", async () => {
    const { location, root } = createProject("candidate-budget");
    const imports = Array.from({ length: 11 }, (_, index) => `import "./ambiguous-${String(index).padStart(2, "0")}"; `);
    writeFileSync(join(root, "entry.ts"), imports.join("\n"));
    indexWithDatabase(databases[0]!, location);
    const unresolved = databases[0]!.prepare(
      "SELECT id, module_specifier FROM unresolved_imports WHERE source_file_id = (SELECT id FROM files WHERE path = 'entry.ts') ORDER BY module_specifier",
    ).all() as Array<{ id: number; module_specifier: string }>;
    expect(unresolved).toHaveLength(11);
    const paths = Array.from({ length: 1_000 }, (_, index) => `candidate/${String(index).padStart(4, "0")}.ts`);
    const update = databases[0]!.prepare("UPDATE unresolved_imports SET status = 'ambiguous', candidates_json = ? WHERE id = ?");
    for (const item of unresolved) update.run(JSON.stringify(paths), item.id);

    const client = await connect(location);
    const map = await client.call("project_map", { limit: 10 });
    const entry = map.files.find((file: { path: string }) => file.path === "entry.ts");
    expect(map.candidateBudget).toBe(2_000);
    expect(map.candidatePathsTotal).toBe(11_000);
    expect(map.candidatePathsReturned).toBe(2_000);
    expect(map.candidatePathsTruncated).toBe(true);
    expect(entry.unresolvedImports.map((item: { candidates: string[] }) => item.candidates.length))
      .toEqual([...Array(10).fill(200), 0]);
    expect(entry.unresolvedImports.every((item: { candidatesTotal: number; candidatesTruncated: boolean }) =>
      item.candidatesTotal === 1_000 && item.candidatesTruncated)).toBe(true);
  });

  it("bounds file_details unresolved-import candidate materialization globally", async () => {
    const { location, root } = createProject("file-details-candidate-budget");
    const imports = Array.from({ length: 11 }, (_, index) => `import "./missing-${String(index).padStart(2, "0")}";`);
    writeFileSync(join(root, "entry.ts"), imports.join("\\n"));
    indexWithDatabase(databases[0]!, location);
    const unresolved = databases[0]!.prepare(
      "SELECT id FROM unresolved_imports WHERE source_file_id = (SELECT id FROM files WHERE path = 'entry.ts') ORDER BY module_specifier",
    ).all() as Array<{ id: number }>;
    expect(unresolved).toHaveLength(11);
    const paths = Array.from({ length: 1_000 }, (_, index) => `candidate/${String(index).padStart(4, "0")}.ts`);
    const update = databases[0]!.prepare("UPDATE unresolved_imports SET status = 'ambiguous', candidates_json = ? WHERE id = ?");
    for (const item of unresolved) update.run(JSON.stringify(paths), item.id);

    const client = await connect(location);
    const details = await client.call("file_details", { path: "entry.ts", limit: 20 });
    expect(details.limits).toEqual({ perCollection: 20, candidatesPerImport: 200, candidateBudget: 2_000 });
    expect(details.totals.candidatePaths).toBe(11_000);
    expect(details.unresolvedImports.map((item: { candidates: string[] }) => item.candidates.length))
      .toEqual([...Array(10).fill(200), 0]);
    expect(details.unresolvedImports.every((item: { candidatesTotal: number; candidatesTruncated: boolean }) =>
      item.candidatesTotal === 1_000 && item.candidatesTruncated)).toBe(true);
    expect(details.truncated.candidatePaths).toBe(true);
  });

  it("bounds index_update diagnostic details while preserving exact totals", async () => {
    const { location, root } = createProject("index-update-output-budget");
    writeFileSync(join(root, "entry.ts"), "export const entry = true;\n");
    indexWithDatabase(databases[0]!, location);
    for (let index = 0; index < 205; index += 1) {
      symlinkSync(join(root, "entry.ts"), join(root, `linked-${String(index).padStart(3, "0")}.ts`));
    }

    const client = await connect(location);
    const result = await client.call("index_update", { include: ["*.ts"], maxProcessed: 1_000 });
    expect(result.skipped).toBe(205);
    expect(result.skippedFiles).toHaveLength(200);
    expect(result.totals).toEqual({ errors: 0, skippedFiles: 205 });
    expect(result.limits).toEqual({ detailItems: 200 });
    expect(result.detailsTruncated).toEqual({ errors: false, skippedFiles: true });
    expect(result.skippedFiles).toEqual([...result.skippedFiles].sort());
  });

  it("keeps concurrent MCP servers isolated to their own repositories and memories", async () => {
    const first = createProject("first");
    const second = createProject("second");
    writeFileSync(join(first.root, "first-only.ts"), "export const firstOnly = true;\n");
    writeFileSync(join(second.root, "second-only.ts"), "export const secondOnly = true;\n");
    indexWithDatabase(databases[0]!, first.location);
    indexWithDatabase(databases[1]!, second.location);
    remember(first.location, "First secret label", "First project memory", "decision");
    remember(second.location, "Second secret label", "Second project memory", "decision");

    const [firstClient, secondClient] = await Promise.all([
      connect(first.location),
      connect(second.location),
    ]);
    const [firstOverview, secondOverview, firstMap, secondMap, firstMemory, secondMemory] = await Promise.all([
      firstClient.call("project_overview"),
      secondClient.call("project_overview"),
      firstClient.call("project_map"),
      secondClient.call("project_map"),
      firstClient.call("memory_recall"),
      secondClient.call("memory_recall"),
    ]);

    expect(firstOverview.rootPath).toBe(first.root);
    expect(secondOverview.rootPath).toBe(second.root);
    expect(firstMap.files.map((file: { path: string }) => file.path)).toContain("first-only.ts");
    expect(firstMap.files.map((file: { path: string }) => file.path)).not.toContain("second-only.ts");
    expect(secondMap.files.map((file: { path: string }) => file.path)).toContain("second-only.ts");
    expect(secondMap.files.map((file: { path: string }) => file.path)).not.toContain("first-only.ts");
    expect(firstMemory.records.map((memory: { title: string }) => memory.title)).toContain("First secret label");
    expect(firstMemory.records.map((memory: { title: string }) => memory.title)).not.toContain("Second secret label");
    expect(secondMemory.records.map((memory: { title: string }) => memory.title)).toContain("Second secret label");
    expect(secondMemory.records.map((memory: { title: string }) => memory.title)).not.toContain("First secret label");
  });

  it("returns controlled MCP errors for missing, unindexed, traversal, and outside-root paths", async () => {
    const { location, root } = createProject("paths");
    writeFileSync(join(root, "indexed.ts"), "export const indexed = true;\n");
    indexWithDatabase(databases[0]!, location);
    writeFileSync(join(root, "not-indexed.ts"), "export const later = true;\n");
    const client = await connect(location);
    const invalidPaths = ["missing.ts", "not-indexed.ts", "../outside.ts", join(root, "..", "outside.ts")];
    for (const path of invalidPaths) {
      const response = await client.request("tools/call", {
        name: "dependency_graph",
        arguments: { path },
      });
      const result = response.result as { isError?: boolean } | undefined;
      expect(Boolean(response.error) || result?.isError === true, path).toBe(true);
    }
  });

  it("returns empty reports and exact-limit project maps without truncation", async () => {
    const { location } = createProject("empty");
    const client = await connect(location);
    const [freshness, memories, map] = await Promise.all([
      client.call("index_freshness"),
      client.call("memory_freshness"),
      client.call("project_map"),
    ]);
    expect(freshness.skippedFiles).toEqual([]);
    expect(freshness.errors).toEqual([]);
    expect(memories.records).toEqual([]);
    expect(memories.total).toBe(0);
    expect(memories.truncated).toBe(false);
    expect(map.files).toEqual([]);
    expect(map.totalFiles).toBe(0);
    expect(map.truncated).toBe(false);
    const exactMapProject = createProject("exact-map");
    for (let i = 0; i < 10; i += 1) {
      writeFileSync(join(exactMapProject.root, `exact-${i}.ts`), `export const item${i} = ${i};\n`);
    }
    indexWithDatabase(databases[1]!, exactMapProject.location);
    const exactMapClient = await connect(exactMapProject.location);
    const exactMap = await exactMapClient.call("project_map", { limit: 10 });
    expect(exactMap.totalFiles).toBe(10);
    expect(exactMap.files).toHaveLength(10);
    expect(exactMap.truncated).toBe(false);
  });
});
