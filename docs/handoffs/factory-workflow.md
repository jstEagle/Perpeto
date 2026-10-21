# Factory workflow handoff

`packages/factory-workflow` implements the workflow parts of the [architecture contract](../architecture.md), plus the lead's addendum on agent-authored workflows and observing runs. The addendum is on main's `docs/architecture.md`, not on this branch. The package has no dependencies and never calls a harness. The API is documented in the [package README](../../packages/factory-workflow/README.md).

## What exists

- **Graph v1:** `validateGraph` returns errors and warnings. Each issue has a code, a message, and the node or edge it concerns.
- **Compilation:** `compileGraph` produces an execution plan with routing tables, loop back edges, and each role's derived `canMessage`, delegation and subagent limits.
- **Run engine:** `step(state, event)` is pure and deterministic. It covers:
  - planner fan-out into child work items
  - review, CI, human and merge gates
  - loop iteration limits, with nested loops reset correctly
  - per-node concurrency queues
  - blocked results
  - pause, resume and stop
  - completion
  - `workitem.moved`, `gate.result` and `assignment.state` events
- **`RunStore`:** SQLite in WAL mode. Each apply is one transaction. It deduplicates by event id, keeps entity tables and an effects outbox that survives restarts, and `verify()` replays a run to check its state.
- **Drafts:** `diffGraphs` for comparing a draft with the active version, and `classifyInteraction` for tagging unplanned interactions.
- **Workflow architect:** `GRAPH_JSON_SCHEMA`, `describeGraphSchema`, `buildArchitectPrompt`, `parseArchitectResult` and `evaluateArchitectResult`.
- **Metrics:** `computeRunMetrics` returns NodeMetrics, EdgeMetrics, RunMetrics and the six bottleneck rules, each with numeric evidence.
- **Templates:** `templates/build.json` and `templates/improve.json`. Both are valid with no warnings.

## Verification

Run with Node v24.22.0.

- `node --test` in `packages/factory-workflow` runs 75 tests, and all pass.
- `npm test` from the repo root runs 95 tests, and all pass.

The tests cover:

- **Validation:** every error code listed in the README.
- **Full build run:** input → planner → builder → review fails → retry → review passes → CI fails → fix → CI passes → merge → output. The run's events replay to identical state.
- **Engine behaviour:** loop-limit failure, the concurrency queue, pause/resume/stop including cancelling jobs and merges, blocked results and human gates, merge rejection, and purity, checked on frozen input.
- **Store:** restart mid-run twice, duplicate and conflicting events, outbox recovery, and rollback of rejected events.
- **Drafts and architect:** diffs, prompt content and determinism, and reply parsing edge cases.
- **Metrics:** every bottleneck rule.

Not verified:

- Behaviour with several processes writing the store at once. It relies on `BEGIN IMMEDIATE` and the busy timeout.
- Load at the contract's 100-agent target.
- Any live hub, node or T3 integration.
- `GRAPH_JSON_SCHEMA` against a JSON Schema validator. No dependency was added.

## Contract changes for the lead

None of these are in `docs/architecture.md` yet. The README documents them.

1. **Review verdicts:** a review's verdict comes from `AssignmentResult.outcome`, where `success` passes and `failure` fails. Consider adding an explicit `verdict` field so a crashed reviewer isn't mistaken for a rejection.
2. **Planner items:** `AssignmentResult.items?: [{ title, body? }]` holds a planner's output.
3. **Deterministic IDs:** engine IDs are the run suffix plus a counter, such as `wi_<runSuffix>_<n>`, not random. Replay depends on this.
4. **Config additions:**
   - `concurrency`, `policy`, `requirements` and `role` on planner and review nodes.
   - `requirements` and `role` on agent nodes.
   - `expectedIterations` on loops.
   - An optional `fail` port on merge queues.
   - Agent-only "helper" nodes reached only by `delegates` edges.
5. **Metrics shape:** `NodeMetrics.concurrency` and `utilization` are `null` for nodes without a limit. Unplanned `EdgeMetrics` include `from` and `to`. `computeRunMetrics` also takes `machines` and `usage` (UsageRecord rows).
6. **Extra events:** the engine also emits `gate.result` for merges, plus `loop.iteration`, `workitem.blocked`, `human.requested`, `planner.items_truncated` and `run.*` events.
7. **Run lifecycle:** a run completes when all its work items finish, unless `keepOpen` is set. `run.started` needs `repo` when the graph has CI or a merge queue.

## What remains

- **Hub integration:** wiring the store, outbox and metrics into the hub.
- **Project metrics:** aggregation for `/projects/:id/metrics`.
- **Retries:** no automatic retry for agent `failure` results, and no escalation route when a loop hits its limit. Both fail the item.
- **Failed CI infrastructure:** `job.completed` accepts only `passed` or `failed`. The hub must retry jobs that end in `error` itself.
- **Batch merges:** the `batch` merge strategy is passed through for the delivery package to implement.
