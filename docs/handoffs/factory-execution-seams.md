# Factory execution seams

Investigated 21 October 2026 against the pinned inherited runtime and current Perpeto source. Source inspection establishes available seams; recommendations below are not implemented factory scheduling. Existing saved definitions currently configure graphs, not running harness workflows.

## Existing boundaries

| Responsibility | Concrete source | Observed contract |
|---|---|---|
| Saved graph | `packages/factory-definition/src/storage.js` and `.d.ts` | Immutable versions, agent/context/check/merge-queue nodes and typed edges. Agent nodes specify driver, optional model and delegation/concurrency settings; no live provider instance or assignment binding exists. |
| Provider account/model selection | `vendor/t3code/packages/contracts/src/modelSelection.ts`, `providerInstance.ts` | Runtime selection is `{instanceId,model,options?}`. Driver names identify harness kinds; instance IDs identify configured accounts. A factory's `harness:"codex"` cannot uniquely select among multiple Codex accounts. |
| Launch | `apps/server/src/orchestration-v2/ThreadLaunchService.ts` | `launch` takes project, model selection, runtime/interaction policy, workspace strategy and optional initial message; returns thread ID/projection/resumed. Supports root, existing worktree and provisioned worktree. |
| Public launch transport | `packages/contracts/src/orchestrationV2.ts`, `rpc.ts`; `apps/server/src/ws.ts` | Authenticated `orchestration.launchThread` websocket RPC enters `ThreadMessageIntake`, startup command queue and launch service. `packages/client-runtime/src/operations/commands.ts:startThreadTurn` is the existing UI consumer. |
| Subsequent turns | `orchestration-v2/ThreadManagementService.ts`, `Orchestrator.ts`, `ThreadCommandExecutor.ts` | `message.dispatch` commands use durable IDs and per-thread serialized dispatch. This is the existing command boundary; bypassing it to call CLI processes would lose orchestration state. |
| Durable commit | `orchestration-v2/EventSink.ts`, `CommandReceiptStore.ts`, `EventStore.ts`, `ProjectionStore.ts`, `EffectOutbox.ts` | Events/projections/receipts/outbox effects commit transactionally. Receipt acceptance is distinct from provider execution and later verification. Expected attempt/status guards prevent stale provider events replacing newer ownership. |
| Provider lifecycle | `ProviderSessionManager.ts`, `ProviderTurnStartService.ts`, `ProviderEventIngestor.ts`; `packages/provider-core/src/server/ProviderAdapter.ts` | Existing adapters expose open/resume/start/interrupt/requests and normalized events. Preserve native capabilities, approvals and questions. `turn.terminal` is not equivalent to product acceptance. |
| Filesystem finalization | `orchestration-v2/RunFinalizationService.ts` | Captures checkpoint and refreshes workspace/VCS after turn; do not mark work integrated merely because assistant output arrived. |
| Recovery | `ProviderRuntimeRecoveryService.ts`, `RestartContinuation.ts` | Reconciles running/preparing/waiting state and process-bound requests on startup/shutdown. Can enqueue conditional native continuations; blockers include archived/snoozed threads, nonresumable pending requests, missing strong native IDs and incompatible state. It is not generic cross-machine migration. |
| Perpeto services | `apps/server/src/perpeto/` | Versioned graph storage, durable messaging and CI queue are mounted/authenticated alongside inherited orchestration. No graph-to-thread execution ledger exists yet. |

Paths in the table after the first two package rows are relative to `vendor/t3code` unless otherwise stated.

## Recommended next vertical slice

Execute one explicitly selected agent node from one immutable factory revision on one selected environment, and record a durable assignment linked to the resulting T3 thread/run. Use a task that emits a fixed answer before adding edits, reviews or graph transitions.

Persist the factory/project/version/node IDs, execution environment, resolved provider instance/model, assignment ID, command/thread/run IDs, input-context snapshot references and result/evidence state. Resolve account/model availability from the live runtime catalog; do not silently choose the first matching account. Keep workspace choice explicit and reuse `ThreadLaunchService` for worktree preparation. This recommendation does not select a new database/framework or distributed scheduler.

