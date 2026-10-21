# Factory hub handoff

## Conflict recovery integration, 21 October 2026

Merged main `8f8f903` in `b4bd436`, retaining the continuous-intake implementation below. The minimal additive delivery change persists `rejectionKind: 'conflict'|'ci'|'other'` on queue entries: typed `MERGE_CONFLICT` preparation failures activate recovery, failed checks/missing evidence are `ci`, and infrastructure/publication/withdrawal failures are `other`. Types survive SQLite reopen. Historical/untyped causes are conservatively `other`, with no reason-text inference. The hub copies the field to its entry and maps it to `merge.rejected.data.kind`.

Hub assignment results preserve planner `items[].touches` and builder `rebaseTouchedBeyondConflicts`, including explicit false, for engine validation. Leases retain engine assignment `step: 'rebase'` and `rebaseOf`. Engine recovery movements retain `edgeId: null`, `step: 'rebase'` and `unplanned: false`; authored-edge metrics exclude them. Project node/run metrics sum `conflictRejections` and `rebases`; engine `conflict-churn` findings keep their run ids.

Tests were first observed failing for delivery kinds, planner scopes, engine kind mapping and conflict metrics. A real local Git/HTTP test merges the first of two reviewed edits, observes the second conflict, leases its rebase, reports explicit false, then verifies fresh speculative CI and merge without another review. Other tests cover typed cause persistence across restart, overlapping child serialization, true/false review evidence, multi-run metrics and churn. This is local integration with test-driven node results, not live harness acceptance. Node `v24.22.0`: root `npm test` passes **545 tests, 0 failures** (44.6 s), including the merged main tests and actual Git conflict recovery. Changed Markdown file links resolve and `git diff --check` passes. No new config key, dependency change or executor edit was needed.

### Executor handoff

No changes were made to `packages/t3-executor` in this integration. The parser in `src/results.js` currently drops the new fields, so the executor worker must add:

- Planner output instructions and parsing: `AssignmentResult.items[].touches?: string[]`, at most 100 distinct normalized repository-relative file/directory paths per item, each nonblank and at most 4096 characters. Match workflow validation: no absolute/drive paths, parent traversal, backslashes, control characters or glob syntax; empty/omitted declarations retain legacy concurrency.
- Rebase output instructions and parsing: `AssignmentResult.rebaseTouchedBeyondConflicts?: boolean` from the final fenced JSON. Request it on `assignment.step === 'rebase'`; preserve both true and false, validate present values, and leave a missing report absent so the engine conservatively repeats review. Preserve `assignment.rebaseOf` (the rejected merge id). Branch identity already derives from the work item; verify publishing the new head on that same branch. `publishBranch` currently pushes without force, so a history-rewriting rebase needs an explicit safe publication strategy or a merge-based update that fast-forwards.
- Existing architect integration also needs `templateId?: string` and `additionalWorkflows?: Array<{name: string, graph: object, rationale: string, templateId?: string}>` (up to three). Its current successful structured parse keeps only graph/rationale and replaces summary with rationale, so the hub cannot recover the discarded fields from the original fenced block. The hub already accepts these fields directly or from intact fenced JSON.


## Continuous intake integration, 21 October 2026

This section supersedes the original unwired-engine limits below. Based on main `81e629c`; changes stay in the owned hub paths and the architecture/handoff docs. No new hub config keys were needed, so CLI-generated config and `config/hub.example.json` keep their existing contract.

Implemented and covered by regression tests added before the relevant fixes:

- Run start forwards `keepOpen`, `source`, UTC cron `schedule` and per-run `budget`. `PATCH /runs/:id` updates live/paused runs without replacing their pinned graph or existing work. Maintenance sends durable minute ticks with stable ids; missed minutes do not catch up. Goal and schedule requests use the durable engine outbox, persisted prepared batches and stable fulfilment ids. Goals omit completed/dropped/already active or reserved project goals, include context/evidence and expose `goalId` links.
- Usage records and delivery intents commit together, then input/output deltas reach the engine exactly once. Cache subtotals are excluded. Previous-day records remain in the ledger without consuming today's allowance. Intake pauses/resumes through engine budget events; deferred manual batches survive restart and split to capacity. Finite runs wait for their deferred input before completing. Run detail and overview expose settings, `intake` and `budgetUsage`.
- Independent workflows stay concurrently active with separate runs and shared machine/delivery capacity. The template endpoint returns the public workflow library, and architect prompts retain existing workflows. Direct and fenced replies preserve templates/additional proposals; all graphs validate before the drafts save together, errors carry `workflowIndex`, and assignment `drafts` lists every workflow id/version for separate activation.
- Role usage grouping persists assignment role/node attribution through rollup and assignment deletion. Successful runs record `completedAt`, and terminal runs retain the engine's `stoppedAt`. The initial additive merge rejection field is superseded by the typed conflict-recovery integration above.

Durability tests inject a failure after engine commit but before the hub projection commits, including scheduled ticks and manual intake. Tests also cover close/reopen, daily rollover, active/item/token limits, finite batch completion, concurrent goal deduplication, all-or-nothing architect validation and usage retention. Node `v24.22.0`: root `npm test` passes **514 tests, 0 failures** (34.5 s), including CLI/example config parity, actual hub HTTP/SQLite tests and repository end-to-end crash recovery. `git diff --check` passes. No dependency manifest or lockfile changed.

Limits: no live harness/browser/device acceptance was run. Budgets guard intake, not in-flight spend. Since `packages/workflow` has no configuration update event, changed runs and finite runs held for deferred input use the hub's existing whole-state snapshot execution path. This preserves durability and atomic effects, but writes the full state per event; later steps are outside RunStore replay verification. Ordinary runs retain the incremental store. A native workflow configuration event should replace this compatibility path in future work.

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
