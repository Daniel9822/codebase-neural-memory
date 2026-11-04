# Memory Reconciliation Apply — Safety Design

**Status:** Implemented baseline contract for event-only `request_review` (PR #149); follow-up hardening in review adds response-budget enforcement and related evidence/relation references.  
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

Follow-up hardening in this branch adds response-budget/truncation coverage and event payload references for related evidence/relations.

Still required:
- Independent SQLite connection changes a selected current version during a concurrent apply; transaction detects conflict.
- Failure injection after commit followed by retry returns the stored result.
- Explicit append-only event trigger behavior and full evidence/relation count/pointer preservation assertions.
- Windows/Ubuntu/macOS CI for the response-budget/reference hardening branch.

## 9. Explicitly deferred

- Duplicate merging or supersession.
- Contradiction resolution.
- Automatic changes to lifecycle or epistemic state.
- Evidence/relation deletion or rewriting.
- Automatic source reindexing or filesystem writes.
- Background scheduling or claims of autonomous review completion.
- Broad project-wide apply without explicit selected IDs.

These require separate contracts, provenance rules, user/agent authorization semantics, and recoverability analysis.
