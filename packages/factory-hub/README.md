# Factory hub

Dependency-free Node 24 HTTP control plane with its own durable SQLite state. It implements the [factory contract](../../docs/architecture.md) and the later agent-authored workflow, observation and node wire-format addenda. It never calls inference APIs.

**Engine and delivery:** the default engine is [workflow-adapter.js](src/engine/workflow-adapter.js) over `@perpeto/factory-workflow`; tests may still inject the in-package stub. Merge-queue nodes run through [delivery/index.js](src/delivery/index.js) over `@perpeto/factory-delivery`, for local bare repositories only. The [e2e suite](../factory-e2e/README.md) runs a real hub, node and bare repository with a fake executor. No live T3 harness run is claimed.

## Start

```sh
source ~/.nvm/nvm.sh && nvm use 24
node packages/factory-hub/bin/perpeto-hub.js --config config/hub.example.json
```

The example binds loopback port 4320. Paths resolve relative to the configuration file. The first start creates `.perpeto/hub/owner.secret`, mode 600, containing the owner bearer token. The CLI prints only its address. Read this token through an owner-only credential-file flow; do not put it in JSON configuration, command arguments, URLs or logs. Losing the secret file requires restoring it; the hub refuses to silently replace an existing owner identity.

The example JSON configures host/port, hub and messaging DB paths, owner secret path, exact allowed browser origins, request byte cap, heartbeat/lease/long-poll/maintenance intervals, enrollment TTL and the architect harness provider/model. Defaults are 10-second heartbeats, offline after three missed intervals, 60-second leases, 25-second long polls, 10-minute enrollment codes and a 1 MiB request cap. `architectHarness` selects a T3 harness; it does not call a model directly.

Embedders can use:

```js
import { createHub } from '@perpeto/factory-hub';
const hub = await createHub({ configPath: '/path/to/hub.json', engine });
const url = await hub.listen(); // config port 0 selects an ephemeral port
// ...
await hub.close();
```

There is no built-in TLS terminator. Loopback is the default. Remote transport setup and deployment are outside this package's verified scope.

## Authentication and retries

Routes live under `/api/v1`. `/health` and `/api/v1/health` are public. `/api/v1/nodes/enroll` authenticates with a one-time code rather than a bearer token. All other routes require `Authorization: Bearer <token>`.

Owner tokens can use the owner API. Node tokens can heartbeat, lease, and access their own currently leased assignments/jobs. They cannot read projects, accounts, global events, metrics, usage or owner messaging routes. Agent messages travel through their assignment's `message` event, checked against `policy.canMessage` and bound to its run channel and sender role.

All mutations accept `idempotencyKey` in the JSON body or `Idempotency-Key` in a header. Supply a fresh key per logical mutation and preserve it on retries. Matching bodies return the original status/body, even across restart. Changed bodies return `409 CONFLICT`. Object-key ordering does not change a fingerprint. Keys are scoped to authenticated identity, HTTP method and route. Without a key, a retry is a new request. The existing MessagingStore additionally enforces project-wide message keys. Enrollment-code and node-token retries reconstruct credentials from the owner secret and public entity IDs; the DB contains hashes and response metadata, never their plaintext.

Errors are `{ "error": { "code": "INVALID_INPUT", "message": "..." } }`. Lease rejection specifically uses `409` and `error.code: "lease_lost"`, matching the node wire format. Raw SQL and stacks are never returned.

## API summary

| Area | Routes under `/api/v1` |
| --- | --- |
| Projects | `GET/POST /projects`, `GET/PATCH /projects/:id` |
| Workflows | `GET/POST /projects/:id/workflows`, `GET/PUT /workflows/:id`, `POST /workflows/:id/validate` |
| Drafts | `POST /projects/:id/workflows/drafts` with `{prompt, baseWorkflowId?}` |
| Versions | `GET /workflows/:id/versions`, `GET /workflows/:id/diff?from=&to=`, `POST /workflows/:id/activate` with `{version}` |
| Runs | `POST /workflows/:id/runs`, `GET /runs/:id`, `POST /runs/:id/pause`, `/resume`, `/stop`, `/inputs` |
| Work | `GET /runs/:id/work-items`, `GET /runs/:id/assignments`, `POST /work-items/:id/decision`, `GET /assignments/:id` |
| Metrics | `GET /runs/:id/metrics?window=1h|24h|7d`, `GET /projects/:id/metrics?window=...` |
| Machines | `GET /machines`, `POST /machines/enrollment-codes`, `POST /machines/:id/drain` |
| Accounts | `GET /accounts` |
| Jobs | `GET /jobs`, `GET /jobs/:id`, `GET /jobs/:id/log`, `POST /jobs/:id/cancel` |
| Delivery | `GET /projects/:id/merge-queue` |
| Usage | `GET /usage?groupBy=provider|model|machine|day` |
| Overview | `GET /overview`, optionally `?projectId=...` |
| Events | `GET /events?after=0&limit=100`, or SSE with `Accept: text/event-stream` |
| Nodes | `POST /nodes/enroll`, `/nodes/heartbeat`, `/nodes/lease` |
| Lease reports | `POST /assignments/:id/renew`, `/events`, and the corresponding `/jobs/:id/...` |

