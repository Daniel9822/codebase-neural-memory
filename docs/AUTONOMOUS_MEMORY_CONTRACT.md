# Autonomous Memory Contract v2

**Status:** Approved implementation contract. Schema v13 migration is under implementation; core operations, retrieval, MCP integration, and agent workflow remain unimplemented until their own tests and PRs pass.  
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

`memory_update` appends a version to a known identity. It requires `knowledgeId`, `expectedVersionId`, and a non-empty change `reason`; actor is optional. Mutable knowledge fields are partial: omitted title/summary/content/epistemic state/confidence/tags/aliases/fragments inherit from the current version. A supplied content body replaces the primary fragment; supplied fragments replace the prior fragment set (and are preceded by the primary content fragment when content is supplied). Existing evidence is carried forward into the new version and newly supplied evidence is appended. The identity's current-version pointer and metadata update in the same transaction as the new immutable version, fragments, evidence, and `updated` event. A stale expected version returns a structured `conflict` with the actual current version and performs no write. An unchanged effective payload returns `no_op` and creates no version/event. The original version and its author/evidence remain intact. Current implementation is `src/core/memory-update.ts`, exposed as MCP `memory_update`; core and protocol regression tests cover append/history preservation, stale conflict, no-op, confidence rationale, and project isolation. Failure-injection and independent-connection race tests remain outstanding.

### 5.3 Correction

`memory_correct` records which claim/version is being corrected, the replacement or corrected fragment, correction reason, and correction source (`user` or `agent`). It appends a version and explicit correction event/relation. The previous version remains retrievable.

A user correction is captured without asking for confirmation again. The agent must still interpret the correction and label it correctly:
- correction of a current implementation claim -> record the user assertion and mark the implementation claim pending validation if it conflicts with source/tests;
- desired future behavior -> create/update a linked `planned` decision, not a claim that code already behaves that way;
- verified implementation change -> record the new behavior as verified only after relevant source/tests support it.

Dependent knowledge is marked for review through bounded impact discovery; CNM must not blindly rewrite all related entries.

### 5.4 Reconciliation

Reconciliation is bounded, deterministic, and reportable. It can identify stale evidence, duplicate candidates, contradictions, orphan relations, and dependent entries requiring review. Broad or destructive actions must support dry-run/reporting. Source changes never justify deleting knowledge by themselves. Version and event history has no automatic time-based deletion in the initial implementation; any future pruning policy must be explicit, auditable, recoverable, and must preserve the latest version and required provenance. History queries remain bounded and paginated.

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
| `memory_history` | `id` | `limit` 1–100; cursor; optional event/version filters |
| `memory_reconcile` | none | `dryRun` default true; selected IDs or scope; `limit` 1–100; explicit operation kinds |
| `memory_health` | none | `limit` 1–100; include bounded source freshness/conflict samples |

All string fields are trimmed and validated; required text cannot be blank. Paths must be project-relative and pass the existing safe-file/path policy. Evidence metadata must be structured and bounded; raw source contents, secrets, arbitrary binary data, and full conversation transcripts are not accepted. Batch capture is all-or-nothing and uses one idempotency key scoped to the project and operation.

### 8.2 Response and error contract

Every list/search/bootstrap/history/reconcile/health response includes a stable ordering rule, returned count, total when safely computable, applied limit, and an explicit truncation indicator. Character budgets apply to the serialized response, not only to individual content fields. Pagination cursors are opaque, deterministic for a stable database snapshot, and bound to the query/filter set.

Structured errors use stable codes: `invalid_input`, `not_found`, `version_conflict`, `idempotency_conflict`, `limit_exceeded`, `stale_evidence`, and `integrity_error`. Error messages are actionable but must not expose absolute local paths, source contents, credentials, or database internals. A version conflict returns the current version identifier without overwriting either writer's data.

## 9. Implementation sequence and gates

1. **Contract (this document):** settle semantics, authority, migration mapping, idempotency, bounds, and compatibility.
2. **Schema/history:** add normalized identity/version/fragment/evidence/relation/event storage and transactional migration. v13 DDL/backfill is merged to main (PR #137, merge `c1abe4160ff7a5c9503e42901b2c6e4e21476778`). Current-version ownership is constrained by a composite foreign key; triggers enforce immutable versions/fragments and append-only evidence/events. Post-merge CI run `41729315788` passed all five jobs (verify Ubuntu/Windows; benchmark Ubuntu/Windows/macOS). The broader older-schema upgrade, crash/reopen, invalid-data, FTS-integrity, and query-plan matrix remains open.
3. **Core operations:** initial bounded `memory_capture` core/MCP slice is implemented on branch `feat/memory-capture-core`; update, correction, history, reconciliation, broader matching, and concurrency control remain future steps.
4. **Retrieval:** implement bootstrap/search/get/expand/health with bounded FTS5 retrieval and source freshness.
5. **MCP/workflow:** expose tools, preserve compatibility, update generated instructions and documentation, and verify supported clients.
6. **Evaluation:** run repeatable reuse, correction, source-change, broad retrieval, and cross-session scenarios against a control.

No phase is complete because a tool name or schema exists. Completion requires focused tests, migration evidence, clean-checkout CI, reviewed diffs, and measured acceptance results.

## 10. Explicit non-goals and deferred work

- Passive interception of all model conversations or hidden chain-of-thought.
- Automatic storage of every message or transient action.
- Mandatory cloud/team/device synchronization.
- Mandatory embeddings, vector databases, external LLMs, or hosted APIs.
- Training or modifying model weights.
- Automatic destructive merging of ambiguous or contradictory knowledge.
- Claiming cross-worktree sharing without an explicit, tested project-identity linking design.
