# Accounts

A dependency-free, per-machine account pool for Node 24. Credentials remain on the execution machine. `snapshot()` returns the architecture's `Account[]` allowlist for node heartbeats. No credentials, credential fingerprints, local paths, usage payloads or source profiles appear in that snapshot.

**Provider terms:** rotating consumer subscriptions may be restricted by provider terms. Perpeto documents this capability and its limits rather than encouraging circumvention. Operators are responsible for choosing permitted account arrangements. This package does not bypass limits, redeem reset credits, disguise clients or make inference requests.

## Configuration and API

Read non-secret options from [accounts.example.json](../../config/accounts.example.json). The node data directory must be absolute, owned by the running user, and mode `0700`. This implementation requires POSIX ownership/mode semantics and fails closed on unsupported platforms.

```js
import { readFileSync } from 'node:fs';
import { AccountPool } from './src/index.js';

const options = JSON.parse(readFileSync('/path/to/accounts.json', 'utf8'));
const pool = new AccountPool(options);

// Explicit, same-machine, user-authorized enrollment only. No automatic discovery.
// Supply your own private file-backed source. Do not use this example on real
// accounts merely to test the package; its tests generate synthetic homes.
const account = pool.importAccount({
  provider: 'codex',
  label: 'Build account',
  source: { kind: 'provider-home', homePath: '/absolute/private/login-home' },
  idempotencyKey: 'enroll-build-account',
});

const { account: selected, binding } = pool.select({
  provider: 'codex', assignmentId: 'asg_example', idempotencyKey: 'reserve-example',
});
// Local T3 integration registers binding.mutation and uses its instance ID.
// It must recheck pool.bindingFor(selected.id) immediately before launch.
// ...execute through T3...
pool.release({ assignmentId: 'asg_example', idempotencyKey: 'release-example' });
const heartbeatAccounts = pool.snapshot();
```

All methods are synchronous. Every mutation requires a stable `idempotencyKey`. Within receipt retention, the same key and same request returns the recorded result; a changed request fails with `IDEMPOTENCY_CONFLICT`. Observation receipts retain only a digest of the request plus sanitized status, never the raw error/usage message. Selection retries additionally recheck the reservation and current account eligibility, so an old result cannot resurrect a released, disabled, invalid or cooling account.

- `importAccount({ provider, label, source, id?, idempotencyKey })`: fresh isolated home, generated `acct_…` ID unless supplied. Never overwrites an existing ID/home.
- `select({ provider, assignmentId, idempotencyKey })`: returns `{ account, binding }`, or throws `NO_ELIGIBLE_ACCOUNT`. Reserves capacity atomically. Reusing an active assignment returns its existing account.
- `release({ assignmentId, idempotencyKey })`: frees its reservation. Always release in the executor's `finally`, including failures/cancellations. A retry attempt after release needs a new selection key.
- `observe({ accountId, message, idempotencyKey })`: merges sparse usage windows, cools on observed limits, marks invalid on authentication failure. Raw messages are not retained. A limit never enables a disabled/invalid account.
- `disable({ accountId, idempotencyKey })` / `enable(…)`: manual eligibility. Enabling retains authentication invalidity and any cooldown.
- `markAuthenticated({ accountId, idempotencyKey })`: clear invalidity only after externally confirmed, account-specific reauthentication. This checks file safety, not the provider's acceptance of credentials; it never performs login.
- `snapshot()`: detached `Account[]`, with expired cooldowns reflected as active. Returns future `cooldownUntil` even when disabled/invalid takes precedence.
- `bindingFor(accountId)`: eligibility/file-safety check and local-only T3 descriptor. Never include this descriptor in a heartbeat or send it to the hub.

`selection: "lru"` is the default. A persisted sequence breaks same-millisecond ties. `"headroom"` first chooses the account with the greatest minimum remaining percentage across known windows, then LRU. Missing usage is treated as unknown/full headroom; no quota probe occurs. Expired usage windows stop reducing headroom. `maxConcurrentPerAccount` defaults to 1 and is independent of the node's overall agent capacity.

## Import design

Only **copy enrollment** is implemented. Referencing a mutable ccswap/global login from a running account home would let an external switch change its identity. Perpeto instead copies explicit local sources into `nodeDataDir/accounts/<provider>/<accountId>/`, mode `0700`, with files `0600`. The source is never written, linked, switched, refreshed or automatically rediscovered. Import behavior has been exercised against fixture directories only.

