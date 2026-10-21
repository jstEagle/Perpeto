# Workflow engine

Workflow graphs, their validation and compilation, the deterministic run engine, a SQLite run store, graph diffs, workflow-architect support and run metrics. It implements the workflow parts of [the architecture contract](../../docs/architecture/README.md). It never calls a harness or the network. The only I/O is the store's SQLite file and reading bundled templates for clients and architect prompts.

Requires Node 24. No dependencies or environment variables.

```js
import {
  validateGraph, compileGraph, step, RunStore, diffGraphs,
  buildArchitectPrompt, evaluateArchitectResult, computeRunMetrics, classifyInteraction,
} from '@perpeto/workflow';
```

## Graphs

`validateGraph(graph, { providers? })` never throws. It returns `{ ok, errors, warnings }`, where each issue is `{ code, message, nodeId?, edgeId? }`. With `providers`, a harness provider outside that list is an `UNAVAILABLE_PROVIDER` error.

| Code | Meaning |
| --- | --- |
| `INVALID_GRAPH`, `INVALID_SCHEMA`, `LIMIT_EXCEEDED` | Not a `perpeto.workflow/1` object, or over 500 nodes or 2000 edges |
| `INVALID_NODE`, `INVALID_EDGE`, `DUPLICATE_ID`, `UNKNOWN_NODE_TYPE`, `INVALID_EDGE_KIND` | Malformed nodes and edges. Node, edge and role ids may not be `Object.prototype` names such as `constructor` |
| `DANGLING_EDGE` | Edge points at a missing node |
| `MISSING_CONFIG`, `INVALID_CONFIG`, `INVALID_HARNESS`, `INVALID_POLICY`, `INVALID_RETRY`, `LOOP_BOUNDS` | Node config is missing or has the wrong shape. `maxIterations` is 1 to 100, `retry.maxAttempts` 1 to 10 and `retry.backoffSec` 0 to 86400 |
| `INVALID_ESCALATION` | `onExhausted` doesn't name another human, agent or review node, or `onBlocked` doesn't name a human node |
| `DUPLICATE_ROLE` | Two agent nodes share a role id |
| `NO_INPUT`, `NO_OUTPUT`, `UNREACHABLE_NODE` | Work cannot enter, finish, or reach a node |
| `MISSING_FLOW_OUT`, `AMBIGUOUS_ROUTE`, `GATE_UNWIRED`, `INVALID_PORT`, `INVALID_FLOW` | Routing problems. Gates need one edge on `pass` and one on `fail`, and other nodes need exactly one flow edge out |
| `FLOW_CYCLE`, `LOOP_UNCOUNTED` | A cycle, including one through an escalation, does not return into a loop node from inside that loop's body |
| `LOOP_CONDITION_UNMATCHED` | `until: review-pass` without a review gate whose fail edge returns to the loop, and likewise for `ci-pass` and `manual` (human) |
| `INVALID_DELEGATION`, `INVALID_MESSAGES_EDGE` | `delegates` must run from a planner or agent to an agent, and `messages` must connect planner, agent or review roles |

Warnings, which don't block a graph: `UNKNOWN_KEY`, `UNKNOWN_CONFIG_KEY`, `DUPLICATE_EDGE`, `NO_PATH_TO_OUTPUT`, `LOOP_NEVER_REPEATS`, `POLICY_CANMESSAGE_DERIVED`, `POLICY_SUBAGENTS_WITHOUT_DELEGATION`, `DELEGATION_UNUSED` and `DELEGATE_PROVIDER_NOT_ALLOWED`. These flag valid values that are fragile in unattended runs:

| Code | When |
| --- | --- |
| `NO_RETRY` | A planner, agent, review or CI node makes one attempt (`retry` missing or `maxAttempts: 1`) and has no `onExhausted` target |
| `RETRY_WITHOUT_BACKOFF` | It retries with `backoffSec` 0 |
| `LOOP_LIMIT_HIGH` | A loop allows more than `SAFE_MAX_ITERATIONS` (10) passes |

These semantics go beyond the contract table:

