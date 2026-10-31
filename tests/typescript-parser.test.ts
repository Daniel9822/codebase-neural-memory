import { describe, expect, it } from "vitest";
import { parseTypeScriptFile } from "../src/core/typescript-parser.js";

describe("parseTypeScriptFile", () => {
  it("extracts exported declarations, imports, and local function calls", () => {
    const source = `import { helper } from "./helper";\n\nexport function runTask() {\n  helper();\n}\n\nclass Worker {\n  execute() { runTask(); }\n}`;
    const parsed = parseTypeScriptFile("src/task.ts", source);

    expect(parsed.imports).toContain("./helper");
    expect(parsed.symbols.map((symbol) => symbol.name)).toContain("runTask");
    expect(parsed.symbols.map((symbol) => symbol.name)).toContain("Worker");
    expect(parsed.symbols.map((symbol) => symbol.name)).toContain("Worker.execute");
    expect(parsed.calls).toContainEqual({ callerName: "runTask", calleeName: "helper" });
    expect(parsed.calls).toContainEqual({ callerName: "Worker.execute", calleeName: "runTask" });
  });
  it("rejects malformed source and includes a source location", () => {
    expect(() => parseTypeScriptFile("broken.ts", "export function broken( {"))
      .toThrow(/broken\.ts:1:/);
  });
});
