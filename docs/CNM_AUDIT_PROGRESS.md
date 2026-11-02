# CNM Audit Progress

Audit started 2026-11-02. This is the live implementation ledger for CNM-01 through CNM-06. A merged change closes only the behavior covered by its evidence; broader workstream closure requires the remaining call-site audit and combined regression tests.

## Current status

- [x] **CNM-01 — Relation configuration freshness (PR #82):** freshness now fingerprints root and transitive extended TypeScript configs plus relevant project package manifests; configuration-only drift marks the index stale until a successful rebuild. CI run 41406437168 passed typecheck, tests, build, smoke, and benchmark jobs on supported runners. Merge: `2dc4c51c3dfad03a41ec6af6798bff4702dbb92e`.
- [x] **CNM-02 — Directory symlink replacement (PR #75):** a directory symlink scope is protected, and full reconciliation aborts rather than deleting previously indexed descendants. CI run 41404323034 passed. Merge: `3d7d94de32151b1f891308d7e661c945cfd694b9`. Remaining: audit other symlink scopes and combined failure paths.
- [x] **CNM-03 — Complete snapshot at full-index entry points (PR #79):** the CLI-facing `indexProject` path now requires a complete snapshot for unscoped runs; selective/budgeted runs remain non-destructive. CI run 41405788148 passed. Merge: `7b1f4b8b9edb4d1a8c73db1cac4ad38c9bbdaaf9`. Remaining: audit every destructive reconciliation path and failure injection cases.
- [x] **CNM-04 — Post-read freshness (PR #77):** indexed reads revalidate after the operation; strict mode refuses changed/unverifiable snapshots and non-strict mode warns. Deterministic mutation tests cover both modes. CI run 41405092697 passed. Merge: `e5fffa774c180aa45ea60195cf28dead2ea51f10`. Remaining: broader cross-process and multi-handler verification.
- [x] **CNM-05 — Safe project file reads and managed-instruction writes (PR #76, #89, #92, #95):** `source_excerpt`, indexer source reads, `.gitignore`, memory source fingerprints, and `AGENTS.md` use verified descriptor reads or equivalent identity/containment checks, including post-read path revalidation. Managed `AGENTS.md` writes now verify the opened object, reject symlink/hardlink targets, and use exclusive creation for new files. Outside-root symlinks fail closed. CI runs 41404690251, 41409758684, 41410395689, and 41410907119 passed. PR #89 merge: `f8c67219e974b3239accbd7bf93f3ebec26de39a`; PR #92 merge: `54aa52936a812494a6cbdd43c2429294ee603b82`; PR #95 merge: `9969869a3ad24a241a9967ae3221521b75ddb94d`. Remaining: audit config fingerprint/TypeScript config reads, directory-open races, and add deterministic race injection where feasible.
- [x] **CNM-06 — Deterministic bounded discovery (PR #84):** directory entries are sorted before `maxFiles` selection; when `maxProcessed` or the directory sorting safety cap is exceeded, indexing aborts before writes instead of committing an order-dependent partial set. Shuffled-creation-order regression coverage passed. CI run 41407210746 passed typecheck, tests, build, smoke, and benchmark jobs on Ubuntu, Windows, and macOS. Merge: `14b9d59ad397cd4357759da8b48ba7b91f4dac37`. Remaining: audit other bounded retrieval paths and complete combined CNM-01–CNM-06 regression coverage.

## Required close-out for the integrity workstream

- [ ] Audit every remaining path-based filesystem read/open for TOCTOU and root-containment guarantees, especially TypeScript/package config fingerprinting and directory traversal; managed AGENTS.md writes are now covered by PR #95.
- [ ] Audit every full/selective/budgeted index path and every destructive reconciliation call site.
- [ ] Add combined tests for directory symlink replacement, incomplete discovery, source drift, and relation configuration drift.
- [ ] Verify freshness/error semantics when configuration files are missing, malformed, or unreadable.
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
- [ ] Close the configuration error-state gap: `readConfigTextSafely` currently converts every safe-read failure to `undefined`; `loadPathAliasConfig`, `readLocalPackages`, and extended-config traversal can then silently omit invalid/unreadable configuration. Freshness hashes raw bytes/error codes, but does not expose a distinct actionable configuration diagnostic or consistently classify an invalid resolution configuration as incomplete.
- [x] Harden extended-config candidate discovery: candidate selection uses `lstat` and the verified config reader; missing candidates permit normal extension fallbacks, while symlink/unreadable candidates remain visible to freshness diagnostics. TypeScript's config host also uses the verified reader when parsing inherited configs. Package-manifest `tsconfig` metadata error semantics remain open.
- [ ] Close directory-open race coverage: discovery classifies entries with `Dirent`, then recursively calls `opendirSync(directory)` by path. A directory can be replaced between classification and open; source-file opens are separately root/identity checked, but directory enumeration itself has no verified directory-handle identity contract. Add deterministic replacement injection and fail-closed behavior where supported.
- [x] Close the configuration error-state gap for freshness: PR #116 reports malformed/unreadable relation configuration through bounded freshness diagnostics and marks the index `incomplete`. Resolution-time fallback behavior remains a separate audit item.
- [ ] Harden extended-config candidate discovery: `resolveExtendedConfigPath` uses path-based `existsSync` / `statSync` to select candidates before the final safe read. The final byte read is protected, but candidate selection and package-manifest interpretation need explicit missing/malformed/unreadable semantics and race tests.
- [x] Add directory identity checks before opening and after `opendirSync`, during enumeration, before entry processing, and after source reads; deterministic replacement injection proves fail-closed behavior. Node's path-based API still cannot bind these checks to the opened directory descriptor; retain that limitation.
- [x] Confirmed `readFileWithinRoot` validates the opened file against the resolved path before reading and again after reading; no source change is claimed by this audit-only finding.
- [ ] Complete the remaining candidate-discovery race audit and combined CNM-01/CNM-05 regression coverage before closing the workstreams.



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
- [x] PR #120 follow-up covers malformed and non-string `tsconfig` metadata in package manifests; symlink/unreadable manifest cases remain part of the broader security audit.
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


### Integrated CNM close-out regression — PR #122 (2026-11-02)

- [x] Add a combined regression for directory-to-symlink replacement, incomplete discovery, simultaneous source-file drift, and relation-configuration drift.
- [x] Assert the destructive reconciliation is refused and previously indexed file/symbol records remain intact.
- [x] Add a regression ensuring a symlinked package manifest encountered during TypeScript `extends` resolution is surfaced as an incomplete freshness diagnostic.
- [x] Make complete-snapshot indexing reject malformed/unsafe relation configuration before database writes and verify the relation-config fingerprint again before commit; roll back on drift.
- [x] Reject project-local relative `extends` paths that traverse symlinked parent directories; preserve explicitly external `extends` and package-manager symlinks under `node_modules`, and add a regression for the rejected local path.
- [x] Document the full-snapshot configuration fail-closed behavior in the README, distinguishing it from selective/bounded updates.
- [x] Add a strict MCP freshness regression where a second independent SQLite connection advances the index revision during a read; the first handler must refuse the mixed-snapshot result.
- [x] Add a strict MCP freshness regression where a directory is replaced by an outside-root symlink during the read; post-read discovery becomes incomplete and the result is refused.
- [ ] Re-run the complete GitHub Actions matrix on the latest PR head after correcting the integrated test fixture identified by the first run; verify typecheck, full tests, build, smoke, and benchmarks.
- [ ] Continue the cross-process/MCP-handler race audit and remaining destructive reconciliation call-site review; this PR does not close CNM-01–CNM-06 globally.
- [ ] Complete the CNM-05 audit of TypeScript program/dependency reads in `src/core/import-diagnostics.ts`: config bytes use the verified reader, but `ts.createProgram` and `ts.resolveModuleName` still rely on TypeScript's default filesystem host for dependency resolution; define and test the intended symlink/external-package boundary.
