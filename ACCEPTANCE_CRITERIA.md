# v0.1.0 Acceptance Criteria

**Status:** Acceptance baseline for review  
**Release:** CNM 0.1.0  
**Scope:** Local-first JavaScript/TypeScript repository indexing and retrieval

This document turns the v0.1 scope already described in `README.md`, `ARCHITECTURE.md`, and `CHANGELOG.md` into observable acceptance criteria. It defines how to verify the documented behavior; it does not claim that every criterion is already satisfied.

## 1. How to use this document

Each criterion has a stable ID, an expected result, and a verification method.

- **Documented scope** is explicitly described in the existing project documentation.
- **Acceptance detail** is a testable interpretation added here to make the documented behavior verifiable. It is not an expansion of product scope.
- A criterion is accepted only when its result is demonstrated by an automated test or a reproducible manual check.
- Typechecking and building are necessary, but they do not by themselves prove runtime behavior.

If implementation and documentation disagree, record the discrepancy and decide whether the implementation or the documentation should change. Do not silently treat undocumented behavior as a release requirement.

## 2. Product boundary

CNM v0.1.0 is a single-process, local-first developer tool. It builds a persistent structural map of a JavaScript/TypeScript repository, stores it in SQLite outside the repository, provides lexical retrieval and basic dependency impact analysis, stores explicit developer-entered memories, and exposes read-only retrieval through an MCP stdio adapter.

The following constraints are part of the release boundary:

- Source code and the CNM database remain local; indexing must not upload source code or require a cloud service.
- CNM does not train models, modify model weights, or edit source files.
- CNM does not create its database or a memory directory inside the target repository by default, and does not modify the target repository's `.gitignore`.
- The core remains independent of MCP and any specific LLM or coding agent.
- Inferred relationships retain provenance and confidence. An inference must not be presented as a confirmed project rule.
- Incremental indexing must be safe and recoverable.

## 3. Acceptance criteria

### A. Runtime, installation, and CLI

| ID | Criterion | Acceptance condition | Verification |
|---|---|---|---|
| RUN-01 | Supported runtime | CNM installs and runs on Node.js 22.12 or newer on Windows, macOS, and Linux. | Run the install, typecheck, test, and build commands on a supported Node.js version. Platform-specific checks should be recorded separately. |
| CLI-01 | Clean installation | A clean checkout installs reproducibly from the committed lockfile. | Run `npm ci --no-audit --no-fund` from a clean checkout. |
| CLI-02 | Static checks, tests, and build | Typecheck, automated tests, and build complete successfully. | Run `npm run typecheck`, `npm test`, and `npm run build`. Record test files and test count. |
| CLI-03 | Project initialization | `cnm init` initializes local project metadata and can be run again without creating duplicate project identities or corrupting data. | Run `cnm init` twice from the same repository, then run `cnm status`. |
| CLI-04 | Main workflow commands | The documented commands `index`, `status`, `map`, `search`, `explain`, `impact`, `remember`, `memories`, and `mcp` are registered and have their documented basic behavior. | Exercise each command against a disposable fixture repository. |
| CLI-05 | Numeric limits | Any CLI `--limit` argument accepts only positive safe integers and rejects zero, negative, fractional, non-numeric, infinite, and unsafe integer values. | Unit-test the argument parser and manually check at least one invalid CLI invocation. |

### B. Project identity, storage, and privacy

| ID | Criterion | Acceptance condition | Verification |
|---|---|---|---|
| PRJ-01 | Stable local identity | Repeated commands from the same canonical repository path resolve to the same project ID. | Compare the project identity across separate CLI invocations. |
| PRJ-02 | External database location | The SQLite database is stored in the documented per-user application-data directory, outside the target repository. | Initialize a fixture repository and inspect the reported database path and repository working tree. |
| PRJ-03 | No repository mutation | Initialization and indexing do not add a CNM data directory to the target repository and do not modify its `.gitignore`. | Compare the fixture repository before and after running the commands. |
| PRJ-04 | Local-only operation | The basic indexing and retrieval workflow works without a cloud service or model-provider credentials. | Run initialization, indexing, search, and impact analysis in an environment without configured model credentials or CNM cloud services. |

### C. File discovery and incremental indexing

