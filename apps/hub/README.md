# Hub

Dependency-free Node 24 HTTP control plane with its own durable SQLite state. It implements the [factory contract](../../docs/architecture/README.md) and the later agent-authored workflow, observation and node wire-format addenda. It never calls inference APIs.

**Engine and delivery:** the default engine is [workflow-adapter.js](src/engine/workflow-adapter.js) over `@perpeto/workflow`; tests may still inject the in-package stub. Merge-queue nodes run through [delivery/index.js](src/delivery/index.js) over `@perpeto/delivery`, for local bare repositories and GitHub publication. The [e2e suite](../../tests/e2e/README.md) runs a real hub, node and bare repository with a fake executor. No live T3 harness run is claimed.

## Start

```sh
source ~/.nvm/nvm.sh && nvm use 24
node apps/hub/bin/perpeto-hub.js --config config/hub.example.json
```

**HTTPS.** `tlsEnabled: true` serves HTTPS with a self-signed ECDSA P-256 certificate created on first start at `tlsCertPath` (default `./tls/cert.pem`) with an owner-only key at `tlsKeyPath` (`./tls/key.pem`); machines pin its SHA-256 fingerprint. Plain HTTP is loopback-only: a non-loopback `host` without TLS fails with `INSECURE_BIND` unless `allowInsecureRemote: true`. `publicUrl` (an https origin, or loopback http) is the address join codes carry, for example a tailnet URL. `POST /machines/enrollment-codes` accepts `{ttlMs?, url?, pin?}` and returns `{id, code, expiresAt, joinCode}`, where `joinCode` is `pj1_` plus base64url JSON `{url, fingerprint?, code}`; the fingerprint is included only for the hub's own HTTPS address (default when no `url` or `publicUrl` is given, or with `pin: true`). `GET /tls` returns `{enabled, fingerprint?, expiresAt?, next?}`; `POST /tls/rotate` creates the next certificate and `POST /tls/activate` serves it without a restart (`409 NO_PENDING_CERTIFICATE` without a rotation, `409 TLS_DISABLED` without TLS). With TLS, heartbeat responses add `tls: {fingerprints}` (served, then next) so pinned machines follow a rotation. See [Join machines over a LAN or tailnet](../../docs/guides/remote-machines.md).

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

`GET /events` pages forward with `after` (default 0) and returns `{events, nextCursor, hasMore}`. With `latest=true` it returns the newest page, and with `before=<seq>` the page before that event, both as `{events, previousCursor, nextCursor, hasMore}`. Pages are always oldest first, and `after`, `before` and `latest` are mutually exclusive. `runId` and `projectId` narrow any page, and the stream; `types=a,b` keeps only those types, and `exclude=a,b` drops them. `exclude` defaults to `machine.heartbeat,assignment.renewed,job.renewed,job.log`, which hubs before this version wrote on every heartbeat, renewal and CI log line; `exclude=` shows everything. An explicit list replaces the default.

Machine liveness lives in machine state (`GET /machines`: `status`, `lastHeartbeatAt`). The log records only transitions: `machine.offline` after three missed heartbeats and `machine.online` when a heartbeat brings it back. Heartbeats, renewals and CI log lines write no events; CI output stays with its job (`GET /jobs/:id/log`).

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

Usage filters are `projectId`, `runId`, `machineId`, `accountId`, `provider`, `model`, `from` and `to` (inclusive ISO timestamps). Responses are `{groupBy, groups: [{key, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, records}], totals}`. Missing cost is counted as zero, without estimating provider prices. Usage also supports `groupBy=role`, attributed by assignment role (node id fallback), preserved through rollup and assignment deletion for new records. Overview returns `{owner, goals, runs, activeAgents, queuedWork, tokensToday, machinesOnline}`; with `projectId` its goals are that project's, otherwise every project's goals with their `projectId`.

