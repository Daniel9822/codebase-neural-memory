import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

const root = mkdtempSync(join(tmpdir(), "cnm-phase3-smoke-"));
const repo = join(root, "repo");
mkdirSync(repo, { recursive: true });
const aPath = join(repo, "a.ts");
const bPath = join(repo, "b.ts");
writeFileSync(aPath, 'import { beta } from "./b";\nexport function alpha() { return beta(); }\n');
writeFileSync(bPath, "export function beta() { return 42; }\n");
const cli = resolve("dist/cli/index.js");
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const originalHashes = [digest(aPath), digest(bPath)];

function runCli(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`cnm ${args.join(" ")} failed (status ${result.status}):\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

let mcp;
try {
  assert.match(runCli(["--help"]), /Usage:/);
  assert.match(runCli(["init"]), /Initialized memory/);
  assert.match(runCli(["index"]), /Index completed/);
  assert.match(runCli(["search", "alpha"]), /alpha/);
  assert.match(runCli(["dependencies", "a.ts", "--depth", "2"]), /b\.ts/);
  assert.match(runCli(["file", "a.ts", "--limit", "1"]), /"path": "a\.ts"/);
  assert.match(runCli(["freshness"]), /"status": "current"/);

  mcp = spawn(process.execPath, [cli, "mcp"], { cwd: repo, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: mcp.stdout });
  const pending = new Map();
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve: done, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else done(message.result);
    }
  });
  mcp.on("exit", (code) => {
    for (const { reject } of pending.values()) reject(new Error(`MCP process exited: ${code}`));
    pending.clear();
  });
  let nextId = 1;
  const request = (method, params = {}) => {
    const id = nextId++;
    return new Promise((done, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for MCP ${method}`));
      }, 10000);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); done(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };
  const initialized = await request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "cnm-phase3-smoke", version: "1.0.0" },
  });
  assert.ok(initialized.serverInfo);
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const listed = await request("tools/list");
  const names = listed.tools.map((tool) => tool.name);
  for (const name of ["symbol_lookup", "dependency_graph", "file_details", "index_freshness", "change_impact"]) {
    assert.ok(names.includes(name), `MCP tool missing: ${name}`);
  }
  const lookup = await request("tools/call", { name: "symbol_lookup", arguments: { query: "alpha", limit: 10 } });
  assert.match(lookup.content.map((item) => item.text ?? "").join("\n"), /alpha/);
  const dependencies = await request("tools/call", { name: "dependency_graph", arguments: { path: "a.ts", depth: 2 } });
  assert.match(dependencies.content.map((item) => item.text ?? "").join("\n"), /b\.ts/);
  const impact = await request("tools/call", { name: "change_impact", arguments: { path: "b.ts", limit: 10, maxProcessed: 20 } });
  const impactText = impact.content.map((item) => item.text ?? "").join("\n");
  const impactResult = JSON.parse(impactText);
  assert.deepEqual(impactResult.affectedFiles, ["a.ts"]);
  assert.equal(impactResult.truncated, false);
  const details = await request("tools/call", { name: "file_details", arguments: { path: "a.ts", limit: 1 } });
  assert.match(details.content.map((item) => item.text ?? "").join("\n"), /a\.ts/);
  const freshness = await request("tools/call", { name: "index_freshness", arguments: {} });
  assert.match(freshness.content.map((item) => item.text ?? "").join("\n"), /"status": "current"/);
  assert.deepEqual([digest(aPath), digest(bPath)], originalHashes, "CLI/MCP read operations modified repository source files");
  console.log("Phase 3 CLI/MCP smoke checks passed; source files remained unchanged.");
} finally {
  if (mcp && mcp.exitCode === null) mcp.kill("SIGTERM");
  rmSync(root, { recursive: true, force: true });
}
