# CNM Audit Progress

Audit started 2026-11-02 against main. Source inspection has identified follow-up verification required for CNM-01 through CNM-06. No implementation item is closed until regression tests and CI evidence are recorded.

- [ ] CNM-01 relation configuration freshness: inspect inputs and verify tests.
- [ ] CNM-02 directory symlink protection: test replacement of indexed directory with symlink.
- [ ] CNM-03 selective reconciliation: audit every destructive path under incomplete discovery.
- [ ] CNM-04 MCP read consistency: audit snapshot checks around reads.
- [ ] CNM-05 safe file reads: audit path validation/open/read sequence.
- [ ] CNM-06 deterministic bounded selection: audit candidate ordering and truncation.
