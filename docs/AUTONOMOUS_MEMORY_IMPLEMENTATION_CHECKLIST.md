# CNM Master Implementation Checklist — Autonomous Persistent Knowledge

**Repository:** `Daniel9822/codebase-neural-memory`  
**Baseline branch:** `main`  
**Tracking branch:** `docs/autonomous-memory-implementation-plan`  
**Plan created:** 2026-11-02  
**Status:** Source audit and contract v2 defined. Schema v13 code and populated-v12 migration regression are in progress on `feat/autonomous-memory-schema-v13`; CI/review pending. Core operations, retrieval, MCP integration, and agent workflow are not implemented.

## How to use this checklist

- Mark a box `[x]` only after implementation or inspection is complete and evidence is recorded.
- A checked documentation item does not imply the underlying code or behavior is complete.
- Every finding must be classified as **Verified behavior**, **Confirmed defect**, **Risk**, **Missing capability**, or **Not verified**.
- Every code change must have focused regression tests, a reviewed diff, and appropriate full validation.
- Keep this file, `docs/ROADMAP.md`, `docs/PRODUCT_SPEC.md`, `docs/ACCEPTANCE_CRITERIA.md`, `docs/PHASE_6_MCP_CONTRACT.md`, `docs/AGENT_WORKFLOW.md`, `ARCHITECTURE.md`, `README.md`, `AGENTS.md`, and `CHANGELOG.md` consistent with the behavior actually merged.
- Do not mark a phase complete based on tool names, documentation claims, or a green partial test run alone.

## Initial repository audit — known baseline and open verification

Observed from the current `main` documentation and package metadata on 2026-11-02:

- The product currently has project-scoped SQLite persistence, lexical/structural retrieval, bounded task context, and an MCP adapter.
- The current documented memory workflow uses explicit `remember`, `memory_propose`, and `memory_transition`; agent-proposed memories require explicit human confirmation.
- The documented MCP contract says the current server has 18 tools; this count and every schema must be rechecked against `src/adapters/mcp/server.ts` during the source audit.
- `docs/ROADMAP.md` records Phases 3–7 as closed, while the supplied master plan adds six integrity/freshness risks and a new autonomous-memory capability set. Historical phase closures must be preserved; the new work must be tracked as new requirements rather than silently rewriting history.
- The product is explicitly local-first, source-of-truth-first, agent-agnostic, and has no mandatory cloud, LLM, embeddings, or remote service.

These baseline observations were initially documentation-level. The source audit update below records the later source-level findings and evidence. Checkboxes are maintained per requirement; unchecked items are still open or not yet verified.

## Source audit update — 2026-11-03 after CNM-06 merge

Verified against `main` at `8ffbc71109ab165f857bc5ef5393331f17130b53`, including `src/core/memories.ts`, `src/storage/database.ts`, `src/adapters/mcp/server.ts`, `tests/memories.test.ts`, `docs/AGENT_WORKFLOW.md`, and the current migration sequence (schema v12):

- **Verified behavior:** the legacy `memories` table stores UUID, category, title/content, `proposed|confirmed|obsolete|rejected`, optional source path/hash and commit SHA, author/updater, and timestamps.
- **Verified behavior:** `remember` inserts `confirmed`; `proposeMemory` inserts `proposed`; `updateMemory` overwrites fields in place; `transitionMemory` validates legacy status transitions; source/Git freshness reports review requirements without changing lifecycle.
- **Verified behavior:** MCP currently registers `memory_propose`, `memory_transition`, `memory_freshness`, and `memory_recall`. The current agent workflow still asks for explicit confirmation of proposals.
- **Confirmed capability gap:** no immutable version/history model, stable identity/current-version split, fragment store, evidence entity model, typed knowledge relations, autonomous capture API, correction API, bootstrap, or health/reconciliation APIs exist in the audited memory surface.
- **Confirmed capability gap:** legacy `updateMemory` destroys the previous field values; the current schema cannot explain why a change occurred or reconstruct earlier versions.
- **Boundary:** CNM cannot passively observe arbitrary agent conversations. Autonomous capture means the agent submits reusable findings through a supported tool without a per-item approval step.
- **Contract:** [docs/AUTONOMOUS_MEMORY_CONTRACT.md](AUTONOMOUS_MEMORY_CONTRACT.md) defines the target semantics, authority model, epistemic states, idempotency, migration mapping, compatibility, and progressive retrieval. It is a design contract, not evidence of implementation.
- **Next:** implement the schema migration and versioned core operations before adding new MCP tools. Preserve legacy IDs/data and keep legacy tool behavior explicit until migration and compatibility tests pass.

### Current integrity workstream status

