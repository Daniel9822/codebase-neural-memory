# CNM Master Implementation Checklist — Autonomous Persistent Knowledge

**Repository:** `Daniel9822/codebase-neural-memory`  
**Baseline branch:** `main`  
**Tracking branch:** `docs/autonomous-memory-implementation-plan`  
**Plan created:** 2026-11-02  
**Status (2026-11-04):** Contract v2, the base versioned-memory schema v13, and the lazily initialized schema-v14 FTS5 search index are merged to `main` (PRs #136–#164). PR #164 adds rollback-injection atomicity tests for `memory_update` and `memory_correct`; independent-process contention coverage for those operations is the next active slice. `memory_search`/`memory_bootstrap` (#144), `memory_health` (#146), read-only reconciliation preview (#147), and event-only `request_review` with bounded responses and related evidence/relation references (#149–#150) are available. Apply-transaction lock contention/retry is verified by PR #156. PR #158 explicitly configures SQLite WAL `synchronous=FULL` and tests the effective pragma (merge `5ea62b89ea2f348080d55396b288612a534568d9`; CI `41919002890`, all five jobs green, including Windows). This verifies the configured SQLite policy, not physical power-loss/filesystem durability. Resolution workflows, durable dependent-knowledge review and power-loss/filesystem durability remain open.

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
- [x] Add initial project/type/lifecycle, version, fragment, evidence-source, relation traversal, and event indexes plus enum/range/uniqueness constraints (`src/storage/database.ts`, schema v13; query-plan validation remains open).
- [x] Constrain current-version ownership with a deferred composite foreign key and enforce immutable versions/fragments plus append-only evidence/events using SQLite triggers; regression assertions added (CI pending).
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

- [x] Implement bounded, validated capture input and output contracts in the core memory engine (`src/core/memory-capture.ts`; MCP adapter schema also bounded). CLI integration and broader negative-case coverage remain open.
- [x] Support small knowledge units and structured metadata without requiring an LLM (titles, summaries, fragments, tags, aliases, typed evidence; no LLM dependency).
- [x] Record origin, timestamp, epistemic state, optional confidence with required rationale, actor, and bounded source/test evidence.
- [x] Add project-scoped idempotency keys and request hashes; same-payload retries replay the original result, key reuse with a different payload is rejected.
- [x] Match by exact normalized title/type identity and aliases (`src/core/memory-capture.ts`); broader lexical/source-symbol/path/relation matching remains open.
- [x] Classify create, duplicate, or conflict using conservative exact identity matching; ambiguous/different content is never auto-merged. Enrich remains deferred.
- [x] Persist each batch transactionally and return stable knowledge IDs plus per-item outcome/reason.
- [x] Agent capture does not require per-item human confirmation; epistemic state is explicit and confidence requires a rationale.
- [ ] Add CLI/core/MCP integration tests, privacy exclusions, size bounds, and retry tests. Core and MCP integration, bounds, retry, duplicate/conflict tests added; CLI coverage and explicit privacy-exclusion tests remain open.

## D2. `memory_update` and history

- [x] Implement bounded partial-field updates and explicit immutable version creation (`src/core/memory-update.ts`; PR #139).
- [x] Persist change reason/actor and carry forward prior evidence while appending new evidence; retain prior version author/provenance.
- [ ] Reject invalid lifecycle/epistemic transitions (lifecycle transition API remains separate; no general transition matrix is implemented here).
- [ ] Keep previous versions available and exclude superseded claims from default current recall (history/retrieval is still pending).
- [x] Test no-op updates and stale expected-version conflicts; [ ] duplicate update semantics, stale source references, independent-connection races, and transactional failure injection remain open.

## D3. `memory_correct` and user corrections

- [x] Implement explicit correction API with expected-version concurrency and correction provenance (`src/core/memory-correct.ts`; PR #140, merge `7ca7441059299a228c4889cb5ccbd542637cab58`).
- [x] Correct one selected current fragment while preserving every other fragment.
- [x] Preserve prior immutable version, evidence snapshot, actor/reason, and append-only `corrected` event with prior version/target fragment references.
- [ ] Represent desired future behavior as a separate linked `planned` decision (the correction API does not create that decision automatically).
- [x] Keep user corrections explicitly `user_asserted` or `pending_validation`; reject labeling a user correction as verified implementation. Agent corrections marked verified require evidence.
- [ ] Find and mark dependent knowledge as needing review; bounded impact discovery/review queue is not implemented.
- [ ] Add broader tests for corrections across hypotheses, decisions, and dependent entries; current tests cover user assertions, pending validation, agent-evidence gate, stale conflict, no-op, and fragment/history preservation.

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

- [x] Implement `memory_bootstrap` with a small configurable summary of high-value current knowledge, unresolved risks, and relevant freshness warnings (PR #144).
- [x] Implement `memory_search` with lexical FTS5, exact identifiers, aliases/tags, category/type, paths/symbols, relations, and time filters (PR #144).
- [x] Use stable relevance tie-breakers and expose why each result matched (PR #144).
- [x] Return short summaries/snippets and stable IDs by default; enforce item/character budgets and truncation metadata (PR #144).
- [x] Exclude superseded/archived/rejected content from current results by default, with explicit history filters (PR #144).
- [ ] Complete the full empty/ambiguous/multilingual-basic-normalization/wildcard/repeated-run/exact-boundary test matrix. Empty browse, filters, cursors, and project isolation are covered; remaining edge cases stay open.

### E1 implementation merged — 2026-11-04 (PR #144)

- Branch: `feat/memory-search-bootstrap`, based on main `76c41859181c79ea2698fe3a28f55a37b58371f8`.
- Added `src/core/memory-search.ts`: lazy schema-v14 FTS5 index creation/backfill, project-scoped lexical search and empty-query high-value browse, current-version/lifecycle defaults, explicit historical search, type/tag/path/symbol/epistemic/time/relation filters, exact source/identity ranking, deterministic tie-breakers, 1,000-candidate windows, snapshot-bound cursors, and serialized-character budgets.
- Added `src/core/memory-bootstrap.ts`: compact grouped startup context, epistemic labels, contract-aligned 1–20 item and 500–8,000 character budgets, type/include-pending filters, code-index freshness reporting, and explicit source-evidence freshness limitation.
- Registered `memory_search` and `memory_bootstrap` in `src/adapters/mcp/server.ts`; added `tests/memory-search.test.ts` and MCP protocol/read-boundary coverage in `tests/mcp-adapter.test.ts`.
- **Status: PARTIAL on main.** PR #144 merged as `b9ec6802a5646ee9ed1abd5f5717fc91be4ff9a5`; CI run `41795181023` passed all five jobs. Both Ubuntu and Windows passed typecheck, all 239 tests, build, and smoke; Ubuntu/Windows/macOS benchmarks passed. Five of six E1 criteria are checked. The remaining edge-case matrix is explicitly open.

## E2. Get, expand, history

- [x] Implement `memory_get` for one knowledge identity/current version with optional bounded evidence metadata (`src/core/memory-get.ts`; PR #142, merge `b83fdcd87a14c9165b15e15f6126415b4c6b5bcc`).
- [x] Implement `memory_expand` for selected stable fragment IDs or deterministic ordinal paging with item/serialized-character budgets (`src/core/memory-get.ts`; PR #142, merge `b83fdcd87a14c9165b15e15f6126415b4c6b5bcc`).
- [x] Implement bounded `memory_history` for immutable versions and append-only events with independent version/event cursors (`src/core/memory-history.ts`; PR #141 merge `582161966b67a35ba83f8eddf128a97e0d2be9ed`). Source freshness invalidation and broader supersession workflows remain open.
- [x] Ensure history depth is explicit and bounded (version/event page limits 1–50; project-scoped lookup; deterministic cursor ordering).
- [x] Test version/event pagination, ordering, project isolation, and invalid bounds; [ ] serialized character-budget enforcement and stale-provenance warnings remain open.

## E3. Health and reconcile APIs

### E3 implementation merged — 2026-11-04 (PR #146)

`memory_health` is merged in PR #146 (merge `5b55a443c910742dde07696503d3aed01e71d69c`; CI `41821794346`, all five jobs green). The read-only `memory_reconcile` preview is merged in PR #147 (merge `754b7dddd74afc8b3be5353cdc838568e0ba7283`; head `fa1b84dedbfbe7430840109fd6ae3bd50f394609`; CI `41823553294`, all five jobs green). The preview reports sampled stale evidence, exact normalized-title duplicate candidates, contradictions, orphan relations, and related dependent-review candidates. It performs no knowledge mutations.

- [x] Implement `memory_health` for schema status, counts, broken references, pending validation, conflicts, and source freshness.
- [x] Add a bounded, read-only `memory_reconcile` preview for stale sampled evidence, exact normalized-title duplicate candidates, contradictions, orphan relations, and related dependent-knowledge review candidates (`src/core/memory-reconcile.ts`). No repair or mutation is performed; full operation selection, mutation/idempotency, exact dependent-impact totals, and recovery semantics remain pending.
- [x] Specify first apply-capable operation as explicit event-only `request_review`; define project-scoped idempotency, expected-version concurrency, dry-run/apply separation, atomicity, bounds, and recovery requirements in [Memory Reconciliation Apply Design](MEMORY_RECONCILIATION_APPLY_DESIGN.md). Specification only; no apply code is implemented.
- [x] Implement event-only `request_review` with all-or-nothing transaction, append-only audit events, project-scoped idempotency, expected-version checks, and dry-run default (PR #149; merge `db7ef0af725f81a1d70fe32a78a3cd203083f9f0`; `src/core/memory-review-request.ts`; MCP `memory_reconcile`).
- [x] Add focused tests for same-key replay/conflict, stale expected versions, foreign/missing project IDs, duplicate IDs, missing apply key, batch bounds, and injected event-insert rollback (`tests/memory-review-request.test.ts`; MCP integration in `tests/mcp-adapter.test.ts`). CI run `41825667650` passed all five jobs on Ubuntu, Windows, and macOS benchmark runners.
- [x] Enforce response-size budget and capture bounded evidence/relation references (PR #150; CI `41827470581`).
- [x] Assert preservation of evidence, relations, fragments, current-version pointers, and append-only review events (PR #151; merge `c9a62b6fc0854fe536a01782f5a979200e0287df`; CI `41828848388`, all five jobs green).
- [x] Simulate a lost response after commit and verify same-key retry replays the stored result without duplicate events (PR #152; CI `41833420368`, five jobs green).
- [x] Verify a version committed through an independent SQLite connection is detected as stale by `request_review`, with no review event/idempotency write (PR #153; merge `a85ef0235bbe05cbdf4ba788c584e8c6c20848d9`; CI `41834609758`, five jobs green).
- [x] Terminate a child process immediately after the apply commits but before it returns a response; verify parent retry replays the stored result without duplicate events (PR #153; merge `a85ef0235bbe05cbdf4ba788c584e8c6c20848d9`; CI `41834609758`, five jobs green). This tests process termination after commit, not power-loss durability.
- [x] Verify deterministic cross-process database-open contention and retry: PR #154 merge `875112ca6ad92d9e919ec0321cb14093295b8ba4`, CI `41839728294` (five jobs green). This established safe failure/no writes and retry, but did not isolate the apply transaction.
- [x] Verify the current-schema open fast path and contention specifically inside `requestMemoryReview` apply: PR #156 merge `55d663aae0da7b4a2a68696f0c74ae1a328cff1a`; head `4df8d05e722212316af73f7ffdae553d4fd118d9`; CI run `41913689539` passed all five jobs (Ubuntu/Windows typecheck, tests, build, smoke; Ubuntu/Windows/macOS benchmarks). `migrate()` now returns read-only when migration v13 is present, avoiding repeated migration DDL/marker writes on ordinary opens. The test proves `openDatabase()` succeeds while another process holds `BEGIN IMMEDIATE`, then `requestMemoryReview()` fails at apply without writes and succeeds with same-key retry after release. The test awaits child exit before assertions/cleanup to avoid Windows WAL-handle cleanup races.
- [ ] Test power-loss/filesystem durability boundaries; process termination is not a power-loss proof. PR #158 configures WAL `synchronous=FULL` on each opened connection and asserts `journal_mode=wal` plus `synchronous=2`; CI `41919002890` passed Ubuntu/Windows verification and all three platform benchmarks. This is configuration verification only, not a physical power-loss/filesystem test.
- [ ] Test malformed/legacy data, orphan relations, incomplete discovery, and source snapshot changes.

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

## 2026-11-04 — PR #164 rollback atomicity verified; next concurrency slice active

- **IMPLEMENTED / verified:** PR #164 merged to `main` as `f9ff199321ce240c052a431ed0897b5196004d79`; PR head `81307794d6f3db8567ba3772a51bbb2eeebfb3bc`; CI run `41934624316` passed all five jobs (Ubuntu/Windows verification and Ubuntu/Windows/macOS benchmarks).
- `tests/memory-update.test.ts` and `tests/memory-correct.test.ts` now inject a failure at immutable-version insertion and compare before/after snapshots of the queried knowledge pointers, versions, fragments, evidence, and events. This verifies those queried fields remain unchanged for that injected failure; it is not a byte-for-byte database image comparison.
- **Active PR #165:** `test/memory-update-correct-cross-process-contention` adds independent-process `BEGIN IMMEDIATE` contention tests for both operations. Acceptance: fail without writes while the lock is held, wait for child handle closure, then retry successfully. Initial CI also exposed a `memory_history` bug: an individually oversized omitted event could be revisited indefinitely because the cursor was reset to the last returned event. The branch now preserves the cursor past that oversized event and uses a deterministic fixture timestamp. All changes remain pending fresh Ubuntu/Windows CI.
- **Still open:** simultaneous same-identity writer scheduling, wider migration/recovery matrix, relational impact propagation, evidence freshness, and physical power-loss/filesystem durability.

## Progress log

| Date | Work item | Evidence / commit / PR / CI | Outcome / next action |
|---|---|---|---|
| 2026-11-02 | Initial documentation-level baseline review | `main`: product/architecture/roadmap/MCP/workflow docs and package metadata inspected | Source-level audit and CI verification were pending at baseline; subsequent implementation progress is recorded below. |
| 2026-11-04 | Merge and documentation close-out for focused retrieval | PR #142 merge `b83fdcd87a14c9165b15e15f6126415b4c6b5bcc`; `src/core/memory-get.ts`; MCP adapter; `tests/memory-get.test.ts`; MCP tests | `memory_get` and `memory_expand` are on main. Next implementation slice: lexical `memory_search` and compact `memory_bootstrap`; stale-source signaling, health/reconcile, dependent review, and integration/evaluation remain open. |
| 2026-11-04 | Versioned memory search and bootstrap | PR #144 merged as `b9ec6802a5646ee9ed1abd5f5717fc91be4ff9a5`; CI `41795181023`; `src/core/memory-search.ts`, `src/core/memory-bootstrap.ts`, MCP adapter, focused core/protocol tests | Search/browse, filters, snapshot cursors, and compact bootstrap are on main; 239 tests pass on Ubuntu and Windows, all five CI jobs green. E1 remains PARTIAL only for the multilingual/wildcard/repeated-run/ambiguous/exact-boundary edge-case matrix. E3 health/reconcile, source-evidence freshness, dependent review, and evaluation remain open. |
| 2026-11-04 | Memory health and source freshness | PR #146 merged `5b55a443c910742dde07696503d3aed01e71d69c`; CI `41821794346`; `src/core/memory-health.ts`; MCP adapter; `tests/memory-health.test.ts` | Bounded integrity and source-evidence freshness report is on main; all five CI jobs passed. No automatic repair. |
| 2026-11-04 | Memory reconciliation preview | PR #147; merge `754b7dddd74afc8b3be5353cdc838568e0ba7283`; CI `41823553294`; `src/core/memory-reconcile.ts`; MCP `memory_reconcile`; `tests/memory-reconcile.test.ts` | Merged to main; all five CI jobs green. Read-only preview reports stale sampled evidence, normalized-title duplicate candidates, contradictions, orphan relations, and dependent-review candidates. Mutating operations, idempotency/recovery, exact dependent-impact totals, and durable review workflow remain open. |
| 2026-11-04 | Safe reconciliation apply design | PR #148 merged as `c572b02aaa816e1b72f936527b285cf0f11be701`; `docs/MEMORY_RECONCILIATION_APPLY_DESIGN.md` | Specifies event-only `request_review`, explicit IDs/expected versions, idempotency, all-or-nothing transaction and recovery tests. |
| 2026-11-04 | Event-only review request implementation | PR #149 merged as `db7ef0af725f81a1d70fe32a78a3cd203083f9f0`; CI `41825667650` (five jobs green); `src/core/memory-review-request.ts`; `tests/memory-review-request.test.ts`; MCP `memory_reconcile` | Merged: default dry-run, explicit expected-version validation, project-scoped idempotent atomic event append, rollback/replay/conflict tests, MCP integration, 12,000-character serialized response budget with truncation metadata, and up to 20 evidence plus 20 relation IDs per event with truncation flags. PR #150 merge `2279edd954bdeedea2c7cd9d1e5d014c05eccb24`; CI `41827470581` passed all five jobs (Ubuntu/Windows verification and Ubuntu/Windows/macOS benchmarks). Remaining: independent-connection race, post-commit crash/retry, and explicit append-only/preservation assertions. |

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
- Migration commits: `659228bac38b66cefab16c44fde4758be25213ca`, retry-safe evidence `1daef6622cabce8f687fffc7b4c767123db47b17`, metadata columns `edf28202d2ebf343727617beeec8b968a328e0ae`, atomic migration marker `8bb786dc90b7dd1e5b707111ce5515c07e4585ac`.
- Migration regression test commit: `d32ab7e37aa6d963874387e2d74aca9851d3e435`.
- Current state at PR #137 merge: schema v13 and focused migration tests merged. Post-merge CI run `41729315788` passed all five jobs (verify Ubuntu/Windows and benchmark Ubuntu/Windows/macOS). Do not mark all of Workstream C1 complete: older-schema matrix, crash/reopen boundaries, invalid legacy data, FTS integrity, and query-plan validation remain open. Compatibility CRUD APIs still operate on the legacy table until the versioned core layer is implemented.

| 2026-11-03 | Autonomous memory v2 contract | PR #136 merged; merge commit `4f66aad688bd62bf6b480160584b5231b057b879`; CI run `41719670579` had four successful jobs and the macOS benchmark remained queued at merge time | Contract and cross-document baseline are now on main. The implementation PR #137 is stacked on that contract and awaits CI/review. |


### CI diagnosis — 2026-11-03

- Initial run `41721857299`: TypeScript passed on Ubuntu and Windows; both test jobs failed only because `tests/migrations.test.ts` still asserted that the latest schema stopped at v12. The failure was an outdated migration expectation, not a runtime migration failure. Both benchmark jobs completed successfully; macOS benchmark was queued at inspection.
- Fixed the migration fixture to expect schema v13 and assert v13 migration idempotency in `tests/migrations.test.ts` (commit `a6838ae7f2f1bc18430573b655852437868f22fb`). New CI run is required; no green result is claimed yet.

- Follow-up integrity hardening commits: `fa6f80d7f40c730d0063ec09f673b15fb2173a56` (ownership FK and DB-level append-only triggers), `e58ed9ac9016d5a49daa17286474b84be103c3b0` (trigger regression tests).


### 2026-11-03 — Schema v13 merged; first capture slice implemented

- PR #137 merged to `main` as `c1abe4160ff7a5c9503e42901b2c6e4e21476778`. It includes the migration edge-case fix: `openDatabase(location)` passes `location.id` to `migrate`, and the migration test covers a populated legacy DB with an empty `projects` table.
- Merge-triggered CI run `41729315788` completed successfully: all five jobs passed, including `benchmark / macos-latest`. The merge commit is CI-green.
- Branch `feat/memory-capture-core`: initial `memory_capture` core implementation in `src/core/memory-capture.ts`, MCP tool in `src/adapters/mcp/server.ts`, core tests in `tests/memory-capture.test.ts`, and MCP protocol integration coverage in `tests/mcp-adapter.test.ts`.
- Implemented behavior: bounded 1–20 item batches; structured fragments/tags/aliases/evidence; explicit epistemic state and optional confidence rationale; project-scoped idempotency; exact normalized title/type matching; duplicate/conflict classification; atomic version/event/evidence persistence. Different content under the same identity is surfaced as conflict and never silently merged.
- Not yet implemented: enrich semantics, broader lexical/source/symbol/relation matching, CLI integration, explicit privacy-exclusion tests, update/correction/history/reconciliation APIs, and bootstrap/search/get/expand/health retrieval.
- No CI success is claimed for this branch until its workflow jobs complete.


### 2026-11-03 — Capture merged; versioned update in progress

- PR #138 merged to `main` as `7faf875f0166bc2e496d099039cb625dde5ba832`; `memory_capture` core/MCP and bounded atomic capture tests are now part of main.
- PR #138 merge status was verified through GitHub; its original checklist progress note above is historical and is superseded by this entry.
- Branch `feat/memory-update-versioned`: adds `src/core/memory-update.ts`, the `memory_update` MCP tool, core tests in `tests/memory-update.test.ts`, and protocol coverage in `tests/mcp-adapter.test.ts`; expected tool count is now 20 (`tests/mcp-stdio.test.ts`).
- Update semantics: optimistic `expectedVersionId`, structured stale conflict, immutable version append, full fragment/evidence snapshot, actor/reason event, conditional current-version pointer update, and no-op suppression. This branch is not merged and must not be treated as released until its latest-head CI passes.


### 2026-11-03 — Optimistic update and selective correction merged

- PR #139 merged to `main` as `f73e1a4022c8b61a6854af2e24c7405dabc3d24c`; `memory_update` is now part of the default branch. Post-merge CI run #2240 was started and must be confirmed independently.
- PR #140 merged to `main` as `7ca7441059299a228c4889cb5ccbd542637cab58`; `src/core/memory-correct.ts`, MCP `memory_correct`, focused core tests, MCP protocol registration/integration coverage, and documentation are now in the default branch.
- Correction semantics: target one fragment in the expected current version; append a new immutable version; preserve other fragments and prior evidence; record correction source (`user`/`agent`), actor, reason, previous version and target fragment in an append-only `corrected` event. User corrections can only be `user_asserted` or `pending_validation`; agent corrections marked `verified` require evidence.
- Not implemented by this slice: dependent-knowledge impact/review marking, automatic creation/linking of a separate planned decision, history retrieval, independent-connection race tests, and failure-injection rollback tests. Do not mark those complete.
- Latest-head CI run `41738355370` passed all five jobs: verify Ubuntu/Windows (typecheck, tests, build, smoke) and benchmark Ubuntu/Windows/macOS. This confirms the PR head; combined status/workflow lookup against the merge commit returned no separate merge-commit run.


### 2026-11-03 — Bounded version history in progress

- Branch `feat/memory-history-api` adds `src/core/memory-history.ts` and MCP `memory_history`.
- The reader returns immutable version metadata and append-only events for one project-scoped knowledge identity. Version pagination uses descending version numbers; event pagination uses descending `(created_at, id)` cursors. Limits are independently bounded to 1–50.
- Tests cover capture → update → correction history, independent cursors, stable older-page retrieval, project isolation, and invalid bounds. Character-budget enforcement and stale-evidence warnings are not part of this slice.
- PR/CI status is pending; do not treat this API as available on `main` until merged.


## 2026-11-04 verification update — PR #158

- **Verified behavior:** `openDatabase()` sets `PRAGMA synchronous = FULL` after enabling WAL on each connection. `tests/memory-review-request.test.ts` asserts WAL mode and synchronous level `2`.
- **Performance regression avoided:** the bounded memory recall fixture in `tests/memories.test.ts` now inserts its 5,001 rows in one transaction. It preserves the candidate-window assertions and avoids 5,001 separately synchronized commits on Windows.
- **Evidence:** PR #158 merged as `5ea62b89ea2f348080d55396b288612a534568d9`; head `9b2d7c33b62564f087c3196faeaff1b49865922e`; CI run `41919002890` passed all five jobs (Ubuntu/Windows typecheck, tests, build and smoke; Ubuntu/Windows/macOS benchmarks).
- **Not verified:** actual machine power-loss, storage-controller and filesystem durability. Keep the power-loss/filesystem acceptance item open.


### 2026-11-04 — `memory_history` serialized response budget (PR pending)

- Added an explicit 500–12,000 character `maxChars` budget (default 12,000) measured against compact serialized JSON, plus exact project-scoped version/event totals, returned counts, `serializedChars`, `truncated`, and per-stream budget omission counts.
- Version and event ordering/cursors remain independent. If the character budget omits older tail rows, only that stream's cursor advances and the omitted count is explicit; historical records and payloads are never rewritten or field-truncated.
- MCP emits compact JSON for this tool so the core's measured representation matches the wire text.
- Initial CI run `41921639444` failed on both Ubuntu and Windows because the MCP adapter's exact tool-schema contract had not been updated to include `memory_history.maxChars`; the `memory_history` unit tests themselves passed (4 tests). The schema expectation was corrected in follow-up commit `da962b7979486a6a53e05f06d1d6de8308bd6ce6`; CI must rerun.
- Still requires dedicated coverage/review for an individually oversized row and repeated constrained-page cursor progression before merge.


## 2026-11-04 — PR #160 merged; serialized-history edge coverage follow-up

- **Verified:** PR #160 is merged to `main` as `a430548943b55eed9a0cd15d5dd7aaff58d3e594`. It adds the compact-JSON `maxChars` budget (500–12,000), serialized-size metadata, total counts, explicit budget omission counts, and independent cursors.
- **Source review finding:** the merged `tests/memory-history.test.ts` covers the basic serialized ceiling but did not exercise repeated constrained pages or a single event larger than the entire budget. These are acceptance gaps, not evidence of a confirmed production defect.
- **Follow-up branch:** `test/memory-history-budget-pagination`; tests added for repeated constrained-page traversal (no skipped/duplicated fixture events) and an individually oversized event (bounded response, explicit omission and continuation cursor).
- **Pending:** PR/CI review. Do not mark these edge cases verified until Ubuntu and Windows test jobs pass. If either test exposes a defect, fix the implementation without weakening assertions.
- **Additional open concern:** review that `totalVersions` is correctly scoped by the globally unique knowledge identity and that `serializedChars` is an exact fixed-point value at digit-boundary sizes. This follow-up does not claim either concern is a defect.

- **CI finding (run `41929755942`):** Ubuntu and Windows each failed only the new repeated-page test (262/263 passed); all typechecks and three benchmarks passed. The fixture's 1,500-character budget was too small for any of its 700-character-payload events plus response metadata, so it never observed a fixture event. Adjusted that traversal fixture to 2,500 characters so individual rows fit while the complete collection still requires multiple pages. This is a test-fixture correction, not a production fix; rerun CI must prove the traversal assertions.

- **CI finding (run `41930510132`):** Ubuntu and Windows again failed only the repeated-page test (262/263 passed). The fixture budget had been raised to 2,500, but its serialized-size assertion still incorrectly capped the page at 1,500 (observed 1,789). Updated that assertion to enforce the configured 2,500-character budget; no pagination/count/order assertion was relaxed. Await CI on the corrected head.

## 2026-11-04 — PR #161 merged: constrained memory-history pagination verified

- **IMPLEMENTED / verified:** PR #161 merged to `main` as `e5e646efaa1f45efd73612afab64b81bbd0dfbce`.
- CI run `41931940923` completed successfully: Ubuntu and Windows verification jobs passed `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run smoke`; Ubuntu, Windows, and macOS benchmark jobs also passed.
- Added regression coverage in `tests/memory-history.test.ts` for traversing repeated character-constrained pages without skipped/duplicated fixture events and deterministic ordering, plus explicit handling of an individually oversized event with bounded serialization and a continuation cursor.
- The two earlier CI failures were test-fixture/assertion mismatches, corrected without relaxing pagination completeness, uniqueness, or ordering assertions. The final CI run above supersedes the historical pending notes below.
- **Still open:** broader exact fixed-point/digit-boundary response-budget review and cross-tool response-budget coverage remain separate acceptance items; this PR does not close them.

## 2026-11-04 — Follow-up: update/correct rollback atomicity tests

- **Pending CI:** branch `test/memory-update-correct-rollback-atomicity` adds failure-injection tests to `tests/memory-update.test.ts` and `tests/memory-correct.test.ts`.
- Each test installs a SQLite trigger that aborts insertion of the next immutable version, then asserts the complete before/after database snapshot is identical across knowledge current pointers, versions, fragments, evidence, and events.
- This is targeted rollback/atomicity coverage, not yet independent-process lock contention. Do not mark the broader concurrency requirement complete until a separate-connection contention test passes on supported platforms.


## 2026-11-05 — concurrent writer verification and next gate

- **PR #165 verified:** merged as `c7a82bfe2d141433a1bc57e24842b729dec903e3`; CI run `41939068928` passed all five jobs. This covers independent-process SQLite write-lock contention and successful retry for both `memory_update` and `memory_correct`, plus the oversized-`memory_history` cursor regression and migration rollback/retry.
- **PR #168 verified:** merged as `96da869dcd198bccd7b6e6cce1ed67ceb6a4ee88`; exact-head CI run `41991378215` passed all five jobs. Its cross-process same-identity `memory_update` race verifies one winner, one stale conflict, one new version/event, and the winner's current pointer.
- PR #167's original head failed CI run `41989383489` on Ubuntu and Windows due to worker coordination timeout. It is closed as superseded by PR #168; do not reopen or merge it.
- **Active follow-up branch:** `test/memory-correct-same-identity-races` adds two process-level regressions: simultaneous `memory_correct` writers for one identity, and a mixed `memory_update`/`memory_correct` race. Both assert a single winner/conflict, current-version ownership, and no duplicate version/event or mixed fragment state. Treat this coverage as pending until fresh Ubuntu and Windows verification and all benchmark jobs pass.
- Same-identity correction and mixed-writer scheduling remain open until this follow-up merges. Physical power-loss/filesystem durability remains unverified despite SQLite `synchronous=FULL`.


## 2026-11-05 — migration/recovery verification continuation

- **PR #169 merged:** squash commit `d5cdb6cdca88f1f41211ae9fa2c85dc837f1d1ca`; exact-head CI run `41997492219` passed all five jobs. This completes same-identity `memory_correct` and mixed `memory_update`/`memory_correct` scheduling coverage alongside #165 and #168.
- **Active PR #170:** the branch is being rebased onto the post-#169 `main` without replaying the already-merged #169 test/doc diff. Its own scope remains limited to migration tests, FTS5 reopen/integrity tests, and the four tracking documents.
- The migration additions cover the four documented legacy status mappings plus an unknown legacy status preserved in `legacy_status` and mapped conservatively to `pending_validation`; legacy source rows and provenance are asserted unchanged.
- The on-disk v13 failure test closes/reopens SQLite, proves transactional DDL and migration-marker rollback survived process-style reopen, then retries without duplicate import. The lazy schema-v14 FTS5 test checks one-time index bookkeeping, repeated opens/searches, FTS5 `integrity-check`, FK integrity and SQLite `integrity_check`.
- The original PR #170 head passed exact-head CI run `41998827170` (five jobs) after the SQL-ordering fixture correction. The rebased branch requires a fresh exact-head run before merge; do not inherit the old green status as proof for the new head.
- Still open after this slice: full snapshots for every supported historical schema, duplicate/colliding legacy IDs, additional interruption boundaries outside v13 DDL, FTS rebuild/failure recovery, migration query-plan validation and empirical power-loss/filesystem durability.

- **Rebased PR #170 onto current main:** branch head before this status note was `a872db2464d9f4fc47aefdf198093c7d4a4e95b2`, parented directly on #169 merge `d5cdb6cdca88f1f41211ae9fa2c85dc837f1d1ca`. The diff is six files only; fresh CI for the rebased PR head is still required. The prior stacked head's green run `41998827170` is historical evidence only, not a check for the rebased head.


## 2026-11-05 — historical schema and identity-collision follow-up

- **PR #169 merged:** `d5cdb6cdca88f1f41211ae9fa2c85dc837f1d1ca`, CI `41997492219`, all five jobs green. Same-identity correction/correction and mixed update/correction concurrency are now covered on `main`.
- **PR #170 merged:** `6c75efe875044071acdfd4c79891beb7f9958bb6`, CI `42015208428`, all five jobs green. The legacy status matrix, file-backed v13 rollback/reopen/retry and schema-v14 FTS5 reopen/integrity cases are now on `main`.
- **Active PR #171:** adds a populated schema-v1 snapshot and retry-safe handling for normalized path collisions during the legacy stable-ID backfill. Distinct legacy paths `src\\collision.ts` and `src/collision.ts` must remain separate rows with deterministic unique IDs; dependent symbol IDs are recalculated when file identities are repaired after an interrupted v5 backfill. The test verifies the 1..13 marker sequence, source-row preservation, retry idempotency, FK and SQLite integrity.
- These #171 changes are pending exact-head CI/review. Remaining migration work includes more historical schema snapshots, additional collision/corrupt-state permutations, FTS rebuild/failure recovery, query-plan validation and physical power-loss/filesystem durability.
