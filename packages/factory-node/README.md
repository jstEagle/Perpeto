# Factory node

Dependency-free Node 24 daemon for the [factory node protocol](../../docs/architecture.md#node-protocol). It enrolls a machine, advertises capacity and executable harnesses, leases assignments and CI jobs, renews leases, and reports revision-bound evidence. All inference goes through an executor; this package never calls model APIs.

## Start

Use Node 24.13.1 or newer within Node 24:

```sh
source ~/.nvm/nvm.sh && nvm use 24
node packages/factory-node/bin/perpeto-node.js --config config/node.json
```

Copy [config/node.example.json](../../config/node.example.json) to `config/node.json`. Set `hubUrl`, `dataDir`, name, labels, and capacity. Paths in node JSON resolve relative to that JSON file. The daemon appends `/api/v1` to `hubUrl`. Remote hubs require HTTPS unless `allowInsecureHttp` explicitly permits HTTP.

Supply the hub's one-time code in the configured `enrollmentCodeFile`, an owner-only regular file, mode `600`. Do not put codes, tokens, or account credentials in configuration, arguments, or logs. The daemon persists its enrollment retry key and then `{ machineId, token }` in `credentialFile`, also mode `600`, using an atomic rename. A completed enrollment no longer needs the code file. Existing permissive credential files are rejected.

The data directory holds `daemon.lock`, `leases.json`, retained assignment workspaces, and temporary CI clones. Only one daemon may use a data directory. Do not run multiple daemons with copies of the same machine credentials. The lease journal records the highest attempt accepted for each work item before execution; a restart lets a previously accepted attempt expire rather than running it again. Keep this journal with the machine's credentials. It currently grows with the number of distinct work items.

`SIGINT` and `SIGTERM` drain active work before shutting down. Embedders can cancel immediately with `stop({ drain: false })`. Renewals and heartbeats continue while draining. Execution is aborted when a renewal or event reports `409 lease_lost`, or when the last confirmed lease expires, including during a network outage. No stale completion is sent. Reconnection uses capped exponential backoff and stable request idempotency keys.

## Embed and extend

```js
import { createNode } from '@perpeto/factory-node';
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

At startup the daemon imports `@perpeto/factory-t3` by package name if installed. It expects `createT3Executor({ config, runtimeUrl, accountProvider })`, or `createExecutor` with the same arguments, returning an executor. `executorPackages` explicitly overrides the package list. Explicitly configured missing packages and broken installed packages fail startup; absent optional defaults are allowed. Packages must be resolvable by Node from this package; no root workspace manifest or dependency installation was changed here.

The optional `@perpeto/factory-accounts` package should export `createAccountProvider({ config, configRoot })`, returning:

```js
const accounts = {
  async list() { return []; },   // public Account metadata for heartbeats
  async acquire(request) { /* optional executor-owned account selection */ },
  async release(account, result) { /* optional executor-owned release */ },
  async close() { /* optional shutdown */ },
};
```

The daemon owns `list`/`close`; executors own account selection/rotation. `accountProviderPackage` overrides the module, and `accounts` is its non-secret configuration. Heartbeats allow only string values from the contract's Account fields, dropping other properties. Never return credentials as account labels or IDs. Without a package/injected provider, accounts default to an empty list.

Provider discovery checks executable names on PATH: `codex`, `claude`, `gemini`, `opencode`, `amp`, `droid`, `agent` (Cursor), `copilot`, and `pi`. `providers` restricts the detected set. Discovery does not prove authentication, model availability, executor installation, or a successful harness turn.

## CI jobs and logs

A Job needs a full 40- or 64-character Git commit SHA, `configHash`, a repository URL/path (or `{ url, localPath? }`), and named shell steps. Each job clones into a unique `dataDir/jobs/job-*/source`, without local hardlinks, checks out the exact SHA detached, executes steps sequentially, then removes its clone on success, failure, timeout, cancellation, or lease loss. It never checks out a developer's working tree. Passing evidence echoes the submitted `revision` and `configHash`; this runner does not calculate the workflow's configuration hash.

Steps use `/bin/sh -c` on macOS/Linux and `cmd.exe` on Windows. Default step timeout is 600 seconds and checkout timeout is 120 seconds, configurable under `jobs`. A nonzero exit is `failed`; timeout, invalid job, checkout failure, or process-start error is `error`; cancellation is `cancelled`. Later steps stop after the first non-pass. Step events contain status, exit code, timeout flag, timestamps, revision, and config hash. Completed events contain the final status, all step results, revision, config hash, and an empty artifacts array. Artifact upload is not implemented.

Logs use `{ step: index, stream: 'stdout'|'stderr', chunk }`. Chunks are at most `jobs.maxLogChunkBytes` UTF-8 bytes (default 8192, configurable from 128 through 65536). Backpressure bounds pending output. Lines wait for a newline/EOF before redaction, so secrets spanning pipe chunks are never emitted in fragments. A line exceeding the limit is masked in full until the next newline. Output is decoded across UTF-8 boundaries.

Configure non-secret regular expressions in `jobs.redactPatterns`. For exact secret values, reference an owner-only `jobs.redactionFile`, containing `{ "literals": ["private value"] }`; the file path resolves relative to node JSON. Only single-line literal secrets are supported. Redaction applies to job stdout/stderr, not executor result summaries or structured events; adapters must never put credentials there.

CI commands execute with the node user's permissions and environment. These workspaces provide source isolation, not a security sandbox. POSIX cancellation terminates the whole process group; Windows uses `taskkill` for escalation and has not been verified. A hard daemon crash can leave external processes or temporary directories behind; crash-time orphan reaping is not implemented. Executors must cooperate with AbortSignal for assignment abandonment.

## Optional T3 supervision

`runtime: { enabled: true, repoRoot: "..", url: "http://127.0.0.1:4310" }` starts `node scripts/runtime.mjs start` from the configured checkout. That existing launcher reads `config/perpeto.json`; match its port to `runtime.url`. Setup/build must already be completed. The node suppresses runtime stdout/stderr because the inherited launcher can print pairing credentials. Readiness checks the loopback URL; the supervisor stops its process group on shutdown. An unmanaged runtime can instead use `enabled: false` plus `url`.

The injectable supervisor interface is `{ start(): Promise<string|undefined>, stop(): Promise<void> }`. The URL returned by `start()` reaches executors as `ctx.runtimeUrl`. Lifecycle and URL propagation are verified with stubs; this package's tests do not start the actual T3 server or verify pairing/authentication.

## Protocol integration notes

No changes were made to `docs/architecture.md`. The following details should be fixed there and checked against the parallel hub implementation:

- Requests add the global `idempotencyKey`. Renewals and events also add top-level `attempt` so the hub can reject stale work, including reassignment to the same machine. Hub implementations must validate that attempt atomically; the node cannot fence stale results by itself.
- Canonical lease response accepted here is `{ assignments: Assignment[], jobs: Job[] }`. Also accepted are `{ leases: [{ kind, item }] }` or `{ items: [...] }`, including flat entities and `assignment`/`job` wrappers. Attempts and expiration may be on the entity or wrapper. Renewal needs `{ leaseExpiresAt }` (or `{ lease: { leaseExpiresAt } }`).
- Each kind has its own capacity-aware poll, with `kinds: ['assignment']` or `['job']`. This avoids overleasing one kind when only the other has capacity.
- Heartbeats add `status: 'online'|'draining'`. A response `status: 'draining'` or `machine.status: 'draining'` also stops new leases. The contract currently leaves heartbeat responses and node-requested drain unspecified.
- There is no hub-to-node cancellation route/event defined. Local cancellation works; remote cancellation needs an explicit hub signal. A `lease_lost` rejection and lease expiry abandon work, without falsely reporting a cancelled result from an obsolete owner.

## Verify

```sh
source ~/.nvm/nvm.sh && nvm use 24
node --test packages/factory-node/test/*.test.js
npm test
```

Tests use an in-process fake hub HTTP server and local bare Git repositories. See [the handoff](../../docs/handoffs/factory-node.md) for executed commands, outcomes, integration requests, and remaining gaps. No live hub, harness, subscription account, or cross-machine run is claimed.
