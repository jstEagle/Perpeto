# Factory integration handoff

Branch `t3/b6753bf9`, based on main `13cdd2d`, with main `4d8bd2d` (workflow retries and escalation, GitHub publication strategies, CLI) merged in. Not pushed or merged.

## What is wired

- **Engine:** the hub's default engine is now [workflow-adapter.js](../../packages/factory-hub/src/engine/workflow-adapter.js) over `@perpeto/factory-workflow`. It runs the pure `step` with hub-persisted state, maps hub events to engine events and engine effects to hub effects, and delegates validation, diffs, architect prompts and parsing, and run metrics. Project metrics aggregate per-run results. The mapping table is in the [hub README](../../packages/factory-hub/README.md#engine-mapping).
- **Verdicts and retries:** review `verdict` passes through. A review `success` without a verdict goes to the engine as an error, which it retries. Expired leases on run work become failed attempts reported to the engine. Jobs that end `error` or `cancelled` reach the engine as well. The hub does not lease a retry before its `notBefore`.
- **Delivery:** [delivery/index.js](../../packages/factory-hub/src/delivery/index.js) mounts `@perpeto/factory-delivery` merge queues. It enqueues engine merge entries, dispatches speculative jobs through the hub job queue, records node results, ticks the queue and reports merged or rejected entries back to the engine. It uses the local-git adapter.
- **Accounts:** [integrations/accounts.js](../../packages/factory-node/src/integrations/accounts.js) wraps `createAccountPool` in the node's `createAccountProvider({ config, configRoot, dataDir })` interface. The pool opens after enrollment, and reservations are scoped to each attempt.
- **E2E:** [packages/factory-e2e](../../packages/factory-e2e/README.md) runs the build template and the architect flow against a real hub and node.

## Fixes outside the owned paths

| File | Change |
| --- | --- |
| `factory-hub/src/hub.js` | Starts runs with the project, which gives the engine its repo. Sends pause, resume and stop to the engine. Keeps `verdict` and `items` on results. The review `gate.result` uses the verdict. Stores non-interaction engine events. Merges delivery fields into merge entries. Skips derived moves when the engine reports them. Keeps the engine's `attempt`. Honours `notBefore`. Reports expired run leases to the engine. Hosts the delivery pump. |
| `factory-hub/src/observation.js` | Passes engine states to metrics. Accepts the subject kind for interaction events. |
| `factory-hub/src/config.js`, `config/hub.example.json` | Add `deliveryDatabasePath`. |
| `factory-hub/test/hub.test.js` | The production default now rejects an empty graph with `INVALID_WORKFLOW` instead of returning `503 ENGINE_UNAVAILABLE`. |
| `factory-delivery/src/{machine,queue,store}.js` | Add a `withdraw` action for waiting entries, used when a run stops. |
| `factory-node/src/{executors,node,index}.js` | An `accounts` section uses the built-in adapter. `bind({ machineId })` runs after enrollment. |
| READMEs | Hub, node and e2e documentation. |

## Verification

Run on macOS with Node v24.22.0 and Git 2.54.0, after `source ~/.nvm/nvm.sh && nvm use 24`:

| Command | Result |
| --- | --- |
| `npm test` | 261 passed, 0 failed, about 26 s |
| `npm run test:e2e` | 2 passed, about 3 s |
| `node --test packages/factory-hub/test/workflow-adapter.test.js` | 1 passed. Covers a lost lease retried by the engine, `notBefore`, a fenced stale result and a verdict-less review retried as an error. |
| `node --test packages/factory-node/test/accounts-integration.test.js` | 2 passed |

The build e2e passed in 5 of 5 repeated runs before the merge with main and in every run after it. The e2e tests are part of `npm test`.

## Gaps and contract requests

- **Architecture doc:** `docs/architecture.md` was not edited. It should record the following:
  - `deliveryDatabasePath`
  - speculative Jobs carrying `delivery: { queueId, mergeEntryIds }`
  - MergeEntry `queueId`, `mergedRevision` and `deliveryError`
  - project metrics `runs` and per-bottleneck `runId`
  - the rule that lost leases on run work are engine retries
- **GitHub merging:** merge entries for remote or GitHub repositories stay queued with `deliveryError`. Main's new GitHub publication strategies are not wired into the hub.
- **Delivery throughput:** the hub runs the queue's Git work in-process, outside the request serializer. Each sync step is serialized with requests. It has not been load-tested.
- **Stopped runs:** a stopped run's merge entry can be withdrawn only while it is waiting. An entry under test is cancelled through its job. An entry already in the atomic publish step may still merge.
- **Project metrics:** p90 is an upper bound, not an exact merged percentile.
- **Executors and accounts:** the node does not acquire accounts itself; acquisition belongs to the executor, which `factory-t3` must implement. Assignments carry no repository field, so the e2e executor is given the repo path directly. A real executor needs the project repo, either from the hub or through T3 project configuration.
- **Not verified:** a live T3 harness, real accounts, multiple machines, remote Git, crash and restart during a pump, and lease expiry under a live node daemon.
