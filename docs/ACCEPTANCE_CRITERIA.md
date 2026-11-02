# Acceptance Criteria

**Product:** Codebase Neural Memory (CNM)  
**Purpose:** Verifiable completion conditions for the roadmap  
**Last reviewed:** 2026-11-01

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
- [x] Impact returns known reverse dependents for fixture imports, including transitive dependents; traversal is bounded by result and relation-processing budgets, reports truncation/processing metrics, and is covered for cycles, duplicates, missing targets, and invalid limits (`tests/retrieval.test.ts`; CLI/MCP smoke coverage in `scripts/phase-3-smoke.mjs`; PR #29).
- [ ] Remember persists a note across separate CLI invocations.
- [ ] Memories can be filtered and are scoped to the current project.

### MCP
- [ ] The MCP server starts using stdio from the configured project directory.
- [x] The current server exposes the documented read-only retrieval tools, including bounded `source_excerpt` for indexed implementation lines; the original ten-tool Phase 6 contract remains historical evidence.
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
- [ ] External package resolution and named/default import bindings are checked with the project TypeScript resolver; missing packages and missing exports are persisted and exposed through bounded `project_map` diagnostics (`tests/indexer.test.ts`).
- [x] Cross-file symbol edges are created only when static evidence supports the resolution (named exports, aliases, shadowing, non-exported symbols, and ambiguous heritage fixtures).

## 6. Phase 3 — Retrieval

- [x] Exact symbol lookup returns expected matches (fixture verifies `explainSymbol` resolves an exact declaration with source location).
- [x] Partial lexical lookup returns relevant matches with stable limits (prefix search and bounded result count are covered by `tests/retrieval.test.ts`).
- [x] Empty and punctuation-only queries return an empty result safely; invalid result limits are rejected (`tests/retrieval.test.ts`).
- [x] Symbol retrieval results include file path, symbol kind, and line range when available (verified by exact and partial lookup fixtures).
- [x] Direct dependency lookup returns expected edges with relation provenance, confidence, and index revision (`tests/retrieval.test.ts`).
- [x] Transitive dependency lookup returns depth and dependency chains, protects against cycles/duplicates, and reports result/processing truncation (`tests/retrieval.test.ts`).
- [x] Every adjacent edge in a transitive dependency chain carries its own relation, provenance, confidence, and index revision (`chainEvidence`; `tests/retrieval.test.ts`).
- [x] Symbol retrieval explains ranking signals (exact name, name-term coverage, signature-term coverage, export status, and FTS5 BM25); FTS fallback is restricted to FTS5-specific availability/query errors.
- [x] MCP symbol filters (kind, project-relative path prefix, and export status) are applied before the bounded candidate limit; regression coverage places the only matching symbol beyond the unfiltered 1,000-row window.
- [x] SQL LIKE fallback escapes literal percent, underscore, and backslash characters so user terms cannot expand wildcard matches (`tests/retrieval.test.ts`).
- [x] File detail retrieval reuses indexed file metadata, symbols, resolved/unresolved imports, symbol relations, and provenance without creating inferred entities.
- [x] File detail retrieval bounds each collection, validates limits, and reports total counts and per-collection truncation through core, CLI, and MCP (`tests/retrieval.test.ts`).
- [x] A labeled ten-query lexical relevance fixture corpus asserts expected top results for exact, multi-term, participant, validation, and tournament-domain queries (`tests/fixtures/retrieval-relevance.ts` and `tests/retrieval.test.ts`).
- [x] Retrieval identifies stale or incomplete index state (the freshness report compares source hashes and additions/deletions without mutating the index; incomplete discovery is surfaced separately).
- [x] Schema migration v6 → v7 adds persisted index exclusions with a `[]` default and is covered for existing data and repeat execution (`tests/migrations.test.ts`).
- [x] Relevance tests use labeled expected results rather than subjective spot checks alone (`tests/fixtures/retrieval-relevance.ts` and `tests/retrieval.test.ts`).


### Phase 3 close-out verification (required before declaring the phase closed)

The retrieval feature checklist above records implemented behavior and its focused test evidence. The phase is not formally closed until this execution record is completed from a clean checkout.

- [x] Install dependencies from the committed lockfile with the documented Node.js version (npm ci --no-audit --no-fund).
- [x] Run npm run typecheck and record the actual result.
- [x] Run npm test and record the actual result, including the retrieval and migration suites.
- [x] Run npm run build and record the actual result.
- [x] Run the documented retrieval CLI smoke checks, including exact/lexical lookup, dependencies, file details, and freshness.
- [x] Verify the corresponding read-only MCP retrieval tools and their input/result bounds.
- [x] Review the final diff and confirm retrieval/freshness operations did not modify repository source files.
- [x] Record commit, environment, commands, pass/fail/not-run outcomes, and any platform limitations in the phase close-out report.

### Phase 3 clean-checkout verification record

- **Result:** PASS
- **Verified merge commit:** `553b3acbe3ef868fd4ef49fadb189ae2b92c1c2e` (PR #26)
- **CI run:** [GitHub Actions #41185088116](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41185088116)
- **Environment:** GitHub-hosted `ubuntu-latest`, Node.js 22, npm; clean `actions/checkout` followed by lockfile install.
- **Commands passed, in workflow order:** `npm ci --no-audit --no-fund`; `npm run typecheck`; `npm test`; `npm run build`; `npm run smoke`.
- **CLI smoke coverage:** help, init, index, lexical symbol search, bounded dependency traversal, bounded file details, and current freshness.
- **MCP smoke coverage:** stdio initialization and tool discovery; `symbol_lookup`, `dependency_graph`, `file_details`, and `index_freshness` calls with explicit limits; freshness reports current.
- **No-mutation check:** SHA-256 hashes of fixture source files before and after CLI/MCP read operations matched. The smoke fixture is created in a temporary directory and removed afterward.
- **Diff review:** PR #26 changes only the smoke script, npm script declaration, and CI workflow; no application source files were changed.
- **Limitations:** This records the Linux/Node 22 CI environment. Other operating systems and repository-scale performance/relevance benchmarks remain outside this Phase 3 verification; benchmark work belongs to Phase 8.

### Phase 3 reverse-impact follow-up verification

- **Result:** PASS
- **Merged PR:** [#29 — bounded and verified reverse impact retrieval](https://github.com/Daniel9822/codebase-neural-memory/pull/29)
- **Verified merge commit:** `000c4d7f0041e680f5c431097fb58b9dbd83a1a3`
- **CI run:** [GitHub Actions #41186793246](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41186793246) — `success`.
- **Commands passed:** `npm ci --no-audit --no-fund`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run smoke`.
- **Reverse-impact behavior:** `findImpact` enforces configurable result and relation-processing limits, validates bounds, and returns `truncated`, `processedFiles`, `processedRelations`, and effective limits.
- **Regression coverage:** direct and transitive reverse dependents, cycles, duplicate paths, result and processing truncation, missing targets, and invalid limits in `tests/retrieval.test.ts`.
- **CLI/MCP smoke:** exercises `cnm impact` and MCP `change_impact`; MCP output is parsed as JSON and its affected paths and truncation flag are asserted. The full smoke suite passed in the post-merge CI run.

Phase 3 is formally closed on the verified commit above.

Repository-scale benchmarks, larger precision/recall studies, and performance baselines are Phase 8 work. They must not be used to expand Phase 3 scope or to block its closure once the Phase 3 exit condition above is satisfied.

## 7. Phase 4 — Memory lifecycle

- [x] A memory has a stable UUID, category, title, content, status, and timestamps (`tests/memories.test.ts`).
- [x] A memory can optionally reference a source path and Git commit (`tests/memories.test.ts`).
- [x] Memory update is explicit, partial, and persists (`tests/memories.test.ts`).
- [x] Memory deletion is explicit and scoped to the correct project (`tests/memories.test.ts`).
- [x] Proposed, confirmed, obsolete, and rejected states have defined, validated transitions; rejected is terminal (`tests/memories.test.ts`).
- [x] A proposed suggestion cannot become confirmed without an explicit transition/approval action (`tests/memories.test.ts`).
- [x] A changed or missing source file is reported as requiring review without silently rewriting memory content or status (`tests/memories.test.ts`).
- [x] Search excludes rejected memories by default (`tests/memories.test.ts`).
- [x] Memory operations from one project cannot expose or delete another project's content (`tests/memories.test.ts`).
- [x] Optional memory `commitSha` references are compared with current Git `HEAD` ancestry (`current`, `ancestor`, `ahead`, `diverged`, `unknown`, `unavailable`); non-current/unavailable references require review without mutating memory lifecycle (`tests/git-awareness.test.ts`).
- [x] Optional author identity is retained separately from the identity of the latest updater; attribution is explicit and never inferred from external accounts (`tests/memories.test.ts`, migration v9).

### Phase 4 close-out verification (required before declaring the phase closed)

- **Result:** PASS
- **Status:** Phase 4 is formally closed on 2026-10-31.
- **Verified merge commit:** `921be0d219e9ccbd151fa49008a691cee4287bcb` (PR #31; author provenance).
- **Post-merge CI run:** [GitHub Actions #41188733503](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41188733503) — `success`.
- **Environment:** GitHub-hosted `ubuntu-latest`, Node.js 22, npm; clean checkout of `main`.
- **Commands passed, in workflow order:** `npm ci --no-audit --no-fund`; `npm run typecheck`; `npm test`; `npm run build`; `npm run smoke`.
- **Coverage represented by the verification:** database migration and memory tests, plus CLI/MCP smoke coverage for memory lifecycle, freshness inspection, explicit author attribution, and updater attribution.
- **Follow-up delivery:** Git commit ancestry comparison was deferred at the original Phase 4 close-out and is now delivered by Phase 7 PR #48. It remains read-only and does not change memory lifecycle state.
- **Limitations:** This records the Linux/Node 22 CI environment. Other operating systems are not claimed as verified by this run.
## 8. Phase 5 — Task context builder

- [x] A task description is accepted without requiring an LLM; lexical anchors and retrieval are deterministic.
- [x] Context can include relevant files, symbols, direct dependencies, memories, and relevant tests.
- [x] Every included code fact has a source reference (symbol path/line range; file/dependency/test path; memory source path or stable memory ID).
- [x] Repeated entities are deduplicated before ranking and budget application. Overlapping excerpts are not emitted by this API, so excerpt-overlap deduplication is not applicable.
- [x] The builder respects `maxItems` and the exact serialized-character budget.
- [x] `maxCharacters` is defined as `JSON.stringify(result.items).length`: the character count of the complete serialized items array, including opening/closing brackets, commas, quotes, and all serialized item fields. It excludes task text, anchors, warnings, follow-up prompts, and budget metadata. For an empty result, the count is 2 (the serialized value `[]`).
- [x] Candidates are ranked deterministically; lower-ranked items that do not fit are omitted and truncation is reported.
- [x] Repository-wide test-path candidates are included only when the test path contains at least one lexical task anchor; unrelated test paths are excluded. Tests already discovered as a matching symbol source remain eligible on their symbol evidence.
- [x] The output explains selection through ranking `signals`.
- [x] Missing, ambiguous, and stale information is explicitly marked, including stale/incomplete source-index warnings.
- [x] A follow-up lookup retrieves additional details without rebuilding task ranking, symbol search, or memory recall.

### Regression evidence

- `tests/context.test.ts` includes both relevant `tests/auth.test.ts` and unrelated `tests/billing.test.ts`; the auth task includes only the relevant path candidate.
- Budget tests assert `usedCharacters === JSON.stringify(items).length`, exact-fit inclusion, and exclusion of a candidate that no longer fits; a smaller later candidate may still use the remaining budget.
- Existing regression coverage exercises source references, dependencies, memories, unresolved imports, stale index state, deduplication, item limits, truncation, and incremental lookup.

### Phase 5 close-out verification

- **Status:** PASS — Phase 5 formally closed on 2026-10-31 after successful default-branch CI verification.
- **Merged freshness baseline:** PR [#36](https://github.com/Daniel9822/codebase-neural-memory/pull/36), merge commit `992fcd3c2aebc8029b3ca2f24a3c3e76aeba1bb6`.
- **Post-merge CI for PR #36:** [GitHub Actions #41233040729](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41233040729) — success; `npm ci`, typecheck, tests, build, and smoke all completed successfully.
- **Environment:** GitHub-hosted Ubuntu, Node.js 22.
- **Final close-out PR:** [#37](https://github.com/Daniel9822/codebase-neural-memory/pull/37) merged into `main` at `f4f5aa6612de5aafdf4423095251030ac862b12b`; it includes test relevance filtering, exact serialized-array budget semantics, and regression fixtures.
- **PR verification:** [GitHub Actions #41233795736](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41233795736) — success; install, typecheck, tests, build, and smoke steps all completed successfully on the final PR head.
- **Default-branch verification:** [GitHub Actions #41250061815](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41250061815) — success on `main` at merge commit `f3c74147ce6b9cad2100156a644c404b965d6f6a`; clean checkout, lockfile install, typecheck, tests, build, and smoke all passed.
- **Limitations:** retrieval is lexical/structural and does not promise semantic completeness. The API emits structured file details rather than text excerpts. Incremental lookup is core API only; no dedicated CLI/MCP lookup command is exposed.

## 9. Phase 6 — MCP integration

### Block 1 — Audit and contract documentation

- [x] The registered tool inventory is exactly the ten tools in `src/adapters/mcp/server.ts`.
- [x] Every tool's Zod input schema, optional arguments, defaults, and adapter-level hard limits are documented in `docs/PHASE_6_MCP_CONTRACT.md`.
- [x] Each tool is mapped to the core operation it invokes.
- [x] Stdio startup, working-directory project binding, initialized-project guard, and the read-only boundary are documented.
- [x] README, ARCHITECTURE, PRODUCT_SPEC, ROADMAP, and ACCEPTANCE_CRITERIA reference the same contract and do not advertise unregistered tools.
- [x] Unverified protocol behavior and client integration are explicitly labeled as pending rather than claimed as complete.

### Block 2 — Adapter protocol tests

- [x] Tests use the real server/SDK with in-memory transport and the real CLI stdio process.
- [x] Discovery returns exactly ten tools with the expected schemas.
- [x] At least one valid call is tested for every registered tool.
- [x] Zod-invalid arguments and core handler exceptions are rejected with the observed MCP error envelope (`isError: true`).
- [x] Repeated calls, EOF/shutdown, and reconnection are tested, including a restarted stdio process.
- [x] Read calls do not mutate repository source files, index records, or durable memory records.

**Evidence:** CI run [41238294195](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41238294195) passed all 82 tests across 9 test files, `npm run typecheck`, `npm run build`, and `npm run smoke`.

### Block 3 — Limits, paths, and isolation

- [x] Every response collection is bounded at the MCP boundary and reports totals/truncation where applicable.
- [x] `index_freshness.skippedFiles` and `index_freshness.errors` are bounded and expose total counts plus truncation flags.
- [x] `memory_freshness` is bounded and exposes the total eligible count plus a truncation flag.
- [x] `project_map` exposes the total indexed-file count and a truncation flag when the result limit is reached; nested imports and candidate paths are also bounded.
- [x] Boundary tests cover exact-limit, over-limit, empty, and incomplete-discovery cases for these three tools.
- [x] Two independent MCP servers bound to different repositories cannot read each other's indexed files or memories.
- [x] Invalid, missing, unindexed, traversal, and outside-root paths produce controlled errors.

**Evidence:** CI run [41239258583](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41239258583) passed 86 tests across 10 test files, typecheck, build, and smoke.

### Block 4 — Real clients

- [x] OpenCode discovers the local stdio server and successfully executes real `project_overview` and `symbol_lookup` calls with the repository `cwd`.
- [x] VS Code discovers the workspace stdio server and GitHub Copilot Agent successfully executes real `project_overview` and `symbol_lookup` calls with `${workspaceFolder}` binding.
- [x] Record both real-client results, configuration paths, execution date, shared index metrics, and the located symbol in `docs/CLIENT_INTEGRATION.md`; SDK-only protocol tests are not counted as client integration.
- [x] Record VS Code 1.144.0 (x64), OpenCode 1.19.5, and Node.js v22.12.0.
- [x] Record the validated GitHub Copilot Agent integration as part of the VS Code 1.144.0 installation; a separate extension identifier/version is not a required acceptance datum for this environment.

### Block 5 — Regression and close-out

- [x] Clean-checkout `npm ci --no-audit --no-fund`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run smoke` all pass in default-branch CI run [41250061815](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41250061815) on merge commit `f3c74147ce6b9cad2100156a644c404b965d6f6a`.
- [x] The Phase 6 diffs across PRs #42, #43, #45, and #46 were reviewed; the changes are confined to the MCP implementation/tests, client configuration templates/tests, and intended documentation. No unrelated source or repository mutation was found.
- [x] Documentation matches the ten registered tools, schemas, limits, and tested behavior; the stale version statement in the product specification has been corrected.
- [x] The merge commit, default-branch CI run, and both real-client integration evidence records are documented.
- [x] Phase 5's default-branch close-out evidence is verified by the same successful main-branch CI run.

Blocks 1–5 are complete. Phase 6 is formally closed: the validated VS Code installation provides the integrated Copilot Agent experience, and the real MCP calls are evidenced alongside VS Code 1.144.0, OpenCode 1.19.5, and Node.js v22.12.0.

## 10. Phase 7 — Git awareness and freshness

**Status:** PASS — PR #48 merged as `c6e2d742be3df8b1e697d354a81463ae92ef7590`; default-branch CI run [41253963500](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41253963500) passed.

- [x] The index records the source commit, branch, dirty flag, working-tree status hash, and changed-path count when Git metadata is available (migration v10; `tests/git-awareness.test.ts`).
- [x] Dirty working-tree changes are detected by the Git porcelain snapshot and supported-file content hashes.
- [x] Commit and branch changes are reported as stale even when supported source-file hashes are unchanged (`tests/git-awareness.test.ts`).
- [x] Relation-resolution configuration drift, including transitive `tsconfig` extends files and relevant package manifests, marks the index stale until a successful relation rebuild updates its fingerprint (`tests/indexer.test.ts`; PR #78).
- [x] Git renames reconcile as one added and one deleted path; existing deletion tests verify stale symbols, FTS rows, and graph relations are removed.
- [x] Freshness uses a deterministic full scan rather than relying on file-watcher events; therefore missed watcher notifications cannot suppress reconciliation. A watcher is not implemented.
- [x] A clean reindex and incremental reconciliation converge to equivalent logical state across branch switches, renames, deletions, symbols, imports, calls, heritage, relations, unresolved imports, and FTS (`tests/git-awareness.test.ts`).
- [x] Worktree, submodule, and repository-move identity/storage behavior is documented; submodule isolation inside a parent scan is explicitly not claimed.
- [x] The existing CLI `cnm freshness` and MCP `index_freshness` report indexed/current commit, branch, dirty state, and whether each changed.
- [x] Memory freshness compares recorded commits with current Git ancestry, includes commit-only memories, and requires review for non-current or unavailable provenance (`tests/git-awareness.test.ts`).

## 11. Phase 8 — Evaluation and performance

- [x] A reproducible synthetic fixture corpus is generated deterministically by `scripts/benchmark.ts`.
- [x] Small, medium, and large synthetic cases (26, 101, and 301 source files) plus the checked-out CNM repository layout are measured in CI.
- [x] Initial, unchanged incremental, and one-file changed incremental index timings are recorded.
- [x] Search, dependency-graph, and freshness latency are recorded as median and p95.
- [x] SQLite size and process peak RSS are recorded, with cumulative RSS methodology documented.
- [x] Retrieval top-1 accuracy, precision@5, recall@5, and MRR are measured against ten labeled queries.
- [x] The same benchmark cases are repeated on Linux, Windows, and macOS; all three matrix jobs passed in CI run [41254663323](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41254663323).
- [x] An eight-task read-only evaluation suite, scoring rubric, and paired-run protocol are checked in (`benchmarks/agent-tasks.json`, `docs/AGENT_EVALUATION_PROTOCOL.md`).
- [ ] Actual agent task comparisons use the same repository, task, model, prompt, and comparable conditions; no paired results have been collected yet.
- [ ] Performance optimizations include regression tests; no performance optimization has been introduced in this phase slice.
- [x] No numeric improvement claim is made; the baseline is explicitly descriptive and machine-dependent.

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
- [x] Database migration v6 → v7 is tested against an existing v6 schema; migrations from other supported versions remain part of the release audit.
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


### Bounded MCP source excerpt

- [x] Source excerpts require an indexed, project-relative path and inclusive positive line range.
- [x] Lexical traversal and canonical symlink escapes outside the selected project root are rejected.
- [x] Reads are bounded to 200 lines, 20,000 output characters, and 1 MiB source files.
- [x] The response includes returned line bounds, total file lines, truncation, current source SHA-256, indexed SHA-256, and an explicit current/stale comparison.
- [x] MCP protocol tests discover the tool, validate its schema, execute a valid read, and include it in the no-mutation read-call suite.
- [x] Run the full clean-checkout CI workflow on the implementation PR; `npm ci`, typecheck, all tests, build, smoke, and Linux/Windows/macOS benchmark jobs passed.


**Source excerpt verification record**

- **Result:** PASS.
- **PR head:** `aaf49eadcf0b8b73f2f3bc69d5f8a572c51989a9`.
- **GitHub Actions:** [run 41268702640](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41268702640) — verify and Linux, Windows, and macOS benchmark jobs passed.
- **Commands passed:** `npm ci --no-audit --no-fund`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run smoke`.
- **Coverage:** core current/stale hash comparison, project-relative path and range validation, MCP tool discovery/schema/call, real stdio invocation, and existing read-only/no-mutation checks.


## 15. MCP agent-capability follow-up (PR #54 — merged)

- [x] `index_update` is discoverable and runs incremental reconciliation without force-reparsing unchanged files.
- [x] `index_update` preserves the project's persisted custom exclusion rules.
- [x] `index_update` reports the standard index summary and advances the index revision.
- [x] Selective index updates accept project-relative file and directory paths plus include globs, and reject path traversal.
- [x] File and directory-entry budgets are validated, enforced, and reported with explicit truncation metadata.
- [x] Selective and truncated updates never delete indexed files outside the selected scope; bounded explicit MCP updates can commit processed files without pretending the remaining scope was scanned.
- [x] MCP schema and valid-call tests cover selective update options; core tests cover file, directory, glob, limits, partial reconciliation, and out-of-scope deletion safety.
- [x] `memory_propose` persists a durable memory with status `proposed`, never `confirmed`.
- [x] Proposed memories remain subject to the existing explicit lifecycle transition rules.
- [x] `symbol_lookup` optional kind, file-path-prefix, and exported filters are validated and applied deterministically.
- [x] MCP protocol tests discover and call the new tools and assert the updated schemas.
- [x] Read-only protocol tests continue to prove that read calls do not mutate source, index, or memory state.
- [x] Full CI passes on the final PR head, including typecheck, tests, build, smoke, and benchmark matrix.

- [x] Bounded symbol-level impact traverses `CALLS`, `EXTENDS`, and `IMPLEMENTS` edges with shortest distances, ambiguity handling, edge provenance, and result/processing limits (`findSymbolImpact`; `tests/retrieval.test.ts`).
- [x] Recognized test callback registrations create `test-case` symbols and imported calls inside them create source-linked `CALLS` edges; `symbol_impact` exposes exact static test-to-symbol links (`tests/typescript-parser.test.ts`, `tests/retrieval.test.ts`). This is not runtime test coverage.

- [x] Bounded Git blame returns line-level commit, author, timestamp, and summary for tracked project-relative paths; rejects unsafe paths and ranges over 200 lines (`tests/git-awareness.test.ts`). Attribution is not treated as inferred rationale.
- [x] Bounded MCP `git_history` returns recent commit metadata and changed-path evidence with 1–50 commit and 1–500 path budgets, a 3-second subprocess timeout, and explicit truncation flags (`tests/git-awareness.test.ts`, `tests/mcp-adapter.test.ts`). Commit boundaries are not represented as agent sessions.

The following capabilities remain open: signature-regex search, public-contract analysis, finer task-context budget categories (PR #64), and Git session rationale. Inline source retrieval, explicit task anchors, and freshness-aware read policies are covered by the follow-up criteria below.


## 16. Agent-trust and context-quality follow-up

- [x] Every indexed MCP read checks source/index freshness before and after the operation; strict mode refuses a changed snapshot and non-strict mode emits an explicit warning (PR #77; `tests/mcp-freshness.test.ts`).
- [x] Freshness warnings include changed/added/deleted counts and affected paths while preserving the original JSON payload as the first text block.
- [x] Strict freshness mode refuses indexed reads unless freshness is current and returns an actionable refusal.
- [x] Auto-update mode performs at most one incremental refresh before a read, only when discovery is complete and no more than 50 source files changed.
- [x] Auto-update remains opt-in and never modifies source files; incomplete or large change sets require explicit index_update.
- [x] symbol_lookup can include bounded source for each result, with working-tree hash, indexed hash, and indexStatus.
- [x] file_details can include bounded snippets for a limited number of symbols.
- [x] task_context accepts explicit path/symbol anchors, suppresses broad lexical fallback in anchored mode, and labels items as anchor, graph, or fallback.
- [x] Anchored context does not inject unrelated repository test paths or lexical memories.
- [x] MCP-first workflow documentation defines start-of-session freshness/memory checks, pre-edit retrieval, post-edit verification, and proposed-memory review.
- [x] Typecheck, complete test suite, build, smoke, and cross-platform CI pass on the final PR head (run 41285903567; PR #55; merge commit de0cc1056469113995647d1d10199e08da39dc42).
- [ ] Verify the new contract in at least one real OpenCode and one VS Code/Copilot client after merging; simulated protocol tests alone do not satisfy this item.

**Safety note:** the auto-update limit is a changed-file count, not a wall-clock timeout. The indexer is synchronous; no five-second cancellation guarantee is claimed. Source excerpts independently report hash status to detect a change between freshness preflight and the actual read.


**Agent-trust verification record**

- **Result:** PASS for automated verification.
- **Merged PR:** [#55 — freshness-aware MCP reads and anchored context](https://github.com/Daniel9822/codebase-neural-memory/pull/55).
- **Merge commit:** `de0cc1056469113995647d1d10199e08da39dc42`.
- **PR-head CI:** [GitHub Actions #41285903567](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41285903567) — all verify and benchmark jobs passed.
- **Commands passed:** `npm ci --no-audit --no-fund`, `npm run typecheck`, `npm test`, `npm run build`, `npm run smoke`, and benchmark on Ubuntu, Windows, and macOS.
- **Manual client verification:** still open. The new warnings, strict refusal, auto-update, inline source, and anchor schemas have automated MCP adapter coverage; a post-merge OpenCode and VS Code/Copilot manual check is not claimed.


## Agent readiness and durable memory

- [ ] `cnm init` creates a root `AGENTS.md` with accurate CNM usage instructions when none exists.
- [ ] If `AGENTS.md` already exists, initialization preserves all user-authored content and adds or updates only the CNM-managed section.
- [ ] Re-running initialization is idempotent; the managed block includes a version and content hash.
- [ ] `cnm agents-md --check` exits 0 when synchronized, 1 when outdated, and 2 when missing.
- [ ] `cnm agents-md --print` prints without writing; supported tool flavors are validated.
- [x] `memory_recall` finds relevant memories from natural-language terms, supports list/status/category filters, includes proposed memories by default without mislabeling their status, and reports total eligible records, processed candidates, and truncation when the bounded candidate window is incomplete (`tests/memories.test.ts`).
- [ ] An agent can call `memory_transition` to confirm a proposal only after the user explicitly authorizes it; no automatic promotion is allowed.
- [ ] A different agent using the same initialized project can recall the same local memories.
- [x] TypeScript semantic import diagnostics identify supported missing-package and missing-export cases during indexing; `project_map` exposes them, and `file_details` exposes bounded per-file diagnostics with totals/truncation. Compiler/build validation remains required because this is not a complete compiler run.
- [ ] Full typecheck, tests, build, smoke, and cross-platform CI pass before merge.

## CNM-06 — Deterministic bounded discovery

- [x] `maxFiles` candidate selection is deterministic across different directory-entry creation/enumeration orders (`tests/indexer.test.ts`; PR #84).
- [x] When `maxProcessed` cannot cover the complete deterministic candidate set, indexing aborts before database writes instead of committing a filesystem-order-dependent partial selection (`tests/indexer.test.ts`; PR #84).
- [ ] A directory exceeding the deterministic sorting safety cap is treated as incomplete; add a focused regression for the 100,000-entry cap and verify no partial index mutation is committed.
- [ ] Full-scope freshness reports incomplete discovery when deterministic enumeration cannot be completed; add direct freshness coverage for the sorting-cap case.
- [ ] Memory freshness inspection has a default 100-record budget, a hard maximum of 500, explicit total/truncation metadata in the CLI report, and targeted-ID evaluation for task context; validate the new tests and command contract in CI.
