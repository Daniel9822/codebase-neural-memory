# CNM Audit Progress

Audit started 2026-11-02. This is the live implementation ledger for CNM-01 through CNM-06. A merged change closes only the behavior covered by its evidence; broader workstream closure requires the remaining call-site audit and combined regression tests.

## Current status

- [x] **CNM-01 — Relation configuration freshness (PR #82):** freshness now fingerprints root and transitive extended TypeScript configs plus relevant project package manifests; configuration-only drift marks the index stale until a successful rebuild. CI run 41406437168 passed typecheck, tests, build, smoke, and benchmark jobs on supported runners. Merge: `2dc4c51c3dfad03a41ec6af6798bff4702dbb92e`.
- [x] **CNM-02 — Directory symlink replacement (PR #75):** a directory symlink scope is protected, and full reconciliation aborts rather than deleting previously indexed descendants. CI run 41404323034 passed. Merge: `3d7d94de32151b1f891308d7e661c945cfd694b9`. Remaining: audit other symlink scopes and combined failure paths.
- [x] **CNM-03 — Complete snapshot at full-index entry points (PR #79):** the CLI-facing `indexProject` path now requires a complete snapshot for unscoped runs; selective/budgeted runs remain non-destructive. CI run 41405788148 passed. Merge: `7b1f4b8b9edb4d1a8c73db1cac4ad38c9bbdaaf9`. Remaining: audit every destructive reconciliation path and failure injection cases.
- [x] **CNM-04 — Post-read freshness (PR #77):** indexed reads revalidate after the operation; strict mode refuses changed/unverifiable snapshots and non-strict mode warns. Deterministic mutation tests cover both modes. CI run 41405092697 passed. Merge: `e5fffa774c180aa45ea60195cf28dead2ea51f10`. Remaining: broader cross-process and multi-handler verification.
- [x] **CNM-05 — Safe source excerpt open/read (PR #76):** reads use a verified file descriptor, post-open containment and file identity checks; outside-root symlink substitution is rejected. CI run 41404690251 passed. Merge: `da7e7fd90a15a39af551237ca7c3ee6868ccc43a`. Remaining: audit all other path-based reads and add deterministic race injection where feasible.
- [x] **CNM-06 — Deterministic bounded discovery (PR #84):** directory entries are sorted before `maxFiles` selection; when `maxProcessed` or the directory sorting safety cap is exceeded, indexing aborts before writes instead of committing an order-dependent partial set. Shuffled-creation-order regression coverage passed. CI run 41407210746 passed typecheck, tests, build, smoke, and benchmark jobs on Ubuntu, Windows, and macOS. Merge: `14b9d59ad397cd4357759da8b48ba7b91f4dac37`. Remaining: audit other bounded retrieval paths and complete combined CNM-01–CNM-06 regression coverage.

## Required close-out for the integrity workstream

- [ ] Audit every path-based filesystem read/open for TOCTOU and root-containment guarantees.
- [ ] Audit every full/selective/budgeted index path and every destructive reconciliation call site.
- [ ] Add combined tests for directory symlink replacement, incomplete discovery, source drift, and relation configuration drift.
- [ ] Verify freshness/error semantics when configuration files are missing, malformed, or unreadable.
- [ ] Review all bounded candidate selection paths beyond file discovery for deterministic ordering and stable tie-breakers.
- [ ] Run final clean-checkout CI on the integrated main state and update the master checklist with final evidence.

## Evidence policy

- A checked item means the cited PR is merged and the referenced CI passed for that PR head.
- A partially addressed risk remains open under the broader close-out list above.
- No local test execution is claimed; validation evidence is from GitHub Actions run records.
