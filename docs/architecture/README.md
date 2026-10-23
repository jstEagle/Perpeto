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
| `packages/pacer` | `@perpeto/pacer` | Pure subscription pacer: plans agents per provider and account from usage windows, learned burn rates, slots and ready work. No I/O. |
| `packages/t3-executor` | `@perpeto/t3-executor` | Executor that drives a local T3 environment: threads, turns, events, token usage, subagent policy. |
| `packages/janitor` | `@perpeto/janitor` | Storage janitor: bounded inventory of worktrees, workspaces, build artifacts and caches; retention policy; journaled, re-checked deletion. Injectable fs and exec. |
| `packages/t3-observer` | `@perpeto/t3-observer` | Read-only observer of an operator's own running T3 Code: sessions, per-turn usage and subscription windows. No hub coupling. |
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
               mergedRevision?, deliveryError?, rejectionKind?: 'conflict'|'ci'|'other',
               lane?, priority?, cause?: 'ci'|'conflict'|'head-changed'|'timeout'|'manual'|'approvals'|'other' }
// Speculative merge-queue Jobs also carry delivery: { queueId, mergeEntryIds }.
MergeQueueConfig { version: 1, queues: QueueConfig[] }   // hub document per project, plus .perpeto/merge-queue.json
QueueConfig  { name, branches: string[] /* globs */, strategy: 'serial'|'batch'|'speculative', maxBatchSize, depth, requiredChecks: string[],
               method, publication, lanes: { name, priority, labels[], branches[] }[], defaultLane?, freeze: { windows: ({ cron, durationMinutes } | { start, end })[] },
               maxInFlight|null, flakyRetries, bisectOnBatchFailure, autoRebaseOnConflict, ejectAfterMinutes|null, requiredApprovals }
Machine      { id, name, os, arch, labels: string[], providers: string[], capacity: { maxAgents, maxJobs },
               running: { agents, jobs }, status: 'online'|'offline'|'draining', lastHeartbeatAt, version, tokenGeneration, revokedAt?,
               reportedLabels?, health?: MachineHealth, workspaces?: { repos: string[] /* repoKey of repos worked on recently */ },
               schedule?: { cordoned, drain, weight /* 0..10 */, maxAgents|null, maxJobs|null, labels|null, allowOnBattery|null, updatedAt },
               placement /* computed on read */: { status: 'online'|'limited'|'overloaded'|'cordoned'|'draining'|'drained'|'offline', accepting,
                 configured: { agents, jobs }, effective: { agents, jobs }, held: { agents, jobs }, loadPerCore?, weight, reasons: PlacementReason[] },
               runner?: { pools: { name, maxJobs }[], labels: string[], cache?: { sizeBytes, maxBytes, entries } },   // CI runner capability, separate from agent slots
               storage?: { state: 'ok'|'low'|'critical', totalBytes?, freeBytes?, freePercent?, reclaimableBytes, attentionCount, scannedAt } }   // from the storage janitor; placement may avoid low/critical machines
MachineHealth { reportedAt, cpus?, load?: [1m, 5m, 15m], memory?: { totalBytes, freeBytes, pressure?: 'normal'|'warn'|'critical' }, processes?,
               power?: { source: 'ac'|'battery', percent?, charging? }, thermal?: 'nominal'|'fair'|'serious'|'critical', uptimeSec?, nodeVersion?,
               runtime?: { reachable }, disk?: { totalBytes, freeBytes } /* workspace volume */, storage?: { state: 'ok'|'low'|'critical' } /* storage janitor */ }
PlacementReason { code: 'offline'|'revoked'|'cordoned'|'draining'|'overloaded'|'busy'|'memory-pressure'|'low-disk'|'on-battery'|'thermal'|'too-many-processes'|
               'runtime-unreachable'|'no-provider'|'full'|'capped-by-node'|'no-telemetry', message, effect: 'blocks'|'blocks-agents'|'blocks-jobs'|'reduces'|'info' }
// Assignments and Jobs record placement?: { machineId, score, reasons: string[], at } when leased.
PipelineRun  { id /* plr_… */, projectId, pipeline, revision, ref?, trigger: { kind: 'manual'|'merge-queue'|'pull-request'|'schedule'|'workflow', runId?, workItemId?, jobId?, mergeEntryIds?, cron? },
               status: 'queued'|'running'|'passed'|'failed'|'cancelled'|'error', configSource: 'repo'|'project'|'none', configHash?, jobs: PipelineRunJob[],
               createdAt, startedAt?, finishedAt?, durationMs?, supersededBy?, reason?, retries? }
