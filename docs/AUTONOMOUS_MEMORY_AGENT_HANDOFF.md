# Autonomous Memory — Agent Handoff and Current Status

**Repository:** `Daniel9822/codebase-neural-memory`  
**Snapshot date:** 2026-11-04  
**Baseline:** `main`  
**Purpose:** operational entry point for any coding agent continuing the autonomous-memory work. This document is a navigation and handoff layer; it does not replace the contract, implementation checklist, or source code.

## Authority and document precedence

Use these sources in this order for their respective questions:

1. **Current behavior:** inspect the current `main` source, tests, migrations, and CI. Never infer implementation from a planned tool name or a checked documentation box.
2. **Intended behavior:** [Autonomous Memory Contract v2](AUTONOMOUS_MEMORY_CONTRACT.md).
3. **Progress, acceptance criteria, evidence, and remaining tasks:** [Master Implementation Checklist](AUTONOMOUS_MEMORY_IMPLEMENTATION_CHECKLIST.md). This is the canonical progress ledger.
4. **How an agent should operate CNM:** [Agent Workflow](AGENT_WORKFLOW.md).
5. **Repository-wide engineering rules:** root [AGENTS.md](../AGENTS.md).

If documents disagree, record the discrepancy and verify source/tests. Do not silently reconcile historical records or mark work complete without evidence.

## Status vocabulary

Every work item must use exactly one primary status:

- **IMPLEMENTED** — code is on `main`, focused tests exist, and the merged PR/commit is recorded.
- **PARTIAL** — some behavior is merged, but one or more acceptance criteria or threat cases remain open.
- **PENDING** — not implemented.
- **BLOCKED** — cannot proceed until a named dependency or decision is resolved.
- **NOT VERIFIED** — evidence is insufficient or current state has not been inspected.

A PR branch, an open PR, a green subset of tests, or documentation alone does not qualify as IMPLEMENTED. Record code path, tests, PR/merge commit, CI run, limitations, and next action.

## Verified implementation snapshot

The following autonomous-memory slices are recorded as merged to `main`:

| Capability | Status | Evidence / implementation |
|---|---|---|
| Contract v2 | IMPLEMENTED (specification) | PR #136; merge `4f66aad688bd62bf6b480160584b5231b057b879`; `docs/AUTONOMOUS_MEMORY_CONTRACT.md` |
| Schema v13 and legacy migration | IMPLEMENTED, with broader migration matrix still open | PR #137; merge `c1abe4160ff7a5c9503e42901b2c6e4e21476778`; `src/storage/database.ts` |
| `memory_capture` | IMPLEMENTED for current bounded deterministic capture semantics | PR #138; merge `7faf875f0166bc2e496d099039cb625dde5ba832`; `src/core/memory-capture.ts` |
| `memory_update` | IMPLEMENTED with optimistic expected-version update | PR #139; merge `f73e1a4022c8b61a6854af2e24c7405dabc3d24c`; `src/core/memory-update.ts` |
| `memory_correct` | IMPLEMENTED for targeted fragment correction | PR #140; merge `7ca7441059299a228c4889cb5ccbd542637cab58`; `src/core/memory-correct.ts` |
| `memory_history` | IMPLEMENTED with bounded independent version/event pagination | PR #141; merge `582161966b67a35ba83f8eddf128a97e0d2be9ed`; `src/core/memory-history.ts` |
| `memory_get`, `memory_expand` | IMPLEMENTED with bounded metadata/evidence and selective fragment expansion | PR #142; merge `b83fdcd87a14c9165b15e15f6126415b4c6b5bcc`; `src/core/memory-get.ts`; `tests/memory-get.test.ts` |
| `memory_search`, `memory_bootstrap` | PARTIAL — merged core behavior; edge-case acceptance matrix remains open | PR #144; merge `b9ec6802a5646ee9ed1abd5f5717fc91be4ff9a5`; CI run `41795181023`; `src/core/memory-search.ts`, `src/core/memory-bootstrap.ts`; 239 tests passed on Ubuntu and Windows |
| `memory_health` | MERGED — bounded integrity and source-freshness report; no automatic repair | PR #146; merge `5b55a443c910742dde07696503d3aed01e71d69c`; CI `41821794346` green; `src/core/memory-health.ts`; MCP tool and tests |
| `memory_reconcile` preview | IMPLEMENTED — bounded read-only findings preview | PR #147; merge `754b7dddd74afc8b3be5353cdc838568e0ba7283`; CI `41823553294`; `src/core/memory-reconcile.ts` |
| `memory_reconcile` `request_review` | IMPLEMENTED — event-only apply, bounded response, evidence/relation references; no knowledge/lifecycle mutation | PRs #149–#156; #156 merge `55d663aae0da7b4a2a68696f0c74ae1a328cff1a`; CI `41913689539` passed all five jobs; `src/core/memory-review-request.ts`, `src/storage/database.ts`; `tests/memory-review-request.test.ts` |

