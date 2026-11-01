# Controlled agent evaluation protocol

## Purpose

Compare repository-understanding performance with and without CNM MCP context. This protocol defines a reproducible experiment; it is not evidence that CNM improves agent performance.

An exploratory transcript record exists in `benchmarks/agent-results-2026-11-01.json`. It is retained as qualitative diagnostic evidence only. It is **not a valid paired benchmark** and must not be used to claim a winner, a performance delta, or a measured CNM advantage/disadvantage.

## Fixed inputs

- Repository: `Daniel9822/codebase-neural-memory`
- Reference commit: `4e57cadc49fedea2f88359a204c10568c3dece48`
- Task set: `benchmarks/agent-tasks.json`
- Results template: `benchmarks/agent-results.template.json`
- Tasks are read-only navigation, code-understanding, and debugging prompts. Do not edit source files during a run.

The task set is specific to the CNM codebase. It does not by itself satisfy the broader small/medium/large repository evaluation goal. Separate task sets and relevance/acceptance evidence are required for those repository classes.

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

1. Create clean, independent worktrees at the exact reference commit. Record the resolved `git rev-parse HEAD` for both conditions; the SHAs must match.
2. Keep the same OS, Node version, agent client/version, model identifier, model settings, context/token budget, tool permissions, and timeout for each paired run.
3. Use the exact same task ID and prompt text in both conditions. Record a prompt hash so accidental task drift is detectable.
4. For a pilot, run every task once in each condition. For a scored comparison, use at least three independent replicates per task and condition.
5. Alternate or randomize condition order per task to reduce order and warm-cache bias. Start each replicate with a fresh agent conversation, shell state, and CNM database.
6. Submit only the task `prompt` to the evaluated agent. Do not show `expectedEvidence` or `acceptance` until scoring.
7. Save the complete answer and raw tool-call transcript. Record elapsed time, token usage when exposed by the client, and tool-call count. If a client does not expose a metric, record `null`; do not estimate it.
8. Score answers only after both conditions are complete. Prefer a reviewer who does not know which condition produced the answer.

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

Total score: 0–16 per task run. Also record binary task success only when correctness and evidence are each at least 3 and no critical false claim appears. Calculate the total from the four dimension scores; never hand-enter a conflicting total.

## Comparability and reporting gates

A task pair is eligible for quantitative comparison only when all of the following are true:
- same task ID, prompt hash, repository commit, OS, agent client/version, model, and model settings;
- both condition transcripts and complete answers are retained;
- each run has a distinct replicate ID and fresh state;
- scoring uses the same rubric and acceptance evidence;
- no unpaired environmental interruption or extra retry occurred.

Report per task and per condition:
- task success rate and mean/median rubric score;
- median completion time;
- median input/output tokens when available;
- median tool calls;
- all individual replicate scores and excluded runs.

Compare paired task-level results. Do not aggregate across unlike task categories or repository sizes without showing per-category and per-size results. A small sample or one model/client is not sufficient for a general claim. Missing metrics remain null.

## Validity controls

- Do not change task wording between conditions.
- Do not change the repository commit or model version between paired runs.
- Do not let the treatment reuse indexed state from another task or replicate.
- Do not give the treatment more time, context, tools, or retries.
- Do not interpret fewer tool calls as better unless correctness and completeness are maintained.
- Record any environmental interruption and exclude/re-run the paired task in both conditions.
- Tool availability is part of the treatment being evaluated: record unavailable or failed MCP tools exactly; do not silently replace them with unrecorded manual source reads.
- A tool-discovery or client-integration failure must be reported separately from a CNM core retrieval failure.

## Existing exploratory record (2026-11-01)

The transcript artifact contains one attempted run per condition for some CNM-specific tasks. It is not a valid benchmark because:
- the task artifact and transcript record do not consistently use the same reference commit;
- the record does not establish matching checked-out SHAs;
- the with-CNM and without-CNM runs used different agent identities, with model and client versions missing;
- the task-03 transcript prompt differs from task CNM-AGENT-03 in the checked-in task set;
- timing, token usage, and complete raw tool payloads are missing;
- scoring was provisional and not blinded;
- the CNM sessions reported that `source_excerpt` was unavailable, while the control agent read source directly. This is a client/tool-exposure limitation to investigate, not proof of a CNM core defect.

The transcript may guide integration debugging, but its provisional scores and winner fields must not be used as benchmark results. Preserve it for auditability and collect a new paired dataset using the fixed inputs above.

## Current status

- Eight read-only CNM-specific tasks and a controlled protocol are checked in.
- Exploratory agent transcripts exist, but no valid paired evaluation has been completed.
- No measured CNM advantage or disadvantage is claimed.
- The current task set evaluates one repository and navigation/debugging only. Separate small, medium, and large repository task suites plus controlled implementation tasks are still required before drawing conclusions about coding productivity or cross-repository scaling.
