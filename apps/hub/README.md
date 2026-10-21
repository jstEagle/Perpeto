# Hub

Dependency-free Node 24 HTTP control plane with its own durable SQLite state. It implements the [factory contract](../../docs/architecture/README.md) and the later agent-authored workflow, observation and node wire-format addenda. It never calls inference APIs.

**Engine and delivery:** the default engine is [workflow-adapter.js](src/engine/workflow-adapter.js) over `@perpeto/workflow`; tests may still inject the in-package stub. Merge-queue nodes run through [delivery/index.js](src/delivery/index.js) over `@perpeto/delivery`, for local bare repositories and GitHub publication. The [e2e suite](../../tests/e2e/README.md) runs a real hub, node and bare repository with a fake executor. No live T3 harness run is claimed.

## Start

```sh
source ~/.nvm/nvm.sh && nvm use 24
node apps/hub/bin/perpeto-hub.js --config config/hub.example.json
```

The example binds loopback port 4320. Paths resolve relative to the configuration file. The first start creates `.perpeto/hub/owner.secret`, mode 600, containing the owner bearer token. The CLI prints only its address. Read this token through an owner-only credential-file flow; do not put it in JSON configuration, command arguments, URLs or logs. Losing the secret file requires restoring it; the hub refuses to silently replace an existing owner identity.

The example JSON configures host/port, hub and messaging DB paths, owner secret path, exact allowed browser origins, request byte cap, heartbeat/lease/long-poll/maintenance intervals, enrollment TTL and the architect harness provider/model. Defaults are 10-second heartbeats, offline after three missed intervals, 60-second leases, 25-second long polls, 10-minute enrollment codes and a 1 MiB request cap. `architectHarness` selects a T3 harness; it does not call a model directly.

Embedders can use:

```js
import { createHub } from '@perpeto/hub';
const hub = await createHub({ configPath: '/path/to/hub.json', engine });
const url = await hub.listen(); // config port 0 selects an ephemeral port
// ...
await hub.close();
```

There is no built-in TLS terminator. Loopback is the default. Remote transport setup and deployment are outside this package's verified scope.

## Authentication and retries

Routes live under `/api/v1`. `/health` and `/api/v1/health` are public. `/api/v1/nodes/enroll` authenticates with a one-time code rather than a bearer token. All other routes require `Authorization: Bearer <token>`.

Owner tokens can use the owner API. Node tokens can heartbeat, lease, and access their own currently leased assignments/jobs. They cannot read projects, accounts, global events, metrics, usage or owner messaging routes. Authorization is checked on the same parsed path the router dispatches on, and every route outside the machine protocol requires an owner token. Request paths that URL parsing would rewrite (dot segments, including percent-encoded ones, backslashes, encoded slashes or empty segments) are refused with `400 INVALID_PATH`. Agent messages travel through their assignment's `message` event, checked against `policy.canMessage` and bound to its run channel and sender role.

**Session cookie.** Browsers can trade the owner token for an HttpOnly cookie so the token never stays in page scripts. `POST /session` with the owner bearer (idempotency key allowed) returns `201 {expiresAt}` and `Set-Cookie: perpeto_session=<opaque>; HttpOnly; SameSite=Strict; Path=/api/v1; Max-Age=<ttl>`, with `Secure` unless the request comes from a loopback `http` origin. `GET /session` returns `{kind: 'owner', expiresAt}` (`null` for a bearer) or 401, and `DELETE /session` with the cookie returns 204, clears the cookie and deletes the session. The cookie authenticates like the owner bearer on every owner route and the event stream; a bearer header wins when both are sent. Sessions last `sessionTtlMs` (12 h) and slide with use (the refreshed cookie comes back on the response). Only hashes are stored; a retried `POST` re-sends the same cookie. A change made with the cookie needs an `Origin` from `corsOrigins`, and a `POST` needs a JSON body, otherwise `403 CSRF_REJECTED`. CORS answers configured origins only, never `*`, with `Access-Control-Allow-Credentials: true` and `DELETE` allowed. `SameSite=Strict` needs the app and hub on the same site.

