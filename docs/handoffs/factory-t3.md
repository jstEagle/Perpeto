# factory-t3 handoff

## Conflict recovery results, 21 October 2026

Worktree branch `t3/a37ed279` from `main` at `74cb7cb`, for the executor items in the [hub handoff](factory-hub.md#executor-handoff) and [workflow handoff](factory-workflow.md#exact-integration-required-outside-this-workers-scope). Only `packages/t3-executor/**` and this file changed. Not pushed or merged.

- **Planner touches:** `items[].touches` is parsed, normalised and validated to the engine's rules (at most 100 distinct repository-relative paths, no absolute/drive paths, `..`, backslashes or control characters). The engine forbids glob syntax, so a glob widens to the directory it starts in rather than being passed through; a declared scope never shrinks. The planner answer format asks for `touches`.
- **Architect extras:** `templateId` and up to three `additionalWorkflows` survive the structured parse. Malformed extras return the whole reply in `summary`, so the hub's parser reports the error to the architect.
- **Rebase steps:** `step: 'rebase'` checks out the published work branch, asks the agent to rebase onto the base, resolve conflicts and run quick tests, then verifies the result with Git and publishes the **same branch** with `--force-with-lease` on the exact previous head. `rebaseTouchedBeyondConflicts` comes from comparing the new head with `git merge-tree`'s three-way merge outside conflict hunks; the agent's own claim is ignored. Unknown evidence is left out, so the engine repeats review. Details in the [executor README](../../packages/t3-executor/README.md#rebase-steps).

Verification on Node v24.22.0: tests were written first and observed failing (11 of 11). `npm test -w @perpeto/t3-executor` now passes 70 of 70, including the rebase tests against real temporary repositories with a real conflict and the fake T3 server. Root `npm test` passes 557 of 557. Changed Markdown anchors resolve and `git diff --check` passes.

Not verified: a live harness resolving a real conflict; local working checkouts (`repo.localPath` worktrees) for rebase steps, which have no test; Git older than 2.40, where `merge-tree --merge-base` is missing and the field is omitted. The comparison is conservative by design: a resolution Git would itself produce differently (for example rename handling across several replayed commits) reports `true` and costs one extra review, never a skipped one.

## Dedicated Claude config directory, 21 October 2026

Worktree branch `t3/a4959f6c` from `main` at `9c9e43f`, for the "account-level Claude context" finding in [live acceptance run 2](live-acceptance-2.md#findings). Not pushed or merged.

- **Transcripts and state:** unpooled factory Claude instances now run with `homePath` `<agentHomesDir>/claude-<hash>`, which T3 passes as `CLAUDE_CONFIG_DIR`. The directory (mode 700) holds only a login, and Claude keeps its transcripts, `.claude.json`, memory and settings there. Pooled accounts already ran in private homes. Details in the [executor README](../../packages/t3-executor/README.md#claude-config-directory).
- **Login:** a pool account, a separate `claude auth login` into the factory home, or the explicit `runtime.t3.claudeLogin: "copy-once"`, which copies only `claudeAiOauth` from the current login (file, else macOS keychain) once and records the copy. With none of these, the assignment is `blocked`; it never falls back to `~/.claude`. **This changes the default:** a node that ran Claude factory work on the operator login now needs one of the three.
- **Account email: still present, and inherent to the account.** Claude Code 2.1.304 takes it from `oauthAccount.emailAddress`, which it fetches from `/api/oauth/profile` and stores in the dedicated home's own `.claude.json`. The live turn confirmed both. Only a different account, or possibly an inference-only `claude setup-token` token (untested), keeps the operator's email out.
- **Accounts fix found on the way:** on macOS Claude moves `.credentials.json` into a per-directory keychain item on its first credential write. Pooled Claude homes would then have been marked invalid after one use; the pool now accepts that item (presence check only). Claude imports also drop everything but `claudeAiOauth`. See [factory-accounts](factory-accounts.md#dedicated-claude-homes-follow-up-21-october-2026).

Verification on Node v24.22.0: `npm test -w @perpeto/t3-executor` 53 of 53 and `npm test -w @perpeto/accounts` 31 of 31, all with synthetic credentials, a fake keychain and the fake T3 server. Repository `npm test`: 486 of 486. One live Sonnet turn (`live-check.mjs --isolation --provider claudeAgent --model claude-sonnet-5-5 --claude-login copy-once`, runtime built from the same vendor commit in another worktree): success, commit by Perpeto Agent, one transcript in the dedicated home, `~/.claude/projects` unchanged at 67 directories, email block present. The temporary home was deleted and no keychain item was left.

Not verified: the keychain move and the pool's acceptance of it live (no refresh happened in a 10-second turn); whether a shared refresh token from `copy-once` signs the operator out when either side refreshes; a `setup-token` login.

## Factory orchestration context filtering, 21 October 2026

Implemented in this worktree from `main` at `61855d5`. No push or merge.

The executor attaches immutable `t3Tools: "policy"` alongside the existing per-thread AgentPolicy before launch. The recorded server-only vendor patch reads it during provider-session preparation. Zero-subagent roles (or an empty provider allowlist) receive no T3 MCP session. Delegation-enabled roles receive an isolated `/mcp/perpeto` catalog with only `orchestrator_capabilities`, `delegate_task`, `task_status` and `task_cancel`; the existing atomic budget/provider checks still apply. Factory credentials cannot switch to the full MCP endpoint. Policies migrate from SQLite v1 to v2 with `"full"` as the legacy default; children inherit via the policy link or lineage root before linking.

Codex and Claude suppress T3 orchestration notes with the reduced catalog attached. **Known gap, deliberately kept outside the vendor patch:** delegation-enabled Cursor, OpenCode and ACP providers still receive T3 notes from `vendor/t3code/packages/provider-*`. Zero-subagent roles omit MCP centrally and avoid those notes. Provider-native tools remain a separate boundary. Claude prompt construction is covered by tests, not a new live Claude run.

### Measurement

Two tiny real Codex builder turns, one before and one after, used `gpt-6.1-sol`, low effort, existing login, separate temporary T3 state and bare repositories. Each created and committed `hello.txt`; both succeeded with the factory Git identity. No login was created or switched.

| First model call | Before | After | Change |
| --- | ---: | ---: | ---: |
| Codex rollout input tokens | 15,256 | 13,562 | -1,694 (-11.1%) |
| T3 orchestration/runtime/browser notes | 7,559 chars | 0 | Removed |
| App-owned tool catalog for builder | Full | None | Removed |

These are provider-reported first-call counts, not synthetic fake-server usage or an estimate of schema token cost. Harness instructions and 2,671 characters of model-catalog multi-agent notes remain. Prompt assembly tests compare the upstream and factory paths; MCP HTTP tests verify the actual catalog and call boundary. Reproduce the live builder with `node packages/t3-executor/scripts/live-check.mjs --isolation --provider codex --model gpt-6.1-sol --effort low`; the baseline used the pre-patch runtime and executor. The two-turn allowance is spent; no live delegation/Claude turn was added.

### Validation

Node v24.22.0. Repository `npm test`: 461 passed. Related upstream suites: 649 passed across 15 files (policy HTTP/service, factory MCP HTTP catalog/calls, MCP services/toolkits/access, provider-session preparation/inheritance, Codex and Claude prompt assembly). Vendor server typecheck and runtime build passed. `npm run verify:upstream` verifies the pinned import and recorded patches.

## Live acceptance fixes, 21 October 2026

Branch `t3/756151ef`, from the findings in [live acceptance run 1](live-acceptance-1.md#fixed-after-the-run). Not pushed or merged.

- **Agent isolation** ([isolation.js](../../packages/t3-executor/src/isolation.js), [README](../../packages/t3-executor/README.md#agent-isolation)): each assignment runs on a factory provider instance derived from the operator's or the pooled account's, through T3's existing instance `environment`, `homePath` and `launchArgs`; no vendor patch. New settings: `agentIsolation` (`factory`, or `inherit` for debugging), `gitIdentity`, `agentHomesDir`, `codexHome`, `personalSkillDirs`.
- **Prompts:** only work roles get the closing branch and pull request request; a local origin says there is no pull request. Planner `summary` comes from the json block.
- **Live:** `live-check.mjs --isolation`, two Codex `gpt-6.1-sol` low turns. The second, after disabling `~/.agents/skills`: commit by `Perpeto Agent <agents@perpeto.local>`, no personal context, 15,252 first-call input tokens against 31,347 in run 1. Tests: 45 of 45.

Not done or not verified:

- **Claude isolation live**, and whether `--setting-sources` also hides user-scope MCP servers in `~/.claude.json`.
- **T3 context** (finding 3): addressed by the per-thread filtering patch above. The reduced catalog preserves policy-allowed app-owned delegation. The remaining external-provider prompt gap is recorded above.
- **Auth link:** the factory Codex home links `auth.json` to the operator's file. If a Codex release starts replacing it atomically, the executor refuses that home (`ISOLATION_AUTH_DIVERGED`) instead of using a forked copy.
- **Hub change requested** (apps/hub is another worker's): to set the identity per project, accept `gitIdentity: { name, email }` on `POST/PATCH /projects` and copy it onto each assignment as `assignment.gitIdentity`. The executor already reads it. Per-node identity works today through `node.json` `runtime.t3.gitIdentity`.

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
- **Not enforced in upstream full sessions:** `t3_thread_fork` and `schedule_task` are not policy-checked. Factory sessions now hide them entirely. Native subagent token usage is not reported, because T3 counts only the main agent.
- **One T3 project per clone:** clone-mode workspaces each register a T3 project, because T3 keys projects by root.

## Contract requests (architecture.md not edited)

- Document `ExecContext.accountProvider` and the account flow above, including the `providers:manage` scope for executor sessions.
- Document the executor progress `interaction` values in the table above, and `threadRef` as `t3-thread://v1/<threadId>`.
- Name the work-branch convention. The executor uses `assignment.branch`, then `workItem.branch`, then `perpeto/<workItemId>`. This matches the e2e executor, but not `factory-delivery`'s `branchName()`.
- `AgentPolicy`: an empty `allowedSubagentProviders` allows none, and a policy is fixed once a thread starts.
