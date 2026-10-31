# Changelog

## Unreleased

- Hardened lexical LIKE fallback by escaping wildcard characters.
- Added provenance, confidence, and index revision for every edge in transitive dependency chains.
- Bounded file-detail collections across core, CLI, and MCP, with totals and truncation reporting.
- Expanded labeled lexical retrieval relevance coverage from three to ten queries.
- Updated architecture, product specification, roadmap, and acceptance criteria to match the implemented retrieval surface; explicitly deferred conceptual component retrieval.

## 0.1.0 — Initial development baseline

- Added local project identity and per-user SQLite storage.
- Added JavaScript/TypeScript AST indexing.
- Added incremental file hashing and index updates.
- Added symbol search, project map, and reverse-import impact analysis.
- Added explicit local project memories.
- Added read-only MCP tools over stdio.
