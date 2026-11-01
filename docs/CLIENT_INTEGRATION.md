# MCP client integration

This guide configures the real CNM stdio server in OpenCode and Visual Studio Code. Both examples deliberately set the server working directory to the workspace being inspected. CNM derives the project identity from that process working directory; omitting it can bind the server to a different repository.

## Prerequisites

1. Use Node.js 22.12 or newer.
2. Install CNM and make the `cnm` executable available on `PATH`. From a source checkout:

   ```bash
   npm ci
   npm run build
   npm link
   ```

3. In the target repository, initialize and index it once:

   ```bash
   cnm init
   cnm index
   ```

The MCP server is read-only. Initialization and indexing are explicit CLI operations; the MCP client does not perform them.

The MCP adapter also supports optional freshness policies. Set these variables in the environment inherited by the MCP process (using the client/OS-specific environment configuration):

- `CNM_MCP_AUTO_UPDATE=1`: incrementally refresh before reads when discovery is complete and at most 50 source files changed. Otherwise the server skips the automatic update and explains that an explicit `index_update` is needed.
- `CNM_MCP_STRICT_FRESHNESS=1`: refuse indexed reads unless the index is current. If both variables are enabled, auto-update runs first and strict mode checks the resulting state.

Both are disabled by default. Auto-update is synchronous; the 50-file threshold is not a wall-clock timeout. Do not enable strict mode until the target repository has been initialized and indexed.

## OpenCode (first client)

OpenCode's local MCP configuration uses a top-level `mcp` object, `type: "local"`, an argument-array `command`, and an optional `cwd`. Copy [`examples/opencode.mcp.json`](../examples/opencode.mcp.json) to `opencode.json` at the root of the target workspace, or merge its `mcp.codebase-memory` entry into the existing file. Do not overwrite other project configuration.

The relevant entry is:

```json
{
  "type": "local",
  "command": ["cnm", "mcp"],
  "cwd": ".",
  "enabled": true,
  "timeout": 30000
}
```

From the target workspace, run:

```bash
opencode mcp list
```

The `codebase-memory` server must report a connected/ready state. If it does not, inspect the server output and confirm that `cnm` is on `PATH`, the target repository was initialized, and `cwd` resolves to the intended workspace.

Then start an OpenCode session in that same workspace and request both of these operations explicitly:

- “Call `project_overview` on the Codebase Memory MCP server and report the project root and indexed-file count.”
- “Call `symbol_lookup` with a symbol name that exists in this repository and report its file path.”

Verify the returned project and source path belong to the open workspace. A connected status alone is discovery evidence, not proof that a tool call succeeded.

## Visual Studio Code (second client)

VS Code uses a workspace `.vscode/mcp.json` file with a top-level `servers` object. Copy [`examples/vscode.mcp.json`](../examples/vscode.mcp.json) to `.vscode/mcp.json` in the target workspace, creating the directory if needed. Merge the server entry if the file already exists.

The relevant entry is:

```json
{
  "type": "stdio",
  "command": "cnm",
  "args": ["mcp"],
  "cwd": "${workspaceFolder}"
}
```

Open the target workspace in VS Code and trust it only after reviewing the MCP configuration. Open the Command Palette and run **MCP: List Servers**. Start `codebase-memory` if it is not already running, and inspect its output if startup fails.

In a GitHub Copilot Agent session, explicitly ask it to call `project_overview`, then `symbol_lookup` for a known symbol. Confirm that the returned project and source path belong to the open workspace. A server appearing in the list is discovery evidence; the successful tool response is the call evidence.

VS Code's workspace MCP format uses `servers`; the portable Copilot `.mcp.json` format uses `mcpServers` and does not support a `cwd` field. Use the workspace `.vscode/mcp.json` format here because explicit workspace binding is a CNM requirement.

## Evidence to record

For each client, record:

- Client name and exact version.
- OS and Node.js version.
- The configuration file path and effective `command` / `cwd`.
- The observed connected/ready state and the ten discovered tool names (where the client exposes them).
- The exact tool names called and a short, redacted result proving the project root/source path.
- Any startup errors or platform-specific limitations.

Do not record repository source contents, personal paths, secrets, or private memory text in public issue/PR evidence. Redact absolute home-directory paths.

## Manual client execution evidence

**Execution date:** 2026-10-31  
**Target workspace:** the local `codebase-neural-memory` repository (absolute user-specific path intentionally redacted).  
**Platform evidence:** Windows PowerShell; VS Code reported x64. The exact Windows edition was not captured.  
**Observed versions:** VS Code `1.144.0` (commit `2c33b50b16c472efe58357d1d2a8a5414bc23fbf`, x64); OpenCode `1.19.5`; Node.js `v22.12.0`.  
**GitHub Copilot:** The user confirmed that Copilot is integrated into the validated VS Code installation. Record the client as VS Code 1.144.0 with its integrated Copilot Agent experience; no separate extension identifier/version is required for this environment.

| Client | Configuration / discovery | Real calls observed | Result |
|---|---|---|---|
| VS Code + GitHub Copilot Agent | Workspace `.vscode/mcp.json`; `MCP: List Servers` showed `codebase-memory` running | `project_overview({})`; `symbol_lookup({"query":"createMcpServer"})` | Both successful |
| OpenCode | Workspace `opencode.json`; local stdio server `codebase-memory` connected | `project_overview({})`; `symbol_lookup({"query":"createMcpServer"})` | Both successful |

Both clients returned the same indexed workspace metrics: 25 files, 135 symbols, 171 relations, index revision 1, last indexed at `2026-10-31T22:08:46.961Z`. Both located the exported function `createMcpServer(location: ProjectLocation): McpServer` at lines 12–102 using FTS5. Copilot reported the file as `server.ts`; OpenCode reported the repository-relative path `src/adapters/mcp/server.ts`.

These are manual end-to-end client calls, not simulated SDK calls. The test used the CNM repository itself as the target workspace; it validates client startup, discovery, workspace binding, and tool invocation, but does not replace the separate automated two-project isolation tests from Block 3.

**Evidence status:** Both real-client integrations are verified. The exact Windows edition was not captured and is an optional environment detail, not a Phase 6 exit criterion. Copilot is recorded as integrated in the validated VS Code 1.144.0 installation.

## Troubleshooting

- **Server does not start:** verify the `cnm` executable is on the environment `PATH` inherited by the client.
- **“This repository is not initialized”:** run `cnm init` in the target workspace, then `cnm index`.
- **Wrong project is reported:** set `cwd` explicitly to the target workspace; do not rely on the editor's inherited process directory.
- **Tools are missing after a config change:** restart the server/client or use the client's MCP refresh/reset command.
- **VS Code restricted mode:** workspace MCP servers do not start until the workspace is trusted. Review the configuration before granting trust.

## Official client references

- [OpenCode MCP servers](https://docs.opencode.ai/docs/mcp-servers/)
- [OpenCode CLI — MCP list](https://dev.opencode.ai/docs/cli/)
- [VS Code MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)
- [VS Code — Add MCP servers](https://code.visualstudio.com/docs/agent-customization/mcp-servers)
