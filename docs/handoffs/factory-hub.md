# Factory hub handoff

Implemented in `apps/hub/**` and `config/hub.example.json`; no architecture, other package, upstream runtime, or root configuration changes. Branch: `t3/build-factory-hub`. Based on `e02784f`, with the later agent-authored workflow, run observation and fixed node wire-format contracts read directly from `main` in `/Users/justuswork/Documents/Perpeto`.

## What exists

- Dependency-free Node 24 ESM hub: `createHub({configPath,engine?})`, explicit `listen()`/`close()`, CLI, file-based config, JSON caps/errors, exact-origin CORS.
- All contracted owner/node API routes. SQLite persistence for hub entities, immutable workflow versions, run/engine snapshots, architect requests, leases/cancellations, account snapshots, usage, idempotency and global events. MessagingStore retains its separate DB.
- Owner secret bootstrap to a mode-600 file, token/code hashes in SQLite, deterministic retry credential reconstruction with HMAC from the owner secret. No token is logged or persisted in idempotency responses.
- One-time expiring enrollment; public account snapshots; capacity/requirement-aware long polling; renewals; expiry requeue with incremented attempt; atomic machine/attempt/expiry fencing. Heartbeat missed three intervals marks offline. Owner drain survives offline/recovery.
- Exact fixed node response shapes: lease `{assignments,jobs}`; renew `{leaseExpiresAt}`; heartbeat `{status,cancel:{assignments,jobs}}`. Missing or stale attempts return `409` with `error.code:'lease_lost'`. Run stop and individual job cancellation persist notification IDs until acknowledgment/original lease expiry.
- Global event sequence with JSON pages and resumable SSE, including committed lease events. Usage aggregates provider/model/machine/day and filters; dashboard overview.
- Immutable user/agent workflow versions, diff/activation routes, project-scoped `workflow-architect` assignments, validation-error retries capped at three architect attempts, valid inactive drafts with provenance/rationale, and run-pinned active versions.
- Interaction telemetry: assignment lifecycle, work-item movement, delegation/messages, gate results, edge matching and unplanned interactions. Leased agents message only roles permitted by their policy. Owner run-channel sends emit one `agent.messaged` per message.
- Run/project metrics routes collect scoped state, events and usage, delegate calculation to the engine, and overlay machine/agent locations from current leases.

## Workflow integration boundary

`src/engine/workflow-adapter.js` deliberately fails closed with `503 ENGINE_UNAVAILABLE`. The lead must map actual `@perpeto/workflow` exports and its RunStore into this small interface. No production path imports the test stub.

```text
validate(graph) -> { valid, errors }
startRun({run,workflow,input}) -> {state,effects}
applyEvent({run,workflow,state,event}) -> {state,effects}
diffGraphs(fromGraph,toGraph) -> JSON diff
buildArchitectPrompt({prompt,project,machines,providers,workflows,baseGraph,validationErrors,attempt}) -> string
parseArchitectResult(assignmentResult) -> {graph,rationale}
computeRunMetrics({projectId?,runId?,runs,workflows,assignments,jobs,workItems,machines,usage,events,window,windowMs,from,at})
  -> {nodes:NodeMetrics[],edges:EdgeMetrics[],run:RunMetrics,bottlenecks:Bottleneck[]}
```

Engine methods may be asynchronous but must perform no external side effects. Opaque state is hub-persisted with effects. Entity effects are `{type:'work-item'|'assignment'|'job'|'merge-entry',value}`; run effects patch status via `{type:'run',value:{status}}`; explicit interactions use `{type:'event',value:{type,assignmentId?,data}}`. Assignment/job effects queue work; engine results cannot overwrite held or finished work, or another run's IDs. Run input is `event:{type:'input',data:body}`; final work is `assignment.finished`/`job.finished` with entity ID, result `data` and full `value`; human input is `human.decision` with work item ID and `data`. Workflow metrics formulas and validation policy are engine-owned.

## Verification

Executed on this Mac with Node `v24.22.0`, using:

```sh
source ~/.nvm/nvm.sh && nvm use 24
node --test apps/hub/test/hub.test.js
npm test
```

- Hub suite: **26 passed, 0 failed**. Actual ephemeral-port HTTP and disk SQLite cover auth/CORS/caps (including chunked 413), retry conflicts/restart, enrollment expiry/replay/secret containment, own-work access, requirement/capacity matching, expiry and same-machine stale attempts, offline/drain, usage aggregation, SHA-bound jobs/logs, workflow version snapshots, pause/stop, human gates, messaging cursors/retry/restart, SSE replay/live resume, long polling, engine rollback startup recovery, header-based messaging retries, private DB/WAL/SHM permissions and actual CLI startup/shutdown without credential output.
- Addenda: immutable versions/diffs/activation and run pinning; architect invalid/valid and three-attempt cutoff; run messaging policy plus planned/unplanned interactions; metric window/context/lease overlays; exact wire format; persisted cancellation/acknowledgment and owner-only individual job cancellation.
- Root `npm test`: **47 passed, 0 failed** in this worktree. Other workers' newer packages are not present here, so this is not the integrated main test count.
- The latest root-suite load case enrolled **100 simulated machines**, then sent **100 concurrent leases** and **100 concurrent renewals**. All 100 assignments were unique and all 200 operations succeeded: **55.8 ms leasing + 32.5 ms renewing**, approximately **2,266 requests/sec** for that short local sample. Earlier samples varied roughly 1,513–2,506 requests/sec. Enrollment time is excluded from the throughput denominator. This is HTTP/SQLite throughput, not real-agent concurrency, a sustained benchmark, or cross-machine acceptance.

