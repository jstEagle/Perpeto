# Factory accounts handoff

Implemented on `t3/factory-account-pool`, based on the supplied Perpeto foundation. Core implementation commit: `423073944df341adedab75ab099b7ffb29c5c279`. This handoff and the package README are committed separately. No push or merge was performed.

## What exists

- Dependency-free ESM/JSDoc package [`@perpeto/factory-accounts`](../../packages/factory-accounts/README.md), with `AccountPool` / `createAccountPool` exports and a [JSON configuration example](../../config/accounts.example.json).
- Explicit same-machine copy enrollment for file-backed Claude/Codex current homes and ccswap stores. Credentials live only in private Perpeto homes under the node data directory. No source/account-switching commands, Keychain access, global login mutation, or cross-machine credential transfer.
- Durable LRU/headroom selection, assignment reservations, configurable per-account concurrency, idempotency/conflict detection, cooldowns, disable/enable, and invalid authentication state. Selection ties use a persisted sequence. Enabling never clears invalidity/cooldowns.
- `snapshot()` produces the exact architecture `Account[]` fields without local paths, tokens, credential fingerprints, usage payloads, or source profiles.
- `bindingFor()` and `select().binding` return a stable local T3 provider instance, `upsert` mutation and diagnostic launch environment. Codex uses `setupMode: "existing"`, empty `shadowHomePath`, and `config.homePath`; Claude uses `config.homePath`. The README identifies the vendored settings, RPC and adapter sources that consume these fields.
- Sanitized Claude/Codex limit/auth detection, native Codex error unions, sparse usage-window merging, reset handling, and separation of Claude warning/overage/overload/permission signals.
- POSIX ownership/mode enforcement (`0700` directories, `0600` files), symlink/multiply-linked credential rejection, fsync/atomic state writes, and a cross-process mutation lock.

## Verification

Verified on Node `v24.22.0` after `source ~/.nvm/nvm.sh && nvm use 24`:

- `node --test packages/factory-accounts/test/accounts.test.js`: the initial 14-test suite passed; subsequent coverage is included in the root run below.
- Final `npm test`: **39 passed**, including **18 accounts tests**. Tests generate all credential material as synthetic fixture strings. They cover both import layouts, source preservation, permissions, safe errors, snapshots, LRU/headroom, same-millisecond ordering, cooldown expiry/fallback, sparse resets, idempotent retries, restart reservations, disable/auth precedence, independent handles, and competing child processes.
- `git diff --check` and staged whitespace checks passed.
- Read installed `ccswap help` plus its `paths.py`, `credentials.py`, `codex.py` and `session.py`. No real account/store data was read or imported. No switch/add/remove commands were run.
- No vendored runtime, architecture contract, root scripts, or other workers' paths were modified.

These checks do **not** prove live authentication, provider readiness, a real harness turn, node/hub integration, or provider-terms compliance.

## Executor/node integration required

Construct one pool with the node's private data directory and machine ID. All mutations require a stable request `idempotencyKey`; all timestamps returned to callers are ISO UTC strings. Methods are synchronous, so callers can use them directly or await their results.

1. Reserve with `select({ provider: assignment.harness.provider, assignmentId: assignment.id, idempotencyKey })`.
2. Register the returned binding locally through T3's `server.updateSettings` RPC: `{ patch: {}, providerInstanceMutation: binding.mutation }`. Await instance readiness; create the thread using `binding.providerInstanceId` plus the assignment model. The descriptor is **local only** and must not be sent to the hub. Recheck `bindingFor(accountId)` immediately before launch.
3. Feed observed native/normalized errors and usage into `observe({ accountId, message, idempotencyKey })`. Forward only `snapshot()` in account heartbeats. Raw message text is not persisted by this package.
4. Release the reservation in `finally` on completion, failure or cancellation. Release and use a fresh selection key when scheduling a new attempt. Existing account processes are not switched or killed by pool mutations.
5. On node restart, reconcile persisted reservations with durable assignment leases, releasing terminated attempts. Retry `ACCOUNT_POOL_BUSY` with bounded node-side backoff. Translate sanitized `AccountPoolError.code` values to the node's error surface.

## Contract deviations and requests

No shared entity/schema changes are requested. `docs/architecture.md` was not edited. The public heartbeat shape matches `Account`.

Clarify the architecture's “next eligible account takes over” sentence as **new assignment/retry placement**, rather than seamless transfer of a running conversation. This package deliberately does not move T3 sessions between account homes or replay side-effecting work. The executor owns that policy and its verification.

The Account entity does not expose reservations/headroom, which remain node-local. It has no assignment-attempt fencing field. Reconciliation must therefore use node-owned assignment state; a stale observer/release must not be applied to a newer attempt. If the executor reuses assignment IDs across concurrent attempts, key its local reservation by an attempt-qualified ID and release that exact reservation.

## Known gaps

- No live harness/T3 execution or import from real account state. Account auth JSON is structurally checked, not authenticated with the provider.
- Keychain-only Claude and Codex keyring imports unsupported. Claude API-key enrollment unsupported. File-backed imports only; no automatic provider discovery, credential rotation, login, or refresh synchronization.
- Copied OAuth refresh tokens can become stale or conflict with another login process. Subscription-identity deduplication and quota probing are not implemented. Different local account IDs do not prove separate subscriptions.
- A crash can leave a lock or orphaned private home; recovery is manual after establishing no active writer. Reservations persist until explicitly reconciled/released. No deletion API, automatic reservation expiry or receipt compaction.
- POSIX only. Windows ACL parity and network-filesystem durability have not been implemented or verified.
- Selection is atomic within this local pool, but the subsequent external T3 launch is not atomic with a concurrent disable. Existing turns may continue; the executor must own launch/cancellation coordination.
- Provider terms may restrict consumer-subscription rotation. The README documents this; the implementation does not encourage circumvention or claim authorization from providers.
