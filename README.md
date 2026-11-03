# Codebase Neural Memory

**Local-first structural memory for software repositories and coding agents.**

Codebase Neural Memory (CNM) builds a persistent, queryable map of a codebase. It indexes source files, extracts JavaScript/TypeScript symbols, records imports and locally resolvable dependencies, stores explicit project decisions, and exposes read-only retrieval tools through MCP.

It does not train models, modify model weights, upload source code, or require a cloud service. The initial release is a local developer tool; team synchronization and embeddings are intentionally out of scope.

## Status

This repository starts the v0.1 development line. The first implementation targets JavaScript and TypeScript repositories. Python and additional languages will be added through parser adapters after the core indexing and retrieval flow is stable.

## Requirements

- Node.js 22.12 or newer
- npm
- Windows, macOS, or Linux

## Install for development

```bash
git clone <your-private-repository-url>
cd codebase-neural-memory
npm install
npm run build
npm link
```

## Quick start

Run these commands from the root of a repository you want to index:

```bash
cnm init
cnm index
cnm status
cnm map
cnm search "registerParticipant"
cnm explain "TournamentService"
cnm impact "src/services/tournamentService.ts"
cnm blame "src/services/tournamentService.ts" --start-line 10 --end-line 30
cnm symbol-impact "registerParticipant" --file "src/services/tournamentService.ts" --direction incoming --depth 3
cnm dependencies "src/services/tournamentService.ts" --depth 2
cnm remember "Duplicate registration is prohibited" "A participant may only be registered once in an active tournament."
cnm memories
cnm freshness
cnm file "src/services/tournamentService.ts" --limit 100
```

Run `cnm index` again after changing the code. Unchanged files are skipped by content hash; modified files are reparsed and deleted files are removed from the active index. Use `cnm freshness` to compare the working tree with the index without modifying it: the report distinguishes `not-indexed`, `current`, `stale`, and `incomplete`, counts added, changed, and deleted files, and reports the indexed/current Git commit, branch, and working-tree state when Git metadata is available. A changed commit, branch, or Git working-tree snapshot is reported as stale even when source-file hashes are unchanged. Non-Git folders continue to use file-content freshness alone. Add project-specific exclusions with repeatable `--exclude` patterns, for example `cnm index --exclude "generated/" --exclude "*.fixture.ts"`. These patterns are additive and cannot disable mandatory safety exclusions. For focused refreshes, use repeatable `--path` selectors (file or directory) and/or `--include` glob patterns: `cnm index --path src/core --include "*.ts"`. Bound work with `--max-files 200` and `--max-processed 10000`. A selective or bounded run does not perform deletion reconciliation, so missing-file cleanup remains a full-scope operation; it never deletes indexed records outside its selected scope. `maxFiles` selects a deterministic subset and reports `truncated: true` when more candidates remain. If `maxProcessed` is exceeded before the candidate set can be selected deterministically, the update aborts without writing any index changes. The same `paths`, `include`, `maxFiles`, and `maxProcessed` controls are available on the MCP `index_update` tool. Paths must be project-relative and cannot traverse outside the repository. Every CLI/MCP index update, including selective and bounded updates, aborts without committing when relation-resolution configuration is malformed, unreadable, or unsafe, and rechecks the configuration fingerprint before commit. Selective/bounded updates remain scoped and non-destructive; full-scope updates additionally require complete source discovery. Fix the configuration and retry rather than accepting an incomplete relation graph.

## Project memory lifecycle

CNM stores project decisions and notes in the local project database, independently of the coding agent connected to it. During `cnm init`, CNM creates `AGENTS.md` when absent or adds/updates only a marked CNM-managed section in an existing file, preserving the project-authored content. Use `cnm agents-md --check` in CI and `cnm agents-md --print` to inspect the generated instructions. Use `remember` for knowledge explicitly confirmed by the person invoking the command, or `propose` for suggestions that remain unconfirmed until an explicit transition:

