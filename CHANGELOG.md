# Changelog\n\n## Unreleased\n\n- Add bounded directory-boundary component maps with cross-directory import counts and directed shortest dependency distances.

## Unreleased

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
