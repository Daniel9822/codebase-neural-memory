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
    expect(parsed.calls).toContainEqual({ callerName: "runTask", calleeName: "helper", moduleSpecifier: "./helper", importedSymbolName: "helper" });
    expect(parsed.calls).toContainEqual({ callerName: "Worker.execute", calleeName: "runTask" });
  });
  it("extracts class and interface heritage declarations", () => {
    const parsed = parseTypeScriptFile("src/models.ts", `
      interface BaseContract {}
      interface ExtendedContract extends BaseContract {}
      class BaseClass {}
      class Worker extends BaseClass implements ExtendedContract {}
    `);
    expect(parsed.heritage).toEqual([
      { ownerName: "ExtendedContract", relationKind: "EXTENDS", targetName: "BaseContract" },
      { ownerName: "Worker", relationKind: "EXTENDS", targetName: "BaseClass" },
      { ownerName: "Worker", relationKind: "IMPLEMENTS", targetName: "ExtendedContract" },
    ]);
  });
  it("rejects malformed source and includes a source location", () => {
    expect(() => parseTypeScriptFile("broken.ts", "export function broken( {"))
      .toThrow(/broken\.ts:1:/);
  });
});