```bash
cnm propose "Potential API rule" "Review this rule before adopting it." --author "Project Maintainer"
cnm memories
cnm memory transition <memory-id> confirmed
cnm memory update <memory-id> --content "Updated decision text" --author "Project Maintainer"
cnm memory freshness --limit 100
cnm memory transition <memory-id> obsolete
cnm memory delete <memory-id>
```

The lifecycle permits `proposed → confirmed` or `proposed → rejected`, `confirmed → obsolete`, and `obsolete → confirmed`. Rejected memories are terminal and excluded from recall by default. Updates and deletion are explicit and scoped to the current project. Optional source paths, Git commit identifiers, and explicit author identities can be stored with a memory. The original author is retained separately from the identity supplied for the latest update; CNM does not infer or transmit personal identity automatically.

When a source path is supplied, CNM records a SHA-256 fingerprint of the referenced file. `cnm memory freshness` also compares an optional recorded Git commit with the current `HEAD`: `current`, `ancestor`, `ahead`, `diverged`, `unknown`, or `unavailable` commit relationships are reported separately from file status. Older, ahead-of-branch, divergent, unknown, or unavailable commit references require review. Commit-only memories are included even when no source path is attached. The CLI inspects at most 100 records by default (`--limit` accepts 1–500) and reports the eligible total plus a truncation flag; task context checks freshness only for the selected memory candidates. This inspection does not rewrite memory content or change lifecycle status; it never auto-confirms or auto-obsoletes a memory.

## MCP integration

Start the local MCP server from an initialized target repository:

```bash
cnm init
cnm index
cnm mcp
```

The server uses stdio and exposes eighteen tools: thirteen read/retrieval tools and three explicit local write operations (`index_update`, `memory_propose`, and `memory_transition`). The memory transition tool can confirm a proposal only after the user clearly authorizes it.

- `project_overview` — local repository/index summary.
- `index_freshness` — source-file and Git commit/branch/working-tree freshness versus the index.
- `project_map` — indexed files, resolved/unresolved imports, and bounded TypeScript-backed external import diagnostics (`missing-package` / `missing-export`).
- `symbol_lookup` — bounded lexical symbol search with kind, file-path-prefix, and export filters applied before candidate truncation, plus opt-in verified inline source (`includeSource`). Ranking tie-breaks use locale-independent code-unit ordering.
- `index_update` — incrementally reconcile changed/deleted/added source files while retaining configured exclusions.
- `dependency_graph` — bounded direct/transitive import traversal with edge evidence.
- `file_details` — bounded indexed file metadata, symbols, imports, and relations; `inlineSnippets` optionally includes bounded source for the first symbols.
- `source_excerpt` — bounded current source-code lines from an indexed file, with line ranges, SHA-256 comparison against the index, and explicit stale/truncation status.
- `git_blame` — bounded read-only line attribution for tracked project files, including commit, author, timestamp, and summary; this is historical attribution, not inferred rationale.
- `git_history` — bounded recent commit metadata and changed-path evidence, with strict commit/path budgets and a 3-second command timeout. Git commits are not assumed to equal agent sessions, and commit messages are not treated as proof of intent.
- `change_impact` — bounded reverse-import impact traversal at the file level.
- `symbol_impact` — bounded symbol-level traversal over `CALLS`, `EXTENDS`, and `IMPLEMENTS`, returning shortest relation distances, source locations, and per-edge evidence. Incoming traversal finds callers, subclasses, implementors, and indexed test-case callbacks that may be affected; outgoing traversal finds dependencies. Recognized `it`/`test`/`specify`-style callbacks in test files are indexed as `test-case` symbols, with imported calls linked to their concrete source symbols. This is static syntax evidence, not runtime test coverage. Ambiguous symbol names return candidates and require a path/kind/line filter.
- `task_context` — deterministic, bounded task context from indexed facts and memories; optional exact path/symbol anchors disable broad lexical symbol fallback and label each item origin.
- `memory_freshness` — source-file fingerprints and Git commit ancestry for linked or commit-referenced memories.
- `memory_recall` — bounded lexical retrieval with lifecycle labels, filters, and explicit candidate-window truncation metadata.
- `memory_propose` — persist an agent suggestion with `proposed` status; a person must explicitly confirm it.
- `memory_transition` — explicitly transition a memory lifecycle state; agent confirmation requires clear user authorization.

