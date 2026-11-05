# Memory Reconciliation Apply — Safety Design

**Status:** PR #158 also configures SQLite WAL `synchronous=FULL` on each opened connection and asserts the effective setting (`5ea62b89ea2f348080d55396b288612a534568d9`; CI `41919002890`, all five jobs green). This verifies the configured SQLite policy only; physical power-loss/filesystem durability remains unverified. Implemented event-only `request_review` contract (PRs #149–#150 merged); PR #151 adds preservation and append-only assertions; PR #152 verifies lost-response replay; PR #153 adds independent-connection stale-version and child-process termination-after-commit tests (merged as `a85ef0235bbe05cbdf4ba788c584e8c6c20848d9`; CI `41834609758`, all five jobs green); PR #156 verifies contention at the apply transaction (merge `55d663aae0da7b4a2a68696f0c74ae1a328cff1a`; CI `41913689539`, all five jobs green).  
**Baseline:** PR #147 merged to `main` as `754b7dddd74afc8b3be5353cdc838568e0ba7283`; CI `41823553294` passed all five jobs.  
**Scope:** Define the first safe write-capable reconciliation operation without merging, rewriting, archiving, or deleting knowledge.

## 1. Current boundary

The `memory_reconcile` tool provides a bounded read-only preview and an explicit event-only `request_review` apply mode. The apply mode is separate from preview selection and is constrained by the invariants below.

This design does not authorize duplicate merging, automatic contradiction resolution, evidence deletion, relation deletion, lifecycle changes, or automatic epistemic-state promotion/demotion.

## 2. First permitted operation

The only implemented write operation is **`request_review`**:

- Append an auditable review-request event for an explicitly selected, existing knowledge item.
- Include the triggering reason and up to 20 related evidence IDs and 20 relation IDs in the event payload when available; include explicit truncation flags for either reference list.
- Preserve the knowledge item, current version pointer, every immutable version, fragment, evidence row, and relation unchanged.
- Do not claim that a human has reviewed or resolved the item. A review-request event is a queue signal, not a validation result.
- Do not infer or apply the operation to every preview candidate. The caller must submit an explicit bounded list of IDs and the expected current version ID for each item.

Duplicate candidates and contradictions are report-only in this first apply slice. They require separate human-directed operations and must never be auto-merged or auto-resolved.

## 3. Request contract

Proposed MCP input:

- `dryRun`: boolean, default `true`.
- `operation`: literal `request_review`; required when applying.
- `items`: 1–100 explicit entries, each containing `knowledgeId`, `expectedVersionId`, and a bounded non-empty `reason`.
- `idempotencyKey`: required for apply; bounded opaque caller-supplied key.
- `limit`: optional 1–100 for preview only; does not widen the explicit apply list.

Apply must reject missing operation, missing idempotency key, empty/oversized item lists, duplicate IDs, malformed reasons, and unknown fields. The operation must be project-scoped and must not accept filesystem paths as authority for choosing knowledge IDs.

## 4. Concurrency and idempotency

- Re-read each selected item and verify project ownership, active/current identity, and exact `expectedVersionId` inside the write transaction.
- If any selected item is missing, belongs to another project, or has changed current version, abort the entire batch. Return a structured conflict; do not partially append events.
- Compute a canonical request hash over operation, project, ordered normalized item inputs, expected versions, and reasons.
- Use the existing `memory_idempotency` keyspace scoped by project and operation.
- Same key + same request hash returns the original stored result without adding events.
- Same key + different request hash returns an idempotency conflict and performs no writes.
- Append all review-request events and the idempotency result in one SQLite transaction. A crash before commit leaves neither; a crash after commit leaves both. Retry returns the stored result.
- Stable item ordering and deterministic result serialization are required.

## 5. Event contract

The proposed event type is `reconciliation_review_requested`. Payload should include:

- schema/version marker;
- operation identifier and idempotency key reference (never secrets);
- review reason code and concise explanation;
- source evidence identifiers and relation identifiers when available;
- expected current version ID;
- actor and timestamp via the existing event columns.

