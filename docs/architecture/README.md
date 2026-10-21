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
- Every mutating request accepts an `idempotencyKey`. A repeat with the same body returns the original result; a repeat with a different body returns `409 conflict`.
- Errors are `{ "error": { "code": "SNAKE_CASE", "message": "…" } }` and never include raw SQL, stack traces, or secrets.
- Paths that URL normalization would rewrite (dot segments, encoded slashes, repeated slashes) are rejected with `400 INVALID_PATH`; authorization and routing always use the same normalized path.

## Entities

```ts
Project      { id, name, repo: { url, defaultBranch, localPath? }, docs: DocRef[], goals: string[], createdAt, updatedAt }
DocRef       { id, title, path?: string, url?: string, kind: 'requirements'|'vision'|'spec'|'notes' }
Workflow     { id, projectId, name, purpose: 'build'|'improve'|'maintain'|'custom', version, graph: WorkflowGraph, status: 'draft'|'active'|'paused' }
Run          { id, projectId, workflowId, workflowVersion, status: 'running'|'paused'|'stopped'|'completed'|'failed', startedAt, stoppedAt? }
WorkItem     { id, runId, title, body, nodeId, status: 'queued'|'active'|'blocked'|'done'|'failed', branch?, prUrl?, headSha?, iteration, parentId? }
Assignment   { id, projectId, repo: { url, defaultBranch, localPath? } /* copied from the project when created */, runId? /* absent for project-scoped work such as the workflow architect */, workItemId?, nodeId, role, prompt, harness: Harness, policy: AgentPolicy,
               requirements: MachineRequirements, status: 'queued'|'leased'|'running'|'succeeded'|'failed'|'cancelled',
               machineId?, leaseExpiresAt?, attempt, result?: AssignmentResult }
Harness      { provider: string, model: string, options?: Record<string, string|boolean> }   // provider = T3 driver kind, e.g. 'claudeAgent', 'codex'
AgentPolicy  { maxSubagents: number, allowedSubagentProviders: string[], maxTurns?: number, maxTokens?: number, canMessage: string[] }
MachineRequirements { os?: 'darwin'|'linux'|'windows', labels?: string[], providers?: string[] }
AssignmentResult { outcome: 'success'|'failure'|'blocked', summary, branch?, prUrl?, headSha?, threadRef?,
                   verdict?: 'pass'|'fail' /* review gates; a review without a verdict is an error, not a rejection */,
                   items?: { title, body? }[] /* planner output */, graph?, rationale? /* workflow architect */ }
Job          { id, projectId, runId?, workItemId?, repo, revision /* full commit sha */, steps: JobStep[],
               requirements: MachineRequirements, status: 'queued'|'leased'|'running'|'passed'|'failed'|'cancelled'|'error',
               machineId?, leaseExpiresAt?, attempt, logRef?, artifacts: ArtifactRef[], configHash }
JobStep      { name, run: string /* shell command */, timeoutSec? }
MergeEntry   { id, projectId, queueId, prUrl, headSha, baseBranch, status: 'queued'|'testing'|'merging'|'merged'|'rejected', jobId?, reason?,
               mergedRevision?, deliveryError? }
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
| `input` | Source of work: ideas, backlog, goals, docs | `source: 'manual'|'goals'|'issues'`, `docs: DocRef ids` |
| `planner` | Agent that turns input into work items | `harness`, `prompt`, `maxItems` |
| `agent` | Agent role that does a work item | `harness`, `prompt`, `concurrency`, `policy` |
| `review` | Agent review gate; passes or returns work | `harness`, `prompt`, `rubric` |
| `ci` | CI gate run on a user-owned machine at the exact head commit | `steps`, `requirements` |
| `merge-queue` | Serialises merges into the base branch | `strategy: 'serial'|'batch'`, `requiredChecks`, `method: 'squash'|'merge'|'rebase'`, `publication: 'fast-forward-push'|'github-merge-queue'` |
| `loop` | Repeats its body until a condition or limit | `until: 'review-pass'|'ci-pass'|'manual'`, `maxIterations` |
| `human` | Pauses for a person | `prompt` |
| `output` | Terminal: work item finished | none |

Ports: gates have `pass` and `fail` output ports. `flow` edges move work items. `delegates` edges grant authority for the source agent to create subagents or assign to the target role, bounded by the target's `concurrency` and the source's `policy.maxSubagents`. `messages` edges permit the two roles to message each other; the engine derives each assignment's `policy.canMessage` from them.

Node config may also set `concurrency`, `policy`, `requirements` and `role` on planner and review nodes, and `expectedIterations` on loops. An agent reached only by `delegates` edges is a helper role. A run completes when every work item finishes unless the run was started with `keepOpen`.

The engine is deterministic: it reads the run's state plus incoming results (assignment finished, job finished, human decision) and emits new work items, assignments, jobs and merge entries. It never calls a harness. A loop counts iterations on the work item and fails it at `maxIterations`.

Default templates live in `packages/workflow/templates/`: `build` (input → planner → agent pool → review loop → CI → merge queue → output) and `improve` (goals → auditor → agent → review → CI → merge queue → output).

## Agent-authored workflows

Users should not have to build workflows by hand. The default path is a prompt: "Describe how this project should be built." The hub creates an assignment for a `workflow-architect` role, which runs through T3 like any other agent with the project's docs, goals, available machines, providers and existing workflows as context. Its `AssignmentResult` carries `{ graph, rationale }`.

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

An interaction with no matching edge is recorded with `unplanned: true` and shown, rather than hidden.

### Metrics

`GET /runs/:id/metrics?window=1h|24h|7d` and `GET /projects/:id/metrics?window=` return:

```ts
NodeMetrics   { nodeId, queued, active, done, failed, concurrency, utilization /* active ÷ concurrency */,
                waitSec: { avg, p90 }, serviceSec: { avg, p90 }, throughputPerHour, failureRate, tokens }
