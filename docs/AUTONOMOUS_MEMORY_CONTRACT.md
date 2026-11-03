# Autonomous Memory Contract v2

**Status:** Approved implementation contract for the autonomous-memory workstream; implementation is not implied by this document.  
**Baseline:** `main` at `8ffbc71109ab165f857bc5ef5393331f17130b53` (2026-11-03).  
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

`memory_update` appends a version to a known identity. It accepts an expected current version for optimistic concurrency, a reason, actor/origin, and any new evidence. A mismatch returns a structured conflict instead of overwriting concurrent work. No-op updates create no version.

### 5.3 Correction

`memory_correct` records which claim/version is being corrected, the replacement or corrected fragment, correction reason, and correction source (`user` or `agent`). It appends a version and explicit correction event/relation. The previous version remains retrievable.

A user correction is captured without asking for confirmation again. The agent must still interpret the correction and label it correctly:
- correction of a current implementation claim -> record the user assertion and mark the implementation claim pending validation if it conflicts with source/tests;
- desired future behavior -> create/update a linked `planned` decision, not a claim that code already behaves that way;
- verified implementation change -> record the new behavior as verified only after relevant source/tests support it.

Dependent knowledge is marked for review through bounded impact discovery; CNM must not blindly rewrite all related entries.

### 5.4 Reconciliation

Reconciliation is bounded, deterministic, and reportable. It can identify stale evidence, duplicate candidates, contradictions, orphan relations, and dependent entries requiring review. Broad or destructive actions must support dry-run/reporting. Source changes never justify deleting knowledge by themselves.

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
| `proposed` | `active` | `inferred` or `pending_validation` | Preserve as unconfirmed candidate; do not silently promote it to verified. |
| `obsolete` | `superseded` | Preserve best available epistemic classification; otherwise `pending_validation` | Keep visible in history, excluded from current recall by default. |
| `rejected` | `archived` | `pending_validation` | Preserve rejection as a legacy event/reason and exclude from ordinary recall. |

The final migration must preserve each legacy row's ID, title/content/category, status, source path/hash, commit SHA, author/updater, and timestamps. A legacy version is created from the exact row contents. Rejected/obsolete entries are not deleted. Legacy update/transition/delete APIs remain available with documented compatibility semantics until a separately reviewed deprecation.

## 8. MCP and agent integration

The core owns all business logic; MCP is a validated adapter. Proposed operations are `memory_bootstrap`, `memory_search`, `memory_get`, `memory_expand`, `memory_capture`, `memory_update`, `memory_correct`, `memory_history`, `memory_reconcile`, and `memory_health`.

Agent workflow:
- start: bootstrap memory, then check index/source freshness;
- investigate: search first, expand only relevant fragments, verify source when needed;
- discover: capture reusable findings as they are learned;
- correct: use correction semantics and distinguish current implementation from desired behavior;
- finish: capture verified changes, decisions, test evidence, incidents/solutions, unresolved questions, and follow-ups.

CNM cannot force an arbitrary agent to call its tools. The product can make the behavior explicit in generated `AGENTS.md`, tool descriptions, examples, and supported-client integration tests. Do not claim passive capture or automatic end-of-session hooks unless a client actually supplies those events.

## 9. Implementation sequence and gates

1. **Contract (this document):** settle semantics, authority, migration mapping, idempotency, bounds, and compatibility.
2. **Schema/history:** add normalized identity/version/fragment/evidence/relation/event storage and transactional migration.
3. **Core operations:** implement capture, update, correction, history, and reconciliation with deterministic matching and concurrency control.
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
