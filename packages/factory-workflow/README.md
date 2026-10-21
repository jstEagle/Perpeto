# Factory workflow

Workflow graphs, their validation and compilation, the deterministic run engine, a SQLite run store, graph diffs, workflow-architect support and run metrics. It implements the workflow parts of [the architecture contract](../../docs/architecture.md). It never calls a harness or the network. The only I/O is the store's SQLite file and reading the bundled build template for architect prompts.

Requires Node 24. No dependencies or environment variables.

```js
import {
  validateGraph, compileGraph, step, RunStore, diffGraphs,
  buildArchitectPrompt, evaluateArchitectResult, computeRunMetrics, classifyInteraction,
} from '@perpeto/factory-workflow';
```

## Graphs

`validateGraph(graph, { providers? })` never throws. It returns `{ ok, errors, warnings }`, where each issue is `{ code, message, nodeId?, edgeId? }`. With `providers`, a harness provider outside that list is an `UNAVAILABLE_PROVIDER` error.

| Code | Meaning |
| --- | --- |
| `INVALID_GRAPH`, `INVALID_SCHEMA`, `LIMIT_EXCEEDED` | Not a `perpeto.workflow/1` object, or over 500 nodes or 2000 edges |
| `INVALID_NODE`, `INVALID_EDGE`, `DUPLICATE_ID`, `UNKNOWN_NODE_TYPE`, `INVALID_EDGE_KIND` | Malformed nodes and edges |
| `DANGLING_EDGE` | Edge points at a missing node |
| `MISSING_CONFIG`, `INVALID_CONFIG`, `INVALID_HARNESS`, `INVALID_POLICY`, `LOOP_BOUNDS` | Node config is missing or has the wrong shape. `maxIterations` is 1 to 100 |
| `DUPLICATE_ROLE` | Two agent nodes share a role id |
| `NO_INPUT`, `NO_OUTPUT`, `UNREACHABLE_NODE` | Work cannot enter, finish, or reach a node |
| `MISSING_FLOW_OUT`, `AMBIGUOUS_ROUTE`, `GATE_UNWIRED`, `INVALID_PORT`, `INVALID_FLOW` | Routing problems. Gates need one edge on `pass` and one on `fail`, and other nodes need exactly one flow edge out |
| `FLOW_CYCLE`, `LOOP_UNCOUNTED` | A cycle does not return into a loop node from inside that loop's body |
| `LOOP_CONDITION_UNMATCHED` | `until: review-pass` without a review gate whose fail edge returns to the loop, and likewise for `ci-pass` and `manual` (human) |
| `INVALID_DELEGATION`, `INVALID_MESSAGES_EDGE` | `delegates` must run from a planner or agent to an agent, and `messages` must connect planner, agent or review roles |

Warnings, which don't block a graph: `UNKNOWN_KEY`, `UNKNOWN_CONFIG_KEY`, `DUPLICATE_EDGE`, `NO_PATH_TO_OUTPUT`, `LOOP_NEVER_REPEATS`, `POLICY_CANMESSAGE_DERIVED`, `POLICY_SUBAGENTS_WITHOUT_DELEGATION`, `DELEGATION_UNUSED` and `DELEGATE_PROVIDER_NOT_ALLOWED`.

These semantics go beyond the contract table:

- Merge queues route a merge on `pass`. An unported edge also counts as `pass`. A `fail` edge is optional; without one, a rejected merge fails the item.
- Planner and review nodes also accept `concurrency` (default 1), `policy`, `requirements` and `role`. Agent nodes accept `requirements` and `role`. A node's role id defaults to its node id.
- An agent reached only by `delegates` edges is a helper role. It needs no flow edges.
- Loops accept `expectedIterations`, which defaults to `min(2, maxIterations)`. The `rework-loop` metric uses it.
- Back edges into loops come from dominators. An edge into a loop is a back edge when every path from an input to its source passes through the loop. Entering a loop on a back edge increments the item's count. Entering any other way resets it to 1, so the build template's review loop starts again after CI sends work back through the delivery loop.

`compileGraph(graph)` throws `WorkflowError('INVALID_GRAPH')` with the validation result in `error.details`. It returns a plan containing:

- `graphHash`, a SHA-256 of the canonical graph.
- `inputs`.
- `nodes[id]` with config defaults applied, plus `routes`: `{ next }` or `{ pass, fail }`, each `{ node, edgeId }` or `null`.
- `roles[roleId]`, each `{ nodeId, harness, prompt, concurrency, requirements, policy, delegatesTo, delegateOnly }`. In `policy`:
  - `canMessage` comes from `messages` edges, in both directions.
  - `maxSubagents` is the smaller of `policy.maxSubagents` and the delegate targets' total concurrency. It is 0 without a `delegates` edge.
  - `allowedSubagentProviders` defaults to the delegate targets' providers.
  - `requirements.providers` always includes the role's own provider.
- `loops[id]`, each `{ until, maxIterations, expectedIterations, body, backSources }`.

