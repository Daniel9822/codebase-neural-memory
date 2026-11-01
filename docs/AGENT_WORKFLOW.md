# MCP-first workflow for coding agents

CNM generates and maintains a managed instruction section in the target repository's root `AGENTS.md` during `cnm init`. If the file already contains project-authored instructions, CNM preserves them and adds or updates only its own marked section. Run `cnm agents-md --check` in CI to detect missing or outdated CNM instructions.

## Session initialization

1. Call `memory_recall` with a natural-language task/domain query before broad source exploration. Use `list: true` to inspect recent memories, and filters such as `status` or `category` when useful.
2. Treat `confirmed` memories as accepted project knowledge, subject to source freshness. `proposed` entries are useful candidate knowledge but are not confirmed facts. `obsolete` entries are historical and must not be followed as current guidance. `rejected` entries are excluded by default.
3. Call `index_freshness` once. It reports exact changed/added/deleted paths, old/new SHA-256 values, and incomplete discovery.
4. If the index is stale, call `index_update` once and re-check freshness. Do not loop. If discovery remains incomplete, explain the gap and verify affected files directly.
5. If strict freshness refuses a read, restore freshness before relying on indexed claims. Do not bypass the refusal by treating stale data as current.

## MCP-first source retrieval

1. Resolve known symbols with `symbol_lookup`; narrow by `kind`, `filePath`, and `exported`. Request `includeSource` for relevant symbol bodies.
2. Use `file_details` for indexed file structure, imports, and relationships; enable `inlineSnippets` when useful.
3. Use `source_excerpt` for exact line ranges returned by CNM.
4. For broad tasks, call `task_context` with explicit `anchors.paths` and/or `anchors.symbols`.
5. Use `dependency_graph` with low depth first; use `change_impact` before changing high-fan-in contracts.
6. An empty result means “not found by this retrieval method”, not “does not exist”.

## Freshness and safe fallbacks

- Prefer MCP for indexed JavaScript/TypeScript structure and bounded source excerpts.
- Trust indexed structure only when the result is current. A freshness warning or `indexStatus: stale` means verify the current file before editing or describing exact line ranges.
- Use ordinary file reads for Markdown, assets, JSON/configuration, package manifests, tests, compiler output, unsupported files, or stale/incomplete/unreadable results.
- Never read or copy secrets such as `.env`, private keys, credentials, or authentication histories into memory or agent instructions.
- Never infer behavior from symbol names, signatures, graph edges, or memory text alone when implementation details matter. Verify source and tests.
- Inspect `file_details.importDiagnostics` and `project_map.importDiagnostics` for TypeScript semantic diagnostics such as missing external packages and missing named exports. Diagnostics are limited to supported indexed files and static TypeScript resolution; an empty list is not a compiler guarantee. Run the project's compiler/build and tests before claiming a change is healthy.

## Editing and verification

1. Before editing, inspect the current source excerpt and its freshness/hash.
2. After editing, run `index_update` once when refreshed structural retrieval is needed; re-check relevant symbols/ranges if lines or structure moved.
3. Run relevant tests, typecheck, build, and project-specific checks. CNM is not a compiler or test runner.
4. Review the final diff and distinguish verified results from assumptions.
5. Re-run `change_impact` or `dependency_graph` when the edit changes an export or dependency contract.

## Proactive, durable project memory

CNM memory is stored in the project's local database and is independent of the agent currently connected. Any agent using the same initialized project can recall the same records.

- The agent should actively recognize durable knowledge worth preserving: architecture and design decisions, stable conventions, non-obvious behavior, important workflows, recurring failure causes, and verified fixes.
- Propose meaningful knowledge proactively with `memory_propose`; do not wait for the user to remember to ask. Include a precise title, reusable explanation, category (`decision`, `convention`, `architectural`, or `gotcha`), and `sourcePath` / `commitSha` when grounded.
- Do not save transient task chatter, secrets, speculation, unverified guesses, or duplicate memories.
- Proposed entries are immediately discoverable through `memory_recall`, but remain `proposed`. Always label them as pending and never present them as accepted project truth.
- Ask the user whether they want the proposal confirmed. If the user clearly says yes (for example, “confirm it”, “approve this memory”, or an unambiguous equivalent), call `memory_transition` with `status: "confirmed"`. That explicit answer is sufficient; do not ask for a second confirmation.
- Never transition a proposal to confirmed merely because the agent considers it useful. Explicit user authorization is the approval boundary. If the user declines, do not confirm it; reject only when that is the intended lifecycle decision.
- On later tasks, freely consult relevant confirmed memories and review their provenance with `memory_freshness` when source/commit currency matters. Changed, missing, unsafe, or non-current provenance requires caution and review; it does not silently rewrite or delete the memory.

## Optional server policies

- `CNM_MCP_AUTO_UPDATE=1` performs one incremental refresh before a read when the change set is small and discovery is complete. It skips automatic refresh when discovery is incomplete or more than 50 source files changed. It is off by default.
- `CNM_MCP_STRICT_FRESHNESS=1` refuses indexed reads unless the index is current. When combined with auto-update, strict mode checks the post-update state.
- Auto-update is synchronous; the 50-file threshold is not a wall-clock timeout.

## Compact retrieval sequences

Named implementation:

`memory_recall → index_freshness → symbol_lookup → file_details → source_excerpt`

Broad task:

`memory_recall → index_freshness → task_context(anchors) → file_details/source_excerpt → tests`

After a durable verified discovery:

`memory_propose → tell user proposal is pending → memory_transition(confirmed only after explicit user approval)`

## Scope boundary

This is a workflow recommendation, not a guarantee of complete program understanding. CNM indexes supported JavaScript/TypeScript structures. Runtime behavior, dynamic imports, framework magic, generated code, reflection, external package validity, and unindexed files still require direct inspection and tests.
