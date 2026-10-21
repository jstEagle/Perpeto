# T3 executor

Node executor that runs factory assignments through a local T3 environment server. It is dependency-free ESM for Node 24. All inference goes through T3 and its harnesses; this package never calls a model API.

```js
import { createT3Executor } from '@perpeto/t3-executor';
const executor = createT3Executor({ config, runtimeUrl, accountProvider });
// { kind: 't3', canRun(assignment, machine), run(assignment, ctx), providers({ signal }), close() }
// providers() lists the driver kinds T3 reports enabled and ready; the node advertises them.
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
| `agentIsolation` | `factory` | `factory` runs agents on an isolated T3 provider instance (see [agent isolation](#agent-isolation)). `inherit` uses the operator's instance as is; keep it for debugging |
| `gitIdentity` | `{ "name": "Perpeto Agent", "email": "agents@perpeto.local" }` | Author and committer of agent commits. An assignment's `gitIdentity`, or `context.project.gitIdentity`, overrides it per project |
| `agentHomesDir` | `<baseDir>/perpeto-agent-homes`, else `~/.perpeto/agent-homes` | Where factory Codex homes live |
| `codexHome` | the base instance's home, else `CODEX_HOME`, else `~/.codex` | Codex home whose login an unpooled factory instance uses |
| `personalSkillDirs` | `["~/.agents/skills"]` (absolute) | Shared skill folders whose skills factory Codex instances disable |
| `turnTimeoutMs` | 4 hours | Assignment time limit |
| `settleMs`, `pollMs`, `accountReadyTimeoutMs` | 2000, 1000, 60000 | Timing |

A minted session gets `orchestration:read`, `orchestration:operate` and `providers:manage`. The last one is needed to register account instances.

## What `run(assignment, ctx)` does

1. **Account.** If the node supplies an account provider (`ctx.accountProvider` or the factory argument), the executor:
   - reserves an account with `acquire({ provider, assignmentId, attempt })`;
   - registers the binding with `server.updateSettings { patch: {}, providerInstanceMutation }`;
   - waits until that instance is `ready`, then rechecks `bindingFor(accountId, { reservationId })` just before launch;
   - renews its reservation halfway through each confirmed lease, throughout setup, the turn and cancellation cleanup. The default pool lease is five minutes. Each renewal has a fresh idempotency key; if renewal hangs, a separate deadline cancels work after three quarters of the confirmed lifetime, leaving time for interrupt cleanup before expiry.

   With `agentIsolation: factory` the bound instance gets the factory Git identity and project-only settings, as below; the pool's Perpeto-owned home is kept.

   It sends every provider failure to `observe`, so the pool decides between rate-limit cooldown and auth invalidation. Binding checks, observations and release carry the selected reservation token. It always stops renewal and releases the reservation in `finally`. Renewal loss interrupts followed root and child runs and returns an assignment `failure`. `ACCOUNT_POOL_EXHAUSTED` also returns `failure` with a retry-with-backoff summary and never selects the operator's default login. With no enrolled accounts or no pool support (`acquire` returns `null`), it uses a ready instance of the harness's driver.
   Without a pool it picks a ready operator instance of the driver and, in `factory` mode, registers and waits for its factory instance (`perpeto_<base>_<hash>`) instead.
2. **Workspace from `assignment.repo`.**
   - A local working checkout (`localPath`) gets a T3-managed worktree on the work branch. An existing branch or worktree is reused.
   - Otherwise the executor clones `url` (or a bare `localPath`) into `ctx.workspace/repo`, starting from `origin/<branch>` when an earlier attempt published it.
   - The work branch is `assignment.branch`, then `workItem.branch`, then `perpeto/<workItemId>`.
3. **Thread.** The executor finds or creates the T3 project for the workspace root (T3 allows one project per root). It attaches the `AgentPolicy`, including `t3Tools: "policy"`, to a deterministic thread ID, then launches the thread with the prompt.
   - The prompt is the assignment prompt plus project goals, docs, the work item, subagent limits and, for structured roles, the answer format.
   - IDs derive from the assignment ID and attempt, so a relaunch after a node crash resumes the same thread instead of starting a second one.
4. **Follow.** The executor subscribes to the thread, plus child threads that it delegates or creates, and reports through `ctx.report`. See [progress events](#progress-and-usage-events).
5. **Finish.** It waits until every followed thread is idle for `settleMs`: no active run, pending request, active subagent or background task. Then:
   - **Review** (`nodeType: 'review'`): `verdict` comes from the final message's fenced JSON. A missing verdict leaves the field unset, so the engine retries.
   - **Planner** (`nodeType: 'planner'`): `items` comes from fenced JSON. A missing or invalid block makes the attempt fail rather than plan nothing.
   - **Workflow architect** (`role: 'workflow-architect'` or `architectRequestId`): `graph` and `rationale` come from fenced JSON. Otherwise the whole reply goes back in `summary`, so the hub's parser can return its errors.
   - **Work**: the executor reports uncommitted changes, pushes new commits on the work branch, and returns `branch`, `headSha`, the last PR URL the agent mentioned, and `threadRef` (`t3-thread://v1/<threadId>`). When it pushed to a local bare origin (an absolute or `file://` path, not GitHub) and the agent named no PR, `prUrl` is `local:<branch>`, the address the merge queue's local adapter expects.
