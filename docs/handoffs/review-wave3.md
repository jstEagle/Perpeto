# Wave 3 review: factory hub, workflow, node, delivery, accounts, CLI

Reviewed 21 October 2026 on branch `t3/5986cada`, based on main `9881b7b`. Independent review, no code changed. Scope: `packages/factory-{hub,workflow,node,delivery,accounts,e2e}`, `packages/perpeto-cli` and `install/`, read against [architecture](../architecture.md) and the wave handoffs.

Method: code reading plus scratch reproductions against the real packages, run outside the repo on Node v24.22.0 with temporary SQLite files and local bare Git repositories. A finding is listed as confirmed only if it has a failing reproduction or an exact code trace. `npm test` (261 passing) was not re-run as evidence; it does not cover any of the paths below.

## Summary

| Severity | Count |
| --- | --- |
| Critical | 1 |
| High | 6 |
| Medium | 18 |
| Low | 17 |

Several findings were found independently by more than one reviewer and are merged here. "Latent" marks defects in code no shipped path calls yet (account reservations are executor-owned, and `factory-t3` does not exist).

## Critical

### Node tokens can reach owner-only routes through path normalization (C1)

- **Where:** `packages/factory-hub/src/hub.js:78` checks the node allowlist against the raw request path. Routing then parses it with `new URL(path, 'http://hub')` (`hub.js:95`, `hub.js:289-294`), which applies WHATWG dot-segment and separator normalization. `index.js:109` passes the raw `url.pathname` through, and no owner route checks `auth.kind === 'owner'` itself.
- **Failure:** a raw path can match the node allowlist shape `/(assignments|jobs)/<id>[/renew|events|log]` and still normalize to a different, owner-only route. Confirmed: an encoded dot-segment path that passes the allowlist normalizes to `/events`, so a machine token reads the global event log, which carries every project's results, job log chunks and messaging metadata. Other separator forms may reach further owner routes, including mutating ones. That depends on what Node's HTTP parser accepts, and I did not test it (see unconfirmed).
- **Why it matters:** the node token sits in each machine's data directory, readable by the same user that runs agents and CI steps (H6). A single compromised machine should not be able to act as the owner.
- **Fix:**
  - Authorize on the normalized `pathname`, computed once in `index.js`, and reject requests whose normalized path differs from the raw one or contains encoded dots or backslashes.
  - Make `route()` deny by default: every owner route requires `auth.kind === 'owner'`.
  - Add regression tests for encoded and backslash path forms with a node token.
- **Fixed in `d06571d`.** Over HTTP the edge parse already resolved dot segments; the confirmed bypass was `Hub.request`, which checked the allowlist on one string and routed a re-parsed one. The hub now parses each path once, refuses anything normalization would rewrite (dot segments, encoded slashes or backslashes, empty segments) with `400 INVALID_PATH`, and `route()` denies node and enrollment tokens by default on the same decoded segments it dispatches on. The HTTP edge also refuses non-canonical targets. Regression tests cover encoded, backslash and double-slash forms over raw HTTP and against `Hub.request` directly.

## High

### A blank or whitespace-only CI log line fails the job (H1)

- **Where:** the node posts one log event per line (`factory-node/src/job.js:28-44`). The hub validates each chunk with `nonblank` (`factory-hub/src/hub.js:480`), which trims, so `"\n"` is rejected with 400. A NUL byte is rejected the same way. The failed post aborts the step (`process.js:31-32`) and the job ends `error` (`node.js:185-190`).
- **Failure:** `printf 'a\n\nb\n'` ends `job.completed:error`, while `printf 'a\nb\n'` passes. npm-style output, which starts with a blank line, also ends `error`. The templates' `npm ci` and `npm test` steps produce exactly this, so CI on real projects is retried as an infrastructure error until it runs out of attempts. Confirmed by reproduction (`/tmp/review-node/blank-log.test.js` at review time).
- **Fix:** accept any non-empty string chunk, escaping or replacing NUL instead of rejecting it. Also batch logs (M18).
- **Fixed in `9f096ac`.** Any non-empty string chunk is accepted and NUL is stored as U+FFFD. Batching (M18) is node-side and not part of this fix.

### A wedged merge entry blocks the project's merge queue forever (H2)