`GET /events` pages forward with `after` (default 0) and returns `{events, nextCursor, hasMore}`. With `latest=true` it returns the newest page, and with `before=<seq>` the page before that event, both as `{events, previousCursor, nextCursor, hasMore}`. Pages are always oldest first, `after`, `before` and `latest` are mutually exclusive, and `runId` limits any of them, and the stream, to one run.

All mutations accept `idempotencyKey` in the JSON body or `Idempotency-Key` in a header. Supply a fresh key per logical mutation and preserve it on retries. Matching bodies return the original status/body, even across restart. Changed bodies return `409 CONFLICT`. Object-key ordering does not change a fingerprint. Keys are scoped to authenticated identity, HTTP method and route. Without a key, a retry is a new request. The existing MessagingStore additionally enforces project-wide message keys. Enrollment-code and node-token retries reconstruct credentials from the owner secret and public entity IDs; the DB contains hashes and response metadata, never their plaintext.

Errors are `{ "error": { "code": "INVALID_INPUT", "message": "..." } }`. Lease rejection specifically uses `409` and `error.code: "lease_lost"`, matching the node wire format. Raw SQL and stacks are never returned.

## API summary

| Area | Routes under `/api/v1` |
| --- | --- |
| Projects | `GET/POST /projects`, `GET/PATCH /projects/:id` |
| Workflows | `GET/POST /projects/:id/workflows`, `GET/PUT /workflows/:id`, `POST /workflows/:id/validate` |
| Drafts | `POST /projects/:id/workflows/drafts` with `{prompt, baseWorkflowId?}` |
| Versions | `GET /workflows/:id/versions`, `GET /workflows/:id/diff?from=&to=`, `POST /workflows/:id/activate` with `{version}` |
| Runs | `GET /projects/:id/runs?status=`, `POST /workflows/:id/runs`, `GET /runs/:id`, `POST /runs/:id/pause`, `/resume`, `/stop`, `/inputs` |
| Work | `GET /runs/:id/work-items`, `GET /runs/:id/assignments`, `POST /work-items/:id/decision`, `GET /assignments/:id` |
| Metrics | `GET /runs/:id/metrics?window=1h|24h|7d`, `GET /projects/:id/metrics?window=...` |
| Machines | `GET /machines`, `POST /machines/enrollment-codes`, `POST /machines/:id/drain`, `POST /machines/:id/revoke` |
| Accounts | `GET /accounts` |
| Jobs | `GET /jobs`, `GET /jobs/:id`, `GET /jobs/:id/log`, `POST /jobs/:id/cancel` |
| Delivery | `GET /projects/:id/merge-queue` |
| Usage | `GET /usage?groupBy=provider|model|machine|day` |
| Overview | `GET /overview`, optionally `?projectId=...` |
| Events | `GET /events?after=0&limit=100`, `?latest=true` or `?before=<seq>`, each optionally `&runId=`; or SSE with `Accept: text/event-stream` (also `runId`) |
| Session | `GET`, `POST`, `DELETE /session` (owner session cookie, below) |
| Nodes | `POST /nodes/enroll`, `/nodes/heartbeat`, `/nodes/lease`, `/nodes/token` |
| Lease reports | `POST /assignments/:id/renew`, `/events`, `/release`, and the corresponding `/jobs/:id/...` |

List responses use `{projects}`, `{workflows}`, `{runs}`, `{versions}`, `{machines}`, `{accounts}`, `{jobs}`, `{workItems}`, `{assignments}` or `{entries}`. Single entities are returned directly. Draft requests return the architect Assignment with HTTP 202. Follow it using `GET /assignments/:id`; invalid attempts expose `retryAssignmentId` and `architectErrors`, and a valid result exposes `draftWorkflowId` and `draftVersion`. There are at most three architect validation attempts, independent of lease requeue attempts. Architect assignments belong to a project before there is a run, so they omit `runId`/`workItemId`.

