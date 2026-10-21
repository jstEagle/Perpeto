# Factory workflow handoff

`packages/workflow` implements the workflow parts of the [architecture contract](../architecture/README.md), plus the lead's addendum on agent-authored workflows and observing runs. The addendum is on main's `docs/architecture/README.md`, not on this branch. The package has no dependencies and never calls a harness. The API is documented in the [package README](../../packages/workflow/README.md).

## Concurrent work and conflict recovery, 21 October 2026

Implemented only under `packages/workflow/**` and this handoff, following the merge-conflict finding in [live acceptance run 2](live-acceptance-2.md). No hub, delivery or executor files were changed. This is engine-level behavior; live acceptance depends on the wiring below.

- Merge config now accepts `onConflict: 'rebase' | 'review'` (default `rebase`) and `rebaseReview: 'changed' | 'always' | 'never'` (default `changed`). Explicit conflict rejections schedule a lightweight `step: 'rebase'` assignment on the most recent successful builder role. Its replacement prompt asks for the latest base, conflict resolution with behavior preserved, a new head and `rebaseTouchedBeyondConflicts`. The default skips review only on an explicit `false`; missing evidence repeats review. Clean rebases repeat the successful CI path at the new head, then enqueue anew. CI failures take normal repair/review routes; retries and escalation retain their normal policies. Graphs without a CI node use speculative queue CI. Review/delivery loop budgets are untouched; the existing hop limit bounds recovery routing.
- Planner prompts request file/module boundaries and per-item `touches: string[]`. `serializeOverlappingTouches: true` is the default on planners. Scope reservations span building through terminal delivery within a run, across builder roles, retries and human waits. File/directory prefixes overlap; undeclared/empty scopes preserve old concurrency. This is declared-scope scheduling, not enforcement of actual edits or coordination across runs.
- Node/run metrics count `conflictRejections` and `rebases` from persisted entries/assignments, with time windows. Rejections belong to merge nodes; rebase assignments, including retries, belong to builder nodes. `conflict-churn` warns at 2 conflicts per merge node/window and is critical at 4, with counts, related rebases and the window in evidence. Every template and the architect schema/guide includes the controls.

### Exact integration required outside this worker's scope