No live T3/harness, real workflow engine/metrics, full node-daemon integration, merge execution, hosted CI, deployment or browser journey is claimed.

## Contract details and requests

Architecture was not edited. The fixed `attempt` protocol supersedes the earlier experimental lease-ID fence; no lease ID is emitted or accepted as a substitute. Other needed integration details:

1. Map the engine interface above, including aggregate project metrics. Configure `architectHarness` in JSON for a provider/model actually available on enrolled machines. Architect assignments have project scope before a run exists, so `runId`/`workItemId` are omitted. This optionality should be documented in the entity schema.
2. Workflow `activeVersion` is a mutable pointer; immutable saved versions retain their draft status. `GET /workflows/:id` can show a newer draft and the existing active pointer. Starting a new run always selects the explicit active version. API metric payload names are `{nodes,edges,run,bottlenecks}`.
3. Node executors can submit first-class interactions via the assignment/job events routes; engine effects can emit them directly. The node's final event body must preserve architect `graph`/`rationale`. Cancellation acknowledgment accepts its current `failed/outcome:blocked` assignment result and `completed/status:cancelled` job result, plus explicit `type:cancelled`.
4. Additive owner routes `GET /assignments/:id` (architect tracking) and `POST /jobs/:id/cancel` (individual cancellation) are implemented. Job SHAs accept 40 or 64 hex characters to match the node daemon.
5. Existing factory-client uses `/api/perpeto`, whereas hub messaging is `/api/v1/messaging`. Lead/client owner must add a base-path option or adapter; hub reuses the exact MessagingStore semantics.

## Remaining limits

- The default engine adapter is intentionally unwired. Real validation, graph execution, architect parsing/prompt quality, graph diffs and measured bottleneck formulas require integration and end-to-end verification.
- Messaging writes use a different SQLite connection/DB. A crash between message/channel persistence and hub commit can leave message state without its hub event. Retried sends recover a missing event by message ID, but crash-atomic multi-DB writes are not guaranteed.
- One process owns hub scheduling. Large queues use in-process scans; no claim beyond the recorded short 100-machine HTTP load sample. No event/log/usage/idempotency retention or pagination beyond global events and existing messaging cursors.
- No token rotation/revocation UI, artifact upload, real merge runner or deployment setup. Backup DBs and the owner secret together. Remote transport needs a separately configured secure endpoint; example binding is loopback.

## Commits

- `e98655c` foundational store/config/workflow boundary.
- `6094e36` HTTP APIs, leases, events, usage, messaging and initial HTTP/load tests.
- `f3bfe14` immutable workflows, architect proposals and run observations.
- `53b5b4a` fixed node attempt/heartbeat/cancellation protocol and restart/cap/rollback coverage.
- `8a9ceaf` header idempotency, account timestamp validation, private sidecar checks and CLI startup/shutdown coverage.
- The final documentation commit follows these; use branch history for its SHA.

## Update: review wave 3 follow-ups (21 October 2026)

Later work on `t3/fix-hub-review-findings` supersedes several limits above; the current behaviour is in the [hub README](../../apps/hub/README.md) and each finding's fix is marked in [the wave 3 review](review-wave3.md). In short: retention, archives and usage rollups now exist; leasing wakes only machines that could take the work and queries open work through indexes; run state lives in the workflow RunStore; machine tokens can be rotated and revoked; owner session cookies, event paging and filters serve the web and Apple clients.

Latest changes:

- **Credentials** (`dd59078`): machine tokens, enrollment codes and session tokens are random and stored as hashes; the owner secret cannot mint them. Replays return the issued credential, sealed with AES-256-GCM under `credentialKeyPath` (default `./credentials.key`, owner-only, fingerprint pinned in the database). Back it up with the owner secret; the hub refuses to start without it. Tokens from older hubs keep working until rotated.
- **Message interactions** (`5d8977e`): `agent.messaged` resolves roles to nodes through the run's graph; an end no node holds is `null` with `sourceUnknown`/`targetUnknown: true`.
- **Cross-machine CI** (`c90abc4`): jobs whose revision lives in a hub repository carry `source: {kind: 'hub-bundle', path: '/jobs/:id/bundle'}` and `repo: {defaultBranch}`; `GET /jobs/:id/bundle?attempt=N` serves a bundle of exactly that revision to the machine holding that attempt.
