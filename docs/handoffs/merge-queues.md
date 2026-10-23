# Configurable merge queues handoff

Worker C of the 2026-10-23 factory wave. Based on main `4316b1d`. Nothing pushed; no real GitHub repository, remote or live machine was touched. All Git work in tests uses temporary local bare repositories.

## What exists

**Project configuration.** Each project has a versioned hub document of named queues (`GET/PUT /projects/:id/merge-queues`, `baseVersion` for optimistic concurrency, last 20 versions kept). A `.perpeto/merge-queue.json` committed on the default branch overrides it per queue name and top-level field. An invalid file, alone or combined with the hub document, is reported (`repo.errors`, `repo.error`) and not applied. Validation lives in `packages/delivery/src/queue-config.js`, shared by the hub, the CLI and the web editor (browser-safe, with a `.d.ts`). Example: `config/merge-queue.example.json`.

**Per queue:** target branch globs, `serial|batch|speculative` (with `maxBatchSize`, `depth`), required checks by name, merge method, publication, priority lanes matched by label or head-branch pattern, freeze windows (five-field UTC cron plus duration, or a date range) and manual freeze, `maxInFlight`, `flakyRetries`, `bisectOnBatchFailure`, `autoRebaseOnConflict`, `ejectAfterMinutes`, `requiredApprovals`.

**Queue logic (`packages/delivery`).** All optional and absent by default, so queues without a policy keep their exact configuration hash and FIFO behaviour:
- Lanes order queued entries by priority, FIFO within a lane. Owners can move an entry to a lane, or send it to the back.
- Freezes stop new attempts and hold tested work before publication.
- Flaky retry reruns CI on the same candidate revision before rejecting.
- Bisection can be turned off, so a failed batch rejects every member.
- Timeouts eject entries that are waiting or testing, but never one that is publishing.
- Speculative attempts are prepared on the candidate ahead of them, so publication stays a fast-forward. Only the head's verdict counts. A failed or changed head discards the stack, and a speculative conflict waits blocked until it reaches the head.
- Rejections carry a `cause` (`ci`, `conflict`, `head-changed`, `timeout`, `manual`, `approvals`, `other`). Attempt history and `queueView`/`queueMetrics` provide the live view, ETA and metrics.

Owner commands (freeze, unfreeze, prioritize, eject, requeue) commit without the worker lease. A step that races one finds its attempt gone and stops quietly.

**Hub.** `apps/hub/src/merge-queues.js` handles the routes, settings document, repository file reading (cached, 10 s), named-queue resolution and owner commands. A workflow node with `config.queue: 'main'` uses the named queue. The engine schema accepts it in place of inline `strategy`/`method`, and inline nodes behave as before. Named queues map to one delivery queue per base branch and CI recipe, reconfigured in place when settings or the file change. Freezes persist on the named queue and apply to new delivery queues too. Required approvals count passing review-gate assignments for the work item at admission. `autoRebaseOnConflict: false` reports conflicts to the run as plain rejections. Events: `merge-queue.config-updated|frozen|unfrozen`, `merge-entry.prioritized|ejected|requeued`. `HubError` gained optional `details`, serialized as `error.details`.

**CLI.** `perpeto queue [projectId]`, `perpeto queue freeze <queueId> [--reason]`, `perpeto queue unfreeze <queueId>`, `perpeto queue config validate <file>` (offline, exit 1 with JSON paths).

**Web.** The merge queue screen now has:
- a queue picker and a freeze banner
- a live card showing what is in flight, with the next ETA
- throughput metrics (more behind a disclosure)
- entries in merge order with lane, status, ETA and an actions menu
- recent outcomes and the repository file status
- a settings dialog that edits every field, with inline errors from the shared validator and the hub's `details`

Hubs without the routes get the old flat list. Demo data is in `apps/web/src/api/merge-queue-fixtures.ts`. Screenshots are in `apps/web/screenshots/merge-queues/` (light and dark: main, frozen release, settings, settings with errors), and `merge-queue-{desktop,mobile}.png` were refreshed.

**Apple.** `MergeQueueScreen.swift` mirrors the web screen. The settings sheet edits strategy, sizes, gates, retries and toggles, with inline errors from the same rules. Lanes and freeze windows are shown read-only (edit them on the web or in the file). Demo data is `DemoMergeQueues`. Screenshots: `apps/apple/screenshots/merge-queues/`.

## Verification

Node v24.22.0, macOS:

| Command | Result |
| --- | --- |
| `npm test` (root) | 652 passed, 0 failed |
| `node --test packages/delivery/test/queue-policy.test.js` | 20 tests: config validation, precedence, globs and cron, lanes, freeze (manual and window, fake clock), flaky retry, bisect off, timeouts, owner commands without the lease, speculative (in-memory and real bare repo), reconfigure, metrics, ETA |
| `node --test apps/hub/test/merge-queues.test.js` | 3 integration tests on a real hub: settings, repository file, named-queue admission, freeze, lanes, eject, metrics, approvals, workflow queues |
| `node --test apps/cli/test/queue.test.js` | 3 tests |
| `cd apps/web && npx vitest run && npx tsc --noEmit` | 144 passed, typecheck clean |
| `cd apps/apple && swift test` | 117 passed |

Existing delivery, hub delivery and e2e merge queue tests (`tests/e2e/test/hub-wiring.test.js`, `remote-ci.test.js`, `build-run.test.js`) pass unchanged.

## Not verified, and limits

- Repository file reading for GitHub projects uses the hub's candidate mirror at its last fetch. Only local repositories were tested.
- Speculative queues on GitHub: the mirror now skips fetching commits it already holds (needed for stacked candidates). They were not run against GitHub. Native `github-merge-queue` publication still requires serial.
- Required checks name CI pipelines by string. Today a name must match a workflow `ci` node id or a step name. Worker D's pipelines are not wired here, so an unknown name fails closed (the attempt is rejected as CI).
- Requeue applies to open entries only. A rejected entry has already returned to its run (rebase or fail route), so it cannot be requeued.
- Lanes match work item `labels` and head branch. The engine does not set labels on work items yet, so in practice lanes match branches or manual moves.
- Approvals count review passes in the run for the work item, not per head revision.
- ETA is a simple estimate from the median of recent attempt durations.
- The Apple editor does not edit lanes or freeze windows.
