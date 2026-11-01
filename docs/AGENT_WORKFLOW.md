# MCP-first workflow for coding agents

This policy is intended to be copied into the target repository's AGENTS.md (or merged into its existing agent instructions). It describes how to use Codebase Neural Memory (CNM) as the first source for repository structure while keeping source code and tests authoritative.

## Session start

1. Call memory_recall with a concise task/domain query before broad source exploration. Treat confirmed memories as historical project knowledge only after checking their source freshness; proposed memories are suggestions, obsolete memories are not current guidance, and rejected memories must not be used.
2. Call index_freshness once. It is read-only and reports exact changed/added/deleted paths, old/new SHA-256 values, and whether discovery was incomplete.
3. If the index is stale, call index_update once. Do not loop. If it remains incomplete or stale, report that limitation and use source-control/filesystem tools to verify the affected files.
4. If the MCP server uses strict freshness, a refused response is a hard stop for indexed claims until freshness is restored. Do not work around it by treating the stale index as current.

## Before editing

1. Resolve a known symbol with symbol_lookup. Use kind, filePath, and exported filters to narrow ambiguous results.
2. Use file_details for file structure, imports, and relationships. Prefer inlineSnippets when one to three symbol bodies are needed.
3. Use source_excerpt for the exact implementation lines. Require indexStatus: current before relying on indexed line ranges or hashes. An excerpt with indexStatus: stale is actual working-tree text but proves the index snapshot is outdated.
4. For high-fan-in modules or exported contracts, run change_impact before changing the public surface. Use dependency_graph with a low depth first; expand only when the result justifies it.
5. For broad/noisy tasks, call task_context with explicit anchors, e.g. anchors: { paths: ["src/feature/handler.ts"], symbols: ["handleFeature"] }. When anchors are supplied, the central context is built from those anchors and their graph; each item is labeled origin: anchor, graph, or fallback. Prefer anchor facts, then graph evidence. If the tool reports a stale warning, resolve freshness before relying on indexed details.

## Reading policy and safe fallbacks

- Prefer MCP for indexed JavaScript/TypeScript structure and bounded source excerpts.
- Do not read an entire indexed source file merely to discover its structure when symbol_lookup, file_details, or source_excerpt can answer the question.
- Use ordinary file reads/search when a file is not indexed, is unsupported/non-code (configuration, assets, generated data, documentation), is too large, or the MCP result is stale/incomplete/unreadable. State which fallback was necessary.
- Never infer behavior from symbol names, signatures, graph edges, or memory text alone when implementation details matter. Verify the source excerpt and tests.
- MCP retrieval is lexical/structural, not semantic proof. An empty result does not prove that no dependency or behavior exists.

## After editing and verification

1. Run the relevant tests, typecheck, build, and any project-specific checks. CNM does not replace the target project's test suite.
2. Call index_update once after source edits when you need refreshed structural retrieval. Do not repeatedly update in a loop.
3. Re-run file_details/source_excerpt for changed files and verify the new source hash and line ranges. If a source excerpt reports stale, do not describe the index as synchronized.
4. Re-run change_impact or dependency_graph when the edit changes an export or dependency contract.
5. Propose stable, reusable project knowledge with memory_propose only after tests and review support it. Include a concise title, evidence-based content, category, sourcePath, and commitSha when available. Use categories such as decision, convention, architectural, and gotcha.
6. A memory proposal is not a confirmed decision. A human must review and explicitly confirm it through the project's established memory lifecycle workflow. Never claim a proposed memory is confirmed.

## Optional server policies

- CNM_MCP_AUTO_UPDATE=1 performs one incremental refresh before a read when the source change set is small and discovery is complete. It skips automatic refresh when discovery is incomplete or more than 50 source files changed. It is off by default.
- CNM_MCP_STRICT_FRESHNESS=1 refuses indexed reads unless the index is current. When combined with auto-update, strict mode checks the post-update state.
- Auto-update is synchronous and its 50-file threshold is not a wall-clock timeout. For large repositories or time-sensitive agent calls, prefer explicit index_update and inspect its result.

## Compact retrieval sequence

For a named implementation:

symbol_lookup -> file_details -> source_excerpt

For an exported API or high fan-in file:

index_freshness -> index_update if needed -> change_impact -> source_excerpt -> edit -> tests -> index_update -> source_excerpt

For an uncertain task:

memory_recall -> index_freshness -> task_context with anchors -> file_details/source_excerpt -> tests -> memory_propose if a stable lesson emerged

## Scope boundary

This document is a workflow recommendation, not a guarantee of complete program understanding. The parser indexes supported JavaScript/TypeScript files and statically resolvable structures. Runtime behavior, dynamic imports, framework magic, generated code, reflection, and unindexed files still require direct inspection and tests.