Supported sources:

| Source | Credential file | Additional behavior |
| --- | --- | --- |
| `{ kind: "provider-home", homePath }`, Codex | `<homePath>/auth.json` | Creates a minimal `config.toml` with `cli_auth_credentials_store = "file"` |
| `{ kind: "provider-home", homePath, accountConfigPath? }`, Claude | `<homePath>/.credentials.json` | Optionally copies only `oauthAccount` and `hasCompletedOnboarding` from the explicit account config |
| `{ kind: "ccswap", storePath, slot }`, Codex | `<storePath>/codex/credentials/account-<slot>.json` | Reads slot from `codex/sequence.json`; preserves its disabled flag |
| `{ kind: "ccswap", storePath, slot }`, Claude | `<storePath>/credentials/.creds-<slot>-<email>.enc` | Reads email/disabled from `sequence.json`; decodes base64; selects identity fields from `configs/.claude-config-<slot>-<email>.json` |

`ccswap` store paths must be explicit. Its installed source resolves macOS to `~/.claude-swap-backup` and Linux to `$XDG_DATA_HOME/claude-swap` (default `~/.local/share/claude-swap`). These are source-study observations, not directories this package reads automatically. Its `.enc` files are base64, **not encryption**. Read `ccswap help`, `claude_swap/paths.py`, `credentials.py` (`_backup_enc_path`, `_read_account_credentials`), `codex.py` (`_credential_path`) and `session.py` (`session_dir_for`) for the implementation studied here. Perpeto never invokes ccswap, including its switch/add/remove commands.

A file-backed ccswap session profile can also be passed as a `provider-home` source. Keychain-only Claude backups and Codex keyring logins are unsupported. Current default Claude identity metadata may live outside `.claude`, so `accountConfigPath` is explicit; no user-wide config is copied wholesale. API-key Codex auth files are accepted, but Claude imports currently require `claudeAiOauth.accessToken`.

Sources require private files/directories. Symlinks at checked directories/files and multiply linked credential files are refused. Existing unsafe permissions are rejected, not silently repaired. Imported metadata may contain private identity information and stays inside the credential home. Labels are operator-supplied heartbeat metadata and must never contain secrets.

Copied OAuth credentials can become stale, and concurrent use of copied refresh tokens may invalidate a login. No refresh synchronization, subscription-identity deduplication, or live authentication proof is implemented. Enroll each identity deliberately; do not assume separately named copies provide separate quota. No source credentials are copied between machines.

## T3 executor integration

`select().binding` and `bindingFor(id)` return:

```js
{
  accountId: 'acct_example',
  providerInstanceId: 'factory_acct_example',
  instance: {
    driver: 'codex', displayName: 'Build account', enabled: true,
    config: {
      homePath: '/absolute/node/accounts/codex/acct_example',
      setupMode: 'existing', shadowHomePath: ''
    }
  },
  mutation: { operation: 'upsert', instanceId: 'factory_acct_example', instance: /* same config */ {} },
  environment: { CODEX_HOME: '/absolute/node/accounts/codex/acct_example' }
}
```

For Claude, `driver` is `claudeAgent`, `config` contains only `homePath`, and the diagnostic environment key is `CLAUDE_CONFIG_DIR`. Paths are non-secret local configuration, supplied through `config.homePath`; no non-secret process environment settings are needed. The `environment` object describes what T3 will derive; it is not a T3 environment-variable array and should not be assigned directly to `instance.environment`.

The executor must register a stable instance per account via T3's authenticated `server.updateSettings` RPC payload `{ patch: {}, providerInstanceMutation: binding.mutation }`, then await provider readiness and select `binding.providerInstanceId` for the new thread with the assignment's model. Keep registration local. Use the instance mutation rather than replacing the whole provider-instance map. The package produces the descriptor; it does not open an RPC connection or create a thread.

Source references under [vendor/t3code](../../vendor/t3code):