PipelineRunJob { key /* 'test (node=22)' */, name, matrix?, needs: string[] /* keys */, runsOn: { pool?, os?, labels }, status: 'waiting'|'queued'|'leased'|'running'|'passed'|'failed'|'cancelled'|'error'|'skipped',
               jobId? /* current hub Job */, machineId?, attempt, maxAttempts, attempts: { jobId, status, machineId?, queuedAt, startedAt?, finishedAt? }[],
               queuedAt?, startedAt?, finishedAt?, durationMs?, queueWaitMs?, flaky?, cache?: { key, hit }[], artifacts?: { id, jobId, name, path, size }[] }
// Pipeline Jobs also carry pipelineRunId, pipelineJob (key), runsOn, pool (once leased), env, cache, collect (artifact specs), timeoutSec, startedAt.
// A Job with pipeline (workflow ci node) or pipelines (merge-queue candidate) is a proxy: never leased, status 'running' until its pipeline runs finish.
Account      { id, machineId, provider, label, status: 'active'|'cooling'|'disabled'|'invalid', cooldownUntil?, lastUsedAt?, plan?: string,
               usage?: { checkedAt, windows: UsageWindow[] },   // percentages and reset times only: never credentials, emails, fingerprints or paths
               source?: 'observed', providerInstanceId? }      // observed: a provider instance of an operator's own T3, reported by an observe-only node
Session      { id, machineId, machineName, threadId, title?, project?: { name, path? /* folder name */ }, branch?, worktree? /* folder name */, provider, providerInstanceId, model?,
               status: 'running'|'waiting'|'idle'|'error', parentThreadId?, childCount, createdAt, lastActivityAt, turns,
               tokens: { input /* uncached */, output, cacheRead, cacheWrite, reasoning } }   // a thread observed in an operator's own T3
UsageWindow  { id /* provider's stable id: five_hour, seven_day, primary… */, kind: 'session'|'weekly'|'monthly'|'other', label, usedPercent /* 0..100 */, resetsAt?, windowMins? }
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
| `ci` | CI gate run on a user-owned machine at the exact head commit | `steps` or `pipeline` (a pipeline name from `.perpeto/ci.json`), `requirements` |
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
Bottleneck    { nodeId, reason: 'saturated'|'queue-growing'|'high-failure'|'waiting-on-human'|'no-capacity'|'rework-loop'|'conflict-churn'|'under-burning',
                evidence: string, severity: 'info'|'warning'|'critical' }