`classifyInteraction(plan, { kind, from, to })` matches an observed delegation or message between node or role ids to an edge. It returns `{ edgeId, unplanned }` so the hub can log `agent.delegated` and `agent.messaged` with `unplanned: true` when no edge exists.

## Run engine

`step(state, event)` returns `{ state, effects, ignored? }`. It is pure, never mutates `state`, and is deterministic:

- IDs are `wi_`, `asg_`, `job_` and `mq_` plus the run suffix and a counter, for example `asg_ab12_3`.
- Time comes only from `event.at`.

Invalid events throw `WorkflowError`. Events that are valid but stale, such as a second result for a closed assignment, a result after a stop, or a repeated pause, return the unchanged state with `ignored` set to a reason. `replay(events)` folds events from nothing.

Events are `{ id, type, at, data }`:

| Type | Data |
| --- | --- |
| `run.started` | `{ runId, projectId, workflowId, workflowVersion, graph, repo?: { url or localPath, defaultBranch }, inputs?: [{ title, body?, nodeId? }], keepOpen? }`. `repo` is required when the graph has CI or a merge queue |
| `input.added` | `{ items: [{ title, body?, nodeId? }] }`. `nodeId` is needed when there are several input nodes |
| `assignment.completed` | `{ assignmentId, result: AssignmentResult }` |
| `job.completed` | `{ jobId, status: 'passed' or 'failed', summary?, logRef? }` |
| `merge.completed` / `merge.rejected` | `{ mergeId, mergedSha? }` / `{ mergeId, reason }` |
| `human.decision` | `{ workItemId, decision: 'pass' or 'fail', note? }` |
| `run.paused`, `run.resumed`, `run.stopped` | `{}`, or `{ reason? }` for `run.stopped` |

Assignment results are interpreted by the role that produced them:

- **Agent:** a `success` result's `branch`, `prUrl` and `headSha` become the item's. A full 40- or 64-character lowercase SHA is required.
- **Review:** `success` passes the gate and `failure` fails it. The summary becomes feedback in the next agent prompt.
- **Planner:** `success` may include `items: [{ title, body? }]`, truncated to `maxItems`. Each item becomes a child work item at the planner's next node. The parent stays `active` until every child finishes, then becomes `done`, or `failed` if any child failed. With no items, the original item continues as the work item.
- **Any role:** `blocked` parks the item as `blocked` until `human.decision` either retries it (`pass`, with the optional note as feedback) or fails it (`fail`). `failure` from a planner or agent fails the item.

Routing and the run's lifecycle:

- **Gates:** CI jobs run at the item's `headSha`. Missing it fails the item with `missing_head_sha`. Merge entries need a pull request URL and head commit. Human gates block the item and emit `human.requested`.
- **Loops:** a loop fails the item with `loop_limit` once its count passes `maxIterations`. An item that crosses more than 1000 flow edges fails with `hop_limit`.
- **Concurrency:** open assignments per node never exceed its `concurrency`. Excess items wait in `queued` and are dispatched in arrival order.
- **Pause:** results are still applied and routed, but nothing new is dispatched until `run.resumed`.
- **Stop:** cancels open assignments, jobs and merges, and fails unfinished items with `run_stopped`.
- **Completion:** a run becomes `completed` once every item is done, or `failed` if any top-level item failed. With `keepOpen`, it keeps waiting for input instead.

Effects are what the host should do:

- `create-work-item {workItem}`
- `create-assignment {assignment}`
- `create-job {job}`
- `enqueue-merge {mergeEntry}`
- `mark-item-done {workItemId}`
- `mark-item-failed {workItemId, reason, message}`
- `cancel-assignment {assignmentId, reason}`, `cancel-job`, `cancel-merge`
- `emit-event {event: {type, subject, data}}`

Emitted event types:

- `workitem.moved` `{ workItemId, edgeId, from, to, port?, unplanned: false }`
- `assignment.state` `{ assignmentId, workItemId, nodeId, role, state }`. The engine reports `queued`, `succeeded`, `failed` and `cancelled`; the hub adds `leased` and `running`.
- `gate.result` `{ workItemId, nodeId, gate, result, assignmentId | jobId | mergeId, summary? }`
- `loop.iteration`, `workitem.blocked`, `human.requested`, `planner.items_truncated`
- `run.started`, `run.paused`, `run.resumed`, `run.stopped`, `run.completed`, `run.failed`

Work items carry these fields beyond the contract:

- `enteredAt`, `loopCounts`, `hops`
- `visits`, the last 100 of `{ nodeId, enteredAt, startedAt, endedAt?, result?, assignmentId | jobId | mergeId }`
- `feedback`, `failure`, `waiting`, `childIds`, `completedAt`

## Run store

```js
const store = new RunStore('/abs/path/runs.sqlite');      // WAL, synchronous FULL
const { effects, state, duplicate, ignored, seq } = store.apply(runId, event);
for (const { id, effect } of store.pendingEffects({ limit: 100 })) { /* execute */ store.ackEffects([id]); }
```

