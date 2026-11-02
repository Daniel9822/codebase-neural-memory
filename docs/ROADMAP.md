# Development Roadmap

**Product:** Codebase Neural Memory (CNM)  
**Baseline:** v0.1.0 development line  
**Last reviewed:** 2026-10-31

This roadmap describes intended work, not proof that a phase is complete. A phase is complete only when its acceptance criteria pass and the result is documented.

## Guiding sequence

Stabilize the existing implementation first. Then improve source indexing, establish a reliable graph, build retrieval and memory workflows, package task context, and validate the MCP integration. Optional semantic retrieval comes only after structural and lexical baselines exist.

## Phase 0 — Audit and stabilize the existing baseline

**Status:** Required first; not considered complete by the existence of the current code.

Tasks:
- Inspect the complete current source tree, package metadata, lockfile, migrations, tests, and CI workflow.
- Install from a clean checkout using the lockfile.
- Run typecheck, tests, build, and CLI smoke tests.
- Verify SQLite creation, migrations, project isolation, and database closure.
- Verify init does not modify repository files.
- Exercise a clean index, second unchanged index, modified file, deleted file, and forced reindex.
- Exercise all documented CLI commands and each MCP tool.
- Fix confirmed defects with narrow changes.
- Record platform and environment limitations honestly.

Deliverable: reproducible v0.1 baseline and an audit report separating confirmed defects, risks, and missing future features.

Exit condition: clean installation and all currently claimed baseline behaviors pass automated or documented manual checks.

## Phase 1 — Robust source discovery and incremental indexing

**Status:** Partially implemented; needs audit and hardening.

Tasks:
- Make file discovery deterministic and observable.
- Verify .gitignore handling and built-in exclusions.
- Make exclusions configurable without weakening safe defaults.
- Test symlinks, file size limits, binary files, unreadable files, and malformed syntax.
- Ensure updates and deletions remove stale symbols, FTS rows, imports, calls, and graph relations.
- Make per-file persistence atomic.
- Ensure interruptions do not leave partially updated file records.
- Add force rebuild and consistency checks.
- Report parse errors and skipped files in index summaries.

Deliverable: reliable, recoverable incremental indexer for supported JavaScript/TypeScript projects.

Exit condition: acceptance criteria for initial, incremental, deletion, failure recovery, exclusions, and reindex equivalence pass.

## Phase 2 — Structural model and knowledge graph

**Status:** Core graph behavior is implemented and revision attribution is covered by integration tests; formal phase closure still depends on the complete acceptance audit.