Use `cnm blame <path> --start-line <n> --end-line <n>` or MCP `git_blame` to inspect Git attribution for at most 200 lines in a tracked project-relative file. Author email is omitted. This does not infer intent or session rationale. Use MCP `git_history` to inspect at most 50 recent commits and 500 changed paths; it is a factual change log, not reconstructed session history.

Use `source_excerpt` after `symbol_lookup` or `task_context` to inspect the actual implementation at a returned path and line range. It accepts a project-relative indexed path, inclusive `startLine` / `endLine`, and optional `maxCharacters` (100–20,000; default 12,000). It returns at most 200 lines and reads source files no larger than 1 MiB, rejects paths outside the project root, and reports `indexStatus: current|stale` by comparing the working-tree SHA-256 with the indexed hash. A stale excerpt is current working-tree content, not a claim that the index describes those bytes.

### MCP freshness and agent workflow

Every indexed read checks source/index freshness. If the snapshot is stale or incomplete, the tool preserves its JSON result as the first text block and appends a warning with changed-file counts, affected paths, and the required action. The separate index_freshness tool reports exact paths and old/new SHA-256 hashes (up to 200 details).

Optional server environment variables:

- CNM_MCP_AUTO_UPDATE=1 — incrementally refresh before reads. This is off by default; automatic refresh is skipped when discovery is incomplete or more than 50 source files changed. In those cases call index_update explicitly.
- CNM_MCP_STRICT_FRESHNESS=1 — refuse indexed reads unless the index is current. If combined with auto-update, strict mode evaluates the post-update state.

Auto-update is synchronous. The 50-file guard bounds the number of changed source files, not wall-clock duration. Source-bearing tools still return independent content hashes and indexStatus because files can change after a freshness check.

Symbol signatures retain bounded multiline declaration headers (parameters, generics, return types, and class heritage; maximum 1,200 characters) without storing implementation bodies. For focused implementation inspection, use symbol_lookup with includeSource: { maxLines: 60 }, file_details with inlineSnippets: true (default three symbols), or source_excerpt. For noisy tasks, pass task_context.anchors with exact paths and/or symbol names; returned items identify whether they came from an explicit anchor, graph expansion, or lexical fallback. See [Agent workflow](docs/AGENT_WORKFLOW.md) for a copyable MCP-first policy and the memory-recall/proposal lifecycle.

The MCP process is bound to the repository resolved from its working directory. Configure the MCP client with an explicit repository `cwd`; do not rely on whichever directory the client happens to inherit. `memory_recall` supports natural-language lexical matching, list mode, and lifecycle/category filters. `memory_transition` applies explicit lifecycle changes; agents must call `status: "confirmed"` only after the user clearly authorizes it. For exact schemas and limits, see [the MCP contract](docs/PHASE_6_MCP_CONTRACT.md).