Allocate/store stable assignment and launch command IDs before launch. A failed/ambiguous launch must reconcile the known thread/receipt before issuing new work. Perpeto storage and inherited orchestration are separate transactional boundaries: no existing transaction spans them. An execution adapter therefore needs a recoverable dispatch intent and reconciliation, not a claim of atomic exactly-once launch.

Observe persisted projections or sequenced event streams; record waiting approvals/questions, provider failures and checkpoint completion. Keep user-facing status distinct from raw RPC success. Next add one context edge and a single check submission pinned to the produced commit; do not implement all graph edge semantics in the first turn proof.

## Replaceable orchestrator sessions

Recommendation: distinguish a durable role/assignment from the transient T3 session fulfilling it. A replacement coordinator gets bounded current intent, assignments, results/evidence and unresolved questions; it need not inherit the old conversation. Native thread resume remains useful for ordinary worker continuity, but resuming the same ever-growing native conversation is not itself context renewal.

An orchestrator's app-owned child tasks can persist independently, but their native callbacks and credentials must still obey existing session ownership. Add explicit coordinator generation/ownership fencing before allowing replacement sessions to assign or finish shared work. Preserve ambiguous old work for reconciliation. Do not replay a prompt automatically when an agent may already have edited files, dispatched children or triggered external jobs.

## Delegation controls and enforcement limits

The saved node's `allowSubagents`, `maxSubagents` and `maxConcurrent` are currently validated configuration only. They are not read by inherited runtime policy or MCP delegation handlers. `ProviderAdapterV2RuntimePolicy` currently carries runtime mode, interaction mode, cwd, approvals, sandbox and reasoning effort; it has no factory child quota.

App-owned delegation enters `mcp/OrchestratorMcpService.ts:delegateTask`, resolves current provider/project enablement, checks that the caller owns an active run, derives stable command IDs from `clientRequestId`, and dispatches `delegated_task.request`. This is a practical enforcement seam for Perpeto-owned delegation authority and quotas. Reservation must be atomic across concurrent calls; a descriptive prompt is not enforcement.

Native harness subagents bypass that app-owned tool: Codex/Claude adapters expose native lifecycle events, and instructions explicitly prefer native tools for some same-provider work. Observing a spawn event after it happens cannot enforce a pre-spawn quota. Claude's `allowedTools` only preapproves tools; its separate `tools` query policy controls availability. No uniform existing native spawn-count control was established across all nine drivers. Determine per-driver enforcement support before presenting graph limits as guaranteed; keep unsupported controls explicit and retain native approval/security boundaries. Define whether limits count active direct children, descendants or lifetime spawns before wiring enforcement.

## Optional actual imported-Codex proof

`scripts/smoke-harness.mjs` uses `config/smoke-harness.json`. It creates isolated runtime/project/Codex directories, copies the existing local auth file into an owner-only private file, uses file credential storage and a fresh Codex config, and never symlinks sessions/config from the user's home. Upstream shadow homes deliberately share state via symlinks (`provider/Drivers/CodexHomeLayout.ts`), so they are inappropriate for this isolated check.

The script selects an installed model from `server.getConfig`, creates a T3 project via `/api/projects/mutate`, and sends an authenticated `orchestration.launchThread` request. The socket uses `/ws?orchestrationProtocol=2` with a one-use ticket from `/api/auth/websocket-ticket`; the Effect frame is `{_tag:"Request",id,tag,payload,headers:[]}`. It checks the real thread projection for completed status and an exact nonce assistant response, then checks persistence after restart. No tools are approved; any pending tool approval fails the smoke. It fingerprints source auth before/after without printing its contents.

Run only on an explicitly authorized live harness check:

```sh
node scripts/smoke-harness.mjs
```

This consumes the existing subscription and is excluded from ordinary CI/tests. Copied file authentication may be unavailable or insufficient for keychain-only installations; that is a local-auth prerequisite, not evidence the imported adapter works. **Verified 21 October 2026:** `node scripts/smoke-harness.mjs` passed against the built runtime. A real Codex app-server turn completed, its assistant-role output matched the nonce exactly, the same output survived isolated server restart, and the original Codex auth-file fingerprint remained unchanged. Initial provider snapshots can precede readiness; the reusable smoke requests a fresh Codex provider refresh and waits within its configured startup deadline. No two-host execution, scheduler, graph transition or multi-provider compatibility is established by a successful nonce turn.
