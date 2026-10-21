# T3 executor

Node executor that runs factory assignments through a local T3 environment server. It is dependency-free ESM for Node 24. All inference goes through T3 and its harnesses; this package never calls a model API.

```js
import { createT3Executor } from '@perpeto/t3-executor';
const executor = createT3Executor({ config, runtimeUrl, accountProvider });
// { kind: 't3', canRun(assignment, machine), run(assignment, ctx), close() }
```

`@perpeto/node` loads it by package name (the default `executorPackages` entry); the root npm workspaces link it. A node outside this checkout can list an absolute module path instead, for example `"executorPackages": ["/path/Perpeto/packages/t3-executor/src/index.js"]`.

## Configuration

The node passes its `runtime` section as `config`. Executor settings can sit at the top level or under `runtime.t3`. Everything here is non-secret.

| Key | Default | Meaning |
| --- | --- | --- |
| `url` | node `runtimeUrl`, else host and port from `repoRoot/config/perpeto.json` | T3 server origin |
| `credentialFile` | none | Owner-only (mode 600) file holding one T3 session token |
| `repoRoot`, `serverEntry`, `baseDir` | derived from `repoRoot` | Without `credentialFile`, the executor mints a short-lived session with T3's own CLI. It keeps the token in memory only. |
| `tokenTtl` | `12h` | Lifetime of minted sessions. On a 401 the executor mints a fresh one and retries. |
| `runtimeMode` | `full-access` | T3 runtime mode. This is T3's default and suits unattended work. `harness.options.runtimeMode` overrides it per assignment. |
| `onRuntimeRequest` | `interrupt` | When an agent asks for approval or input: `interrupt` the run and return `blocked`, or `leave` it pending for a person in T3 |
| `onNativeSubagentViolation` | `interrupt` | `interrupt` or `report` |
| `publishBranch` | `true` | Push new commits on the work branch to `origin`, without force |
| `turnTimeoutMs` | 4 hours | Assignment time limit |
| `settleMs`, `pollMs`, `accountReadyTimeoutMs` | 2000, 1000, 60000 | Timing |

A minted session gets `orchestration:read`, `orchestration:operate` and `providers:manage`. The last one is needed to register account instances.

## What `run(assignment, ctx)` does

1. **Account.** If the node supplies an account provider (`ctx.accountProvider` or the factory argument), the executor:
   - reserves an account with `acquire({ provider, assignmentId, attempt })`;
   - registers the binding with `server.updateSettings { patch: {}, providerInstanceMutation }`;
   - waits until that instance is `ready`, then rechecks `bindingFor(accountId, { reservationId })` just before launch;
   - renews its reservation halfway through each confirmed lease, throughout setup, the turn and cancellation cleanup. The default pool lease is five minutes. Each renewal has a fresh idempotency key; if renewal hangs, a separate deadline cancels work after three quarters of the confirmed lifetime, leaving time for interrupt cleanup before expiry.

   It sends every provider failure to `observe`, so the pool decides between rate-limit cooldown and auth invalidation. Binding checks, observations and release carry the selected reservation token. It always stops renewal and releases the reservation in `finally`. Renewal loss interrupts followed root and child runs and returns an assignment `failure`. `ACCOUNT_POOL_EXHAUSTED` also returns `failure` with a retry-with-backoff summary and never selects the operator's default login. With no enrolled accounts or no pool support (`acquire` returns `null`), it uses a ready instance of the harness's driver.
2. **Workspace from `assignment.repo`.**
   - A local working checkout (`localPath`) gets a T3-managed worktree on the work branch. An existing branch or worktree is reused.
   - Otherwise the executor clones `url` (or a bare `localPath`) into `ctx.workspace/repo`, starting from `origin/<branch>` when an earlier attempt published it.
   - The work branch is `assignment.branch`, then `workItem.branch`, then `perpeto/<workItemId>`.