| ID | Criterion | Acceptance condition | Verification |
|---|---|---|---|
| IDX-01 | Supported source extensions | Discovery includes `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, and `.cjs`. | Use a fixture containing each extension and verify the indexed file records. |
| IDX-02 | Built-in exclusions | Common generated/dependency directories and sensitive file patterns documented by the project are excluded. | Include dependency/build folders, `.env` files, and private key/certificate files in a fixture; verify they are not indexed. |
| IDX-03 | Git ignore rules | Root and nested `.gitignore` rules are applied relative to their directory. | Create ignored files and directories at the root and in nested directories; verify ignored content is absent while non-ignored siblings remain indexed. |
| IDX-04 | Symbolic links | Symbolic links are skipped and traversal does not follow a link into another tree. | Add file and directory symlinks to a fixture; verify linked targets are not indexed through those links. |
| IDX-05 | File-size safety limit | Files larger than 1 MB are skipped by default and are not parsed. | Test files below and above the documented limit. |
| IDX-06 | Safe reconciliation of skipped files | A file skipped only because it exceeds the size limit is not mistaken for a deleted file. Its existing index record is retained until the file is actually removed or intentionally excluded. | Index a small file, grow it beyond 1 MB, re-index, and verify its prior record remains. Then delete it and verify removal. |
| IDX-07 | Content hashing | SHA-256 content hashes identify unchanged and modified source files. | Verify unchanged content is skipped and changed content causes a re-index. |
| IDX-08 | Incremental updates | Unchanged files are skipped, changed files are updated, new files are added, and deleted files are removed from the active index. | Run a sequence of initial, unchanged, modified, added, and deleted fixture states; verify summary counters and database contents. |
| IDX-09 | Force re-indexing | `cnm index --force` reparses eligible files even when their content hash has not changed. | Run a normal index followed by a forced index and verify the eligible files are processed again. |
| IDX-10 | Atomic and recoverable run | A failed indexing run does not leave a partially updated database. File records, symbols, imports/calls, relations, and the project index timestamp commit or roll back together. | Force a controlled failure during relation rebuilding and verify that the database still contains the complete prior index. |

### D. Parsing and structural knowledge

| ID | Criterion | Acceptance condition | Verification |
|---|---|---|---|
| PAR-01 | Declaration extraction | The parser extracts the documented JavaScript/TypeScript declaration kinds: functions, classes, methods, interfaces, type aliases, and enums. | Parser tests cover each supported declaration kind, including exported and non-exported declarations. |
| PAR-02 | Imports and re-exports | Import declarations and re-export module specifiers are recorded. | Parser tests cover standard imports and re-exports. |
| PAR-03 | Local call facts | Simple local function-call relationships are recorded when the parser can identify the caller and callee. | Parser tests cover direct identifier calls within a file. |
| PAR-04 | Conservative inference | Unsupported or ambiguous runtime relationships are not invented as resolved edges. | Include dynamic/framework-specific patterns in fixtures and verify that unsupported relationships are not asserted as resolved. |

### E. Relations, retrieval, and impact analysis

| ID | Criterion | Acceptance condition | Verification |
|---|---|---|---|
| REL-01 | Relative import resolution | Relative imports are resolved against indexed files using the documented common JS/TS extensions and index-file candidates. | Index a fixture with relative imports and verify the expected file edges. |
| REL-02 | Relation metadata | Inferred relations retain their type, provenance, and confidence in storage. | Inspect relation rows and verify the expected fields and values for parser-derived edges. |
| RET-01 | Lexical symbol search | Search returns matching indexed symbols using the SQLite FTS5 lexical index. | Index a fixture and verify representative exact and partial symbol queries. |
| RET-02 | Project map | The map reports indexed files and their resolved imports. | Compare map output with a known fixture dependency graph. |
| RET-03 | Reverse-import impact | Impact analysis returns files that transitively depend on the requested indexed file through resolved import relations. | Use a multi-level import fixture and verify the transitive reverse dependency set. |
| RET-04 | Missing target behavior | A file absent from the active index produces a clear error that directs the user to index the project. | Request impact for a missing path and verify the error. |

### F. Explicit memories and MCP

| ID | Criterion | Acceptance condition | Verification |
|---|---|---|---|
| MEM-01 | Explicit memory creation | A developer can create a project memory through the CLI with a title, content, category, and optional source path. | Create a memory and verify its persisted record. |
| MEM-02 | Explicit versus inferred knowledge | Developer-confirmed memories remain distinct from parser-derived inferences. | Verify memory status/category and relation provenance are stored separately. |
| MEM-03 | Local persistence and recall | Memories persist in the local SQLite database and can be listed or filtered through the CLI. | Create memories, close the process, then retrieve them in a new process. |
| MCP-01 | Local stdio adapter | `cnm mcp` starts the local MCP server over stdio. | Launch the server with a disposable repository and verify initialization/handshake. |
| MCP-02 | Read-only tool surface | MCP exposes the documented retrieval tools: `project_overview`, `project_map`, `symbol_lookup`, `change_impact`, and `memory_recall`. | Inspect the advertised tool list and call each tool against a fixture. |
| MCP-03 | No MCP mutations | MCP tools do not create memories, mutate the index, or edit source files. | Verify the tool surface and compare the database/repository before and after read-only tool calls. |

## 4. Deliberate non-goals for v0.1.0

The following are not release blockers for this milestone:

- Python or additional language parsers.
- Cross-file symbol resolution.
- Dynamic imports, framework-specific dependency injection, reflection, or runtime-generated relationships.
- TypeScript path aliases and package-export resolution beyond the documented conservative relative-import scope.
- Embeddings, vector databases, semantic ranking, and model training/fine-tuning.
- Background file watching.
- Cloud services or multi-developer synchronization.
- Automatic semantic claims presented as confirmed project rules.
- Direct source-code editing by CNM or its MCP adapter.

A later milestone may add these capabilities through a separately reviewed scope change.

## 5. Release acceptance gate

CNM v0.1.0 is ready for release review when:

1. All mandatory criteria in sections A–F have an automated test or reproducible manual verification record.
2. `npm ci --no-audit --no-fund`, `npm run typecheck`, `npm test`, and `npm run build` pass in CI.
3. The indexing safety and recoverability tests pass, including oversized-file retention, nested ignore rules, true deletion, and whole-run rollback.
4. The privacy/local-storage constraints are verified against a disposable repository.
5. Any unmet criterion is explicitly listed as a known limitation or deferred item; it is not silently treated as complete.

## 6. Evidence record

For each release candidate, record:

- Commit SHA and tested Node.js/npm versions.
- CI run URL and result.
- Test files and total tests passed.
- Manual checks performed, with environment and result.
- Unmet criteria and accepted deferrals.

This evidence record makes the release decision reproducible without treating a successful build as proof that every product behavior works.