List responses use `{projects}`, `{workflows}`, `{versions}`, `{machines}`, `{accounts}`, `{jobs}`, `{workItems}`, `{assignments}` or `{entries}`. Single entities are returned directly. Draft requests return the architect Assignment with HTTP 202. Follow it using `GET /assignments/:id`; invalid attempts expose `retryAssignmentId` and `architectErrors`, and a valid result exposes `draftWorkflowId` and `draftVersion`. There are at most three architect validation attempts, independent of lease requeue attempts. Architect assignments belong to a project before there is a run, so they omit `runId`/`workItemId`.

New workflow versions are always drafts with `authoredBy`, optional `rationale` and `parentVersion`. `versions` returns immutable saved records. Activation changes a separate `activeVersion` pointer, not historical records or live runs. A workflow head may show a newer draft alongside its older `activeVersion`; new runs use that active version. Starting a workflow with no active version returns `409 WORKFLOW_NOT_ACTIVE`.

Metrics return `{nodes, edges, run, bottlenecks}` and default to a 24-hour window. State, events, usage and window bounds go to `engine.computeRunMetrics`; graph diffs, architect prompt construction and result parsing also belong to the engine interface. The hub overlays `run.activeAgents` and `run.machines` from unexpired assignment leases. Project metrics combine per-run engine metrics: counts, tokens and throughput add up, averages are weighted by finished work, and `p90` is the worst run's p90 (an upper bound, since percentiles cannot be merged from summaries). Project bottlenecks carry `runId`, and the response lists `runs`.

Usage filters are `projectId`, `runId`, `machineId`, `accountId`, `provider`, `model`, `from` and `to` (inclusive ISO timestamps). Responses are `{groupBy, groups: [{key, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, records}], totals}`. Missing cost is counted as zero, without estimating provider prices. Overview returns `{activeAgents, queuedWork, tokensToday, machinesOnline}`. Tokens include input, output and both cache counters. Jobs can be filtered by project/run. Job logs return `{jobId, chunks:[{id,jobId,chunk,at}]}`; artifact upload is not implemented.

## Node protocol

Enrollment codes are single-use and expiring. An idempotent enrollment retry receives its original token, including after restart. Enrollment returns `{machineId, token}`. Node tokens only exist as hashes in the DB.

Heartbeat bodies carry `{capacity:{maxAgents,maxJobs}, running:{agents,jobs}, providers, accounts, status:'online'|'draining'}`. Account snapshots replace that machine's previous public metadata; unknown fields are dropped, and IDs belonging to another machine are rejected. Responses are exactly `{status, cancel:{assignments:[],jobs:[]}}`. Owner-requested drain is persistent. Offline detection also covers draining machines, and a recovered owner-drained machine remains draining.

Lease requests carry `{kinds:['assignment','job'],max}` and return exactly `{assignments,jobs}`. Each work entity includes `attempt` and `leaseExpiresAt`. Capacity uses the larger of machine-reported running work and hub-held unexpired leases, so stale or optimistic heartbeats cannot grant extra slots. OS, labels and providers must match. Paused runs cannot receive new leases. Expired work requeues with `attempt + 1`, including during startup recovery.

**Renewals and events require top-level `attempt`**. The hub checks machine ownership, attempt, active state and expiry in the same serialized DB transaction. Wrong, absent or expired attempts return `409 lease_lost`, including when the same machine reacquires the work. Renewal returns exactly `{leaseExpiresAt}`.

Assignment events include `started`, `progress`, `usage`, `message`, `completed`, `failed` and observed interactions (`workitem.moved`, `agent.delegated`, `agent.messaged`, `gate.result`). Completion `data` is the AssignmentResult; architect results additionally carry `graph` and `rationale`. `usage` takes the UsageRecord's provider/model/token fields and optional account/cost/timestamp. `message` data takes `{recipientRoleId,body}` and sends to `run-<runId>` as the leased role. Job events include `started`, `log`, `step`, `completed` and `gate.result`; a final result must match its full Git SHA (40 or 64 hex characters) and, if supplied, config hash.

Stopping a run or cancelling a job revokes its leases immediately and persists a cancellation notification through restart. Heartbeats list it until acknowledgment or its original lease expiry. A matching machine/attempt may acknowledge an assignment with `failed` and `outcome:'blocked'`, or a job with `completed` and `status:'cancelled'` at the matching revision. An explicit `type:'cancelled'` acknowledgment is also accepted. These acknowledgments preserve terminal cancelled state; other late results remain fenced out.

## Events and messaging

