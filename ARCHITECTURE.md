# Architecture

## Runtime shape

CNM v0.1 is a single-process Node.js application. The CLI coordinates the application services; the core does not depend on MCP or a model provider.

```text
CLI ──> Application/Core ──> SQLite
             │                 ├── project metadata
             │                 ├── files and symbols
             │                 ├── imports and calls
             │                 ├── relations
             │                 ├── memories
             │                 └── FTS5 index
             └── MCP adapter (stdio, read-only tools)
```

## Local storage

Each repository is assigned an ID derived from its canonical local path. Its SQLite database is written under the operating system's per-user application data directory. Nothing is written into the target repository by default.

Project identity remains derived from the canonical worktree path. Each Git worktree therefore receives a separate CNM project ID and local database; moving a repository changes its ID. Opening a submodule directly resolves that submodule as its own project, but the parent indexer does not yet enforce nested-submodule isolation. These boundaries are documented behavior, not shared Git-common-directory identity.

## Indexing pipeline

1. Discover supported files while respecting `.gitignore` and built-in exclusions.
2. Skip symlinks and files larger than the configured safety limit.
3. Hash file content with SHA-256.
4. Skip unchanged files unless `--force` is supplied.
5. Parse changed files with the TypeScript compiler API.
6. Persist symbols and import/call facts.
7. Rebuild currently resolvable graph edges.
8. Update project index timestamp.

The TypeScript compiler API is used for the first implementation because it provides a mature, cross-platform parser for JavaScript and TypeScript. Parser adapters keep the engine open to Tree-sitter or additional language parsers later without making native Tree-sitter builds a prerequisite for the first release.

## Knowledge model

- Files are source artifacts.
- Symbols are declarations extracted from those artifacts.
- Relations are typed, directed edges between files or symbols.
- Memories are explicit project notes or decisions entered by a developer.
- FTS5 is a lexical index over symbols and signatures.

Inferred edges carry provenance and confidence. A confirmed memory is separate from an inference extracted from syntax.

## Retrieval

The task-context builder accepts a natural-language task and returns deterministic, bounded candidates from lexical symbol search, indexed file details and graph relations, local memories, and test-path matches. Each candidate includes explainable ranking signals and source references; memory lifecycle and source freshness warnings remain explicit. The retrieval layer provides deterministic lexical symbol search with exact/name/signature/export ranking signals, source paths and line ranges; file/import maps; incoming and outgoing symbol relations; bounded direct and transitive dependency traversal; bounded file details; reverse-import impact analysis; and read-only index freshness inspection. Dependency results carry provenance, confidence, index revision, depth, the full file chain, and evidence for every edge in that chain. File-detail collections expose per-collection limits, total counts, and truncation flags. SQL LIKE fallback treats percent, underscore, and backslash as literal query characters. Retrieval remains lexical and structural: it does not claim semantic understanding or retrieve conceptual components.

## MCP boundary

MCP exposes ten read-only tools through the TypeScript SDK v2 and stdio transport:

- `project_overview` — local repository/index summary.
- `index_freshness` — read-only source-file and Git commit/branch/working-tree versus index freshness report.
- `project_map` — indexed files and locally resolved imports.
- `symbol_lookup` — bounded lexical symbol search with ranking signals.
- `dependency_graph` — bounded direct/transitive import traversal with edge evidence.
- `file_details` — bounded indexed file metadata, symbols, imports, and relations.
- `change_impact` — bounded reverse-import impact traversal.
- `task_context` — deterministic, bounded task-oriented context from indexed facts and memories.
- `memory_freshness` — source-file freshness inspection for linked memories.
- `memory_recall` — bounded retrieval of non-rejected memories with lifecycle labels.

The server registration in `src/adapters/mcp/server.ts` is the source of truth for this inventory. Tool schemas, defaults, adapter-level limits, core mappings, project binding, and protocol validation evidence are recorded in [`docs/PHASE_6_MCP_CONTRACT.md`](docs/PHASE_6_MCP_CONTRACT.md). Adapter tests verify all ten valid calls, Zod-invalid arguments, core errors, repeat calls, EOF/reconnection, and two-project process isolation. Real OpenCode and VS Code/Copilot calls are documented in [`docs/CLIENT_INTEGRATION.md`](docs/CLIENT_INTEGRATION.md); the exact Copilot extension identifier/version remains unverified. Search, graph traversal, file details, task context, and memory recall validate and bound their inputs/results. Memory creation and index mutation remain CLI operations, keeping an agent from silently changing durable project knowledge. `component_get`, `decision_lookup`, and a tool named `project_context` are not currently registered; task-oriented context is exposed as `task_context`.

## Deliberate non-goals for v0.1

- No cloud service or synchronization protocol.
- No embedding model or vector database requirement.
- No training, fine-tuning, or model-weight modification.
- No automatic semantic claims presented as confirmed project rules.
- No direct source-code editing.
