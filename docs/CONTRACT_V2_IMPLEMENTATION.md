# Contract v2 — implementation and verification plan

This document turns the v2 proposal into implementation gaps. It distinguishes repository facts inspected on `main` from behavior demonstrated by the external `itachi-bot` runtime matrix. It does not claim that the external matrix has been independently reproduced here.

## Baseline inspected

Baseline: `main` after PR #60 (`d4d0fdfd39a848d30bc6456360dbc228f5c12ae7`).

Already present on the baseline:

- File freshness with exact paths and hashes, inline source snippets, anchored task context, lifecycle-aware memory recall, and opt-in MCP auto-update / strict freshness.
- `cnm agents-md` generation and managed-block updates, `--check`, `--print`, tool flavors, `--force`, idempotence, and preservation of user-authored `AGENTS.md` content.
- TypeScript semantic import diagnostics persisted in `import_diagnostics`, including TypeScript missing-module and missing-export diagnostics. `project_map` already exposes them with bounded totals/truncation.
- Existing generated agent instructions already warn that CNM is not a compiler and require build/test validation.

Important gap found during this audit: `file_details` did not expose the persisted semantic import diagnostics, even though `project_map` did. This made a file-focused MCP workflow appear blind to diagnostics that the index had already computed.

## Implementation gaps and decisions

### NP1 — evolve, do not replace

The existing `agents-md` implementation is retained. It owns only its marked section, preserves surrounding user-authored content, protects symlinks/directories, and requires `--force` to replace a manually edited managed block.

The v2 instruction content is being tightened to:
- inspect semantic import diagnostics from `file_details` and `project_map`;
- distinguish diagnostics from a complete compiler run;
- keep external reads for configuration, manifests, tests, compiler output, unsupported files, and exact diff verification;
- retain explicit memory approval boundaries and one-shot freshness recovery.

A separate `AGENTS.cnm.md` fallback and interactive `--merge` diff are not introduced: the existing managed-block strategy is already non-destructive and avoids creating competing instruction files.

### NP2 — expose the diagnostics consistently

The TypeScript analyzer and persistence already exist. This change exposes per-file diagnostics through `file_details`, bounded by the same per-collection limit and accompanied by totals/truncation metadata. The result includes module specifier, diagnostic kind/code/message, line/column, and imported name.

Supported diagnostic classes currently include TypeScript missing-module and missing-export codes. This remains static analysis over indexed source files, not a replacement for `tsc`, a bundler, runtime module loading, or tests. Dynamic imports and unsupported/unindexed files may remain outside coverage.

### P2 — auto-update failure and snapshot hardening

The successful auto-update path remains bounded to at most 50 changed source files and refuses incomplete discovery. This change hardens the update transaction itself:

- Automatic reconciliation now requires complete discovery; skipped, unreadable, or protected source paths abort before any database write.
- Per-file parse/index failures abort and roll back the whole automatic update instead of committing a partial revision.
- A second source discovery compares every supported path and SHA-256 hash before commit. File drift or newly incomplete discovery aborts and rolls back the transaction.
- Git snapshot drift continues to abort the transaction.
- MCP auto-update failures are caught and reported. Strict freshness returns a structured refusal with the skipped/failure reason and never serves stale indexed data; non-strict mode labels the failed refresh and retains the freshness warning.
- Successful auto-update is announced only after the post-update freshness check reports `current`.
- Concurrent MCP read requests in the same Node process are covered; the index/update path is synchronous, so those handlers cannot interleave their refresh transactions on the event loop. Cross-process contention remains governed by SQLite transaction locking and is not claimed as covered by this test.

Covered by MCP adapter tests: incomplete discovery, the 50-file ceiling, forced SQLite relation failure with rollback, strict refusal after failure, and concurrent reads producing one index revision.

The second-discovery guard is implemented to detect source drift during reconciliation. A deterministic race-injection test is not currently provided; the guard should not be described as race-proof against changes occurring after its final verification point.

### NP5 — diagnostic provenance and confidence (follow-up)

Future diagnostics should state their analysis source (for example, TypeScript semantic analysis) and distinguish confirmed compiler diagnostics from incomplete/unknown resolution. Do not invent confidence scores for deterministic compiler diagnostics.

### NP6 — response integrity metadata (follow-up)

Freshness and index revision metadata already exist in several MCP responses. Audit response consistency before adding duplicate fields. Any new common envelope should identify index revision, freshness, whether auto-update ran, whether discovery/reconciliation was complete, and any truncation.

### NP7 — agent behavior acceptance (follow-up)

Add reproducible agent-task scenarios for symbol discovery, implementation explanation, dependency inspection, broken-import diagnosis, durable memory proposal, and compiler/build validation. Measure unnecessary external reads only when the requested information is actually available from current indexed MCP data; necessary reads of configuration, tests, documentation, and compiler output are not failures.

## Acceptance criteria

- [x] `file_details` returns bounded semantic import diagnostics with totals and truncation metadata.
- [x] Missing package and missing named-export cases are covered by retrieval tests.
- [x] MCP adapter test verifies the same diagnostics are present in the actual `file_details` tool response.
- [ ] Full typecheck, complete tests, build, smoke, and cross-platform CI pass on the final PR head.
- [x] P2 tests cover incomplete discovery, the 50-file ceiling, transactional rollback, strict refusal after failure, and same-process concurrent reads. Source-drift revalidation is implemented; a deterministic race-injection test remains open.
- [ ] Agent behavior scenarios are exercised against a real supported MCP client.

## Validation record

Implementation is proposed on `feat/auto-update-failure-hardening`. No local test suite or build has been run in this session. CI results must be recorded against the final PR head before treating this work as validated.
