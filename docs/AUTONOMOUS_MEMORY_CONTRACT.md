# Autonomous Memory Contract v2

**Status:** Approved implementation contract. Base schema v13/migration, the lazy schema-v14 FTS5 search-index migration, and the versioned core/MCP operations `memory_capture`, `memory_update`, and `memory_correct` are merged to `main` (PRs #137–#140). Progressive retrieval/history and health are merged; reconciliation has a read-only preview merged to `main` in PR #147; mutating maintenance, durable dependent-knowledge workflow, and broader agent integration remain unimplemented.  
**Audit baseline:** `main` at `8ffbc71109ab165f857bc5ef5393331f17130b53` (2026-11-03). Contract merged to `main` in PR #136 at `4f66aad688bd62bf6b480160584b5231b057b879`.  
**Scope:** Project-local, persistent knowledge that can be captured, versioned, corrected, related, retrieved, and reviewed by compatible coding agents.

## 1. Product contract

CNM memory is a project-owned knowledge store, not a conversation transcript and not a replacement for source code.

The normal agent workflow is:

1. Recall relevant project knowledge before broad exploration.
2. Verify source-linked claims when their freshness or certainty matters.
3. Capture durable discoveries during work, not only at session end.
4. Record changes, corrections, decisions, test evidence, and unresolved questions with their actual epistemic status.
5. Retrieve current knowledge by default and expand history or detail only when needed.

Normal capture of reusable knowledge must not require per-item user approval. The agent decides when a durable discovery merits a tool call; CNM persists the submitted knowledge locally and labels its epistemic status. CNM cannot passively observe arbitrary conversations: it only receives information explicitly supplied through its CLI/core/MCP interfaces. Agent instructions and tool descriptions must make capture a normal workflow behavior.

Memory must remain local-first, project-scoped, model/agent-agnostic, deterministic, bounded, and usable without a hosted service, LLM, embeddings, GPU, or paid API.

## 2. Authority and epistemic distinctions

CNM must not collapse different kinds of truth into one status.

### 2.1 Lifecycle

Lifecycle answers whether a knowledge identity is current in the project knowledge base:

- `active`: current knowledge; eligible for ordinary recall subject to epistemic and freshness labels.
- `superseded`: replaced by a newer knowledge identity or version; retained for history and excluded from current recall by default.
- `archived`: intentionally retained but not normally surfaced.

Lifecycle is independent of whether the content is verified.

### 2.2 Epistemic state

Epistemic state answers what kind of claim is being stored:

- `observed`: directly observed behavior or state, not necessarily independently tested.
- `verified`: supported by explicit source/test evidence recorded with the knowledge.
- `inferred`: reasoned interpretation; useful but not a demonstrated fact.
- `user_asserted`: a statement or correction supplied by the user. It is authoritative as user intent/assertion, but is not automatically proof of current implementation.
- `planned`: desired future behavior or an approved direction not yet implemented.
- `hypothesis`: a tentative explanation that needs investigation.
- `pending_validation`: a claim whose validation is required or whose evidence became stale.

The source repository and reproducible tests remain the authority for claims about implemented behavior. User instructions are authoritative for desired behavior, constraints, and decisions within the user's authority. If those conflict, preserve both as distinct linked knowledge (for example, current implementation = observed/verified; desired behavior = planned/user_asserted) and expose the discrepancy. Never rewrite a code fact merely to match an intended design.

### 2.3 Confidence

Confidence is a separate, optional normalized value in the range 0–1, accompanied by a short basis/reason where useful. It is not a substitute for epistemic state or evidence. Do not fabricate numeric precision; omit confidence when the submitting agent cannot justify it. Retrieval must display epistemic state and relevant evidence, not just a confidence number.

## 3. Knowledge identity and version model

A knowledge identity is stable across edits. Each content change creates a new immutable version.

A knowledge identity contains at least:

- stable UUID;
- extensible knowledge type/category and optional tags/aliases;
- current version pointer;
- lifecycle;
- creation/update timestamps.

A knowledge version contains at least:

- immutable version UUID and monotonically increasing version number per identity;
- title, concise summary, and detailed content;
- epistemic state and optional confidence/basis;
- actor/agent/tool origin;
- creation timestamp and change reason;
- links to source/evidence records and fragments.

A version is never edited in place. Updating content, correcting a claim, or changing epistemic classification appends a new version and an audit event in one transaction. The previous version remains addressable.

Knowledge types are extensible strings. Initial recommended values are `behavior`, `architecture`, `infrastructure`, `procedure`, `convention`, `decision`, `incident`, `solution`, `test_evidence`, `constraint`, `hypothesis`, `pending_question`, and `lesson`. Unknown non-empty types may be stored; clients must not assume the list is closed.

## 4. Fragments, sources, and relations

### 4.1 Fragments

Large knowledge items may contain ordered, independently retrievable fragments. Each fragment has a stable ID within its version, a title/heading, concise summary, body, ordinal, and optional token/character metadata. The default search response returns summaries/snippets; expansion retrieves only selected fragments. Fragment IDs are version-scoped so a later edit cannot silently change the meaning of an old fragment.

### 4.2 Evidence and provenance

Evidence is stored separately from prose and may include:

- source file path, symbol identifier/name, file hash, and observed line range;
- commit SHA, branch/worktree/index revision where available;
- test command, test identifier, result, and execution timestamp;
- user correction or instruction reference represented as a supplied assertion (not a fabricated conversation archive);
- agent/tool identifier and observation method.

Every evidence item records its kind, locator/metadata, observed time, and verification result when applicable. Secrets, credentials, private keys, authentication histories, and irrelevant transient conversation content must never be captured.

Freshness is evaluated using existing CNM source/Git/index mechanisms where possible. A changed or missing source marks the affected claim for review/pending validation; it does not delete the knowledge or silently rewrite it. A stale source reference must be visible in recall and bootstrap responses.

### 4.3 Relations

Knowledge relations are typed, directed, and explainable. Initial relation kinds include `supports`, `contradicts`, `supersedes`, `depends_on`, `related_to`, `derived_from`, and `affects`. Relations carry actor/origin, timestamp, and optional evidence/reason. Ambiguous matches must not be auto-merged or linked as facts.

## 5. Capture and update behavior

### 5.1 Capture

`memory_capture` accepts one or more small reusable knowledge units, each with bounded title/summary/content, type, epistemic state, optional confidence, tags/aliases, source/evidence, fragments, and an idempotency key.

Capture outcomes are explainable:

- `created`: no sufficiently equivalent identity was found;
- `enriched`: deterministic evidence supports adding information to an existing identity, by appending a version;
- `duplicate`: the submitted content is already represented; no new version is created;
- `conflict`: a plausible existing identity disagrees or cannot safely be reconciled; preserve both and record a conflict/review relation.

Capture is local and atomic. Retrying the same idempotency key returns the same outcome/IDs and must not create duplicate records. Capture does not imply human confirmation. Low-confidence or inferred knowledge may be stored immediately with its correct epistemic label.

The initial implementation should use deterministic matching (stable source/symbol identity, explicit identity hints, normalized exact/lexical matches, aliases, and bounded relation context). It must not use an LLM or perform destructive fuzzy merges. Ambiguous cases create a conflict/review result.

### 5.2 Update

`memory_update` appends a version to a known identity. It requires `knowledgeId`, `expectedVersionId`, and a non-empty change `reason`; actor is optional. Mutable knowledge fields are partial: omitted title/summary/content/epistemic state/confidence/tags/aliases/fragments inherit from the current version. A supplied content body replaces the primary fragment; supplied fragments replace the prior fragment set (and are preceded by the primary content fragment when content is supplied). Existing evidence is carried forward into the new version and newly supplied evidence is appended. The identity's current-version pointer and metadata update in the same transaction as the new immutable version, fragments, evidence, and `updated` event. A stale expected version returns a structured `conflict` with the actual current version and performs no write. An unchanged effective payload returns `no_op` and creates no version/event. The original version and its author/evidence remain intact. Current implementation is `src/core/memory-update.ts`, exposed as MCP `memory_update`; core and protocol regression tests cover append/history preservation, stale conflict, no-op, confidence rationale, and project isolation. PR #164 adds targeted failure-injection rollback tests for immutable-version insertion. PR #165 adds independent-process lock-contention/retry tests for both update and correction. Its initial CI also exposed and prompted a fix for `memory_history` cursor advancement past individually oversized events; the fix and tests await fresh Ubuntu/Windows CI. Simultaneous same-identity writer scheduling remains open.

### 5.3 Correction

`memory_correct` requires `knowledgeId`, `expectedVersionId`, `targetFragmentId`, `replacementContent`, a non-empty reason, correction source (`user` or `agent`), and an explicit epistemic state. It only targets a fragment belonging to the expected current version. A stale expected version returns a structured conflict; identical replacement content is a no-op. A successful correction appends a new immutable version, copies all fragments while replacing only the selected fragment, carries forward prior evidence and appends supplied evidence, then writes an append-only `corrected` event containing the previous version ID, target fragment ID, correction source, ordinal, and version number. Actor and reason are stored on the new version/event. Prior versions/fragments/evidence remain unchanged. The core implementation is `src/core/memory-correct.ts`, exposed through MCP `memory_correct`.

A user correction is captured without asking for confirmation again. The API permits user-sourced corrections only as `user_asserted` or `pending_validation`; it cannot promote a user assertion to verified implementation. Agent-sourced corrections marked `verified` must include evidence. The agent must still interpret the correction and label it correctly:
- correction of a current implementation claim -> record the user assertion and mark the implementation claim pending validation if it conflicts with source/tests;
- desired future behavior -> create/update a linked `planned` decision, not a claim that code already behaves that way;
- verified implementation change -> record the new behavior as verified only after relevant source/tests support it.

Dependent knowledge is intended to be marked for review through bounded impact discovery; that discovery/review queue is not implemented in the current correction slice. CNM must not blindly rewrite all related entries. A desired future behavior must be captured separately as a linked `planned` decision; `memory_correct` does not create that decision automatically.

### 5.4 Reconciliation

Reconciliation is bounded, deterministic, and reportable. It can identify stale evidence, duplicate candidates, contradictions, orphan relations, and dependent entries requiring review. Broad or destructive actions must support dry-run/reporting. Source changes never justify deleting knowledge by themselves. The initial preview is read-only. Any first apply-capable slice is limited to an explicit `request_review` operation that appends an audit event for caller-selected IDs without changing knowledge, versions, evidence, relations, lifecycle, or epistemic state. It requires explicit expected current-version IDs, project-scoped idempotency, all-or-nothing transactions, and bounded responses. Duplicate merge, contradiction resolution, lifecycle/state changes, and deletion are explicitly excluded. See [Memory Reconciliation Apply Design](MEMORY_RECONCILIATION_APPLY_DESIGN.md). Version and event history has no automatic time-based deletion in the initial implementation; any future pruning policy must be explicit, auditable, recoverable, and must preserve the latest version and required provenance. History queries remain bounded and paginated.

## 6. Progressive retrieval contract

Current knowledge is returned by default; superseded/archived history is opt-in.

- `memory_bootstrap`: compact project overview of high-value current knowledge, unresolved questions/risks, pending validation, and freshness warnings. Strict item/character limits and truncation metadata are mandatory.
- `memory_search`: bounded lexical/FTS5 search across title, summary, content/fragments, aliases/tags, type, paths/symbols, and optional time/epistemic/lifecycle filters. Exact identifiers and source locators receive explicit ranking signals. Results explain why they matched.
- `memory_get`: retrieve one identity and its current version metadata/summary.
- `memory_expand`: retrieve selected fragments or bounded detail by stable fragment ID, with pagination.
- `memory_history`: retrieve immutable versions and events with bounded pagination.
- `memory_health`: report schema/migration state, counts, pending validation/conflicts, broken references, and bounded source freshness.
- `memory_reconcile`: run or preview bounded consistency/freshness maintenance.

Existing `memory_recall`, `memory_freshness`, `memory_propose`, and `memory_transition` remain compatibility surfaces during migration. Their behavior must be explicitly mapped and documented; do not silently reinterpret legacy statuses or remove existing IDs.

Every response has deterministic ordering, bounded item and serialized-character budgets, exact totals where practical, and explicit truncation metadata. Search and bootstrap must never return the whole memory database by default.

## 7. Backward-compatible migration policy

The existing `memories` table and its IDs are in use and must be preserved. Migration is forward-only, transactional/recoverable, and tested from empty and populated schema-v12 databases.

Initial legacy mapping proposal:

| Legacy status | New lifecycle | New epistemic state | Compatibility rule |
|---|---|---|---|
| `confirmed` | `active` | `user_asserted` | Preserve original status and all metadata; do not assume code verification merely because a human confirmed the note. |
| `proposed` | `active` | `pending_validation` | Preserve as unconfirmed candidate; do not silently promote it to verified. |
| `obsolete` | `superseded` | `pending_validation` | Preserve legacy status and original row; exclude from current recall by default. |
| `rejected` | `archived` | `pending_validation` | Preserve rejection as a legacy event/reason and exclude from ordinary recall. |

The migration must preserve each legacy row's ID, title/content/category, status, source path/hash, commit SHA, author/updater, and timestamps. A legacy version is created from the exact row contents. Rejected/obsolete entries are not deleted. Implemented v13 mapping: `confirmed` → `active/user_asserted`; `proposed` → `active/pending_validation`; `obsolete` → `superseded/pending_validation`; `rejected` → `archived/pending_validation`. Each imported identity stores the original status in `legacy_status`, and its version/fragment/event/evidence use deterministic legacy-derived IDs so a retry does not duplicate them. The old `memories` table remains intact. Legacy update/transition/delete APIs remain available with documented compatibility semantics until a separately reviewed deprecation.

## 8. MCP and agent integration

The core owns all business logic; MCP is a validated adapter. Proposed operations are `memory_bootstrap`, `memory_search`, `memory_get`, `memory_expand`, `memory_capture`, `memory_update`, `memory_correct`, `memory_history`, `memory_reconcile`, and `memory_health`.

Agent workflow:
- start: bootstrap memory, then check index/source freshness;
- investigate: search first, expand only relevant fragments, verify source when needed;
- discover: capture reusable findings as they are learned;
- correct: use correction semantics and distinguish current implementation from desired behavior;
- finish: capture verified changes, decisions, test evidence, incidents/solutions, unresolved questions, and follow-ups.

CNM cannot force an arbitrary agent to call its tools. The product can make the behavior explicit in generated `AGENTS.md`, tool descriptions, examples, and supported-client integration tests. Do not claim passive capture or automatic end-of-session hooks unless a client actually supplies those events.

### 8.1 Proposed MCP input contracts

The following are adapter-level bounds for the first implementation. They are deliberately conservative and may be tightened by implementation tests; they must not be widened without updating this contract and the acceptance criteria.

| Operation | Required inputs | Optional inputs and limits |
|---|---|---|
| `memory_bootstrap` | none | `limit` 1–20 (default 10); `maxChars` 500–8,000 (default 4,000); optional knowledge types and include-pending flag |
| `memory_search` | none; empty query means browse current high-value items | `query` up to 1,000 chars; `limit` 1–50 (default 10); `maxChars` up to 12,000; type/tag/path/symbol/epistemic/lifecycle/time filters; cursor |
| `memory_get` | `id` (1–128 chars) | optional `versionId`; optional include-evidence flag |
| `memory_expand` | `id` | `fragmentIds` 1–20 (each 1–128 chars), or a cursor; `limit` 1–20; `maxChars` up to 12,000 |
| `memory_capture` | `idempotencyKey` (1–128 chars), `items` 1–20 | Each item: title 1–240 chars; summary up to 1,000; content 1–20,000; type 1–64; epistemic state enum; optional confidence 0–1 and basis up to 500; up to 20 tags/aliases (64 chars each); up to 10 evidence items; up to 20 fragments (heading 240, summary 1,000, body 8,000 chars each). Batch is atomic. |
| `memory_update` | `id`, `expectedVersionId`, `reason` 1–1,000 chars | Partial version fields with the same per-field limits as capture; actor/origin metadata |
| `memory_correct` | `id`, `targetVersionId`, `reason` 1–1,000 chars, `correctionSource` = user/agent | Corrected title/summary/content or fragment; epistemic state; evidence; expected current version |
| `memory_history` | `knowledgeId` (1–128 chars) | `versionLimit` and `eventLimit` 1–50 (default 20); `beforeVersionNumber`; paired `beforeEventCreatedAt` / `beforeEventId` cursors |
| `memory_get` | `knowledgeId` | optional `versionId`; optional `includeEvidence` (bounded evidence metadata) |
| `memory_expand` | `knowledgeId` | optional `versionId`; `fragmentIds` 1–20 or `beforeOrdinal`; `limit` 1–20; `maxChars` 500–12,000 |
| `memory_reconcile` | none | Current preview: `limit` 1–100; strictly read-only. Proposed first apply operation: `request_review` only, with explicit IDs and expected versions, dry-run default true, project-scoped idempotency, append-only events, all-or-nothing transaction, and recovery guarantees per the apply design |
| `memory_health` | none | `limit` 1–100; include bounded source freshness/conflict samples |

All string fields are trimmed and validated; required text cannot be blank. Paths must be project-relative and pass the existing safe-file/path policy. Evidence metadata must be structured and bounded; raw source contents, secrets, arbitrary binary data, and full conversation transcripts are not accepted. Batch capture is all-or-nothing and uses one idempotency key scoped to the project and operation.

### 8.2 Response and error contract

Every list/search/bootstrap/history/reconcile/health response includes a stable ordering rule, returned count, total when safely computable, applied limit, and an explicit truncation indicator. Character budgets apply to the serialized response, not only to individual content fields. Pagination cursors are opaque, deterministic for a stable database snapshot, and bound to the query/filter set. `memory_history` accepts `maxChars` from 500 to 12,000 (default 12,000), measures compact serialized JSON, and reports `serializedChars`, exact version/event totals, `truncated`, and per-stream budget-omitted counts. Its version and event cursors remain independent; history payloads are never field-truncated or rewritten.

Structured errors use stable codes: `invalid_input`, `not_found`, `version_conflict`, `idempotency_conflict`, `limit_exceeded`, `stale_evidence`, and `integrity_error`. Error messages are actionable but must not expose absolute local paths, source contents, credentials, or database internals. A version conflict returns the current version identifier without overwriting either writer's data.

## 9. Implementation sequence and gates

1. **Contract (this document):** settle semantics, authority, migration mapping, idempotency, bounds, and compatibility.
2. **Schema/history:** add normalized identity/version/fragment/evidence/relation/event storage and transactional migration. v13 DDL/backfill is merged to main (PR #137, merge `c1abe4160ff7a5c9503e42901b2c6e4e21476778`). Current-version ownership is constrained by a composite foreign key; triggers enforce immutable versions/fragments and append-only evidence/events. Post-merge CI run `41729315788` passed all five jobs (verify Ubuntu/Windows; benchmark Ubuntu/Windows/macOS). The broader older-schema upgrade, crash/reopen, invalid-data, FTS-integrity, and query-plan matrix remains open.
3. **Core operations (partially implemented):** bounded `memory_capture` (PR #138), optimistic immutable `memory_update` (PR #139), and provenance-aware selective `memory_correct` (PR #140) are merged. Broader matching, full lifecycle transition policy, idempotent updates, independent-connection race tests, and failure-injection rollback tests remain open.
4. **History slice:** `memory_history` is merged in PR #141 with project-scoped, bounded version/event pagination.
5. **Focused retrieval:** `memory_get` and `memory_expand` are merged in PR #142 (`b83fdcd87a14c9165b15e15f6126415b4c6b5bcc`); both are project-scoped and bounded, with fragment bodies retrieved separately from identity/version metadata.
6. **Search/bootstrap (merged, PR #144):** `memory_search` and `memory_bootstrap` are on main (merge `b9ec6802a5646ee9ed1abd5f5717fc91be4ff9a5`; CI `41795181023`). Search uses a lazy schema-v14 FTS5 index with backfill/update trigger, empty-query high-value browse, exact identity/source ranking, type/tag/path/symbol/epistemic/lifecycle/time/relation filters, bounded candidate windows, and snapshot-bound cursors. Bootstrap returns bounded high-value knowledge, risks/questions, and pending validation with type/include-pending filters and explicit freshness limits. Five E1 behaviors are accepted; multilingual/basic-normalization, wildcard, repeated-run, ambiguous-query, and exact-boundary tests remain open. Source-evidence freshness is reported as not checked, not inferred from code-index freshness.
7. **Health/reconciliation and impact:** `memory_health` is merged to `main` (PR #146). The merged PR #147 implementation adds a strictly read-only preview for sampled stale evidence, exact normalized-title duplicate candidates, contradictions, orphan relations, and related dependent-review candidates. It does not repair, merge, archive, or delete. Mutating reconciliation, idempotency/recovery, and a durable dependent-review workflow remain future work; never silently rewrite dependent items.
8. **MCP/workflow and evaluation:** continue agent integration, preserve compatibility, and run repeatable reuse, correction, source-change, broad retrieval, and cross-session scenarios against a control.

No phase is complete because a tool name or schema exists. Completion requires focused tests, migration evidence, clean-checkout CI, reviewed diffs, and measured acceptance results.

## 10. Explicit non-goals and deferred work

- Passive interception of all model conversations or hidden chain-of-thought.
- Automatic storage of every message or transient action.
- Mandatory cloud/team/device synchronization.
- Mandatory embeddings, vector databases, external LLMs, or hosted APIs.
- Training or modifying model weights.
- Automatic destructive merging of ambiguous or contradictory knowledge.
- Claiming cross-worktree sharing without an explicit, tested project-identity linking design.


## 2026-11-04 implementation verification addendum

PR #164 is merged to `main` as `f9ff199321ce240c052a431ed0897b5196004d79`; CI run `41934624316` passed all five jobs. Its rollback-injection tests for `memory_update` and `memory_correct` compare before/after snapshots of queried knowledge pointers, versions, fragments, evidence, and events after an immutable-version insert failure. This is targeted failure coverage, not a complete failure matrix.

PR #165 (`test/memory-update-correct-cross-process-contention`) adds independent-process SQLite writer-lock tests for update and correction. The intended acceptance is no writes on lock failure followed by a successful retry after lock release. Treat this slice as pending until Ubuntu and Windows CI pass. Neither PR establishes simultaneous same-identity writer scheduling or physical power-loss durability.


## 2026-11-05 implementation verification addendum

PR #164 rollback-injection tests are merged; CI run `41934624316` passed all five jobs. They compare queried snapshots of knowledge pointers, versions, fragments, evidence, and events after an immutable-version insert failure.

PR #165 is merged as `c7a82bfe2d141433a1bc57e24842b729dec903e3`; CI run `41939068928` passed all five jobs. It verifies independent-process write-lock failure without writes and successful retry for both `memory_update` and `memory_correct`, and includes the oversized-event `memory_history` cursor correction and migration rollback/retry test.

PR #168 is merged as `96da869dcd198bccd7b6e6cce1ed67ceb6a4ee88`; exact-head CI run `41991378215` passed all five jobs. It verifies simultaneous same-identity `memory_update` writers produce one update and one stale conflict without extra versions/events. The initially failing PR #167 is closed as superseded by #168.

The active follow-up branch `test/memory-correct-same-identity-races` adds same-identity simultaneous `memory_correct` coverage and a mixed `memory_update`/`memory_correct` writer race. Until its fresh Ubuntu/Windows and benchmark CI passes and it is merged, those two concurrency cases remain unverified. None of these tests establishes physical power-loss/controller/filesystem durability; keep that acceptance item open.


## 2026-11-05 — verification status after #169

PR #169 is merged as `d5cdb6cdca88f1f41211ae9fa2c85dc837f1d1ca`; exact-head CI `41997492219` passed all five jobs. Same-identity correction/correction and mixed update/correction writers now have cross-process race coverage; prior update/update coverage is in #168 and lock-contention/retry coverage is in #165.

PR #170's original stacked branch passed exact-head CI `41998827170` (five jobs) after the deterministic SQL-ordering correction. Its branch is being reconstructed on current `main` to exclude already-integrated #169 commits and avoid duplicate diffs. The pending slice still covers legacy status preservation (including unknown status retained as `pending_validation`), file-backed v13 transaction rollback after close/reopen/retry, and schema-v14 FTS5 integrity/bookkeeping after repeated opens. Require fresh CI on the rebased exact head before merging.

Remaining migration gaps: all supported historical schema snapshots, ID collisions/duplicates, additional interruption boundaries, FTS rebuild failure recovery and query-plan validation. Neither SQLite `integrity_check` nor FTS5 `integrity-check` proves physical power-loss durability.

PR #170 is now based directly on current `main` after PR #169's squash merge `d5cdb6cdca88f1f41211ae9fa2c85dc837f1d1ca`. Its diff is limited to the migration/FTS tests and four tracking documents. The prior stacked branch passed run `41998827170`; that run does not certify the rebased head, which still requires a new exact-head CI run.


## 2026-11-05 — FTS retrieval integrity

The active branch `fix/search-fail-closed-on-fts-drift` adds a fail-closed consistency gate to `memory_search`: one FTS row and one indexed-version marker must exist for each knowledge version, with no orphan/duplicate/ownership-mismatched rows. It prevents returning incomplete retrieval output while the index is known inconsistent. The lazy initializer can restore a missing marker when an FTS row already exists, but does not regenerate a missing FTS row automatically. Health remains read-only and the inconsistency stays visible for explicit future repair design. This change is pending cross-platform CI.


## 2026-11-05 — FTS retrieval merge and historical migration rebase

PR #173 is merged as `2f05249b9d71e9851190f01e72ade778d2cc5d77`; exact-head CI run `42017503161` passed all five jobs. The FTS5 fail-closed consistency gate and marker-only retry are now part of `main`.

PR #171's current work is being reconstructed on the new main to avoid documentation conflicts introduced by #173. Its migration implementation/test remains focused on populated v1 snapshots, stable-ID uniqueness under normalized/unrelated collisions, interrupted v5 backfill repair, and preservation/FK/integrity assertions. The rebased HEAD needs its own fresh five-job CI before merge.


## 2026-11-05 — PR #171 verification status

The populated schema-v1 snapshot and retry-safe normalized-path stable-ID repair are under PR #171, exact head `d13ea31549b4e7793266eb9ada4d054696ce5026`, based on main `2f05249b9d71e9851190f01e72ade778d2cc5d77`. Exact-head CI run `42018977502` passed all five jobs (Ubuntu/Windows verification and Ubuntu/Windows/macOS benchmarks); independent run `42018940167` also passed all five. No open review threads were found. This is still PR-level evidence, not merged behavior; do not mark it implemented until merge and post-merge verification.

PR #172 is closed as superseded by #171. Historical-schema coverage beyond the populated v1 fixture, malformed records, further interrupted migration boundaries, FTS rebuild recovery/query-plan validation, and physical power-loss durability remain open.


## Implementation verification note — 2026-11-05

PR #171's populated schema-v1 migration snapshot and deterministic stable-ID collision/retry repair are merged to `main` as `9b24daa5e3e76ac21ccae3015d892cf2fa7afe26`. Exact-head CI run `42019978734` passed all five jobs. This is implementation evidence for the covered v1 and v5-retry cases only; it is not evidence that every historical schema generation, malformed legacy input, interruption boundary, FTS recovery path, or physical durability scenario has been verified. The implementation checklist remains the authoritative ledger for remaining acceptance work.


## 2026-11-05 — Migration compatibility verification update

PR #177 adds the populated schema-v8 snapshot to `main` (merge `3c3a3e8a6e1497f846c5661c7fe864081005a3f0`; exact-head CI `42032100779`, all five jobs green). The populated snapshot matrix now includes v1, v6, v8 and v10 entry points. The v8 case validates FTS/import/call/heritage/relation/unresolved-import data and legacy evidence through v13. It is in-memory and does not establish reopen recovery. A first CI run caught an incorrect expectation that a pre-v5 symbol stable ID would survive; the corrected test reflects deterministic v5 symbol-ID recomputation while preserving source-field, hash-format, integrity and repeat-stability assertions. The master checklist remains the authoritative source for remaining supported generations, malformed legacy data, additional interruption boundaries and FTS recovery/query plans.
