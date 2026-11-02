# Phase 6 — MCP Contract

**Status:** Complete and formally closed on 2026-10-31. Blocks 1–3 are CI-verified; Block 4 real-client calls were manually verified in VS Code with its integrated GitHub Copilot Agent experience and in OpenCode. Recorded versions: VS Code 1.144.0 (x64), OpenCode 1.19.5, Node.js v22.12.0. No separate Copilot extension version is required for the validated VS Code installation. Block 5 regression passed in clean-checkout CI run [41250061815](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41250061815); the documentation close-out merged in PR [#47](https://github.com/Daniel9822/codebase-neural-memory/pull/47), and post-merge main CI [41250490923](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41250490923) passed.

**Post-Phase-6 extensions:** `source_excerpt` added bounded source inspection; the follow-up adds `index_update` and `memory_propose`. The original Phase 6 ten-tool close-out remains historical evidence only.

## Source of truth

- Tool registration and Zod input schemas: `src/adapters/mcp/server.ts`
- CLI startup and initialized-project guard: `src/cli/index.ts`
- Project-root and project-ID resolution: `src/core/project.ts`
- SDK dependency: `@modelcontextprotocol/server ^2.3.1` in `package.json`

The registered server is named `codebase-neural-memory`, reports version `0.1.0`, and uses the SDK stdio transport. The original Phase 6 registration contained ten tools. The current registration has 18 tools, including subsequent additions such as `source_excerpt`, `index_update`, `component_map`, `memory_propose`, `memory_transition`, `symbol_impact`, `git_blame`, and `git_history`; this file must be reconciled with `server.ts` whenever a tool or schema changes.

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
| `index_freshness` | No arguments | 200 per-file change records (path, status, old/new SHA-256); 200 skipped-file details and 200 error details; totals, truncation flags, and `relationsConfigChanged` | `getIndexFreshness(location)` |
| `index_update` | `paths`: optional array of 1–100 project-relative file/directory paths (1–500 chars each); `include`: optional array of 1–100 include glob patterns (1–500 chars each); `maxFiles`: optional integer, 1–10,000; `maxProcessed`: optional integer, 1–100,000 | Incremental reconciliation using persisted exclusions; selective scope is the intersection of paths and include patterns; `maxFiles` selects candidates deterministically and reports `truncated`; exceeding `maxProcessed` aborts without writes rather than committing a filesystem-order-dependent partial selection; selective updates do not perform deletion reconciliation; `errors` and `skippedFiles` return at most 200 sorted details each with exact totals and per-list truncation flags | `updateProjectIndex(location, options)` |
| `project_map` | `limit`: optional integer, 1–200 | 80 files; 200 imports, unresolved imports, and TypeScript import diagnostics per file; 200 candidate paths per unresolved import and a 2,000-path global budget across the returned files; exact candidate totals and per-import/global truncation metadata | `getProjectMapReport(location, limit)` |
| `symbol_lookup` | `query`: non-empty string, max 1,000 characters; `limit`: optional integer, 1–50; `kind`: optional string; `filePath`: optional project-relative path prefix; `exported`: optional boolean; `includeSource`: optional object with `maxLines` 1–100 | `limit`: 20; source snippets default to 60 lines and 8,000 characters | `searchSymbols`; optional bounded `getSourceExcerpt` per result |
| `dependency_graph` | `path`: non-empty string, max 500 characters; `depth`: optional integer, 1–20; `limit`: optional integer, 1–100; `maxProcessed`: optional integer, 1–10,000 | `depth`: 1; `limit`: 100; `maxProcessed`: 1,000 | `findDependencies(location, path, depth, limit, maxProcessed)` |
| `file_details` | `path`: non-empty string, max 500 characters; `limit`: optional integer, 1–500; `inlineSnippets`: optional boolean; `snippetLimit`: optional integer, 1–10; `snippetMaxLines`: optional integer, 1–100 | 100 per collection, including TypeScript import diagnostics; unresolved-import candidates are capped at 200 per import and 2,000 globally; at most 3 inline snippets by default, 60 lines and 8,000 characters each | `getFileDetails`; returns bounded `importDiagnostics` (missing packages/exports) and optional bounded `getSourceExcerpt` for the first symbols |
| `source_excerpt` | `path`: non-empty indexed project-relative path, max 500 characters; `startLine`, `endLine`: positive integers with end ≥ start; `maxCharacters`: optional integer, 100–20,000 | 12,000 characters; at most 200 lines and 1 MiB source file | `getSourceExcerpt(location, path, startLine, endLine, maxCharacters)` |
| `change_impact` | `path`: non-empty string, max 500 characters; `limit`: optional integer, 1–5,000; `maxProcessed`: optional integer, 1–10,000 | `limit`: 100; `maxProcessed`: 1,000 | `findImpact(location, path, limit, maxProcessed)` |
| `git_blame` | `path`: non-empty project-relative path (1–500); `startLine`, `endLine`: positive integers with end ≥ start and range ≤ 200 lines | No implicit broad range; caller supplies explicit line bounds | `getGitBlame(rootPath, path, startLine, endLine)`; read-only Git line attribution |
| `git_history` | `limit`: optional integer, 1–50; `maxPaths`: optional integer, 1–500 | 20 commits; 200 changed paths; Git subprocess timeout 3 seconds; output cap 2 MiB; returns `truncated` and `truncatedPaths` | `getGitHistory(rootPath, limit, maxPaths)`; read-only commit metadata and changed-path evidence. Commit boundaries are not treated as agent sessions, and commit messages do not establish intent |
| `symbol_impact` | `symbol`: exact non-empty name; optional `filePath` (1–500), `kind` (1–100), `startLine` (positive integer), `direction` (`incoming` or `outgoing`), `depth` (1–20), `limit` (1–500), `maxProcessed` (1–10,000), and unique `relationKinds` from `CALLS`, `EXTENDS`, `IMPLEMENTS` | `direction`: `incoming`; `depth`: 3; `limit`: 100; `maxProcessed`: 1,000; all three relation kinds | `findSymbolImpact(location, symbol, options)`; breadth-first traversal returns shortest distances and per-edge evidence; ambiguous roots are returned as candidates without traversal |
| `task_context` | `task`: non-empty string, max 2,000 characters; `maxItems`: optional integer, 1–100; `maxCharacters`: optional integer, 100–50,000; `symbolLimit`, `fileLimit`, `dependencyLimit`, `testLimit`, `memoryLimit`: optional integers, 1–50; `anchors`: optional object with up to 20 project-relative paths and/or 20 exact symbol names (at least one required) | `maxItems`: 20; `maxCharacters`: 12,000; `symbolLimit`: 20; `fileLimit`: 10; `dependencyLimit`: 20; `testLimit`: 20; `memoryLimit`: 20; lexical test-path discovery scans at most 500 paths matching test-directory or `.test`/`.spec` filename patterns and reports truncation | `buildTaskContext(location, task, options)` |
| `memory_propose` | `title`: 1–300 chars; `content`: 1–10,000 chars; optional `category` (1–80), `sourcePath` (1–500), `commitSha` (1–100) | Saves status `proposed`; human confirmation remains explicit | `proposeMemory(...)` |
| `memory_freshness` | `limit`: optional integer, 1–500 | 100 source- or commit-linked records; total eligible count and truncation flag | `getMemoryFreshnessReport(location, limit)` |
| `memory_recall` | `query`: optional string (max 1,000); `limit`: optional integer, 1–50; `status`: optional lifecycle status; `category`: optional string (1–80); `list`: optional boolean | `query`: empty string; `limit`: 20; proposed/confirmed/obsolete included by default; rejected excluded unless explicitly filtered | `recallMemoriesReport(location, query, limit, options)` with natural-language lexical scoring, lifecycle/category filters, total eligible count, processed-candidate count, output limit, and truncation flag |
| `memory_transition` | `id`: UUID; `status`: `proposed`, `confirmed`, `obsolete`, or `rejected` | Explicit lifecycle transition only; confirmation requires prior clear user authorization by the calling agent | `transitionMemory(location, id, status)` |

### Result and truncation behavior

- `index_update` preserves exact `scanned`, `added`, `updated`, `unchanged`, `deleted`, `symbols`, `relations`, `skipped`, and `failed` counters. Diagnostic `errors` and `skippedFiles` are sorted and capped independently at 200 entries; `totals`, `limits.detailItems`, and `detailsTruncated` expose the full counts and omissions. This bounds MCP/CLI response materialization without changing indexing selection or persistence.

- `task_context` keeps nested unresolved-import evidence to at most five imports and five candidate paths per import in each file detail; `candidatesTruncated` remains true when this presentation subset omits paths.
- `file_details` returns at most 200 candidate paths per unresolved import and 2,000 candidate paths globally for the selected file. Each import reports `candidatesTotal` and `candidatesTruncated`; top-level `totals.candidatePaths`, `limits.candidateBudget`, and `truncated.candidatePaths` expose aggregate omissions. Candidate JSON is expanded only into the bounded result rows, not decoded wholesale into JavaScript arrays.
- `project_map` returns a report with total indexed files, a top-level truncation flag, and per-file totals/truncation flags for resolved imports, unresolved local imports, and TypeScript-backed external import diagnostics. Each nested collection is capped at 200 per file. Candidate paths are capped at 200 per unresolved import and 2,000 globally across the returned files; candidate totals and per-import/global truncation metadata make omitted candidates explicit. Candidate arrays remain fully persisted in SQLite; retrieval selects only the bounded, deterministically ordered paths instead of decoding every candidate array into application memory. External diagnostics identify unresolved packages and invalid named/default exports; they do not replace the project compiler/build.
- `index_freshness` returns deterministic per-file `fileChanges` for added, changed, and deleted indexed source paths. Each entry includes `path`, `status`, `oldHash`, and `newHash` (SHA-256; null when the file did not exist on that side). The list is capped at 200 and exposes `fileChangesTotal` plus `fileChangesTruncated`. It also caps `skippedFiles` and `errors` independently at 200 each; `totals` and `truncated` report their full counts and truncation.
- `memory_freshness` accepts `limit` from 1 to 500 (default 100) and returns `records`, `total`, `limit`, and `truncated`; the database query and source hashing are also limited to the requested record count.
- `task_context` scans at most 500 paths matching test-directory or `.test`/`.spec` filename patterns for lexical fallback; when a 501st candidate exists, it marks the test kind as truncated and warns that matching tests may be missing. Graph-derived tests and explicit anchors remain independent of this lexical fallback window.
- `memory_recall` applies lifecycle and category filters in SQLite before candidate selection. Relevance ranking examines at most 5,000 newest eligible records and returns `totalEligible`, `processedCandidates`, `limit`, and `truncated`; the flag is true when the candidate window or requested output limit omits eligible/matching records. This is bounded lexical recall, not a completeness guarantee. `task_context` propagates a warning when its 500-record memory candidate pool is truncated.
- `symbol_lookup` accepts queries up to 1,000 characters in both the MCP schema and core API, and is capped at 50 results by the MCP schema. Kind, project-relative path-prefix, and export filters are applied in the database query before the 1,000-candidate ceiling, so non-matching candidates cannot consume the search budget ahead of matching rows. Candidate selection and final ranking use deterministic tie-breaks; the candidate ceiling remains a bounded-search limit, not a claim of semantic completeness.
- `dependency_graph` has independent depth, unique-result, and processed-edge budgets. The core traversal also protects against cycles and reports its traversal/truncation metadata.
- `file_details` applies the supplied limit independently to its returned collections; the core response includes collection totals and truncation indicators.
- `source_excerpt` reads only indexed files, confines lexical and canonical paths to the selected project root, and reports current-vs-indexed SHA-256 status plus line bounds and truncation.
- `change_impact` has independent affected-file and processed-relation budgets and reports processing/truncation metadata.
- `symbol_lookup` routes queries containing literal LIKE wildcard characters (`%`, `_`, or backslash) through the escaped LIKE fallback rather than FTS5, preserving literal matching semantics.
- Test files with recognized `it`/`test`/`specify`/`fit`/`xit`/`xtest` callback registrations add non-exported `test-case` symbols; imported calls inside those callbacks are indexed as normal `CALLS` edges, allowing `symbol_impact` to map a source symbol back to concrete test cases. This is static syntax evidence, not runtime coverage.
- `symbol_impact` performs bounded breadth-first traversal over symbol-level `CALLS`, `EXTENDS`, and `IMPLEMENTS` edges. `distance` is the shortest edge count from the selected root; `path` and `chainEvidence` preserve each intermediate symbol and the original directed edge evidence. Ambiguous names are not merged: callers must narrow by `filePath`, `kind`, and/or `startLine`. `processedRelations`, effective limits, and `truncated` are explicit.
- `task_context` enforces total item/serialized-character budgets plus independent symbol, file, dependency, test, and memory item budgets; `budget.perKind` reports each limit and accepted count, while `budget.truncatedKinds` identifies categories cut by their own item caps.
- `memory_recall` is capped at 50 records by the MCP schema; natural-language matching ranks title/content/category token overlap, and `list: true` returns recent entries without query scoring. Proposed entries are included by default and retain their status label. Rejected entries are excluded by default but can be explicitly requested with `status: "rejected"`.

The adapter's Zod limits are intentionally sometimes narrower than the corresponding core API limits. Client-facing limits in this table describe the MCP contract, not the maximum possible values of direct core calls.

## Freshness policy for every indexed read

Every indexed read checks source/index freshness before executing and revalidates the snapshot after the operation. Strict mode refuses a changed source snapshot or index revision; non-strict mode appends a post-read consistency warning. When the index is not current, the handler preserves the original JSON payload as its first text block and appends a separate, explicit warning containing the freshness state, changed/added/deleted counts, affected paths (up to 20), and the corrective action. This applies to project overview/map, symbol lookup, dependency graph, file details, source excerpts, impact, task context, and memory reads. index_freshness remains the diagnostic source and reports up to 200 exact file changes with old/new SHA-256 hashes.

Two opt-in server policies are available through environment variables:

- CNM_MCP_AUTO_UPDATE=1: before an indexed read, perform one incremental reconciliation if the index is stale. Automatic refresh is skipped when discovery is incomplete or more than 50 source files changed; the response explains why and requires an explicit index_update. The default is off.
- CNM_MCP_STRICT_FRESHNESS=1: refuse indexed reads unless the freshness state is current, returning status: refused and an actionable hint. The adapter revalidates after the operation too; a changed source snapshot or index revision is refused in strict mode. The default is off.

When both are enabled, auto-update runs first and strict mode evaluates the resulting state. The refresh is synchronous; the 50-file safety threshold bounds automatic change volume, not wall-clock time. A filesystem race after the freshness check remains possible, so source-bearing responses retain their own hash/status (source_excerpt, includeSource, and inlineSnippets). No policy writes repository source files.

### Inline source and anchored context

- symbol_lookup.includeSource: adds a bounded source excerpt to each returned symbol, including actual source hash, indexed hash, and indexStatus.
- file_details.inlineSnippets: adds source to at most snippetLimit (default 3) symbols, each bounded by snippetMaxLines (default 60; maximum 100) and 8,000 characters.
- task_context category limits: `symbolLimit`, `fileLimit`, `dependencyLimit`, `testLimit`, and `memoryLimit` independently cap each item category (1–50); total `maxItems` and `maxCharacters` remain final response-wide budgets.
- task_context.anchors: when supplied, disables broad task-query symbol fallback and builds the central context from exact symbol-name and/or project-relative path anchors. Every item carries origin: anchor | graph | fallback so callers can prioritize anchor facts over graph expansion and fallback candidates.

## Read-only boundary

Most MCP tools are read-only. Three explicit MCP local write operations are available: `index_update` reconciles the index incrementally, preserving configured exclusions; `memory_propose` persists only a `proposed` record; and `memory_transition` applies one allowed lifecycle transition. Memory updates and deletion remain explicit CLI operations. `memory_transition` does not infer user approval: an agent must call `status: "confirmed"` only after the user has clearly authorized confirmation. Neither memory operation modifies repository source files.

## Validation and error contract

- Input validation is declared with Zod at tool registration. Required strings must be non-empty and path/task text fields have explicit character ceilings; numeric limits are integers within the ranges in the table.
- Core operations can reject uninitialized projects, missing indexed paths, invalid core-level limits, or invalid task descriptions.
- The current handlers serialize successful results as JSON text in MCP text content. Freshness warnings are appended as a separate text block so existing consumers can continue parsing the first JSON block. Strict-freshness refusals use the MCP error result and include a structured JSON refusal payload.
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


## Agent-trust follow-up (2026-11-01)

- [x] Freshness reports expose exact changed/added/deleted paths and old/new hashes (existing index_freshness implementation).
- [x] All indexed read handlers append a freshness warning when the source/index state is not current.
- [x] Optional strict mode refuses stale or incomplete indexed reads.
- [x] Optional auto-update reconciles small, complete source changes before a read; incomplete discovery and changes over 50 files are left for explicit update.
- [x] Symbol and file-detail tools can include bounded source snippets with independent hashes and index status.
- [x] Task context accepts explicit path/symbol anchors and labels anchor, graph, and fallback provenance.
- [x] Full CI passed on PR #55 head in run 41285903567, including typecheck, tests, build, smoke, and Ubuntu/Windows/macOS benchmarks.
- [ ] Post-merge real-client compatibility for the new freshness warnings and optional schemas still requires a manual OpenCode and VS Code/Copilot check.


### Agent-trust CI evidence

- **Merged PR:** [#55](https://github.com/Daniel9822/codebase-neural-memory/pull/55).
- **Merge commit:** `de0cc1056469113995647d1d10199e08da39dc42`.
- **PR-head CI:** [run 41285903567](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41285903567) — verify, benchmark/ubuntu-latest, benchmark/windows-latest, and benchmark/macos-latest all passed.
- **Manual compatibility:** not yet repeated after the new response warning blocks and optional input fields; existing client evidence remains historical for the prior contract.