- CNM-01: implemented across the relation-configuration fingerprint work; conservative manifest fingerprinting remains a documented precision trade-off.
- CNM-02: closed for the defined threat boundary; unsafe directory scopes are protected, with portable Node directory race limitations documented.
- CNM-03: CLI-facing full-index guards exist, but the comprehensive audit of every internal/destructive reconciliation entry point remains open.
- CNM-04: strict/non-strict post-read freshness behavior and representative independent-process interleavings are implemented; the test scope is not an exhaustive scheduler/power-loss proof.
- CNM-05: closed for the defined threat boundary; descriptor-verified file reads and path-based directory identity checks retain a documented swap-and-restore residual.
- CNM-06: PR #135 merged; CI run [41718023148](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41718023148) completed successfully.

The six-item audit is therefore substantially advanced, but CNM-03 and combined cross-surface close-out should not be represented as fully closed until their remaining checklist evidence is recorded.

## Definition of done — applies to every implementation task

- [ ] Reproduce or otherwise demonstrate the target behavior with a focused test before/alongside the fix.
- [ ] Implement the smallest coherent change within existing architecture; no unrelated refactors.
- [ ] Cover success, boundary, failure, stale/incomplete, and relevant adversarial cases.
- [ ] Preserve backward compatibility or provide a tested forward-only migration and rollback/recovery guidance where appropriate.
- [ ] Verify bounds, deterministic ordering, project isolation, provenance, and error behavior where relevant.
- [ ] Run focused tests, `npm run typecheck`, `npm test`, `npm run build`, and `npm run smoke` when the environment supports them.
- [ ] Review the complete diff, public API/schema changes, generated instructions, and docs.
- [ ] Record commands, results, environment limitations, commit/PR/CI evidence, and remaining risks.
- [ ] Merge only after review and required CI pass; verify the resulting `main` state before proceeding.

---

# Workstream A — Audit and close the six integrity/freshness risks

## A0. Establish an evidence-based baseline

- [ ] Record `main` HEAD SHA, open PRs, working tree/branch context available through GitHub, and recent merges.
- [ ] Inventory source tree, migrations, tests, scripts, CI workflows, public CLI commands, MCP registrations, and all index/reconciliation entry points.
- [ ] Run or verify latest clean-checkout CI for install, typecheck, full tests, build, and smoke; distinguish current-main evidence from historical CI.
- [ ] Build a requirement-to-code-to-test matrix for CNM-01 through CNM-06.
- [ ] For every requirement, record current behavior, evidence, classification, gap, proposed fix, and acceptance test.
- [ ] Identify platform-specific constraints (Windows/macOS/Linux) and tests that cannot run in the available CI environment.
- [ ] Publish audit findings before making behavior-changing edits.

## A1. CNM-02 — Protect indexed records from directory symlinks