```

Bottlenecks are computed from measured state, never guessed by a model. Examples: utilization at or above 0.9 with a growing queue is `saturated`; queued work whose requirements no online machine meets is `no-capacity`; loop iterations rising above the configured average is `rework-loop`; a pacing plan whose provider has less ready work than its subscriptions sustain is `under-burning`, attached to the input node of each running run that uses that provider (see [subscription pacing](#subscription-pacing)). Each bottleneck carries the numbers behind it in `evidence`.

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
| `GET /machines`, `POST /machines/enrollment-codes`, `POST /machines/:id/drain`, `POST /machines/:id/revoke` | Machines with their computed `placement`; revoke permanently invalidates every token for the machine; the legacy drain stops the node's lease loop |
| `PATCH /machines/:id` `{ cordoned?, drain?, weight?, maxAgents?, maxJobs?, labels?, allowOnBattery? }` | Owner schedule; idempotent. Emits `machine.cordoned`, `machine.uncordoned`, `machine.draining`, `machine.drain-cancelled`, `machine.updated` only on change. See [fleet placement](#fleet-placement) |
| `GET /accounts` | Subscription pool across machines, with each account's `plan` and `usage` |
| `PATCH /accounts/:id` `{ label?, plan? }` | Owner display metadata; `plan: null` clears the operator plan. Shown at once and relayed to the owning node on its next heartbeat |
| `GET /pacing`, `PUT /pacing/settings` | Subscription pacing plan and settings; see [subscription pacing](#subscription-pacing) |
| `GET /assignments/:id` | One assignment, used to follow the workflow architect |
| `GET /jobs`, `GET /jobs/:id`, `GET /jobs/:id/log`, `POST /jobs/:id/cancel` | CI jobs |
| `GET /jobs/:id/bundle?attempt=N` | Git bundle of a hub-hosted job revision for the leasing machine or the owner; jobs with `source: { kind: 'hub-bundle' }` are fetched this way so any enrolled machine can run them. `409 SOURCE_UNAVAILABLE` if the revision is gone |
| `GET /pipelines?projectId&revision?` | Pipelines from `.perpeto/ci.json` at the revision (default: the default branch head the hub holds) or the project's stored config: `{ source, revision, path, pipelines: [{ name, triggers, jobs, lastRun? }], error? }` |
| `GET/PUT /projects/:id/ci-config` `{ config\|null }` | Project-level pipeline configuration, used when the hub cannot read the repository file |
| `GET /pipeline-runs?projectId&pipeline&status&limit`, `GET /pipeline-runs/:id` | Pipeline runs, newest first |
| `POST /pipeline-runs` `{ projectId, pipeline, revision?, ref? }` | Manual trigger; without `revision` the hub runs the `ref` or default branch head it holds (`400 REVISION_REQUIRED` otherwise). A run with a `ref` cancels older active manual, pull-request or schedule runs of that pipeline and ref |
| `POST /pipeline-runs/:id/cancel` `{ reason? }`, `POST /pipeline-runs/:id/retry` `{ job? }` | Cancel; rerun failed, cancelled or skipped jobs (one job and its dependents, or all) of a finished run |
| `GET /jobs/:id/log?after=<seq>&limit=` | `{ chunks: [{ seq, id, chunk, at }], nextCursor, hasMore, truncated, bytes }`; stored redacted and capped at `ci.logMaxBytesPerJob` |
| `GET /jobs/:id/artifacts`, `GET /jobs/:id/artifacts/:artifactId` | Artifacts a job uploaded (complete, digest-checked), and one artifact's bytes |
| `GET /runners` | Machines' pools, busy slots, mode (`agents`, `ci`, `both`, `observe`), dependency cache size and 24-hour CI utilisation; per-pool slots and queue |
| `GET /ci/insights?projectId&window=24h\|7d\|30d`, `GET /ci/flaky?projectId`, `POST /ci/validate` `{ config }` | Pass rate, duration trends and queue wait per pipeline and job; flaky jobs (passed and failed at the same revision); schema validation |
| `GET /projects/:id/merge-queue` | Merge queue entries (flat list, kept for older clients) |
| `GET /projects/:id/merge-queues`, `PUT` `{ config, baseVersion? }` | Project merge queue settings: hub document (versioned, `409 VERSION_CONFLICT` on a stale `baseVersion`, `400 INVALID_MERGE_QUEUE_CONFIG` with `error.details[{path,message}]`), the repository file status, the effective config and every queue (named `mqn_…` and workflow-defined `dq_…`); see [merge queues](#merge-queues) |
| `GET /merge-queues/:id?window=1h|24h|7d` | Live queue: entries in merge order with lane, status and ETA, attempts (batches and speculation), freeze, recent outcomes, metrics |
| `POST /merge-queues/:id/freeze` `{ reason? }`, `POST /merge-queues/:id/unfreeze` | Manual freeze: no new attempts start and tested work does not publish |
| `POST /merge-entries/:id/priority` `{ lane?, priority? }`, `/eject` `{ reason? }`, `/requeue` | Owner commands on an open entry; refused (`409`) once it is publishing |
| `GET /usage?projectId&runId&source=observed|factory&groupBy=provider|model|machine|day|role|source` | Token and agent usage; `source=observed` is usage from operators' own T3 sessions, which has no project |
| `GET /sessions?machineId&status&provider&since&limit&cursor` | Observed sessions, newest activity first: `{ sessions: Session[], nextCursor? }`; see [observe-only mode](#observe-only-mode) |
| `GET /sessions/summary?window=1h|24h|7d` | Machines observing, session totals and observed tokens by provider, model, machine and hour |
| `GET /storage`, `GET /storage/policy`, `GET /machines/:id/storage`, `POST /machines/:id/storage/{scan,cleanup}`, `GET /machines/:id/storage/cleanups/:id` | Storage janitor; see [storage janitor](#storage-janitor) |
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

| `POST /nodes/heartbeat` `{ capacity, running, accounts: Account[], providers, labels, health?, workspaces? }` | Every 10 s. Missing three marks the machine `offline`. Accounts may carry `plan` and `usage`; `health` is sanitized field by field and never fails a heartbeat |
| `POST /nodes/storage` `{ inventory?, summary?, cleanups? }` | Storage inventory and cleanup results; see [storage janitor](#storage-janitor) |
| `POST /nodes/observations` `{ batchId, source, sessions, removedThreadIds?, usage?, providers?, resync? }` | Observe-only report from the machine's own T3; see [observe-only mode](#observe-only-mode). `batchId` is the idempotency key |
| `POST /nodes/lease` `{ kinds: ['assignment','job'], max }` | Long-poll up to 25 s. Returns leased assignments and jobs with `leaseExpiresAt` (60 s) |
| `POST /assignments/:id/renew`, `POST /jobs/:id/renew` | Extend a lease while working |
| `POST /assignments/:id/release`, `POST /jobs/:id/release` `{ attempt, idempotencyKey?, reason? }` | Hand back unstarted work without consuming an attempt; the same machine is not offered it again for one lease duration |
| `POST /nodes/token` `{ idempotencyKey? }` | Rotate this machine's token; the old token works until the new one is first used |
| `POST /assignments/:id/events` `{ type: 'started'|'progress'|'usage'|'message'|'completed'|'failed', data }` | Report progress, usage and the final `AssignmentResult` |
| `POST /jobs/:id/events` `{ type: 'started'|'log'|'step'|'artifact'|'completed', data }` | Report log chunks while the job runs, artifact chunks `{ name, path, size, sha256, offset, data (base64, ≤ 512 KiB) }`, and the final status bound to `revision`; the final result must carry `configHash` and may carry `cache: [{ key, hit }]` |

Lease wire format, fixed after the node implementation:

- `POST /nodes/lease` returns `{ assignments: Assignment[], jobs: Job[] }`. Every item includes `attempt` and `leaseExpiresAt`.
- Renew and event bodies include `attempt` beside `idempotencyKey`. The hub checks machine ownership, attempt and expiry atomically, so an older attempt re-leased to the same machine is fenced off. Renew returns `{ leaseExpiresAt }`; a node that gets no confirmation abandons the work.
- Heartbeat bodies include `status: 'online'|'draining'`. Heartbeat responses are `{ status, cancel: { assignments: string[], jobs: string[] }, tls?, pacing?: { accounts: { [accountId]: { targetAgents } } }, accountUpdates?: { id, accountId, label?, plan?: string|null }[] }`; the node aborts listed work and reports it `cancelled`. This is how stopping a run or cancelling a job reaches a machine. `pacing` is present only while pacing is enabled and lists this machine's accounts of paced providers; without it the node's `paced` selection falls back to its own policy. `accountUpdates` repeat until the node's snapshot shows them.
- An assignment's `progress` event `{ interaction: 'account.bound', accountId }` names the account the agent runs on (an account of the same machine); the hub records it as `Assignment.accountId` to count agents per account.

A run result the engine refuses is acknowledged with `200` plus a `reason` and recorded as a failed attempt, so a node never loops resending it.

Heartbeats, renewals and CI log lines do not write events; liveness lives in machine state, logs at `GET /jobs/:id/log`. The log records only transitions (`machine.online`, `machine.offline`). `/events` and the stream accept `exclude=`, `types=` and `projectId=` filters and exclude legacy noise types by default. Free capacity is computed from the leases the hub holds, not the heartbeat's `running` count.

Finished assignments and jobs are archived after `finishedWorkRetentionMs` but remain readable by id and in per-run listings. Events, usage and idempotency records have their own retention keys; event retention is at least 7 days so metric windows stay complete, and usage past retention keeps hourly rollups.

An expired lease on run work is reported to the engine as a failed attempt, and the engine's retry policy schedules the next attempt. Project-scoped work and merge-queue jobs return to `queued` with `attempt + 1`. Results from a stale lease are rejected with `409 lease_lost`, so a reconnecting machine cannot overwrite newer work.

### Fleet placement

Placement is pull-based: nodes long-poll `POST /nodes/lease`, and the hub decides what each lease may take (`apps/hub/src/placement.js`).

- **Effective capacity.** `configured` is the node's capacity lowered by any owner override (an override cannot raise it). Health then blocks or scales it: load per core at or above `placement.loadHardPerCore` (1.5), more than `maxProcesses` (2,000), critical memory pressure, less than `minFreeDiskBytes` (10 GiB) free or storage `critical`, battery power without `allowOnBattery`, or thermal `critical` block all new work; load between `loadSoftPerCore` (0.8) and the hard limit scales linearly, and memory `warn`, storage `low` or thermal `serious` halve it. An unreachable T3 runtime or no providers blocks agents only. Cordon and drain block everything; drain is placement-only (the node keeps running) and reports `draining` until nothing is held, then `drained`. Telemetry older than `healthStaleMs` is ignored (`no-telemetry`), so a node without telemetry places by capacity only.
- **Spreading and affinity.** Each candidate is scored: free headroom (40), cool CPUs (20), the machine that last ran the item's work item or previous attempt (+25), a warm workspace for the item's repository (+15), all times the owner's `weight`. While another machine that is long-polling for that kind right now fits the item, has a free slot and scores at least `spreadMargin` (10) higher, a fresh item waits for it (that machine is woken at once); after `deferMs` (5 s) any eligible machine takes it. Leases record `placement`, also carried in the `*.leased` event.
- **Transitions.** `machine.placement-changed { from, to, reasons }` records status changes (for example `online` to `overloaded`); steady heartbeats write nothing.
- **Joining.** `perpeto hub invite` issues a join code whose `alts` lists every address the hub answers on (Tailscale name and IPs, then LAN), pinned to its certificate; `node join` keeps the first that answers. `perpeto doctor` explains a failed hub check: pin mismatch, refused port, timeout, no route, DNS or wrong protocol.

### Subscription pacing

The pacer keeps every subscription working and spends each usage window by its reset. Inputs are the heartbeat usage windows, burn rates learned per account and window, running agents per account, machine slots and ready work. The algorithm, worked examples and limits are in the [pacer handoff](../handoffs/pacer.md). Real subscriptions have not been paced live.

```ts
Pacing         { enabled, mode: 'enforce'|'advise', strategy: 'rotation'|'parallel', targetUsePercent, minAgents, maxAgents: number|null, updatedAt,
                 providers: PacingProvider[], accounts: PacingAccount[], timeline: { accountId, from, to, phase: 'burn'|'rest' }[] }   // timeline covers the next 10 h
