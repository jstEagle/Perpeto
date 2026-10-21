# Wave 3 account fixes

Implemented locally on Node v24.22.0, using synthetic credentials only. No push or merge.

| Finding | Implementation commit |
| --- | --- |
| M11: bounded receipt retention and legacy startup compaction | `fedb1e1` |
| M12: reservation expiry, renewal, reconciliation and explicit pooled exhaustion | `ee3b5ce` |
| M13: skip unhealthy homes and persist quarantine | `4630fcf` |
| L9: explicit machine rebind API | `3567b0e` |
| L11: retain per-window permitted Claude overage | `c34e4ae` |

Every finding received a failing regression before its implementation. The package suite has 28 passing tests, including legacy registry recovery above 4 MiB, receipt churn, lease expiry/replay fencing, renewal/reconciliation after restart, unhealthy candidate fallback, machine rebinding and delayed overage observations. No live account enrollment or harness authentication was tested.

## Required node and executor changes

These files are outside this worker's owned paths and were not changed:

- `apps/node/src/integrations/accounts.js`: preserve `selection.reservation.id`; pass it to `release()` and `bindingFor()`; expose `renewReservation()` to the executor. Keep attempt-qualified assignment IDs. The adapter already propagates the new `ACCOUNT_POOL_EXHAUSTED` error, preventing the previous default-login fallback.
- `packages/t3-executor/src/executor.js`: renew well before `reservation.expiresAt` with a new idempotency key each time; stop the harness on renewal failure. A retry of the same renewal key intentionally does not extend its recorded expiry. The default account lease is five minutes. Existing long-running callers will otherwise outlive the reservation and allow capacity reuse while their harness is still running.
- Node startup: inspect `pool.reservations()` and call `reconcileReservations({ activeReservationIds, idempotencyKey })` against durable attempt ownership before new work. Use an empty list only after establishing that no local attempts remain active; opening a second pool handle must not release another process's reservations.
- Node re-enrollment: open with the old machine identity and explicitly call `rebindMachine({ machineId: newMachineId, idempotencyKey })` before binding the new identity. Rebinding refuses live reservations and preserves private account homes.

## Root suite ownership blocker

After preparing local workspace links, `npm test` has 304 passing tests and one failure. `apps/node/test/accounts-integration.test.js:35` explicitly expects pool exhaustion on a second attempt to return `null`. It now correctly throws `ACCOUNT_POOL_EXHAUSTED`. The node owner must replace that assertion with `assert.rejects(..., { code: 'ACCOUNT_POOL_EXHAUSTED' })`; the following unsupported-provider assertion should continue to expect `null`.

No test was skipped or disabled, and no out-of-scope source/test was changed to obtain a green result. The root suite is not green until that obsolete assertion is updated.