Example OpenCode configuration (replace the path with the absolute path to the repository and adjust the executable path for your machine):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "codebase-memory": {
      "type": "local",
      "command": ["cnm", "mcp"],
      "cwd": ".",
      "enabled": true
    }
  }
}
```

The project must be initialized before the MCP server starts. If the process is launched from another repository, it will bind to that repository's local project identity instead; see the contract for the resolution rules and limitations. For a complete OpenCode and VS Code setup, including workspace-scoped configuration templates and real-client verification steps, see [MCP client integration](docs/CLIENT_INTEGRATION.md).

## Where data is stored

The database is stored outside the repository:

- Windows: `%LOCALAPPDATA%/CodebaseNeuralMemory/projects/<project-id>/memory.sqlite`
- macOS: `~/Library/Application Support/CodebaseNeuralMemory/projects/<project-id>/memory.sqlite`
- Linux: `$XDG_DATA_HOME/codebase-neural-memory/projects/<project-id>/memory.sqlite` (default: `~/.local/share/codebase-neural-memory/...`)

CNM does not create a memory directory in the repository and does not modify `.gitignore`. The database is private to the local user and is not committed or pushed with the project.

## What is indexed

Use `cnm blame <path> --start-line <n> --end-line <n>` to inspect Git attribution for at most 200 lines in a tracked project-relative file. This does not infer intent or session rationale. Use `cnm relations <symbol>` to inspect direct incoming and outgoing symbol relationships (such as `CALLS`, `EXTENDS`, and `IMPLEMENTS`) with file locations, provenance, confidence, and index revision. Use `cnm symbol-impact <symbol> --direction incoming --depth 3` to traverse those edges and measure shortest symbol-to-symbol distances; disambiguate repeated names with `--file`, `--kind`, or `--start-line`. Traversal is bounded by depth, result, and processed-edge limits and reports truncation. `cnm dependencies <file> --depth <number> --limit <number> --max-processed <number>` returns direct or transitive imports with depth, a dependency chain, and `chainEvidence` containing provenance, confidence, and index revision for every edge in that chain; the JSON response reports whether either traversal budget truncated the result. Defaults are 100 unique results and 1,000 examined import edges. `cnm file <path> --limit <number>` returns indexed file metadata, symbols, resolved and unresolved imports, symbol relationships, and provenance. The per-collection limit defaults to 100 and has a maximum of 500; the response includes total counts and truncation flags for each collection. The MCP `file_details` tool accepts the same optional `limit`. These details are read from the existing index; CNM does not infer additional entities for this view.

File and symbol nodes receive deterministic SHA-256 identifiers derived from their project-relative identity; these identifiers survive forced reindexing and line-only shifts. Internal SQLite row IDs remain implementation details.

The project map lists resolved relative imports and explicitly labels relative imports that are unresolved or ambiguous; ambiguous imports are not assigned a guessed target. Symbol search ranks exact names, name-term coverage, signature-term coverage, exported symbols, and FTS5 BM25 relevance, and returns the signals used for each result. Multi-term queries are tokenized and matched across names and signatures. If the SQLite build does not provide FTS5, the lexical LIKE fallback is used; queries containing literal LIKE wildcard characters also bypass FTS5 so underscores, percent signs, and backslashes are not reinterpreted by FTS tokenization. Unrelated SQLite errors are surfaced instead of being silently treated as a fallback condition. The initial parser supports `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, and `.cjs` files. It extracts functions, classes, methods, interfaces, type aliases, enums, import declarations, simple local function-call relationships, and statically resolvable class/interface heritage relationships.

Common generated/dependency folders and sensitive files such as `.env`, private keys, and certificate files are excluded. The `.gitignore` file is respected, and additional patterns can be supplied to `cnm index` with `--exclude`. Symlinks are skipped by default. Files larger than 1 MB are skipped by default.

## Current limitations

