# MCP-first workflow for coding agents

CNM generates and maintains a managed instruction section in the target repository's root `AGENTS.md` during `cnm init`. If the file already contains project-authored instructions, CNM preserves them and adds or updates only its own marked section. Run `cnm agents-md --check` in CI to detect missing or outdated CNM instructions.


> **Versioned memory status (2026-11-04):** Schema v13, `memory_capture`, optimistic `memory_update`, `memory_correct`, `memory_history`, `memory_get`, `memory_expand`, FTS5-backed `memory_search`, and compact `memory_bootstrap` are merged to `main` (PRs #137–#144). Start sessions with `memory_bootstrap`; use `memory_search` before broad exploration. An empty query browses high-value current knowledge; filters and snapshot-bound cursors support focused follow-up. Historical versions are opt-in. `memory_search` and `memory_bootstrap` expose freshness limits: `sourceEvidenceFreshness: not_checked` is not a freshness guarantee. Legacy `memory_propose`/`memory_transition` remain compatibility tools with their explicit-approval semantics. PR #146 merged `memory_health`; use it at task boundaries to inspect integrity, pending/conflicting knowledge, FTS consistency, and bounded source freshness. The read-only `memory_reconcile` preview is merged (PR #147); it reports sampled stale evidence, exact normalized-title duplicate candidates, contradictions, orphan relations, and related dependent-review candidates, but performs no repair or mutation. Mutating reconciliation, idempotency/recovery, and a durable dependent-knowledge review workflow remain open; broader migration/concurrency/rollback coverage, retrieval edge-case evaluation, and real-client integration remain open. Start with [Autonomous Memory Agent Handoff](AUTONOMOUS_MEMORY_AGENT_HANDOFF.md), then use the [master checklist](AUTONOMOUS_MEMORY_IMPLEMENTATION_CHECKLIST.md) as the canonical progress ledger.

## Correction handling (versioned memory rollout)

When using `memory_correct`, identify the exact current fragment being corrected and pass its `targetFragmentId` with the current `expectedVersionId`. Record the source honestly:
- A user-provided correction is `user_asserted` or `pending_validation`; never call it verified implementation solely because the user stated it.
- An agent correction may be marked `verified` only when source/test evidence is attached.
- A desired future behavior is a separate `planned` decision, not a correction that rewrites the current implementation claim.
- If a correction conflicts with source/tests, preserve the user intent as an assertion and leave implementation truth pending validation. Do not silently overwrite dependent knowledge; dependent impact/review tooling is still pending.

## Session initialization

1. Call `memory_recall` with a natural-language task/domain query before broad source exploration. Use `list: true` to inspect recent memories, and filters such as `status` or `category` when useful.
2. Treat `confirmed` memories as accepted project knowledge, subject to source freshness. `proposed` entries are useful candidate knowledge but are not confirmed facts. `obsolete` entries are historical and must not be followed as current guidance. `rejected` entries are excluded by default.
3. Call `index_freshness` once. It reports exact changed/added/deleted paths, old/new SHA-256 values, and incomplete discovery.
4. If the index is stale, call `index_update` once and re-check freshness. Do not loop. If discovery remains incomplete, explain the gap and verify affected files directly. For a focused task, `index_update` also accepts `paths` (project-relative files/directories), `include` (glob patterns), `maxFiles`, and `maxProcessed`. A `maxFiles` update selects candidates deterministically and reports `truncated` when more candidates remain. If `maxProcessed` is exceeded before deterministic selection completes, the update aborts without writes. Scoped updates never perform deletion reconciliation or delete records outside their selection; they are not repository-wide freshness repairs. Re-run an unscoped update before treating the whole index as current.
5. If strict freshness refuses a read, restore freshness before relying on indexed claims. Do not bypass the refusal by treating stale data as current.

## MCP-first source retrieval

1. Resolve known symbols with `symbol_lookup`; narrow by `kind`, `filePath`, and `exported`. Request `includeSource` for relevant symbol bodies.
2. Use `file_details` for indexed file structure, imports, and relationships; enable `inlineSnippets` when useful.
3. Use `source_excerpt` for exact line ranges returned by CNM.
4. For broad tasks, call `task_context` with explicit `anchors.paths` and/or `anchors.symbols`.
5. Use `git_blame` for bounded line-level historical attribution when the origin of existing code matters. Treat author, commit, timestamp, and summary as evidence only; do not infer intent or session rationale from blame alone. Use `git_history` for a bounded recent commit/change-path timeline when broader change context is useful. A commit is not necessarily one agent session; timestamps, authors, subjects, and changed paths are evidence, not proof of intent or task completion. Use `dependency_graph` with low depth first; use `change_impact` before changing high-fan-in files. For a specific function, class, or interface, use `symbol_impact` with `direction: "incoming"` to find callers, subclasses, implementors, and recognized test-case callbacks; disambiguate repeated names with `filePath`, `kind`, or `startLine`. Use `direction: "outgoing"` to inspect the symbol's dependencies. Treat returned `test-case` symbols as static call evidence, not proof that the test executes or passes.
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
- Capture durable reusable findings proactively with `memory_capture`; normal versioned capture does not require per-item human approval. Supply an accurate `epistemicState`, confidence rationale when confidence is provided, and bounded evidence such as `sourcePath`, `commitSha`, or test result when grounded.
- Do not save transient task chatter, secrets, speculation, unverified guesses as verified facts, or duplicate memories. Use `hypothesis` or `pending_validation` when appropriate.
- Treat exact-identity duplicates and conflicts returned by `memory_capture` explicitly; never auto-merge ambiguous or contradictory knowledge.
- Use `memory_update` with the current `expectedVersionId` and a reason for intentional edits; use `memory_correct` for a provenance-aware correction of one current fragment. Preserve user intent separately from verified implementation truth.
- Use `memory_history` to inspect immutable versions/events, `memory_get` for identity/version metadata, and `memory_expand` only for relevant fragment bodies. Until search/bootstrap exist, legacy `memory_recall` remains the available discovery path. Consult [AUTONOMOUS_MEMORY_AGENT_HANDOFF.md](AUTONOMOUS_MEMORY_AGENT_HANDOFF.md) for the current implementation snapshot and next-agent sequence.
- Legacy `memory_propose`/`memory_transition` remain for compatibility only and retain their old explicit-approval behavior; do not confuse them with versioned capture.

## Optional server policies

- `CNM_MCP_AUTO_UPDATE=1` performs one incremental refresh before a read when the change set is small and discovery is complete. It skips automatic refresh when discovery is incomplete or more than 50 source files changed. It is off by default.
- `CNM_MCP_STRICT_FRESHNESS=1` refuses indexed reads unless the index is current. When combined with auto-update, strict mode checks the post-update state.
- Auto-update is synchronous; the 50-file threshold is not a wall-clock timeout.

## Compact retrieval sequences

Named implementation:

`memory_recall → index_freshness → symbol_lookup → file_details → source_excerpt`

Broad task:

`memory_recall → index_freshness → task_context(anchors) → file_details/source_excerpt → tests`

After a durable discovery:

`memory_capture(epistemicState + grounded evidence) → memory_get → memory_expand(only relevant fragments)`

Use `memory_update` for intentional versioned edits and `memory_correct` for a provenance-aware correction. Do not route normal versioned capture through legacy proposal/approval tools.

## Scope boundary

This is a workflow recommendation, not a guarantee of complete program understanding. CNM indexes supported JavaScript/TypeScript structures. Runtime behavior, dynamic imports, framework magic, generated code, reflection, external package validity, and unindexed files still require direct inspection and tests.

> **Historical implementation note (2026-11-03):** this note records the rollout state at that date and is superseded by the 2026-11-04 status above. The current canonical status and remaining work are in [AUTONOMOUS_MEMORY_AGENT_HANDOFF.md](AUTONOMOUS_MEMORY_AGENT_HANDOFF.md) and the master checklist.


> **2026-11-04 verification addendum:** PR #164 is merged to `main` (`f9ff199321ce240c052a431ed0897b5196004d79`); CI `41934624316` passed all five jobs. Rollback-injection tests for `memory_update` and `memory_correct` compare queried snapshots of knowledge pointers, versions, fragments, evidence, and events. Independent-process contention coverage for these two operations is being added on branch `test/memory-update-correct-cross-process-contention`. Initial CI exposed a `memory_history` cursor bug for individually oversized events; the branch now fixes cursor advancement and makes its fixture timestamp deterministic. Do not treat either change as verified until fresh Ubuntu and Windows CI pass. See the [master checklist](AUTONOMOUS_MEMORY_IMPLEMENTATION_CHECKLIST.md) and [agent handoff](AUTONOMOUS_MEMORY_AGENT_HANDOFF.md) for the active sequence.


> **2026-11-05 verification addendum:** PR #165 is merged (`c7a82bfe2d141433a1bc57e24842b729dec903e3`; CI `41939068928`, five jobs green) with independent-process lock contention/retry coverage for both version writers, oversized-history cursor coverage, and migration rollback/retry. PR #168 is merged (`96da869dcd198bccd7b6e6cce1ed67ceb6a4ee88`; CI `41991378215`, five jobs green) with a same-identity `memory_update` two-writer race. PR #167's failed original test branch is closed as superseded by #168. The active branch `test/memory-correct-same-identity-races` adds same-identity `memory_correct` and mixed `memory_update`/`memory_correct` races; those cases remain pending CI and review. See the master checklist and agent handoff for the acceptance gate. SQLite `synchronous=FULL` does not constitute empirical power-loss/filesystem durability testing.


> **2026-11-05 post-#169 verification:** PR #169 is merged as `d5cdb6cdca88f1f41211ae9fa2c85dc837f1d1ca` (CI `41997492219`, five jobs green), completing same-identity correction/correction and mixed update/correction writer races. PR #170's previous stacked head passed CI `41998827170`, but is being reconstructed on current `main` to prevent its PR diff from repeating the squashed #169 commits. Its new exact-head CI must pass before merge. Pending coverage is legacy status mapping/unknown-state preservation, file-backed v13 rollback-close/reopen-retry and schema-v14 FTS5 integrity across repeated opens. See the checklist and handoff; physical power-loss durability remains unverified.

> **PR #170 rebase status:** the branch now starts at current `main` after #169 merge `d5cdb6cdca88f1f41211ae9fa2c85dc837f1d1ca`; only six intended files differ. CI run `41998827170` belongs to the prior stacked head and must not be treated as approval of the rebased head. Require a fresh exact-head five-job run before merging.


> **FTS retrieval integrity follow-up:** branch `fix/search-fail-closed-on-fts-drift` adds a pre-search consistency check across knowledge versions, FTS5 rows and version markers. Missing, duplicate, orphaned or ownership-mismatched FTS rows now fail closed instead of producing incomplete search results. The lazy initializer restores a missing marker from an existing FTS row without duplicating the FTS document; missing documents remain visible to `memory_health` and are not silently rebuilt. Require exact-head Ubuntu/Windows and benchmark CI before merging.


> **PR #173 merged:** commit `2f05249b9d71e9851190f01e72ade778d2cc5d77`, exact-head CI `42017503161`, all five jobs green. FTS search now fails closed on detectable row/marker drift. PR #171 is being reconstructed on the new post-#173 main to keep its diff conflict-free; run all five checks again on its rebased exact HEAD before merging.


> **PR #171 verification:** current PR head `d13ea31549b4e7793266eb9ada4d054696ce5026` is based on post-#173 main, is mergeable, has no open review threads, and passed all five CI jobs in run `42018977502` (also independently `42018940167`). PR #172 was closed as superseded by #171; do not merge the weaker duplicate branch.


## Migration compatibility note — 2026-11-05

The populated schema-v1 historical migration snapshot and normalized-path stable-ID collision recovery are merged in PR #171 (merge commit `9b24daa5e3e76ac21ccae3015d892cf2fa7afe26`; exact-head CI `42019978734`, five jobs green). Agents must not infer complete migration compatibility from this single snapshot: consult `docs/AUTONOMOUS_MEMORY_IMPLEMENTATION_CHECKLIST.md` for remaining historical-version, malformed-data, interruption/retry, FTS recovery and durability coverage.


> **2026-11-05 migration verification addendum:** PR #175 is merged as `8364f0af0e1fcd5bb02889f56b7c9823e9cbcc1a`; exact-head CI run `42022370475` passed all five jobs (Ubuntu/Windows verification and Ubuntu/Windows/macOS benchmarks). `tests/migrations.test.ts` now includes a populated schema-v6 historical fixture preserving project/index metadata, files, symbols, symbol calls, relations and legacy memories through migration to v13, with stable-ID, schema-marker, FK/integrity and idempotent repeated-call assertions. This fixture is in-memory and does not close/reopen the database; do not overstate it as reopen recovery. The populated v1 and v6 snapshots are distinct migration boundaries. The handoff and master checklist remain authoritative for the still-open migration matrix and autonomous-memory work.


> **2026-11-05 migration verification addendum:** PR #176 is merged as `6cf7d2432b332af7707090a67c8276902fbe8deb`; exact-head CI `42030574370` passed all five jobs. The populated schema-v10 test in `tests/migrations.test.ts` preserves project Git/worktree/index metadata, files, symbols, calls, relations and legacy memory provenance through v13, and checks v11/v12 additions, schema markers, FK/SQLite integrity, stable IDs and idempotent repeated migration. It is in-memory, not a close/reopen test. Populated historical snapshots now cover v1, v6 and v10; the master checklist and handoff record the remaining matrix.
