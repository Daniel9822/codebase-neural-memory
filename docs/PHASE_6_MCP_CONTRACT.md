# Phase 6 — MCP Contract

**Status:** Complete and formally closed on 2026-10-31. Blocks 1–3 are CI-verified; Block 4 real-client calls were manually verified in VS Code with its integrated GitHub Copilot Agent experience and in OpenCode. Recorded versions: VS Code 1.144.0 (x64), OpenCode 1.19.5, Node.js v22.12.0. No separate Copilot extension version is required for the validated VS Code installation. Block 5 regression passed in clean-checkout CI run [41250061815](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41250061815); the documentation close-out merged in PR [#47](https://github.com/Daniel9822/codebase-neural-memory/pull/47), and post-merge main CI [41250490923](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41250490923) passed.

**Post-Phase-6 extension (2026-10-31):** the current MCP server adds an eleventh read-only tool, `source_excerpt`, to close the source-inspection gap identified during Phase 8 agent evaluation. The original Phase 6 close-out and its ten-tool verification remain historical records of the contract at that time.

## Source of truth

- Tool registration and Zod input schemas: `src/adapters/mcp/server.ts`
- CLI startup and initialized-project guard: `src/cli/index.ts`
- Project-root and project-ID resolution: `src/core/project.ts`
- SDK dependency: `@modelcontextprotocol/server ^2.3.1` in `package.json`

The registered server is named `codebase-neural-memory`, reports version `0.1.0`, and uses the SDK stdio transport. The original Phase 6 registration contained ten tools. The current registration contains eleven after the `source_excerpt` follow-up; this file must be reconciled with `server.ts` whenever a tool or schema changes.

## Project binding and startup

1. The `cnm mcp` command resolves the project from the process working directory.
2. In a Git working tree, CNM uses `git rev-parse --show-toplevel`; if that fails, it searches upward for a `.git` entry; otherwise the resolved starting directory is used.
3. The root is canonicalized with `realpathSync`. The project ID is the first 20 hexadecimal characters of SHA-256 over that canonical root.
4. The database is selected under the per-user application data directory at `projects/<project-id>/memory.sqlite`.
5. Before starting MCP, the CLI checks that the project is initialized. If it is not, startup fails with `This repository is not initialized. Run \`cnm init\` first.`

The MCP client must launch the process with its working directory set to the intended repository (or a directory within that repository). CNM does not accept a project path as an MCP tool argument and does not provide a remote project selector. A different working directory can therefore bind a different local project; client configuration is part of the security boundary.

## Registered tools

All fields below are taken from the Zod schemas and handler calls in `server.ts`. “Default” means the value supplied by the adapter when the optional argument is omitted.

| Tool | Input schema | Adapter default / hard maximum | Core operation |
|---|---|---|---|
| `project_overview` | No arguments | — | `getProjectOverview(location)` |
| `index_freshness` | No arguments | 200 skipped-file details and 200 error details; totals and truncation flags | `getIndexFreshness(location)` |
| `project_map` | `limit`: optional integer, 1–200 | 80 files; 200 imports and 200 unresolved imports per file; 200 candidate paths per unresolved import; totals and truncation flags | `getProjectMapReport(location, limit)` |
| `symbol_lookup` | `query`: non-empty string; `limit`: optional integer, 1–50 | `limit`: 20 | `searchSymbols(location, query, limit)` |
| `dependency_graph` | `path`: non-empty string; `depth`: optional integer, 1–20; `limit`: optional integer, 1–100; `maxProcessed`: optional integer, 1–10,000 | `depth`: 1; `limit`: 100; `maxProcessed`: 1,000 | `findDependencies(location, path, depth, limit, maxProcessed)` |
| `file_details` | `path`: non-empty string; `limit`: optional integer, 1–500 | 100 per collection | `getFileDetails(location, path, limit)` |
| `source_excerpt` | `path`: non-empty indexed project-relative path; `startLine`, `endLine`: positive integers with end ≥ start; `maxCharacters`: optional integer, 100–20,000 | 12,000 characters; at most 200 lines and 1 MiB source file | `getSourceExcerpt(location, path, startLine, endLine, maxCharacters)` |
| `change_impact` | `path`: non-empty string; `limit`: optional integer, 1–5,000; `maxProcessed`: optional integer, 1–10,000 | `limit`: 100; `maxProcessed`: 1,000 | `findImpact(location, path, limit, maxProcessed)` |
| `task_context` | `task`: non-empty string; `maxItems`: optional integer, 1–100; `maxCharacters`: optional integer, 100–50,000 | `maxItems`: 20; `maxCharacters`: 12,000 | `buildTaskContext(location, task, options)` |
| `memory_freshness` | `limit`: optional integer, 1–500 | 100 source- or commit-linked records; total eligible count and truncation flag | `getMemoryFreshnessReport(location, limit)` |
| `memory_recall` | `query`: optional string; `limit`: optional integer, 1–50 | `query`: empty string; `limit`: 20 | `recallMemories(location, query, limit)` |

### Result and truncation behavior

- `project_map` returns a report with total indexed files, a top-level truncation flag, and per-file totals/truncation flags for resolved and unresolved imports. Nested import collections are capped at 200 per file, and each unresolved import candidate list is capped at 200 paths.
- `index_freshness` retains finite summary counters and caps `skippedFiles` and `errors` independently at 200 each. `totals` reports the full counts and `truncated` reports whether either detail list was shortened.
- `memory_freshness` accepts `limit` from 1 to 500 (default 100) and returns `records`, `total`, `limit`, and `truncated`; the database query and source hashing are also limited to the requested record count.
- `symbol_lookup` is capped at 50 results by the MCP schema.
- `dependency_graph` has independent depth, unique-result, and processed-edge budgets. The core traversal also protects against cycles and reports its traversal/truncation metadata.
- `file_details` applies the supplied limit independently to its returned collections; the core response includes collection totals and truncation indicators.
- `source_excerpt` reads only indexed files, confines lexical and canonical paths to the selected project root, and reports current-vs-indexed SHA-256 status plus line bounds and truncation.
- `change_impact` has independent affected-file and processed-relation budgets and reports processing/truncation metadata.
- `task_context` enforces both item and serialized-item-character budgets and reports budget usage/truncation.
- `memory_recall` is capped at 50 records by the MCP schema; the core API itself permits a larger limit.

The adapter's Zod limits are intentionally sometimes narrower than the corresponding core API limits. Client-facing limits in this table describe the MCP contract, not the maximum possible values of direct core calls.

## Read-only boundary

The read-only handlers call overview, freshness, map, search, graph, file-detail, source-excerpt, context-building, or memory-recall operations. No MCP tool is registered for indexing, creating/updating/deleting memories, or changing memory lifecycle state. The CLI remains responsible for those explicit write operations. The handlers do not intentionally modify repository source files or create durable memory records.

## Validation and error contract

- Input validation is declared with Zod at tool registration. Required strings must be non-empty; numeric limits are integers within the ranges in the table.
- Core operations can reject uninitialized projects, missing indexed paths, invalid core-level limits, or invalid task descriptions.
- The current handlers serialize successful results as JSON text in MCP text content.
- The adapter tests exercise the real registered server through the SDK's `InMemoryTransport`. Zod-invalid arguments and a core missing-indexed-path exception are both observed as tool results with `isError: true`.
- Repeated calls, clean in-memory transport close/reconnect, and real CLI stdio startup, EOF exit, and process reconnection are covered by `tests/mcp-adapter.test.ts` and `tests/mcp-stdio.test.ts`.
- Two concurrently running MCP servers bound to different project roots are covered by `tests/mcp-boundaries.test.ts`; distinct indexed files and memories remain isolated across repeated calls.

## Phase 6 verification status

| Area | Current evidence | Status |
|---|---|---|
| Ten-tool inventory and input schemas | Source inspection of `server.ts` | Documented |
| Client-visible defaults and bounds | Source inspection of Zod schemas and handler defaults | Documented |
| Core function mapping | Source inspection of handler calls | Documented |
| MCP protocol error envelope | Adapter tests assert `isError: true` for Zod validation and core missing-path errors | Verified in tests |
| All ten valid calls and invalid arguments | SDK in-memory tests discover all ten schemas and call all ten handlers; invalid Zod/core errors are asserted | Verified in tests |
| Bounded freshness and map reports | Exact/over/empty/incomplete discovery boundaries, totals, truncation, nested map caps, and invalid path errors are tested | Verified in CI run 41239258583 |
| Repeat calls, EOF, and reconnection | In-memory protocol test plus real CLI stdio process EOF/restart test | Verified in tests |
| Two-project process isolation | Two concurrent MCP servers tested with distinct indexed files and memories; no cross-project reads observed | Verified in CI run 41239370942 |
| OpenCode end-to-end | Installed OpenCode client connected to the workspace-scoped stdio server and successfully called `project_overview({})` and `symbol_lookup({query: "createMcpServer"})`; see `docs/CLIENT_INTEGRATION.md` | Manually verified 2026-10-31; OpenCode 1.19.5, Node.js v22.12.0 |
| VS Code end-to-end | VS Code MCP server showed Running; integrated GitHub Copilot Agent successfully called `project_overview({})` and `symbol_lookup({query: "createMcpServer"})`; see `docs/CLIENT_INTEGRATION.md` | Manually verified 2026-10-31; VS Code 1.144.0 (x64), Node.js v22.12.0; Copilot treated as part of the VS Code installation |
| Clean-checkout regression | Default-branch CI ran lockfile install, typecheck, full tests, build, and CLI/MCP smoke on merge commit `f3c74147ce6b9cad2100156a644c404b965d6f6a` | Passed in CI run 41250061815 |

## Maintenance rule

When changing `src/adapters/mcp/server.ts`, update this contract and the linked README, architecture, product specification, roadmap, and acceptance criteria in the same change. Add or update adapter tests before claiming a protocol behavior is verified.

## Regression close-out

- **Default branch:** `main` at merge commit `f3c74147ce6b9cad2100156a644c404b965d6f6a`.
- **CI:** [run 41250061815](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41250061815) — success; `npm ci --no-audit --no-fund`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run smoke` passed on GitHub-hosted Ubuntu / Node.js 22.
- **Diff review:** Phase 6 PRs #42, #43, #45, and #46 reviewed. Changes are within the intended MCP adapter/core/tests, client config templates/tests, and documentation scope.
- **Client evidence:** OpenCode and VS Code/Copilot manual calls and known version limitations are recorded in `docs/CLIENT_INTEGRATION.md`.
- **Phase 6 closure:** the user confirmed that Copilot is integrated into the validated VS Code installation; no independent extension identifier/version is required.