- Import resolution supports relative imports, explicit `compilerOptions.paths` aliases from the repository-root `tsconfig.json`, and `exports` targets from local packages whose `package.json` files are in indexed source directories or their ancestors. Root and subpath exports, simple wildcard mappings, and the `types`, `import`, `node`, `default`, and `require` conditions are supported; multiple indexed targets are reported as ambiguous, and missing or unsafe local targets remain unresolved. A separate TypeScript semantic pass reports unresolved external packages and invalid named/default export bindings in `project_map`; these are focused import diagnostics, not a replacement for the repository compiler or build. It uses the project `tsconfig.json` when available and excludes Node built-ins and recognized local workspace packages. The freshness fingerprint also includes external `node_modules/package.json` manifests actually consulted by TypeScript semantic module resolution; changes to those manifests mark the index stale, while unrelated unused package manifests do not.
- Class and interface `extends` / class `implements` relationships are recorded when the target is a unique local symbol or a uniquely resolved named import. Complex heritage expressions and unresolved or ambiguous targets are not inferred.
- Call relationships are resolved within a file and across statically imported named exports (including aliased imports) when the import resolves to one indexed file and one exported symbol. Shadowed imports, default/namespace imports, re-exports, dynamic calls, and runtime-generated relationships are not inferred.
- Dynamic imports, framework-specific dependency injection, reflection, and runtime-generated relationships are not inferred.
- The index is structural, not a substitute for source code or tests. `cnm freshness` is a read-only filesystem and Git-state comparison, not a background watcher; it uses the exclusion patterns persisted by the last index run. Git dirty-state tracking covers the repository's unignored working-tree changes, so unrelated non-source edits can also make the Git snapshot stale. The MCP `index_freshness` tool returns the same report without changing the index.
- Embeddings, semantic ranking, background file watching, and multi-developer synchronization are not part of this first milestone.

## Design principles

1. Local-first and private by default.
2. Source code remains the source of truth.
3. Every inferred relationship has provenance and a confidence value.
4. Incremental indexing must be safe and recoverable.
5. The core must remain independent of any particular LLM or coding agent.
6. MCP is an adapter, not the memory engine.

## Development

```bash
npm run typecheck
npm test
npm run build
```

## License

MIT. See [LICENSE](LICENSE).


## Task context

Build a deterministic, bounded context bundle for a task from the local index and project memories. In addition to total item/character limits, set independent category limits for symbols, files, dependencies, tests, and memories:

```sh
cnm context "Fix authentication token refresh and update tests" --max-items 20 --max-characters 12000 --symbol-limit 20 --file-limit 10 --dependency-limit 20 --test-limit 20 --memory-limit 20
```

The JSON response includes lexical anchors, ranked symbols/files/memories/test paths, source references, lifecycle and freshness warnings, total budget usage, and per-category limits/usage/truncation metadata. Memory statuses are not collapsed: proposed and obsolete records are labeled and accompanied by warnings. The MCP adapter exposes the same capability as `task_context`. Retrieval remains lexical/structural and does not claim semantic completeness.


### Structural component overview

Use `cnm components` or MCP `component_map` to aggregate the indexed import graph by first project-relative directory. For example, `cnm components --from src --depth 3` reports directed cross-directory imports and shortest dependency distances. These groups are deterministic structural boundaries, not semantic or business-domain component inference; root-level files are grouped under `(root)`. Output is bounded and includes truncation metadata.

## Autonomous memory development status

Autonomous Memory Contract v2 and its staged implementation plan are documented in [docs/AUTONOMOUS_MEMORY_CONTRACT.md](docs/AUTONOMOUS_MEMORY_CONTRACT.md) and [docs/AUTONOMOUS_MEMORY_IMPLEMENTATION_CHECKLIST.md](docs/AUTONOMOUS_MEMORY_IMPLEMENTATION_CHECKLIST.md). The schema-v13 migration is merged. An initial versioned `memory_capture` core/MCP slice is under review; existing legacy memory commands remain compatibility surfaces while update/correction and retrieval are implemented. Planned v2 capabilities must not be treated as fully released behavior.


### Autonomous memory capture (transition)

The versioned memory schema (v13) is merged. An initial `memory_capture` core/MCP implementation is under development on `feat/memory-capture-core`; the existing legacy memory tools remain the active compatibility surface until versioned update/correction and retrieval operations are completed and reviewed. Do not treat the schema migration alone as a completed autonomous-memory system.
