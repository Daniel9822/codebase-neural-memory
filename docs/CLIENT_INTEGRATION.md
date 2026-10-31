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
