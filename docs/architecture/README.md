# Factory architecture

Status: implementation contract, 21 October 2026. Justus asked to start building the expanded direction in [the vision](../product/vision.md#expanded-product-direction). This document fixes shared names and interfaces so parallel workers build compatible pieces. Anything below that is not yet implemented and verified is a plan, not a shipped capability. Change this file deliberately and note the change in the commit.

## Shape

```text
 clients: web app, native Swift app, CLI
            │  HTTPS JSON + event stream
            ▼
 ┌──────────────────────────────┐
 │ hub (one per factory)        │  projects, workflows, runs, work items,
 │ apps/hub                     │  assignments, jobs, merge queue, machines,
 │                              │  accounts, usage ledger, messaging
 └──────────────────────────────┘
            ▲  enrollment, heartbeats, leases, results
            │
 ┌──────────────────────────────┐   one per machine
 │ node daemon                  │   supervises the local T3 environment server,
 │ apps/node                    │   executes assignments through T3, runs CI jobs,
 │                              │   owns the machine's subscription pool
 └──────────────────────────────┘
            │  T3 environment API (local)
            ▼
     T3 runtime (vendor/t3code) → harnesses (Claude, Codex, …) → inference
```

The hub decides what should happen. Nodes do the work and report evidence. T3 remains the only path to inference; Perpeto never calls a model API directly.

## Packages and owners

Deployable surfaces live in `apps/`; libraries they compose live in `packages/` and are imported by package name through npm workspaces.

| Path | Package | Purpose |
| --- | --- | --- |
| `apps/hub` | `@perpeto/hub` | Hub HTTP server, persistence, leasing, event log, usage ledger. Mounts workflow engine and messaging. |
| `apps/node` | `@perpeto/node` | Node daemon: enrollment, heartbeats, lease loop, executor registry, CI job runner. |
| `apps/cli` | `@perpeto/cli` | `perpeto` command: install, start hub, enroll node, status. |
| `apps/web` | `@perpeto/web` | Perpeto web app. |
| `apps/apple` | Swift package | Native SwiftUI app for macOS (iPadOS/iOS later). |
| `packages/workflow` | `@perpeto/workflow` | Workflow graph schema, validation, compilation, and the deterministic run engine. No I/O except its SQLite store. |
| `packages/delivery` | `@perpeto/delivery` | PR policy, merge queue, CI job definitions, revision-bound evidence. |
| `packages/accounts` | `@perpeto/accounts` | Per-machine subscription pool and hot swapping, in the spirit of CCswap. |
| `packages/t3-executor` | `@perpeto/t3-executor` | Executor that drives a local T3 environment: threads, turns, events, token usage, subagent policy. |
| `packages/messaging` | `@perpeto/messaging` | Existing durable messaging store. Shared by the hub and the T3 environment server. |
| `packages/sdk` | `@perpeto/sdk` | Messaging HTTP client, `perpeto-messages` CLI and MCP stdio server for agents. |
| `packages/design-tokens` | `@perpeto/design-tokens` | Brand tokens generated from `brand/tokens.css` for CSS and Swift, plus logo assets. |
| `tests/e2e` | `@perpeto/e2e` | End-to-end suites across hub, node, delivery and SDK. |

Factory services stay outside `vendor/t3code`. Patch the vendored runtime only when T3 lacks a required hook, and record each patch in `config/upstream-patches.json`.

## Runtime conventions

- Node 24 (`>=24.13.1 <25`), ESM JavaScript with JSDoc types, `node:sqlite`, `node:test`. Server packages stay dependency-free unless a dependency clearly pays for itself.
- Non-secret configuration lives in JSON files under `config/` or a user config directory. Secrets live in owner-only files (mode 600) referenced by path, never in JSON config, CLI arguments, or logs.
- IDs are strings: a short prefix plus a random suffix (engine-created IDs are deterministic, `wi_<runSuffix>_<n>`, so runs replay identically), for example `prj_…`, `wf_…`, `run_…`, `wi_…`, `asg_…`, `job_…`, `mch_…`, `acct_…`, `mq_…`.
- Timestamps are ISO 8601 UTC strings.
- Machine tokens, enrollment codes and session tokens are random and stored only as hashes. Idempotent replays return the original token, kept encrypted under a separate owner-only `credentialKeyPath` file; back it up with the hub databases. A leaked owner secret cannot mint machine tokens.
- Every mutating request accepts an `idempotencyKey`. A repeat with the same body returns the original result; a repeat with a different body returns `409 conflict`.
- Errors are `{ "error": { "code": "SNAKE_CASE", "message": "…" } }` and never include raw SQL, stack traces, or secrets.
- Paths that URL normalization would rewrite (dot segments, encoded slashes, repeated slashes) are rejected with `400 INVALID_PATH`; authorization and routing always use the same normalized path.

## Entities

```ts
Project      { id, name, repo: { url, defaultBranch, localPath? }, docs: DocRef[], goals: Goal[], gitIdentity?: { name, email }, createdAt, updatedAt }   // gitIdentity is copied onto every new assignment; agents commit under it, falling back to the node's runtime.t3.gitIdentity
Goal         { id, title, status: 'active'|'done'|'dropped', workItemIds, done, total }   // progress counts leaf work items linked by goalId; legacy string goals are read with title-derived ids
DocRef       { id, title, path?: string, url?: string, kind: 'requirements'|'vision'|'spec'|'notes' }
Workflow     { id, projectId, name, purpose: 'build'|'improve'|'maintain'|'custom'|'bugfix'|'docs'|'security-audit'|'dependency-upgrade', version, graph: WorkflowGraph, status: 'draft'|'active'|'paused' }
Run          { id, projectId, workflowId, workflowVersion, status: 'running'|'paused'|'stopped'|'completed'|'failed', startedAt, stoppedAt?, completedAt?, keepOpen, source?: 'goals'|'schedule'|'manual', schedule?: string /* numeric UTC cron */,
               budget?: { maxTokensPerDay?, maxActiveItems?, maxItemsPerDay? }, intake?, budgetUsage? }
WorkItem     { id, runId, title, body, nodeId, status: 'queued'|'active'|'blocked'|'done'|'failed', branch?, prUrl?, headSha?, iteration, parentId?, goalId?, touches?: string[], plan?: { from, summary } }
Assignment   { id, projectId, repo: { url, defaultBranch, localPath? } /* copied from the project when created */, runId? /* absent for project-scoped work such as the workflow architect */, workItemId?, nodeId, role, prompt, harness: Harness, policy: AgentPolicy,
               requirements: MachineRequirements, status: 'queued'|'leased'|'running'|'succeeded'|'failed'|'cancelled',
               machineId?, leaseExpiresAt?, attempt, step?: 'rebase', rebaseOf?: string /* rejected merge entry */, result?: AssignmentResult }
Harness      { provider: string, model: string, options?: Record<string, string|boolean> }   // provider = T3 driver kind, e.g. 'claudeAgent', 'codex'
AgentPolicy  { maxSubagents: number, allowedSubagentProviders: string[], maxTurns?: number, maxTokens?: number, canMessage: string[] }
MachineRequirements { os?: 'darwin'|'linux'|'windows', labels?: string[], providers?: string[] }
AssignmentResult { outcome: 'success'|'failure'|'blocked', summary, branch?, prUrl?, headSha?, threadRef?,
                   verdict?: 'pass'|'fail' /* review gates; a review without a verdict is an error, not a rejection */,
                   rebaseTouchedBeyondConflicts?: boolean /* explicit false permits the default conflict-only review bypass */,
                   items?: { title, body?, touches?: string[] }[] /* planner output; summary is retained as plan when keeping an item whole */, graph?, rationale?, templateId?, additionalWorkflows?: { name, graph, rationale, templateId? }[] /* workflow architect */ }
Job          { id, projectId, runId?, workItemId?, repo, revision /* full commit sha */, steps: JobStep[],
               requirements: MachineRequirements, status: 'queued'|'leased'|'running'|'passed'|'failed'|'cancelled'|'error',
               machineId?, leaseExpiresAt?, attempt, logRef?, artifacts: ArtifactRef[], configHash }
JobStep      { name, run: string /* shell command */, timeoutSec? }
MergeEntry   { id, projectId, queueId, prUrl, headSha, baseBranch, status: 'queued'|'testing'|'merging'|'merged'|'rejected', jobId?, reason?,
               mergedRevision?, deliveryError?, rejectionKind?: 'conflict'|'ci'|'other' }
// Speculative merge-queue Jobs also carry delivery: { queueId, mergeEntryIds }.
Machine      { id, name, os, arch, labels: string[], providers: string[], capacity: { maxAgents, maxJobs },
               running: { agents, jobs }, status: 'online'|'offline'|'draining', lastHeartbeatAt, version, tokenGeneration, revokedAt? }
Account      { id, machineId, provider, label, status: 'active'|'cooling'|'disabled'|'invalid', cooldownUntil?, lastUsedAt? }
UsageRecord  { id, projectId, runId?, assignmentId?, machineId, accountId?, provider, model,
               inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd?, at }
Event        { seq /* hub-global increasing integer */, at, type, projectId?, runId?, subject: { kind, id }, data }
```

Messaging keeps the existing `@perpeto/messaging` model: project channels, stable role IDs, idempotent sends and cursor reads. Each run gets a channel `run-<runId>`. Messages never imply task ownership or a verified result; assignments and jobs carry those.

## Workflow graph v1

A workflow is a typed graph. Edges carry one meaning each, so the editor and engine agree on what a line means.

```ts
WorkflowGraph { schema: 'perpeto.workflow/1', nodes: GraphNode[], edges: GraphEdge[] }
GraphNode     { id, type: NodeType, label, position: { x, y }, config: object }
GraphEdge     { id, from: { node, port? }, to: { node, port? }, kind: 'flow'|'delegates'|'messages' }
```

| Node type | Meaning | Key config |
| --- | --- | --- |
| `input` | Source of work: ideas, backlog, goals, docs | `source: 'manual'|'goals'|'schedule'|'issues'`, `schedule: numeric UTC cron`, `docs: DocRef ids` |
| `planner` | Agent that turns input into work items | `harness`, `prompt`, `maxItems`, `serializeOverlappingTouches: boolean` (default true) |
| `agent` | Agent role that does a work item | `harness`, `prompt`, `concurrency`, `policy` |
| `review` | Agent review gate; passes or returns work | `harness`, `prompt`, `rubric` |
| `ci` | CI gate run on a user-owned machine at the exact head commit | `steps`, `requirements` |
| `merge-queue` | Serialises merges into the base branch | `strategy: 'serial'|'batch'`, `requiredChecks`, `method: 'squash'|'merge'|'rebase'`, `publication: 'fast-forward-push'|'github-merge-queue'`, `onConflict: 'rebase'|'review'`, `rebaseReview: 'changed'|'always'|'never'` |
| `loop` | Repeats its body until a condition or limit | `until: 'review-pass'|'ci-pass'|'manual'`, `maxIterations` |
| `human` | Pauses for a person | `prompt` |
| `output` | Terminal: work item finished | none |

Ports: gates have `pass` and `fail` output ports. `flow` edges move work items. `delegates` edges grant authority for the source agent to create subagents or assign to the target role, bounded by the target's `concurrency` and the source's `policy.maxSubagents`. `messages` edges permit the two roles to message each other; the engine derives each assignment's `policy.canMessage` from them.

Node config may also set `concurrency`, `policy`, `requirements` and `role` on planner and review nodes, and `expectedIterations` on loops. An agent reached only by `delegates` edges is a helper role. A run completes when every work item finishes unless the run was started with `keepOpen`.

The engine is deterministic: it reads the run's state plus incoming results (assignment finished, job finished, human decision) and emits new work items, assignments, jobs and merge entries. It never calls a harness. A loop counts iterations on the work item and fails it at `maxIterations`.

Default templates live in `packages/workflow/templates/`: build, improve, bugfix, docs, security-audit and dependency-upgrade. `GET /workflow-templates` returns `{templates: [{id, description, graph}]}` from the workflow package's public library. Multiple workflows of one project may be active and run concurrently; activation is scoped to one workflow id, runs pin their version, and project delivery queues and machine capacity remain shared.

## Agent-authored workflows

Users should not have to build workflows by hand. The default path is a prompt: "Describe how this project should be built." The hub creates an assignment for a `workflow-architect` role, which runs through T3 like any other agent with the project's docs, goals, available machines, providers and existing workflows as context. Its `AssignmentResult` carries `{ graph, rationale, templateId?, additionalWorkflows?: [{name, graph, rationale, templateId?}] }` (up to three additional proposals), either directly or as fenced JSON in `summary`. The prompt includes existing workflows and the template library. Every proposed graph is validated before any draft is saved; errors on additional graphs carry `workflowIndex` starting at 1. Valid proposals are saved together as separate drafts and the assignment returns `drafts: [{workflowId, version}]`, alongside the existing primary `draftWorkflowId`/`draftVersion`. Each needs independent activation.

The hub validates the graph with the workflow package. Invalid graphs go back to the architect with the validation errors, up to three attempts. A valid graph is saved as a new **draft** version with `authoredBy: { kind: 'agent', assignmentId, prompt }` and the rationale. Nothing runs until a person activates it. Clients show the proposed graph, the rationale and a diff against the active version, and the user can activate it, ask for changes in another prompt, or edit by hand.

Agents running in a workflow may propose changes, for example adding a reviewer where review is the bottleneck. A proposal follows the same draft path and never changes an active run silently.

`Workflow` gains `authoredBy: { kind: 'agent'|'user', assignmentId?, prompt? }`, `rationale?` and `parentVersion?`. Versions are immutable once saved.

## Observing runs

The graph a user approved is also the live map of the run. Clients draw the same nodes and edges with live state on top, so people can see where work is, how agents interact, how fast work moves and what is holding it up.

Interaction events are first-class. The executor and messaging layer report them, and the hub stores them in the event log with the run and node roles they connect:

| Event type | Meaning |
| --- | --- |
| `workitem.moved` | A work item crossed a `flow` edge |
| `agent.delegated` | An agent assigned work or spawned a subagent along a `delegates` edge |
| `agent.messaged` | One role messaged another along a `messages` edge |
| `assignment.state` | Assignment queued, leased, running, finished, with machine and account |
| `gate.result` | Review, CI or human gate passed or failed |

Interaction events carry `from` and `to` node ids; an end that cannot be resolved through the run's graph is `null` with `sourceUnknown`/`targetUnknown: true`, never a role id. An interaction with no matching edge is recorded with `unplanned: true` and shown, rather than hidden.

### Metrics

`GET /runs/:id/metrics?window=1h|24h|7d` and `GET /projects/:id/metrics?window=` return:

```ts
NodeMetrics   { nodeId, queued, active, done, failed, concurrency, utilization /* active ÷ concurrency */,
                waitSec: { avg, p90 }, serviceSec: { avg, p90 }, throughputPerHour, failureRate, tokens, conflictRejections, rebases }
EdgeMetrics   { edgeId, kind, count, unplanned }
RunMetrics    { velocity: { itemsDonePerDay, trend: number[] }, cycleTimeSec: { avg, p90 }, wip,
                tokensPerItem, activeAgents, conflictRejections, rebases, machines: { machineId, activeAgents, nodes: string[] }[] }
Bottleneck    { nodeId, reason: 'saturated'|'queue-growing'|'high-failure'|'waiting-on-human'|'no-capacity'|'rework-loop'|'conflict-churn',
                evidence: string, severity: 'info'|'warning'|'critical' }
```

Bottlenecks are computed from measured state, never guessed by a model. Examples: utilization at or above 0.9 with a growing queue is `saturated`; queued work whose requirements no online machine meets is `no-capacity`; loop iterations rising above the configured average is `rework-loop`. Each bottleneck carries the numbers behind it in `evidence`.

The run view shows on each node its active agents, queue depth, wait time and throughput. Edges show recent traffic counts, and bottlenecks are marked with their reason. Beside the map, a velocity panel and a "where work is running" panel show machines with their active agents. Use explicit numbers and status labels; any motion is brief and respects reduced motion.

## Hub API v1

All routes are under `/api/v1` and require `Authorization: Bearer <token>`. Owner tokens act for the user. Node tokens act for one machine and may only call `/nodes/*`, `/assignments/:id/*` and `/jobs/:id/*` for work leased to that machine.

| Method and path | Purpose |
| --- | --- |
| `GET /health` | Unauthenticated liveness and version |
| `GET/POST /projects`, `GET/PATCH /projects/:id` | Projects, repo, docs, goals |
| `GET/POST /projects/:id/workflows`, `GET/PUT /workflows/:id` | Workflows; PUT validates and bumps `version` |
| `POST /workflows/:id/validate` | Validation result without saving |
| `POST /projects/:id/workflows/drafts` `{ prompt, baseWorkflowId? }` | Ask the workflow architect for a draft; returns the assignment to follow |
| `GET /workflows/:id/versions`, `GET /workflows/:id/diff?from=&to=` | Version history and graph diff |
| `POST /workflows/:id/activate` `{ version }` | Make a draft version active |
| `GET /runs/:id/metrics`, `GET /projects/:id/metrics` | Live node, edge and run metrics with bottlenecks |
| `GET /projects/:id/runs?status=` | Runs for a project, newest first |
| `POST /workflows/:id/runs`, `GET/PATCH /runs/:id`, `POST /runs/:id/{pause,resume,stop}` | Runs |
| `POST /runs/:id/inputs` | Durably accept ideas or input items; budget-limited batches wait for capacity or the next UTC day. Empty items require an outstanding `requestId` |
| `GET /workflow-templates` | Template descriptions and editable graphs from `@perpeto/workflow` |
| `GET /runs/:id/work-items`, `GET /runs/:id/assignments` | Run detail |
| `POST /work-items/:id/decision` `{ decision, note?, decisionId }` | Answer a `human` gate; `decisionId` (exposed on the work item and `human.requested`) binds the answer to one gate visit, and a stale one gets `409 STALE_DECISION` |
| `GET /machines`, `POST /machines/enrollment-codes`, `POST /machines/:id/drain`, `POST /machines/:id/revoke` | Machines; revoke permanently invalidates every token for the machine |
| `GET /accounts` | Subscription pool across machines |
| `GET /assignments/:id` | One assignment, used to follow the workflow architect |
| `GET /jobs`, `GET /jobs/:id`, `GET /jobs/:id/log`, `POST /jobs/:id/cancel` | CI jobs |
| `GET /jobs/:id/bundle?attempt=N` | Git bundle of a hub-hosted job revision for the leasing machine or the owner; jobs with `source: { kind: 'hub-bundle' }` are fetched this way so any enrolled machine can run them. `409 SOURCE_UNAVAILABLE` if the revision is gone |
| `GET /projects/:id/merge-queue` | Merge queue |
| `GET /usage?projectId&runId&groupBy=provider|model|machine|day|role` | Token and agent usage |
| `GET /owner`, `PATCH /owner` `{ name?, initials? }` | Owner display name and initials (`ownerName` in hub config), also returned by `GET /session` and `/overview` |
| `GET /overview` | Counts for dashboards plus active/paused `runs` with settings, `intake` and `budgetUsage` |
| `GET /events?after=<seq>|latest=true|before=<seq>&runId=&limit=` | Event page, always oldest first; `after` returns `{events, nextCursor, hasMore}`, `latest`/`before` add `previousCursor`; the three are mutually exclusive. `Accept: text/event-stream` streams live, also filterable by `runId` |
| `GET /session`, `POST /session`, `DELETE /session` | Exchange the owner bearer for an HttpOnly, SameSite=Strict `perpeto_session` cookie (`sessionTtlMs`, sliding); cookie-authenticated mutations need an `Origin` in `corsOrigins` and a JSON body, else `403 CSRF_REJECTED` |
| Messaging | Existing routes from [messaging](../guides/messaging.md), served by the hub under `/api/v1/messaging/…` |

### Continuous intake and budgets

`POST /workflows/:id/runs` accepts `{input: {items?, keepOpen?, source?, schedule?, budget?}}`. Settings may also be top-level. `PATCH /runs/:id` changes `{keepOpen?, source?, schedule?, budget?}` on running or paused runs; `budget` replaces the previous limits, and `{}` removes them. Limits are positive safe integers. A schedule is five numeric UTC cron fields with lists/ranges/steps; a schedule source requires a valid schedule, falling back to graph input config when omitted. Settings never mutate the pinned workflow graph. Terminal runs reject changes.

Hub maintenance sends a stable `input.tick` once per observed UTC minute to running keep-open or budgeted runs. The minute marker, engine event id, input requests and prepared input batches survive restart. Missed scheduled minutes are not replayed. User-paused and terminal runs are not ticked or refilled. Goals intake omits done/dropped goals, goals whose linked leaves are all done, and goals already active or reserved across project workflows; work-item responses expose `goalId`. Sources include project docs, goal evidence, usage metrics and recent outcomes. Empty source replies fulfil the outstanding request and wait for another tick.

Each accepted usage delta is stored with a durable delivery intent in the ledger transaction, then sent to the engine after commit using the usage record's id. Budgets count input plus output tokens, excluding cache subtotals; usage events must be deltas, not cumulative snapshots. Delayed usage from a previous window remains in the ledger without consuming the current window. `maxActiveItems` bounds unfinished leaf work, and `maxItemsPerDay` includes planner children. `budget.exhausted` pauses intake and planner expansion; existing assignments and retries continue. The next eligible tick/result emits `budget.available`. Daily allowances reset at UTC midnight on the next event. These are intake limits, not hard spend caps for work already admitted.

Manual batches are split to available capacity and retained until admitted. A finite run with deferred inputs stays open internally until its last batch is admitted, then returns to normal completion. Configuration edits and these finite-run holds use the hub's existing whole-state snapshot path because the workflow package has no configuration event; ordinary runs retain incremental RunStore persistence. Snapshot runs remain durable but each event writes the full state, and their later events are outside RunStore replay verification. The hub records configuration changes in its event log. Moving this contract into a native workflow configuration event is future work.

Run detail and `/overview.runs` expose `intake` (including its pause reason) and `budgetUsage: {day, tokens, items}` separately from user pause state. `completedAt` records successful completion; `stoppedAt` records any terminal end, preserving the engine's timestamp when available. `/usage?groupBy=role` groups by assignment role, falling back to its node id; new usage retains that attribution through rollup or assignment deletion. Older usage without retained assignment evidence groups as `unknown`.

Delivery persists `MergeEntry.rejectionKind: 'conflict'|'ci'|'other'` from typed queue transitions. Preparation `MERGE_CONFLICT` is `conflict`; failed speculative checks or missing/stale evidence are `ci`; infrastructure/publication/withdrawal failures are `other`. The hub copies it to its merge entry and maps it to `merge.rejected.data.kind`. Historical/untyped causes remain `other`; reason text never activates recovery.

Merge config defaults to `onConflict: 'rebase'` and `rebaseReview: 'changed'`. Explicit conflicts lease the most recent successful builder with `assignment.step: 'rebase'` and `rebaseOf` naming the rejected merge. The hub retains `rebaseTouchedBeyondConflicts?: boolean` in stored and engine results. Only explicit `false` skips repeated review under the default policy; true or missing evidence repeats it. Fresh CI still runs at the new head before another merge. Recovery movement events keep `step: 'rebase'`, `edgeId: null` and `unplanned: false`; these engine-owned moves are excluded from authored-edge traffic. Node and run metrics expose `conflictRejections` and `rebases`, summed across project runs; per-run `conflict-churn` findings remain tagged with `runId`.

Planner `items[].touches?: string[]` survive hub result transport and remain engine-validated declarations, not actual edit enforcement. With `serializeOverlappingTouches` enabled, overlapping file/directory scopes serialize within a run until terminal delivery; absent/empty declarations preserve legacy concurrency. Cross-run edit coordination is not implied. Executor parser/output-format support for these result fields is a separate integration boundary, recorded precisely in [the hub handoff](../handoffs/factory-hub.md#executor-handoff).

### Node protocol

| Method and path | Purpose |
| --- | --- |
| `POST /nodes/enroll` `{ code, name, os, arch, labels, providers, version }` | Exchange a one-time enrollment code for `{ machineId, token }` |

Enrollment codes come wrapped in a paste-able join code, `pj1_` + base64url `{ url, fingerprint?, code }` (`POST /machines/enrollment-codes` accepts `{ url?, pin? }`). With hub TLS enabled (self-signed, generated on first start), nodes pin the certificate's SHA-256 fingerprint and send nothing to a server with a different one; `GET /tls`, `POST /tls/rotate` and `POST /tls/activate` manage rotation, and heartbeat responses carry `tls.fingerprints` so running nodes follow it. A non-loopback hub without TLS refuses to start (`INSECURE_BIND`) unless `allowInsecureRemote` is set. Tailscale (`perpeto hub expose --tailscale`) is the recommended path between machines.

| `POST /nodes/heartbeat` `{ capacity, running, accounts: Account[], providers, labels }` | Every 10 s. Missing three marks the machine `offline` |
| `POST /nodes/lease` `{ kinds: ['assignment','job'], max }` | Long-poll up to 25 s. Returns leased assignments and jobs with `leaseExpiresAt` (60 s) |
| `POST /assignments/:id/renew`, `POST /jobs/:id/renew` | Extend a lease while working |
| `POST /assignments/:id/release`, `POST /jobs/:id/release` `{ attempt, idempotencyKey?, reason? }` | Hand back unstarted work without consuming an attempt; the same machine is not offered it again for one lease duration |
| `POST /nodes/token` `{ idempotencyKey? }` | Rotate this machine's token; the old token works until the new one is first used |
| `POST /assignments/:id/events` `{ type: 'started'|'progress'|'usage'|'message'|'completed'|'failed', data }` | Report progress, usage and the final `AssignmentResult` |
| `POST /jobs/:id/events` `{ type: 'started'|'log'|'step'|'completed', data }` | Report log chunks and the final status bound to `revision`; the final result must carry `configHash` |

Lease wire format, fixed after the node implementation:

- `POST /nodes/lease` returns `{ assignments: Assignment[], jobs: Job[] }`. Every item includes `attempt` and `leaseExpiresAt`.
- Renew and event bodies include `attempt` beside `idempotencyKey`. The hub checks machine ownership, attempt and expiry atomically, so an older attempt re-leased to the same machine is fenced off. Renew returns `{ leaseExpiresAt }`; a node that gets no confirmation abandons the work.
- Heartbeat bodies include `status: 'online'|'draining'`. Heartbeat responses are `{ status, cancel: { assignments: string[], jobs: string[] } }`; the node aborts listed work and reports it `cancelled`. This is how stopping a run or cancelling a job reaches a machine.

A run result the engine refuses is acknowledged with `200` plus a `reason` and recorded as a failed attempt, so a node never loops resending it.

Heartbeats, renewals and CI log lines do not write events; liveness lives in machine state, logs at `GET /jobs/:id/log`. The log records only transitions (`machine.online`, `machine.offline`). `/events` and the stream accept `exclude=`, `types=` and `projectId=` filters and exclude legacy noise types by default. Free capacity is computed from the leases the hub holds, not the heartbeat's `running` count.

Finished assignments and jobs are archived after `finishedWorkRetentionMs` but remain readable by id and in per-run listings. Events, usage and idempotency records have their own retention keys; event retention is at least 7 days so metric windows stay complete, and usage past retention keeps hourly rollups.

An expired lease on run work is reported to the engine as a failed attempt, and the engine's retry policy schedules the next attempt. Project-scoped work and merge-queue jobs return to `queued` with `attempt + 1`. Results from a stale lease are rejected with `409 lease_lost`, so a reconnecting machine cannot overwrite newer work.

## Node executors

```js
// apps/node
/** @typedef {{ signal: AbortSignal, report: (event) => Promise<void>, workspace: string }} ExecContext */
/** Executor: { kind: string, canRun(assignment, machine): boolean, run(assignment, ctx): Promise<AssignmentResult> } */
```

The node ships a `fake` executor for tests and loads `@perpeto/t3-executor` for real work. CI jobs run in a fresh worktree checked out at `revision`, one directory per job, never in a developer's checkout.

`@perpeto/t3-executor` creates a T3 thread for each assignment on the configured provider and model, sends the prompt, follows the thread's events to completion, forwards token usage as `usage` events, and enforces `AgentPolicy`: subagent creation beyond `maxSubagents` or to a provider outside `allowedSubagentProviders` is refused.

`@perpeto/accounts` chooses which subscription account a T3 provider instance uses. When a harness reports a rate limit, the account cools down and new assignments and retries go to the next eligible account. A running conversation is not moved between accounts. It never copies credentials between machines.

## Clients and brand

Both clients follow Perpeto Mono strictly (see [design system](design-system.md)): [brand/README.md](../../brand/README.md), [brand/tokens.css](../../brand/tokens.css) and the Spindle identity in `brand/identity/`. `packages/design-tokens` is the only place clients read colors, type scale, spacing and radii from. No ad-hoc colors, no uppercase microcopy, no numbered eyebrows or tracked-out kickers, no decorative node meshes or gradients. The workflow editor is the one place nodes and edges appear: soft rounded nodes and thin grey edges on a faint dot grid, not a ruled drawing or a sci-fi network.

Primary navigation: Projects → Project (Overview, Workflows, Runs, Work, Messages, Merge queue) and Factory (Machines, Accounts, Usage). Usage and agent counts are always visible at the project level.

## Scale target

Design for many machines: leases, a global event sequence, idempotent writes and stateless clients let the hub move from SQLite to a networked database later. The first verified target is 5 machines and 100 concurrent agents on one hub. Do not claim higher scale without a load test.

## Verification

Each package has `node --test` coverage of its contract, including restart and lease-expiry cases where relevant. `npm test` discovers Node tests under `apps/` (hub, node, cli), `packages/`, `tests/` and `scripts/`; each workspace also runs its own suite with `npm test -w <package>`. The web app uses Vitest and the Apple app uses `swift test`. End-to-end: one hub, one node, fake executor, a `build` workflow run from input to merged output against a local bare Git repository. Live T3 and harness runs are separate, explicitly reported checks.
