# Delivery

Dependency-free Node 24 ESM library for CI definitions, PR policy, and durable local merge queues. It does not execute CI, serve HTTP, or call a harness. See the [shared architecture](../../docs/architecture/README.md).

```sh
source ~/.nvm/nvm.sh && nvm use 24
node --test packages/delivery/test/*.test.js
npm test -w @perpeto/delivery       # same suite through the workspace script
```

## CI jobs and evidence

```js
import { buildJob, isEvidenceCurrent } from './src/index.js';

const ci = {
  steps: [{ name: 'test', run: 'node --test', timeoutSec: 120 }],
  requirements: { os: 'linux', labels: ['node-24'] },
};
const job = buildJob({
  config: ci,
  workItem: { id: 'wi_example', runId: 'run_example', headSha },
  projectId: 'prj_example', repo: { url: '/path/to/repo.git', defaultBranch: 'main' },
});
// Only identity matching. Check result.status separately before treating it as a pass.
isEvidenceCurrent(result, job);
```

`revision` must be a full lowercase SHA-1 or SHA-256 commit ID. `configHash` is SHA-256 of canonical JSON `{steps,requirements}`. Object keys are sorted; step order matters; label/provider sets are sorted and deduplicated. Changing a step command, timeout, requirement, or revision invalidates prior evidence. The configuration and work item are copied, never mutated. Put non-secret configuration in JSON files passed by the caller. Never embed credentials in commands, repository URLs, PR text, or evidence references.

`checksPass(job, requiredChecks)` requires a passed job. Named job steps are proven by the whole-job pass. Additional check records must be `{name,status:'passed',revision,configHash}` matching that job. Explicit check records override inference from a named step. A check for a PR head cannot prove the later speculative merged revision. Skipped/neutral GitHub checks do not count as passes.

## Durable queue integration

```js
import { LocalGitAdapter, MergeQueue, MergeQueueStore } from './src/index.js';

const store = new MergeQueueStore('/path/to/delivery.sqlite');
const queue = new MergeQueue({
  store, queueId: 'mq_project_main',
  config: {
    projectId: 'prj_example', repo: { url: '/path/to/repo.git', defaultBranch: 'main' },
    baseBranch: 'main', strategy: 'batch', batchSize: 8,
    method: 'merge', publication: 'fast-forward-push', requiredChecks: ['test'], ci,
  },
  adapter: new LocalGitAdapter({ repository: '/path/to/repo.git' }),
});

queue.enqueue({
  id: 'mq_entry', projectId: 'prj_example', prUrl: 'local:perpeto/feature',
  headSha, baseBranch: 'main', workItemId: 'wi_example', runId: 'run_example',
}, { idempotencyKey: 'enqueue:work-item-revision' });

await queue.step({ idempotencyKey: 'tick:1' }); // Reserve FIFO entries and exact base.
await queue.step({ idempotencyKey: 'tick:2' }); // Prepare candidate and persist a queued Job.
const job = queue.state.jobs.find(job => job.id === queue.state.active?.jobId);
// Hub: durably enqueue this exact job once, using job.id as its submission key.
// Node: check out job.revision in isolation and execute its steps.
queue.recordJobResult({
  id: job.id, revision: job.revision, configHash: job.configHash,
  status: 'passed', artifacts: [],
}, { idempotencyKey: `result:${job.id}` });
await queue.step({ idempotencyKey: 'tick:3' }); // Check evidence and enter merging.
await queue.step({ idempotencyKey: 'tick:4' }); // Atomically publish tested candidate.
store.close();
```

Each state-changing `step`, enqueue, withdrawal, rejection, and result request has a durable SQLite receipt. Repeating a retained key and body returns the original snapshot, even after further work or restart. Different bodies with the same retained key fail with `IDEMPOTENCY_CONFLICT` (409). Receipts store a compact revision pointer; shared inverse edits reconstruct historical responses without copying the entire queue into every receipt. Unchanged testing/publication polls and idle ticks store neither receipts nor history. Their keys are not reserved, so use a new tick key when requesting new progress.

`new MergeQueueStore(filename, { maxReceipts: 10_000, receiptRetentionMs: 604_800_000 })` sets the per-queue receipt limit and retention window (defaults: 10,000 receipts and seven days). Opening the store and dispatching mutations prune expired/excess receipts and history no retained receipt needs. Expired receipts cannot replay an old response or guarantee deduplication; entity IDs and current phase checks still apply. SQLite reuses freed pages; pruning does not shrink the database file automatically. Schema 1 stores migrate transactionally, retaining their responses as inverse edits. Queue entries, jobs, and Git candidate refs remain historical records outside receipt retention.

