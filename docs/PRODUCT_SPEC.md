# Product Specification

**Product:** Codebase Neural Memory (CNM)  
**CLI command:** `cnm`  
**Repository:** `Daniel9822/codebase-neural-memory`  
**Document status:** Product baseline for the v0.x development line  
**Last reviewed:** 2026-10-31

## 1. Purpose

Codebase Neural Memory is a local-first memory and code-intelligence engine for software repositories. It builds a persistent, queryable representation of a codebase so developers and coding agents can discover relevant files, symbols, dependencies, decisions, and tests without repeatedly exploring the entire repository.

CNM is an external memory system. It does not train models, change model weights, or inject data into a model's hidden layers. Agents consume its results through explicit tool calls, initially using the Model Context Protocol (MCP).

The source repository remains the source of truth. CNM stores derived indexes and separately authored project knowledge; its memory must be refreshable from source and must not be presented as authoritative when stale.

## 2. Problem

Coding agents often rediscover the same architecture and business rules across sessions. A repository can contain many files and dependencies, while a task usually concerns only a small subset. Supplying the whole repository or large documents wastes context and can obscure important relationships.

CNM addresses this by:
- indexing source structure;
- recording explicit relationships between code entities;
- retaining human-confirmed project knowledge;
- retrieving task-relevant context with source references; and
- keeping the memory persistent across agent sessions.

The product must provide measurable value rather than assume that adding a graph or embeddings automatically improves an agent.

## 3. Target users and primary workflow

Primary users are individual software developers using local coding agents or IDE tools. The first release is optimized for an individual workstation and one local repository at a time.

Expected workflow:

1. Install CNM as a CLI.
2. Run `cnm init` inside a repository.
3. Run `cnm index` to build the initial local index.
4. Inspect it using `cnm status`, `cnm map`, `cnm search`, `cnm explain`, `cnm relations`, `cnm dependencies`, `cnm file`, `cnm impact`, and `cnm freshness`.
5. Store explicit project knowledge with `cnm remember`.
6. Connect a compatible coding agent through the local MCP stdio server.
7. Let the agent retrieve only the information relevant to its current task.

## 4. Product principles and non-negotiable constraints

1. **Local-first and private by default.** Indexes and memories are stored on the user's machine. CNM must not transmit source code or memory data to a remote service in the initial release.
2. **No model dependency.** Indexing, search, graph traversal, and memory operations must work without an LLM, GPU, embedding model, or paid API.
3. **Agent-agnostic core.** The core must not depend on OpenCode, Claude Code, or a specific model provider. MCP is an adapter, not the engine.
4. **Source of truth.** Source files and tests outrank derived memory. Every derived fact should be traceable to its source and index revision where applicable.
5. **Evidence over guesses.** Distinguish syntax-derived facts, inferred relationships, and human-confirmed decisions. Do not promote an inference to a confirmed rule.
6. **Incremental but recoverable.** Normal updates should avoid reprocessing unchanged files, while a full rebuild must be available.
7. **Safe by default.** Do not modify project source files, Git configuration, or .gitignore during initialization. Do not silently write durable knowledge from an agent tool call.
8. **Portable and lightweight.** The first release should run on ordinary Windows, macOS, and Linux development machines without external infrastructure.
9. **Explainable retrieval.** Results should include why they were selected and where they came from.

## 5. Version 0.x scope

### Included in the initial development line

- Local CLI and per-user project storage.
- SQLite persistence and FTS5 lexical search.
- JavaScript and TypeScript source parsing.
- File discovery, exclusions, content hashing, and incremental indexing.
- Symbol extraction for supported declarations.
- Import and locally resolvable dependency information.
- A graph data model for typed relationships.
- Local project notes and decisions explicitly entered by the developer.
- Structural and textual retrieval.
- An MCP stdio adapter with read/retrieval tools, incremental index reconciliation, and proposed-only memory creation.
- Tests, diagnostics, and documentation.

### Explicitly out of scope for the first stable release

- Cloud accounts, hosted services, telemetry, or mandatory network calls.
- Multi-user synchronization or a shared team memory.
- Desktop GUI.
- Model training, fine-tuning, or model-weight modification.
- Mandatory embeddings or a vector database.
- Mandatory GPU, Ollama, or a particular LLM.
- Automatic source-code edits.
- Claims of complete understanding of arbitrary languages or runtime behavior.

Embeddings and semantic retrieval may be evaluated as optional extensions after structural and lexical retrieval have measurable baselines.

## 6. Current implementation baseline

The repository currently documents and contains an initial JavaScript/TypeScript implementation. The following is an inventory, not a claim that every behavior has passed acceptance testing:

- CLI commands: init, index, status, map, search, explain, relations, impact, dependencies, file, freshness, remember, memories, and mcp.
- SQLite storage outside the target repository in the operating system's per-user data directory.
- TypeScript compiler API for parsing JavaScript/TypeScript files.
- File hashing to skip unchanged files on later indexing runs.
- Extraction of functions, classes, methods, interfaces, type aliases, enums, and imports.
- Local call facts and conservative import relationships, including provenance, confidence, and index revision.
- Deterministic lexical symbol ranking over exact names, name terms, signature terms, export status, and FTS5 BM25, with a safely escaped LIKE fallback.
- Project map, incoming/outgoing symbol relations, direct/transitive dependency traversal with per-edge chain evidence and explicit limits, and reverse-import impact lookup.
- Bounded file details with source metadata, symbols, resolved/unresolved imports, relations, per-collection totals, and truncation flags.
- Read-only source and Git freshness reports: `cnm freshness` / `index_freshness` record indexed commit/branch and working-tree state; `cnm memory freshness` / `memory_freshness` compare memory commit references with current Git ancestry and file fingerprints. These checks do not change memory lifecycle state. Reconciliation uses deterministic scans; no background watcher is implemented.
- Explicit local memories, currently saved as confirmed records by the CLI.
- MCP tools registered in `src/adapters/mcp/server.ts` (13): `project_overview`, `index_freshness`, `index_update`, `project_map`, `symbol_lookup`, `dependency_graph`, `file_details`, `source_excerpt`, `change_impact`, `task_context`, `memory_freshness`, `memory_propose`, and `memory_recall`.
- MCP input schemas, adapter defaults and hard bounds, core-operation mappings, project binding, and known verification gaps are specified in [`docs/PHASE_6_MCP_CONTRACT.md`](PHASE_6_MCP_CONTRACT.md). Workspace-scoped OpenCode and VS Code setup templates and a real-client verification runbook are provided in [`docs/CLIENT_INTEGRATION.md`](CLIENT_INTEGRATION.md); both clients have completed manual `project_overview` and `symbol_lookup` calls against the local CNM repository. Recorded versions are VS Code 1.144.0 (x64), OpenCode 1.19.5, and Node.js v22.12.0. The validated VS Code installation provides the integrated GitHub Copilot Agent experience; no separate extension version is tracked.

Known limitations in this baseline include conservative import resolution, same-file/local call resolution, simple memory lifecycle, path-derived project identity, no conceptual component extraction/retrieval, initial synthetic and cross-platform real-CNM-repository performance baselines now exist; additional independent repositories, broader relevance judgments, and controlled agent-task comparisons remain pending, and lack of semantic embeddings, automatic file watching, advanced Git history analysis, and multi-developer synchronization.

`task_context` is the registered task-oriented context tool; `project_context` is not a separate registered tool. `component_get` and `decision_lookup` are not registered in the current server. The source code and tests must be inspected before treating this inventory as verified behavior.

## 7. Architecture direction

CNM is a single-process Node.js application with modular boundaries:

- **CLI:** user-facing commands and configuration.
- **Application layer:** coordinates use cases and validation.
- **Project/indexing:** discovers files and tracks index state.
- **Parser adapters:** convert language syntax into a common representation.
- **Knowledge engine:** stores nodes and typed relationships with provenance.
- **Memory engine:** stores explicitly authored project knowledge and its lifecycle.
- **Retrieval engine:** combines lexical search and structural graph traversal.
- **Context builder:** selects, ranks, budgets, and explains task-relevant results.
- **Storage layer:** SQLite, FTS5, schema migrations, and repositories.
- **Adapters:** MCP first; other agent integrations later.

Current implementation choices include TypeScript, Node.js, better-sqlite3, the TypeScript compiler API, Commander, Zod, the ignore package, and the MCP TypeScript SDK. Do not replace a working dependency or add a service/database without a demonstrated technical reason and a migration plan.

SQLite is the initial graph store using relational node and edge tables. A separate graph database is not a v0.x requirement.

## 8. Knowledge model

The model should distinguish:

- **Source artifacts:** repositories, files, commits, and tests.
- **Code symbols:** functions, classes, methods, interfaces, types, and other language-specific declarations.
- **Conceptual entities:** components, features, business rules, and architecture decisions are part of the intended knowledge vocabulary. The current parser/indexer does not extract component entities or provide component retrieval; these concepts must not be presented as implemented.
- **Relations:** directed, typed links such as IMPORTS, CALLS, DEPENDS_ON, IMPLEMENTS, DEFINED_IN, and TESTED_BY.
- **Memories:** explicit project knowledge with category, status, source, timestamps, and optional commit reference.

