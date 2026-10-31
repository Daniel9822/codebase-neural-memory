# Acceptance Criteria

**Product:** Codebase Neural Memory (CNM)  
**Purpose:** Verifiable completion conditions for the roadmap  
**Last reviewed:** 2026-10-31

## 1. How to use this document

A feature is not complete because a command exists or a README describes it. It is complete when the relevant behavior is demonstrated by automated tests or a repeatable manual test and the result is recorded.

For every implementation task, classify findings as:

- **Confirmed defect:** current code demonstrably violates an existing requirement.
- **Risk:** a plausible failure mode not yet reproduced.
- **Missing capability:** planned behavior not implemented yet.
- **Verified behavior:** demonstrated by a test or repeatable check.

Do not report a missing future feature as a defect in the current implementation.

## 2. Global release gates

Every milestone must preserve these rules:

- Core operations work without an LLM, GPU, embedding model, external API, or cloud account.
- Repository source files are not modified by init, indexing, search, retrieval, or MCP startup.
- The default database is stored outside the target repository.
- No repository content or memory is transmitted externally by default.
- Project memories from different local repositories are isolated.
- Unsupported or malformed files do not crash an entire indexing run.
- Derived knowledge includes source references where applicable.
- Stale or uncertain facts are not presented as confirmed.
- Database changes are recoverable and do not silently leave partial state.
- Typecheck, tests, and build pass in CI for supported environments.

## 3. Phase 0 — Audit and stabilize v0.1 baseline

### Installation and tooling
- [ ] A clean checkout can install dependencies from the committed lockfile using the documented Node.js version.
- [ ] TypeScript typecheck completes successfully.
- [ ] Automated tests complete successfully.
- [ ] Production build completes successfully.
- [ ] The built CLI starts and prints help/version information.
- [ ] All documented commands are exercised by automated smoke tests or a repeatable test script.

### Project initialization and privacy
- [ ] Running init from a repository root identifies the expected project root.
- [ ] Running init from a nested directory identifies the same root.
- [ ] Running init creates the database in the OS-specific user data directory.
- [ ] Running init does not create CNM data folders inside the repository.
- [ ] Running init does not modify tracked files, untracked files, or .gitignore.
- [ ] Two different repositories receive isolated project identities and databases.
- [ ] Repeated init is safe and does not duplicate project records.

### Initial and incremental indexing
- [ ] A fixture repository with supported JS/TS files can be indexed.
- [ ] The index summary reports discovered, indexed, skipped, and failed files consistently.
- [ ] A second index with unchanged inputs skips reparsing those files.
- [ ] A changed file receives updated hash, symbols, imports, and calls.
- [ ] A deleted file is removed from active files, symbols, FTS entries, and relations.
- [ ] A forced reindex produces the same logical index as a clean initialization on the same fixture.
- [ ] An unsupported extension is skipped without crashing.
- [ ] A malformed source file is reported without aborting unrelated files.
- [ ] Oversized, ignored, secret-pattern, and symlink cases follow documented exclusions.

### Retrieval and memories
- [ ] Symbol search returns expected symbols and source line ranges.
- [ ] Explain returns matching symbol definitions or a clear no-result response.
- [ ] Project map lists indexed files and only relationships that the resolver has actually established.
- [ ] Impact returns known reverse dependents for fixture imports.
- [ ] Remember persists a note across separate CLI invocations.
- [ ] Memories can be filtered and are scoped to the current project.

### MCP
- [ ] The MCP server starts using stdio from the configured project directory.
- [ ] The server exposes only the documented read-only tools in this baseline.
- [ ] Each tool validates inputs and returns a useful error for invalid values.
- [ ] Repeated MCP reads do not mutate source or memory records.
- [ ] The server cannot accidentally read a different repository's memory.

Phase 0 is complete only after results are recorded, including exact environment and any platform-specific limitations.

## 4. Phase 1 — Robust indexer