New workflow versions are always drafts with `authoredBy`, optional `rationale` and `parentVersion`. `versions` returns immutable saved records. Activation changes a separate `activeVersion` pointer, not historical records or live runs. A workflow head may show a newer draft alongside its older `activeVersion`; new runs use that active version. Starting a workflow with no active version returns `409 WORKFLOW_NOT_ACTIVE`.

Metrics return `{nodes, edges, run, bottlenecks}` and default to a 24-hour window. State, events, usage and window bounds go to `engine.computeRunMetrics`; graph diffs, architect prompt construction and result parsing also belong to the engine interface. The hub overlays `run.activeAgents` and `run.machines` from unexpired assignment leases. Project metrics combine per-run engine metrics: counts, tokens and throughput add up, averages are weighted by finished work, and `p90` is the worst run's p90 (an upper bound, since percentiles cannot be merged from summaries). Project bottlenecks carry `runId`, and the response lists `runs`.

Usage filters are `projectId`, `runId`, `machineId`, `accountId`, `provider`, `model`, `from` and `to` (inclusive ISO timestamps). Responses are `{groupBy, groups: [{key, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, records}], totals}`. Missing cost is counted as zero, without estimating provider prices. Overview returns `{activeAgents, queuedWork, tokensToday, machinesOnline}`. Tokens include input, output and both cache counters. Jobs can be filtered by project/run. Job logs return `{jobId, chunks:[{id,jobId,chunk,at}]}`; artifact upload is not implemented.

## Node protocol

Enrollment codes are single-use and expiring. An idempotent enrollment retry receives its original token, including after restart. Enrollment returns `{machineId, token}`.

Tokens derive from the machine and a token generation, so they are never stored in plaintext. `POST /nodes/token` (node token, body `{idempotencyKey?}`) rotates the caller's own token and returns `201 {machineId, token, generation}`. The previous token keeps working until the new one is first used, then every older generation is retired; a retry with the old token and the same idempotency key returns the same new token, including after restart. `POST /machines/:id/revoke` (owner, body `{reason?, idempotencyKey?}`) deletes every token generation for the machine, sets `status: 'offline'` and `revokedAt`, emits `machine.revoked`, and expires the machine's leases so maintenance hands run work to the engine's retry policy and requeues the rest. Replays of earlier enrollment or rotation responses then return tokens that no longer authenticate. Revocation is permanent; enroll the machine again with a new code. An `os` of `win32` (Node's platform name) is stored as `windows`. Node tokens only exist as hashes in the DB.

Heartbeat bodies carry `{capacity:{maxAgents,maxJobs}, running:{agents,jobs}, providers, labels, accounts, status:'online'|'draining'}`; `labels`, when present, replace the labels used for leasing. Account snapshots replace that machine's previous public metadata; unknown fields are dropped, and IDs belonging to another machine are rejected. Responses are exactly `{status, cancel:{assignments:[],jobs:[]}}`. Owner-requested drain is persistent. Offline detection also covers draining machines, and a recovered owner-drained machine remains draining.

Lease requests carry `{kinds:['assignment','job'],max}` and return exactly `{assignments,jobs}`; a `max` above 1,000 is served as 1,000. Each work entity includes `attempt` and `leaseExpiresAt`. Every Assignment, including a workflow architect, carries a copy of its project `repo: {url, defaultBranch, localPath?}` taken when the assignment is created. Capacity uses the larger of machine-reported running work and hub-held unexpired leases, so stale or optimistic heartbeats cannot grant extra slots. OS, labels and providers must match. Paused runs cannot receive new leases. Expired run work becomes an engine-owned failed attempt and follows its retry policy. Project-scoped assignments and speculative merge jobs requeue with `attempt + 1`, including during startup recovery.

`POST /assignments/:id/release` and `POST /jobs/:id/release` (leasing machine only, body `{attempt, idempotencyKey?, reason?}`) hand back work that has not started. They are fenced like renewals, return `{released: true, status: 'queued', attempt}`, keep the same `attempt`, emit `assignment.released` or `job.released`, and do not report to the engine. The releasing machine is not offered that attempt again for one lease duration. Started work returns `409 CONFLICT`; report its result instead.

