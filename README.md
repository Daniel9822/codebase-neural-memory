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
cnm dependencies "src/services/tournamentService.ts" --depth 2
cnm remember "Duplicate registration is prohibited" "A participant may only be registered once in an active tournament."
cnm memories
cnm freshness
cnm file "src/services/tournamentService.ts"
```

Run `cnm index` again after changing the code. Unchanged files are skipped by content hash; modified files are reparsed and deleted files are removed from the active index. Use `cnm freshness` to compare the working tree with the index without modifying it: the report distinguishes `not-indexed`, `current`, `stale`, and `incomplete`, and counts added, changed, and deleted files while listing skipped files and discovery errors. Add project-specific exclusions with repeatable `--exclude` patterns, for example `cnm index --exclude "generated/" --exclude "*.fixture.ts"`. These patterns are additive and cannot disable mandatory safety exclusions.

## MCP integration

Start the local MCP server from the target repository:

```bash
cnm mcp
```

Configure the client to launch `cnm mcp` with the repository as its working directory. The server uses stdio and exposes read-only tools:

- `project_overview`
- `project_map`
- `symbol_lookup`
- `change_impact`
- `memory_recall`
- `index_freshness`
- `dependency_graph`
- `file_details`

Example OpenCode configuration (adjust the executable path for your machine):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "codebase-memory": {
      "type": "local",
      "command": ["cnm", "mcp"],
      "enabled": true
    }
  }
}
```

If the client launches MCP from a different working directory, set its server working directory to the repository root using the client's supported configuration.

## Where data is stored

The database is stored outside the repository:

- Windows: `%LOCALAPPDATA%/CodebaseNeuralMemory/projects/<project-id>/memory.sqlite`
- macOS: `~/Library/Application Support/CodebaseNeuralMemory/projects/<project-id>/memory.sqlite`
- Linux: `$XDG_DATA_HOME/codebase-neural-memory/projects/<project-id>/memory.sqlite` (default: `~/.local/share/codebase-neural-memory/...`)

CNM does not create a memory directory in the repository and does not modify `.gitignore`. The database is private to the local user and is not committed or pushed with the project.

## What is indexed

Use `cnm relations <symbol>` to inspect incoming and outgoing symbol relationships (such as `CALLS`, `EXTENDS`, and `IMPLEMENTS`) with file locations, provenance, confidence, and index revision. Use `--limit` to bound the result. `cnm dependencies <file> --depth <number> --limit <number> --max-processed <number>` returns direct or transitive imports with edge evidence, depth, and the dependency chain; the JSON response reports whether either traversal budget truncated the result. Defaults are 100 unique results and 1,000 examined import edges. `cnm file <path>` returns indexed file metadata, symbols, resolved and unresolved imports, symbol relationships, and provenance. These details are read from the existing index; CNM does not infer additional entities for this view.

File and symbol nodes receive deterministic SHA-256 identifiers derived from their project-relative identity; these identifiers survive forced reindexing and line-only shifts. Internal SQLite row IDs remain implementation details.

The project map lists resolved relative imports and explicitly labels relative imports that are unresolved or ambiguous; ambiguous imports are not assigned a guessed target. Symbol search ranks exact names, name-term coverage, signature-term coverage, exported symbols, and FTS5 BM25 relevance, and returns the signals used for each result. Multi-term queries are tokenized and matched across names and signatures. If the SQLite build does not provide FTS5, the lexical LIKE fallback is used; unrelated SQLite errors are surfaced instead of being silently treated as a fallback condition. The initial parser supports `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, and `.cjs` files. It extracts functions, classes, methods, interfaces, type aliases, enums, import declarations, simple local function-call relationships, and statically resolvable class/interface heritage relationships.

Common generated/dependency folders and sensitive files such as `.env`, private keys, and certificate files are excluded. The `.gitignore` file is respected, and additional patterns can be supplied to `cnm index` with `--exclude`. Symlinks are skipped by default. Files larger than 1 MB are skipped by default.

## Current limitations

- Import resolution supports relative imports, explicit `compilerOptions.paths` aliases from the repository-root `tsconfig.json`, and `exports` targets from local packages whose `package.json` files are in indexed source directories or their ancestors. Root and subpath exports, simple wildcard mappings, and the `types`, `import`, `node`, `default`, and `require` conditions are supported; multiple indexed targets are reported as ambiguous, and missing or unsafe local targets remain unresolved. External packages and `baseUrl`-only resolution are not inferred.
- Class and interface `extends` / class `implements` relationships are recorded when the target is a unique local symbol or a uniquely resolved named import. Complex heritage expressions and unresolved or ambiguous targets are not inferred.
- Call relationships are resolved within a file and across statically imported named exports (including aliased imports) when the import resolves to one indexed file and one exported symbol. Shadowed imports, default/namespace imports, re-exports, dynamic calls, and runtime-generated relationships are not inferred.
- Dynamic imports, framework-specific dependency injection, reflection, and runtime-generated relationships are not inferred.
- The index is structural, not a substitute for source code or tests. `cnm freshness` is a read-only working-tree comparison, not Git commit/branch tracking or a background watcher; it uses the exclusion patterns persisted by the last index run. The MCP `index_freshness` tool returns the same report without changing the index.
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
