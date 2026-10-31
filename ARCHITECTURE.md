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

This path-derived identity is intentionally simple for the first milestone. A future migration can add explicit project identity files or Git common-directory identity to handle moves and worktrees more elegantly.

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

The current retrieval layer provides lexical symbol lookup, a file/import map, and transitive reverse-import impact analysis. Later stages can combine these with semantic ranking, task-specific graph traversal, token budgets, and freshness scoring.

## MCP boundary

MCP exposes read-only tools in v0.1 through the current TypeScript SDK v2 and stdio transport. Memory creation and index mutation remain CLI operations, keeping an agent from silently changing durable project knowledge.

## Deliberate non-goals for v0.1

- No cloud service or synchronization protocol.
- No embedding model or vector database requirement.
- No training, fine-tuning, or model-weight modification.
- No automatic semantic claims presented as confirmed project rules.
- No direct source-code editing.