PacingProvider { provider, targetAgents, runningAgents, slots, readyWork, limitedBy: 'weekly'|'session'|'slots'|'work'|'none', starved, sustainableAgents }
PacingAccount  { accountId, machineId, provider, label, plan?, status, state: 'burning'|'next'|'resting'|'cooling'|'exhausted'|'unknown',
                 targetAgents, runningAgents, burnPerAgentHour?, idleForecastMins,
                 windows: { id, kind, label, usedPercent, resetsAt?, projectedPercentAtReset, onTrack: 'under'|'on'|'over' }[] }
```

- A provider is paced once one of its enabled accounts reports usage windows; only paced providers appear in `providers`. Accounts of other providers are listed with `state: 'unknown'` and no allowance.
- `sustainableAgents` is what the subscriptions and slots could run with unlimited work; `starved` means `readyWork` is below it. `burnPerAgentHour` is the learned session rate (percent per agent-hour) and is absent while the provider prior is used. `idleForecastMins` counts minutes in the next 10 h when the account's session clock runs with headroom but no agents are planned on it. Disabled and invalid accounts report `state: 'resting'` with their `status`.
- `PUT /pacing/settings` `{ enabled?, strategy?, targetUsePercent? (50..100), minAgents?, maxAgents? (null clears) }` takes `idempotencyKey` like other mutations, persists in the hub database, and returns the `Pacing` view. Defaults come from the hub config key `pacing` (`enabled: true`, `strategy: 'rotation'`, `targetUsePercent: 95`, burn-rate priors per provider and window kind).
- While enabled, leases cap each machine's agents per paced provider at the sum of its accounts' `targetAgents`; caps never raise workflow or machine limits. The hub emits `pacing.updated` (provider targets, limits, account states and targets) when the plan changes materially, `pacing.settings-updated`, `account.updated` after `PATCH /accounts/:id`, and `pacing.nudged` when a starved fleet gives an idle keep-open scheduled run one improvement pass ahead of its schedule (at most once per `pacing.nudgeIntervalMs`).
- Usage samples are stored per account when a fresh reading arrives (its `checkedAt` moves) and expire with `usageRetentionMs`.

### Merge queues

Each project can define named merge queues, one per target branch pattern. Precedence: built-in defaults, then the hub document (`PUT /projects/:id/merge-queues`), then `.perpeto/merge-queue.json` committed on the default branch, matched by queue name with each top-level field in the file replacing the hub's (lanes and freeze windows replace whole). A file that is invalid, alone or combined, is reported and ignored. A workflow `merge-queue` node uses a named queue with `config.queue: '<name>'` instead of inline `strategy`/`method`; inline nodes behave exactly as before. A named queue maps to one delivery queue per base branch and CI recipe, whose policy is reconfigured in place when settings change. Queue behaviour lives in `@perpeto/delivery`: lane priority ordering (FIFO within a lane), manual and cron/date freezes (block new attempts and publication), flaky retries on the same candidate, optional batch bisection, timeouts that eject waiting entries, `maxInFlight`, required approving reviews checked at admission, and speculative attempts stacked on the candidate ahead. Metrics per window: merged per hour (and hourly), median time in queue, failure rate by cause, batch success rate. Events: `merge-queue.config-updated`, `merge-queue.frozen`, `merge-queue.unfrozen`, `merge-entry.prioritized`, `merge-entry.ejected`, `merge-entry.requeued`. CLI: `perpeto queue [projectId]`, `perpeto queue freeze|unfreeze <queueId>`, `perpeto queue config validate <file>`. Example: [config/merge-queue.example.json](../../config/merge-queue.example.json).

### Observe-only mode

Justus asked on 22 October 2026 to hook Perpeto into his own T3 Code sessions and subscriptions on each Mac, for observability only. A node with `observe.enabled` (and usually `capacity: { maxAgents: 0, maxJobs: 0 }`, no executor, no runtime) runs `@perpeto/t3-observer` against the operator's running T3 desktop server. It reads only: `server.getConfig`, `orchestration.subscribeShell` and bounded `orchestration.subscribeThread` snapshots, with a session minted once by T3's own CLI with scope `orchestration:read`. It never sends a command, settings change or provider refresh. The [observe guide](../guides/observe.md) covers auth, what leaves the machine, install and limits.

```ts
ObservationBatch { batchId, observedAt?, source: { connected, serverVersion?, error? },
                   sessions: ObservedSession[] /* ≤ 500, changed since the last acknowledged batch */, removedThreadIds?: string[] /* ≤ 1000 */,
                   usage?: ObservedUsage[] /* ≤ 2000 */, providers?: ObservedProvider[] /* ≤ 50, the full list when it changed */,
                   resync?: { id, final } /* after a node start: every live session, chunked; the final chunk prunes sessions it did not list */ }