The queue config is immutable on reopen. Use a dedicated delivery DB; this package owns its schema version. Create its parent directory before opening it. `DeliveryError.toJSON()` returns the contract's `{error:{code,message}}`; host transports own HTTP mapping and authorization.

`createQueueState`, `reduceQueue`, and `selectEntries` are pure exports for engine integration. Their transition actions are internal orchestration input, not an authorization boundary. `MergeQueueStore` wraps them with transactions, receipts, and fenced worker leases. One `step` worker holds the queue at a time; independent processes get `BUSY`. If a process dies, the default lease expires after 60 seconds. A stale worker cannot persist a transition. Publication fencing depends on the adapter: local Git compares base and heads in one transaction; GitHub uses the strategy-specific safeguards below. A worker lease alone cannot fence a remote Git push.

The hub must validate its node lease before accepting `recordJobResult`, register/dispatch each persisted Job idempotently, and cancel superseded queued jobs. The delivery store preserves cancelled obsolete jobs and historical evidence; the hub must mirror those cancellations. Batch jobs omit work item/run attribution because they can contain several work items; `active.entryIds` identifies the membership. Individual entries carry the shared `jobId`.

Only jobs with `status === 'queued'` should count as missing work to submit to the hub. A cancelled historical job that was never mirrored must not keep the hub ticking an otherwise finished queue. An open queue has an active attempt or entries with `status === 'queued'`; terminal job history does not make it open.

### Permanent failures and cancellation

```js
// Host retry policy: persist a bounded retry count, for example three attempts,
// then reject the offending entry with a safe reason (never subprocess output).
queue.rejectEntry({
  entryId: 'mq_entry', reason: 'PR branch unavailable after 3 attempts.',
}, { idempotencyKey: 'reject:mq_entry:missing-branch' });

// Run cancellation also releases an entry already preparing/testing/merging.
queue.withdraw({ entryId: 'mq_stopped_entry', reason: 'Run stopped.' }, {
  idempotencyKey: 'withdraw:mq_stopped_entry',
});
```

Both methods synchronously mark the entry `rejected`, retain the supplied reason, cancel an unfinished speculative Job, and clear its active attempt. Surviving batch members return to the front for fresh speculative CI. Late results for the released attempt fail with `STALE_ATTEMPT`. Retained-key retries return the original response; a new request against a terminal entry fails with `CONFLICT`. Rejection/withdrawal acquire the queue's worker lease and return `BUSY` if a tick owns it, so the host should retry after that tick. Missing entries return `NOT_FOUND`. Hosts own authorization, retry counts, permanent-error classification (such as unsupported PR URLs), and mirroring entry/job outcomes into runs. These APIs do not undo a remote publication that already happened; reconcile forge state before rejecting a potentially published attempt.

### Queue behavior

- Serial takes one queued entry; batch takes up to `batchSize` in FIFO order. Both test a synthetic commit incorporating the base and every selected PR head before publication. Native GitHub publication requires `strategy: 'serial'`; batches are refused before any work to avoid partial native batch publication.
- Changing the base requeues the attempt, cancels unfinished obsolete jobs, and creates a new candidate/job. Changing a PR head, including during batch publication, rejects only that entry; enqueue the new revision with a new entry id.
- Conflicts reject the conflicting entry with a reason; remaining batch entries return to the front. Failed or incomplete required checks bisect batches recursively, then reject a failing singleton. Later halves test against the base produced by earlier successful halves.
- Preparing, testing, and merging are persisted separately. Restarting during testing retains the same candidate and Job. Restarting after Git publication recognizes the candidate in base ancestry and completes the SQLite acknowledgement without merging again.
- CI failure, cancellation, and runner error are terminal results for the attempt. A singleton is rejected; a batch is split. Branch-protection publication failures reject the attempt with a safe reason. Transient adapter/transport failures throw and retain the durable phase for retry.

## Adapter contract

Adapters expose async methods:

```js
getBase(baseBranch, publication?)       // full SHA
getHead(entry)                          // full SHA at entry.prUrl
prepare({ baseSha, entries, method, idempotencyKey }) // { revision }
isMerged({ baseBranch, revision })      // whether candidate has already been published
merge({ baseBranch, baseSha, revision, entries, method, idempotencyKey, publication, evidence, publicationState })
// -> { status: 'merged', revision, publication? }
//  | { status: 'base_changed' } | { status: 'head_changed', entryId }
//  | { status: 'pending', publicationState } | { status: 'rejected', reason }
```

`prepare` must be repeatable for an attempt and keep its candidate reachable across restart. `merge` owns publication recovery and PR finalization, including retries after remote publication. `atomicMerge = true` now declares an atomic publication mechanism, with the distinct guarantees below. It no longer implies that every adapter has local Git's multi-ref base/head compare-and-swap. Fast-forward mode must confirm the exact tested candidate; native GitHub mode may return GitHub's actual merge SHA tagged `publication: 'github-merge-queue'`. Entries retain both `testedRevision` and `mergedRevision`. A pending result keeps the durable merging phase and `active.publicationState`; ticks observe forge state again. The host should scope an adapter to the queue's repository. `createPullRequest` and `readChecks` are optional forge helper methods outside the queue publish interface.

`head_changed` identifies the changed entry with `entryId`. For compatibility, the queue rereads heads if an older adapter omits it. If no changed entry can be identified, it throws `ADAPTER_ERROR` and retains the attempt rather than rejecting unrelated batch members.

### Local Git

`LocalGitAdapter` requires a bare repository for mutations. PRs are branches addressed as `local:<short-branch-name>`. Preparation uses a fresh temporary detached worktree, with hooks/signing disabled and a fixed factory commit identity/date. All three methods (`merge`, `squash`, `rebase`) produce a durable candidate under `refs/perpeto/candidates/`. Publication uses one `git update-ref --stdin` transaction to verify the branch heads and compare-and-swap the base. The base points to the exact revision CI tested. Preparing an already-cached attempt reuses its candidate.

Normal completion removes temporary worktrees. A hard process/OS crash during preparation can leave a temporary worktree for operator cleanup; the next attempt uses a fresh one. Candidate refs and historical jobs are intentionally retained; receipt retention is configured on `MergeQueueStore` as described above. The hub must make candidate objects available to remote user-owned runners, for example by fetching the candidate refs into a runner mirror. The adapter does not transfer objects across machines.

### GitHub CLI

`GitHubAdapter({repository:'owner/name',runner?,candidateAdapter?,gitRepository?,publication?})` provides:

- `createPullRequest({branch,baseBranch,title,body})`: checks for an existing open PR, then uses `gh pr create` with the literal body on stdin.
- `getBase`, `getHead`, `readChecks({prUrl})`: repository-scoped reads. Checks identify the actual head, without inventing a config hash.
- `mergePullRequest({prUrl,headSha,method})`: direct head-guarded `gh pr merge --match-head-commit`; returns `merged` only after reading a completed merge, otherwise `pending`. Retries detect an already-merged PR.

All invocations use argv without a shell. Authentication stays in the user's existing `gh` credential store. Command failures expose generic messages, never raw subprocess output. The injected runner signature is `(command,args,{cwd?,env?,input?,timeoutMs?}) => Promise<{exitCode,stdout,stderr}>`.

#### Fast-forward publication (default)

Configure `publication: 'fast-forward-push'` on the merge-queue node's config or adapter. An explicit queue config wins over the adapter default. The host must supply a synchronized candidate adapter (normally `LocalGitAdapter`) and a Git mirror containing its candidate objects. `gitRepository` defaults to `candidateAdapter.repository`. Configure the mirror's single `origin` fetch/push URL to the same intended repository as `repository: 'owner/name'`; differing push URLs and multiple URLs are refused. This package does not establish that repository identity or sync the mirror for the host.

After speculative CI, the adapter takes the expected old value explicitly as `baseSha`, reads it using `git ls-remote origin refs/heads/<base>`, checks the candidate's first-parent chain and merge shape, and rereads each PR's exact head/base/open state. It reads the expected remote base again immediately before:

```sh
git push origin <testedMergedSha>:refs/heads/<base>
```

There is no force, `+` refspec, or force-with-lease. Merge, squash and rebase candidates are prepared in their final shape before CI; publication never regenerates them. The remote's [fast-forward rules](https://git-scm.com/docs/git-push#_push_rules) reject a divergent concurrent base advance. An observed base change requeues the entry for a new candidate/job. The adapter reads `ls-remote` after the push and verifies the candidate is the remote tip or an ancestor of it, fetching the observed immutable SHA if needed. That ancestry also recovers publication after a crash, including when the base advanced again before restart.