- **Where:** `factory-delivery/src/queue.js:86-98`, `local-git.js:33-38` and `77-83`, `machine.js:40-45`, `factory-hub/src/delivery/index.js:101-110` and `124-128`.
- **Failure:** if the head entry's PR branch is deleted after enqueue, its `prUrl` is a GitHub URL on a local project, it has unrelated history, or it is `local:main`, then `getHead`, `prepare` or `merge` throws `COMMAND_FAILED` or `INVALID_INPUT` on every tick. `advance` records `lastError` and returns. Every later entry for that repo and base stays `queued`, the run is never told, and stopping the run doesn't help, because `withdraw` only removes waiting entries. All of these values come from agent results. The comment at `delivery/index.js:106` says a non-local PR URL is handed back to the run, but `enqueue` never validates it. Confirmed by four package-level and one hub-level reproduction.
- **Fix:** validate `prUrl` through the adapter at enqueue. Treat a missing PR ref as head-changed. Reject the entry on non-conflict merge failures, `INVALID_INPUT` and `INVALID_CANDIDATE`. Cap `COMMAND_FAILED` retries, and add an abort for the active attempt.
- **Hub side: Fixed in `505e5fb`.** A failing queue step backs off exponentially (`deliveryRetryBackoffMs`, capped at 60 s). After `deliveryMaxStepFailures` consecutive failures of one attempt the hub calls `rejectEntry`, records the cause as the entry's `deliveryError` and reports the rejection to its run. A batch rejects only entries whose PR head cannot be read when that identifies them. A merging attempt is rejected only once the adapter confirms the base lacks its candidate. Failures with no attempt (a missing base branch) stay a visible queue error. Admission-time `prUrl` validation is not added; bad URLs are caught by the bounded retries instead. Regression tests cover a deleted PR branch and an unpublishable `local:main` entry with real Git.
- **Delivery side: Fixed in `4a95697`.** Additive `MergeQueue.rejectEntry({entryId,reason},{idempotencyKey})` permanently rejects queued or active entries, cancels unfinished speculative jobs, and requeues surviving batch members under the worker lease. `withdraw` now also releases active attempts. The [delivery README](../../packages/delivery/README.md#permanent-failures-and-cancellation) documents the API. The hub still owns admission validation, bounded retry counts, failure classification, and reporting rejection to runs.

### Long-poll fan-out and full-table scans collapse the hub well below the scale target (H3)

- **Where:** `factory-hub/src/index.js:43-57` registers every waiting long-poll as a hub listener. `hub.js:104` calls `notify()` after every mutation except an empty lease, including heartbeats, renewals and log lines. Each wake reruns `lease()`, which loads and parses every row of the kind twice (`hub.js:268`, `hub.js:270`, `store.js:31-33`), all inside the single request serializer and a `BEGIN IMMEDIATE` write lock. Maintenance does the same scans every second (`hub.js:135-141`). The `entities_queue` index (`store.js:13`) is never used, because `list()` filters in JavaScript.
- **Measured:**

| Setup | Result |
| --- | --- |
| 20,000 finished assignments with 4 KB prompts | one `lease()` 444 ms, one `maintenance()` 256 ms |
| 5,000 finished rows, 1 machine (2 waiting polls) | heartbeat round-trip 47-75 ms |
| 5,000 finished rows, 10 machines (20 polls) | 458-902 ms |
| 5,000 finished rows, 25 machines (50 polls) | 1.2-2.1 s |

- **Failure:** at 100 machines and 1,000 agents, renewals and heartbeats arrive at tens per second and each one triggers a scan per waiting poll. Renewals then exceed the node's `requestMs`, leases expire fleet-wide, and the resulting engine retries add more load. Finished work never leaves the hot table, so this gets worse as the factory runs.
- **Fix:** query queued work in SQL on an indexed status column, and keep held counts per machine. Wake polls only when leasable work is added or capacity frees, and coalesce wakes. Skip the scan when a machine has no free capacity. Move finished entities out of the scanned set.

### Cancelling a run's CI job strands the work item and the run (H4)

- **Where:** `POST /jobs/:id/cancel` (`factory-hub/src/hub.js:447-451`) only calls `cancelWork` (`hub.js:176-185`), which informs delivery for merge-queue jobs but never the engine. The node's cancellation acknowledgement returns early in `cancellationAck` (`hub.js:186-197`, `457-458`), before the engine path at `hub.js:512`.
- **Failure:** the engine's job stays open and its work item stays `active` at the ci node, so the run never completes. That holds even with `retry.maxAttempts: 3`. Confirmed by reproduction with the real adapter: after the cancel, the run was `running`, the item `active@ci`, the job `cancelled`, and no retry job existed.
- **Fix:** after `cancelWork` on a non-delivery run job, send the engine `job.finished` with status `cancelled`, so its retry policy applies.
- **Fixed in `12fef06`.** Regression test with the real adapter: the cancelled attempt is retried and the run completes.

### One failed lease-journal write fails every later lease until restart (H5)

**Fixed in 958dbf8.**

- **Where:** `factory-node/src/node.js:108-111` chains journal writes on one promise and never recovers from a rejection.
- **Failure:** one transient write error, such as a full disk or a briefly read-only data dir, makes every later `persistSeen` reject. The node keeps heartbeating and leasing, then fails each item immediately, so it burns engine retries for work that other machines could run. Confirmed: after restoring the data dir, jobs 2 and 3 still ended `error`, and `leases.json` was never written again.
- **Fix:** keep the chain alive with `.catch(() => {})` on the stored promise, and return the per-write promise to the caller.

### CI steps can read the node token, which cannot be revoked (H6)

**Fixed in dfc41ca.** Node-side CI exposure is addressed; hub token revocation/rotation remains a contract request. See [node isolation limits](../../apps/node/README.md#ci-jobs-and-logs).

**Hub side: Fixed in `693ae72`.** `POST /nodes/token` rotates a machine's own token (the old one works until the new one is first used) and owner-only `POST /machines/:id/revoke` deletes every token generation, marks the machine offline with `revokedAt` and expires its leases. Tokens remain HMAC-derived per machine and generation rather than random, so idempotent replays can re-derive them without storing them; revocation deletes the stored hashes, so replayed tokens no longer authenticate.

- **Where:** job workspaces live under the node `dataDir` (`factory-node/src/job.js:79-81`), next to `machine.json`. Steps inherit the daemon's full environment (`job.js:98-99`), and `perpeto node start` passes the operator's shell environment to the daemon. Node tokens are `HMAC(ownerToken, machineId)` (`factory-hub/src/hub.js:61`, `404`), with no revocation route. Rotating the owner token is refused at startup (`hub.js:53`).
- **Failure:** CI runs agent-authored code at `headSha` by design. A step that reads `../../../machine.json` printed the token unredacted into the hub job log (confirmed by reproduction). With C1, that token reaches owner routes. Without C1, it still lets the holder lease and report any work matching that machine.
- **Fix:** move workspaces outside `dataDir`, run steps with a scrubbed allowlisted environment, add the token to CI redaction, and store random per-machine tokens with a revoke route.

## Medium

### The hub accepts results the engine rejects, discarding the agent's work (M1)

`factory-hub/src/hub.js:485-490` accepts any string up to 4,096 characters for `headSha`, `branch` and `prUrl`, and planner `items` of any shape. The engine's `checkResult` (`factory-workflow/src/engine.js:690-705`) requires a full lowercase SHA, a branch of at most 255 characters, item titles of at most 200 characters and string bodies. A short SHA, a long branch name or `body: null` makes the final event return 400 and roll back. The node then reports "Executor failed." (`factory-node/src/node.js:185-190`), so the real result is lost and the work retries. Confirmed by reproduction. **Fix:** validate with the engine's limits at the hub boundary, or have the adapter convert invalid fields into an explicit failure summary the agent can act on. **Fixed in `61cdec0`.** The hub dry-runs the pure engine step before acknowledging a run result. A refused result is recorded as a failure carrying the engine's reason and the agent's summary, which the engine retries; the response includes `reason`.

### Pausing one run stalls the merge queue shared by other runs (M2)

Single-entry speculative jobs carry their run's `runId` (`factory-hub/src/delivery/index.js:163`, `factory-delivery/src/queue.js:101`). `lease()` skips queued work whose run isn't `running` (`factory-hub/src/hub.js:277`), and the queue has no job timeout. Pausing run A while its entry is under test blocks every other run's merges for that project and base until A resumes. Confirmed independently by three reviewers (lease returned no jobs, the other run's entry stayed `queued`). **Fix:** don't apply the run-status filter to delivery jobs, or requeue a paused run's active entry. **Fixed in `21d39f5`.** Merge-queue jobs lease regardless of their run's pause.

### Batch entries from a stopped run still merge, while the hub reports them rejected (M3)

Batch jobs carry no `runId` (`factory-delivery/src/jobs.js:45`, `queue.js:99`), so `cancelRunWork` (`factory-hub/src/hub.js:251`) skips them. The hub entry already shows `rejected` with reason `run_stopped`, and `sync` skips terminal hub entries (`delivery/index.js:173-175`). Delivery merges the code anyway, so the hub and the base branch disagree. This contradicts `integration.md:48`. Confirmed: `main:a.txt` was merged while the hub entry was `rejected`. **Fix:** add a reducer action that removes one entry from the active attempt and requeues the rest, and run the withdraw pass in `admit` before `advance`. **Fixed in `5ace1ba`**, using delivery's active `withdraw` from `4a95697`. The pump withdraws closed entries before every queue step, which cancels the batch job and retests the rest. If a publication already completed before the stop, the hub now mirrors the merge rather than showing rejected.

### A repeated human decision passes the next human gate (M4)

`factory-hub/src/hub.js:381-385` and the engine (`engine.js:185-215`) only check that the item is `blocked`, not which gate the decision is for. The engine event id is random (`workflow-adapter.js:131`). A client retry without an idempotency key, or two people answering the same gate, applies the second `pass` to the next gate, so it passes without anyone seeing its prompt. Confirmed: two `pass` posts on a design gate followed by a release gate both returned 200, and the run completed. **Fix:** require the gate `nodeId` (or a visit token) and reject it if it doesn't match `item.waiting.nodeId`.

Fixed in 634703b for the engine: every wait has a `decisionId`, and a decision naming another one throws `STALE_DECISION`. The hub adapter still has to send `decisionId` (and map `STALE_DECISION` to 409) before hub clients are protected. **Hub side: Fixed in `5fedb31`.** `POST /work-items/:id/decision` passes `decisionId` to the engine, refuses one for an earlier wait with `409 STALE_DECISION`, maps the engine's `STALE_DECISION` to 409, and exposes `decisionId` on work items, `human.requested` and the human `gate.result`.

### The node ignores heartbeat cancellations and never acknowledges them (M5)

**Fixed in 958dbf8.**

The hub returns `cancel: { assignments, jobs }` (`factory-hub/src/hub.js:435-436`), as the architecture requires, but `factory-node/src/node.js:118` only reads `status`. Work stops only when the next renew gets `409 lease_lost`, about 20 s with default timing, and no `cancellation-acknowledged` event is ever sent. Confirmed: about 23 heartbeats carried the cancel, the abort came 4.6 s later on a renew, and no acknowledgement followed. **Fix:** abort the listed records and report `cancelled` with the attempt.

### The node advertises providers it cannot run, and their work parks on a human (M6)

**Fixed in 958dbf8.**

`node.js:278-282` advertises every provider CLI found on PATH, while a missing `@perpeto/factory-t3` is skipped silently (`executors.js:73-77`). Leased work comes back `blocked` with "No compatible executor is installed" (`node.js:179`), and the engine routes blocked work to a human gate or holds it (`engine.js:96`, `523-531`). Confirmed with a fake `codex` on PATH. **Fix:** advertise only providers with a registered executor, and report a missing executor as a failure the engine retries elsewhere.

### Account snapshot errors and hub 409s kill the node and its running work (M7)

**Fixed in 958dbf8.**

`node.js:115` and `127` treat any account-provider error, or any non-retryable heartbeat response, as fatal, and a fatal stop drops every running record (`node.js:46-51`). The hub answers 409 when an account ID already belongs to another machine (`factory-hub/src/hub.js:424-425`), and `importAccount({ id })` lets operators choose IDs (`factory-accounts/src/index.js:130`). Confirmed: one thrown `LOCAL_STORAGE_ERROR` abandoned a running job, and a duplicate explicit account ID on a second machine kept that node from starting (real hub over HTTP). **Fix:** send heartbeats with the last good snapshot or none, treat account-related 4xx as non-fatal, and namespace account IDs by machine.

### A background child holding stdout times out the step (M8)

**Fixed in dfc41ca.**

`factory-node/src/process.js:35` waits for `close`, not `exit`. `sh -c 'sleep 30 & echo hi; exit 0'` returned `timedOut: true` after the full timeout, which `job.js:104` maps to `error`. Patterns like `server & npm test` hit this. Confirmed by reproduction. **Fix:** on `exit`, kill the process group and close the pipes after a short grace period.

### Leased items the node won't run are dropped without release (M9)

The hub never updates machine `labels` after enrollment (`factory-hub/src/hub.js:417-418`), while the node checks its current config labels (`node.js:206`). A mismatched item hits `continue` at `node.js:228` with no release, so it stays leased until expiry and its attempt is burned. A node clock more than one lease ahead hits the same path (`node.js:202`). Confirmed: attempts climbed from 1 to 4 with nothing running. **Fix:** send labels in heartbeats and add a lease release route. **Hub side: Fixed in `64273ba`.** Heartbeat `labels` replace enrollment labels for leasing, and `POST /assignments/:id/release` / `POST /jobs/:id/release` `{attempt, idempotencyKey?, reason?}` return unstarted work to `queued` with the same attempt, without telling the engine. The releasing machine is not offered that attempt again for one lease duration. The node still releases through a fenced terminal event until it adopts the route.

### Node IDs like `constructor` break concurrency and loop limits (M10)

The node ID pattern (`factory-workflow/src/graph.js:21`) allows `Object.prototype` keys. These collide with inherited properties in plain-object maps: `open` (`engine.js:562-574`), `loopCounts` (`engine.js:396`, after the delete at `508`) and per-node metric counters (`metrics.js:87-94`). Confirmed: an agent node named `constructor` with concurrency 1 dispatched all three items at once, and a loop named `constructor` produced 666 assignments before the hop backstop, against 11 for a loop named `loop`. Workflows can be agent-authored, so this needs no malicious user. **Fix:** use `Map` or `Object.create(null)`, or reject reserved IDs in validation.

Fixed in a94db54.

### Account registry receipts grow until the node can't start (M11, latent)

**Fixed in fedb1e1.**

Every select, release and observe adds a permanent receipt (`factory-accounts/src/index.js:119-120`), and the whole registry is rewritten with fsync each time. Reads fail above 4 MiB (`private-files.js:57`), after which `snapshot()` throws `FILE_TOO_LARGE`, the heartbeat goes fatal (M7), and restarts fail at `bind`, which is an endless restart loop under a service manager. Measured: 443 B to 267 KB after 200 assignments, so the cap arrives after roughly 2,700 assignments. Confirmed with a real node and a fake hub. **Fix:** expire or compact receipts, or move the registry to `node:sqlite`.

### Crash-leaked reservations drain the pool, and exhaustion falls back to the operator's login (M12, latent)

**Fixed in ee3b5ce.** Package leases and fail-closed exhaustion are implemented. Node startup recovery and strict exhaustion coverage: **Fixed in 9fd2160.** Recovery releases only exact durably settled tokens; uncertain crash reservations retain their finite lease. Executor turn renewal, cancellation on renewal loss and reservation-token forwarding remain with the executor worker. The node uses fenced releases because bulk reconciliation can remove a token created after its snapshot; atomic bulk snapshot fencing is an accounts API follow-up. See [account integration requirements](../../packages/accounts/REVIEW-WAVE3.md).

`factory-node/src/integrations/accounts.js:36-57` never reconciles reservations on `bind`, and the pool has no API to list them (handoff step 5 is unimplemented). After a crash mid-assignment, the retry and every other assignment get `null`, while heartbeats still report the account `active`. `acquire()` returns `null` both for "provider not pooled" and "pool exhausted" (`accounts.js:5`, `52`), and the documented contract tells executors to fall back to the default login on `null`. An exhausted pool therefore silently runs work on the operator's personal subscription. Confirmed by scratch test on a shared data dir. **Fix:** release all reservations on `bind`, and return `null` only when no account of that provider is enrolled.

### One unhealthy account home blocks selection for its provider (M13, latent)

**Fixed in 4630fcf.**

`factory-accounts/src/index.js:161-168` picks the least-recently-used candidate first and then checks its home. The check throws instead of skipping, and nothing is persisted, so the same account stays first forever. Confirmed: one `.claude.json` at mode 0644 made three selects in a row throw `UNSAFE_PERMISSIONS`, and the healthy account was never chosen. **Fix:** skip and flag unhealthy accounts.

### Hub tables grow without bound and several reads scan them all (M14)

- **Growth:** every node POST carries a fresh idempotency key (`factory-node/src/hub.js:18`, `25`), so the hub stores a row per heartbeat, renewal, event and non-empty lease, including full assignment prompts in lease responses (`factory-hub/src/hub.js:98`). Every heartbeat and renewal also writes an event (`hub.js:435`, `454`), about 864,000 heartbeat events a day at 100 machines before any renewals. `job-log` and `usage` rows are kept forever. Nothing is pruned.
- **Scans:** `GET /jobs/:id/log` parses every log chunk of every job (`hub.js:445`). `/overview` parses every usage record ever written (`hub.js:524`). `messageInteraction` full-scans `events` with `json_extract` on each message (`hub.js:563`; the query plan is `SCAN events`). Metrics run one extra query per event row with no index on `at` or `run_id`, and load job log chunks through `job.log` event data (`observation.js:38-43`, `store.js:17-18`).
- **Fix:** add retention for idempotency rows and events, stop emitting heartbeat and renew events (or keep them out of the global log), index `job-log` and `usage` by their keys, and index event lookups.

### The whole run state is rewritten on every engine event (M15)

`factory-workflow/src/engine.js:58` clones the full state, `563-566` and `300` scan every assignment and item, `workflow-adapter.js:51-55` stringifies every item and merge twice, and `factory-hub/src/hub.js:199-206` parses and rewrites the state. Closed assignments keep their full prompt and result. Measured with 4 KB bodies: 100 finished items gave a 1.2 MB state and 1.1 ms per event, and 2,000 items gave 24.8 MB and 40-72 ms per event, before the SQLite write. Cost per run grows quadratically. **Fix:** store entities in their own rows, keep closed work out of the hot state, and diff from effects instead of whole-state comparisons.

Fixed in 8eb08d0 for `factory-workflow` (now `packages/workflow`): `step` is copy-on-write, and `RunStore` writes only changed rows with a flat per-event cost. The hub-side costs (`workflow-adapter.js` diffing, `hub.js` parsing and rewriting the state) remain. **Hub side: Fixed in `05cab73`.** The adapter steps runs in a `RunStore` at `workflowDatabasePath`; the hub keeps only the applied sequence per run, builds its entities from engine effects and reads work items from the store. With 60 items of 4 KB the hub's per-run row is now `{id, seq}` instead of 276 KB. A hub rollback after the engine committed is repaired by replaying the run's stored events after its applied sequence.

### Merge-queue receipts store the full state on every tick, and an unmirrored cancel keeps the queue ticking forever (M16)

`factory-delivery/src/store.js:61-74` and `98-105` insert a receipt holding the entire queue state on every tick, including no-op ticks, and the hub ticks about once a second while a queue has open work (`delivery/index.js:114-118`). Measured: 7,066 bytes per tick with 30 entries. If a job is cancelled before the hub mirrors it, `admit` treats the queue as open forever (`delivery/index.js:117`, `161`). Confirmed: 20 pumps after everything merged added 20 receipts. **Fix:** skip receipts for no-op ticks, store a hash instead of the state, prune history, and only count `queued` delivery jobs as missing from the hub.

**Delivery side: Fixed in `4a95697`.** Receipts hold compact revision pointers backed by shared inverse edits, preserving exact historical retry responses. Idle/unchanged ticks add no receipts or history; configurable count/age retention prunes both, with transactional schema-1 migration. Active withdrawal cancels the speculative job and clears the attempt. Regression tests cover cancellation before mirroring, bounded retention, replay through restart/bisection, and unchanged publication polling. The hub follow-up remains: only missing jobs with `status === 'queued'` may keep admission open; never count unmirrored cancelled history as pending work.

**Hub side: Fixed in `21d39f5`.** Only queued delivery jobs the hub has not registered count as pending work, and a delivery outcome with no hub entry no longer keeps the queue open.

### One bad project repo URL halts merge admission for every project (M17)

`localRepository` (`factory-hub/src/delivery/index.js:20`) calls `fileURLToPath`, which throws on `file://host/repo.git`. `admit` only catches `Unsupported` (`delivery/index.js:97`), so the whole admit transaction rolls back on every pump, with no `merge-queue.error` event. Confirmed: `ERR_INVALID_FILE_URL_HOST` on each pump, and a healthy project's entry was never enqueued. **Fix:** catch errors per entry and record them as `deliveryError`. **Fixed in `21d39f5`.** An unusable `file://` URL is treated as unsupported, and any per-entry admission error is recorded as `deliveryError` with a `merge-entry.blocked` event; the entry stays retryable.

### CI logs cost one HTTP request per line, inside the step timeout (M18)

**Fixed in dfc41ca.**

`factory-node/src/job.js:28-44` awaits one POST per line. Measured: 3,000 lines took 985 ms against 3 ms locally, and that time counts toward the step timeout. On a remote hub it scales with round-trip time. **Fix:** batch by size or time.

## Low

| ID | Where | Defect | Fix |
| --- | --- | --- | --- |
| L1 | `factory-delivery/src/queue.js:72` | One PR head moving during batch publication rejects every batch member, because the reject has no `entryId`. Confirmed. Testing-phase handling at `queue.js:88` is correct. | Return the changed `entryId` from `merge()` and reject only that entry. **Fixed in `4a95697`.** Local/GitHub adapters identify the changed entry; legacy adapters fall back to head rereads. Real Git publication-race tests prove healthy batch members still merge. |
| L2 | `factory-hub/src/delivery/index.js:191-197` | `record()` commits to the delivery DB inside the hub transaction. After a hub rollback, a later result with a different body throws `IDEMPOTENCY_CONFLICT`, which isn't swallowed, so the job is re-leased indefinitely. Confirmed for the double-record throw; the rollback window is by trace. | Treat a conflict on a resolved job as ignored and cancel the hub job. **Fixed in `55ea196`.** The conflict is ignored and the hub job mirrors delivery's recorded result. |
| L3 | `factory-node/src/node.js:189`, `307` | `stop({ drain: false })` reports run work as `blocked`, which the engine holds for a human instead of retrying. Trace. | Report `failure` for forced stops. **Fixed in 958dbf8.** |
| L4 | `factory-hub/src/hub.js:208`, `246`; `engine.js:537-544` | Escalations are logged as unplanned `workitem.moved` events with no endpoints, and metrics show `unplanned:flow:?->?`. Confirmed. | Count escalated items as reported moves. **Fixed in `55ea196`.** Derived moves also carry `from`/`to`. |
| L5 | `factory-workflow/src/architect.js:223` | The `FENCE` regex backtracks quadratically. A 64 KiB architect summary blocked the hub's serialized loop for 2.5 s per attempt. Confirmed. | Use a single whitespace class, or scan line by line. Fixed in 5a595b8. |
| L6 | `factory-node/src/config.js:46-48`, `factory-hub/src/hub.js:261` | Node capacity above 1,000 is accepted, but the lease `max` caps at 1,000, so leasing gets 400 and the node goes fatal. Confirmed. | Clamp `max`, or validate capacity against the hub limit. Node: **Fixed in 958dbf8.** Hub: **Fixed in `55ea196`** (clamps `max`). |
| L7 | `factory-hub/src/hub.js:269` | `Math.max(held, machine.running)` keeps a finished slot idle until the next heartbeat, up to 10 s by default. Measured 1.6 s with a 3 s heartbeat. | Use held leases only, or refresh `running` on final events. **Fixed in `55ea196`.** Final events and cancellation acknowledgements free the slot. |
| L8 | `factory-node/src/hub.js:36-46`, `node.js:121-130`, `238-243` | Retries back off without jitter, so nodes retry in lockstep after a hub outage. Trace. | Add full jitter. **Fixed in 958dbf8.** |
| L9 | `factory-accounts/src/index.js:66` | Re-enrolling on the same data dir gives a new machine ID, and the pool then fails with `INVALID_REGISTRY` at startup. Confirmed. | Rebind or reset the pool explicitly on re-enrollment. **Fixed in 3567b0e.** Pool API. Node re-enrollment integration: **Fixed in 9fd2160.** Live reservations block rebinding; persisted retry intent resumes after they are released/expire without consuming another enrollment code. |
| L10 | `factory-node/src/node.js:166-169` | Assignment workspaces (random per attempt) are never removed, and the lease journal is rewritten in full on every lease. The journal limit is already noted in the handoff. | Prune finished workspaces and journal entries. |
| L11 | `factory-accounts/src/signals.js:67-76`, `index.js:212-215` | Claude's permitted overage still cools the account on the next unrelated observation, about an hour in the repro, contradicting the comment and README. Confirmed. | Store an overage flag per window and exclude it from the exhausted check. **Fixed in c34e4ae.** |
| L12 | `perpeto-cli/src/service.js:27`, `50` | The systemd ownership check is a prefix match, so the default `service uninstall` disabled and removed a `~/.perpeto-staging` unit. Confirmed with a stubbed `systemctl`. | Match the whole marker line. **CLI fixed in `9a44a25`:** exact systemd marker-line ownership is checked before any manager call; prefix-install/uninstall regression in `apps/cli/test/review.test.js`. |
| L13 | `perpeto-cli/src/api.js:49-50`, `config.js:44` | A join retry rebuilds `name` from `hostname()` and requires an exact match, so a retry after a macOS hostname change fails until `join.secret` is deleted by hand. Confirmed. | Reuse `pending.config` on retry. **CLI fixed in `9a44a25`:** persisted defaults/body survive hostname or runtime-default changes; explicit name/label/hub/code conflicts still fail. Regression in `apps/cli/test/review.test.js`. |
| L14 | `perpeto-cli/src/process.js:20-23`, `factory-node/src/node.js:82-83` | Stale-lock checks are PID-only, so a reused PID (PID 1 in the repro) blocks startup after an unclean shutdown. Partly documented. | Store a boot or start-time identity with the PID. Node: **Fixed in 958dbf8.** **CLI fixed in `9a44a25`:** locks persist process start identity and recover a recycled PID without signalling it; live legacy PID-only locks stay conservative. Regression in `apps/cli/test/review.test.js`. |
| L15 | `perpeto-cli/src/config.js:30-31` | The CLI hub config omits `deliveryDatabasePath`, so the delivery DB lands outside `hub/`, and the backup in `docs/install.md` misses it. Trace. | Set `./hub/delivery.sqlite`. **CLI fixed in `9a44a25`:** all hub settings are explicit, including workflow/delivery DBs, retry bounds and repository cache under `hub/`; guide backs up the complete directory. Contract-key/path regression in `apps/cli/test/review.test.js`. |
| L16 | `factory-workflow/src/run-store.js:132` | `canonicalJson` sorts event keys, but warning order depends on key order (`graph.js:159`, `187-189`), so `verify()` reports a false mismatch. Confirmed. | Compare canonicalized warnings. Fixed in 3de2e3d. |
| L17 | `perpeto-cli/src/api.js:56`; `factory-hub/src/hub.js:399`, `496` | The CLI enrolls with `os: platform()`, so Windows sends `win32` and the hub rejects anything but `windows`. Separately, job results may omit `configHash` and still be accepted. Trace. | Map `win32` to `windows` as the node does (`node.js:279`). Require `configHash` on final job results. **Hub half fixed in `55ea196`:** `configHash` is required and the hub maps `win32` to `windows` at enrollment. **CLI half fixed in `9a44a25`:** enrollment maps `win32` to `windows`; injected-platform regression in `apps/cli/test/review.test.js`. |

## Plausible but unconfirmed

- **Maintenance is all-or-nothing:** `factory-hub/src/hub.js:130-162` runs every expiry, offline mark and engine event in one transaction, and `index.js:123` swallows failures. Any engine or effect-validation throw would roll back all of it and repeat every second, stalling lease expiry and offline detection hub-wide. Delivery `sync` has the same shape (`delivery/index.js:83`, `141`, `182`). A future `STATE_VERSION` bump would be one trigger. No current input was found.
- **More owner routes through C1:** backslash separators normalize like `/` in WHATWG URLs. Whether Node's HTTP parser accepts them in a request target was not tested.
- **Two queues per base branch:** two merge-queue configs on the same repo and base create two independent queues (`delivery/index.js:68`). The atomic ref update keeps this safe, but they may keep forcing each other to retest.
- **Speculative CI errors reject PRs:** an `error` or `cancelled` result on a single-entry speculative job rejects the PR, while ordinary CI nodes retry those statuses.
- **GitHub publication wedges:** in the GitHub adapter, `HEAD_CHANGED` or a closed PR after push would wedge the merging phase like H2. This path isn't wired into the hub yet.
- **Presigned URLs in PR comments:** GitHub PR-close comments include artifact and log URLs with their query strings (`factory-delivery/src/github.js:131-138`).
- **Shutdown ordering:** `Hub.close` closes the delivery store before in-flight requests drain (`hub.js:592`).
- **Stranded leases on stop:** drain, stop or a fatal error can abort a long-poll the hub already committed (`index.js:53-54`), stranding leased items until expiry.
- **Clock skew:** a node clock behind the hub's lets work keep running after the hub expired its lease (`node.js:161`).
- **Event log exposure:** the hub copies the whole executor result `data` into the global event log (`hub.js:513`) with no allowlist. Whether that leaks anything depends on what `factory-t3` returns.
- **Unbounded fan-out:** chained planners can multiply work items, up to 100 per level, with no cap per run.
- **Stale metrics:** metrics can count an assignment leased before the window as waiting, which feeds the `no-capacity` bottleneck rule.

## Checked and held up

- **Lease fencing:** machine, attempt and expiry are checked atomically for renew and events, cross-machine access returns `409 lease_lost`, and stale results are fenced off.
- **Retries:** `retryOf` and `notBefore` are honoured.
- **IDs:** engine IDs can't collide across runs or with architect and delivery IDs.
- **Drafts:** agent-authored drafts never run without activation. Planner output reaches work items only as title and body.
- **Git, gh and the CI runner:** commands use argv without a shell, refs are checked with `check-ref-format`, SHAs are regex-checked, there's no force refspec, values starting with `-` and `ext::` URLs are rejected, and error messages don't carry subprocess output or tokens.
- **Secrets and service files:** secret files are written owner-only with exclusive create and no-follow reads, plist and systemd values are escaped, the installer quotes its variables and runs with `set -eu`, and enrollment replay returns the same identity without persisting tokens.