**Renewals and events require top-level `attempt`**. The hub checks machine ownership, attempt, active state and expiry in the same serialized DB transaction. Wrong, absent or expired attempts return `409 lease_lost`, including when the same machine reacquires the work. Renewal returns exactly `{leaseExpiresAt}`.

Assignment events include `started`, `progress`, `usage`, `message`, `completed`, `failed` and observed interactions (`workitem.moved`, `agent.delegated`, `agent.messaged`, `gate.result`). Completion `data` is the AssignmentResult; architect results additionally carry `graph` and `rationale`. `usage` takes the UsageRecord's provider/model/token fields and optional account/cost/timestamp. `message` data takes `{recipientRoleId,body}` and sends to `run-<runId>` as the leased role. Job events include `started`, `log`, `step`, `completed` and `gate.result`; a final result must match its full Git SHA (40 or 64 hex characters) and config hash. A `log` chunk is any non-empty string, including blank lines; NUL is stored as U+FFFD. A run assignment's final result is validated by the engine before it is acknowledged (an event the engine refuses leaves no trace); a result the engine would refuse, such as a short SHA or an oversized branch or planner item, is recorded as a failure carrying the engine's reason and the agent's summary, the response includes `reason`, and the engine's retry policy applies.

Stopping a run or cancelling a job revokes its leases immediately and persists a cancellation notification through restart. Heartbeats list it until acknowledgment or its original lease expiry. A matching machine/attempt may acknowledge an assignment with `failed` and `outcome:'blocked'`, or a job with `completed` and `status:'cancelled'` at the matching revision. An explicit `type:'cancelled'` acknowledgment is also accepted. These acknowledgments preserve terminal cancelled state; other late results remain fenced out. Cancelling a run's CI job (not a merge-queue job) reports the attempt to the engine as `cancelled`, so its retry policy applies and the run can finish. Free capacity counts the unexpired leases the hub holds for the machine; the node sizes each lease's `max` from its own running count, so a heartbeat that predates a completion cannot hold a slot shut.

## Events and messaging

Event pages return `{events,nextCursor}`. SSE emits standard `id`, `event` and JSON `data` fields. Resume with `Last-Event-ID` or `after`; explicit `after` wins. Replay and live delivery use the same committed global sequence. Slow readers are disconnected when response buffering fills and can resume from their last consumed ID. No event-retention pruning is implemented.

Interaction events identify the run, roles and source/target nodes (`sourceNodeId`/`targetNodeId`, also as `from`/`to`, which metrics read so unplanned edges keep their endpoints). Matching edges receive `edgeId`; unexpected interactions are retained with `unplanned:true`. Message edges permit traffic both ways. Hub assignment lifecycle transitions emit `assignment.state`; jobs, review results and human decisions emit `gate.result`. Engines may also emit explicit interaction effects or work-item moves. Observed interactions are telemetry, never authority to spawn work.

The existing MessagingStore is mounted at:

```text
PUT  /api/v1/messaging/projects/:projectId                 {name}
GET  /api/v1/messaging/projects/:projectId/channels
POST /api/v1/messaging/projects/:projectId/channels        {id,name}
GET  /api/v1/messaging/projects/:projectId/channels/:channelId/messages
POST /api/v1/messaging/projects/:projectId/channels/:channelId/messages
```

Send/read bodies, role addressing and cursor semantics match [factory messaging](../../docs/guides/messaging.md). Each run gets `run-<runId>` automatically. Owner sends in run channels emit `agent.messaged` once per message ID. `@perpeto/sdk` defaults to this hub prefix and supports the T3-hosted `/api/perpeto` routes through its `messagingPrefix` JSON option.

## Engine mapping

