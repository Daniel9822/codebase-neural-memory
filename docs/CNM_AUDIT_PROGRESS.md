# CNM Audit Progress

Audit started 2026-11-02. This is the live implementation ledger for CNM-01 through CNM-06. A merged change closes only the behavior covered by its evidence; broader workstream closure requires the remaining call-site audit and combined regression tests.

## Current status

- [x] **CNM-01 — Relation configuration freshness (PR #82):** freshness now fingerprints root and transitive extended TypeScript configs plus relevant project package manifests; configuration-only drift marks the index stale until a successful rebuild. CI run 41406437168 passed typecheck, tests, build, smoke, and benchmark jobs on supported runners. Merge: `2dc4c51c3dfad03a41ec6af6798bff4702dbb92e`.
- [x] **CNM-02 — Symlink-safe destructive reconciliation (PRs #75, #124, and #125):** directory and already-indexed file symlink scopes are protected; full reconciliation aborts rather than deleting previously indexed descendants or graph state. PR #124 CI run 41470817362 and PR #125 CI run 41471907118 passed all verification and benchmark jobs. PR #125 adds bounded handle/path enumeration comparison and a deterministic swap-and-restore regression. Merge #124: `ab1c51d023fc4f9bc9031dd4cd1d8e38e883068c`; merge #125: `cd834013e33aa8c5f5a5e805e4e0ebfac4293739`. Descriptor-bound traversal remains an explicit residual.
- [x] **CNM-03 — Complete snapshot at full-index entry points (PR #79):** the CLI-facing `indexProject` path requires a complete snapshot for unscoped runs; selective/budgeted runs remain non-destructive. CI run 41405788148 passed. Merge: `7b1f4b8b9edb4d1a8c73db1cac4ad38c9bbdaaf9`. Remaining: true future-call-site protection and broader failure injection; the current code audit found the file-index deletion path centralized in `indexer.ts`.
- [x] **CNM-04 — Post-read freshness (PR #77 and #126):** indexed reads revalidate after the operation; strict mode refuses changed/unverifiable snapshots and non-strict mode warns. PR #126 adds independent Node-process regressions for strict post-read revision changes and SQLite writer contention/recovery. PR-head CI run [41475613803](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41475613803) passed typecheck, full tests, build, smoke on Ubuntu/Windows and benchmarks on Ubuntu/Windows/macOS. PR #126 merged as `24974f82b8df690f1d1d2530b9a1451391d066a0`. Coverage is representative, not exhaustive across all scheduler orderings, power-loss scenarios, or network filesystems.
- [ ] **CNM-05 — Safe project file reads and managed-instruction writes (PRs #76, #89, #92, #95, #128):** `source_excerpt`, indexer source reads, `.gitignore`, memory source fingerprints, and `AGENTS.md` use verified descriptor reads or equivalent identity/containment checks, including post-read path revalidation. Managed `AGENTS.md` writes verify the opened object, reject symlink/hardlink targets, and use exclusive creation for new files. PR #128 adds a custom TypeScript compiler host: program source reads, module resolution and semantic package-manifest inspection use the verified reader; project-local non-`node_modules` symlink files fail closed, while package-manager links and TypeScript library files remain supported with final-component verification. Regression coverage confirms a symlinked dependency declaration is not consumed. PR #128 merged into `main` as `42ea75efa47076c3558b24d239d7e53cb37fe96b`; CI run [41505097212](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41505097212) passed Ubuntu/Windows verification (typecheck, tests, build, smoke) and Ubuntu/Windows/macOS benchmarks. CNM-05 remains open for TypeScript path-based directory-resolution operations, directory-open races, and deterministic race injection where feasible.
- [x] **CNM-06 — Deterministic bounded discovery (PR #84):** directory entries are sorted before `maxFiles` selection; when `maxProcessed` or the directory sorting safety cap is exceeded, indexing aborts before writes instead of committing an order-dependent partial set. Shuffled-creation-order regression coverage passed. CI run 41407210746 passed typecheck, tests, build, smoke, and benchmark jobs on Ubuntu, Windows, and macOS. Merge: `14b9d59ad397cd4357759da8b48ba7b91f4dac37`. Remaining: finish the cross-surface retrieval-budget/tie-breaker inventory.

### CNM-02 follow-up — destructive reconciliation call-site audit (2026-11-02)

- [x] Searched repository code for destructive file-index mutations. The only active file-record deletion path is `indexWithDatabase` in `src/core/indexer.ts`; it calls `clearFileIndex` and then deletes the `files` row. `clearFileIndex` removes FTS, symbols, imports, calls, and heritage rows. Foreign-key cascades cover dependent records such as unresolved imports.
- [x] Confirmed full-scope deletion is gated by discovery protection: missing indexed paths are retained when their exact path or an ancestor is in `protectedDirectories`; any symlink entry protects its lexical path before user ignore rules are applied.
- [x] Confirmed selective/budgeted indexing sets `scoped` and never enters the file-deletion branch. Complete-snapshot failures abort before the database transaction; later failures roll back the encompassing transaction, including relation rebuilds.
- [x] Added a regression where an already-indexed source file is replaced by a symlink. The test asserts incomplete freshness, zero reported deletions, full-update rejection, and preservation of file hashes, symbols, FTS rows, graph relations, and index revision (`tests/indexer.test.ts`).
- [x] Verify the indexed-file-to-symlink regression and full cross-platform CI on PR #124 head; run 41470817362 passed Ubuntu/Windows typecheck, tests, build, smoke, and Ubuntu/Windows/macOS benchmarks. PR #124 merged as `ab1c51d023fc4f9bc9031dd4cd1d8e38e883068c`.
- [x] Add a deterministic regression for a directory swapped to a symlink during `opendirSync` and restored before identity recheck; discovery compares bounded directory-entry snapshots from the opened handle and a second path-opened handle, and fails closed on disagreement (PR #125; CI run 41471907118 passed). The comparison is capped at the first snapshot size plus one sentinel.
- [ ] Keep descriptor-bound directory traversal and the residual race after path-based identity checks open; path-based `opendirSync` cannot bind the prior `lstat` identity to the opened descriptor. The second enumeration narrows/detects inconsistent views but does not eliminate every concurrent swap-and-restore race.

### CNM-04 follow-up — independent-process SQLite interleavings (2026-11-02)

- [x] Strict post-read validation refuses a result when an independent Node process advances the persisted index revision during the operation; preflight/post-read revisions are reported and the result is not exposed as verified current.
- [x] Independent writer contention while another connection holds `BEGIN IMMEDIATE` returns `SQLITE_BUSY` within the configured timeout without advancing the revision; after rollback, a new independent writer succeeds and advances exactly one revision.
- [x] PR #126 final CI run 41475613803 passed both verification jobs (Ubuntu/Windows typecheck, tests, build, smoke) and benchmark jobs (Ubuntu/Windows/macOS).
- [x] CNM-04 is closed for the representative process-level interleavings above; do not claim exhaustive scheduler or storage-failure coverage.

**Concurrency claim boundary:** deterministic process-level tests cover representative writer/read and writer/writer interleavings. They do not prove every possible OS scheduler interleaving, power-loss scenario, or behavior on network filesystems.

## Required close-out for the integrity workstream

- [ ] Finish the CNM-05 path-based filesystem audit: PR #128 is merged and its TypeScript source/config/dependency file-read host passed CI run 41505097212; review remaining path-based directory-resolution calls and descriptor-bound traversal before closure.
- [x] Audit every full/selective/budgeted index path and every destructive reconciliation call site (PR #124: file deletion centralized in `indexWithDatabase`/`clearFileIndex`; selective/budgeted updates are non-destructive; transaction rollback protects failed reconciliation).
- [x] Add combined tests for directory symlink replacement, incomplete discovery, source drift, and relation configuration drift (PR #122; CI 41460410372 passed).
- [x] Verify freshness/error semantics when configuration files are missing, malformed, or unreadable (PR #116; CI runs 41438435498 and 41438442638 passed; PR #122 adds all-scope write-abort coverage).
- [ ] Review all bounded candidate selection paths beyond file discovery for deterministic ordering and stable tie-breakers.
- [ ] Run final clean-checkout CI on the integrated main state and update the master checklist with final evidence.

## Evidence policy

- A checked item means the cited PR is merged and the referenced CI passed for that PR head.
- A partially addressed risk remains open under the broader close-out list above.
- No local test execution is claimed; validation evidence is from GitHub Actions run records.


### CNM-06 follow-up — index_update response details (2026-11-02)

- [x] Confirmed `index_update` could return unbounded `errors` and `skippedFiles` arrays even though discovery is capped at 100,000 examined entries.
- [x] Cap each diagnostic detail collection at 200 sorted entries, preserving exact counters and adding `totals`, `limits.detailItems`, and `detailsTruncated` metadata.
- [x] Add an MCP regression with 205 skipped symlink paths to prove exact totals, deterministic details, and explicit truncation.
- [x] Verify CI runs 41431584105 and 41431576683 and merge PR #110 (`da169033995f6c295aad0f28065968b367f1ad90`); broader MCP output-contract audit remains open.


### CNM-06 follow-up — CLI project map output budget (2026-11-02)

- [x] Confirmed the legacy `cnm map` command used `getProjectMap`, decoding every unresolved-import candidate array and accepting an unbounded file limit.
- [x] Switch the CLI to the shared bounded `getProjectMapReport` contract: 1–200 files, 200 nested rows per file, 200 candidates per import, and 2,000 candidate paths globally.
- [x] Surface exact file/candidate truncation and TypeScript import diagnostics in CLI output; candidate evidence remains fully persisted in SQLite.
- [x] Verify CI run 41434244151 passed and merge PR #112 (`b20429746fcb77c95856673baa52381854a42701`); continue auditing remaining CLI and MCP retrieval entry points.


### CNM-06 follow-up — file_details candidate output budget (2026-11-02)

- [x] Confirmed `getFileDetails` parsed each unresolved import's complete `candidates_json` array into JavaScript, bypassing the outer per-collection limit.
- [x] Bound candidates to 200 per import and 2,000 globally per selected file; expose per-import and aggregate totals/truncation metadata.
- [x] Add regression coverage for 11 imports with 1,000 candidates each and the bounded `task_context` projection.
- [x] Verify PR #111 CI run 41433329768 passed on Windows and Ubuntu verification plus Windows/Ubuntu/macOS benchmarks; merge commit `614b8db2de7837fcf251db3f0dd64bdb39a73293`. Broader MCP output-contract audit remains open.


### CNM-06 follow-up — symbol relation result ceiling (2026-11-02)

- [x] Confirmed `getSymbolRelations` accepted any positive safe integer, allowing arbitrarily large relation result materialization from the core/CLI API.
- [x] Enforce a 500-result ceiling in the core API and document the CLI limit.
- [x] Route the deprecated legacy `getProjectMap` API through `getProjectMapReport`, so external core callers also receive bounded candidate arrays and the 1–200 file limit; add regression coverage for its legacy projection.
- [x] Verify PR #113 CI run 41434956754 passed and merge commit `b2ecb2ab37482fe38016d14f742799426700b307` is on `main`.
- [ ] Complete the cross-surface audit of remaining CLI/MCP retrieval inputs, ordering, processing budgets, and truncation contracts.


### CNM-06 follow-up — CLI/index input-budget audit (2026-11-02)

- [x] Audited CLI retrieval ceilings against core validators: search (1–1,000), relations (1–500), project map (1–200), file details (1–500), component map (depth 1–20, groups 1–100, files/group 1–20), impact (results 1–5,000; processed 1–10,000), dependency traversal (depth 1–100; results 1–5,000; processed 1–10,000), symbol impact (depth 1–20; results 1–500; processed 1–10,000), task context (items 1–100; characters 100–50,000; per-kind 1–50), and memory recall (1–500).
- [x] Confirmed MCP schemas expose stricter or matching limits for registered retrieval tools; project-map/file-details nested candidate arrays, task-context test discovery, index diagnostics, Git history, and blame have bounded windows.
- [x] Found custom CLI/core index exclusions were the remaining repeated input list without a count/length ceiling; added a maximum of 100 non-empty patterns, each at most 500 characters, with regression coverage.
- [x] Added a 200-character non-empty symbol-name ceiling to core `explainSymbol` and `getSymbolRelations`; regression tests cover empty and oversized names.
- [x] Clarified CLI help for search, dependencies, memories, and repeated exclusion patterns so user-visible limits match core contracts.
- [x] Verify PR #114 merged as `89fe1f69028ca1d9483fafeaf02d8b9ca6f5bfde`; CI and merge are complete. The broader CNM-01–CNM-06 filesystem/freshness close-out and autonomous-memory implementation remain open.


### CNM-01 / CNM-05 follow-up — configuration reads and directory traversal audit (2026-11-02)

- [x] Confirmed relation-config bytes are read through `readFileWithinRoot` in `src/core/indexer.ts`; the shared reader uses a file descriptor, `O_NOFOLLOW` where available, root containment checks, descriptor/path identity checks, and post-read revalidation.
- [x] Confirmed `package.json` manifests used for local package resolution and TypeScript extended-config package metadata use the same safe byte reader.
- [x] PR #122 implements actionable freshness diagnostics and an all-scope preflight that rejects malformed, unreadable, or unsafe relation configuration before writes; CI 41460410372 passed and the PR is merged as `8790bf71aad57c74bbb120ba1c2b8feb707803dc`.
- [x] Harden extended-config candidate discovery: candidate selection uses `lstat` and the verified config reader; missing candidates permit normal extension fallbacks, while symlink/unreadable candidates remain visible to freshness diagnostics. TypeScript's config host also uses the verified reader when parsing inherited configs. PR #122 extends this to bare-package manifest metadata and all-scope fail-closed behavior; CI 41460410372 passed and the PR is merged.
- [ ] Retain the documented directory-open residual: discovery uses path-based `opendirSync`, and Node does not expose a way to bind the preceding `lstat` identity check to the opened directory descriptor. Existing before/after identity checks and deterministic replacement tests reduce the window but do not eliminate a swap-and-restore race.
- [x] Close the configuration error-state gap for freshness: PR #116 reports malformed/unreadable relation configuration through bounded freshness diagnostics and marks the index `incomplete`. Resolution-time fallback behavior remains a separate audit item.
- [x] PR #122 removes path-following existence checks, uses `lstat` plus the verified reader, fingerprints package manifests consulted by bare-package `extends`, and adds missing/malformed/symlink regressions; CI 41460410372 passed and PR #122 is merged.
- [x] Add directory identity checks before opening and after `opendirSync`, during enumeration, before entry processing, and after source reads; deterministic replacement injection proves fail-closed behavior. Node's path-based API still cannot bind these checks to the opened directory descriptor; retain that limitation.
- [x] Confirmed `readFileWithinRoot` validates the opened file against the resolved path before reading and again after reading; no source change is claimed by this audit-only finding.
- [x] PR #122 adds combined configuration/symlink/source-drift tests and pre/post fingerprint rollback coverage. External `node_modules` manifests used by semantic module resolution are covered by PR #123, merged as `a6f6f077d418f34aacf42ce7375e5ce0fc89fc2c`; final PR-head CI run 41468222761 passed.



### CNM-01 follow-up — invalid relation configuration diagnostics (2026-11-02)

- [x] Add freshness inspection for root and transitive TypeScript configs plus package manifests used by relation resolution.
- [x] Report malformed TypeScript JSON, missing extended configs, malformed package manifests, and unsafe/unreadable config files through bounded freshness errors; classify these states as `incomplete` instead of silently reporting `current`.
- [x] Add regression coverage for malformed `tsconfig.json`, a missing extended config, malformed `package.json`, and a final-component symlink config.
- [x] Verify PR #116 CI runs 41438435498 and 41438442638 passed; PR #116 is merged into `main`.
- [x] Directory identity checks are merged in PR #117. Residual limitation: Node's path-based opendirSync does not bind checks to the opened descriptor.


### CNM-01 / CNM-05 follow-up — inherited TypeScript config safe reads (2026-11-02)

- [x] Route `ts.parseJsonConfigFileContent` through a config host whose `readFile` uses `readConfigTextSafely`; inherited configs can no longer be read through TypeScript's default filesystem host.
- [x] Replace `existsSync` / `statSync` candidate selection for `extends` paths with `lstat` plus verified safe reads. Missing candidates still allow standard `.json` and `tsconfig.json` fallbacks; unsafe/unreadable candidates remain diagnosable.
- [x] Add a regression where the root config extends a final-component symlink to an outside config; no alias import relation may be created and freshness must be `incomplete`.
- [x] Verify inherited-config hardening in merged PR #118; cross-platform CI passed.
- [x] PR #122 adds final-component manifest symlink rejection, local symlink-parent rejection, package-manager directory-symlink compatibility, and all-scope abort tests; CI 41460410372 passed and PR #122 is merged.
- [x] Directory replacement race hardening is merged in PR #117; CI run 41439352404 passed across the required test/build/smoke and benchmark matrix.


### CNM-01 / CNM-05 follow-up — merged configuration diagnostics and directory identity (2026-11-02)

- [x] PR #116 merged into `main`; CI runs 41438435498 and 41438442638 passed. Malformed TypeScript/package JSON, missing `extends`, and unsafe/unreadable config paths now produce bounded freshness diagnostics and `incomplete` status.
- [x] Validate directory identity with `lstat`, canonical `realpath`, root containment, and device/inode identity before recursive enumeration.
- [x] Revalidate identity after directory open, while reading entries, before processing entries, and after source reads.
- [x] Add deterministic directory replacement injection through a narrow directory-opener seam; avoid spying on immutable ESM namespace exports.
- [x] Verify typecheck, full tests, build, smoke, and Linux/Windows/macOS CI on PR #117 head; run 41439352404 passed.
- [ ] Descriptor-relative directory opening remains unavailable through Node's path-based `opendirSync`; current repeated path identity checks are fail-closed detection, not an `openat`/descriptor-bound guarantee.


### CNM-01 / CNM-05 reconciliation after PRs #117 and #118 (2026-11-02)

- [x] PR #117 merged as `2daebc4f14446287ecf39729a09b093bf994b127`; CI run [41439352404](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41439352404) passed the test/build/smoke and benchmark matrix. Directory identity checks and deterministic replacement regression are in `main`.
- [x] PR #118 merged as `d10bc6e9f5a05ca78766477bf93640ca92cf54bf`; inherited TypeScript config parsing uses the verified reader and final-component symlink regression is in `main`.
- [x] Reconciled stale audit entries that incorrectly described #117/#118 as unmerged or validation-pending.
- [ ] Keep descriptor-relative directory traversal and extended package-manifest race semantics open until stronger guarantees and broader regression coverage are established.


### CNM-06 follow-up — bounded memory freshness

- [x] Bound `inspectMemoryFreshness` to 100 records by default and 500 maximum (PR #122).
- [x] Add targeted memory-ID freshness inspection (maximum 50 IDs) so `task_context` hashes only the memory candidates it actually returns (PR #122).
- [x] Change `cnm memory freshness` to use the bounded report, expose `--limit` (1–500), and return total/truncation metadata (PR #122).
- [x] Verify the CLI report's default budget of 100 as well as explicit limit/truncation behavior in `tests/memories.test.ts` (PR #122; CI 41460410372 passed).
- [x] Add a synthetic 100,001-entry directory regression proving the deterministic sorting cap aborts discovery, marks the root protected, and returns no partial candidate set (PR #122).
- [x] Inject the discovery provider into freshness evaluation for deterministic testing; assert the sorting cap reports `incomplete`, preserves all indexed records, emits no false deletions, and leaves the index revision unchanged. The 100,001-entry fixture uses a 30-second timeout for cross-platform filesystem overhead (PR #122; CI 41460410372 passed).
- [x] Update README, architecture, and product-contract documentation to match the CLI and context budgets (PR #122).
- [x] Verify final cross-platform CI on PR #122 head: run 41460410372 passed verify (typecheck, tests, build, smoke) on Ubuntu and Windows and benchmarks on Ubuntu, Windows, and macOS. PR #122 merged as `8790bf71aad57c74bbb120ba1c2b8feb707803dc`.

### Integrated CNM close-out regression — PR #122 (2026-11-02)

- [x] Add a combined regression for directory-to-symlink replacement, incomplete discovery, simultaneous source-file drift, and relation-configuration drift. (PR #122; CI 41460410372 passed; merged to `main`).
- [x] Assert the destructive reconciliation is refused and previously indexed file/symbol records remain intact. (PR #122; CI 41460410372 passed; merged to `main`).
- [x] Add a regression ensuring a symlinked package manifest encountered during TypeScript `extends` resolution is surfaced as an incomplete freshness diagnostic. (PR #122; CI 41460410372 passed; merged to `main`).
- [x] Make every index-update scope reject malformed/unsafe relation configuration before database writes and verify the relation-config fingerprint again before commit; any detected drift rolls back the transaction. (PR #122; CI 41460410372 passed; merged to `main`).
- [x] Reject project-local relative `extends` paths that traverse symlinked parent directories; preserve explicitly external `extends` and package-manager symlinks under `node_modules`, and add a regression for the rejected local path. (PR #122; CI 41460410372 passed; merged to `main`).
- [x] Add regressions proving malformed/unsafe relation configuration blocks both full and selective updates before writes, preserving the prior index revision and relation graph. (PR #122; CI 41460410372 passed; merged to `main`).
- [x] Verify the relation-config fingerprint before and after every update scope; inject a config change after preflight and assert the scoped transaction rolls back file hashes, relations, and index revision. (PR #122; CI 41460410372 passed; merged to `main`).
- [x] Include package manifests consulted during bare-package `extends` resolution in the configuration fingerprint and diagnostics, including missing candidates; add a regression proving that changing the manifest's `tsconfig` target makes freshness stale. (PR #122; CI 41460410372 passed; merged to `main`).
- [x] Add positive regressions proving explicit external `extends` targets and package-manager symlinks under `node_modules` remain supported by the documented trust boundary. (PR #122; CI 41460410372 passed; merged to `main`).
- [x] Bind project-local config reads to the canonical project root, reject symlinked parent directories, remove path-following `existsSync` candidate checks, and disable config-driven directory enumeration in both TypeScript config hosts. (PR #122; CI 41460410372 passed; merged to `main`).
- [x] Remove path-following existence prechecks for package manifests and the root semantic-diagnostics config; attempt the verified read directly and preserve normal missing-config fallback behavior. (PR #122; CI 41460410372 passed; merged to `main`).
- [x] Document the full-snapshot configuration fail-closed behavior in the README, distinguishing it from selective/bounded updates. (PR #122; CI 41460410372 passed; merged to `main`).
- [x] Add a strict MCP freshness regression where a second independent SQLite connection advances the index revision during a read; the first handler must refuse the mixed-snapshot result. (PR #122; CI 41460410372 passed; merged to `main`).
- [x] Add a strict MCP freshness regression where a directory is replaced by an outside-root symlink during the read; post-read discovery becomes incomplete and the result is refused. (PR #122; CI 41460410372 passed; merged to `main`).
- [x] Re-run the complete GitHub Actions matrix on the latest PR head after the follow-up fixes: the local-extends fixture now excludes its symlink directory to isolate config diagnostics; the semantic-diagnostics reader has been consolidated, and local config reads are revalidated after the descriptor-bound read. Runs 41456135085 and 41456423882 exercised earlier PR heads and are not final validation. Verify typecheck, full tests, build, smoke, and benchmarks. (PR #122; CI 41460410372 passed; merged to `main`).
- [ ] Continue the cross-process/MCP-handler race audit and remaining destructive reconciliation call-site review; this PR does not close CNM-01–CNM-06 globally.
- [ ] Complete the CNM-05 audit of TypeScript program/dependency reads in `src/core/import-diagnostics.ts`: config bytes use the verified reader, but `ts.createProgram` and `ts.resolveModuleName` still rely on TypeScript's default filesystem host for dependency resolution; define and test the intended symlink/external-package boundary.


### CNM-01 follow-up — TypeScript semantic dependency manifest freshness (2026-11-02)

- [x] Track the `package.json` files actually consulted when TypeScript resolves imports from indexed source files, including resolver-observed missing candidates; do not scan all of `node_modules` (PR #123).
- [x] Include deterministic path + content/missing-state fingerprints in the persisted relation-configuration fingerprint so dependency metadata drift invalidates freshness and triggers relation/diagnostic rebuilding (PR #123).
- [x] Read consulted manifests through the verified safe reader; reject final-component symlinks, classify malformed or unreadable manifests as `incomplete`, and fail closed on the manifest inspection budget (PR #123).
- [x] Add regressions proving a used dependency manifest change marks freshness stale, an unused package manifest change does not, and unsafe/malformed consulted manifests block index updates (`tests/integrity-combined.test.ts`; PR #123).
- [x] Verify full typecheck, tests, build, smoke, and Ubuntu/Windows/macOS benchmark CI on the final code head: run 41467736510 passed every job (PR #123).


### CNM-04 follow-up — independent-process SQLite interleavings (2026-11-02)

- [x] Confirmed the existing second-connection regression was not an independent-process test; same-process MCP concurrency does not prove cross-process behavior.
- [x] Added a child Node process that opens the same SQLite database independently and advances `index_revision` during the read callback; strict post-read validation must refuse the result and report the exact preflight/post-read revisions.
- [x] Added a writer-contention regression: hold `BEGIN IMMEDIATE` in the parent process, verify an independent writer receives `SQLITE_BUSY` without changing the revision, release the lock, then verify a fresh independent writer succeeds and advances exactly one revision.
- [ ] Add/verify any further transaction-boundary interleavings identified by review; these deterministic tests cover representative process boundaries, not every theoretically possible scheduler interleaving.
- [ ] Run final PR-head typecheck, complete tests, build, smoke, and Linux/Windows/macOS benchmark matrix before marking CNM-04 complete.
- **Scope limitation:** SQLite locking is tested using independent processes on the CI runner's local filesystem. This does not establish correctness for unsupported network filesystems, arbitrary power-loss timing, or every possible OS scheduler ordering.
