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

**Status:** Complete and formally closed on 2026-10-31. The clean-checkout CI verification on merge commit `921be0d219e9ccbd151fa49008a691cee4287bcb` passed lockfile installation, typecheck, the full test suite, production build, and CLI/MCP smoke checks. Git commit/branch freshness is explicitly deferred to Phase 7 and is not a Phase 4 exit requirement; the verification record is in `docs/ACCEPTANCE_CRITERIA.md`.

Tasks:
- [x] Define memory categories and metadata.
- [x] Add safe partial update and project-scoped delete operations.
- [x] Add source-path references, optional Git commit metadata, and file-content SHA-256 fingerprints.
- [x] Implement proposed, confirmed, obsolete, and rejected states with validated explicit transitions.
- [x] Preserve explicitly supplied author identity separately from the latest updater; attribution is optional and never inferred.
- [x] Identify changed, missing, untracked, and unsafe source-file references that require review without mutating the memory.
- [ ] Compare referenced Git commits/branches with current repository state (deferred to Phase 7).
- [x] Require explicit user approval before confirming agent-proposed knowledge.
- [x] Make memory recall bounded, project-scoped, and predictable.

Deliverable: persistent, attributable project decisions and notes.

Exit condition: memory CRUD, lifecycle transitions, source traceability, and stale-memory behavior pass tests.

## Phase 5 — Task-oriented context builder

**Status:** Implementation merged; final close-out awaits verification of the merge commit on the default branch.

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
- **Remaining close-out check:** verify a workflow run against the merge commit/default branch before marking Phase 5 formally closed.
- **Limitations:** retrieval remains lexical/structural and does not promise semantic completeness. Context items are structured file details, not text excerpts. Incremental lookup remains a core API; no separate CLI/MCP incremental-lookup command is exposed.

## Phase 6 — MCP adapter and agent workflow

**Status:** The ten-tool read-only MCP server is implemented. Block 1 (source-derived contract and documentation synchronization) is documented in `docs/PHASE_6_MCP_CONTRACT.md`. Adapter-specific protocol tests, MCP project-isolation proof, real-client integrations, and final CI close-out remain pending. Phase 5's merge-commit/default-branch verification is also still recorded as a prerequisite close-out item and must not be silently treated as complete.

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

- [x] Add an OpenCode local-server configuration template with explicit workspace-relative \`cwd\` (\`examples/opencode.mcp.json\`).
- [ ] Verify OpenCode discovery and real tool calls in an installed OpenCode client.
- [x] Add a VS Code workspace stdio configuration template with explicit \`\${workspaceFolder}\` binding (\`examples/vscode.mcp.json\`).
- [ ] Verify VS Code discovery and real tool calls in an installed VS Code/Copilot client.
- [x] Document reproducible setup, verification prompts, evidence requirements, and troubleshooting (\`docs/CLIENT_INTEGRATION.md\`).
- [ ] Record client versions, configuration, observed results, and platform limitations after real-client execution.

**Deliverable:** two independently verified client integrations; simulated protocol calls do not count as client evidence.

### Block 5 — Regression and formal close-out

- [ ] Run `npm ci --no-audit --no-fund`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run smoke` on a clean checkout.
- [ ] Review the complete diff and confirm no unintended source/repository mutation.
- [ ] Synchronize all official documentation with the final source and tests.
- [ ] Record the commit, CI run, client evidence, and any limitations.
- [ ] Verify Phase 5's pending default-branch close-out evidence before declaring the overall sequence closed.

**Deliverable:** Phase 6 merged into `main` with passing CI and reproducible integration evidence.

**Phase 6 exit condition:** all five blocks pass. The existence of ten registered tools or a successful generic smoke test alone is not sufficient.
 
## Phase 7 — Git awareness and automatic freshness

**Status:** Planned; basic metadata fields exist but lifecycle is not complete.

Tasks:
- Record the indexed Git commit and relevant file state.
- Detect branch/commit changes and dirty worktrees.
- Associate source facts with the index revision.
- Evaluate a file watcher as an optional convenience, not as the consistency mechanism.
- Reconcile missed events through a deterministic scan.
- Handle renamed files, worktrees, submodules, and repository moves deliberately.
- Make freshness visible to retrieval clients.

Deliverable: memory that can detect and report when its view of source may be stale.

Exit condition: controlled Git changes and missed watcher events converge to the same index as a clean reindex.

## Phase 8 — Quality, performance, and evaluation

**Status:** Planned; begin collecting baseline measurements during earlier phases.

Tasks:
- Build fixture repositories of increasing size and complexity.
- Add end-to-end tests for real repository layouts.
- Measure initial indexing, incremental indexing, query latency, database size, and memory use.
- Evaluate retrieval precision and recall against labeled tasks.
- Compare agent tasks with and without CNM under comparable conditions.
- Add regression thresholds only after stable measurements exist.
- Profile before adding caches or parallelism.

Deliverable: reproducible evaluation suite and evidence-based performance improvements.

Exit condition: documented benchmarks, stable regression tests, and no known data-integrity failures in the supported scenarios.

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
