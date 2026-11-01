# Phase 8 — Benchmark methodology and initial baseline

## How to run

From a clean checkout with dependencies installed:

```bash
npm ci --no-audit --no-fund
npm run benchmark
```

The command creates temporary repositories, indexes and measures them, then removes them. It prints one JSON report to stdout. It does not write benchmark artifacts into the repository, contact external services, or apply performance thresholds.

CI runs the benchmark in a separate Linux/Windows/macOS matrix job. The original synthetic baseline measurements below are from Linux-only GitHub Actions run [41253753337](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41253753337); cross-platform real-repository measurements are from matrix run [41254663323](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41254663323).

## Fixture design

The generator creates three deterministic TypeScript repositories and also measures the checked-out repository without writing into it:

| Case | Source files | Generated modules | Shape |
|---|---:|---:|---|
| Small | 26 | 25 | One labeled domain file plus a 25-module import chain |
| Medium | 101 | 100 | One labeled domain file plus a 100-module import chain |
| Large | 301 | 300 | One labeled domain file plus a 300-module import chain |

The shared labeled retrieval corpus contains ten symbol queries with one or more relevant symbols per query. The domain fixture is held constant across scales; generated modules add repository size and graph depth without adding matching names for the labeled domain queries. A separate real-repository case indexes the current CNM checkout into a temporary database directory outside the repository and removes that directory after measurement.

## Measurement protocol

- Initial index: one clean index per fixture.
- Unchanged incremental index: one immediate second index with no source changes.
- Changed incremental index: append one deterministic comment to the last generated module and index again.
- Search: 25 samples of `searchSymbols("calculateAverage", 20)`.
- Graph: 25 samples of a depth-5 dependency traversal from the final generated module.
- Freshness: 10 samples of `getIndexFreshness`.
- Latencies report median and p95 in milliseconds.
- Retrieval reports top-1 accuracy, precision@5, recall@5, and mean reciprocal rank (MRR) over the ten labeled queries.
- Database size includes the SQLite database and any remaining WAL/SHM files.
- RSS is measured with Node's process resource usage. Per-case RSS snapshots and the process high-water mark are reported; the cases run sequentially in one process, so the high-water mark is cumulative rather than an isolated per-case peak.

## Initial CI baseline

Environment: GitHub-hosted `ubuntu-latest`, Node.js `v22.23.3`, Linux x64.

| Metric | Small (26 files) | Medium (101 files) | Large (301 files) |
|---|---:|---:|---:|
| Initial index (ms) | 47.535 | 69.476 | 128.657 |
| Unchanged index (ms) | 10.961 | 20.139 | 17.582 |
| One-file changed index (ms) | 12.752 | 15.693 | 20.381 |
| Search median / p95 (ms) | 0.856 / 1.029 | 0.871 / 1.094 | 1.006 / 1.055 |
| Graph median / p95 (ms) | 0.799 / 0.968 | 0.792 / 0.817 | 0.922 / 0.953 |
| Freshness median / p95 (ms) | 4.899 / 8.009 | 6.623 / 7.085 | 10.135 / 17.165 |
| Database bytes | 180,224 | 327,680 | 684,032 |
| Process peak RSS at case end (bytes, cumulative) | 238,170,112 | 249,966,592 | 250,359,808 |

### Real repository case

The same CI run also measured the checked-out `codebase-neural-memory` repository (28 supported TypeScript source files). The index database lived in a temporary directory outside the checkout; no repository source files were modified.

| Metric | Result |
|---|---:|
| Initial index | 616.795 ms |
| Unchanged index | 93.846 ms |
| Search median / p95 | 1.796 / 1.892 ms |
| Graph median / p95 | 1.895 / 2.557 ms |
| Freshness median / p95 | 46.777 / 52.346 ms |
| Database bytes | 294,912 |
| Process peak RSS | 254,279,680 bytes |

Evidence: [GitHub Actions run 41254266525](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41254266525), Ubuntu Linux x64 / Node.js v22.23.3. This is one real repository layout, not a representative cross-project sample.

### Cross-platform real-repository baseline

The checked-out CNM repository (28 supported TypeScript files) was measured on all three matrix runners in CI run [41254663323](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41254663323). Each runner used a temporary database outside the source tree. All three benchmark jobs and the Ubuntu verification job passed.