- [ ] Trace discovery, symlink classification, completeness flags, and every reconciliation/deletion path.
- [x] Reproduce: index real files, replace a directory with a directory symlink, run indexing/reconciliation (PR #75; `tests/indexer.test.ts`; CI 41404323034).
- [x] Ensure symlink directories are never followed outside the project root (PR #75; directory symlink is skipped and its scope protected).
- [x] Represent unsafe/uninspectable discovery as incomplete/protected, not as proof that previously indexed files were deleted (PR #75; full reconciliation aborts).
- [ ] Prevent deletion of file, symbol, relation, and FTS records under an uninspected scope.
- [ ] Add regression tests for directory symlinks, replacement after initial indexing, nested links, dangling links, and supported platform behavior.
- [ ] Verify safe behavior for full and selective/budgeted indexing.
- [ ] Document exact guarantees and limitations.

**Acceptance:** prior records survive or destructive reconciliation aborts with an explicit incomplete/protected reason; no outside-root traversal; no false deletion.

## A2. CNM-01 — Include relation-resolution configuration in freshness

- [ ] Inventory every input that affects import/relation resolution (including applicable `tsconfig.json`, `package.json`, and any other actually consumed configuration).
- [x] Trace how configuration is read, normalized, fingerprinted, persisted, and compared by freshness (PR #82; CI 41406437168).
- [ ] Define a fingerprint that changes only for resolution-relevant inputs. Current implementation fingerprints whole relevant `package.json` files conservatively, so unrelated manifest edits can also mark the index stale; narrow to resolution-relevant fields if measurements justify it.
- [x] Persist the fingerprint atomically with the index/relation revision (existing index transaction, verified by config-only rebuild test in PR #82).
- [ ] Report missing, changed, malformed, and unreadable configuration distinctly.
- [x] Add a non-Git fixture that modifies a `tsconfig` alias without changing source files (PR #82; `tests/indexer.test.ts`).
- [x] Verify relation rebuilding updates graph edges and returns freshness to current after a config-only change (PR #82; `tests/indexer.test.ts`).
- [ ] Test unchanged normalized configuration, invalid JSON, removed config, and configuration read failures.

**Acceptance:** a relevant configuration change is detected even without Git or source-file changes; relation rebuild is reproducible and freshness returns to current only after successful completion.

## A3. CNM-04 — Harden freshness for MCP reads

- [ ] Enumerate all MCP indexed-read handlers and their preflight/update/read sequences.
- [ ] Identify operations that can mix index revisions or source snapshots.
- [x] Define strict and non-strict behavior for state changes during a read (PR #77; `tests/mcp-freshness.test.ts`).
- [x] Recheck relevant source freshness and index revision after the operation (PR #77; `readResponse`).
- [x] In strict mode, reject inconsistent results with a structured, actionable error (PR #77).
- [x] In non-strict mode, preserve useful output with an explicit post-read inconsistency warning (PR #77).
- [x] Refuse strict reads when the index revision changes during the operation; warn in non-strict mode (PR #77).
- [ ] Add deterministic race/injected-change tests for source mutation, index revision change, and discovery becoming incomplete.
- [ ] Verify error envelopes and response bounds remain consistent with the MCP contract.

**Acceptance:** a read whose relevant snapshot changes during execution is rejected in strict mode and clearly marked inconsistent in non-strict mode; stable reads remain backward compatible.

## A4. CNM-05 — Secure file open/read against symlink races

- [x] Inventory project-controlled file reads/opens across source excerpts, indexer/configuration, TypeScript compiler inputs, memory source fingerprints, and managed agent instructions (`safe-file.ts`, `indexer.ts`, `import-diagnostics.ts`, `memories.ts`, `retrieval.ts`, `agents-md.ts`).
- [x] Identify TOCTOU gaps between path validation, open, read, and directory enumeration; distinguish content-read guarantees from path-based directory metadata checks.
- [x] Harden project-local reads with descriptor verification, `O_NOFOLLOW` where available, root containment and before/after identity checks; reject hard-linked local source/config/managed-instruction inputs where requested. Package-manager stores and TypeScript library roots remain explicitly scoped.
- [x] Verify opened file identity against the resolved path and revalidate after reading; managed `AGENTS.md` writes also reject symlink/hardlink targets and use exclusive creation.
- [x] Define the portable fallback: fail closed on detected unsafe substitutions; document that path-based directory enumeration cannot prove resistance to every swap-and-restore race.
- [x] Add deterministic file/directory replacement regressions across safe reads, indexer discovery, and TypeScript package-root enumeration.
- [x] Test traversal, absolute paths, hard links, dangling symlinks, final-component symlinks, and file/directory replacement.
- [x] Confirm rejected inputs do not return outside-root file content; supported package-manager and TypeScript library inputs remain constrained to approved roots. PR #133 merged as `5b024794bf96ff102cdbbd298b2f2c1464ccbeb7`; CI 41542394157 passed all five jobs.

**Acceptance:** project-local content reads are descriptor-verified and fail closed on detected substitution; unsupported descriptor-bound directory guarantees are explicitly documented. This is not a claim that every path-based directory race is eliminated.
## A5. CNM-06 — Deterministic candidate selection under limits

- [x] Inventory bounded/ranked collections across symbol search/exact lookup/relations, file/project/component maps, dependency/change/symbol-impact traversals, task context, memories, Git history/blame, freshness, and index-update diagnostics.
- [x] Define locale-independent code-unit tie-breakers for symbol rank, exact lookup, relation details, graph edges, and context candidates; SQL queries include stable path/line/name/kind/signature/ID or relation evidence keys.
- [x] Normalize explicit task-context anchors, follow-up source paths, and set-valued symbol-impact relation filters before candidate selection/truncation.
- [x] Collect dependency/test context candidates before applying per-kind output limits; rank/deduplicate deterministically, with a bounded per-anchor graph query and an explicit 500-path lexical test-discovery window.
- [x] Make duplicate candidate resolution stable on equal scores; apply per-kind, global item, and exact serialized-character budgets after ranking, and report every omitted kind including omissions caused by global/character limits.
- [x] Preserve nested candidate totals across omitted unresolved imports in `file_details`; expose `resultsTruncated` for exact-symbol, symbol-relation, and symbol-search result caps, plus `candidateWindowTruncated` for bounded search candidate discovery.
- [x] Add regressions for reversed explicit anchors/follow-up paths, relation-filter permutations, candidate-window overflow, exact symbol/relation truncation, nested candidate totals under a smaller file-details limit, and context truncation-kind metadata.
- [x] Document intentional bounded windows and their truncation signals; identical indexed state and normalized parameters produce identical selected results and metadata.

**Acceptance:** identical logical inputs and parameters produce identical selected items, order, totals, and truncation metadata. Any bounded candidate window that can omit matches exposes a truncation signal.
## A6. CNM-03 — Require complete snapshots for destructive selective paths

- [ ] Inventory all full, selective, bounded, retry, and failure recovery index paths.
- [ ] Mark discovery completeness and selected scope explicitly in the internal result contract.
- [ ] Identify every deletion/reconciliation call reachable after partial, truncated, failed, or unsafe discovery.
- [ ] Require a complete validated snapshot before every destructive reconciliation. The CLI-facing `indexProject` and `updateProjectIndex` paths now guard unscoped runs (PR #79), but all direct/internal entry points still need audit.
- [ ] Preserve records outside inspected scope and under incomplete scopes.
- [ ] Add failure injection for traversal limits, unreadable directories, symlinks, parser failures, interruption, and partial discovery.
- [ ] Verify index, symbols, relations, and FTS updates are atomic/recoverable as designed.
- [ ] Test full rebuild equivalence and selective-update non-deletion guarantees.
- [ ] Document each update mode's exact safety contract.

**Acceptance:** incomplete or partial discovery cannot trigger destructive cleanup of unobserved records; every mutation is confined to a validated scope.

## A7. Cross-cutting security/freshness close-out

- [ ] Test combinations of CNM-01/02/03/04/05/06, not only isolated unit cases.
- [ ] Review SQLite transactions and consistency across file, symbol, relation, FTS, and revision records.
- [ ] Run platform CI and targeted symlink/race tests on supported OSes where feasible.
- [ ] Update `docs/ACCEPTANCE_CRITERIA.md`, `docs/ROADMAP.md`, `ARCHITECTURE.md`, MCP contract, README, and CHANGELOG.
- [ ] Record PR/commit/CI evidence and close each risk only after acceptance passes.

---

# Workstream B — Specify the autonomous knowledge contract

## B1. Model and vocabulary

- [x] Audit existing memory schema, migrations, CRUD, statuses, source links, commit metadata, and freshness behavior (main schema v12; `memories.ts`, `database.ts`, MCP adapter, tests inspected 2026-11-03).
- [x] Define stable knowledge identity separately from version identity (`docs/AUTONOMOUS_MEMORY_CONTRACT.md`).
- [x] Define extensible knowledge types: behavior, architecture, infrastructure, procedure, convention, decision, incident, solution, test/evidence, constraint, hypothesis, pending question, and lesson (`docs/AUTONOMOUS_MEMORY_CONTRACT.md`).
- [x] Separate lifecycle (`active`, `superseded`, `archived`) from epistemic state (`observed`, `verified`, `inferred`, `user_asserted`, `planned`, `hypothesis`, `pending_validation`) and optional confidence (`docs/AUTONOMOUS_MEMORY_CONTRACT.md`).
- [x] Define source/provenance records: code path/symbol/hash, commit/index revision, test command/result, user correction, agent/tool origin, and timestamps (`docs/AUTONOMOUS_MEMORY_CONTRACT.md`).
- [x] Define contradiction, supersession, merge/split, and dependency relation semantics (`docs/AUTONOMOUS_MEMORY_CONTRACT.md`; ambiguous automatic merges are prohibited).
- [x] Specify idempotency, optimistic concurrency, transactional version/event writes, and retry behavior for capture/update/correction (`docs/AUTONOMOUS_MEMORY_CONTRACT.md`).
- [x] Define privacy filters that prevent secrets, credentials, and irrelevant transient conversation content from entering memory (`docs/AUTONOMOUS_MEMORY_CONTRACT.md`).
- [x] Define API contracts, validation, response bounds, and structured error shapes before implementation (`docs/AUTONOMOUS_MEMORY_CONTRACT.md`, Sections 8.1–8.2).
- [x] Review the contract against backward compatibility and local-first/no-remote-dependency constraints (`docs/AUTONOMOUS_MEMORY_CONTRACT.md`).

## B2. Resolve product decisions explicitly

- [x] Define what qualifies as reusable knowledge and what must not be captured (transient chatter, secrets, unverified claims represented as facts) (`docs/AUTONOMOUS_MEMORY_CONTRACT.md`).
- [x] Define how autonomous capture is triggered by agent behavior versus what CNM can itself observe; do not claim passive conversation capture unless the integration actually supplies those events (`docs/AUTONOMOUS_MEMORY_CONTRACT.md`).
- [x] Define how user corrections are detected from explicit correction tools and natural-language agent interpretation; preserve the distinction between desired behavior and current code behavior (`docs/AUTONOMOUS_MEMORY_CONTRACT.md`).
- [x] Define conflict policy between source/test evidence, user-stated intent, prior memory, and agent inference (`docs/AUTONOMOUS_MEMORY_CONTRACT.md`).
- [x] Define whether capture writes active knowledge immediately or stages low-confidence items as hypotheses/pending validation without requiring user confirmation (`docs/AUTONOMOUS_MEMORY_CONTRACT.md`).
- [x] Define audit/history retention and bounded pruning policy without deleting necessary provenance: no automatic pruning in the initial implementation; bounded/paginated reads only (`docs/AUTONOMOUS_MEMORY_CONTRACT.md`).
- [x] Define worktree/project identity policy that avoids accidental repository mixing: no implicit sharing; explicit linking remains deferred (`docs/AUTONOMOUS_MEMORY_CONTRACT.md`).
- [x] Define compatibility/migration strategy for current `proposed`, `confirmed`, `obsolete`, and `rejected` memories (`docs/AUTONOMOUS_MEMORY_CONTRACT.md`).
- [ ] Update Product Spec, Architecture, Roadmap, Acceptance Criteria, MCP contract, Agent Workflow, AGENTS, README, and Changelog to one coherent contract.

**Acceptance:** written contract distinguishes actual behavior, verified evidence, user intent, plans, and hypotheses; normal agent capture does not require per-item user approval; local-first and bounded-response constraints remain intact.

---

# Workstream C — Evolve SQLite schema and preserve existing memories

## C1. Schema design and migration

- [ ] Map current schema and all foreign keys/indexes/triggers/FTS dependencies.
- [x] Design normalized tables for knowledge identity, versions, fragments, evidence, typed relations, append-only events, and idempotency records (`src/storage/database.ts`, schema v13; implementation review/CI pending).
- [x] Add initial project/type/lifecycle, version, fragment, evidence-source, relation traversal, and event indexes plus enum/range/uniqueness constraints (`src/storage/database.ts`, schema v13; current-version invariant and query-plan validation remain open).
- [x] Implement forward-only v12→v13 transactional DDL/backfill with deterministic legacy IDs and retry-safe inserts (`src/storage/database.ts`; CI/review pending).
- [x] Preserve legacy IDs and exact title/content/category/status/source/hash/commit/author/updater/timestamps while retaining the old table (`src/storage/database.ts`; regression test added, CI pending).
- [ ] Define downgrade/recovery policy; do not claim destructive downgrade support without implementation.
- [ ] Test migration from every supported prior schema version, including empty and populated databases. A populated-v12 regression has been added; it still needs CI and explicit empty/older-version coverage.
- [ ] Test interrupted migration/reopen, duplicate IDs, invalid legacy data, FTS consistency, and foreign-key integrity. Retry/idempotency is partially covered by the populated-v12 test; crash-boundary and full integrity checks remain open.
- [ ] Add schema version and data-integrity checks to health/status reporting where appropriate.

**Acceptance:** existing user memories survive migration unchanged in meaning and remain retrievable; migration is repeatable/safe under supported recovery conditions.

## C2. Versioned knowledge operations

- [ ] Define immutable version records and the single current-version invariant.
- [ ] Record each change as an auditable event with reason, actor/source, timestamp, and affected knowledge IDs.
- [ ] Ensure updates create versions/events instead of silently overwriting history.
- [ ] Ensure superseded versions remain retrievable through history but are not presented as current by default.
- [ ] Add transactional merge/split/relationship operations with provenance preservation.
- [ ] Add tests for rollback, concurrent updates, duplicate retries, and version ordering.

---

# Workstream D — Autonomous capture, update, correction, and reconciliation

## D1. `memory_capture`

- [ ] Implement bounded, validated capture input and output contracts in the core memory engine.
- [ ] Support small knowledge units and structured metadata without requiring an LLM.
- [ ] Record origin, timestamp, verification state, confidence, and available source evidence.
- [ ] Add idempotency/deduplication keys so retries do not create duplicate knowledge.
- [ ] Match existing entries by exact identity, normalized lexical signals, aliases, source symbols/paths, and relation context.
- [ ] Classify candidate operation as create, enrich, conflict, or duplicate; avoid destructive auto-merge on ambiguous matches.
- [ ] Persist atomically and return stable IDs plus the outcome/reason.
- [ ] Ensure ordinary agent capture does not require explicit user confirmation, while low-confidence claims remain labeled.
- [ ] Add CLI/core/MCP integration tests, privacy exclusions, size bounds, and retry tests.

## D2. `memory_update` and history

- [ ] Implement partial enrichment and explicit version creation.
- [ ] Support reason/evidence and preserve original author separately from updater identity.
- [ ] Reject invalid lifecycle/epistemic transitions.
- [ ] Keep previous versions available and exclude superseded claims from default current recall.
- [ ] Test no-op updates, duplicate updates, stale source references, and transactional failure.

## D3. `memory_correct` and user corrections

- [ ] Implement explicit correction API that links to the prior version and records correction provenance.
- [ ] Support correcting a specific claim/fragment rather than replacing unrelated content.
- [ ] Preserve the prior version and correction reason in history.
- [ ] Represent desired future behavior as a decision/planned item, not as current implemented behavior.
- [ ] Where correction conflicts with source/tests, retain the user instruction as intent and record the implementation discrepancy for verification rather than silently falsifying code facts.
- [ ] Find and mark dependent knowledge as needing review; do not blindly rewrite all related entries.
- [ ] Add tests for corrections to verified facts, hypotheses, decisions, and dependent entries.

## D4. Reconciliation, duplicates, and contradictions

- [ ] Implement bounded candidate discovery and explainable matching scores/reasons.
- [ ] Detect exact duplicates, useful enrichments, direct contradictions, supersession, and unresolved ambiguity.
- [ ] Automatically apply only deterministic safe updates; retain uncertain conflicts with explicit status.
- [ ] Implement relationship-aware impact/review queue for dependent knowledge.
- [ ] Reconcile stale source references without deleting knowledge simply because source files changed or disappeared.
- [ ] Add deterministic fixtures for duplicate, enrich, conflict, supersede, split, and dependency invalidation cases.

**Acceptance:** repeated capture is idempotent; corrections are versioned and traceable; ambiguous conflicts are not silently merged; outdated knowledge is not represented as current.

---

# Workstream E — Specialized progressive retrieval

## E1. Search and bootstrap

- [ ] Implement `memory_bootstrap` with a small configurable summary of high-value current knowledge, unresolved risks, and relevant freshness warnings.
- [ ] Implement `memory_search` with lexical FTS5, exact identifiers, aliases/tags, category/type, paths/symbols, relations, and time filters.
- [ ] Use stable relevance tie-breakers and expose why each result matched.
- [ ] Return short summaries/snippets and stable IDs by default; enforce item/character budgets and truncation metadata.
- [ ] Exclude superseded/archived/rejected content from current results by default, with explicit history filters.
- [ ] Test empty, ambiguous, multilingual/basic normalization, wildcard, repeated-run, and exact-boundary cases.

## E2. Get, expand, history

- [ ] Implement `memory_get` for one knowledge identity/current version.
- [ ] Implement `memory_expand` for selected fragments only, with stable fragment IDs and paging.
- [ ] Implement `memory_history` for versions, correction reasons, source changes, and supersession.
- [ ] Ensure a deep history request is explicit and bounded.
- [ ] Test pagination stability, version selection, character limits, and stale provenance warnings.

## E3. Health and reconcile APIs

- [ ] Implement `memory_health` for schema status, counts, broken references, pending validation, conflicts, and source freshness.
- [ ] Implement `memory_reconcile` as a bounded, auditable operation with dry-run/reporting where destructive or broad changes could occur.
- [ ] Define idempotency and safe behavior when discovery is incomplete or source snapshots change.
- [ ] Test malformed/legacy data, orphan relations, and recoverability.

**Acceptance:** narrow queries return small relevant evidence-backed fragments; expansion is selective; history and health are bounded and truthful.

---

# Workstream F — MCP and agent workflow integration

## F1. MCP core adapter

- [ ] Keep business logic in the core; MCP handlers only validate, call core operations, and format bounded responses.
- [ ] Register and document `memory_bootstrap`, `memory_search`, `memory_get`, `memory_expand`, `memory_capture`, `memory_update`, `memory_correct`, `memory_history`, `memory_reconcile`, and `memory_health` as appropriate to the final contract.
- [ ] Reconcile proposed tools with existing `memory_recall`, `memory_propose`, `memory_transition`, and `task_context`; avoid redundant APIs without a documented migration rationale.
- [ ] Add schema/contract tests for every new and changed tool, including invalid inputs, thrown core errors, bounds, truncation, and repeated calls.
- [ ] Preserve project isolation, strict freshness behavior, and local-only writes.
- [ ] Document compatibility/deprecation policy for existing MCP clients.

## F2. Generated instructions and agent behavior

- [ ] Update CNM-managed `AGENTS.md` instructions without overwriting user-authored content.
- [ ] On session start, instruct the agent to bootstrap memory and check freshness before broad exploration.
- [ ] During work, instruct lookup-before-exploration, selective expansion, and capture of reusable discoveries.
- [ ] On corrections, instruct use of correction workflow and distinction between intended and implemented behavior.
- [ ] On task completion, capture verified changes, test evidence, decisions, unresolved questions, and follow-ups.
- [ ] Ensure tool descriptions explain when to call each tool, not just what it does.
- [ ] Test generated instruction idempotency, migration from existing AGENTS.md, and absence of contradictory confirmation requirements.
- [ ] Perform real-client verification in supported agents after automated protocol tests pass.

**Acceptance:** compatible agents are explicitly guided to use persistent memory at start/during/end of work; memory writes are local and bounded; normal capture does not depend on per-item confirmation.

---

# Workstream G — Freshness, identity, and long-term coherence

## G1. Source-linked memory freshness

- [ ] Link knowledge/evidence to source paths, symbols, file hashes, commits, index revisions, and tests when available.
- [ ] Reuse existing freshness mechanisms rather than duplicating them.
- [ ] Determine affected knowledge from changed symbols/files/relations; avoid invalidating unrelated knowledge.
- [ ] Mark affected knowledge pending review when evidence becomes stale; do not delete it.
- [ ] Ensure retrieval communicates stale/unverified status.
- [ ] Test file rename/delete, symbol change, branch switch, dirty tree, non-Git project, and incomplete index.

## G2. Worktrees and project identity

- [ ] Audit current canonical-path project ID behavior and database isolation.
- [ ] Specify explicit, opt-in project identity linking for worktrees if safe; never merge identities based solely on repository name or remote URL.
- [ ] Preserve separate worktree source snapshots while allowing intentionally shared project knowledge if design supports it.
- [ ] Add isolation tests for clones, worktrees, nested repositories, submodules, moved directories, and same-named unrelated repositories.
- [ ] Document migration and opt-in behavior.

## G3. Consistency maintenance

- [ ] Implement bounded detection of orphaned relations, duplicate knowledge, contradictory current versions, and missing evidence links.
- [ ] Ensure reconciliation reports proposed actions and keeps audit history.
- [ ] Test interrupted reconciliation and repeatability.
- [ ] Document maintenance frequency/trigger; do not promise background work unless an actual scheduler is implemented.

---

# Workstream H — Evaluation, performance, and final release

## H1. Reproducible evaluation corpus

- [ ] Create fixtures for investigation reuse, user correction, source change, broad subsystem retrieval, and long-gap continuity.
- [ ] Define a control condition without CNM and a treatment condition using CNM.
- [ ] Define metrics before measuring: repeated file reads, relevant knowledge precision, recall, stale-claim rate, correction propagation accuracy, response size, latency, and persistence across sessions/agents.
- [ ] Record ground truth and expected outputs for each scenario.
- [ ] Run the same task inputs under both conditions and preserve machine-readable results.

## H2. Performance and reliability

- [ ] Benchmark capture, search, expansion, history, reconciliation, and migrations on small/medium/large fixtures.
- [ ] Measure SQLite query plans/index use and transaction duration before adding dependencies.
- [ ] Test large memory counts, high relation counts, repeated retries, and concurrent readers/writers within the supported process model.
- [ ] Set explicit regression thresholds and document hardware/runtime.
- [ ] Verify memory response item and character budgets under worst-case metadata.

## H3. Release close-out

- [ ] Run full clean-checkout CI on the final implementation branch and after merge to `main`.
- [ ] Review all migrations, schema contracts, source changes, tests, generated instructions, and documentation diffs.
- [ ] Confirm all requirements in the master plan map to passing acceptance evidence.
- [ ] Update README, Product Spec, Architecture, Roadmap, Acceptance Criteria, MCP Contract, Agent Workflow, AGENTS, and Changelog.
- [ ] Record limitations and explicitly deferred work (including cross-device/team sync, mandatory embeddings, and passive conversation capture unavailable to the integration).
- [ ] Publish final evidence summary with commits/PRs/CI runs and a remaining-risk statement.

---

## Global release gates

- [ ] All six CNM integrity/freshness risks pass their individual and combined regression tests.
- [ ] Existing databases and memories migrate safely.
- [ ] Autonomous capture and correction work without per-item approval for normal agent knowledge.
- [ ] Current implementation, verified facts, user intent, plans, and hypotheses remain distinct.
- [ ] Provenance, confidence, verification state, timestamps, relations, and version history are preserved.
- [ ] Retrieval is progressive, deterministic, bounded, and source-aware.
- [ ] Source changes do not silently erase knowledge or leave stale claims presented as current.
- [ ] Multiple compatible agents can use the same local project memory across sessions.
- [ ] No mandatory network/cloud/LLM/embedding dependency is introduced.
- [ ] The measured evaluation demonstrates improvement against the control; no unsupported productivity claim is made.

## Progress log

| Date | Work item | Evidence / commit / PR / CI | Outcome / next action |
|---|---|---|---|
| 2026-11-02 | Initial documentation-level baseline review | `main`: `docs/ROADMAP.md`, `docs/PRODUCT_SPEC.md`, `docs/ACCEPTANCE_CRITERIA.md`, `docs/PHASE_6_MCP_CONTRACT.md`, `docs/AGENT_WORKFLOW.md`, `AGENTS.md`, `package.json` inspected | Source-level audit and CI verification were pending at baseline; subsequent implementation progress is recorded below. |

| 2026-11-02 | CNM-02 directory symlink replacement | PR #75; CI 41404323034; merge `3d7d94de32151b1f891308d7e661c945cfd694b9` | Targeted regression merged; broader symlink combinations remain open. |
| 2026-11-02 | CNM-05 source-excerpt safe open/read | PR #76; CI 41404690251; merge `da7e7fd90a15a39af551237ca7c3ee6868ccc43a` | Descriptor-based read and identity checks merged; other path-based read sites still require audit. |
| 2026-11-02 | CNM-05 expanded safe file reads | PR #89; CI 41409758684; merge `f8c67219e974b3239accbd7bf93f3ebec26de39a` | Shared verified reader covers indexer source reads, `.gitignore`, memory source fingerprints, and `AGENTS.md`; config reads and write/directory races remain open. |
| 2026-11-02 | CNM-05 post-read path and managed-instruction write safety | PR #92 and PR #95; CI 41410395689 and 41410907119; merges `54aa52936a812494a6cbdd43c2429294ee603b82` and `9969869a3ad24a241a9967ae3221521b75ddb94d` | Shared reads revalidate path identity after reading; `AGENTS.md` writes use verified descriptors. Config fingerprint reads and directory-open race audit remain open. |
| 2026-11-02 | CNM-04 post-read freshness | PR #77; CI 41405092697; merge `e5fffa774c180aa45ea60195cf28dead2ea51f10` | Strict refusal and non-strict warning after a deterministic mutation test merged. |
| 2026-11-02 | CNM-03 full-index snapshot guard | PR #79; CI 41405788148; merge `7b1f4b8b9edb4d1a8c73db1cac4ad38c9bbdaaf9` | CLI-facing full indexing now refuses incomplete discovery; all destructive paths still need final audit. |
| 2026-11-02 | CNM-01 relation configuration freshness | PR #82; CI 41406437168; merge `2dc4c51c3dfad03a41ec6af6798bff4702dbb92e` | Config-only drift marks index stale; successful rebuild clears the flag. |
| 2026-11-02 | CNM-06 deterministic bounded discovery | PR #84 and PR #87; CI 41407210746 and 41407851656; merge `14b9d59ad397cd4357759da8b48ba7b91f4dac37` and root-scope follow-up | `maxFiles` selection is deterministic; over-budget discovery aborts without writes and protects unvisited paths. Broader retrieval-limit audit remains open. |
| 2026-11-02 | CNM-01/CNM-05 config metadata diagnostics | PR #120; merge `5c73896dc1e3833b58c333240bb756db5e9d3be9`; CI 41448646334 passed | Malformed package manifests and non-string/blank `tsconfig` metadata are surfaced through freshness diagnostics; symlink/unreadable manifest race cases remain open. |
| 2026-11-02 | Autonomous memory source audit | `src/core/memories.ts`, `src/core/context.ts`, `src/adapters/mcp/server.ts`, `tests/memories.test.ts`, `tests/context.test.ts` on `main` | Confirmed existing lifecycle-only CRUD and per-item confirmation gap; no version/event history or autonomous capture API in audited surface. Contract and schema design are next.


### 2026-11-03 — Schema v13 implementation in progress

- Branch: `feat/autonomous-memory-schema-v13`.
- Migration commit: `659228bac38b66cefab16c44fde4758be25213ca`; retry-safety fix: `1daef6622cabce8f687fffc7b4c767123db47b17`; metadata columns: `edf28202d2ebf343727617beeec8b968a328e0ae`.
- Migration regression test commit: `d32ab7e37aa6d963874387e2d74aca9851d3e435`.
- Current state: implementation and focused test authored; no passing CI result yet. Do not mark Workstream C complete. The compatibility CRUD APIs still operate on the legacy table until the versioned core layer is implemented.
