# Factory node handoff

Owner: factory-node implementation worker, Bernard Cayley (gpt-6.1-sol). Date: 21 October 2026. Branch: `t3/factory-node-daemon`. Base: `e02784f`. All changes are restricted to `packages/factory-node/**`, `config/node.example.json`, and this handoff.

## Implemented

- Dependency-free ESM package `@perpeto/factory-node`, `bin/perpeto-node.js`, and async `createNode({ configPath })` API. File-based non-secret configuration with TLS default for remote hubs. Owner-only code/credential files; atomic private machine-token persistence and retry-stable enrollment. Data-directory lock with serialized stale-lock recovery.
- PATH executable detection, OS/architecture/labels, 10-second default heartbeats reporting capacity/running/public account metadata, independent capacity-limited long polls for assignments/jobs, periodic lease renewal, local confirmed-expiry watchdog, reconnect backoff, stable request idempotency keys, attempt journal preventing a repeat of an accepted lease after restart, drain and cancellation shutdown. `lease_lost` aborts execution and suppresses obsolete results.
- Executor registry and configurable fake executor (delay/outcome/usage), plus package-name loading of optional T3/account integrations and injectable interfaces. No direct inference API calls. `src/executors.js` and the package README define integration factories and lifecycle responsibilities.
- CI clones a local/remote repository into a unique per-job directory, checks out the exact full SHA, runs shell steps with bounded/redacted UTF-8 output, timeouts and cancellation, emits step evidence, returns status bound to `revision` and `configHash`, and removes the clone. Local bare-Git tests verify the selected older commit while the source checkout stays at a newer commit.
- Optional supervisor starts/stops the repo's `scripts/runtime.mjs start`, refuses an already occupied URL, suppresses potentially sensitive launcher output, and forwards the runtime URL to executors. Both the injectable lifecycle and a stub launcher process are tested.

## Verification

Executed on macOS with Node `v24.22.0`, selected before every Node/npm command using `source ~/.nvm/nvm.sh && nvm use 24`.

- `node --test packages/factory-node/test/*.test.js`: 26 tests passed, 0 failed.
- `npm test`: 47 tests passed, 0 failed, including the new package and existing client/core/launcher tests.
- `git diff --check`: passed.
- Local Markdown relative links and example JSON were checked. CLI usage failure was checked to exit `1` without printing credentials.

Test evidence covers enrollment response loss/retry and restart, owner-only credential enforcement, heartbeat/account allowlisting, capacity/duplicate attempt handling, renewals, `lease_lost`, confirmed lease expiry during renew outage, hub outage/recovery, graceful drain, forced cancellation, restart journal, runtime/context interfaces, executable discovery, explicit missing modules, invalid config, concurrent stale-lock recovery, and lost lease response retry.

CI evidence covers pass, failure, timeout/process-group termination, cancellation, inaccessible/moving revision rejection, exact SHA checkout, revision/config-hash step/final evidence, cleanup, redaction across pipe chunks, oversized lines, UTF-8 boundaries, bounded chunk size, job lease capacity, and process abandonment/cleanup after lease loss.

## Contract requests and integration points

No architecture contract was edited. The binding document should specify the following before live hub integration:

1. Add top-level `attempt` to renew/event request bodies, validated atomically with machine ownership and live expiry. The node sends it alongside the global `idempotencyKey`. A machine token alone cannot fence a previous attempt reassigned to the same machine.
2. Fix the lease response envelope. Canonical support here is `{ assignments: [...], jobs: [...] }`; `{ leases: [...] }` and `{ items: [...] }` containing `{ kind, item }`, flat entities, or `assignment`/`job` wrappers are also accepted. Each accepted item must include `attempt` and `leaseExpiresAt`. Renewal must return `{ leaseExpiresAt }` or `{ lease: { leaseExpiresAt } }`; missing confirmation abandons work.
3. Define drain reporting/response. This node adds heartbeat `status: 'online'|'draining'` and respects response `status: 'draining'` or `machine.status: 'draining'`. The existing heartbeat body/table does not define these fields.
4. Define remote cancellation. No hub cancellation message/route appears in the current node protocol; local cancellation and lost-lease cancellation work.
5. Confirm integration factories with parallel workers: `@perpeto/factory-t3` exports `createT3Executor` or `createExecutor({ config, runtimeUrl, accountProvider })`; `@perpeto/factory-accounts` exports `createAccountProvider({ config, configRoot })` with async `list()` and optional `close()`. Account acquire/release are executor-owned. See README for full interfaces.

## Remaining and verification limits

- No live parallel hub, actual T3 runtime, authenticated harness, real subscription pool, remote Git transport, second machine, hosted CI, or full factory workflow was exercised. Default integration packages are optional; the root package/dependency manifests were outside this worker's ownership and were not changed. Ensure the packages are resolvable by name when composing the factory.
- Confirm T3 launcher port in `config/perpeto.json` matches node `runtime.url`. The actual launcher's build/setup and authentication are separate prerequisites. Runtime readiness proves an HTTP response, not an authenticated T3 session.
- Windows paths exist but process-tree termination and shell behavior are unverified. The tests run POSIX commands on macOS.
- Commands run with the node user's environment/permissions. A fresh clone is not a sandbox. Redaction protects configured single-line literals/regex matches in CI output; structured executor events/results must never carry credentials.
- Assignment executors must honor AbortSignal and await reporting. CI processes and clones are cleaned during normal completion/cancellation/lease loss. Hard daemon termination can leave external processes or temporary directories; orphan reaping/recovery is not implemented.
- Assignment workspaces are retained for executor-owned recovery/cleanup. Lease journal retention is currently unbounded. A crash during stale-lock recovery may leave `daemon-recovery.lock`; it fails closed and requires operator inspection/removal.
- Artifact upload, submodule/LFS checkout, repository caches, local config-hash calculation, and remote cancellation are not implemented. Empty artifact lists and the submitted config hash are returned honestly.