| Hub event | Engine event |
| --- | --- |
| run start, `POST /runs/:id/inputs` `{items}` | `run.started` with project repo, `input.added` |
| assignment `completed`/`failed` | `assignment.completed`; review results pass `verdict` through, and a review `success` without a verdict is sent as an error the engine retries |
| job `completed` | `job.completed` with `passed`, `failed`, `error` or `cancelled` |
| expired lease on run work | the attempt is closed (`failed`/`error`) and reported as a failure, so the engine's `retry` policy creates the next attempt; architect and speculative merge jobs still requeue in the hub |
| `POST /work-items/:id/decision` `{decision, note?, decisionId?}` | `human.decision`. Work items waiting for a person carry `decisionId` (also in `human.requested`); a decision naming an earlier wait returns `409 STALE_DECISION`, so a retry or a second answer cannot pass the next gate. Without `decisionId` it applies to the current wait. |
| pause, resume, stop | `run.paused`, `run.resumed`, `run.stopped` |
| merge queue merged/rejected | `merge.completed`/`merge.rejected` |

Engine retries carry `attempt`, `retryOf` and `notBefore`; the hub does not lease them before `notBefore`. Engine `workitem.moved` and merge `gate.result` events become hub interaction events; `assignment.state`, review/CI/human `gate.result` and `run.*` stay hub-owned to avoid duplicates. Other engine events (`loop.iteration`, `workitem.retried`, `workitem.escalated`, `workitem.blocked`, `human.requested`) are stored as-is.

## Merge queue

A merge entry from the engine is enqueued into one `@perpeto/delivery` queue per project repository, base branch and merge configuration, stored in `deliveryDatabasePath`. Its CI is the steps of the ci nodes named in `requiredChecks` (or every ci node), and a passing speculative job proves those named checks. Speculative jobs are hub Jobs with a `delivery` field, leased by nodes like any other job; their results go to the queue rather than the engine. The pump runs Git preparation and publication outside the request serializer, then reconciles queue state into hub merge entries and jobs, so a crash between the two stores is repaired on the next pump. Before each queue step, entries their run has closed are withdrawn, including entries under test; their speculative job is cancelled and the rest of a batch is retested. A merge that was already published still shows as merged. Merge-queue jobs lease while their own run is paused, because the queue is shared with other runs. Entries are admitted one at a time: an entry whose project repository cannot be used stays queued with `deliveryError` and a `merge-entry.blocked` event, and admission continues for others.

A queue step that fails backs off exponentially from `deliveryRetryBackoffMs` (default 2000, capped at 60 s). After `deliveryMaxStepFailures` consecutive failures of one attempt (default 5) the hub rejects its entries through `rejectEntry`, records the cause as `deliveryError` and reports the rejection to their runs. In a batch, only entries whose PR head cannot be read are rejected when that identifies them. A failing merging attempt is rejected only once the adapter confirms the base does not contain its candidate, so a possibly published push is never reported as rejected; native GitHub queue publication keeps retrying. Failures with no attempt, such as a missing base branch, stay visible as the queue's `merge-queue.error`. Retry counts are in memory and restart after a hub restart.

Local bare repositories (project `repo.localPath`, or an absolute path or `file://` `url`) retain atomic local ref publication. GitHub HTTPS/SSH URLs, or GitHub PR URLs paired with a local/remote Git origin, select `GitHubAdapter`. The hub clones an isolated bare mirror under `deliveryRepositoriesPath`, fetches the observed base and heads before candidate preparation, and gives speculative jobs that mirror URL. Nodes must be able to read that path; cross-machine object transfer is not implemented. Other forges remain blocked with `deliveryError`.

Merge-queue node config accepts `publication: 'fast-forward-push'` (default) or `'github-merge-queue'` (serial only). The former pushes the exact tested candidate without force and finalizes PRs through `gh`; squash/rebase PRs become CLOSED with evidence. The native option lets GitHub own final ordering and checks, so `mergedRevision` can differ from `testedRevision`. These guarantees and remote race limits are documented by [@perpeto/delivery](../../packages/delivery/README.md). Git/gh authentication stays with their credential helpers.

`deliveryLeaseDurationMs` defaults to 60000 and fences a pump worker independently of node leases. After a crash, recovery waits for that lease to expire. Maintenance schedules the pump outside the request serializer, including after startup, and reconciles terminal delivery entries even when the hub did not commit their prior projection. `GET /projects/:id/runs?status=` returns `{runs}` newest first and rejects unknown status values.