1. **Delivery rejection classification:** `packages/delivery/src/queue.js`, in the `MERGE_CONFLICT` catch around `adapter.prepare`, must pass a typed conflict kind into the reducer. `packages/delivery/src/machine.js` must persist it on rejected entries (recommended `rejectionKind: 'conflict'`); singleton `ci-failed` should persist `'ci'`, and other publication/head/withdrawal failures `'other'` or omit it. Preserve the existing safe `reason`. Do not classify by a message substring: CI logs can mention conflicts too.
2. **Hub delivery forwarding:** `apps/hub/src/delivery/index.js` `sync` must copy the persisted rejection kind into its terminal projection and `merge.finished` event. `apps/hub/src/engine/workflow-adapter.js` `hubEvent` must map it to `merge.rejected.data.kind` (`'conflict' | 'ci' | 'other'`) alongside `reason`. Today that adapter forwards only the reason, so default recovery is intentionally inactive through the live hub until this lands.
3. **Structured results through executor and hub:** `packages/t3-executor/src/results.js` planner answer instructions/parser must preserve and validate `items[].touches`. Its work-result parser must retain a boolean `rebaseTouchedBeyondConflicts` from the final JSON block on rebase turns, and the prompt should specify that answer format. In `apps/hub/src/engine/workflow-adapter.js`, `engineResult` must forward both fields instead of dropping them. Preserve `assignment.step` and `rebaseOf` through node/executor transport (the engine's create-assignment effect already includes them); workspace publishing must update the same branch from the latest base. Missing flags safely trigger re-review but cannot deliver the intended savings.
4. **Metrics and clients:** the hub's cross-run metrics aggregator and client types must include the two counters and `conflict-churn`. Preserve engine-owned recovery movement fields (`step: 'rebase'`, `edgeId: null`, `unplanned: false`) instead of reclassifying them as unauthorized graph-edge traffic. The package metrics intentionally exclude those movements from authored-edge counts. Expose the planner/merge config in editors and contracts. Existing retained plans use runtime defaults for missing controls; historical run verification still depends on the compiler/template version that created them.

### Verification for concurrent work

Tests were added and run failing before implementation. Coverage includes clean versus behavior-changing rebases, missing reports, review policy overrides, typed conflict versus CI/untyped rejection, new-head enforcement, multiple CI gates, docs without an authored CI node, retry/escalation cleanup, pause/resume, stale assignment results, SQLite reopen and deterministic replay. Scope tests cover directory/file boundaries, independent parallelism, opt-out, legacy declarations, cross-role reservations, state reload, failure release and a synchronous dispatch-failure stall. Metrics cover node attribution, windows and churn evidence. On Node v24.22.0, workflow tests pass **141/141** and root `npm test` passes **498/498**. Relative documentation links and `git diff --check` pass. Initial root testing failed on missing workspace links; `npm install --ignore-scripts --no-package-lock --no-audit --no-fund` repaired the fresh checkout without tracked dependency changes. No live hub/delivery/harness acceptance was performed for this change.

## Continuous workflows and template library, 21 October 2026

This work changes only `packages/workflow/**` and this handoff. It does not wire the hub, web app, machine execution or actual scheduler. No push or merge was performed.

Implemented:

- A public `listTemplates()` metadata library and isolated `getTemplate(id)` graphs for build, improve, bugfix, docs, security-audit and dependency-upgrade. Every template validates without warnings. New delivery loops allow three passes, role errors retry three times with 30-second backoff, CI errors twice, and delivery exhaustion/blocked results go to human triage. Cheap planning/reproduction roles and stronger implementation/security review roles have explicit defaults. The improve auditor reads goals, metrics and previous outcomes, avoids duplicate work, and can end a pass with no proposals.
- Durable refill requests for `keepOpen` runs, using `input.tick`, `input.requested` and `request-input`. Goals refill only when drained; manual intake never refills automatically. Schedule inputs accept five-field numeric UTC cron, with lists/ranges/steps and day-of-month/day-of-week OR semantics. Requests coalesce while outstanding and are deduplicated per scheduled minute. There is no missed-tick catch-up.
- Per-run `budget: { maxTokensPerDay?, maxActiveItems?, maxItemsPerDay? }`. Exhaustion pauses intake and planner expansion, emits a reason and preserves deferred child proposals. Existing work can finish. Daily counters roll over at the next event in a later UTC day. Usage is reported with idempotent `usage.recorded` deltas; this intake guard is not a hard spend cap for in-flight work.
- Architect prompts include every template graph and description plus `existingWorkflows`. Replies retain optional `templateId` and up to three `additionalWorkflows: [{ name, rationale, templateId?, graph }]`. Evaluation checks every graph; additional errors carry `workflowIndex` starting at 1. Proposals remain drafts with separate activation.

### Exact hub integration required

1. **Run configuration and events:** in `apps/hub/src/engine/workflow-adapter.js`, `startRun` must forward `input.budget`, `input.source`, `input.schedule` alongside `keepOpen`. Graph input config remains the default source/schedule. Extend `hubEvent` to accept `input.tick` and `usage.recorded`, preserving caller-supplied stable event ids, and preserve `requestId` when translating input to `input.added`. The existing input route may accept empty items only when fulfilling a request. Expose `intake` and `budgetUsage` for clients so an intake pause is not confused with a user-paused run.
2. **Scheduler:** drive `input.tick {}` through the durable engine from hub maintenance once per UTC minute for each running keep-open run, using an id such as `tick:<runId>:<UTC-minute>`. This also resets daily allowances and drains deferred planner output. The engine matches cron and remembers the last scheduled minute. Send ticks for goals/manual keep-open runs too, so empty goals responses and daily-budget waits recover. Do not tick user-paused or terminal runs. Decide separately whether missed scheduled minutes should be caught up; this package deliberately does not replay them.
3. **Input source outbox:** `translateEffects`/legacy `translate` currently omit unknown effects. Translate and handle `request-input { requestId, nodeId, source, docs, limit }` durably. For goals, load unfinished project goals, omit completed/already active goals across all project workflows, and attach docs, goal evidence, metrics and previous outcomes in item bodies. For schedule, create the requested audit/pass input. Fulfil with `input.added { requestId, items }` before acknowledging the outbox request. On no eligible work, fulfil with `items: []`; retries use the same request-derived event id. Do not use the emitted `input.requested` notification as a second independent work trigger. Respect the request limit and recheck run status before source execution.
4. **Budget wiring:** `Hub.recordUsage` currently only writes usage records. Forward each newly accepted input/output token delta once to its run with a stable usage-record-derived event id; do not count cache subtotals again or forward cumulative snapshots as deltas. Persist usage plus delivery intent atomically, so a crash cannot lose accounting. Preserve manual/source input batches rejected by the budget and retry them with a new event id after `budget.available`; the engine creates none of an oversized batch and leaves its request outstanding. Alternatively split to fit. Already admitted assignments/retries continue, so stricter execution limits need additional lease-time enforcement and per-assignment policies in the hub.
5. **Multiple workflows:** workflow activation is already scoped to each workflow id and runs pin a selected workflow version. Preserve that behaviour. Pass the `workflows` list received by the adapter into architect `existingWorkflows`; it is currently dropped. Preserve `templateId` and `additionalWorkflows` through result parsing and executor result transport (a fenced JSON `summary` is compatible today). In `Workflows.completed`, validate every graph and save each additional proposal with a distinct workflow id in one transaction, without deactivating other workflows. Return all draft ids/versions to clients and activate them independently. Account for combined machine capacity and use the shared project merge queue.
6. **Template endpoints and clients:** serve `listTemplates()` descriptions and `getTemplate(id)` graphs rather than duplicating a hardcoded two-template list. Expand any purpose/source enums to the new values. Forward validation failures for every proposed graph back to the architect retry loop, including `workflowIndex`.

### Verification for this change

Tests were added and run failing before implementation for the library, continuous intake/budgets and architect proposals. Coverage includes schedule validation/matching and deduplication, empty-source backoff, planner deferral across daily rollover, immutable pure steps, stale request ids, budget event deduplication, SQLite close/reopen, event idempotence, durable outbox recovery and deterministic replay. Node v24.22.0: the workflow suite contains 121 passing tests; root `npm test` passes 477 tests. A fresh-worktree missing-workspace-link failure was resolved with `npm install --ignore-scripts --no-package-lock --no-audit --no-fund`, without changing dependency manifests or the lockfile. No live hub scheduler or multi-workflow client flow was exercised.

## Live acceptance fixes, 21 October 2026

Branch `t3/756151ef`, from [live acceptance run 1](live-acceptance-1.md#fixed-after-the-run). Not pushed or merged. `npm test -w @perpeto/workflow` passes 106.

- **Planner context:** a planner that keeps the item whole hands its summary to the item as `plan` (`{ from, summary }`, at most 8,000 characters), and every later role prompt carries it. Children name their parent. The README defines the order of [work-item context in role prompts](../../packages/workflow/README.md#work-item-context-in-role-prompts).
- **Architect:** a Defaults section (retries with backoff, loop limits, concurrency within capacity, model tiers per role) and local-repository delivery guidance.
- **Warnings:** `NO_RETRY`, `RETRY_WITHOUT_BACKOFF` and `LOOP_LIMIT_HIGH`. They don't block a draft. Graphs without retries now warn, so the hub and web show them on old drafts too.
- **Contract request:** `WorkItem.plan` is new. `AssignmentResult.summary` from a planner now has a meaning, so `docs/architecture/README.md` should say so.

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
