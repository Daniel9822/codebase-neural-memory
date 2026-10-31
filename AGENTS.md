# Agent Working Agreement

This file defines how coding agents should work in Codebase Neural Memory (CNM). It is an operational guide, not a replacement for the product specification, architecture, roadmap, or acceptance criteria.

## 1. Read the project context first

Before proposing or changing code, inspect the current repository state and read:

1. `README.md` — actual user-facing commands and documented current behavior.
2. `docs/PRODUCT_SPEC.md` — product purpose, principles, constraints, and scope.
3. `ARCHITECTURE.md` — current architecture and technical boundaries.
4. `docs/ROADMAP.md` — intended development phases and sequence.
5. `docs/ACCEPTANCE_CRITERIA.md` — evidence required to consider work complete.

Then inspect the relevant source files, tests, package scripts, and recent Git history. Do not rely on conversation summaries or assumptions about code that has not been inspected.

## 2. Distinguish current behavior from planned work

The repository is an evolving v0.x project. A roadmap item is not implemented merely because it is documented.

When reporting findings, use these categories precisely:

- **Verified behavior:** demonstrated by current code and a passing test or repeatable check.
- **Confirmed defect:** a reproducible violation of an existing requirement.
- **Risk:** a plausible weakness that has not been reproduced.
- **Missing capability:** planned behavior that does not exist yet.
- **Not verified:** code or behavior that has not been tested sufficiently.

Do not call a missing future feature a bug. Do not mark an acceptance criterion complete without evidence. Do not claim that a command, build, test, push, or integration succeeded unless its result was observed.

When documentation and implementation disagree, report the discrepancy. The source code and tests establish what currently happens; the Product Spec and explicitly approved decisions establish the intended behavior.

## 3. Preserve the product constraints

These are core product decisions:

- Local-first and private by default.
- No automatic upload of repository source, index data, or memories.
- No mandatory cloud service, account, telemetry, paid API, LLM, GPU, or embedding model.
- No model training, fine-tuning, or model-weight modification.
- No team synchronization in the first release.
- The core must remain independent of MCP and of any particular coding agent.
- MCP is an adapter; it is not the memory engine.
- Source code and tests remain the source of truth.
- Derived facts and inferred relationships must retain provenance and must not be presented as human-confirmed decisions.
- Initialization and indexing must not modify source files, Git metadata, or `.gitignore`.
- Default project memory must remain outside the target repository in the user's per-user application data directory.

Do not introduce networking, telemetry, a hosted service, embeddings, a vector database, a new database server, or a GPU requirement without an explicitly approved product decision.

## 4. Respect the current technical baseline

Current project choices:

- Node.js >= 22.12.
- TypeScript, ESM, strict compiler settings.
- SQLite through `better-sqlite3`.
- TypeScript compiler API for initial JavaScript/TypeScript parsing.
- SQLite FTS5 for lexical symbol lookup.
- Commander for the CLI.
- Zod for validation.
- `ignore` for ignore-pattern handling.
- MCP TypeScript SDK v2 with local stdio transport.
- Vitest for tests.

Use the existing architecture and dependencies unless there is a demonstrated reason to change them. Do not replace the TypeScript compiler API with Tree-sitter, introduce Drizzle, or add a graph/vector database merely because it appeared in an earlier brainstorm. Any dependency or architectural change must include its motivation, compatibility impact, migration plan, and tests.

Maintain the strict TypeScript settings. Use explicit ESM `.js` import specifiers in TypeScript source where required by the current NodeNext setup.

## 5. Safe implementation practices

