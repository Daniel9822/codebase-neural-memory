import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectLocation } from "./project.js";

export type AgentTool = "opencode" | "claude" | "cursor" | "generic";

const START = "<!-- cnm:agent-instructions:start -->";
const END = "<!-- cnm:agent-instructions:end -->";

function readAgentFile(path: string): string | null {
  try {
    const info = lstatSync(path);
    if (!info.isFile()) throw new Error("AGENTS.md must be a regular file; CNM will not follow symlinks or overwrite directories.");
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function instructions(tool: AgentTool): string {
  const toolNote = tool === "generic"
    ? "These instructions are tool-agnostic. Configure your MCP client to start `cnm mcp` with the repository root as its working directory."
    : `These instructions apply to ${tool}. Configure its MCP integration to start \`cnm mcp\` with this repository root as the working directory.`;
  return `# Codebase Neural Memory — Agent workflow

${toolNote}

## 1. Session initialization
- Call \`memory_recall\` with a natural-language description of the task; use \`list: true\` when you need to inspect all recent memories. Review lifecycle status before relying on a result.
- Treat \`confirmed\` memories as project knowledge. \`proposed\` memories are suggestions, not facts; \`obsolete\` memories are historical context and must not be treated as current guidance.
- Call \`index_freshness\`. Use its exact paths and hashes to understand drift; do not run \`git status\` solely to discover source changes.
- If freshness is \`stale\`, call \`index_update\` once, then re-check freshness. Do not loop automatic refresh calls. If discovery is incomplete, explain the gap and verify affected files directly.

## 2. MCP-first source retrieval
- Start with \`symbol_lookup\`, narrowing by \`kind\`, \`filePath\`, or \`exported\`; request \`includeSource\` for the one to three relevant symbols.
- Use \`file_details\` with \`inlineSnippets\` for a focused file view.
- Use \`source_excerpt\` only for exact line ranges returned by CNM.
- For broad tasks, call \`task_context\` with explicit \`anchors.paths\` and/or \`anchors.symbols\`.
- Use \`dependency_graph\` with low \`depth\` first; expand only when evidence requires it.
- An empty result means “not found by this retrieval method”, not “does not exist”.

## 3. Freshness and source verification
- Trust indexed structure only when the result is current. A freshness warning or \`indexStatus: stale\` means verify the current file before editing or describing exact line ranges.
- Source excerpts include hashes. Compare them with indexed hashes and do not mix metadata from one revision with source from another.
- Inspect `file_details.importDiagnostics` (and `project_map.importDiagnostics`) for TypeScript semantic import diagnostics, including missing packages and missing exports. These diagnostics cover supported indexed files and are not a complete compiler run; absence of a diagnostic is not proof that every import or binding is valid.

## 4. External reads and safety boundaries
- Read files outside the index when needed for Markdown, assets, JSON/configuration, package manifests, tests, compiler output, or files CNM cannot represent.
- Never read or copy secrets such as \`.env\`, private keys, credentials, or authentication histories into memory or agent instructions.
- Verify exact diffs and generated artifacts from disk when the task requires byte-level truth.

## 5. Editing and validation
- Before editing, inspect the current source excerpt and its freshness/hash.
- After editing, run \`index_update\` and re-check relevant symbols/ranges if lines or structure moved.
- Run the repository's compiler, build, and relevant tests. CNM is a structural map, not a compiler or test runner.
- Review the final diff; distinguish verified results from assumptions.

## 6. Project memory — proactive and durable
- During work, identify durable knowledge worth preserving: architectural decisions, stable conventions, important workflows, non-obvious behavior, recurring failure causes, and verified fixes. Do not save transient details, secrets, speculation, or unverified guesses.
- You may create a \`memory_propose\` entry proactively when such knowledge is established. Include a precise title, concise reusable explanation, suitable category (\`decision\`, \`convention\`, \`architectural\`, or \`gotcha\`), and \`sourcePath\` / \`commitSha\` when grounded.
- Proposed memories are immediately discoverable through \`memory_recall\`, but are not confirmed truth. Label them as pending when presenting them.
- Ask the user whether they want a proposal confirmed. If the user explicitly says yes (including “confirm it”, “approve”, or equivalent clear authorization), call \`memory_transition\` with status \`confirmed\`; do not ask for a second approval. If the user declines, use \`rejected\` only when appropriate or leave the proposal pending.
- Never confirm a proposal merely because the agent believes it is useful. Explicit user authorization is the approval boundary.
- Revisit relevant confirmed memories during later tasks and flag them for review when \`memory_freshness\` reports changed, missing, unsafe, or non-current source/commit provenance.

## 7. Known limitations
- CNM retrieval is lexical and structural, not a guarantee of semantic completeness. Read source bodies and tests before inferring behavior.
- CNM records TypeScript semantic import diagnostics for supported indexed files and exposes them through `file_details` and `project_map`. Coverage depends on TypeScript project configuration and supported static imports; dynamic resolution and unindexed files may remain outside the analysis. Run the project's compiler/build and tests before claiming a change is healthy.
- A clean index does not prove the application works; run the project's validation commands.

## 8. End-of-task memory review
- Before finishing, consider whether the task produced a durable decision, convention, architectural fact, gotcha, or verified operational fix.
- Propose only meaningful reusable knowledge; avoid duplicate or overly narrow memories.
- Tell the user what was proposed and its status, and whether explicit confirmation is still needed.
`;
}

function managedBlock(tool: AgentTool): string {
  if (!["opencode", "claude", "cursor", "generic"].includes(tool)) throw new Error(`Unsupported agent tool: ${tool}`);
  const body = instructions(tool).trim();
  const hash = createHash("sha256").update(body).digest("hex");
  return [START, `<!-- Generated by cnm 0.1.0; tool=${tool}; sha256=${hash}. Edit outside this managed block. -->`, body, END].join("\n");
}

export interface AgentInstructionsResult {
  path: string;
  status: "created" | "updated" | "current" | "missing" | "outdated";
  content: string;
}

export function renderAgentInstructions(tool: AgentTool = "generic"): string {
  if (!["opencode", "claude", "cursor", "generic"].includes(tool)) throw new Error(`Unsupported agent tool: ${tool}`);
  return managedBlock(tool);
}

function isIntactManagedBlock(block: string): boolean {
  const lines = block.split("\n");
  const header = lines[1]?.match(/^<!-- Generated by cnm [^;]+; tool=[^;]+; sha256=([a-f0-9]{64})\. Edit outside this managed block\. -->$/);
  if (!header || lines[0] !== START || lines.at(-1) !== END) return false;
  const body = lines.slice(2, -1).join("\n");
  return createHash("sha256").update(body).digest("hex") === header[1];
}

/** Keep user-authored AGENTS.md content intact and own only the marked CNM section. */
export function ensureAgentInstructions(location: ProjectLocation, tool: AgentTool = "generic", force = false): AgentInstructionsResult {
  const path = join(location.rootPath, "AGENTS.md");
  const generated = managedBlock(tool);
  const existingFile = readAgentFile(path);
  const exists = existingFile !== null;
  const existing = existingFile ?? "";
  const start = existing.indexOf(START);
  const end = existing.indexOf(END);
  let next: string;
  let status: AgentInstructionsResult["status"];
  if (!exists) {
    next = generated + "\n";
    status = "created";
  } else if (start >= 0 && end >= start) {
    const oldBlock = existing.slice(start, end + END.length);
    if (oldBlock === generated) return { path, status: "current", content: existing };
    if (!force && !isIntactManagedBlock(oldBlock)) {
      return { path, status: "outdated", content: existing };
    }
    next = existing.slice(0, start) + generated + existing.slice(end + END.length);
    status = "updated";
  } else {
    next = existing.replace(/\s*$/, "") + "\n\n" + generated + "\n";
    status = "updated";
  }
  writeFileSync(path, next, "utf8");
  return { path, status, content: next };
}

export function checkAgentInstructions(location: ProjectLocation, tool: AgentTool = "generic"): AgentInstructionsResult {
  const path = join(location.rootPath, "AGENTS.md");
  const existing = readAgentFile(path);
  if (existing === null) return { path, status: "missing", content: "" };
  const start = existing.indexOf(START);
  const end = existing.indexOf(END);
  if (start < 0 || end < start) return { path, status: "outdated", content: existing };
  const actual = existing.slice(start, end + END.length);
  return { path, status: actual === managedBlock(tool) ? "current" : "outdated", content: existing };
}