ObservedSession  { threadId, title?, project?: { name, path? }, branch?, worktree?, provider /* driver */, providerInstanceId, model?, status, parentThreadId?, createdAt, lastActivityAt, turns }
ObservedUsage    { providerTurnId, threadId, providerInstanceId, provider, model, inputTokens /* uncached */, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, usageStatus?, at }
ObservedProvider { instanceId, driver, displayName?, plan? /* T3's subscription label, never an email */, status?, usage?: { checkedAt, windows: UsageWindow[] } }
```

- Status: a pending runtime request is `waiting`; an active run is `running`; a failed last run is `error`; else `idle`. Thread ids may be up to 1,024 characters (T3 derives child ids from parents).
- Usage is one ledger row per machine and provider turn (`INSERT OR IGNORE`), so replays and resends after a restart add nothing; it is stored without a project (`project_id ''`), tagged by machine and observed account, and feeds `GET /usage`, overview tokens and session totals. Records older than `usageRetentionMs`, and sessions idle longer than it, are not stored.
- Each provider instance becomes an `Account` with `source: 'observed'`, replacing that machine's previous observed accounts; heartbeats never remove them. Owner `PATCH /accounts/:id` edits of observed accounts stay on the hub and are not relayed, since the operator's T3 is never written to.
- Pacing learns burn rates for observed accounts from running-session counts per provider instance and each fresh usage reading, but never plans or caps them. `GET /pacing` reports `mode: 'advise'` when no online machine has agent slots. Observed accounts appear in `accounts` with `source: 'observed'`, `advisory: true`, `targetAgents: 0`, `runningAgents`, `state`, `idleForecastMins`, `sustainableAgents?`, `headroomAgents?` (agents that could still run and land on target), `burnPerAgentHour?` and windows with `projectedPercentAtReset` at the current measured burn, `onTrack`, `burnPerAgentHour`, `learned` and `exhaustsAt?`. They never enter lease caps or node allowances.
- Events: `session.updated` `{ machineId, threadId, status, previous? }` when a session appears or changes status (at most 50 per batch), and `sessions.changed` `{ machineId, running, waiting, idle, error }` per machine, at once after a status change and otherwise at most every 15 s. Token changes alone never emit per-session events.
- `Machine` gains `observe?: { connected, lastObservedAt, serverVersion?, error? }`; the summary counts a machine as observing while it reported a connected T3 within 90 s.
- `GET /sessions/summary` returns `{ window, machines: [{ machineId, name, online, observing, lastObservedAt?, observeError?, running, waiting, idle, error }], totals: { running, waiting, sessionsActive }, tokens: { byProvider: [{ provider, input, output, cacheRead, cacheWrite }], byModel: [{ model, … }], byMachine: [{ machineId, name, … }], series: [{ at, input, output }] } }`. `idle`, `error` and `sessionsActive` count sessions with activity in the window; `running` and `waiting` count all; `series` has one bucket per hour of the window.

### CI pipelines and runner pools

Pipelines come from the repository's `.perpeto/ci.json` at the run's revision (schema in [the CI guide](../guides/ci.md), validated by `@perpeto/delivery`'s `parsePipelineConfig`), else from the project's hub-stored config. The hub expands a pipeline into a DAG of Jobs (one per matrix combination) and creates each Job only when everything it `needs` passed; a failure skips dependents and the run finishes when nothing is left running. `retry.maxAttempts` reruns failed or errored jobs as new Jobs; a pass and a failure of the same job at the same revision mark it flaky (`ci.flaky-detected`). Events: `pipeline-run.created|started|finished|cancelled|superseded|retried`, `pipeline-job.retried`.

Naming contract with merge queues: `merge-queue.requiredChecks` entries are strings naming either a `ci` node id or a pipeline. A candidate whose queue requires pipelines (or whose required `ci` nodes name one) gets a proxy Job; the hub runs each pipeline at the candidate revision from the queue's repository and records one result, with the pipeline names as passed checks. Pipelines with a `merge-queue` trigger apply when a graph has no ci nodes and no required checks. `pull-request` triggers run when an agent reports a new head commit; `schedule` triggers run once per matching UTC minute at the default branch head.

Nodes advertise `runner: { pools, labels, cache }` in heartbeats. A Job's `runsOn.pool` selects a pool (absent: any pool with room) and `runsOn.labels` must be machine or runner labels. Leasing interleaves projects, fewest running jobs first. Node config `runner.cacheDir` (default `<dataDir>/ci-cache`, exported as `ciCacheRoot(config)` for storage cleanup, kind `ci-cache`) holds the per-project dependency cache, LRU-evicted above `runner.cacheMaxBytes`. Hub config `ci` sets the log cap, artifact path, caps and retention.

### Storage janitor

Justus asked on 23 October 2026 for Perpeto to keep machines from filling up (his Mac mini reached 98% with 55 GB of simulators, 29 GB of T3 worktrees and orphaned dev servers). Nodes whose config has a `storage` section (`perpeto node join` adds one) run `@perpeto/janitor`; the [storage handoff](../handoffs/storage.md) has the details and limits.

```ts
StorageItem    { id /* sti_…, stable per kind and path */, kind: 'perpeto-workspace'|'ci-workspace'|'ci-cache'|'perpeto-worktree'|'t3-worktree'|'build-artifact'|'global-cache',
                 path /* display-safe: ~ and $TMPDIR */, bytes, approximate?, lastModifiedAt, owner: { runId?, assignmentId?, jobId?, threadId?, workItemId? },
                 gitState?: { branch?, dirty, unpushedCommits, merged? }, reclaimable, action?: 'delete'|'strip', reason, attention?, advisory?, parentId?, hint?, ownedBy?: 'perpeto'|'foreign'|'system' }
