# Changelog

## Unreleased

- Harden event-only `request_review` in MCP `memory_reconcile` (PR #150, merge `2279edd954bdeedea2c7cd9d1e5d014c05eccb24`; CI `41827470581`, all five jobs green). Enforces a 12,000-character serialized response budget with explicit truncation metadata and records up to 20 related evidence IDs and 20 project-scoped relation IDs per event, with truncation flags. Knowledge, evidence, and relation records remain unchanged. Remaining verification: independent-connection race handling, post-commit crash/retry, and append-only/preservation assertions.

- Add event-only `request_review` apply mode to MCP `memory_reconcile` (PR #149, merge `db7ef0af725f81a1d70fe32a78a3cd203083f9f0`; CI `41825667650`, all five jobs green). Dry-run remains the default; explicit apply validates project-scoped knowledge IDs and expected versions, appends audit events atomically with idempotency results, and supports safe replay/conflict detection. It does not alter knowledge content, versions, lifecycle, evidence, or relations. Follow-up PR #150 adds response-size enforcement and source evidence/relation references; independent-connection concurrency and crash-recovery coverage remain open.

- Add bounded `memory_health` integrity and source-evidence freshness reporting through MCP (PR #146, merged); reconciliation/repair remains separate.

- Add FTS5-backed versioned memory search and compact agent bootstrap through MCP (PR #144, merged). Search supports empty-query high-value browse, lexical matching, type/tag/path/symbol and epistemic/lifecycle/time/relation filters, exact-locator ranking, snapshot-bound cursors, and explicit candidate/character truncation. Bootstrap groups high-value knowledge, open risks/questions, and pending validation with contract-aligned item/character bounds, type/include-pending filters, and explicit freshness limits.

- Document the autonomous-memory agent handoff and current implementation snapshot; clarify the master checklist as the canonical progress ledger and align agent guidance with versioned capture/update/correction/retrieval APIs. No runtime behavior changed.

- Add a bounded MCP `git_history` tool exposing recent commit metadata and changed-path evidence, capped at 50 commits/500 paths and a 3-second Git command timeout. Explicitly distinguish commit history from agent-session boundaries and inferred intent.

- Add bounded selective reindexing by project-relative file/directory paths and include globs, with file/traversal budgets exposed through CLI and MCP. Partial scans report truncation and preserve all indexed files outside their scope. Stream directory enumeration within traversal budgets, reduce Git snapshot subprocesses, and avoid rebuilding the global relationship graph when source and relationship configuration fingerprints are unchanged.

- Add bounded directory-boundary component maps with cross-directory import counts and directed shortest dependency distances.

- Preserve bounded multiline TypeScript/JavaScript declaration headers in indexed symbol signatures; keep implementation bodies available only through bounded source retrieval.
- Add freshness warnings to all indexed MCP reads, with optional strict refusal and guarded incremental auto-update.
- Add bounded inline source snippets to `symbol_lookup` and `file_details`, including independent source/index hashes.
- Add explicit path/symbol anchors and origin labels to `task_context` to suppress broad fallback noise.
- Add a reusable MCP-first agent workflow covering freshness, retrieval, verification, and proposed-memory review.
- Retain the existing exact-path and old/new SHA-256 `index_freshness` report; no duplicate freshness tool was added.

## Previous unreleased changes

- Add MCP `index_update` for incremental working-tree reconciliation while preserving persisted exclusion rules.
- Add MCP `memory_propose` for agent-authored suggestions that remain `proposed` until explicit human confirmation.
- Add optional `symbol_lookup` filters for symbol kind, project-relative file path prefix, and export status.
- Harden lexical LIKE fallback by escaping wildcard characters.
- Add provenance, confidence, and index revision for every edge in transitive dependency chains.
- Bound file-detail collections across core, CLI, and MCP, with totals and truncation reporting.
- Expand labeled lexical retrieval relevance coverage from three to ten queries.
- Synchronize architecture, product specification, roadmap, and acceptance criteria with the implemented retrieval surface.

## 0.1.0 — Initial development baseline

- Add local project identity and per-user SQLite storage.
- Add JavaScript/TypeScript AST indexing.
- Add incremental file hashing and index updates.
- Add symbol search, project map, and reverse-import impact analysis.
- Add explicit local project memories.
- Add MCP stdio retrieval tools.
