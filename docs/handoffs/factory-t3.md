# factory-t3 handoff

## Account lease follow-up, 21 October 2026

Implemented on `t3/executor-reservation-renewal` after merging `t3/account-reservation-retention`. Only executor files and this handoff changed beyond that dependency merge; `apps/node` remains owned by the node worker.

- Reservations renew halfway through their confirmed remaining lifetime with a fresh idempotency key each time. A hung renewal cancels after three quarters of that lifetime, leaving time to interrupt before expiry. Renewal continues through setup, execution and interrupt cleanup, then stops before release.
- Binding checks, observe and release receive `reservationId`. Lost renewal interrupts followed root and child runs with `holdQueue: true` and returns `failure`. Cancellation during the launch reply is recovered by reading the thread before interrupting it.
- `ACCOUNT_POOL_EXHAUSTED` returns assignment `failure` with an explicit backoff summary. It never registers or launches the operator's ready default login.
- The node worker agreed to the [local account-provider contract](../../packages/t3-executor/README.md#local-account-provider-contract), including `renewReservation({ assignmentId, attempt, reservationId, idempotencyKey })`. Its adapter changes are a separate branch and are not claimed as verified here.

Verification uses Node v24.22.0, the fake T3 server and synthetic pool credentials. `npm test -w @perpeto/t3-executor` passes 33 tests. Repository `npm test` passes 328 of 329; its only failure is the known obsolete exhaustion/null expectation in `apps/node/test/accounts-integration.test.js:35`, pending the node worker's branch. All publishing end-to-end tests passed. No real account or live harness turn was exercised for this follow-up.

## Original executor handoff

Branch `t3/factory-t3-executor`, with main `9881b7b` merged in. Not pushed or merged. Package documentation, including the T3 API research and file references, is in [packages/t3-executor/README.md](../../packages/t3-executor/README.md).

## What exists

- **Executor** `@perpeto/t3-executor`: `createT3Executor({ config, runtimeUrl, accountProvider })` returns `{ kind: 't3', canRun, run, close }`. It drives a local T3 server through its authenticated HTTP and Effect RPC WebSocket. It needs no dependencies or model API.
  - **Auth:** an owner-only credential file, or a short-lived session minted with T3's own CLI and held in memory.
  - **Workspace:** taken from `assignment.repo`. A local working checkout gets a T3 worktree on `perpeto/<workItemId>`; otherwise the executor clones into `ctx.workspace`, starting from the published branch. New commits are pushed without force.
  - **Accounts:** acquire, then register the instance with `server.updateSettings`, then wait for ready, recheck `bindingFor`, launch, `observe` failures, and release in `finally`.
  - **Reports:** `usage` (uncached input separated from cache reads and writes), `turn.started` and `turn.finished` timing, `agent.delegated` including refusals, `runtime.request` and `provider.failure`.
  - **Results:** a review `verdict`, planner `items` and architect `graph`/`rationale`, parsed from the final fenced JSON block.
  - **Cancellation:** `ctx.signal` interrupts every active run and then rejects.
  - **Executor-side limits:** approvals and questions block the run, and `maxTurns`, `maxTokens` and a time limit stop it.
- **AgentPolicy:** [policy-store.js](../../packages/t3-executor/src/policy-store.js) holds atomic per-tree budgets in SQLite. A recorded vendor patch refuses `delegate_task`, `create_threads` and agent `t3_thread_launch` beyond `maxSubagents` or outside `allowedSubagentProviders`, before dispatch. Provider-native subagents are detected, charged to the same budget, and the run is interrupted on a refusal.
- **Vendor patch** (recorded in `config/upstream-patches.json`):
  - new `perpeto/AgentPolicy.ts` with two tests;
  - routing in `perpeto/http.ts`;
  - hooks in `mcp/OrchestratorMcpService.ts` and `mcp/toolkits/project/handlers.ts`.

## Verification

Run on macOS with Node v24.22.0.

| Check | Result |
| --- | --- |
| `npm test` (repository) | 285 passed, 0 failed |
| `node --test packages/t3-executor/test/*.test.js` | 24 passed. Covers the fake T3 server, the real `factory-node` account provider and pool with a synthetic credential, and a real bare-origin Git publish |
| `vp test run apps/server/src/perpeto/` | 8 passed. Covers `delegate_task` enforcement through the real `OrchestratorMcpService`, and the policy routes with real environment auth |
| Related upstream suites (MCP service, toolkit, tool access, HTTP) | 118 passed |
| Server `typecheck` | No errors |
| `node scripts/check-upstream.mjs` | Provenance verified |
| **Live**: `live-check.mjs --policy --roles` against the rebuilt runtime, Codex `gpt-6-luna` | 16 of 16 ok. Covers a trivial turn, output, usage, timing, branch and head; a real `delegate_task` refused under `maxSubagents: 0`; an allowed delegation with its child thread and child usage followed; a builder commit pushed to origin at the reported head; a review verdict; and planner items |
| **Live**: same with Claude `claude-haiku-5-5` (`--policy`) | 12 of 12 ok. Run before the accounts and role-result changes; not rerun since |

The live checks used existing harness logins on this machine, temporary T3 base directories, and no new logins.

## Not verified or not done

- **Provider-native subagent interrupt, live:** Claude declined to start its built-in subagent when told the policy forbids it, so `--native` was skipped. The path has unit tests only. A hard pre-start block needs an adapter patch; see the README.
- **Real subscription accounts:** not exercised live, because that needs enrolled account homes. Covered with the real pool and synthetic fixtures.
- **Package resolution:** **`@perpeto/t3-executor` does not resolve from `factory-node`**, because the repository has no workspace links. The node silently skips the executor. Configure `executorPackages` with the absolute `src/index.js` path (verified), or add npm workspaces at the root.
- **Not enforced:** `t3_thread_fork` and `schedule_task` are not policy-checked. Native subagent token usage is not reported, because T3 counts only the main agent.
- **One T3 project per clone:** clone-mode workspaces each register a T3 project, because T3 keys projects by root.

## Contract requests (architecture.md not edited)

- Document `ExecContext.accountProvider` and the account flow above, including the `providers:manage` scope for executor sessions.
- Document the executor progress `interaction` values in the table above, and `threadRef` as `t3-thread://v1/<threadId>`.
- Name the work-branch convention. The executor uses `assignment.branch`, then `workItem.branch`, then `perpeto/<workItemId>`. This matches the e2e executor, but not `factory-delivery`'s `branchName()`.
- `AgentPolicy`: an empty `allowedSubagentProviders` allows none, and a policy is fixed once a thread starts.