Event pages return `{events,nextCursor}`. SSE emits standard `id`, `event` and JSON `data` fields. Resume with `Last-Event-ID` or `after`; explicit `after` wins. Replay and live delivery use the same committed global sequence. Slow readers are disconnected when response buffering fills and can resume from their last consumed ID. No event-retention pruning is implemented.

Interaction events identify the run, roles and source/target nodes. Matching edges receive `edgeId`; unexpected interactions are retained with `unplanned:true`. Message edges permit traffic both ways. Hub assignment lifecycle transitions emit `assignment.state`; jobs, review results and human decisions emit `gate.result`. Engines may also emit explicit interaction effects or work-item moves. Observed interactions are telemetry, never authority to spawn work.

The existing MessagingStore is mounted at:

```text
PUT  /api/v1/messaging/projects/:projectId                 {name}
GET  /api/v1/messaging/projects/:projectId/channels
POST /api/v1/messaging/projects/:projectId/channels        {id,name}
GET  /api/v1/messaging/projects/:projectId/channels/:channelId/messages
POST /api/v1/messaging/projects/:projectId/channels/:channelId/messages
```

Send/read bodies, role addressing and cursor semantics match [factory messaging](../../docs/messaging.md). Each run gets `run-<runId>` automatically. Owner sends in run channels emit `agent.messaged` once per message ID. `factory-client` currently hardcodes `/api/perpeto`; it needs a base-path option at integration to use the hub prefix. That package was not modified here.

## Engine mapping

| Hub event | Engine event |
| --- | --- |
| run start, `POST /runs/:id/inputs` `{items}` | `run.started` with project repo, `input.added` |
| assignment `completed`/`failed` | `assignment.completed`; review results pass `verdict` through, and a review `success` without a verdict is sent as an error the engine retries |
| job `completed` | `job.completed` with `passed`, `failed`, `error` or `cancelled` |
| expired lease on run work | the attempt is closed (`failed`/`error`) and reported as a failure, so the engine's `retry` policy creates the next attempt; architect and speculative merge jobs still requeue in the hub |
| `POST /work-items/:id/decision` | `human.decision` |
| pause, resume, stop | `run.paused`, `run.resumed`, `run.stopped` |
| merge queue merged/rejected | `merge.completed`/`merge.rejected` |

Engine retries carry `attempt`, `retryOf` and `notBefore`; the hub does not lease them before `notBefore`. Engine `workitem.moved` and merge `gate.result` events become hub interaction events; `assignment.state`, review/CI/human `gate.result` and `run.*` stay hub-owned to avoid duplicates. Other engine events (`loop.iteration`, `workitem.retried`, `workitem.escalated`, `workitem.blocked`, `human.requested`) are stored as-is.

## Merge queue

A merge entry from the engine is enqueued into one `factory-delivery` queue per project repository, base branch and merge configuration, stored in `deliveryDatabasePath`. Its CI is the steps of the ci nodes named in `requiredChecks` (or every ci node), and a passing speculative job proves those named checks. Speculative jobs are hub Jobs with a `delivery` field, leased by nodes like any other job; their results go to the queue rather than the engine. The pump runs Git preparation and publication outside the request serializer, then reconciles queue state into hub merge entries and jobs, so a crash between the two stores is repaired on the next pump. Waiting entries of a stopped run are withdrawn.

Only local bare repositories (project `repo.localPath`, or an absolute path or `file://` `url`) are supported. Other repositories leave the entry queued with `deliveryError` and a `merge-entry.blocked` event; GitHub queue publication is not wired yet.

## Persistence and limits

Hub entity state, immutable workflow versions, architect requests, run snapshots, engine state, leases, cancellations, jobs/logs, merge entries, account snapshots, usage, idempotency and global events are in `databasePath`. Messaging keeps its existing separate SQLite DB at `messagingDatabasePath`. Both use WAL and full synchronous writes; DB and credential files are private regular files. Hub mutations serialize through transactions and engine effects are committed with their triggering result.

MessagingStore writes are a separate durability boundary. A crash can leave a message/channel durable before its hub event/idempotency response commits. Retrying a send recovers its message event by message ID, but multi-DB crash-atomic delivery is not claimed. A single hub process owns scheduling; no clustered scheduler, retention, token rotation/revocation UI or external artifact storage is provided here. Merge queue Git work for local repositories runs in the hub process. The DB/owner secret must be backed up together.

## Verify

```sh
source ~/.nvm/nvm.sh && nvm use 24
node --test packages/factory-hub/test/hub.test.js
npm test
```

Tests use actual HTTP servers on ephemeral ports, SQLite files and explicit stub engines. The load case enrolls 100 simulated machines, concurrently leases one assignment per machine, then concurrently renews all 100. It measures HTTP/DB work, not 100 real agents, cross-machine networking or sustained production throughput. See [the handoff](../../docs/handoffs/factory-hub.md) for executed results and remaining integration work.