| Runner | Initial index | Unchanged index | Search median / p95 | Graph median / p95 | Freshness median / p95 | Database bytes | Process peak RSS bytes |
|---|---:|---:|---:|---:|---:|---:|---:|
| Ubuntu Linux x64 | 557.049 ms | 52.657 ms | 1.156 / 1.268 ms | 1.122 / 1.347 ms | 21.027 / 25.853 ms | 294,912 | 255,401,984 |
| macOS | 213.423 ms | 85.154 ms | 1.064 / 1.278 ms | 1.074 / 1.214 ms | 56.312 / 79.594 ms | 294,912 | 257,228,800 |
| Windows | 811.163 ms | 457.688 ms | 2.161 / 2.378 ms | 2.266 / 3.245 ms | 171.971 / 188.847 ms | 294,912 | 183,410,688 |

These are single-run observations on hosted runners, not a reliable ranking of operating systems. Filesystem cache, runner hardware, virtualization, and host load differ; repeat measurements before drawing conclusions or setting thresholds.

### Cross-platform real-repository baseline

The checked-out CNM repository (28 supported TypeScript files) was measured on all three matrix runners in CI run [41254663323](https://github.com/Daniel9822/codebase-neural-memory/actions/runs/41254663323). Each runner used a temporary database outside the source tree. All three benchmark jobs and the Ubuntu verification job passed.

| Runner | Initial index | Unchanged index | Search median / p95 | Graph median / p95 | Freshness median / p95 | Database bytes | Process peak RSS bytes |
|---|---:|---:|---:|---:|---:|---:|---:|
| Ubuntu Linux x64 | 557.049 ms | 52.657 ms | 1.156 / 1.268 ms | 1.122 / 1.347 ms | 21.027 / 25.853 ms | 294,912 | 255,401,984 |
| macOS | 213.423 ms | 85.154 ms | 1.064 / 1.278 ms | 1.074 / 1.214 ms | 56.312 / 79.594 ms | 294,912 | 257,228,800 |
| Windows | 811.163 ms | 457.688 ms | 2.161 / 2.378 ms | 2.266 / 3.245 ms | 171.971 / 188.847 ms | 294,912 | 183,410,688 |

These are single-run observations on hosted runners, not a reliable ranking of operating systems. Filesystem cache, runner hardware, virtualization, and host load differ; repeat measurements before drawing conclusions or setting thresholds.

Retrieval metrics were identical across the three scales because the labeled domain fixture is held constant:

| Metric | Result |
|---|---:|
| Labeled queries | 10 |
| Top-1 accuracy | 1.000 |
| Mean precision@5 | 0.260 |
| Mean recall@5 | 0.817 |
| Mean reciprocal rank | 1.000 |

## Agent evaluation status

The exploratory transcript artifact `benchmarks/agent-results-2026-11-01.json` is retained for diagnostic context, but it is not a valid paired benchmark. The protocol audit found unverified/mismatched repository commits, different agent identities and missing client/model metadata, prompt drift for at least one task, missing timing/token metrics, provisional unblinded scoring, and unequal source-inspection capability between conditions.

Consequently, its provisional scores and winner labels must not be aggregated or cited as evidence that CNM helps or harms agent performance. The artifact is useful only for identifying an integration issue to investigate: the CNM-enabled sessions reported that `source_excerpt` was unavailable to the client, while the control agent could inspect source directly. This must be diagnosed at the client/tool-discovery boundary before interpreting agent outcomes.

The reproducible protocol and comparability gates are in [AGENT_EVALUATION_PROTOCOL.md](AGENT_EVALUATION_PROTOCOL.md). The current eight tasks are specific to this repository; controlled small/medium/large repository suites and paired runs remain outstanding.

## Interpretation and limitations

- These are descriptive baseline measurements from one GitHub-hosted Linux runner, not universal performance guarantees.
- The retrieval corpus is a small, hand-labeled symbol-search fixture. It does not establish quality for large real repositories, file-level retrieval, task-context ranking, or other languages.
- Precision@5 uses a fixed denominator of five; a low value can coexist with high recall when each query has only one or two labeled relevant symbols.
- The unchanged-index timings vary with runtime and filesystem cache state; do not infer a speedup from one run.
- The RSS high-water mark is cumulative across the three sequential fixture cases.
- No agent task comparison has been run. A controlled comparison must hold repository, task, model, prompt, and run conditions constant.
- No optimization thresholds are set until repeated baselines across supported operating systems and real repositories exist.

## Next evaluation work

1. Add a checked-in or generated real-world repository fixture with a known source layout and expected relationships.
2. Expand labeled retrieval cases to file-level and task-context queries with independently reviewed relevance judgments.
3. Execute the paired tasks in [`benchmarks/agent-tasks.json`](../benchmarks/agent-tasks.json) using [`docs/AGENT_EVALUATION_PROTOCOL.md`](AGENT_EVALUATION_PROTOCOL.md), with and without CNM.
4. Repeat baselines on Windows and macOS before setting regression thresholds.
