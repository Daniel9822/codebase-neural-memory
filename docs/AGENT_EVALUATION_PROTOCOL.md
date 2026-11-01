# Controlled agent evaluation protocol

## Purpose

Compare repository-understanding performance with and without CNM MCP context. This protocol is a reproducible setup, not a claim that CNM improves task performance. No agent runs or outcome scores have been collected yet.

## Fixed inputs

- Repository: `Daniel9822/codebase-neural-memory`
- Reference commit: `4e57cadc49fedea2f88359a204c10568c3dece48`
- Task set: `benchmarks/agent-tasks.json`
- Results template: `benchmarks/agent-results.template.json`
- Tasks are read-only navigation, code-understanding, and debugging prompts. Do not edit source files during a run.

## Conditions

**Control — without CNM**
- Use the selected agent client with its normal editor, terminal, and file-search tools.
- Do not configure or invoke the CNM MCP server.
- Do not provide precomputed CNM search results or CNM-generated summaries.

**Treatment — with CNM**
- Use the same agent client, model, settings, tools, and workspace.
- Configure the CNM MCP server against the same repository checkout and run `cnm init` plus `cnm index` before the session.
- Allow the agent to discover and call CNM MCP tools normally.

## Run procedure

1. Create two fresh worktrees or clones at the exact reference commit. Do not reuse conversation history, shell state, or CNM memory databases between replicates.
2. Keep the same OS, Node version, agent client/version, model identifier, context/token budget, tool permissions, and timeout for both conditions.
3. Run every task once in each condition for a pilot. For a scored comparison, use at least three independent replicates per task and condition.
4. Alternate or randomize condition order per task to reduce order and warm-cache bias.
5. Submit only the task `prompt` to the evaluated agent. Do not show `expectedEvidence` or `acceptance` until scoring.
6. Save the complete answer and record elapsed time, token usage when exposed by the client, and tool-call count. If a client does not expose a metric, record `null`; do not estimate it.
7. Score answers after both conditions are complete. Prefer a reviewer who does not know which condition produced the answer.

## Scoring rubric

Score each dimension from 0 to 4:

| Score | Meaning |
|---:|---|
| 0 | Missing or materially incorrect |
| 1 | Mostly incorrect; only isolated correct facts |
| 2 | Partially correct; important omissions |
| 3 | Correct with minor omissions |
| 4 | Complete, accurate, and supported by concrete evidence |

Dimensions:
- **Correctness:** technical facts and behavior match the reference commit.
- **Completeness:** all requested parts and acceptance points are addressed.
- **Evidence:** relevant file paths, symbol names, and line references support claims.
- **Calibration:** limitations and unknowns are stated rather than invented.

Total score: 0–16 per task run. Also record binary task success only when correctness and evidence are each at least 3 and no critical false claim appears.

## Reported metrics

Report per task and per condition:
- task success rate and mean/median rubric score;
- median completion time;
- median input/output tokens when available;
- median tool calls;
- all individual replicate scores.

Compare paired task-level results. Do not aggregate across unlike task categories without showing the per-category results. A small sample or one model/client is not sufficient for a general claim.

## Validity controls

- Do not change the task wording between conditions.
- Do not change the repository commit or model version between paired runs.
- Do not let the treatment reuse indexed state from another task or replicate.
- Do not give the treatment more time, context, tools, or retries.
- Do not interpret fewer tool calls as better unless correctness and completeness are maintained.
- Record any environmental interruption and exclude/re-run the paired task in both conditions.

## Current status

The eight-task read-only suite and protocol are checked in. The actual paired agent runs remain pending; no measured CNM advantage is claimed. The initial suite evaluates navigation and debugging, not code-change success. A later task set should add controlled implementation tasks before drawing conclusions about coding productivity.