6. **Cancellation.** When `ctx.signal` aborts, the executor interrupts every active run (`run.interrupt`, `holdQueue: true`), waits briefly, then rejects with the abort reason.

### Agent isolation

Live acceptance run 1 showed factory agents reading the operator's personal instructions and committing as the operator. T3 provider instances accept their own `environment`, home and launch arguments, so the executor isolates agents without patching T3:

| Layer | Operator setup that stays out | What still loads |
| --- | --- | --- |
| Claude | `--setting-sources=project,local`: `~/.claude/settings.json`, `~/.claude/CLAUDE.md`, user hooks, skills and plugins. The Claude Agent SDK loads every source when T3 passes none | The repository's `CLAUDE.md` and `.claude/` settings. The login, from the base instance's `homePath` |
| Codex | A factory `CODEX_HOME` with a minimal `config.toml` and `auth.json` linked to the source home's: `~/.codex/AGENTS.md`, skills, memories, hooks, plugins, MCP servers, rollout history. The config also disables bundled skills and every skill in `~/.agents/skills` (`personalSkillDirs`), which Codex reads whatever `CODEX_HOME` is. `-c features.{memories,hooks,plugins,apps,multi_agent,multi_agent_v2}=false` disables account-level plugins and apps | The repository's `AGENTS.md` and skills. The one login: token refreshes write through the link. Pooled accounts keep their Perpeto-owned homes |
| Git | `GIT_AUTHOR_*` and `GIT_COMMITTER_*` from `gitIdentity`, and `commit.gpgsign`, `tag.gpgsign` off through `GIT_CONFIG_*`, so the operator's identity and signing key never touch agent commits | The operator's other Git config, such as credential helpers |

The executor reports `isolation.bound` with the instance and identity. A factory home whose `auth.json` became a regular file is refused (`blocked`), since that copy would drift from the operator's login. Base-instance environment variables T3 marks sensitive are redacted for clients, so they are not copied; their names are reported in `droppedEnvironment`.

Context before the agent does anything, from Codex rollouts (`gpt-6.1-sol`, low effort):

| Part of the first model call | Live run 1 (operator setup) | Factory instance |
| --- | --- | --- |
| Input tokens, first call | 27,710 to 31,545 (nine turns; builder 31,347) | 13,562 (builder, after tool filtering) |
| Skills list | 41,160 characters | none |
| Memories | about 12,000 characters | none |
| `~/.codex/AGENTS.md` | 4,939 characters | none |
| SessionStart hook output | about 1,780 characters | none |
| T3 orchestration, runtime and tool notes | 7,559 characters | none |
| Multi-agent role and mode notes | 2,671 characters | 2,671 characters |