3. **Thread.** The executor finds or creates the T3 project for the workspace root (T3 allows one project per root). It attaches the `AgentPolicy` to a deterministic thread ID, then launches the thread with the prompt.
   - The prompt is the assignment prompt plus project goals, docs, the work item, subagent limits and, for structured roles, the answer format.
   - IDs derive from the assignment ID and attempt, so a relaunch after a node crash resumes the same thread instead of starting a second one.
4. **Follow.** The executor subscribes to the thread, plus child threads that it delegates or creates, and reports through `ctx.report`. See [progress events](#progress-and-usage-events).
5. **Finish.** It waits until every followed thread is idle for `settleMs`: no active run, pending request, active subagent or background task. Then:
   - **Review** (`nodeType: 'review'`): `verdict` comes from the final message's fenced JSON. A missing verdict leaves the field unset, so the engine retries.
   - **Planner** (`nodeType: 'planner'`): `items` comes from fenced JSON. A missing or invalid block makes the attempt fail rather than plan nothing.
   - **Workflow architect** (`role: 'workflow-architect'` or `architectRequestId`): `graph` and `rationale` come from fenced JSON. Otherwise the whole reply goes back in `summary`, so the hub's parser can return its errors.
   - **Work**: the executor reports uncommitted changes, pushes new commits on the work branch, and returns `branch`, `headSha`, the last PR URL the agent mentioned, and `threadRef` (`t3-thread://v1/<threadId>`). When it pushed to a local bare origin (an absolute or `file://` path, not GitHub) and the agent named no PR, `prUrl` is `local:<branch>`, the address the merge queue's local adapter expects.
6. **Cancellation.** When `ctx.signal` aborts, the executor interrupts every active run (`run.interrupt`, `holdQueue: true`), waits briefly, then rejects with the abort reason.

### Local account-provider contract

The node adapter owns attempt-qualified pool assignment IDs. The executor passes the original `{ assignmentId, attempt }` to it:

- `acquire({ provider, model, assignmentId, attempt })` returns `{ account, binding, reservation: { id, expiresAt, ... } }` or `null`. Exhaustion must throw `ACCOUNT_POOL_EXHAUSTED`.
- `renewReservation({ assignmentId, attempt, reservationId, idempotencyKey })` returns the renewed reservation with the same `id` and a future `expiresAt`. Missing, rejected, expired or unconfirmed renewals stop execution.
- `bindingFor(accountId, { reservationId })` checks the same reservation before registration and launch.
- `observe({ accountId, assignmentId, attempt, reservationId, message, idempotencyKey })` forwards provider failures.
- `release(selection, { assignmentId, attempt, reservationId, result })` fences cleanup against a replacement reservation. Reservation tokens remain local and never enter hub events.

### Progress and usage events

| `type` / `interaction` | Data |
| --- | --- |
| `usage` | `UsageRecord` fields: `provider`, `model`, `accountId?`, `inputTokens` (uncached), `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, plus `reasoningTokens`, `usageStatus`, `threadRef`, `providerTurnId`, `at`. There is one per finished provider turn, including turns in delegated child threads. |
| `thread.started` | `threadRef`, `provider`, `providerInstanceId`, `model`, `resumed`, `workspaceMode` |
| `turn.started` / `turn.finished` | `threadRef`, `runId`, `ordinal`, `status`, `startedAt`, `finishedAt`, `durationMs` |
| `agent.delegated` | `kind` (`delegated_task`, `thread` or `provider_native`), `allowed`, `target: { provider, model, threadRef }`, `from`, `reason?`. Refused attempts are included. |
| `runtime.request` | Approval or input request: `kind`, `prompt?`, `questions?` |
| `provider.failure` | `class` (`usage_limit`, `provider_error`, …), `code`, `retryable`, `resetAt?`, `message` |
| `account.bound`, `branch.published`, `workspace.dirty`, `policy.unenforced` | Diagnostics |

T3 counts cache reads and writes inside `inputTokens` ([`TurnTokenUsage`](../../vendor/t3code/packages/contracts/src/providerRuntime.ts) at lines 322 to 347). The executor subtracts them, so the hub's ledger does not double count.

## AgentPolicy enforcement

| Creation path | Enforced | How |
| --- | --- | --- |
| `delegate_task` (app-owned child task) | **Refused before dispatch** | Vendor patch in [OrchestratorMcpService.ts](../../vendor/t3code/apps/server/src/mcp/OrchestratorMcpService.ts) `delegateTask` |
| `create_threads` | **Refused before dispatch** | Same file, `createThreads` |
| `t3_thread_launch` by an agent | **Refused before dispatch** | [project/handlers.ts](../../vendor/t3code/apps/server/src/mcp/toolkits/project/handlers.ts) |
| Provider-native subagents (Claude Agent/Task tool, Codex multi-agent) | **Detected after start, then the run is interrupted** | The executor reports each `subagent.updated` with `origin: provider_native` to `/native-subagents`. A refusal stops the run. |
| `t3_thread_fork`, `schedule_task` | Not enforced | Not patched |

How the policy store works:
- A policy (`maxSubagents`, `allowedSubagentProviders`) is attached once per root thread and cannot be widened later. Children are linked to it, or resolved through `lineage.rootThreadId`, so the whole tree shares one budget.
- Reservations are atomic in SQLite (`perpeto-agent-policy.sqlite` in T3's state directory, through [policy-store.js](src/policy-store.js)). Retries with the same request key are idempotent, and failed dispatches release their reservation.
- `allowedSubagentProviders` matches a driver kind or an instance ID. An empty list allows none.
- Threads with no policy keep upstream behavior.

Routes, authenticated with T3 environment sessions (GET needs `orchestration:read`, writes need `orchestration:operate`):
- `PUT /api/perpeto/agent-policies/:threadId`
- `GET /api/perpeto/agent-policies/:threadId`
- `GET /api/perpeto/agent-policies/:threadId/decisions?after=`
- `POST /api/perpeto/agent-policies/:threadId/native-subagents`

Limits:
- Native subagents cannot be refused before they start without patching each adapter. For Claude, the cleanest hard block is `disallowedTools: ["Agent", "Task"]` at [ClaudeAdapterV2.ts](../../vendor/t3code/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts) `makeClaudeQueryOptions`, around line 8129, included in `queryPolicyKey`. T3's managed Codex runtime already disables multi-agent globally ([CodexManagedRuntime.ts:24](../../vendor/t3code/apps/server/src/provider/CodexManagedRuntime.ts)).
- A full-access agent runs as the same OS user and could mint its own T3 session. The policy guards against overreach by cooperative agents, not against a hostile one with shell access.
- `maxTurns` and `maxTokens` are enforced by the executor, which interrupts the run.

## How T3 is driven (research notes)

Source: `vendor/t3code` at the pinned commit. Verified live where noted.

**Authentication** ([cli/auth.ts](../../vendor/t3code/apps/server/src/cli/auth.ts), [EnvironmentAuth.ts](../../vendor/t3code/apps/server/src/auth/EnvironmentAuth.ts))
- `bin.mjs auth session issue --base-dir D --ttl T --token-only --scope …` writes a session into the runtime's SQLite directly. It works while the server runs. Verified live.
- HTTP takes `Authorization: Bearer`. The WebSocket uses `POST /api/auth/websocket-ticket`, then `ws://host/ws?orchestrationProtocol=2&wsTicket=…`. Without `orchestrationProtocol=2` the server returns 426.
- DPoP is optional.
- `/mcp` accepts only T3-minted agent tokens or MCP OAuth sessions. That surface is meant for agents, and it can't answer approvals.

**RPC framing** (Effect RPC, JSON; [ws.ts](../../vendor/t3code/apps/server/src/ws.ts) around 3104 to 3171)
- Messages are `{_tag:'Request', id, tag, payload, headers:[]}`, answered by `Exit` (`Success` / `Failure` with an Effect cause) or by stream `Chunk`s.
- **Every chunk must be acknowledged** with `{_tag:'Ack', requestId}`, or the stream stalls.
- `Ping`/`Pong` keeps the connection alive. See [rpc.js](src/rpc.js).

**Methods used**, with scopes from [RpcAuthorization.ts](../../vendor/t3code/apps/server/src/auth/RpcAuthorization.ts) and shapes from [orchestrationV2.ts](../../vendor/t3code/packages/contracts/src/orchestrationV2.ts):
- `server.getConfig` lists providers (`instanceId`, `driver`, `status`, `auth`, `models`).
- `projects.mutate {type:'project.create'}` creates a project. `GET /api/projects` lists them.
- `orchestration.launchThread` takes `{commandId, threadId, projectId, modelSelection:{instanceId, model, options:[{id,value}]}, runtimeMode, interactionMode, workspaceStrategy, initialMessage}`. Strategies are `root`, `worktree {baseRef, branch}` and `existing_worktree`. Verified live.
- `orchestration.subscribeThread {threadId, afterSequence?}` yields `snapshot`, `synchronized` and `event` items. Subscribing before the thread exists yields nothing, so subscribe after launch.
- `orchestration.dispatchCommand` with `run.interrupt` or `runtime-request.respond`.
- `GET /api/orchestration/threads/:id` (header `x-t3-orchestration-protocol: 2`) returns the final snapshot. Worktree branch and path arrive there after launch.
- `server.updateSettings {patch:{}, providerInstanceMutation}` needs `providers:manage`.

**Turn lifecycle**
- Run status goes `preparing|queued|starting|running|waiting`, then ends `completed|interrupted|failed|cancelled|rolled_back`.
- `waiting` also appears during checkpoint finalization, so pending approvals are detected from `runtime-request.updated` (`pending`) and `approval_request`/`user_input_request` turn items. Run status alone isn't enough.
- Assistant text is in `assistant_message` turn items by `runId`. Failures are `error` items carrying `{class, code, message, retryable, resetAt}`. Verified live on Codex and Claude.
- An app-owned `subagent.updated` arrives before its `childThreadId` exists. Verified live.

**Token usage**
- `provider-turn.updated` carries a live context snapshot (`tokenUsage`) and, at turn end, per-turn billing (`turnTokenUsage`: `inputTokens`, `cachedInputTokens`, `cacheCreationTokens`, `outputTokens`, `reasoningTokens`, `usageStatus`).
- Per-provider normalization lives in [ClaudeTurnTokenUsage.ts](../../vendor/t3code/apps/server/src/provider/ClaudeTurnTokenUsage.ts) and [CodexTurnTokenUsage.ts](../../vendor/t3code/apps/server/src/provider/CodexTurnTokenUsage.ts).
- Only the main agent is covered (`usageScope: main_agent`). Native subagent tokens are not included.

## Tests

- `node --test packages/t3-executor/test/*.test.js` runs against a fake T3 server ([test/fake-t3.js](test/fake-t3.js)). The fake is real HTTP plus a minimal WebSocket using T3's RPC framing and chunk acknowledgement, and the real policy store backs its policy routes. One test drives the real `@perpeto/node` account provider and pool with a synthetic credential.
- [Account lease tests](test/account-leases.test.js) use a real pool with synthetic credentials and short leases to cover repeated renewal, hung/lost renewals, root and child interruption, launch cancellation races, fenced cleanup, token forwarding and exhaustion with a ready default login present.
- Vendor tests: `apps/server/src/perpeto/AgentPolicy*.test.ts`, run with `vp test run`.
- **Opt-in live check** (not part of `npm test`; it uses this machine's existing harness logins):

  ```sh
  npm run setup && npm run build
  node packages/t3-executor/scripts/live-check.mjs --policy --roles [--provider claudeAgent --model claude-haiku-5-5] [--native]
  ```