**Goals.** Project goals are `{id, title, status}` (`active`, `done` or `dropped`); `POST`/`PATCH /projects` accept strings or `{id?, title, status?}`, and goals stored as strings read with ids derived from their titles. Input items may carry `goalId` (a goal of the run's project, else 400); the work items they create, and the items a planner splits them into, link to that goal. `GET /projects`, `GET /projects/:id` and `/overview` return each goal with `workItemIds`, `done` and `total`, counting leaf items (a planned item finishes through its children) and `done` by work-item status.

**Commit identity.** `POST`/`PATCH /projects` accept an optional `gitIdentity: {name, email}` (a single-line name without `<` or `>` and an email address, else 400; `null` clears it on `PATCH`). The hub copies it onto each assignment it creates for the project, including workflow-architect assignments, as `assignment.gitIdentity`, so agents commit under that identity. Changes apply to assignments created afterwards. Without it, the node's `runtime.t3.gitIdentity` applies.

**Owner.** `ownerName` in the hub config names the owner. `GET /owner` and `PATCH /owner {name?, initials?}` (1 to 3 letters or digits; `null` clears back to the config name or derived initials) manage it; `GET /session` and `/overview` include `owner: {name, initials}`, with initials from the first and last words of the name. Tokens include input, output and both cache counters. Jobs can be filtered by project/run. Job logs return `{jobId, chunks:[{id,jobId,chunk,at}]}`; artifact upload is not implemented.

## Continuous runs

Run start accepts `{input: {items?, keepOpen?, source?, schedule?, budget?}}`; settings may also be top-level. `PATCH /runs/:id` updates `{keepOpen?, source?, schedule?, budget?}` on running/paused runs. `source` is `manual`, `goals` or `schedule`, with graph input config as the default. Scheduled sources need five-field numeric UTC cron, including lists/ranges/steps. `budget` replaces the previous limits; `{}` removes them. No hub configuration key was added, so CLI-generated configuration and the example keep the same keys.

`budget: {maxTokensPerDay?, maxActiveItems?, maxItemsPerDay?}` accepts positive safe integers. Input/output usage deltas reach the engine through durable ledger intents after commit, excluding cache subtotals. Intake and planner expansion pause with `budget.exhausted` while admitted work may finish. Daily counters reset on the next event after UTC midnight, and `budget.available` signals recovery. This is an intake guard, not a hard cap on in-flight spend. Manual batches are retained and split to available capacity; a finite run waits for deferred batches before completing. Usage events must contain deltas, not cumulative snapshots.

Maintenance sends one stable tick per observed UTC minute, including after restart. It does not replay missed minutes or tick user-paused/terminal runs. Goal sources omit completed/dropped/already active or reserved goals across the project and expose `goalId` on created items. Source bodies include docs, goal evidence, usage metrics and recent outcomes. Scheduled sources request one improvement pass. Prepared replies, including empty source responses, use stable request-derived events; the outbox notification is never a second work trigger.

`Run` responses from creation, detail, project listings and pause/resume/stop always expose `budgetUsage: {day, tokens, items, windowStart, windowEnd}`. Missing engine counters default to zero independently of intake state; the window is `[windowStart, windowEnd)` in UTC for the counters' day. Detail and `/overview.runs` expose settings and `intake` separately from run pause status. Completed runs record `completedAt`; all terminal runs have `stoppedAt`. Changing configuration switches that run to the existing hub-held snapshot execution path, also used when a finite run must wait for budget-deferred input. It is durable but writes the full state per event, and subsequent steps are outside RunStore's replay verification. Unchanged runs keep incremental RunStore persistence.

`GET /workflow-templates` returns `{templates: [{id, description, graph}]}` from the workflow package's six-template library. A project may run multiple independently activated workflows concurrently, sharing machine capacity and delivery queues. Architect replies can name `templateId` and up to three `additionalWorkflows`; every graph validates before any draft is saved. Errors on additional graphs carry `workflowIndex`; successful assignments return `drafts: [{workflowId, version}]` as well as the original primary draft fields. Each draft needs separate activation.

Merge rejections persist a typed `rejectionKind: conflict|ci|other` from delivery and map to engine `merge.rejected.data.kind`; historical/untyped reasons stay `other`. Conflicts can now schedule `step: 'rebase'` assignments with `rebaseOf`. The hub preserves their `rebaseTouchedBeyondConflicts` result: under default `rebaseReview: 'changed'`, only explicit `false` skips repeated review; fresh CI still precedes the next merge. Planner `items[].touches` also survive result transport, enabling the engine's declared-scope scheduling. Both fields remain engine-validated.

Node/run metrics include `conflictRejections` and `rebases`, summed in project metrics, with per-run `conflict-churn` findings retained. Engine recovery movements preserve `step: 'rebase'`, `edgeId: null`, `unplanned: false` and are excluded from authored-edge counts. Actual Git/HTTP integration is tested with an explicit node result; live executor output parsing remains a separate requirement in [the handoff](../../docs/handoffs/factory-hub.md#executor-handoff).

## Node protocol

Enrollment codes are single-use and expiring. An idempotent enrollment retry receives its original token, including after restart. Enrollment returns `{machineId, token}`.

Machine tokens, enrollment codes and session tokens are random 256-bit values; only their SHA-256 hashes authenticate, so neither the owner secret nor a copy of the database can mint one. An idempotent replay returns the credential first issued: the stored response holds it sealed with AES-256-GCM under `credentialKeyPath` (default `./credentials.key`, owner-only, created on first start), until idempotency retention drops the record. The database pins the key's fingerprint, so the hub refuses to start with a missing (`CREDENTIAL_KEY_MISSING`) or different (`CREDENTIAL_KEY_MISMATCH`) key; back it up with the owner secret. Tokens issued by older hubs, which were derived from the owner secret, keep working until the machine rotates. `POST /nodes/token` (node token, body `{idempotencyKey?}`) rotates the caller's own token and returns `201 {machineId, token, generation}`. The previous token keeps working until the new one is first used, then every older generation is retired; a retry with the old token and the same idempotency key returns the same new token, including after restart. `POST /machines/:id/revoke` (owner, body `{reason?, idempotencyKey?}`) deletes every token generation for the machine, sets `status: 'offline'` and `revokedAt`, emits `machine.revoked`, and expires the machine's leases so maintenance hands run work to the engine's retry policy and requeues the rest. Replays of earlier enrollment or rotation responses then return tokens that no longer authenticate. Revocation is permanent; enroll the machine again with a new code. An `os` of `win32` (Node's platform name) is stored as `windows`. Node tokens only exist as hashes in the DB.

Heartbeat bodies carry `{capacity:{maxAgents,maxJobs}, running:{agents,jobs}, providers, labels, accounts, status:'online'|'draining'}`; `labels`, when present, replace the labels used for leasing. Account snapshots replace that machine's previous public metadata; unknown fields are dropped, and IDs belonging to another machine are rejected. Responses are exactly `{status, cancel:{assignments:[],jobs:[]}}`. Owner-requested drain is persistent. Offline detection also covers draining machines, and a recovered owner-drained machine remains draining.

Lease requests carry `{kinds:['assignment','job'],max}` and return exactly `{assignments,jobs}`; a `max` above 1,000 is served as 1,000. Each work entity includes `attempt` and `leaseExpiresAt`. Every Assignment, including a workflow architect, carries a copy of its project `repo: {url, defaultBranch, localPath?}` taken when the assignment is created. Capacity uses the larger of machine-reported running work and hub-held unexpired leases, so stale or optimistic heartbeats cannot grant extra slots. OS, labels and providers must match. Paused runs cannot receive new leases. Expired run work becomes an engine-owned failed attempt and follows its retry policy. Project-scoped assignments and speculative merge jobs requeue with `attempt + 1`, including during startup recovery.

`POST /assignments/:id/release` and `POST /jobs/:id/release` (leasing machine only, body `{attempt, idempotencyKey?, reason?}`) hand back work that has not started. They are fenced like renewals, return `{released: true, status: 'queued', attempt}`, keep the same `attempt`, emit `assignment.released` or `job.released`, and do not report to the engine. The releasing machine is not offered that attempt again for one lease duration. Started work returns `409 CONFLICT`; report its result instead.

**Renewals and events require top-level `attempt`**. The hub checks machine ownership, attempt, active state and expiry in the same serialized DB transaction. Wrong, absent or expired attempts return `409 lease_lost`, including when the same machine reacquires the work. Renewal returns exactly `{leaseExpiresAt}`.

Assignment events include `started`, `progress`, `usage`, `message`, `completed`, `failed` and observed interactions (`workitem.moved`, `agent.delegated`, `agent.messaged`, `gate.result`). Completion `data` is the AssignmentResult; architect results additionally carry `graph` and `rationale`. `usage` takes the UsageRecord's provider/model/token fields and optional account/cost/timestamp. `message` data takes `{recipientRoleId,body}` and sends to `run-<runId>` as the leased role. Job events include `started`, `log`, `step`, `completed` and `gate.result`; a final result must match its full Git SHA (40 or 64 hex characters) and config hash. A `log` chunk is any non-empty string, including blank lines; NUL is stored as U+FFFD. A run assignment's final result is validated by the engine before it is acknowledged (an event the engine refuses leaves no trace); a result the engine would refuse, such as a short SHA or an oversized branch or planner item, is recorded as a failure carrying the engine's reason and the agent's summary, the response includes `reason`, and the engine's retry policy applies.

Stopping a run or cancelling a job revokes its leases immediately and persists a cancellation notification through restart. Heartbeats list it until acknowledgment or its original lease expiry. A matching machine/attempt may acknowledge an assignment with `failed` and `outcome:'blocked'`, or a job with `completed` and `status:'cancelled'` at the matching revision. An explicit `type:'cancelled'` acknowledgment is also accepted. These acknowledgments preserve terminal cancelled state; other late results remain fenced out. Cancelling a run's CI job (not a merge-queue job) reports the attempt to the engine as `cancelled`, so its retry policy applies and the run can finish. Free capacity counts the unexpired leases the hub holds for the machine; the node sizes each lease's `max` from its own running count, so a heartbeat that predates a completion cannot hold a slot shut.

## Events and messaging

Event pages return `{events,nextCursor}`. SSE emits standard `id`, `event` and JSON `data` fields. Resume with `Last-Event-ID` or `after`; explicit `after` wins. Replay and live delivery use the same committed global sequence. Slow readers are disconnected when response buffering fills and can resume from their last consumed ID. No event-retention pruning is implemented.

Interaction events identify the run, roles and source/target nodes (`sourceNodeId`/`targetNodeId`, also as `from`/`to`, which metrics read so unplanned edges keep their endpoints). `agent.messaged` names roles; each end resolves to the node holding that role in the run's graph. An end no node holds (the `owner`, or an unknown role) is recorded as `null` with `sourceUnknown` or `targetUnknown: true` and the role kept in `senderRoleId`/`recipientRoleId`, so it is always unplanned and never counted against a node named like the role. Matching edges receive `edgeId`; unexpected interactions are retained with `unplanned:true`. Message edges permit traffic both ways. Hub assignment lifecycle transitions emit `assignment.state`; jobs, review results and human decisions emit `gate.result`. Engines may also emit explicit interaction effects or work-item moves. Observed interactions are telemetry, never authority to spawn work.

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

A merge entry from the engine is enqueued into one `@perpeto/delivery` queue per project repository, base branch and merge configuration, stored in `deliveryDatabasePath`. Its CI is the steps of the ci nodes named in `requiredChecks` (or every ci node), and a passing speculative job proves those named checks. Speculative jobs are hub Jobs with a `delivery` field, leased by nodes like any other job. Jobs whose revision lives in a hub repository (every candidate, and CI for projects with a local repository) carry `source: {kind: 'hub-bundle', path: '/jobs/:id/bundle'}` and `repo: {defaultBranch}`, never a hub path. `GET /jobs/:id/bundle?attempt=N`, for the machine holding that attempt (or the owner), returns `application/x-git-bundle` with exactly the job's revision and its history under one ref; the hub chooses the repository from the job, and a missing revision returns `409 SOURCE_UNAVAILABLE`; their results go to the queue rather than the engine. The pump runs Git preparation and publication outside the request serializer, then reconciles queue state into hub merge entries and jobs, so a crash between the two stores is repaired on the next pump. Before each queue step, entries their run has closed are withdrawn, including entries under test; their speculative job is cancelled and the rest of a batch is retested. A merge that was already published still shows as merged. Merge-queue jobs lease while their own run is paused, because the queue is shared with other runs. Entries are admitted one at a time: an entry whose project repository cannot be used stays queued with `deliveryError` and a `merge-entry.blocked` event, and admission continues for others.

A queue step that fails backs off exponentially from `deliveryRetryBackoffMs` (default 2000, capped at 60 s). After `deliveryMaxStepFailures` consecutive failures of one attempt (default 5) the hub rejects its entries through `rejectEntry`, records the cause as `deliveryError` and reports the rejection to their runs. In a batch, only entries whose PR head cannot be read are rejected when that identifies them. A failing merging attempt is rejected only once the adapter confirms the base does not contain its candidate, so a possibly published push is never reported as rejected; native GitHub queue publication keeps retrying. Failures with no attempt, such as a missing base branch, stay visible as the queue's `merge-queue.error`. Retry counts are in memory and restart after a hub restart.

Local bare repositories (project `repo.localPath`, or an absolute path or `file://` `url`) retain atomic local ref publication. GitHub HTTPS/SSH URLs, or GitHub PR URLs paired with a local/remote Git origin, select `GitHubAdapter`. The hub clones an isolated bare mirror under `deliveryRepositoriesPath`, fetches the observed base and heads before candidate preparation, and gives speculative jobs that mirror URL. Nodes must be able to read that path; cross-machine object transfer is not implemented. Other forges remain blocked with `deliveryError`.

Merge-queue node config accepts `publication: 'fast-forward-push'` (default) or `'github-merge-queue'` (serial only). The former pushes the exact tested candidate without force and finalizes PRs through `gh`; squash/rebase PRs become CLOSED with evidence. The native option lets GitHub own final ordering and checks, so `mergedRevision` can differ from `testedRevision`. These guarantees and remote race limits are documented by [@perpeto/delivery](../../packages/delivery/README.md). Git/gh authentication stays with their credential helpers.

`deliveryLeaseDurationMs` defaults to 60000 and fences a pump worker independently of node leases. After a crash, recovery waits for that lease to expire. Maintenance schedules the pump outside the request serializer, including after startup, and reconciles terminal delivery entries even when the hub did not commit their prior projection. `GET /projects/:id/runs?status=` returns `{runs}` newest first and rejects unknown status values.

## Persistence and limits

Hub entity state, immutable workflow versions, architect requests, run snapshots, leases, cancellations, jobs/logs, merge entries, account snapshots, usage, idempotency and global events are in `databasePath`. Messaging keeps its existing separate SQLite DB at `messagingDatabasePath`. Ordinary run state lives in the workflow package's `RunStore` at `workflowDatabasePath` (default `./workflow.sqlite`), which persists each event's changed rows rather than the whole run; work items are read from it, and the hub keeps only the last applied engine sequence per run. All use WAL and full synchronous writes; DB and credential files are private regular files. Hub mutations serialize through transactions. The RunStore commits separately: if a hub transaction rolls back after the engine committed, the hub replays that run's stored events after its applied sequence before the run's next event and on every maintenance tick, and acknowledges the engine's outbox only after committing. Runs that already held their whole engine state in the hub keep advancing from it. The hub no longer emits `work-item.updated` for RunStore runs; engine events such as `workitem.moved` and `human.requested` still describe each change.

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

The programmatic `createHub({configPath, clock?})` accepts a clock returning epoch milliseconds, defaulting to `Date.now`. Intake, usage, engine event timestamps, leases, retry deadlines and hub persistence use it; HTTP polling timers still use wall time. Tests advance it across UTC windows without waiting for midnight.

Tests use actual HTTP servers on ephemeral ports, SQLite files and explicit stub engines. The load case enrolls 100 simulated machines, concurrently leases one assignment per machine, then concurrently renews all 100. It measures HTTP/DB work, not 100 real agents, cross-machine networking or sustained production throughput. See [the handoff](../../docs/handoffs/factory-hub.md) for executed results and remaining integration work.