EdgeMetrics   { edgeId, kind, count, unplanned }
RunMetrics    { velocity: { itemsDonePerDay, trend: number[] }, cycleTimeSec: { avg, p90 }, wip,
                tokensPerItem, activeAgents, machines: { machineId, activeAgents, nodes: string[] }[] }
Bottleneck    { nodeId, reason: 'saturated'|'queue-growing'|'high-failure'|'waiting-on-human'|'no-capacity'|'rework-loop',
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
| `POST /workflows/:id/runs`, `GET /runs/:id`, `POST /runs/:id/{pause,resume,stop}` | Runs |
| `POST /runs/:id/inputs` | Add ideas or input items to a running workflow |
| `GET /runs/:id/work-items`, `GET /runs/:id/assignments` | Run detail |
| `POST /work-items/:id/decision` `{ decision, note?, decisionId }` | Answer a `human` gate; `decisionId` (exposed on the work item and `human.requested`) binds the answer to one gate visit, and a stale one gets `409 STALE_DECISION` |
| `GET /machines`, `POST /machines/enrollment-codes`, `POST /machines/:id/drain`, `POST /machines/:id/revoke` | Machines; revoke permanently invalidates every token for the machine |
| `GET /accounts` | Subscription pool across machines |
| `GET /assignments/:id` | One assignment, used to follow the workflow architect |
| `GET /jobs`, `GET /jobs/:id`, `GET /jobs/:id/log`, `POST /jobs/:id/cancel` | CI jobs |
| `GET /projects/:id/merge-queue` | Merge queue |
| `GET /usage?projectId&runId&groupBy=provider|model|machine|day` | Token and agent usage |
| `GET /overview` | Counts for dashboards: active agents, queued work, tokens today, machines online |
| `GET /events?after=<seq>&limit=` | Event page; `Accept: text/event-stream` streams live |
| Messaging | Existing routes from [messaging](../guides/messaging.md), served by the hub under `/api/v1/messaging/…` |

### Node protocol

| Method and path | Purpose |
| --- | --- |
| `POST /nodes/enroll` `{ code, name, os, arch, labels, providers, version }` | Exchange a one-time enrollment code for `{ machineId, token }` |
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

Heartbeats and renewals update machine and lease state only; they do not write events. Free capacity is computed from the leases the hub holds, not the heartbeat's `running` count.

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

Both clients follow the Workshop system strictly: [brand/README.md](../../brand/README.md), [brand/tokens.css](../../brand/tokens.css) and the Spindle identity in `brand/identity/`. `packages/design-tokens` is the only place clients read colors, type scale, spacing and radii from. No ad-hoc colors, no uppercase microcopy, no numbered eyebrows or tracked-out kickers, no decorative node meshes or gradients. The workflow editor is the one place nodes and edges appear, and it should look like a precise ruled drawing, not a sci-fi network.

Primary navigation: Projects → Project (Overview, Workflows, Runs, Work, Messages, Merge queue) and Factory (Machines, Accounts, Usage). Usage and agent counts are always visible at the project level.

## Scale target

Design for many machines: leases, a global event sequence, idempotent writes and stateless clients let the hub move from SQLite to a networked database later. The first verified target is 5 machines and 100 concurrent agents on one hub. Do not claim higher scale without a load test.

## Verification

Each package has `node --test` coverage of its contract, including restart and lease-expiry cases where relevant. `npm test` discovers Node tests under `apps/` (hub, node, cli), `packages/`, `tests/` and `scripts/`; each workspace also runs its own suite with `npm test -w <package>`. The web app uses Vitest and the Apple app uses `swift test`. End-to-end: one hub, one node, fake executor, a `build` workflow run from input to merged output against a local bare Git repository. Live T3 and harness runs are separate, explicitly reported checks.
