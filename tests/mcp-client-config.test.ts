import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("real MCP client configuration templates", () => {
  it("configures OpenCode local stdio with an explicit workspace cwd", () => {
    const config = JSON.parse(
      readFileSync(new URL("../examples/opencode.mcp.json", import.meta.url), "utf8"),
    ) as {
      mcp: Record<string, {
        type: string;
        command: string[];
        cwd?: string;
        enabled?: boolean;
      }>;
    };
    const server = config.mcp["codebase-memory"];

    expect(server).toBeDefined();
    expect(server?.type).toBe("local");
    expect(server?.command).toEqual(["cnm", "mcp"]);
    expect(server?.cwd).toBe(".");
    expect(server?.enabled).toBe(true);
  });

  it("configures VS Code workspace stdio with the workspace folder as cwd", () => {
    const config = JSON.parse(
      readFileSync(new URL("../examples/vscode.mcp.json", import.meta.url), "utf8"),
    ) as {
      servers: Record<string, {
        type: string;
        command: string;
        args: string[];
        cwd?: string;
      }>;
    };
    const server = config.servers["codebase-memory"];

    expect(server).toBeDefined();
    expect(server?.type).toBe("stdio");
    expect(server?.command).toBe("cnm");
    expect(server?.args).toEqual(["mcp"]);
    expect(server?.cwd).toBe("${workspaceFolder}");
  });
});
