# CNM Audit Progress

Audit started 2026-11-02 against main. Source inspection has identified follow-up verification required for CNM-01 through CNM-06. No implementation item is closed until regression tests and CI evidence are recorded.

- [ ] CNM-01 relation configuration freshness: inspect inputs and verify tests.
- [ ] CNM-02 directory symlink protection: test replacement of indexed directory with symlink.
- [ ] CNM-03 selective reconciliation: audit every destructive path under incomplete discovery.
- [ ] CNM-04 MCP read consistency: audit snapshot checks around reads.
- [ ] CNM-05 safe file reads: audit path validation/open/read sequence.
- [ ] CNM-06 deterministic bounded selection: audit candidate ordering and truncation.

## Progress update — CNM-02

- [x] CNM-02 directory symlink protection implemented and merged in PR #75.
- Regression: index a real directory, replace it with a symlink to an outside directory, run full index update, verify it aborts and retains the prior indexed file row.
- CI: run 41404323034 passed on Ubuntu and Windows for typecheck, full tests, build, and smoke; benchmark jobs passed on Ubuntu, Windows, and macOS.
- Merge commit: `3d7d94de32151b1f891308d7e661c945cfd694b9`.
- Remaining qualification: this closes the tested directory-replacement case. Continue auditing other symlink scopes and combined failure cases before declaring the full integrity workstream complete.

## Progress update — CNM-05 and CNM-06 audit

- [ ] CNM-05 safe file reads: PR #76 opened with descriptor-based reads, post-open canonical containment, file identity checks, and an outside-root symlink substitution regression. CI run 41404690251 is in progress; the first run exposed a malformed test fixture, which was corrected in the current head. Keep the item open until the latest CI passes and the remaining filesystem read sites are audited.
- [ ] CNM-06 deterministic limits: source inspection found that `discoverFiles` streams raw directory enumeration order and stops when `maxFiles` / `maxProcessed` budgets are reached, sorting only the selected output afterward. This can make the selected subset depend on filesystem enumeration order. Design a deterministic bounded policy that does not silently violate the processing budget, then add shuffled-order regression tests.