- Merge queues route a merge on `pass`. An unported edge also counts as `pass`. A `fail` edge is optional; without one, an unrecovered rejected merge fails the item.
- Merge queues accept `onConflict: 'rebase' | 'review'` (default `rebase`) and `rebaseReview: 'changed' | 'always' | 'never'` (default `changed`). Typed conflicts recover before the normal fail route; other rejections retain it. See [Concurrent work and conflict recovery](#concurrent-work-and-conflict-recovery).
- Planners accept `serializeOverlappingTouches` (boolean, default `true`). Declared file/directory scopes serialize building through delivery within a run.
- Planner and review nodes also accept `concurrency` (default 1), `policy`, `requirements` and `role`. Agent nodes accept `requirements` and `role`. A node's role id defaults to its node id.
- An agent reached only by `delegates` edges is a helper role. It needs no flow edges.
- Loops accept `expectedIterations`, which defaults to `min(2, maxIterations)`. The `rework-loop` metric uses it.
- Planner, agent, review and CI nodes accept `retry: { maxAttempts, backoffSec? }`. It covers errors, not verdicts, and defaults to one attempt with no backoff. See [Retries and escalation](#retries-and-escalation).
- Planner, agent, review, CI and loop nodes accept `onExhausted`, naming a human, agent or review node. Planner, agent and review nodes also accept `onBlocked`, naming a human node.
- Escalation targets count for reachability, dominators and cycle checks, like flow edges. A human node that is an escalation target may leave `fail` unwired. A fail decision there fails the item with `rejected_by_human`.
- Back edges into loops come from dominators. An edge into a loop is a back edge when every path from an input to its source passes through the loop. Entering a loop on a back edge increments the item's count. Entering any other way resets it to 1, so the build template's review loop starts again after CI sends work back through the delivery loop.

`compileGraph(graph)` throws `WorkflowError('INVALID_GRAPH')` with the validation result in `error.details`. It returns a plan containing:

- `graphHash`, a SHA-256 of the canonical graph.
- `inputs`.
- `nodes[id]` with config defaults applied, plus `routes`: `{ next }` or `{ pass, fail }`, each `{ node, edgeId }` or `null`. Planner, agent, review and CI nodes get `config.retry` filled in. Those nodes and loops also get `escalation: { exhausted, blocked }`, each a node id or `null`. `blocked` is `onBlocked`, or `onExhausted` when that is a human node.
- `escalations`, each `{ from, to, on: 'exhausted' | 'blocked' }`, so editors can draw them.
- `roles[roleId]`, each `{ nodeId, harness, prompt, concurrency, requirements, policy, delegatesTo, delegateOnly }`. In `policy`:
  - `canMessage` comes from `messages` edges, in both directions.
  - `maxSubagents` is the smaller of `policy.maxSubagents` and the delegate targets' total concurrency. It is 0 without a `delegates` edge.
  - `allowedSubagentProviders` defaults to the delegate targets' providers.
  - `requirements.providers` always includes the role's own provider.
- `loops[id]`, each `{ until, maxIterations, expectedIterations, body, backSources }`.

`classifyInteraction(plan, { kind, from, to })` matches an observed delegation or message between node or role ids to an edge. It returns `{ edgeId, unplanned }` so the hub can log `agent.delegated` and `agent.messaged` with `unplanned: true` when no edge exists.

## Run engine

`step(state, event)` returns `{ state, effects, ignored? }`. It is pure, never mutates `state`, and is deterministic. It works copy-on-write: the new state shares every entity the event did not touch with `state`, so treat both as immutable. Its cost follows what the event changes, plus pointer-level copying and scanning of the entity tables.

- IDs are `wi_`, `asg_`, `job_` and `mq_` plus the run suffix and a counter, for example `asg_ab12_3`.
- Time comes only from `event.at`.

Invalid events throw `WorkflowError`. Events that are valid but stale, such as a second result for a closed assignment, a result after a stop, or a repeated pause, return the unchanged state with `ignored` set to a reason. `replay(events)` folds events from nothing.

Events are `{ id, type, at, data }`:

| Type | Data |
| --- | --- |
| `run.started` | `{ runId, projectId, workflowId, workflowVersion, graph, repo?: { url or localPath, defaultBranch }, inputs?: [{ title, body?, nodeId?, touches? }], keepOpen?, source?: 'manual' or 'goals' or 'schedule', schedule?: string, budget?: { maxTokensPerDay?, maxActiveItems?, maxItemsPerDay? } }`. `repo` is required when the graph has CI or a merge queue |
| `input.added` | `{ items: [{ title, body?, nodeId?, touches? }], requestId? }`. `nodeId` is needed when there are several input nodes |
| `input.tick` | `{}`; the hub drives UTC minute ticks, including day rollover |
| `usage.recorded` | `{ inputTokens, outputTokens }` nonnegative integer deltas, deduplicated by event id |
| `assignment.completed` | `{ assignmentId, result: AssignmentResult }` |
| `job.completed` | `{ jobId, status: 'passed', 'failed', 'error' or 'cancelled', summary?, logRef? }` |
| `merge.completed` / `merge.rejected` | `{ mergeId, mergedSha? }` / `{ mergeId, reason, kind?: 'conflict' | 'ci' | 'other' }`. Only explicit `kind: 'conflict'` enters rebase recovery; reason text is never classified |
| `human.decision` | `{ workItemId, decision: 'pass' or 'fail', note?, decisionId? }` |
| `run.paused`, `run.resumed`, `run.stopped` | `{}`, or `{ reason? }` for `run.stopped` |

Assignment results are interpreted by the role that produced them:

- **Agent:** a `success` result's `branch`, `prUrl` and `headSha` become the item's. A full 40- or 64-character lowercase SHA is required.
- **Review:** `verdict` decides the gate: `pass` passes and `fail` returns the work, with the summary as feedback in the next agent prompt. A legacy result with `outcome: 'success'` and no verdict passes, and `gate.result` carries `legacyVerdict: true`. `outcome: 'failure'` without a verdict is an error, never a rejection.
- **Planner:** `success` may include `items: [{ title, body?, touches?: string[] }]`, truncated to `maxItems`. Each item becomes a child work item at the planner's next node. The parent stays `active` until every child finishes, then becomes `done`, or `failed` if any child failed. With no items, the original item continues as the work item, and a nonblank `summary` becomes its `plan` (`{ from, summary }`, at most 8,000 characters): the contract and acceptance criteria every later role receives.
- **Any role:** `failure` from a planner or agent is an error. `blocked` goes to the node's human gate if it has one. Otherwise the item waits as `blocked` at the node until `human.decision` either retries it (`pass`, with the optional note as feedback) or fails it (`fail`).

### Continuous intake and budgets

`keepOpen: true` leaves a drained run running. Input node `config.source` controls refill; `run.started.source` optionally overrides all inputs. Sources:

- `manual`: only `input.added` supplies work. No automatic requests.
- `goals`: when the run drains, emit `input.requested` and a durable `request-input` effect. The hub creates inputs for unfinished goals and supplies relevant metrics and previous outcomes in their bodies. Empty responses wait for another tick.
- `schedule`: an input also needs `config.schedule`, such as `0 2 * * *` for nightly at 02:00 UTC. A run-level `schedule` can override it. `input.tick` checks five numeric UTC cron fields, with lists, ranges and steps; weekdays are 0–6, and restricted day-of-month/day-of-week fields use OR semantics. There is no timer or missed-tick catch-up in the engine. It requests at most once per matching minute per input, including when start or completion falls in that minute. A busy outstanding request coalesces later occurrences.

Each request is `{ requestId, nodeId, source, docs, limit }`, carried identically by `input.requested` and `request-input`. Only one request per input can be outstanding. Fulfil with `input.added { requestId, items }`; an empty array is allowed only with a current request id. The engine targets that input automatically and rejects stale ids or mismatched node ids. Hosts must honour `limit`, avoid duplicate goals across workflows and persist the response before acknowledging the request effect. The source adapter decides when a goal is unfinished; the pure engine never queries project data.

`budget` accepts optional positive safe integers. Counters live in `state.budgetUsage`, resetting at the next event in a later UTC day. Older timestamps never roll the current bucket backwards. `maxItemsPerDay` counts every created root and planner child, including failed work; retries do not create items. `maxActiveItems` counts unfinished executable items, including queued and blocked items, but excludes parents waiting only for children.

A full budget sets `state.intake.paused` with `reason` and emits `budget.exhausted { limit, used, maximum, requested, day, summary }`, once per reason/day while paused. A later event with room emits `budget.available`. The run stays running and existing work can finish. Input batches are atomic: if they do not fit, no items are created and the outstanding request stays open. Preserve a rejected manual batch or source response in the hub and retry with a new event id when capacity returns, or split it into batches that fit. Planner fan-out instead retains uncreated proposals in `item.pendingPlan`, and creates children as capacity returns. Daily limits can defer them to the next day.

`maxTokensPerDay` uses `usage.recorded` input-plus-output deltas. It blocks intake and new planner children after the reported limit, not already admitted assignments, retries, CI or merges. In-flight work can overshoot; this is not a hard spend ceiling. The hub must forward usage promptly and use assignment policy/lease controls if it needs a stricter execution cap. Do not feed cumulative usage snapshots as deltas.

A planner can set `emptyResult: 'complete'` to finish its input at that node when a success explicitly returns `items: []`, then wait for a tick before refilling. The improve auditor uses this to avoid busywork. Without the setting, or with `items` omitted, the existing keep-whole planner behaviour remains.

### Work-item context in role prompts

Every planner, agent and review assignment gets the same work-item context, in this order, after the node's own `prompt`:

| Part | When |
| --- | --- |
| `Work item: <title>` and the body | Always |
| `Part of: <parent title>` | Children a planner split off |
| `Plan from <planner role>:` and the planner's summary | Items a planner kept whole |
| `Rubric:` | Review nodes with a `rubric` |
| Branch, pull request and head commit | Once an agent reported them |
| Feedback to address, or the escalation that brought the item | After a failed gate, a human note or an escalation; reviewers get escalations only |
| Loop pass and retry notes | From the second pass or attempt |
| What to answer | Planners: split or keep whole with the contract in the summary. Reviewers: a verdict |

The executor adds the answer format and factory facts (branch, delivery) below this; see `@perpeto/t3-executor`.

Every wait for a person gets a `decisionId` (`hd_` plus the run suffix and a counter), carried in `item.waiting`, `human.requested` and the in-place `workitem.blocked`. A decision that names a different `decisionId` throws `STALE_DECISION`, so a retried request or a second person answering cannot pass the item's next gate. Hosts should always send it; a decision without one still applies to whatever the item waits for now.

### Concurrent work and conflict recovery

Planner prompts ask for file/module boundaries and `touches: string[]` per proposed item, including shared exports, manifests and tests. Touches are up to 100 distinct repository-relative file or directory paths of at most 4,096 characters. Paths normalize `./` and trailing/repeated slashes; parent traversal, absolute paths, backslashes, control characters and globs are rejected. Directory prefixes overlap descendants (`src` overlaps `src/index.js`, but not `src2`); `.` covers the repository. Omitted/empty declarations preserve legacy concurrency. The planner's `serializeOverlappingTouches: false` opts its children out of scope locking.

The first builder assignment claims the item's declared scopes. Other overlapping items wait across builder roles until the holder is done or failed, including its reviews, CI, retries, human waits and merge recovery. Independent scopes still use the configured concurrency. Scope claims persist on work items and survive replay/restart. They are local to one run and rely on accurate declarations; they do not detect undeclared writes or coordinate separate runs. Later builders must start from the current base, as supplied by the host workspace adapter.

On `merge.rejected { kind: 'conflict' }`, default recovery finds the item's latest successful agent visit and schedules that same role with `assignment.step: 'rebase'` and `rebaseOf: <rejected merge id>`. Its prompt replaces normal implementation instructions: fetch and rebase onto the latest base, resolve conflicts, keep behavior, publish a new head and report `rebaseTouchedBeyondConflicts: boolean`. A successful rebase must return a new full `headSha`; missing/unchanged heads use the builder's error retry policy.

With `rebaseReview: 'changed'`, only an explicit `false` skips review. `true` or an omitted report returns through the builder's normal next route. `always` always takes that route; `never` skips it regardless of the report. This is builder-reported evidence, not a Git hunk verifier. A clean rebase repeats each distinct successful CI node visited since that builder, in order, at the new head, then creates a fresh merge entry. Graphs without an authored CI gate return directly to the merge queue's speculative CI. A CI failure takes its normal fail route, so behavior repairs still receive review. A rebase error retries as a rebase; escalation ends recovery and uses the normal target.

Recovery leaves review/delivery loop counts unchanged and uses the existing item hop limit as its routing backstop. If no successful agent visit is retained, recovery falls back to the merge's normal fail route. `onConflict: 'review'` always uses that route. Missing rejection kinds and CI/other rejection kinds also use that route. Recovery moves emit `workitem.moved` with `step: 'rebase'`, `edgeId: null`, `unplanned: false`; they are engine routing, excluded from authored-edge traffic metrics. Hosts must preserve these fields and the result flag; the [handoff](../../docs/handoffs/factory-workflow.md#concurrent-work-and-conflict-recovery-21-october-2026) lists integration requirements.

### Retries and escalation

Errors are retried; verdicts are not. An error is an agent or planner `failure`, a review `failure` without a verdict, or a CI job that ends `error` or `cancelled`. A review's `fail` verdict, a CI `failed` status and a rejected merge route as before.

- **Retry:** while attempts remain under the node's `retry.maxAttempts`, the item is queued again at the same node. The new assignment or job has `attempt` set to n, `retryOf` set to the previous id and, with a backoff, `notBefore`. Retry n waits `backoffSec × 2^(n−1)` seconds, capped at `MAX_BACKOFF_SEC` (one day). The engine has no clock, so the host must not lease work before `notBefore`. A waiting retry holds a concurrency slot. The agent's prompt names the attempt and the previous error. Attempts restart at 1 whenever the item enters a node.
- **Exhaustion:** when attempts run out, or a loop passes `maxIterations`, the item goes to the node's `onExhausted` target. `workitem.escalated` carries the evidence. Retries give the attempt count, the error code, the last error and the assignment or job ids. Loops give the iteration count, the latest feedback and the last 10 visits in the loop body. The target's prompt, or the `human.requested` context, explains why the item arrived. An escalation from a loop clears that loop's count, so a target that sends work back starts a fresh budget.
- **Without a target:** the item fails as before, with `assignment_failed`, `review_error`, `job_error`, `job_cancelled` or `loop_limit`.
- **Automatic limit:** an item can take at most `MAX_UNATTENDED_ESCALATIONS` (3) escalations to agent or review targets without a human decision between them. Past that, it fails with the original reason. Escalations to human targets are not limited.
- **Blocked:** `blocked` goes to `onBlocked`, or to a human `onExhausted` target, with `workitem.blocked` (`routedTo`) and `workitem.escalated` (reason `blocked`). Without one, the item waits in place. Both show in metrics as `waiting-on-human`.

Routing and the run's lifecycle:

- **Gates:** CI jobs run at the item's `headSha`. Missing it fails the item with `missing_head_sha`. Merge entries need a pull request URL and head commit. Human gates block the item and emit `human.requested`.
- **Loops:** once its count passes `maxIterations`, a loop escalates the item to `onExhausted` or fails it with `loop_limit`. An item that crosses more than 1000 flow edges and escalations fails with `hop_limit`.
- **Concurrency:** open assignments per node never exceed its `concurrency`. Excess items wait in `queued` and are dispatched in arrival order.
- **Pause:** results are still applied and routed, but nothing new is dispatched until `run.resumed`.
- **Stop:** cancels open assignments, jobs and merges, and fails unfinished items with `run_stopped`.
- **Completion:** a run becomes `completed` once every item is done, or `failed` if any top-level item failed. With `keepOpen`, it keeps waiting for input instead.

Effects are what the host should do. Assignments and jobs carry `attempt`, plus `retryOf` and `notBefore` on retries.

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
- `gate.result` `{ workItemId, nodeId, gate, result, assignmentId | jobId | mergeId, summary?, legacyVerdict? }`
- `workitem.retried` `{ workItemId, nodeId, attempt, maxAttempts, reason, summary, assignmentId | jobId, notBefore? }`
- `workitem.escalated` `{ workItemId, from, to, reason: 'retries_exhausted' | 'loop_limit' | 'blocked', evidence }`
- `workitem.blocked` `{ workItemId, nodeId, summary, routedTo? | decisionId? }`
- `human.requested` `{ workItemId, nodeId, decisionId, prompt, context?: { kind, from, summary } }`
- `loop.iteration`, `planner.items_truncated`
- `run.started`, `run.paused`, `run.resumed`, `run.stopped`, `run.completed`, `run.failed`

Work items carry these fields beyond the contract:

- `enteredAt`, `loopCounts`, `hops`, `attempt`
- `lastError` `{ nodeId, attempt, reason, summary, assignmentId | jobId }` and `retryAt` while a retry is pending
- `escalations`, the last 20 of `{ from, to, reason, at, iterations?, attempts? }`, and `unattendedEscalations`
- `visits`, the last 100 of `{ nodeId, enteredAt, startedAt, endedAt?, result?, assignmentId | jobId | mergeId }`. `result` is `pass`, `fail`, `error` (an attempt that errored), `blocked` or `cancelled`
- `touches`, `serializeOverlappingTouches` and `touchesClaimed` for declared scope scheduling; `rebase` while conflict recovery is active
- `feedback`, `failure`, `waiting`, `childIds`, `completedAt`

## Run store

```js
const store = new RunStore('/abs/path/runs.sqlite');      // WAL, synchronous FULL
const { effects, state, duplicate, ignored, seq } = store.apply(runId, event);
for (const { id, effect } of store.pendingEffects({ limit: 100 })) { /* execute */ store.ackEffects([id]); }
```

`apply` runs the engine in one `BEGIN IMMEDIATE` transaction. It stores the event, the rows of the work items, assignments, jobs and merge entries the event created or changed, the run's own fields (status, counters, timestamps) and the effects in an outbox. The plan is stored once when the run starts. The latest state of the 64 most recently used runs stays in memory and advances in place, so an event costs the same however long the run is: about 0.15 ms at 100 or 2,000 finished items with 4 KB bodies (`test/persistence-cost.test.js`), against 14 ms and 209 ms at 100 and 1,000 before. Another store on the same file is detected by sequence number and the run is reloaded from its rows.

- The result's `state` is a private copy, made when first read, of the run as of that event. Reading it costs time in proportion to the run, so hosts on a hot path should read entities instead. Read after a later event on the run, it replays the log up to its event.
- Events are stepped as stored, with sorted keys, so `verify` reproduces the state exactly.
- Schema 1 files (the whole state rewritten on every event) are migrated when opened.

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

`buildArchitectPrompt({ project, docs, goals, machines, providers, existingWorkflow?, existingWorkflows?, userPrompt, previousErrors? })` builds a deterministic prompt for the `workflow-architect` role. It includes the graph guide (`describeGraphSchema()`), defaults for unattended runs (three attempts with 30 s backoff for agent roles and two for CI, loops of 3 passes, concurrency within machine capacity, strong models for builders and escalations and cheaper ones for planning and first-pass review), the complete template library, descriptions and graphs, previous validation errors and the answer format: one fenced json block holding `{ rationale, graph, templateId?, additionalWorkflows? }`. When the repository is a local path, it explains that delivery uses published `local:<branch>` branches and asks for prompts that never mention pull requests.

- `parseArchitectResult(text)` extracts `{ graph, rationale, templateId?, additionalWorkflows? }`. Up to three additional proposals are `{ name, rationale, templateId?, graph }`; nested proposals and unknown template ids are rejected. Each remains a separate draft. Existing single-graph replies remain supported. It takes the last usable fenced block, accepting either a wrapper object or a bare graph with prose as the rationale. It throws `ARCHITECT_PARSE_ERROR`.
- `evaluateArchitectResult(text, { providers? })` parses and validates every proposed graph in one step (additional issues carry `workflowIndex`, starting at 1) for the hub's retry loop, which is capped by `ARCHITECT_MAX_ATTEMPTS`.
- `GRAPH_JSON_SCHEMA` is the JSON Schema 2020-12 for the graph's structure.

## Metrics

`computeRunMetrics(state, events, { now, window, machines?, usage? })` is pure. `window` is `1h`, `24h`, `7d` or a number of seconds. It returns `{ runId, at, windowSec, nodes: NodeMetrics[], edges: EdgeMetrics[], run: RunMetrics, bottlenecks: Bottleneck[] }`, shaped as in the contract.

Inputs:

- `events` is the hub's event log for the run. It reads `workitem.moved`, `agent.delegated`, `agent.messaged` and `assignment.state` (with `machineId`). Wait and service times start from the hub's `leased` or `running` time when known, or the dispatch time otherwise.
- `usage` takes `UsageRecord` rows. Tokens are input plus output tokens.
- `machines` turns on the `no-capacity` rule.

Output details:

- `concurrency` and `utilization` are `null` for nodes without a concurrency limit.
- NodeMetrics also has `errors` (errored attempts), `retries` (assignments and jobs past attempt 1) and `escalations` (escalations out of the node). `failureRate` counts errors and failures over all finished visits.
- RunMetrics also has `retries`, `escalations` and `waitingOnHuman`, the number of blocked items.
- Both NodeMetrics and RunMetrics include windowed `conflictRejections` and `rebases`. Rejections count typed rejected merge entries at completion, attributed to the merge node. Rebases count created rebase assignments (including retries), attributed to the builder node, without depending on the event log.
- An edge with no matching graph edge is reported once per kind and node pair, as `unplanned:<kind>:<from>-><to>`, with `from` and `to`.
- `velocity.trend` counts finished leaf items in 12 buckets for 1h, 24 for 24h or one per day for longer windows.

Bottleneck rules, with thresholds in `BOTTLENECK_RULES`:

| Reason | Rule | Severity |
| --- | --- | --- |
| `saturated` | Utilization at least 0.9 and the queue grew over the window | `critical` when the queue is at least twice the concurrency, otherwise `warning` |
| `queue-growing` | Not saturated, but the queue grew by at least 3 | `warning` |
| `high-failure` | At least 4 finished visits and a failure rate of at least 0.5, errors included | `critical` at 0.75 or more, otherwise `warning` |
| `waiting-on-human` | Items blocked at the node | `warning` after 1h, `critical` after 24h, otherwise `info` |
| `no-capacity` | Waiting assignments or CI jobs whose requirements no online machine meets | `critical` |
| `rework-loop` | Average loop iterations above `expectedIterations`. Escalated items count with the iterations they used | `critical` if any item hit the limit, otherwise `warning` |
| `conflict-churn` | At least 2 typed conflict rejections at a merge node in the window | `critical` at 4, otherwise `warning`; evidence reports rejections, related rebase assignments and window |

Every bottleneck's `evidence` carries the measured numbers, for example `utilization 1.00 (2 of 2 slots busy); queue 4, up from 0 at window start`. A `rework-loop` evidence string names escalations, as in `…; 1 hit the limit; 1 escalated to senior-reviewer`. A `high-failure` one counts errors and retries.

## Templates

`listTemplates()` returns stable `{ id, description }` metadata for the architect and clients. `getTemplate(id)` returns a fresh editable graph, or throws `UNKNOWN_TEMPLATE`. The JSON files remain plain graph v1 documents.

| Template | Default route |
| --- | --- |
| `build` | Planner → builder → review → CI → merge |
| `improve` | Goals/metrics auditor → improver → review → CI → merge |
| `bugfix` | Triage planner → reproduction test → fix → review → CI → merge |
| `docs` | Doc writer → doc review → merge |
| `security-audit` | Auditor → finding verification → fix → review → CI → merge |
| `dependency-upgrade` | Dependency planner → upgrader → review → CI → merge |

New templates use three role attempts with 30-second backoff, two CI attempts, a delivery loop capped at three passes and one or two concurrent workers per role. Planning and reproduction/verification can use cheaper models; implementation and sensitive reviews use stronger ones. Exhausted or blocked delivery reaches human triage. Planning errors end after bounded retries. Docs use a bounded review loop and rely on the reviewer's link/example/layout evidence instead of a generic code test command. CI commands and models must be adapted to the repository and installed providers.

`templates/build.json` runs ideas → planner → delivery loop (until CI passes, 3 passes) → review loop (until review passes, 3 passes) → builder, which can delegate to a helper → reviewer → CI → merge queue → shipped. CI failures and non-conflict rejected merges return through the delivery loop. All templates configure conflict rebases with conditional re-review, and every planner configures overlap serialization. For unattended runs:

- Every agent, review and CI node retries errors two or three times with backoff.
- An exhausted review loop, or a reviewer that keeps erroring, escalates to a senior reviewer. Its pass goes to CI, and its fail goes to triage.
- Triage is a human gate. It also takes exhausted builder, CI and delivery-loop work and blocked builds or reviews. Passing sends the item back through the delivery loop with the note as feedback. Failing ends the item.

`templates/improve.json` runs goals → auditor → improvement loop (4 passes) → improver → reviewer → CI → merge queue → improved. It has the same retries, and exhausted or blocked work goes to a triage gate that returns it to the improvement loop.

All six validate without warnings. Their provider and model choices are defaults for people to edit.

## Tests

```sh
npm test -w @perpeto/workflow
```
