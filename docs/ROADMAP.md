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

**Status:** Evidence-rich bounded dependency traversal, explainable lexical ranking, bounded file-detail retrieval, literal-safe LIKE fallback, and read-only source freshness are implemented. The labeled corpus now covers ten retrieval queries, including exact, multi-term, and domain-style queries. Repository-scale relevance and performance evaluation remain open.

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

Exit condition: expected symbols, files, dependencies, and dependents are returned accurately for retrieval fixtures with source locations, per-edge evidence, deterministic ranking, and explicit result bounds. Conceptual components are not an exit criterion: CNM does not yet extract or retrieve component entities; that requirement is deferred to a future context/semantic capability and must not be represented as delivered by Phase 3.

## Phase 4 — Explicit project memory lifecycle

**Status:** Basic explicit memory insertion and recall exist; lifecycle is incomplete.

Tasks:
- Define memory categories and metadata.
- Add safe update and delete operations.
- Add source references and optional Git commit references.
- Implement proposed, confirmed, obsolete, and rejected states only with explicit transitions.
- Preserve author/source information where available.
- Identify memories whose source files or commits have changed.
- Require explicit user approval before confirming agent-proposed knowledge.
- Make memory search predictable and testable.

Deliverable: persistent, attributable project decisions and notes.

Exit condition: memory CRUD, lifecycle transitions, source traceability, and stale-memory behavior pass tests.

## Phase 5 — Task-oriented context builder

**Status:** Planned; not part of the current baseline.

Tasks:
- Accept a natural-language task description as input.
- Extract useful lexical anchors without requiring an LLM.
- Retrieve matching symbols, files, graph neighbors, memories, and tests.
- Rank candidates using explainable signals.
- Apply configurable item and token/character budgets.
- Deduplicate overlapping information.
- Return compact structured output and source references.
- Mark missing, ambiguous, or stale knowledge.
- Allow follow-up retrieval for deeper details.

Deliverable: deterministic task-context API that can be used by a client or an LLM.

Exit condition: context fixtures show relevant information is selected, irrelevant material is limited, provenance is included, and size budgets are respected.

## Phase 6 — MCP adapter and agent workflow

**Status:** Basic read-only MCP stdio server and five tools exist; integration needs validation.

Tasks:
- Verify current MCP SDK lifecycle and stdio behavior.
- Test server startup from a configured repository working directory.
- Make project selection explicit and prevent accidental cross-project access.
- Validate schemas, limits, and error responses.
- Add component_get, dependency_graph, decision_lookup, and project_context when their underlying core APIs exist.
- Keep agent-facing tools read-only in this release.
- Test with OpenCode first, then another MCP-compatible client.
- Document exact client configuration and troubleshooting.

Deliverable: dependable local MCP interface over the stable core.

Exit condition: clients can discover and call tools repeatedly without corrupting database state or mixing project memory.

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