**Guarantee boundary:** ordinary `git push` has no non-force option accepting an exact caller-specified old SHA. The explicit `baseSha` is checked before/after, not transmitted as a compare-and-swap lease. A base rewind/deletion or movement to another ancestor of the candidate between the last read and push may still be accepted. PR heads cannot be atomically compared with the base update; a late head/base retarget causes finalization to stop for manual reconciliation after publication. Use a protected, monotonic base and control concurrent PR-head writers, or select GitHub's native queue. `atomicMerge = true` describes the atomic remote ref update here, not a multi-ref base/head transaction.

For `method: 'merge'`, delivery stays pending until GitHub reports each PR as `MERGED`. For squash/rebase, GitHub cannot infer head containment. The adapter uses `gh pr close --comment` with the published commit URL, passed job id, revision, config hash and attempt reference, plus HTTP(S) log/artifact links when supplied, then confirms closure. Such PRs remain **CLOSED**, not GitHub **MERGED**; the Perpeto delivery entry records their published/tested SHA. A retry skips already closed PRs and never republishes a candidate found in base ancestry. A crash inside GitHub's comment-plus-close operation can leave a duplicate audit comment on retry; there is no forge-side idempotency key. Terminal protection/rules failures are classified internally and reject the queue entry with a generic actionable reason; subprocess text never becomes the public reason. Transport errors retain the phase for retry.

#### GitHub native merge queue

Set `publication: 'github-merge-queue'` and `strategy: 'serial'`. Perpeto still prepares and tests its speculative candidate first. Before submitting, the adapter reads the PR's GraphQL `mergeQueue` to verify the base has a native queue, then invokes `gh pr merge --auto --match-head-commit <headSha>`. It never supplies `--admin`. [GitHub CLI](https://cli.github.com/manual/gh_pr_merge) enables auto-merge while required checks are outstanding, or enqueues the PR when ready. No ordinary auto-merge fallback is intentionally permitted if the base has no native queue.

Ticks track `github-auto-merge-enabled`, `github-queued`, and eventual `MERGED` state. Restart observes an existing auto-merge request/queue entry without resubmitting. Once a recorded queued/auto-merge state disappears, the entry is rejected for inspection rather than enqueued forever. A head change, close, retarget, or branch-protection rejection is terminal. Native publication ignores later base movement while waiting, since GitHub owns that ordering and final atomicity (`atomicMerge = true`). Queue configuration must remain enabled while submission runs; repository administrators can change it outside this transaction.

**Tradeoff:** GitHub chooses the final base, merge-group checks, and repository queue merge method. Its final SHA can differ from Perpeto's speculative job, so `testedRevision` is preliminary evidence and `mergedRevision` is the observed GitHub merge SHA. Configure GitHub-required merge-group CI independently; this package does not install workflows or claim that Perpeto's job tested GitHub's final commit. Batch native publication is not implemented.

Standalone forge helpers do not provide durable same-key/body receipts; wrap them at the host request boundary. The queue's own commands do provide those receipts. Reopening a legacy queue without a `publication` field normalizes it to the default without discarding active attempts or receipts; other configuration changes still conflict.

## PR policy

`branchName({workItem,runId?})` returns a stable `perpeto/<run>/<title>-<identity-digest>` branch. `pullRequestPolicy({workItem,run,evidence})` returns `{branch,title,body}` with the work item, run, and evidence references. Attach optional `url` fields to work item/run data to make them links; evidence items take `{label,url}`. Evidence links are listed without asserting that they passed. Link schemes and embedded credentials are validated.

## Verification scope

Tests run actual Git commands only against temporary local repositories. They exercise real Node CI for candidate commits, serial/batch passes and failures, conflicts, base/head changes (including publication races), all merge methods, bisection, stale evidence, worker fencing, durable request receipts, and restart before/after publication. GitHub commands are stubbed; fast-forward publication uses a separate temporary bare mirror and bare `origin`, including real candidate CI, non-fast-forward races, squash/rebase closure, and crash recovery. Native queue tracking uses stubbed GraphQL/CLI responses; no test accesses a real forge. Hub/workflow wiring, remote runner transfer, protected GitHub integration, and live credentials are not verified here.