| T3 source | Consumption |
| --- | --- |
| `packages/contracts/src/providerInstance.ts:53` | `ProviderInstanceConfig`, `ProviderInstanceMutation` with `upsert` |
| `packages/contracts/src/settings.ts:556` and `:615` | Codex and Claude driver settings; `homePath` |
| `packages/contracts/src/rpc.ts:755`, `apps/server/src/ws.ts:2377` | Settings mutation RPC routed to `updateProviderInstance` |
| `apps/server/src/serverSettings.ts:139` | Mutation merges/removes one instance |
| `apps/server/src/provider/Drivers/ClaudeHome.ts:30` | `makeClaudeEnvironment` derives `CLAUDE_CONFIG_DIR`, preserving `HOME` |
| `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:9138` | Adapter calls `makeClaudeEnvironment` for that instance |
| `apps/server/src/provider/Drivers/CodexHomeLayout.ts:43` | Empty `shadowHomePath` selects direct, isolated home |
| `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:1512` | App-server subprocess derives `CODEX_HOME` from settings |
| `packages/contracts/src/orchestrationV2.ts:361` | Thread carries `providerInstanceId` separately from model selection |

"Hot swap" means reserving another eligible account for **new work** after a limit. Existing processes retain their account/home. This package does not replay a prompt, transfer conversation history, or move a running T3 session. The executor owns safe retry/reassignment and must not retry side-effecting work blindly. Disabling does not kill existing turns. Recheck `bindingFor` before new launch; local selection cannot make the later T3 RPC atomic with a concurrent disable.

## Signal detection

`detectClaudeSignal(message, { now? })`, `detectCodexSignal(…)`, and `detectProviderSignal(provider, …)` return `null`, `{ kind: "auth-failure" }`, or `{ kind: "rate-limit", cooldownUntil? }`. `now` is epoch milliseconds. Signal output never contains raw provider text.

Claude handling follows `ClaudeAdapterV2.ts:2644`, `:2760`, `:6446`, `:6692` and `provider/claudeUsageLimits.ts:116`: `api_error_status/error_status: 429`, assistant `error: "rate_limit"`, blocked `rate_limit_event.rate_limit_info` and its epoch-second reset, plus the observed nested `rate_limit_error` / `(reset after …)` form. Allowed warnings/overage do not cool accounts, and overload status `529` alone does not count as a subscription limit.

Codex handling follows `CodexAdapterV2.ts:1098`, `:4310`, `:4498`, `:6007` and `provider/codexUsageLimits.ts`: `usageLimitExceeded` / `rateLimitExceeded` codes, native `codexErrorInfo` unions, `account/rateLimits/updated` primary/secondary windows, and T3 normalized `failure.class: "usage_limit"` / `resetAt`. Model-specific `limitId` notifications such as Spark do not overwrite the main subscription windows. Sparse updates merge by window ID; the latest known exhausted-window reset wins.

Normalized T3 `{ windows: [{ id, usedPercent, resetsAt? }] }` updates are accepted for both providers. Raw epoch seconds are converted to ISO UTC; normalized resets are already ISO strings. If no future reset is available, the configured `defaultCooldownMs` applies. A cooldown never shortens due to a later partial update. Helpers recognize known auth codes and status `401`; they cannot infer all future provider errors.

## Durability and limits

The private `registry.json` records metadata, sparse usage windows, reservation IDs and idempotency receipts. Writes use fsync plus an atomic rename. A private `.lock` directory serializes mutations and imports across handles/processes. There are no network calls, dependencies, shell executions or token logs.

`ACCOUNT_POOL_BUSY` is retryable by the node. A crash can leave the lock directory or an unregistered credential home behind; recovery is deliberately manual and must first establish that no writer is active. Never remove a lock merely because it is old. Reservations survive restart, so the node must reconcile them against its durable assignment leases and release terminated work. No automatic timeout, stale-result fencing, account deletion or distributed lock is supplied here. Use local filesystems with reliable atomic rename/permissions semantics.

Receipts are compacted on startup and mutation. Defaults are `receiptRetentionMs: 86400000` (24 hours), `maxReceipts: 512` (configurable from 1 to 1024), and a fixed 1 MiB receipt budget. The first age, count or byte limit ends the retry guarantee; callers must not retry old operation keys after that window. Legacy receipts without timestamps start their retention window at migration and remain subject to both size limits. Startup can recover legacy registries up to 64 MiB; credential-file reads remain capped at 4 MiB. Account metadata and current reservations are preserved during compaction.

Only fixture and local process tests are claimed. No real account enrollment, live authentication, T3 readiness, harness turn, end-to-end node/hub heartbeat, or provider-terms compliance has been verified.

```sh
source ~/.nvm/nvm.sh && nvm use 24
node --test packages/accounts/test/accounts.test.js
npm test -w @perpeto/accounts       # same suite through the workspace script
# Repository checks also discover this package:
npm test
```