StorageSummary { scannedAt, state: 'ok'|'low'|'critical', disk?: { totalBytes, freeBytes }, truncated, reclaimableBytes, reclaimableByKind, advisoryBytes, attentionCount, staleProcesses, items, top: StorageItem-ish[] /* ≤ 5 */ }
StorageCleanup { id /* scl_… or auto_… */, machineId, mode: 'dry-run'|'execute', itemIds?, source: 'owner'|'auto', status: 'pending'|'running'|'completed', requestedAt, completedAt?,
                 result?: { dryRun, freedBytes, actions: { itemId, kind?, path?, action?, bytes, status: 'deleted'|'stripped'|'would-delete'|'would-strip'|'skipped'|'needs-attention'|'failed', reason? }[] } }
```

- Policy: hub config `storage: { policy, machines: { <id or name>: policy } }`, then the node's own `storage` fields win. Defaults: scan every 15 min, auto-clean on, finished Perpeto workspaces and worktrees kept 24 h, artifacts stripped after 72 h idle, `cleanupForeignWorktrees: false`, low below 15% free (aggressive retention 2 h / 12 h), critical below 5%.
- Never deleted: dirty or unpushed work (it becomes `attention`), worktrees of unfinished work items (the heartbeat response lists their branches), folders a running assignment, CI job or dev server uses, artifacts Git does not ignore, global caches and processes (advisory only, with the command to run). Foreign (operator T3) worktrees go only when opted in and merged, clean, pushed and idle.
- Heartbeats carry `storage: StorageSummary` (or `{ pending: true }` before the first scan) and set `Machine.storage`; the response's `storage` holds `{ policy, activeBranches, scan?, cleanups? }`. Nodes post the inventory (largest 400 items plus every attention item) and cleanup results to `POST /nodes/storage`. Owners name items by id only; paths never travel from hub to machine.
- A `critical` node stops leasing new agent work itself; jobs and running work continue. The hub exposes the state for placement and lists it in `GET /storage` `alerts`.
- Events: `storage.scanned` `{ machineId, state, items, reclaimableBytes, attentionCount, truncated }`, `storage.cleaned` `{ machineId, cleanupId, mode, source, freedBytes, counts }`, `storage.low` `{ machineId, state, previous, severity }` on each worsening, and `storage.cleanup-requested`.

## Node executors

```js
// apps/node
/** @typedef {{ signal: AbortSignal, report: (event) => Promise<void>, workspace: string }} ExecContext */
/** Executor: { kind: string, canRun(assignment, machine): boolean, run(assignment, ctx): Promise<AssignmentResult> } */
```

The node ships a `fake` executor for tests and loads `@perpeto/t3-executor` for real work. CI jobs run in a fresh worktree checked out at `revision`, one directory per job, never in a developer's checkout.

`@perpeto/t3-executor` creates a T3 thread for each assignment on the configured provider and model, sends the prompt, follows the thread's events to completion, forwards token usage as `usage` events, and enforces `AgentPolicy`: subagent creation beyond `maxSubagents` or to a provider outside `allowedSubagentProviders` is refused.

`@perpeto/accounts` chooses which subscription account a T3 provider instance uses. When a harness reports a rate limit, the account cools down and new assignments and retries go to the next eligible account. A running conversation is not moved between accounts. It never copies credentials between machines. Its `paced` selection, the node default, picks accounts with free hub allowance first. The executor reads the account instance's T3 usage-limit snapshot when the instance is ready, after each root turn and every `usagePollMs` (2 min) during a turn, and feeds it to the pool, so heartbeats carry current windows.

## Clients and brand

Both clients follow Perpeto Mono strictly (see [design system](design-system.md)): [brand/README.md](../../brand/README.md), [brand/tokens.css](../../brand/tokens.css) and the Spindle identity in `brand/identity/`. `packages/design-tokens` is the only place clients read colors, type scale, spacing and radii from. No ad-hoc colors, no uppercase microcopy, no numbered eyebrows or tracked-out kickers, no decorative node meshes or gradients. The workflow editor is the one place nodes and edges appear: soft rounded nodes and thin grey edges on a faint dot grid, not a ruled drawing or a sci-fi network.

Primary navigation: Projects → Project (Overview, Workflows, Runs, Work, Messages, Merge queue) and Factory (Machines, Accounts, Usage, Storage). Usage and agent counts are always visible at the project level.

## Scale target

Design for many machines: leases, a global event sequence, idempotent writes and stateless clients let the hub move from SQLite to a networked database later. The first verified target is 5 machines and 100 concurrent agents on one hub. Do not claim higher scale without a load test.

## Verification

Each package has `node --test` coverage of its contract, including restart and lease-expiry cases where relevant. `npm test` discovers Node tests under `apps/` (hub, node, cli), `packages/`, `tests/` and `scripts/`; each workspace also runs its own suite with `npm test -w <package>`. The web app uses Vitest and the Apple app uses `swift test`. End-to-end: one hub, one node, fake executor, a `build` workflow run from input to merged output against a local bare Git repository. Live T3 and harness runs are separate, explicitly reported checks.