Tasks:
- Finalize common node and edge model.
- Define stable identifiers and foreign-key/lifecycle rules.
- Resolve relative imports conservatively, including supported extensions and index files.
- [x] Add a bounded TypeScript semantic pass for unresolved external packages and invalid named/default export bindings; expose diagnostics through `project_map` without treating them as a replacement for compiler/build validation (implemented in PR #59; per-file diagnostics exposed by PR #60).
- Evaluate tsconfig path aliases and package exports.
- Resolve same-file and cross-file symbol references where static evidence is sufficient.
- Add reverse and forward graph traversal.
- [x] Record provenance, confidence, and index revision (schema migration v6, atomic revision stamping, and retrieval exposure are covered by integration tests).
- Make relation rebuilding idempotent.
- Keep unresolved/ambiguous references explicit rather than guessing.

Deliverable: queryable code graph with explainable relationships.

Exit condition: graph rebuild is deterministic, stale edges are removed, and graph queries return correct results on fixtures.

## Phase 3 — Lexical and structural retrieval

**Status:** Complete and formally closed on 2026-10-31. The clean-checkout CI verification on merge commit `553b3acbe3ef868fd4ef49fadb189ae2b92c1c2e` passed lockfile installation, typecheck, the full test suite, production build, and CLI/MCP retrieval smoke checks. The execution record is in `docs/ACCEPTANCE_CRITERIA.md`. Repository-scale relevance, precision/recall, and performance benchmarking remain Phase 8 work and are not Phase 3 requirements.

Tasks:
- [x] Improve FTS query handling, multi-term ranking, bounded candidates, and a narrowly scoped FTS5 fallback that does not swallow unrelated SQLite errors.
- [x] Add file detail retrieval by reusing indexed metadata, symbols, imports, unresolved imports, relations, and provenance.
- [x] Support direct and transitive dependency queries with evidence, depth, dependency chains, cycle protection, result limits, processing limits, and truncation reporting.
- [x] Explain lexical ranking signals and dependency relation evidence for every edge in each transitive dependency chain.
- [x] Escape SQL LIKE wildcard characters (percent, underscore, and backslash) in lexical fallback queries.
- [x] Bound every `file_details` collection and report totals and truncation; expose the same limit through CLI and MCP.
- [x] Include source path, symbol kind, and line ranges in symbol retrieval results.
- [x] Detect stale or incomplete source state and communicate added, changed, deleted, skipped, and failed paths through `cnm freshness` and MCP `index_freshness`.
- [x] Build a labeled ten-query test corpus with known expected lexical retrieval results (`tests/fixtures/retrieval-relevance.ts`).
- [x] Add regression coverage for migration v6 → v7 and document `cnm freshness` / MCP `index_freshness`.

Deliverable: fast, explainable lexical and graph-based retrieval without embeddings.

Exit condition: expected symbols, files, dependencies, and dependents are returned accurately for retrieval fixtures with source locations, per-edge evidence, deterministic ranking, and explicit result bounds; the clean-checkout verification record is complete; and no unresolved Phase 3-blocking defect remains. Repository-scale benchmarks and broader precision/recall evaluation belong to Phase 8. Conceptual components are not an exit criterion: CNM does not yet extract or retrieve component entities; that requirement is deferred to a future context/semantic capability and must not be represented as delivered by Phase 3.

## Phase 4 — Explicit project memory lifecycle

**Status:** Complete and formally closed on 2026-10-31. The original Phase 4 close-out verified memory lifecycle and file-content freshness. The Git commit-provenance comparison deferred from Phase 4 was subsequently implemented in Phase 7 (PR #48); see the current Phase 7 acceptance record.

Tasks:
- [x] Define memory categories and metadata.
- [x] Add safe partial update and project-scoped delete operations.
- [x] Add source-path references, optional Git commit metadata, and file-content SHA-256 fingerprints.
- [x] Implement proposed, confirmed, obsolete, and rejected states with validated explicit transitions.
- [x] Preserve explicitly supplied author identity separately from the latest updater; attribution is optional and never inferred.
- [x] Identify changed, missing, untracked, and unsafe source-file references that require review without mutating the memory.
- [x] Compare referenced memory commits with current `HEAD` ancestry; Phase 7 reports current, ancestor, ahead, diverged, unknown, and unavailable states without changing memory lifecycle.
- [x] Require explicit user approval before confirming agent-proposed knowledge.
- [x] Make memory recall bounded, project-scoped, and predictable.

Deliverable: persistent, attributable project decisions and notes.

Exit condition: memory CRUD, lifecycle transitions, source traceability, and stale-memory behavior pass tests.

## Phase 5 — Task-oriented context builder

**Status:** Complete and formally closed on 2026-10-31. The default-branch clean-checkout CI run [41250061815](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41250061815) passed on merge commit `f3c74147ce6b9cad2100156a644c404b965d6f6a`, including lockfile installation, typecheck, the full test suite, production build, and CLI/MCP smoke checks.

Tasks:
- [x] Accept a natural-language task description and extract deterministic lexical anchors without an LLM.
- [x] Retrieve matching symbols, file details, direct dependencies, relevant test-path candidates, and lifecycle-labeled memories.
- [x] Rank candidates using explainable signals and retain source references.
- [x] Deduplicate candidates and enforce configurable item and serialized-character budgets.
- [x] Restrict repository-wide test-path candidates to paths matching at least one task anchor; unrelated test files are excluded.
- [x] Define `maxCharacters` as the exact JavaScript string length of `JSON.stringify(items)`, including array delimiters, commas, quotes, and serialized item fields. The task, anchors, warnings, follow-up prompts, and budget metadata are outside this limit.
- [x] Mark missing, ambiguous, and stale information, including stale/incomplete source-index state.
- [x] Support incremental detail lookup for source paths already represented in context.

Deliverable: deterministic, bounded, source-backed task context for clients and coding agents.

Exit condition: focused fixtures prove relevant tests are included, unrelated tests are excluded, the serialized item budget is exact at and below its boundary, and the complete CI workflow passes on the merged result.

### Phase 5 verification evidence

- **Previously merged feature baseline:** PR [#36 — stale source-index warnings](https://github.com/Daniel9822/codebase-neural-memory/pull/36), merge commit `992fcd3c2aebc8029b3ca2f24a3c3e76aeba1bb6`.
- **Post-merge CI:** [GitHub Actions #41233040729](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41233040729) — success.
- **Verified commands:** `npm ci --no-audit --no-fund`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run smoke`; every workflow step completed successfully on GitHub-hosted Ubuntu / Node.js 22.
- **Final relevance/budget close-out:** PR [#37](https://github.com/Daniel9822/codebase-neural-memory/pull/37) merged into `main`; merge commit `f4f5aa6612de5aafdf4423095251030ac862b12b`.
- **PR verification:** [GitHub Actions #41233795736](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41233795736) — success; `npm ci --no-audit --no-fund`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run smoke` all completed successfully on the final PR head.
- **Default-branch close-out:** verified. CI run [41250061815](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41250061815) ran on `main` at `f3c74147ce6b9cad2100156a644c404b965d6f6a` and completed successfully. The workflow ran `npm ci --no-audit --no-fund`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run smoke` on GitHub-hosted Ubuntu / Node.js 22.
- **Limitations:** retrieval remains lexical/structural and does not promise semantic completeness. Context items are structured file details, not text excerpts. Incremental lookup remains a core API; no separate CLI/MCP incremental-lookup command is exposed.

## Phase 6 — MCP adapter and agent workflow

**Status:** Complete and formally closed on 2026-10-31. Blocks 1–3 are implemented and CI-verified; Block 4's real OpenCode and VS Code/GitHub Copilot calls are manually verified, with VS Code 1.144.0 (x64), OpenCode 1.19.5, and Node.js v22.12.0 recorded. In the validated VS Code installation, Copilot is integrated into the editor experience and does not require a separately tracked extension version. Block 5 regression and close-out passed on `main` in clean-checkout CI run [41250061815](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41250061815); documentation reconciliation merged in PR [#47](https://github.com/Daniel9822/codebase-neural-memory/pull/47), followed by successful main-branch CI run [41250490923](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41250490923).

### Block 1 — Audit and MCP contract

- [x] Confirm the exact ten registered tools from `src/adapters/mcp/server.ts`.
- [x] Record each tool's input schema, defaults, hard limits, and core operation.
- [x] Document stdio startup, working-directory project binding, and the read-only boundary.
- [x] Synchronize README, ARCHITECTURE, PRODUCT_SPEC, ROADMAP, and ACCEPTANCE_CRITERIA with the source-derived contract.
- [x] Explicitly distinguish implemented behavior from protocol/client behavior that still needs evidence.

**Deliverable:** a source-aligned MCP contract with no invented tools or duplicated Phase 3 retrieval work.

### Block 2 — Adapter-specific protocol tests

- [x] Use the real MCP server and installed SDK with its in-memory transport.
- [x] Discover exactly ten tools and assert their published input schemas.
- [x] Execute at least one valid call for every tool.
- [x] Assert invalid Zod inputs and thrown core errors return the observed MCP error envelope (`isError: true`).
- [x] Exercise repeated calls, in-memory close/reconnect, real CLI stdio EOF shutdown, and process reconnection.
- [x] Verify that read calls do not alter repository source files, index records, or durable memories.

**Deliverable:** focused SDK in-memory and real stdio MCP adapter tests, independent of the existing general smoke script. CI evidence: [run 41238294195](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41238294195) passed all 82 tests across 9 test files, typecheck, build, and smoke.

### Block 3 — Limits, paths, and project isolation

- [x] Audit every response collection for a finite adapter-level limit and explicit truncation/total metadata where applicable.
- [x] Bound `index_freshness.skippedFiles` and `index_freshness.errors`, preserving total counts and explicit truncation metadata.
- [x] Bound `memory_freshness` records, preserving the total eligible count and explicit truncation metadata; inspection work is limited to the requested records.
- [x] Make `project_map` report total indexed files and truncation; nested imports, unresolved imports, and candidate paths are capped with metadata.
- [x] Add exact-limit, over-limit, empty, and incomplete-discovery protocol tests for the three tools.
- [x] Run two concurrent MCP servers against two repositories with different indexed files and memories.
- [x] Prove that each server remains bound to its configured project across repeated calls.
- [x] Test invalid, missing, unindexed, traversal, and outside-root paths.

**Evidence:** CI run [41239258583](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41239258583) passed 86 tests across 10 test files, typecheck, build, and smoke.

**Deliverable:** bounded responses and automated evidence that projects cannot leak into one another.

### Block 4 — Real MCP client compatibility

- [x] Add an OpenCode local-server configuration template with explicit workspace-relative `cwd` (`examples/opencode.mcp.json`).
- [x] Verify OpenCode discovery and real tool calls in an installed OpenCode client (manual evidence recorded in `docs/CLIENT_INTEGRATION.md`).
- [x] Add a VS Code workspace stdio configuration template with explicit `${workspaceFolder}` binding (`examples/vscode.mcp.json`).
- [x] Verify VS Code discovery and real tool calls in an installed VS Code/Copilot client (manual evidence recorded in `docs/CLIENT_INTEGRATION.md`).
- [x] Document reproducible setup, verification prompts, evidence requirements, and troubleshooting (`docs/CLIENT_INTEGRATION.md`).
- [x] Record client configurations, observed tool results, execution date, and known platform limitations in `docs/CLIENT_INTEGRATION.md`.
- [x] Record VS Code 1.144.0 (x64), OpenCode 1.19.5, and Node.js v22.12.0 from local CLI output.
- [x] Record the validated VS Code/Copilot integration as the integrated Copilot experience in VS Code 1.144.0; no independent extension identifier/version is required for this environment.

**Evidence:** VS Code with its integrated GitHub Copilot Agent experience and OpenCode each connected to `codebase-memory` and successfully invoked `project_overview` and `symbol_lookup` against the same local CNM workspace on 2026-10-31. Both returned 25 files, 135 symbols, 171 relations, index revision 1, and located `createMcpServer` at lines 12–102. Versions recorded: VS Code 1.144.0 (x64), OpenCode 1.19.5, Node.js v22.12.0. Copilot is recorded as part of the validated VS Code installation, not as a separately versioned extension.

**Deliverable:** two independently verified client integrations; simulated protocol calls do not count as client evidence.

### Block 5 — Regression and formal close-out

- [x] Run `npm ci --no-audit --no-fund`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run smoke` on a clean checkout; all passed in default-branch CI run [41250061815](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41250061815) on merge commit `f3c74147ce6b9cad2100156a644c404b965d6f6a`.
- [x] Review the Phase 6 implementation, configuration, and documentation diffs across PRs #42, #43, #45, and #46; expected source/tests/config/docs changes only, with no unrelated repository mutation found.
- [x] Synchronize the README, architecture, product specification, roadmap, acceptance criteria, MCP contract, and client integration record with the final source and observed tests.
- [x] Record the merge commit, successful CI run, both real-client evidence records, and remaining limitations.
- [x] Verify Phase 5's default-branch close-out evidence; run [41250061815](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41250061815) passed on `main`.

**Deliverable:** Phase 6 implementation and regression close-out merged into `main` with passing CI and reproducible integration evidence. All five blocks are complete.

**Phase 6 exit condition:** all five blocks pass. The existence of ten registered tools or a successful generic smoke test alone is not sufficient.
 
## Phase 7 — Git awareness and automatic freshness

**Status:** Complete and formally closed on 2026-10-31. PR [#48](https://github.com/Daniel9822/codebase-neural-memory/pull/48) merged as `c6e2d742be3df8b1e697d354a81463ae92ef7590`; default-branch clean-checkout CI run [41253963500](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41253963500) passed. Git-aware index snapshots, commit/branch/worktree freshness, memory commit-ancestry review, and deterministic reconciliation are now in `main`.

Tasks:
- [x] Record the indexed Git commit and relevant working-tree state when Git metadata is available (schema migration v10).
- [x] Detect branch/commit changes and dirty worktrees in `cnm freshness` and MCP `index_freshness`.
- [x] Compare memory `commit_sha` references with current Git `HEAD` ancestry and require review for ancestor, ahead, diverged, unknown, or unavailable references (`tests/git-awareness.test.ts`).
- [x] Keep freshness reconciliation deterministic and independent of watcher events; each check scans supported source files and reads Git status.
- [x] Reconcile changes missed by any external watcher through the same deterministic scan; watcher support remains optional and unimplemented.
- [x] Document identity boundaries: each Git worktree path has a separate path-derived CNM project/database; moving a repository changes its project identity. A submodule opened directly resolves as its own project, but a parent scan does not yet enforce submodule isolation.
- [x] Expose Git snapshot and stale/current state through the existing `index_freshness` MCP tool.
- [x] Prove clean reindex and incremental reconciliation converge to equivalent logical state across branch switches, renames, deletions, symbols, imports, graph relations, unresolved imports, calls, heritage, and FTS state (`tests/git-awareness.test.ts`).

Deliverable: memory that can detect and report when its view of source may be stale.

Exit condition: controlled Git changes and missed watcher events converge to the same index as a clean reindex.

### Phase 7 verification evidence

- **Implementation:** PR [#48](https://github.com/Daniel9822/codebase-neural-memory/pull/48); schema migration v10.
- **Default-branch CI:** [GitHub Actions #41253963500](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41253963500) — success on merge commit `c6e2d742be3df8b1e697d354a81463ae92ef7590`; clean checkout, `npm ci --no-audit --no-fund`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run smoke` all passed.
- **Git state coverage:** initial commit/branch capture, clean and dirty worktrees, source edits, empty commits, branch changes with identical source hashes, rename/deletion reconciliation, non-Git folders, and memory commit ancestry/ahead/divergence.
- **Convergence:** incremental indexing and forced reindex were compared using logical file, symbol, import, call, heritage, relation, unresolved-import, and FTS snapshots after rename/deletion and branch-switch scenarios.
- **Consistency design:** freshness always performs a deterministic scan; no background watcher is needed for correctness and none is implemented.
- **Identity limitations:** each worktree path has its own path-derived CNM database; moving a repository changes its ID. Opening a submodule directly resolves it as a separate project, but the parent indexer does not enforce nested-submodule isolation.

## Phase 8 — Quality, performance, and evaluation

**Status:** In progress. PR [#49](https://github.com/Daniel9822/codebase-neural-memory/pull/49) adds a deterministic synthetic benchmark harness, runs it in CI, and records an initial Linux baseline in [`docs/PHASE_8_BENCHMARKS.md`](PHASE_8_BENCHMARKS.md). Real-repository coverage, cross-platform repetition, and controlled agent comparisons remain open.

Tasks:
- [x] Generate deterministic small, medium, and large repository fixtures (26, 101, and 301 source files).
- [x] Add an end-to-end benchmark case for the checked-out CNM repository; additional independent repositories remain open.
- [x] Measure initial, unchanged incremental, and changed incremental indexing; record search, graph, and freshness latency.
- [x] Record SQLite database size and process peak RSS.
- [x] Evaluate symbol retrieval precision@5, recall@5, MRR, and top-1 accuracy against ten labeled queries.
- [x] Define an eight-task read-only CNM-specific evaluation suite and controlled comparison protocol (`benchmarks/agent-tasks.json`, `docs/AGENT_EVALUATION_PROTOCOL.md`).
- [x] Audit the 2026-11-01 exploratory transcript artifact and document why it is not a valid paired benchmark (different/unverified commits, agent/client metadata gaps, prompt drift, missing metrics, provisional unblinded scores, and unequal source-inspection availability).
- [ ] Execute new paired agent tasks with and without CNM under controlled, comparable conditions; the exploratory transcript artifact is diagnostic only and must not be used to claim a winner.
- [ ] Add separate task suites and controlled runs for small, medium, and large repositories; the existing CNM-specific tasks cover only this repository.
- [x] Add bounded MCP source excerpts so agents can inspect indexed symbol implementations after structural retrieval; verify path confinement, output limits, and indexed-vs-working-tree freshness.
- [x] Repeat the same benchmark suite on Linux, Windows, and macOS; all three matrix jobs passed in CI run [41254663323](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41254663323).
- [ ] Add regression thresholds only after repeated stable measurements across supported platforms.
- [ ] Profile before adding caches or parallelism.

Deliverable: reproducible evaluation suite and evidence-based performance improvements. Initial synthetic baseline methodology and results are recorded in `docs/PHASE_8_BENCHMARKS.md`.

Exit condition: documented benchmarks, stable regression tests, and no known data-integrity failures in the supported scenarios.

### Phase 6 follow-up — Agent-operable indexing and memory proposals

**Status:** Complete and merged in PR #54 (`6e0e19cda1c059e45354a9fd483fc57c574319cc`); CI passed on the merged result.

- [x] Expose explicit incremental MCP index reconciliation while preserving persisted project exclusions.
- [x] Expose an agent memory-proposal operation that can create only `proposed` records; human confirmation remains a separate action.
- [x] Add optional symbol kind, project-relative path-prefix, and export filters to MCP symbol lookup.
- [x] Verify MCP schemas, valid calls, invalid inputs, incremental update behavior, exclusion preservation, and proposed-only memory status in CI.
- [x] Add bounded symbol-level impact traversal over `CALLS`, `EXTENDS`, and `IMPLEMENTS`, including BFS shortest distances, per-edge evidence, ambiguity handling, and CLI/MCP access (PR #65).
- [x] Map recognized test callback symbols to imported source symbols through indexed `CALLS` edges and expose the relationship through `symbol_impact` (PR #65); this is static syntax evidence, not runtime coverage.
- [x] Add bounded read-only Git blame retrieval for tracked project-relative line ranges with timeout, output cap, and path validation (PR #66); blame is attribution metadata, not inferred session rationale.
- [x] Expose bounded read-only Git commit history and changed-path evidence through MCP (`git_history`), with commit/path caps, a 3-second timeout, and explicit non-inference of developer sessions or intent.
- [ ] Reconstruct agent sessions only when explicit session identifiers/metadata exist; do not equate commits, timestamps, or author identity with a session.
- [x] Enrich indexed symbol signatures with bounded multiline declaration headers, including parameters, generics, return types, and class heritage; implementation bodies remain on-demand through bounded `source_excerpt` / inline snippets (PR #67). Granular task-context budgets and symbol-level impact traversal are implemented; Git session rationale and semantic/domain component inference remain open; the structural directory-boundary projection is implemented.
- [x] Add independent task-context item budgets for symbols, files, dependencies, tests, and memories; expose the limits in CLI/MCP and report per-category usage/truncation (PR #64).
- [x] Add bounded selective reindex controls for project-relative file/directory paths and include globs, with file/traversal budgets, traversal-safe validation, truncation reporting, and no deletion outside selected scope (CLI and MCP).
- [x] Validate performance improvements across Windows, macOS, and Linux: stream bounded directory enumeration, consolidate Git snapshot metadata retrieval, and skip full relationship/diagnostic reconstruction when indexed sources and relation configuration are unchanged.
- [x] Add a deterministic directory-boundary component projection with directed import coupling and shortest dependency distances (PR #68); semantic/domain component inference remains explicitly out of scope.

Deliverable: agents can explicitly refresh derived index state and submit reviewable memory suggestions without silently confirming project knowledge.

Exit condition: full CI passes on the PR head; protocol and core tests prove the write boundaries; documentation matches the registered tools.

### Agent trust and context follow-up (2026-11-01)

**Status:** Complete and merged in PR #55 (`de0cc1056469113995647d1d10199e08da39dc42`); full CI passed in run [41285903567](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41285903567).

- [x] Reuse the existing exact-path/hash freshness report (P1 was already implemented before this follow-up; do not duplicate it).
- [x] Append a freshness warning to every indexed MCP read when the index is stale or incomplete.
- [x] Add opt-in strict freshness refusal via `CNM_MCP_STRICT_FRESHNESS=1`.
- [x] Add opt-in incremental auto-update via `CNM_MCP_AUTO_UPDATE=1`, with a 50-changed-file guard and safe skip on incomplete discovery.
- [x] Add bounded source snippets to `symbol_lookup` and `file_details`, retaining per-excerpt hashes and status.
- [x] Add explicit path/symbol anchors and anchor/graph/fallback origin labels to `task_context`; anchored mode disables broad lexical fallback.
- [x] Add a reusable MCP-first agent workflow and memory-proposal discipline in `docs/AGENT_WORKFLOW.md`.
- [ ] Add a verified session-start hook for a specific OpenCode plugin API. This is deferred because the current CNM repository has no OpenCode plugin package or hook runtime; the documented startup procedure uses MCP calls instead.
- [x] Run typecheck, full tests, build, smoke, and cross-platform CI on the final PR head (run 41285903567 passed).

Design note: no five-second timeout is claimed. The current indexer is synchronous, so cancelling it safely would require a separate worker/process design. The auto-update file-count guard limits the scope of automatic work but not elapsed time.

**Verification:** PR #55 was merged as `de0cc1056469113995647d1d10199e08da39dc42`. CI run [41285903567](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41285903567) passed `npm ci --no-audit --no-fund`, typecheck, full tests, build, smoke, and benchmark jobs on Ubuntu, Windows, and macOS. Real-client re-verification of the new response blocks remains open.

## Phase 9 — Optional semantic retrieval

**Status:** Deferred until structural and lexical retrieval are stable.

Tasks:
- Define an embedding provider interface.
- Evaluate local and user-configured providers.
- Keep remote providers disabled unless explicitly configured.
- Store embedding metadata and model identity.
- Support re-embedding and index invalidation.
- Combine semantic, lexical, and graph scores transparently.
- Compare retrieval quality against the non-embedding baseline.
- Keep the product fully usable without embeddings.

Deliverable: optional hybrid retrieval with demonstrated benefit.

Exit condition: measurable retrieval improvement justifies the added complexity and privacy implications.

## Phase 10 — Stable release and open-source readiness

**Status:** Future.

Tasks:
- Confirm Windows, macOS, and Linux install flows.
- Package and publish the CLI.
- Document upgrades and migrations.
- Complete security and privacy documentation.
- Add contribution guidelines and issue templates.
- Add release automation and semantic versioning.
- Review license and dependency notices.
- Prepare examples and troubleshooting docs.
- Decide when to make the repository public.

Deliverable: installable, documented, supportable stable release.

Exit condition: release checklist passes and the maintainer explicitly approves public release.

## Deferred product directions

These are not requirements for v1:
- Team synchronization and shared memory.
- Hosted cloud service.
- Desktop GUI.
- Multi-user permissions.
- Mandatory vector database.
- Mandatory model provider or GPU.
- Agent-driven source-code editing.

They may be reconsidered only after the local individual workflow is reliable and evaluated.


## Agent readiness and durable memory v2 — In progress

This work turns CNM into an agent-ready project capability rather than relying on each repository owner to hand-author agent instructions.

- [x] Generate a managed CNM instruction section in root `AGENTS.md` during `cnm init`; create the file when absent and preserve existing user-authored content.
- [x] Add `cnm agents-md` with `--check`, `--print`, and tool flavors (`opencode`, `claude`, `cursor`, `generic`). The managed block is idempotent and hash-stamped.
- [x] Instruct agents to proactively propose durable architectural knowledge, conventions, verified fixes, and important workflows.
- [x] Make proposed memories discoverable by natural-language recall and list mode, with lifecycle and category filters; proposed entries remain visibly unconfirmed.
- [x] Add an explicit MCP `memory_transition` operation. An agent may transition a proposal to `confirmed` only after clear user authorization; the tool itself does not infer consent.
- [x] Document cross-agent continuity: memories remain in the project database and are available to any connected agent using the same project binding.
- [x] Validate external package imports and named import bindings (NP2 from Contract v2); bounded diagnostics are persisted and exposed through `project_map` and `file_details` (PRs #59 and #60).
- [x] Retain opt-in auto-refresh and strict freshness policies from the previous agent workflow work; do not add a second refresh mechanism.
- [x] Harden auto-update against incomplete or changing source snapshots, roll back failed indexing transactions, and return explicit strict/non-strict failure states without serving stale data as current (PR #61; regression coverage includes incomplete discovery, safety limits, rollback, and concurrent reads).
- [x] Add full regression coverage and cross-platform CI evidence for the new generator, retrieval ranking, and memory transition tool before merge (PR #58; Ubuntu/Windows verification and Ubuntu/Windows/macOS benchmark matrix passed).

**Acceptance:** a fresh project gets useful agent instructions from `cnm init`; an existing `AGENTS.md` retains its original content; natural-language queries discover relevant confirmed and proposed memories; and only an explicit user approval allows the agent to confirm a proposal.


### CNM-06 follow-up — MCP retrieval contracts (2026-11-02)

- [x] Apply `symbol_lookup` kind, project-relative path-prefix, and export filters in SQL before the bounded candidate window.
- [x] Add a regression fixture with more than 1,000 unfiltered candidates and a matching symbol beyond that window.
- [ ] Complete the remaining MCP output-contract audit for ranking, deterministic tie-breaks, processing budgets, and order-before-truncation across all registered tools.


### CNM-06 follow-up — task-context test discovery (2026-11-02)

- [x] Detect when the 500-entry lexical test-path discovery window is exceeded, expose a warning, and mark the `test` context kind as truncated.
- [x] Add regression coverage with more than 500 indexed test paths and a matching test beyond the bounded discovery window.
- [x] Document the bound and its incompleteness semantics in the MCP contract.