- [ ] File discovery is deterministic for the same repository state and configuration.
- [ ] .gitignore rules are respected, including nested ignore files where supported.
- [ ] CNM exclusions can be configured without disabling mandatory safety exclusions accidentally.
- [ ] Symlinks are skipped by default and cannot escape the selected repository root.
- [ ] Binary and oversized files are skipped safely.
- [ ] Read and parse failures are reported per file.
- [ ] A single file update is atomic: a failure cannot leave half of its symbols or edges active.
- [ ] Deleting or changing a file removes all stale dependent index rows.
- [ ] A process interruption does not corrupt the SQLite database or leave a file marked current with incomplete data.
- [ ] Re-running index after an interrupted operation converges to the same state as a clean reindex.
- [ ] Index summary counters reconcile with persisted active records.

## 5. Phase 2 — Knowledge graph

- [x] Every node has a stable identifier within the project and a documented node type (file and symbol IDs are deterministic SHA-256 hashes; node types are `file` and `symbol`).
- [x] Every relation is directed and has a documented relation type (verified for IMPORTS, CALLS, EXTENDS, and IMPLEMENTS in indexer and retrieval fixtures).
- [x] Every inferred relation records its provenance and confidence (asserted for imports, imported calls, extends, and implements).
- [x] Human-confirmed knowledge is distinguishable from parser-derived facts (explicit `remember` records are stored in `memories` with `confirmed` status, separately from parser-created `relations` carrying parser provenance; covered by `tests/memories.test.ts`).
- [x] Graph relations are associated with the index revision that produced them (migration v6 adds project and relation revision fields; indexing increments the project revision and stamps every rebuilt edge in the same transaction; `getSymbolRelations` exposes `indexRevision`; revision advancement and rollback are covered by `tests/retrieval.test.ts`).
- [x] Rebuilding relations twice from unchanged source produces no duplicate edges (forced-reindex fixture compares stable node identities and relation metadata).
- [x] Changing or deleting a source removes or invalidates affected old edges (covered by source-change and file-deletion regression tests).
- [x] Forward and reverse traversal return expected neighbors on graph fixtures (dependency and symbol-relation retrieval tests).
- [x] Transitive traversal handles cycles without infinite loops (dependency traversal fixture).
- [x] Unresolved or ambiguous imports are reported as unresolved instead of guessed (relative, tsconfig alias, and package export fixtures).
- [x] Cross-file symbol edges are created only when static evidence supports the resolution (named exports, aliases, shadowing, non-exported symbols, and ambiguous heritage fixtures).

## 6. Phase 3 — Retrieval

- [x] Exact symbol lookup returns expected matches (fixture verifies `explainSymbol` resolves an exact declaration with source location).
- [x] Partial lexical lookup returns relevant matches with stable limits (prefix search and bounded result count are covered by `tests/retrieval.test.ts`).
- [x] Empty and punctuation-only queries return an empty result safely; invalid result limits are rejected (`tests/retrieval.test.ts`).
- [x] Symbol retrieval results include file path, symbol kind, and line range when available (verified by exact and partial lookup fixtures).
- [ ] Direct dependency lookup returns expected edges.
- [ ] Transitive dependency lookup respects depth/size limits and cycles.
- [ ] Retrieval explains the evidence or relation that caused a result to be included.
- [ ] Retrieval identifies stale or incomplete index state.
- [ ] Relevance tests use labeled expected results rather than subjective spot checks alone.

## 7. Phase 4 — Memory lifecycle

- [ ] A memory has a stable ID, category, title, content, status, and timestamps.
- [ ] A memory can optionally reference a source path and Git commit.
- [ ] Memory update is explicit and persists.
- [ ] Memory deletion is explicit and scoped to the correct project.
- [ ] Proposed, confirmed, obsolete, and rejected states have defined transitions.
- [ ] An agent suggestion cannot become confirmed without an explicit approval action.
- [ ] A source change can mark a related memory as requiring review without silently rewriting the decision.
- [ ] Search excludes rejected memories by default.
- [ ] Memory operations from one project cannot expose another project's content.

## 8. Phase 5 — Task context builder