Events are append-only. The operation must not update/delete prior events or evidence. Do not place raw source contents, credentials, absolute paths, or unbounded user text in event payloads.

## 6. Dry-run/apply separation

- Default calls are dry-run and must not write events or idempotency rows.
- Dry-run returns the same validation/conflict assessment apply would use, including candidate count, exact selected IDs, and whether every expected version still matches.
- Apply repeats all validation inside its transaction; a prior dry-run is not a lock or authorization token.
- Apply response must distinguish `applied: true`, `applied: false`, `dryRun: true`, idempotent replay, and conflicts.
- A failed batch must never report partial success.

## 7. Bounds and response safety

- At most 100 explicitly selected items per operation.
- Enforce a serialized response budget of 12,000 characters; report `totalItems`, `returnedItems`, `truncated`, `maxChars`, and `serializedChars` explicitly. The event append remains atomic for all selected items even when the returned per-item detail list is truncated.
- Stable ordering by knowledge ID; never rely on SQLite's implicit row order.
- Return exact counts only when computed; otherwise label counts as sampled/lower-bound.
- Keep preview sampling and apply selection distinct. Preview `limit` must not silently become an apply selection.

## 8. Verification status and remaining tests

Implemented and merged in PR #149: default dry-run creates no event/idempotency row; successful apply appends one event per item and preserves knowledge/version rows; same-key replay and mismatch conflict; stale/missing/foreign IDs abort the batch; duplicate IDs, missing apply key and invalid batch size are rejected; event-insert failure rolls back events and idempotency; MCP integration applies a review request. CI run `41825667650` passed all five jobs.

PR #150 merged as `2279edd954bdeedea2c7cd9d1e5d014c05eccb24`; CI `41827470581` passed all five jobs. It enforces the 12,000-character serialized response budget and records up to 20 related evidence IDs and 20 project-scoped relation IDs per event, with truncation flags.

Still required:
- [x] Deterministic cross-process database-open contention/retry is covered by PR #154 (merge `875112ca6ad92d9e919ec0321cb14093295b8ba4`; CI `41839728294`, all five jobs green). The initial test did not isolate the apply transaction.
- [x] Deterministic contention specifically at `requestMemoryReview`'s immediate apply transaction is covered by PR #156 (merge `55d663aae0da7b4a2a68696f0c74ae1a328cff1a`; head `4df8d05e722212316af73f7ffdae553d4fd118d9`; CI `41913689539`, all five jobs green). The schema-v13 read-only fast path allows `openDatabase()` to succeed while a child holds `BEGIN IMMEDIATE`; the apply then fails without writes and same-key retry succeeds after release.
- [ ] Power-loss/filesystem durability testing; the child-process termination test covers process exit after commit, not machine/power failure. PR #158 sets WAL `synchronous=FULL` and tests the pragma value (`2`), but does not simulate or prove physical power-loss, storage-controller, or filesystem behavior.


## 9. Rollback coverage update — PR #164

PR #164 is merged to `main` as `f9ff199321ce240c052a431ed0897b5196004d79`; CI run `41934624316` passed all five jobs. Failure-injection tests in `tests/memory-update.test.ts` and `tests/memory-correct.test.ts` abort immutable-version insertion and verify identical before/after snapshots of the queried knowledge pointers, version rows, fragments, evidence rows, and events. This closes the targeted injected-failure case only. Independent-process lock contention/retry coverage for `memory_update` and `memory_correct` remains a separate active test slice; simultaneous same-identity writer scheduling and physical power-loss/filesystem durability remain unverified.

## 10. Explicitly deferred

- Duplicate merging or supersession.
- Contradiction resolution.
- Automatic changes to lifecycle or epistemic state.
- Evidence/relation deletion or rewriting.
- Automatic source reindexing or filesystem writes.
- Background scheduling or claims of autonomous review completion.
- Broad project-wide apply without explicit selected IDs.

These require separate contracts, provenance rules, user/agent authorization semantics, and recoverability analysis.