## Persistence and limits

Hub entity state, immutable workflow versions, architect requests, run snapshots, leases, cancellations, jobs/logs, merge entries, account snapshots, usage, idempotency and global events are in `databasePath`. Messaging keeps its existing separate SQLite DB at `messagingDatabasePath`. Run state lives in the workflow package's `RunStore` at `workflowDatabasePath` (default `./workflow.sqlite`), which persists each event's changed rows rather than the whole run; work items are read from it, and the hub keeps only the last applied engine sequence per run. All use WAL and full synchronous writes; DB and credential files are private regular files. Hub mutations serialize through transactions. The RunStore commits separately: if a hub transaction rolls back after the engine committed, the hub replays that run's stored events after its applied sequence before the run's next event and on every maintenance tick, and acknowledges the engine's outbox only after committing. Runs that already held their whole engine state in the hub keep advancing from it. The hub no longer emits `work-item.updated` for RunStore runs; engine events such as `workitem.moved` and `human.requested` still describe each change.

### Scale and retention

Long-polls register as their machine's waiters. After each commit the hub wakes only waiters that could lease something: those of a machine whose capacity, load or profile changed, and, for newly queued work grouped by requirements, those of machines that meet them and have a free slot of that kind. Retries waiting out `notBefore` and release cooldowns wake their machines when due. Heartbeats and renewals write no events and wake no other machine's polls. Leasing, expiry, counts and per-run or per-project listings use expression indexes over open work; job logs, usage and message de-duplication have their own indexed tables, and metrics read their window's events in one query.

A sweep every `retentionSweepIntervalMs` (60 s) runs in bounded batches:

| Data | Setting (default) | After retention |
| --- | --- | --- |
| Finished assignments and jobs | `finishedWorkRetentionMs` (7 days) | Moved to `archived_entities`, or deleted with their logs when `archiveFinished` is false |
| Events | `eventRetentionMs` (30 days, at least 7 so metrics windows stay complete) | Moved to `archived_events`, or deleted |
| Usage | `usageRetentionMs` (30 days) | Folded into hourly rollups per project, run, assignment, machine, account, provider and model |
| Idempotency records | `idempotencyRetentionMs` (1 day) | Deleted; a retry after that runs again |

Archived assignments and jobs are still returned by `GET /assignments/:id`, `GET /jobs/:id`, `GET /runs/:id/assignments` and `GET /jobs?runId=`; other listings show the hot table. `/usage`, `/overview` and metrics read raw usage and rollups together, so totals and groupings stay exact; time filters apply to a rollup's hour.

`node apps/hub/test/load.js [--duration 60] [--machines 100] [--queued 1000] [--hub <bin>]` runs a hub in a child process with 100 machines (half able to run the 1,000 queued assignments), heartbeats every 10 s, long-polls and 10 s renewals, and prints p50/p99 latency per request type and the hub's CPU time.

MessagingStore writes are a separate durability boundary. A crash can leave a message/channel durable before its hub event/idempotency response commits. Retrying a send recovers its message event by message ID, but multi-DB crash-atomic delivery is not claimed. A single hub process owns scheduling; no clustered scheduler, retention, token rotation/revocation UI or external artifact storage is provided here. Merge queue Git work for local repositories runs in the hub process. The DB/owner secret must be backed up together.

## Verify

```sh
source ~/.nvm/nvm.sh && nvm use 24
node --test apps/hub/test/hub.test.js
npm test -w @perpeto/hub       # same suite through the workspace script
npm test
```

Tests use actual HTTP servers on ephemeral ports, SQLite files and explicit stub engines. The load case enrolls 100 simulated machines, concurrently leases one assignment per machine, then concurrently renews all 100. It measures HTTP/DB work, not 100 real agents, cross-machine networking or sustained production throughput. See [the handoff](../../docs/handoffs/factory-hub.md) for executed results and remaining integration work.
