# Factory workflow handoff

`packages/workflow` implements the workflow parts of the [architecture contract](../architecture/README.md), plus the lead's addendum on agent-authored workflows and observing runs. The addendum is on main's `docs/architecture/README.md`, not on this branch. The package has no dependencies and never calls a harness. The API is documented in the [package README](../../packages/workflow/README.md).

## What exists

- **Graph v1:** `validateGraph` returns errors and warnings. Each issue has a code, a message, and the node or edge it concerns.
- **Compilation:** `compileGraph` produces an execution plan with routing tables, loop back edges, and each role's derived `canMessage`, delegation and subagent limits.
- **Run engine:** `step(state, event)` is pure and deterministic. It covers:
  - planner fan-out into child work items
  - review, CI, human and merge gates
  - loop iteration limits, with nested loops reset correctly
  - per-node concurrency queues
  - blocked results, routed to a human gate when one is configured
  - review verdicts, with a fallback for legacy results
  - retries with backoff for agent, review and CI errors
  - escalation to an `onExhausted` target when retries or loop iterations run out
  - pause, resume and stop
  - completion
  - `workitem.moved`, `gate.result`, `assignment.state`, `workitem.retried` and `workitem.escalated` events
- **`RunStore`:** SQLite in WAL mode. Each apply is one transaction. It deduplicates by event id, keeps entity tables and an effects outbox that survives restarts, and `verify()` replays a run to check its state.
- **Drafts:** `diffGraphs` for comparing a draft with the active version, and `classifyInteraction` for tagging unplanned interactions.
- **Workflow architect:** `GRAPH_JSON_SCHEMA`, `describeGraphSchema`, `buildArchitectPrompt`, `parseArchitectResult` and `evaluateArchitectResult`.
- **Metrics:** `computeRunMetrics` returns NodeMetrics, EdgeMetrics, RunMetrics and the six bottleneck rules, each with numeric evidence. It counts errors, retries and escalations.
- **Templates:** `templates/build.json` and `templates/improve.json`. Both are valid with no warnings. Build escalates stuck reviews to a senior reviewer, and both send exhausted or blocked work to a human triage gate.

## Verification

Run with Node v24.22.0.

- `node --test` in `packages/workflow` runs 87 tests, and all pass.
- `npm test` from the repo root runs 221 tests, and all pass.

The tests cover:

- **Validation:** every error code listed in the README.
- **Full build run:** input → planner → builder → review fails → retry → review passes → CI fails → fix → CI passes → merge → output. The run's events replay to identical state.
- **Engine behaviour:** loop-limit failure, the concurrency queue, pause/resume/stop including cancelling jobs and merges, blocked results and human gates, merge rejection, and purity, checked on frozen input.
- **Store:** restart mid-run twice, duplicate and conflicting events, outbox recovery, and rollback of rejected events.
- **Drafts and architect:** diffs, prompt content and determinism, and reply parsing edge cases.
- **Metrics:** every bottleneck rule, plus retry, error and escalation counts and rework-loop evidence that names escalations.
- **Retries and escalation:**
  - verdict and legacy review results, and review errors retried with doubling backoff
  - agent, planner and CI `error`/`cancelled` retries
  - escalation from exhausted retries and from each template loop
  - the senior reviewer and triage paths
  - the unattended-escalation limit
  - blocked work, both routed and held
  - validation of every new config error
  - replay determinism, including identical effects
  - a store restart in the middle of retries and escalations

Not verified:

- Behaviour with several processes writing the store at once. It relies on `BEGIN IMMEDIATE` and the busy timeout.
- Load at the contract's 100-agent target.
- Any live hub, node or T3 integration.
- `GRAPH_JSON_SCHEMA` against a JSON Schema validator. No dependency was added.

## Contract changes for the lead

The verdict, planner items, `keepOpen`, helper roles and the role and loop config additions are now in `docs/architecture/README.md`. These are not yet. The README documents them all.

1. **Retry and escalation config:**
   - `retry: { maxAttempts, backoffSec? }` on planner, agent, review and CI nodes
   - `onExhausted` on those nodes and on loops
   - `onBlocked` on planner, agent and review nodes
   - human escalation targets may leave `fail` unwired
2. **Job and assignment fields:**
   - `job.completed` accepts `error` and `cancelled`, which are retried
   - retried assignments and jobs carry `retryOf` and `notBefore`, and the hub must not lease before `notBefore`
3. **Deterministic IDs:** engine IDs are the run suffix plus a counter, such as `wi_<runSuffix>_<n>`, not random. Replay depends on this.
4. **Other config:** an optional `fail` port on merge queues, and `requirements` and `role` on agent nodes.
5. **Metrics shape:**
   - `NodeMetrics.concurrency` and `utilization` are `null` for nodes without a limit.
   - NodeMetrics adds `errors`, `retries` and `escalations`, and `failureRate` counts errors.
   - RunMetrics adds `retries`, `escalations` and `waitingOnHuman`.
   - Unplanned `EdgeMetrics` include `from` and `to`.
   - `computeRunMetrics` also takes `machines` and `usage` (UsageRecord rows).
6. **Extra events:** the engine also emits `gate.result` for merges, plus `loop.iteration`, `workitem.blocked`, `workitem.retried`, `workitem.escalated`, `human.requested`, `planner.items_truncated` and `run.*` events.
7. **Run start:** `run.started` needs `repo` when the graph has CI or a merge queue.

## Known gaps

- **Hub integration:** wiring the store, outbox and metrics into the hub.
  - The hub must honour `notBefore` when leasing retries.
  - It must report a lost lease or crashed harness as `outcome: 'failure'` so the engine retries it.
- **Behaviour changes:**
  - A review `failure` without a verdict is now an error, not a rejection. Reviewers must send `verdict`.
  - Agent failures now close visits as `error`, so NodeMetrics shows them under `errors` instead of `failed`.
  - Runs recorded before this change won't pass `verify()`, because compiled plans now carry retry defaults and escalation targets.
- **Retry slots:** a retry waiting out its backoff holds a concurrency slot.
- **Merge retries:** the merge queue has no retry policy. A rejected merge is a verdict.
- **Editor:** escalation links live in node config, not edges. The editor needs to draw `plan.escalations` and offer the new fields.
- **Project metrics:** aggregation for `/projects/:id/metrics`.
- **Batch merges:** the `batch` merge strategy is passed through for the delivery package to implement.