`apply` runs `step` in one `BEGIN IMMEDIATE` transaction. It stores the event, the new state, rows for work items, assignments, jobs and merge entries, and the effects in an outbox:

- Event ids deduplicate per run. A repeat with the same type and data returns the original effects with `duplicate: true`, even with a different `at`. Different content under the same id throws `IDEMPOTENCY_CONFLICT`.
- Rejected events leave no trace.
- After a restart, `getState` resumes the run and `pendingEffects` lists effects that were never acknowledged.

Reads: `getRun`, `listRuns({ projectId?, status? })`, `getState`, `listWorkItems`, `listAssignments`, `listJobs` and `listMergeEntries` (each `(runId, { status?, nodeId? })`), `getWorkItem`, `getAssignment`, `getJob`, `getMergeEntry`, `listEvents(runId, { after, limit })`. `verify(runId)` replays the stored events and checks that they reproduce the saved state.

## Drafts and the workflow architect

`diffGraphs(a, b)` returns:

- `{ identical, schemaChanged, nodes, edges, summary }`
- Each of `nodes` and `edges` is `{ added, removed, changed }`, with items matched by id.
- Each `changed` entry lists leaf `changes: [{ path, before?, after? }]`, such as `config.harness.model`. `layoutOnly` is true when only `position` moved.
- `a` may be `null` when there is no active version.

`buildArchitectPrompt({ project, docs, goals, machines, providers, existingWorkflow?, userPrompt, previousErrors? })` builds a deterministic prompt for the `workflow-architect` role. It includes the graph guide (`describeGraphSchema()`), the build template as an example, previous validation errors and the answer format: one fenced json block holding `{ rationale, graph }`.

- `parseArchitectResult(text)` extracts `{ graph, rationale }`. It takes the last usable fenced block, accepting either a wrapper object or a bare graph with prose as the rationale. It throws `ARCHITECT_PARSE_ERROR`.
- `evaluateArchitectResult(text, { providers? })` parses and validates in one step for the hub's retry loop, which is capped by `ARCHITECT_MAX_ATTEMPTS`.
- `GRAPH_JSON_SCHEMA` is the JSON Schema 2020-12 for the graph's structure.

## Metrics

`computeRunMetrics(state, events, { now, window, machines?, usage? })` is pure. `window` is `1h`, `24h`, `7d` or a number of seconds. It returns `{ runId, at, windowSec, nodes: NodeMetrics[], edges: EdgeMetrics[], run: RunMetrics, bottlenecks: Bottleneck[] }`, shaped as in the contract.

Inputs:

- `events` is the hub's event log for the run. It reads `workitem.moved`, `agent.delegated`, `agent.messaged` and `assignment.state` (with `machineId`). Wait and service times start from the hub's `leased` or `running` time when known, or the dispatch time otherwise.
- `usage` takes `UsageRecord` rows. Tokens are input plus output tokens.
- `machines` turns on the `no-capacity` rule.

Output details:

- `concurrency` and `utilization` are `null` for nodes without a concurrency limit.
- An edge with no matching graph edge is reported once per kind and node pair, as `unplanned:<kind>:<from>-><to>`, with `from` and `to`.
- `velocity.trend` counts finished leaf items in 12 buckets for 1h, 24 for 24h or one per day for longer windows.

Bottleneck rules, with thresholds in `BOTTLENECK_RULES`:

| Reason | Rule | Severity |
| --- | --- | --- |
| `saturated` | Utilization at least 0.9 and the queue grew over the window | `critical` when the queue is at least twice the concurrency, otherwise `warning` |
| `queue-growing` | Not saturated, but the queue grew by at least 3 | `warning` |
| `high-failure` | At least 4 finished visits and a failure rate of at least 0.5 | `critical` at 0.75 or more, otherwise `warning` |
| `waiting-on-human` | Items blocked at the node | `warning` after 1h, `critical` after 24h, otherwise `info` |
| `no-capacity` | Waiting assignments or CI jobs whose requirements no online machine meets | `critical` |
| `rework-loop` | Average loop iterations above `expectedIterations` | `critical` if any item hit the limit, otherwise `warning` |

Every bottleneck's `evidence` carries the measured numbers, for example `utilization 1.00 (2 of 2 slots busy); queue 4, up from 0 at window start`.

## Templates

`templates/build.json` runs ideas → planner → delivery loop (until CI passes, 3 passes) → review loop (until review passes, 3 passes) → builder, which can delegate to a helper → reviewer → CI → merge queue → shipped. CI failures and rejected merges return through the delivery loop.

`templates/improve.json` runs goals → auditor → improvement loop (4 passes) → improver → reviewer → CI → merge queue → improved.

Both validate without warnings. Their provider and model choices are defaults for people to edit.

## Tests

```sh
cd packages/factory-workflow && node --test
```