Phase 3 retrieval acceptance covers indexed source files, symbols, imports, dependencies, and parser-derived symbol relations. Component extraction and retrieval remain a separate future capability and are not implied by the conceptual entity vocabulary above.

Relations and memories need provenance. A syntax-derived import should be distinguishable from a semantic association or a developer-confirmed decision. Confidence values must not imply certainty where the parser cannot resolve a relationship.

## 9. Local data and privacy

The default database location is outside the repository:

- Windows: under %LOCALAPPDATA%/CodebaseNeuralMemory/projects/
- macOS: under ~/Library/Application Support/CodebaseNeuralMemory/projects/
- Linux: under $XDG_DATA_HOME/codebase-neural-memory/projects/, defaulting to ~/.local/share/codebase-neural-memory/projects/

Project identity currently derives from the canonical local path. This is a known limitation for moved repositories and Git worktrees and should be addressed deliberately.

The indexer uses ignore rules and built-in exclusions for common generated/dependency directories and sensitive file patterns. Exclusions are defense in depth, not a guarantee that every secret can be detected. Users need configurable exclusions and clear diagnostics.

No initialization or indexing operation may upload repository content. No team synchronization is part of v1.

## 10. Functional requirements

### Project lifecycle
- Initialize local memory for a repository without changing its tracked or untracked project files.
- Resolve the project root predictably.
- Report the database location and index status.
- Support a forced rebuild.

### Indexing
- Discover supported files deterministically.
- Respect .gitignore and CNM exclusion rules.
- Avoid following symlinks by default.
- Apply a configurable size limit.
- Hash file contents and skip unchanged files.
- Remove stale file, symbol, search, and relation records when files are deleted or changed.
- Keep each file update transactionally consistent.
- Report skipped files and parse failures.

### Knowledge graph
- Store typed, directed relationships with provenance.
- Support traversal of direct and transitive dependencies.
- Avoid presenting unresolved or ambiguous references as confirmed edges.
- Allow graph rebuild from indexed source facts.

### Memories
- Store explicit project decisions and notes locally.
- Preserve source and timestamp metadata.
- Provide query, update, and deletion operations with clear user intent.
- Introduce lifecycle states only when the corresponding workflows exist.
- Never silently convert agent suggestions into confirmed project rules.

### Retrieval and context
- Support exact and lexical symbol search.
- Retrieve symbols, files, imports, dependencies, and symbol relations. Conceptual component retrieval is not currently implemented and is not a Phase 3 acceptance requirement.
- Return source paths and line references when available.
- Explain lexical ranking signals and the provenance/confidence/index revision of every dependency-chain edge.
- Report stale or incomplete index state.
- Apply result limits to every collection and report totals/truncation when bounded.
- Keep lexical/structural retrieval useful without embeddings.

### Agent integration
- Expose retrieval tools over local MCP stdio; allow explicit incremental index reconciliation and proposed-only memory creation. Confirmation and other memory lifecycle mutations remain human-controlled.
- Validate all tool inputs.
- Keep index reconciliation and memory proposal as explicit MCP calls; never silently confirm a proposal. Other memory lifecycle mutations remain under explicit CLI control.
- Avoid logging source contents or memory bodies unnecessarily.

## 11. Non-functional requirements

- Strict TypeScript and maintainable module boundaries.
- Reliable schema migrations and database recovery behavior.
- Deterministic indexing results for unchanged source.
- No unnecessary full-repository parsing on incremental runs.
- Graceful handling of unreadable, malformed, unsupported, or oversized files.
- Clear errors and actionable CLI output.
- Automated unit and integration tests.
- CI validation for typecheck, tests, and build.
- No network requirement for core indexing or retrieval.

## 12. Product success

CNM succeeds when, on representative repositories and controlled tasks, it can retrieve the correct files, symbols, dependencies, rules, and tests more efficiently than repeated manual repository exploration, while keeping output compact and verifiable. Conceptual component retrieval is a separate future capability and must not be implied by the current lexical/structural API.

Improvement must be measured against a baseline. Do not promise a fixed reduction in tokens, latency, or task failures before benchmarks support it.


## Bounded source-code inspection

Coding agents can retrieve actual implementation text through the read-only MCP `source_excerpt` tool after locating a symbol or file. The tool is restricted to indexed project-relative files, inclusive line ranges, at most 200 lines, 20,000 output characters, and source files no larger than 1 MiB. It reports whether the current working-tree bytes match the indexed SHA-256; stale source is labeled rather than silently represented as index-consistent. This is targeted source inspection, not repository-wide file dumping or semantic retrieval.
