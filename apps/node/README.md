# Node daemon

Dependency-free Node 24 daemon for the [factory node protocol](../../docs/architecture/README.md#node-protocol). It enrolls a machine, advertises capacity and executable harnesses, leases assignments and CI jobs, renews leases, and reports revision-bound evidence. All inference goes through an executor; this package never calls model APIs.

## Start

Use Node 24.13.1 or newer within Node 24:

```sh
source ~/.nvm/nvm.sh && nvm use 24
node apps/node/bin/perpeto-node.js --config config/node.json
```

Copy [config/node.example.json](../../config/node.example.json) to `config/node.json`. Set `hubUrl`, `dataDir`, name, labels, and capacity. Paths in node JSON resolve relative to that JSON file. The daemon appends `/api/v1` to `hubUrl`. Remote hubs require HTTPS unless `allowInsecureHttp` explicitly permits HTTP.

Supply the hub's one-time code in the configured `enrollmentCodeFile`, an owner-only regular file, mode `600`. Do not put codes, tokens, or account credentials in configuration, arguments, or logs. The daemon persists its enrollment retry key and then `{ machineId, token }` in `credentialFile`, also mode `600`, using an atomic rename. A completed enrollment no longer needs the code file. Existing permissive credential files are rejected.

The data directory holds `daemon.lock`, `leases.json`, and active assignment workspaces. Finished assignment workspaces are removed, so executors must publish durable changes before returning. CI clones use private `perpeto-ci-*` directories under the OS temporary directory, outside node state, and are removed after execution. Locks record PID and process start identity; legacy PID-only locks remain conservative when the PID is alive. Only one daemon may use a data directory. Do not run multiple daemons with copies of the same machine credentials. The lease journal records the highest attempt accepted for each work item before execution; a restart lets a previously accepted attempt expire rather than running it again. Keep this journal with the machine's credentials. A failed write prevents that item from executing, but subsequent leases retry journal persistence. The journal still grows with distinct work items and is rewritten on acceptance. Safe pruning requires a hub replay/tombstone horizon; dropping history now would weaken restart deduplication.

`SIGINT` and `SIGTERM` drain active work before shutting down. Embedders can cancel immediately with `stop({ drain: false })`. Renewals and heartbeats continue while draining. Forced assignment stops report `failure` so engine retries remain available. Heartbeat `cancel` lists abort matching work immediately and send one attempt-fenced `cancelled` event after execution stops, including revision/config hash for jobs. Execution is aborted when a renewal or event reports `409 lease_lost`, or when the last confirmed lease expires, including during a network outage. No stale completion is sent. Reconnection uses capped exponential backoff and stable request idempotency keys.

## Embed and extend

```js
import { createNode } from '@perpeto/node';
const node = await createNode({ configPath: '/path/to/node.json' });
await node.start();
node.drain();                    // stop accepting work; active work continues
await node.stop();               // drain, then stop accounts/runtime
// await node.stop({ drain: false }); // alternatively, cancel active work
```

`node.status` returns state and agent/job counts. `node.error` records fatal background errors. `onStatus` receives state changes; library callers should stop the daemon when state becomes `error`. The CLI handles this automatically. Calls to `start()` are single-use; repeated `stop()` calls share shutdown.

`createNode` also accepts `registry`, `accountProvider`, `runtimeSupervisor`, and `onStatus`. Injected adapters use the same interfaces as dynamically loaded packages.

An executor has the binding contract's shape:

```js
const executor = {
  kind: 't3',
  canRun(assignment, machine) { return machine.providers.includes(assignment.harness.provider); },
  async run(assignment, ctx) {
    // ctx: signal, report({ type, data }), workspace, runtimeUrl, accountProvider
    // MUST honor ctx.signal, stop external work on abort, and await reports.
    return { outcome: 'success', summary: 'Completed.', threadRef: '...' };
  },
};
```

Register executors with `new ExecutorRegistry().register(executor)`; first matching executor wins. The built-in `createFakeExecutor({ delayMs, outcome, summary, usage })` handles provider `fake` and emits configured usage. Setting a `fake` object in node JSON advertises `fake` as a provider. Fake execution is for tests/e2e and does not start a real harness.

At startup the daemon imports `@perpeto/t3-executor` by package name if installed. It expects `createT3Executor({ config, runtimeUrl, accountProvider })`, or `createExecutor` with the same arguments, returning an executor. `executorPackages` explicitly overrides the package list. Explicitly configured missing packages and broken installed packages fail startup; absent optional defaults are allowed. Packages must be resolvable by Node from this package; no root workspace manifest or dependency installation was changed here.

An `accounts` section in node JSON (without `accountProviderPackage`) uses the built-in [@perpeto/accounts adapter](src/integrations/accounts.js). Its non-secret options are the pool's (`selection`, `defaultCooldownMs`, `maxConcurrentPerAccount`, optional `nodeDataDir`, default the node `dataDir`). The pool opens after enrollment via `bind({ machineId })`; `acquire({ provider, assignmentId, attempt })` reserves per attempt and returns `{ account, binding, reservation? }` or `null`, and `release(selection, { assignmentId, attempt, reservationId })` frees it. The reservation-enabled pool throws `ACCOUNT_POOL_EXHAUSTED` when enrolled accounts are busy/cooling/disabled; that error propagates and must never trigger default-login fallback. Bindings stay local; heartbeats carry only `snapshot()` metadata. Operator-chosen account IDs are machine-scoped on the wire; existing pool-generated UUID IDs retain their global identity for client compatibility and are machine-scoped if the hub reports a conflict. Usage events use the same public ID. Local IDs and reservation tokens stay unchanged. Snapshot failures reuse the last accepted metadata or omit accounts; account-related heartbeat 400/409 responses fall back to a heartbeat without accounts so running work and cancellation delivery survive.

A custom account package should export `createAccountProvider({ config, configRoot, dataDir })`, returning:

```js
const accounts = {
  async list() { return []; },   // public Account metadata for heartbeats
  async acquire(request) { /* optional executor-owned account selection */ },
  async release(account, result) { /* optional executor-owned release */ },
  async close() { /* optional shutdown */ },
};
```

The daemon owns `list`/`close`; executors own account selection/rotation.

The built-in adapter also exposes `renewReservation({ assignmentId, attempt, reservationId, idempotencyKey })`, returning the pool's `{ id, assignmentId, accountId, expiresAt }` receipt. Pool assignment IDs remain attempt-qualified. The executor must retain `selection.reservation.id`, use a fresh renewal key each tick, and cancel work on renewal loss. It forwards `reservationId` on `observe`, `release(selection, { assignmentId, attempt, reservationId, result })`, and `bindingFor(accountId, { reservationId })`. Release can recover the token from `selection.reservation.id`; it never replaces a token after renewal. Renewal requires the account pool's reservation-lease API. This worktree's older pool lacks that method. Forwarding is regression-tested with a stub; acquire, repeated renewal, token fencing, observe and release also passed against an isolated snapshot of merged accounts commit `502ec85`. No accounts-package files were changed here.

`accountProviderPackage` overrides the module, and `accounts` is its non-secret configuration. Heartbeats allow only string values from the contract's Account fields, dropping other properties. Never return credentials as account labels or IDs. Without a package/injected provider, accounts default to an empty list.

Provider discovery checks executable names on PATH: `codex`, `claude`, `gemini`, `opencode`, `amp`, `droid`, `agent` (Cursor), `copilot`, and `pi`. `providers` restricts the detected set. Advertisement intersects discovery with the installed registry's `canRun` result. An unexpected lease with no matching executor fails for retry instead of parking on a human. Discovery does not prove authentication, model availability, runtime connectivity, or a successful harness turn.

## CI jobs and logs

A Job needs a full 40- or 64-character Git commit SHA, `configHash`, a repository URL/path (or `{ url, localPath? }`), and named shell steps. Each job clones into a unique OS-temporary `perpeto-ci-*/source`, without local hardlinks, checks out the exact SHA detached, executes steps sequentially, then removes its clone on success, failure, timeout, cancellation, or lease loss. It never checks out a developer's working tree. Passing evidence echoes the submitted `revision` and `configHash`; this runner does not calculate the workflow's configuration hash.

Steps use `/bin/sh -c` inside the platform sandbox. macOS requires `/usr/bin/sandbox-exec`; Linux requires `/usr/bin/bwrap` and permitted user namespaces. Windows and hosts without a usable sandbox fail closed without running steps. macOS has been tested locally; the Linux sandbox and Windows fail-closed path have not been exercised on their respective hosts. Default step timeout is 600 seconds and checkout timeout is 120 seconds, configurable under `jobs`. A nonzero exit is `failed`; timeout, invalid job, checkout failure, or process-start error is `error`; cancellation is `cancelled`. Later steps stop after the first non-pass. Step events contain status, exit code, timeout flag, timestamps, revision, and config hash. Completed events contain the final status, all step results, revision, config hash, and an empty artifacts array. Artifact upload is not implemented.

Logs use `{ step: index, stream: 'stdout'|'stderr', chunk }`. Chunks are at most `jobs.maxLogChunkBytes` UTF-8 bytes (default 8192, configurable from 128 through 65536). Redacted lines are batched per step/stream until the size limit or 100 ms, then sent through the existing `/jobs/:id/events` route. EOF flushes remaining output before the step event; delivery failures propagate. Backpressure bounds pending output. Lines wait for a newline/EOF before redaction, so secrets spanning pipe chunks are never emitted in fragments. A line exceeding the limit is masked in full until the next newline. Output is decoded across UTF-8 boundaries.

The enrolled node token is always added to literal redaction. Configure non-secret regular expressions in `jobs.redactPatterns`. For exact secret values, reference an owner-only `jobs.redactionFile`, containing `{ "literals": ["private value"] }`; the file path resolves relative to node JSON. Only single-line literal secrets are supported. Redaction applies to job stdout/stderr, not executor result summaries or structured events; adapters must never put credentials there.

CI commands inherit no daemon environment. Their environment contains only a configured/system `PATH`, fresh job `HOME` and temporary-directory paths, locale, and noninteractive Git flags. Set non-secret `jobs.path` to an array of tool directories if needed; paths resolve relative to node JSON. Git checkout uses the same base environment plus the daemon's `GIT_CONFIG_GLOBAL` when set, preserving trusted remote rewrites. That config file is protected from steps; the variable is never passed to them. Ambient default-home logins remain unavailable.

The sandbox denies reading/writing node state, configured machine/enrollment/redaction files, account storage, known T3 state and common credential directories, including canonical symlink targets. Add custom adapter secret locations under `jobs.protectedPaths`, an array resolved relative to node JSON. macOS additionally restricts inspecting/signalling other processes; Linux uses a PID namespace, masks protected paths, and mounts the host filesystem read-only. A protected path overlapping the temporary workspace fails the job.

Residual risk: these are local filesystem/process restrictions, not hostile multi-tenant isolation. macOS otherwise retains the node user's filesystem permissions; both platforms allow network access. Unknown secret locations, other same-user services/IPC, privileged helpers, OS vulnerabilities, and hardlink aliases of secrets outside protected directories need stronger isolation or an isolated worker account/VM. Exact-value redaction cannot contain transformed or out-of-band exfiltration. The hub still needs random per-machine tokens and owner-authorized revoke/rotate routes; this package cannot revoke an already exposed token. POSIX cancellation terminates the whole process group; Windows uses `taskkill` for escalation and has not been verified. On shell exit the timeout stops, remaining process-group children are terminated, and inherited pipes are closed after a bounded grace period. Log delivery can finish afterward without turning a completed shell into a timeout. A hard daemon crash can leave external processes or temporary directories behind; crash-time orphan reaping is not implemented. Executors must cooperate with AbortSignal for assignment abandonment.

## Optional T3 supervision

`runtime: { enabled: true, repoRoot: "..", url: "http://127.0.0.1:4310" }` starts `node scripts/runtime.mjs start` from the configured checkout. That existing launcher reads `config/perpeto.json`; match its port to `runtime.url`. Setup/build must already be completed. The node suppresses runtime stdout/stderr because the inherited launcher can print pairing credentials. Readiness checks the loopback URL; the supervisor stops its process group on shutdown. An unmanaged runtime can instead use `enabled: false` plus `url`.

The injectable supervisor interface is `{ start(): Promise<string|undefined>, stop(): Promise<void> }`. The URL returned by `start()` reaches executors as `ctx.runtimeUrl`. Lifecycle and URL propagation are verified with stubs; this package's tests do not start the actual T3 server or verify pairing/authentication.

## Protocol integration notes

The binding contract is [the architecture node protocol](../../docs/architecture/README.md#node-protocol). No architecture or hub files were changed. The node implements these details and leaves the listed cross-package follow-ups:

- Requests add the global `idempotencyKey`. Renewals and events also add top-level `attempt` so the hub can reject stale work, including reassignment to the same machine. Hub implementations must validate that attempt atomically; the node cannot fence stale results by itself.
- Canonical lease response accepted here is `{ assignments: Assignment[], jobs: Job[] }`. Also accepted are `{ leases: [{ kind, item }] }` or `{ items: [...] }`, including flat entities and `assignment`/`job` wrappers. Attempts and expiration may be on the entity or wrapper. Renewal needs `{ leaseExpiresAt }` (or `{ lease: { leaseExpiresAt } }`).
- Each kind has its own capacity-aware poll, with `kinds: ['assignment']` or `['job']`. This avoids overleasing one kind when only the other has capacity.
- Heartbeats add `status: 'online'|'draining'`. A response `status: 'draining'` or `machine.status: 'draining'` also stops new leases. Heartbeat cancellation responses follow the binding contract below.
- Heartbeat cancellation uses the binding contract's `cancel: { assignments, jobs }` response and attempt-fenced `cancelled` event, supported by the current hub's acknowledgement path. Lease loss/expiry still suppresses stale results.
- M9 remains partially addressed: heartbeats send current labels, and incompatible/over-capacity leases receive fenced failure/error events to free their slots where possible. The hub currently ignores updated labels. Request a fenced lease-release route that requeues without consuming an attempt, and hub label refresh. Already-seen/active duplicate attempts are suppressed to avoid finalising running work. Network-lost long-poll responses cannot be released without a hub acknowledgement/reconciliation protocol.
- H6 follow-up: owner-only node token revocation/rotation and random per-machine token issuance belong to the hub. No hub or architecture files were changed.
- L10 follow-up: agree a durable hub replay horizon or terminal tombstone protocol before pruning the node journal. Assignment workspace cleanup is implemented; journal retention remains open.

## Verify

```sh
source ~/.nvm/nvm.sh && nvm use 24
node --test apps/node/test/*.test.js
npm test -w @perpeto/node       # same suite through the workspace script
npm test
```

Tests use an in-process fake hub HTTP server and local bare Git repositories. See [the handoff](../../docs/handoffs/factory-node.md) for executed commands, outcomes, integration requests, and remaining gaps. The Node 24.22.0 root `npm test` passed 315 tests after these changes, including local real-hub publishing e2e flows; the node suite contributes 48 tests. Regression scenarios were run failing before their fixes. The account adapter suite additionally passed against an isolated merged accounts `502ec85` snapshot. No live harness, real subscription account, or cross-machine run is claimed.
