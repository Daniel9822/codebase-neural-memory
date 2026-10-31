# Phase 6 — MCP Contract

**Status:** Blocks 1 and 2 are implemented and CI-verified on 2026-10-31; Blocks 3–5 remain open. This document records the implemented contract; it does not claim that Phase 6 integration acceptance has passed.

## Source of truth

- Tool registration and Zod input schemas: `src/adapters/mcp/server.ts`
- CLI startup and initialized-project guard: `src/cli/index.ts`
- Project-root and project-ID resolution: `src/core/project.ts`
- SDK dependency: `@modelcontextprotocol/server ^2.3.1` in `package.json`

The registered server is named `codebase-neural-memory`, reports version `0.1.0`, and uses the SDK stdio transport. The source registration currently contains exactly ten tools. This file must be reconciled with `server.ts` whenever a tool or schema changes.

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
| `index_freshness` | No arguments | —; output detail arrays are currently unbounded | `getIndexFreshness(location)` |
| `project_map` | `limit`: optional integer, 1–200 | 80; no total/truncated fields in current result | `getProjectMap(location, limit)` |
| `symbol_lookup` | `query`: non-empty string; `limit`: optional integer, 1–50 | `limit`: 20 | `searchSymbols(location, query, limit)` |
| `dependency_graph` | `path`: non-empty string; `depth`: optional integer, 1–20; `limit`: optional integer, 1–100; `maxProcessed`: optional integer, 1–10,000 | `depth`: 1; `limit`: 100; `maxProcessed`: 1,000 | `findDependencies(location, path, depth, limit, maxProcessed)` |
| `file_details` | `path`: non-empty string; `limit`: optional integer, 1–500 | 100 per collection | `getFileDetails(location, path, limit)` |
| `change_impact` | `path`: non-empty string; `limit`: optional integer, 1–5,000; `maxProcessed`: optional integer, 1–10,000 | `limit`: 100; `maxProcessed`: 1,000 | `findImpact(location, path, limit, maxProcessed)` |
| `task_context` | `task`: non-empty string; `maxItems`: optional integer, 1–100; `maxCharacters`: optional integer, 100–50,000 | `maxItems`: 20; `maxCharacters`: 12,000 | `buildTaskContext(location, task, options)` |
| `memory_freshness` | No arguments | —; returns all eligible records | `inspectMemoryFreshness(location)` |
| `memory_recall` | `query`: optional string; `limit`: optional integer, 1–50 | `query`: empty string; `limit`: 20 | `recallMemories(location, query, limit)` |

### Result and truncation behavior

- `project_map` is capped at 200 files by the MCP schema, but the current core return type is only an array: it does not include a total count or a truncation flag. A caller cannot distinguish a complete map from a map cut off by the limit.
- `index_freshness` has no input limit. Its summary counters are finite, but `skippedFiles` and `errors` contain discovery details without an adapter-level cap or truncation metadata.
- `memory_freshness` has no input limit and returns every eligible memory-source record; the current response has no total count or truncation metadata.
- `symbol_lookup` is capped at 50 results by the MCP schema.
- `dependency_graph` has independent depth, unique-result, and processed-edge budgets. The core traversal also protects against cycles and reports its traversal/truncation metadata.
- `file_details` applies the supplied limit independently to its returned collections; the core response includes collection totals and truncation indicators.
- `change_impact` has independent affected-file and processed-relation budgets and reports processing/truncation metadata.
- `task_context` enforces both item and serialized-item-character budgets and reports budget usage/truncation.
- `memory_recall` is capped at 50 records by the MCP schema; the core API itself permits a larger limit.

The adapter's Zod limits are intentionally sometimes narrower than the corresponding core API limits. Client-facing limits in this table describe the MCP contract, not the maximum possible values of direct core calls.

## Read-only boundary

The ten handlers call overview, freshness, map, search, graph, file-detail, context-building, or memory-recall operations. No MCP tool is registered for indexing, creating/updating/deleting memories, or changing memory lifecycle state. The CLI remains responsible for those explicit write operations. The handlers do not intentionally modify repository source files or create durable memory records.

## Validation and error contract

- Input validation is declared with Zod at tool registration. Required strings must be non-empty; numeric limits are integers within the ranges in the table.
- Core operations can reject uninitialized projects, missing indexed paths, invalid core-level limits, or invalid task descriptions.
- The current handlers serialize successful results as JSON text in MCP text content.
- The adapter tests exercise the real registered server through the SDK's `InMemoryTransport`. Zod-invalid arguments and a core missing-indexed-path exception are both observed as tool results with `isError: true`.
- Repeated calls, clean in-memory transport close/reconnect, and real CLI stdio startup, EOF exit, and process reconnection are covered by `tests/mcp-adapter.test.ts` and `tests/mcp-stdio.test.ts`.
- **Not yet verified:** isolation across two concurrently running project processes. This remains a Block 3 requirement.

## Phase 6 verification status

| Area | Current evidence | Status |
|---|---|---|
| Ten-tool inventory and input schemas | Source inspection of `server.ts` | Documented |
| Client-visible defaults and bounds | Source inspection of Zod schemas and handler defaults | Documented |
| Core function mapping | Source inspection of handler calls | Documented |
| MCP protocol error envelope | Adapter tests assert `isError: true` for Zod validation and core missing-path errors | Verified in tests |
| All ten valid calls and invalid arguments | SDK in-memory tests discover all ten schemas and call all ten handlers; invalid Zod/core errors are asserted | Verified in tests |
| Repeat calls, EOF, and reconnection | In-memory protocol test plus real CLI stdio process EOF/restart test | Verified in tests |\n| Two-project process isolation | Project identity is path-derived; MCP-specific two-process proof not present in the reviewed tests | Pending |
| OpenCode end-to-end | Not evidenced by the reviewed source/docs | Pending |
| Second real MCP client | Not evidenced by the reviewed source/docs | Pending |

## Maintenance rule

When changing `src/adapters/mcp/server.ts`, update this contract and the linked README, architecture, product specification, roadmap, and acceptance criteria in the same change. Add or update adapter tests before claiming a protocol behavior is verified.
