# Factory delivery handoff

Implemented on `t3/factory-delivery`, based on `e02784f`. Changes are confined to `packages/factory-delivery/**` and this handoff. No upstream/runtime or shared architecture files changed. No push, merge, real GitHub mutation, or live credential test was performed.

## What exists

`@perpeto/factory-delivery` is a dependency-free Node 24 ESM library with JSDoc contracts and these root exports:

- `buildJob`, `normalizeCI`, `isEvidenceCurrent`, `checksPass`, `stableHash`: exact-revision CI definitions, canonical steps/requirements hashing, and fail-closed check evaluation. Evidence currency compares revision and config hash; it does not imply a passing result.
- `createQueueState`, `selectEntries`, `reduceQueue`: pure deterministic queue transitions. `MergeQueueStore` supplies SQLite WAL/FULL durability, immutable config, request receipts, and worker leases. `MergeQueue` advances one durable phase per idempotent `step` call.
- `LocalGitAdapter`: temporary isolated candidate worktrees in a bare repository, durable candidate refs, merge/squash/rebase, and an atomic ref transaction comparing the base plus every PR head before publishing the exact tested SHA.
- `GitHubAdapter`: repository-scoped CLI PR creation/lookup, check reads, and direct head-guarded merge methods using argv and stdin. All GitHub tests use an injected stub command runner.
- `branchName`, `pullRequestPolicy`: stable Git-safe branch policy and PR templates with work item, run, and evidence references. No automatic claims that linked evidence passed.

Queue behavior includes FIFO serial/batch selection, speculative merged-result Jobs, required checks, rejection reasons, retesting after base moves, rejection after head moves, recursive failed-batch bisection, cancellation of obsolete unfinished jobs, and restart reconciliation after Git publication. State transitions and public tick receipts commit atomically, so a crash before the response cannot advance a retried tick twice.

## Hub/workflow integration

Import the package directly from its root entry `packages/factory-delivery/src/index.js` until the lead adds workspace/package installation wiring. The root test discovery already finds delivery tests without changes to root scripts.

1. Store non-secret queue/CI configuration in JSON. Construct one queue per project/repository/base, with a dedicated delivery SQLite filename and a Git adapter scoped to that repository. Reopen using the same config; changing persisted config fails with `CONFLICT`.
2. For a `ci` gate, call `buildJob({config:node.config,workItem,projectId,repo})`; the work item must have its full `headSha`.
3. For a merge gate, enqueue the contract MergeEntry with an idempotency key. Optional `workItemId`/`runId` retain attribution for singleton candidates. Tick with a fresh key for new progress; replay the same key to retry a request.
4. Dispatch the persisted active speculative Job to the hub exactly once using `job.id` as the submission key. A batch shares one Job and omits singleton work item/run attribution; use the attempt's `entryIds` to identify its members.
5. Validate the node lease in the hub, then call `recordJobResult({id,revision,configHash,status,artifacts,logRef?,checks?},{idempotencyKey})`. The delivery package validates candidate/config identity, not node authority. Result statuses are `passed`, `failed`, `cancelled`, `error`.
6. Continue ticking to approve/publish or reject/requeue. Mirror delivery cancellations into hub job state. Make candidate Git objects available to remote runners before leasing a speculative job.

The [package README](../../packages/factory-delivery/README.md) contains runnable API examples and the adapter contract. `DeliveryError.toJSON()` supplies the shared error envelope. The transport owns authorization, safe error mapping, events, scheduling, and hub Job synchronization.

## Verification

Verified locally on Node `v24.22.0` and real temporary bare/working Git repositories:

- Delivery suite: **35 passed**. Real Node CI runs against the exact candidate commit; passing and deliberately failing source fixtures are included.
- Root `npm test`: **56 passed**, including existing messaging/client/launcher tests and all delivery tests.
- Scenarios include two serial PRs with pass/fail outcomes; conflicts within a batch; successful atomic batches; base/head movement; base/head races at publication; recursive four-entry bisection with a restart between groups; missing/stale evidence; queued-job cancellation; every local merge method; independent SQLite connections and lease expiry; identical/conflicting retries; restart during CI; restart after Git publish before DB acknowledgement; and a crash after a phase transition before its tick response.
- Stubbed GitHub coverage verifies literal multiline PR bodies via stdin, existing-PR recovery, check mapping, merge/squash/rebase head guards, merged/pending responses, stale heads, malformed/failed subprocess responses, and queue rejection of adapters without atomic guards.

This is package-level verification. It is not a hub/node/workflow end-to-end run, a remote-machine test, or live GitHub acceptance.

## Contract requests and remaining work

**GitHub speculative publication is intentionally blocked.** The [GitHub CLI merge interface](https://cli.github.com/manual/gh_pr_merge) guards the PR head but offers no atomic comparison with the tested base. `GitHubAdapter.atomicMerge` is false; the queue throws `ATOMIC_MERGE_UNSUPPORTED` and retains the durable merging phase. The standalone `mergePullRequest` helper exists, but bypassing the queue guard would weaken the tested-base guarantee. Select/implement a protected native GitHub queue integration before enabling automatic GitHub queue publication. No shared contract was edited to hide this limitation.

Private persistence metadata extends existing objects: Jobs carry `queueAttemptId`; MergeEntries can carry `workItemId`, `runId`, and `mergedRevision`. Additional externally produced check evidence uses `checks:[{name,status,revision,configHash}]`; whole-job passes already prove named job steps. The lead should standardize these extensions if they become cross-package API fields. Standalone forge helpers recover through PR lookup/current forge state but do not supply durable same-key/body receipts; wrap those helpers with the hub's request-idempotency layer.

Hub/workflow mounting, job outbox dispatch/cancellation, candidate transfer to runners, live GitHub/auth verification, and CI scale acceptance remain outside this package. GitHub candidate preparation requires a host-synchronized mirror. Historical jobs/receipts/candidate refs have no retention policy yet. A hard crash during Git preparation can leave a temporary worktree for operator cleanup; normal completion removes it.