- [ ] A task description can be passed to the context builder without requiring an LLM.
- [ ] Context can include relevant files, symbols, dependencies, memories, and tests when available.
- [ ] Every included code fact has a source reference.
- [ ] The builder deduplicates repeated entities and overlapping excerpts.
- [ ] The builder respects configured item and output-size budgets.
- [ ] If a budget is exceeded, lower-ranked context is omitted predictably.
- [ ] The output explains why each major item was selected.
- [ ] Missing, ambiguous, and stale information is explicitly marked.
- [ ] A follow-up lookup can retrieve additional detail without rebuilding the whole context.

## 9. Phase 6 — MCP integration

- [ ] MCP server startup is deterministic and documented for the supported clients.
- [ ] The server is bound to the intended repository and does not infer a different project silently.
- [ ] All tools use validated schemas and bounded result sizes.
- [ ] Errors are returned in a way the client can understand.
- [ ] Read tools do not write durable memories or modify the source repository.
- [ ] Component and context tools use the same core APIs as the CLI.
- [ ] OpenCode integration is exercised end to end.
- [ ] At least one additional MCP-compatible client is tested before stable release.
- [ ] MCP protocol/SDK updates are covered by compatibility tests.

## 10. Phase 7 — Git awareness and freshness

- [ ] The index records the source revision used to create it when Git metadata is available.
- [ ] Dirty working-tree changes can be detected.
- [ ] Branch changes cannot silently make the index appear current when source differs.
- [ ] Renames and deletions do not leave stale file identities or edges.
- [ ] A missed file-watcher event is recovered by reconciliation.
- [ ] A clean reindex and incremental reconciliation converge to equivalent logical state.
- [ ] Worktrees and submodules have documented identity and storage behavior before being declared supported.
- [ ] Retrieval can tell the client when the working tree is newer than the indexed revision.

## 11. Phase 8 — Evaluation and performance

- [ ] A reproducible fixture corpus is checked into the repository or generated deterministically.
- [ ] At least small, medium, and large repository cases are measured.
- [ ] Initial and incremental index timings are recorded.
- [ ] Search and graph traversal latency are recorded.
- [ ] Database size and peak memory are recorded.
- [ ] Retrieval precision/recall is measured against labeled queries.
- [ ] Agent task comparisons use the same repository, task, model, and comparable conditions.
- [ ] Performance optimizations include regression tests.
- [ ] No numeric improvement claim is made without reproducible measurements.

## 12. Phase 9 — Optional semantic retrieval

- [ ] Core functionality remains usable with embeddings disabled.
- [ ] Embedding provider is optional and configurable.
- [ ] Remote embedding calls are never made without explicit user configuration.
- [ ] Embedding records include provider/model identity and source revision.
- [ ] Model/provider changes trigger appropriate re-embedding.
- [ ] Hybrid retrieval can explain lexical, structural, and semantic contributions.
- [ ] Semantic retrieval demonstrates measurable improvement over the lexical/structural baseline.
- [ ] No GPU or paid API is required for the default installation.

## 13. Phase 10 — Stable release

- [ ] Windows, macOS, and Linux installation paths are tested.
- [ ] npm package contents include all runtime files and exclude development-only artifacts.
- [ ] Fresh installation and upgrade paths are documented.
- [ ] Database migrations are tested from supported prior versions.
- [ ] CLI help and documentation match actual commands.
- [ ] Security, privacy, and exclusion behavior are documented accurately.
- [ ] License and third-party dependency notices are included.
- [ ] Contribution and issue-reporting guidance is present.
- [ ] CI covers typecheck, tests, build, and supported Node.js versions.
- [ ] Public release occurs only after explicit maintainer approval.

## 14. Evidence required for closing a task

Every completed implementation task should report:

1. Files changed.
2. Behavior implemented.
3. Tests added or updated.
4. Commands executed.
5. Actual results (pass/fail/not run).
6. Remaining limitations or risks.
7. Whether documentation was updated.

Never say a build, test, push, or integration succeeded unless it was actually executed and its result observed.