- Inspect the exact code path before editing it.
- Make the smallest coherent change that solves the task.
- Avoid unrelated refactors and speculative abstractions.
- Preserve existing public CLI and MCP behavior unless the task explicitly changes it.
- Validate CLI and MCP inputs; bound user-controlled result limits and traversal depth.
- Use parameterized SQL statements.
- Keep SQLite schema changes versioned, forward-only, transactional where practical, and covered by migration tests.
- Do not silently discard an existing index when parsing or file discovery fails.
- Remove stale symbols, FTS rows, and relations consistently when source files change or disappear.
- Make indexing repeatable: rebuilding from unchanged source should produce the same logical index.
- Guard graph traversals against cycles and unbounded result growth.
- Treat ambiguous imports and unresolved symbols as unresolved; do not guess targets.
- Keep provenance for graph edges and source references for retrieved facts.
- Continue to exclude symlinks and sensitive/generated paths by default; never weaken mandatory safety exclusions to make a test pass.
- Do not log source contents, secrets, or memory bodies unnecessarily.
- Keep MCP tools read-only unless the product specification and user explicitly authorize a new write capability.
- Never have an agent silently promote its own suggestion into a confirmed project decision.

## 6. Required development workflow

For each implementation task:

1. Check the current branch, working tree, and latest commit.
2. Identify the relevant roadmap phase and acceptance criteria.
3. Inspect the implementation and existing tests before editing.
4. State the intended change and likely affected modules.
5. Implement narrowly and add or update regression tests.
6. Update documentation when behavior, commands, configuration, or limitations change.
7. Review the complete diff for accidental changes, secrets, generated files, and unrelated refactors.
8. Run the applicable checks:
   - `npm ci --no-audit --no-fund`
   - `npm run typecheck`
   - `npm test`
   - `npm run build`
9. Report exactly which commands ran and their actual outcomes. If a check could not run, say so.
10. Do not mark acceptance criteria complete until the required evidence exists.

For meaningful code changes, prefer a focused feature/fix branch and pull request when the repository workflow supports it. Do not force-push, overwrite another contributor's work, or update `main` using a stale branch head. Follow the user's explicit instructions about where changes should be committed.

## 7. Testing expectations

Add tests for both expected results and failure boundaries. Prefer focused fixtures that prove:

- Initial, unchanged, changed, deleted, and forced indexing behavior.
- Correct cleanup of FTS and relation rows.
- File exclusions, nested ignore rules, symlinks, binary and oversized files.
- Malformed source and inaccessible-directory handling.
- Import resolution, ambiguity, path traversal containment, and cycles.
- Memory isolation and lifecycle transitions.
- Database initialization and upgrades from supported prior schemas.
- Retrieval result bounds, source references, and stale-index behavior.
- MCP startup, tool schemas, read-only behavior, and project isolation.

CI currently verifies typecheck, tests, and build on Ubuntu. Do not imply that Windows or macOS compatibility has been validated solely by a Linux CI pass. Prefer cross-platform CI coverage as the project approaches stable release, especially because `better-sqlite3` includes a native component.

## 8. Documentation responsibilities

Keep the following responsibilities distinct:

- `README.md`: install, quick start, current commands, supported behavior, and known limitations.
- `ARCHITECTURE.md`: how the current system is structured and how its components interact.
- `docs/PRODUCT_SPEC.md`: what the product is and the constraints it must preserve.
- `docs/ROADMAP.md`: intended implementation sequence and phase deliverables.
- `docs/ACCEPTANCE_CRITERIA.md`: testable completion conditions.
- `CHANGELOG.md`: user-visible changes by release.
- `SECURITY.md`: privacy defaults, safeguards, and vulnerability reporting.
- `AGENTS.md`: how coding agents should work in this repository.

Update only the documents affected by a change. Keep statements about current implementation distinct from future plans.

## 9. Completion report format

At the end of a task, provide:

1. **Summary:** what changed and why.
2. **Files:** important files added or modified.
3. **Verification:** exact commands and observed results.
4. **Acceptance:** criteria completed, partially completed, or still open.
5. **Risks and limitations:** known gaps and anything not verified.
6. **Git status:** branch, commit/PR reference, and whether changes were actually pushed.

Be direct and honest. Correctness, privacy, maintainability, and preservation of working behavior take priority over adding features quickly.