The implementation checklist contains the detailed semantics and evidence. Historical progress-log entries describe the state at the time they were written; later entries supersede earlier ones. Do not interpret a historical “pending” note as current without reading the latest status and checking `main`.



### Latest verified storage and transaction update — PR #164

PR #158 is merged as `5ea62b89ea2f348080d55396b288612a534568d9` (head `9b2d7c33b62564f087c3196faeaff1b49865922e`; CI `41919002890`, all five jobs green). `src/storage/database.ts` now explicitly sets `PRAGMA synchronous = FULL` on each opened WAL connection. `tests/memory-review-request.test.ts` asserts WAL mode and synchronous level `2`. The bounded recall fixture in `tests/memories.test.ts` batches its 5,001 inserts in one transaction, retaining its truncation assertions while avoiding per-row FULL-sync commits on Windows. This verifies SQLite configuration and CI behavior only; it does not prove physical power-loss, storage-controller, or filesystem durability. Keep that item open.

## Open autonomous-memory work

These are known open items at this snapshot. They are not claims that every edge case has been exhaustively re-audited; verify the current branch and tests before acting.

### Next implementation slice

**`memory_health`, the read-only `memory_reconcile` preview, and event-only `request_review` are merged** (PRs #146, #147, #149, #150; CI runs `41821794346`, `41823553294`, `41825667650`, and `41827470581`; all five jobs passed for #150, including Windows verification and benchmarks on Ubuntu/Windows/macOS). `request_review` lives in `src/core/memory-review-request.ts` and is exposed through MCP `memory_reconcile`. It defaults to dry-run; apply requires explicit selected IDs, expected current-version IDs, and an idempotency key. It validates project ownership/current versions inside an immediate transaction, appends `reconciliation_review_requested` events and the idempotency result atomically, and supports same-key replay plus mismatch conflict. It does not modify knowledge content, versions, current pointers, lifecycle, epistemic state, evidence, or relations. Focused tests are in `tests/memory-review-request.test.ts` and MCP integration coverage in `tests/mcp-adapter.test.ts`. PR #151 additionally verifies preservation of evidence, relations, fragments, and current-version pointers, plus database-enforced append-only event behavior (CI run `41828848388`, all five jobs green). PR #152 explicitly tests lost-response-after-commit replay. PR #153 adds a stale-version check after a write committed through an independent SQLite connection, plus a child-process test that exits immediately after commit before returning a response and verifies idempotent recovery. CI run `41834609758` passed all five jobs for PR #153, merged as `a85ef0235bbe05cbdf4ba788c584e8c6c20848d9`. The stale-version and post-commit process-termination checks are verified. They do not prove power-loss/filesystem durability. PR #154 is merged (merge `875112ca6ad92d9e919ec0321cb14093295b8ba4`; CI `41839728294`, all five jobs green) and established safe failure/no writes and retry under cross-process database-open contention, but did not prove contention at the apply transaction. PR #156 closes that specific verification gap: merge `55d663aae0da7b4a2a68696f0c74ae1a328cff1a`, head `4df8d05e722212316af73f7ffdae553d4fd118d9`, CI `41913689539` (all five jobs green). Its schema-v13 read-only fast path lets a fully migrated database open while the independent writer holds `BEGIN IMMEDIATE`; the test then confirms `requestMemoryReview` fails at its immediate apply transaction without writes and succeeds on same-key retry after release. The test waits for the child process to close its SQLite/WAL handles before assertions and cleanup, including on Windows. This verifies lock contention/retry at the apply boundary, not power-loss durability. The 12,000-character response budget and evidence/relation reference capture were added in PR #150.

Merge: `b9ec6802a5646ee9ed1abd5f5717fc91be4ff9a5`. CI run `41795181023` passed all five jobs: typecheck, 239 tests, build, and smoke on Ubuntu/Windows, plus benchmarks on Ubuntu/Windows/macOS. Core search/browse, filters, snapshot cursors, bounded bootstrap, FTS migration/backfill, and MCP protocol coverage are on `main`. E1 remains PARTIAL because the full multilingual/basic-normalization, wildcard, repeated-run, ambiguous-query, and exact-boundary acceptance matrix is not yet complete. Source-evidence freshness, health/reconcile, and dependent-knowledge review remain open.

Expected scope:
- deterministic, project-scoped lexical FTS5 search over versioned knowledge;
- current-version/lifecycle filtering by default, with explicit historical options where specified by the contract;
- support for relevant titles, summaries, fragments, types, tags/aliases, paths/symbols and exact identifiers; empty-query browse; snapshot-bound cursors; no raw FTS syntax errors;
- bounded snippets/results, stable tie-breakers, match explanations, and truncation metadata;
- compact bootstrap context with explicit epistemic labels, contract-aligned item/character bounds, type/include-pending filters, and no invented freshness guarantees;
- migration/backfill and FTS consistency tests, plus MCP schema/protocol tests.

Do not add embeddings, hosted services, LLM calls, or remote dependencies.

### Memory lifecycle and coherence

**PARTIAL:**
- `memory_health`: bounded schema/data integrity, broken references, conflicts, pending validation, and source-freshness diagnostics are merged; broader malformed/legacy and consistency matrix remains open.
- `memory_reconcile`: bounded preview and event-only `request_review` are merged. Review completion/resolution and exact dependent-impact capture remain open. Response budgets and evidence/relation references are implemented. Stale-version detection, post-commit process-termination recovery, and cross-process lock contention specifically inside the apply transaction are verified (PR #156; CI `41913689539`, five jobs green). PR #158 additionally configures WAL `synchronous=FULL` and verifies the pragma (`5ea62b89ea2f348080d55396b288612a534568d9`; CI `41919002890`, all five jobs green). This does not establish physical power-loss/filesystem durability, which remains open.
- relationship-aware dependent-knowledge impact/review when a source memory is corrected or superseded;
- broader deterministic matching/enrichment/conflict/supersession/split behavior;
- source freshness integration using existing file/symbol/Git/index mechanisms; stale evidence must mark claims for review, never silently delete knowledge;
- update idempotency and explicit lifecycle/epistemic transition validation where required by the contract.

### Reliability and migration verification

**PENDING / NOT VERIFIED until evidenced:**
- migration matrix from all supported prior schema versions, including interruption/reopen/retry and malformed legacy data;
- deterministic overlapping SQLite-connection writer/apply contention tests for `memory_update`, `memory_correct`, and reconciliation apply;
- failure-injection and rollback/atomicity tests (targeted rollback injection merged in PR #164; broader matrix remains open);
- relation/evidence/current-version/FTS consistency checks and repairability;
- serialized response-budget coverage across history/search/bootstrap and adversarial boundary cases;
- retrieval quality corpus and deterministic ranking evaluation.

### Agent and client integration

**PENDING / PARTIAL:**
- bootstrap at session start and search-before-broad-exploration guidance;
- progressive use of search → get → expand → history, and capture/update/correct during and after work;
- generated `AGENTS.md` instructions updated idempotently without overwriting user-authored content;
- tool descriptions and MCP contract synchronized with actual schemas;
- real supported MCP-client verification;
- compatibility/deprecation plan for legacy `memory_recall`, `memory_propose`, and `memory_transition`. Keep legacy semantics explicit; do not pretend they are aliases for the new APIs.

### CLI, evaluation, and release

**PENDING:**
- CLI surface for the versioned APIs where required by the final product contract;
- cross-session/cross-agent evaluation corpus and control-vs-treatment measurements;
- precision/recall, stale-claim rate, correction propagation, response-size, latency, and migration benchmarks;
- final clean-checkout gates and full documentation close-out.

## Integrity/freshness workstream — do not overstate closure

The master checklist sections A1–A7 remain the detailed acceptance ledger. Current high-level interpretation:

- **CNM-01 — PARTIAL:** relation-configuration freshness exists; conservative manifest fingerprinting can produce false positives. Missing/changed/malformed/unreadable configuration cases and normalization precision still need completion.
- **CNM-02 — PARTIAL:** directory symlink protection and incomplete-scope safeguards exist for the defined cases; the master checklist still has open destructive-path, nested/dangling/replacement, selective/budgeted, and platform regression criteria. Do not mark the full workstream closed until A1/A7 acceptance is evidenced.
- **CNM-03 — PENDING/PARTIAL:** CLI-facing full-index guards exist, but all internal/destructive reconciliation entry points and failure/incomplete discovery paths still need audit and tests.
- **CNM-04 — PARTIAL:** strict/non-strict post-read freshness and representative interleavings exist; deterministic mutation/race coverage and response-envelope bounds remain open.
- **CNM-05 — IMPLEMENTED for the documented threat boundary, residual risk remains:** descriptor-verified reads and path identity checks are merged; documented path-based directory swap-and-restore limitations remain. Reopen only if new evidence or scope requires it.
- **CNM-06 — IMPLEMENTED:** PR #135 merged; CI run 41718023148 passed. Cross-cutting A7 validation remains separate.
- **Cross-cutting A7 — PENDING:** combined risk tests, transaction consistency review, platform coverage, and cross-document close-out remain open.

The checklist is authoritative for the individual checkboxes and acceptance details. Do not bulk-check remaining items based on these summaries.

## Required sequence for the next agent

1. Read this handoff, the contract, the full master checklist, `AGENTS.md`, and the relevant sections of `AGENT_WORKFLOW.md`.
2. Inspect GitHub state: current `main` HEAD, open PRs, branch HEADs, and CI. Confirm whether the merged PR #147 and documentation close-out are present.
3. Inspect `src/storage/database.ts`, `memory-health.ts`, `memory-reconcile.ts`, capture/update/correct/history core modules, MCP registration, idempotency storage, and migration/test patterns before designing reconciliation apply semantics.
4. Specify mutating reconciliation invariants and failure/recovery behavior before implementation. Implement only a separately reviewable slice on a feature branch; add focused core, migration, boundary, project-isolation, concurrency, rollback, and MCP tests.
5. Update the master checklist with exact code paths, tests, PR, merge commit, CI run, limitations, and next action. Keep historical log entries intact; add a dated superseding entry instead of rewriting history.
6. Synchronize only affected documents. At minimum, when adding MCP tools, update the MCP contract and agent workflow; when behavior changes, update architecture/product/acceptance/README/changelog as applicable.
7. Review the entire diff. Run the repository's required checks and report the actual outcomes. Do not merge until required CI is green.
8. After merge, verify the merge commit and post-merge `main`; only then change status to IMPLEMENTED.

## Final source-of-truth rule

This handoff is a navigation snapshot, not a substitute for fresh verification. The **master implementation checklist** remains the single progress ledger; the **contract** remains the intended-behavior authority; source/tests/CI on current `main` remain the authority for actual behavior. If any status in this handoff becomes stale, update it from evidence rather than guessing.


## 2026-11-04 — Latest continuation after PR #160

PR #160 is merged as `a430548943b55eed9a0cd15d5dd7aaff58d3e594`. `memory_history` now has compact serialized response budgeting, exact totals, explicit truncation/omission metadata, and independent version/event pagination. A source review found the original tests did not cover repeated constrained-page traversal or one event larger than the whole response budget. Follow-up branch `test/memory-history-budget-pagination` adds those regressions. Treat them as pending until the PR's Ubuntu/Windows CI passes; see the master checklist for evidence and limitations.

Next after this test close-out: prioritize the migration compatibility/recovery matrix and independent-connection contention/rollback coverage for `memory_update` and `memory_correct`, then relationship-aware dependent-knowledge review and source-evidence freshness. Keep power-loss/filesystem durability explicitly unverified.


CI follow-up for PR #161: initial run `41929755942` failed on Ubuntu and Windows only in the repeated-page test because the fixture's 1,500-character budget excluded every 700-character event once response metadata was included. The fixture budget was raised to 2,500 so events can be returned over multiple constrained pages; await new CI before claiming pagination verified.

CI follow-up for PR #161, run `41930510132`: Ubuntu and Windows failed only the repeated-page test because the page was configured for 2,500 characters while the assertion still capped it at 1,500 (actual serialized size 1,789). The assertion now matches the configured 2,500-character ceiling; pagination completeness, uniqueness, and ordering assertions remain unchanged. Await CI on the corrected head; do not merge before both verification jobs pass.

## 2026-11-04 — PR #161 verification close-out

PR #161 is merged to `main` as `e5e646efaa1f45efd73612afab64b81bbd0dfbce`. CI run `41931940923` passed all five jobs: Ubuntu and Windows verification (install, typecheck, full tests, build, smoke), and benchmarks on Ubuntu, Windows, and macOS. The merged tests in `tests/memory-history.test.ts` verify repeated constrained-page traversal without skips or duplicates and deterministic ordering, plus individually oversized-event omission and cursor advancement. Earlier “await CI” notes in this handoff are historical and are superseded by this verified result.

## 2026-11-04 — Next reliability slice in progress

Branch `test/memory-update-correct-rollback-atomicity` adds failure-injection coverage for `memory_update` and `memory_correct`: SQLite triggers abort immutable-version insertion, and tests assert that current pointers, version rows, fragments, evidence, and events remain identical snapshots of the queried fields. This is pending CI and review. It does not yet close independent-connection contention coverage for these operations.
