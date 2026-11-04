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

The implementation checklist contains the detailed semantics and evidence. Historical progress-log entries describe the state at the time they were written; later entries supersede earlier ones. Do not interpret a historical “pending” note as current without reading the latest status and checking `main`.

## Open autonomous-memory work

These are known open items at this snapshot. They are not claims that every edge case has been exhaustively re-audited; verify the current branch and tests before acting.

### Next implementation slice

**`memory_health` is merged in PR #146** (merge `5b55a443c910742dde07696503d3aed01e71d69c`; CI `41821794346` green). Its report is read-only with respect to knowledge and includes bounded integrity/source-freshness samples. The next implementation slice is `memory_reconcile` as a separate bounded, auditable dry-run-first operation; do not silently rewrite dependent knowledge.

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

**PENDING / PARTIAL:**
- `memory_health`: schema and data integrity, broken references, conflicts, pending validation, and truthful freshness diagnostics.
- `memory_reconcile`: bounded, auditable reconciliation with dry-run/reporting and safe behavior on incomplete discovery.
- relationship-aware dependent-knowledge impact/review when a source memory is corrected or superseded;
- broader deterministic matching/enrichment/conflict/supersession/split behavior;
- source freshness integration using existing file/symbol/Git/index mechanisms; stale evidence must mark claims for review, never silently delete knowledge;
- update idempotency and explicit lifecycle/epistemic transition validation where required by the contract.

### Reliability and migration verification

**PENDING / NOT VERIFIED until evidenced:**
- migration matrix from all supported prior schema versions, including interruption/reopen/retry and malformed legacy data;
- independent SQLite-connection concurrency tests for `memory_update` and `memory_correct`;
- failure-injection and rollback/atomicity tests;
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
2. Inspect GitHub state: current `main` HEAD, open PRs, branch HEADs, and CI. Confirm whether `feat/memory-search-bootstrap` still exists and whether it is based on current `main`.
3. Inspect `src/storage/database.ts`, capture/update/correct/get/history core modules, MCP registration, and migration/test patterns before designing search/bootstrap.
4. Implement only the next coherent slice on a feature branch. Add focused core, migration, boundary, project-isolation, and MCP tests.
5. Update the master checklist with exact code paths, tests, PR, merge commit, CI run, limitations, and next action. Keep historical log entries intact; add a dated superseding entry instead of rewriting history.
6. Synchronize only affected documents. At minimum, when adding MCP tools, update the MCP contract and agent workflow; when behavior changes, update architecture/product/acceptance/README/changelog as applicable.
7. Review the entire diff. Run the repository's required checks and report the actual outcomes. Do not merge until required CI is green.
8. After merge, verify the merge commit and post-merge `main`; only then change status to IMPLEMENTED.

## Final source-of-truth rule

This handoff is a navigation snapshot, not a substitute for fresh verification. The **master implementation checklist** remains the single progress ledger; the **contract** remains the intended-behavior authority; source/tests/CI on current `main` remain the authority for actual behavior. If any status in this handoff becomes stale, update it from evidence rather than guessing.
