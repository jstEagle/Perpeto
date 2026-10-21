# Factory delivery handoff

Originally implemented on `t3/factory-delivery`. GitHub publication follow-up is on `t3/github-merge-publication`, based on `13cdd2d`. Changes are confined to `packages/factory-delivery/**` and this handoff. No upstream/runtime or shared architecture files changed. No real remote push, merge, GitHub mutation, or live credential test was performed. Git pushes in tests target temporary local bare repositories only.

## What exists

`@perpeto/factory-delivery` is a dependency-free Node 24 ESM library with JSDoc contracts and these root exports:

- `buildJob`, `normalizeCI`, `isEvidenceCurrent`, `checksPass`, `stableHash`: exact-revision CI definitions, canonical steps/requirements hashing, and fail-closed check evaluation. Evidence currency compares revision and config hash; it does not imply a passing result.
- `createQueueState`, `selectEntries`, `reduceQueue`: pure deterministic queue transitions. `MergeQueueStore` supplies SQLite WAL/FULL durability, immutable config, request receipts, and worker leases. `MergeQueue` advances one durable phase per idempotent `step` call.
- `LocalGitAdapter`: temporary isolated candidate worktrees in a bare repository, durable candidate refs, merge/squash/rebase, and an atomic ref transaction comparing the base plus every PR head before publishing the exact tested SHA.
- `GitHubAdapter`: repository-scoped CLI PR creation/lookup, check reads, and direct head-guarded merge methods using argv and stdin. GitHub commands use an injected stub runner in tests. Publication supports non-force exact-candidate pushes to a local bare origin fixture and GitHub native queue submission/tracking, with the guarantee differences below.
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

## GitHub publication follow-up

The previous intentional `ATOMIC_MERGE_UNSUPPORTED` block is replaced by two configured publication mechanisms. `publication: 'fast-forward-push'|'github-merge-queue'` is stored in delivery queue config; the default is `fast-forward-push`. A queue's explicit setting overrides the adapter default. The host must pass merge-queue node config through to delivery; shared workflow/hub files were not changed by this worker.

- **Fast-forward push:** supply a synchronized bare candidate mirror with `origin` pointing at the intended GitHub repository. `GitHubAdapter` uses `gitRepository` or defaults to `candidateAdapter.repository`. It refuses differing/multiple fetch/push URLs. It explicitly checks `baseSha` with `ls-remote`, validates the candidate first-parent chain and merge shape, reads each PR head/base/state, checks the expected base again, then runs `git push origin <testedSha>:refs/heads/<base>` without force or a lease. A post-push remote-tip/ancestry check confirms publication. Divergent base races requeue for fresh speculative CI. Protected-branch/rules rejection is terminal with a generic actionable reason.
- **PR finalization/recovery:** merge-method PRs must be observed as GitHub `MERGED`. Squash/rebase PRs are closed with a commit link, passed job/revision/config/attempt evidence and HTTP(S) artifact/log links when available. They remain GitHub `CLOSED`, with Perpeto recording delivery. Recovery checks remote ancestry before trying another push, then finishes PR finalization. Already closed PRs are skipped. A crash inside gh's separate comment/close actions can still duplicate a comment; no remote idempotency key exists.
- **Native GitHub queue:** serial only. Perpeto's candidate CI passes first; GraphQL must show a merge queue for the PR's base. Submission uses `gh pr merge --auto --match-head-commit`, without `--admin` or an explicit merge method. Durable pending state tracks auto-merge/queued status; restarts observe existing entries. Queue removal, disabled auto-merge, changed head, close, retarget and protection failures are terminal rather than resubmitted forever. Base advancement during native publication does not trigger Perpeto retesting; GitHub owns its final ordering and checks.

**Contract change and limits:** `atomicMerge = true` now declares an atomic publication mechanism rather than universally promising the original local multi-ref base/head comparison. The local adapter retains that stronger transaction. For GitHub fast-forward mode it means an atomic non-force remote ref update. Ordinary Git push cannot transmit a caller-selected exact old SHA without a force-capable lease. `baseSha` is explicit adapter input checked before/after; a rewind/deletion or movement to another candidate ancestor in the final read/push window may be accepted. PR-head changes are not atomically guarded; late changes stop finalization for manual reconciliation after publication. Use a protected monotonic base and control concurrent head writers, or use the native queue. The README explains this rather than claiming an unavailable CAS guarantee.

For native mode, GitHub may create a different final SHA and use its configured merge method. Entries now retain `testedRevision` for Perpeto's candidate and `mergedRevision` for the actual published/GitHub SHA. Configure GitHub-required merge-group CI independently. Native batch publication and partial-batch reconciliation are deliberately rejected rather than claimed as implemented. Repository queue configuration must stay enabled during submission; administrators can change it outside the API operation.

Legacy delivery snapshots lacking `publication` are normalized to the default while preserving attempts/jobs/receipts. Other config changes still conflict. The queue now always calls `adapter.merge` for merging/recovery, so adapters own forge finalization as well as Git publication; a bare `isMerged` result no longer bypasses PR bookkeeping.

## Verification

Verified locally on Node `v24.22.0`; Git repositories and actual pushes are temporary local fixtures. All `gh`/GraphQL operations are stubbed. `npm test`: **234 passed**, including **60 delivery tests** (25 publication tests plus the original 35). The publication suite also passes independently. `git diff --check` passes.

The publication suite exercises exact tested SHA publication for merge/squash/rebase and squash batches; real Node candidate CI; a divergent base race between the final read and push, followed by retest; observed base/head movement; protected-branch rejection without output leakage; wrong candidate shape/first-parent ancestry; mismatched origin push URL; PR closure and evidence comments; delayed GitHub merge state; restart after push and later base advance for every method; restart after PR closure; native CI gating, submission, waiting, restart, actual-vs-tested SHA, queue absence/removal, changed heads and protection failure; config validation/defaults/precedence; and legacy snapshot normalization.

Existing delivery tests retain serial/batch conflict/failure/bisection, exact evidence, atomic local base/head races, SQLite worker fencing, idempotency receipts and crash/restart coverage. This is package-level verification, not live protected GitHub acceptance or a hub/node/workflow end-to-end run.

## Contract requests and remaining work

Private persistence metadata extends existing objects: Jobs carry `queueAttemptId`; MergeEntries can carry `workItemId`, `runId`, and `testedRevision`/`mergedRevision`. Additional externally produced check evidence uses `checks:[{name,status,revision,configHash}]`; whole-job passes already prove named job steps. The lead should standardize these extensions if they become cross-package API fields. Standalone forge helpers recover through PR lookup/current forge state but do not supply durable same-key/body receipts; wrap those helpers with the hub's request-idempotency layer.

Hub/workflow mounting, job outbox dispatch/cancellation, candidate transfer to runners, live GitHub/auth verification, and CI scale acceptance remain outside this package. GitHub candidate preparation and fast-forward publication require a host-synchronized mirror, a correctly scoped origin and candidate object transfer. Host workflow/schema mounting must accept and forward `publication`; that integration is outside the owned paths. Historical jobs/receipts/candidate refs have no retention policy yet. A hard crash during Git preparation can leave a temporary worktree for operator cleanup; normal completion removes it.