The factory column is `node packages/t3-executor/scripts/live-check.mjs --isolation --provider codex --model gpt-6.1-sol --effort low` on 21 October 2026. A fresh before/after pair used 15,256 and 13,562 first-call input tokens, a reduction of 1,694 (11.1%). Each was one builder turn in its own temporary runtime and repository, using the existing login; both committed as `Perpeto Agent <agents@perpeto.local>`. These are actual Codex rollout counts, including its own instructions and tools, rather than a characters-to-tokens estimate. The multi-agent notes come from the model catalog (`multi_agent_version: v2`) and remain.

Not verified live: Claude isolation (configured and unit-tested only), and whether `--setting-sources` also hides user-scope MCP servers in `~/.claude.json`.

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

### Factory prompt and tool filtering

The executor sets `t3Tools: "policy"` through the existing policy PUT route before launch. T3 reads it when preparing the provider session. Like the budget, this setting is immutable, persistent and inherited by descendants, including through `lineage.rootThreadId` before a child is linked. Existing policies migrate to `"full"`, preserving upstream behavior.

- With `maxSubagents: 0` or no allowed subagent providers, T3 attaches no app-owned MCP session. This removes the app tool catalog and its orchestration notes across providers.
- Otherwise the session uses `/mcp/perpeto`, which exposes only `orchestrator_capabilities`, `delegate_task`, `task_status` and `task_cancel`. The existing atomic policy checks still refuse forbidden providers and exhausted budgets. Status and cancellation remain available after budget exhaustion.
- Factory credentials are refused at the full `/mcp` endpoint, and full credentials are refused at the factory endpoint. Thread management, scheduling, previews, HTML, device, worktree and PR tools are absent from the factory catalog and cannot be called there.
- Codex and Claude omit the T3 orchestration notes even when delegation MCP is attached. **Known gap:** delegation-enabled Cursor, OpenCode and ACP providers still receive T3 notes from their separate provider packages. Those packages were deliberately left unpatched. Zero-subagent threads do not attach MCP and avoid those notes.

This requires the rebuilt runtime; older runtimes may ignore `t3Tools`. It filters T3's app-owned surface, not provider-native tools or the underlying OS. A runtime without policy routes still reports `policy.unenforced` and cannot provide this filtering. Claude prompt assembly is tested; only Codex was exercised live for this change.


| Creation path | Enforced | How |
| --- | --- | --- |
| `delegate_task` (app-owned child task) | **Refused before dispatch** | Vendor patch in [OrchestratorMcpService.ts](../../vendor/t3code/apps/server/src/mcp/OrchestratorMcpService.ts) `delegateTask` |
| `create_threads` | **Refused before dispatch** | Same file, `createThreads` |
| `t3_thread_launch` by an agent | **Refused before dispatch** | [project/handlers.ts](../../vendor/t3code/apps/server/src/mcp/toolkits/project/handlers.ts) |
| Provider-native subagents (Claude Agent/Task tool, Codex multi-agent) | **Detected after start, then the run is interrupted** | The executor reports each `subagent.updated` with `origin: provider_native` to `/native-subagents`. A refusal stops the run. |
| `t3_thread_fork`, `schedule_task` | Hidden from factory sessions | No factory MCP access; upstream full sessions keep existing behavior |

How the policy store works:
- A policy (`maxSubagents`, `allowedSubagentProviders`, `t3Tools`) is attached once per root thread and cannot be widened later. Children are linked to it, or resolved through `lineage.rootThreadId`, so the whole tree shares one budget.
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
- Vendor tests: `apps/server/src/perpeto/AgentPolicy*.test.ts` and `FactoryMcp.test.ts`, plus provider session, Codex/Claude prompt assembly and MCP toolkit tests, run with `vp test run`.
- **Opt-in live check** (not part of `npm test`; it uses this machine's existing harness logins):

  ```sh
  npm run setup && npm run build
  node packages/t3-executor/scripts/live-check.mjs --policy --roles [--provider claudeAgent --model claude-haiku-5-5] [--native]
  node packages/t3-executor/scripts/live-check.mjs --isolation --provider codex --model gpt-6.1-sol --effort low [--server-entry other/checkout/bin.mjs]
  ```
