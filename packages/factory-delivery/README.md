# Factory delivery

Dependency-free Node 24 ESM library for CI definitions, PR policy, and durable local merge queues. It does not execute CI, serve HTTP, or call a harness. See the [shared architecture](../../docs/architecture.md).

```sh
source ~/.nvm/nvm.sh && nvm use 24
node --test packages/factory-delivery/test/*.test.js
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
    method: 'merge', requiredChecks: ['test'], ci,
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

Each completed `step`, enqueue, and result request has a durable SQLite receipt. Repeating a key and body returns the original snapshot, even after further work. Different bodies with the same key fail with `IDEMPOTENCY_CONFLICT` (409). Use a new tick key when requesting new progress. The queue config is immutable on reopen. Use a dedicated delivery DB; this package owns its schema version. Create its parent directory before opening it. `DeliveryError.toJSON()` returns the contract's `{error:{code,message}}`; host transports own HTTP mapping and authorization.

`createQueueState`, `reduceQueue`, and `selectEntries` are pure exports for engine integration. Their transition actions are internal orchestration input, not an authorization boundary. `MergeQueueStore` wraps them with transactions, receipts, and fenced worker leases. One `step` worker holds the queue at a time; independent processes get `BUSY`. If a process dies, the default lease expires after 60 seconds. A stale worker cannot persist a transition. Base/head comparison in the adapter's publication transaction protects against a slow worker publishing after another worker took over.

The hub must validate its node lease before accepting `recordJobResult`, register/dispatch each persisted Job idempotently, and cancel superseded queued jobs. The delivery store preserves cancelled obsolete jobs and historical evidence; the hub must mirror those cancellations. Batch jobs omit work item/run attribution because they can contain several work items; `active.entryIds` identifies the membership. Individual entries carry the shared `jobId`.

### Queue behavior

- Serial takes one queued entry; batch takes up to `batchSize` in FIFO order. Both test a synthetic commit incorporating the base and every selected PR head before publication.
- Changing the base requeues the attempt, cancels unfinished obsolete jobs, and creates a new candidate/job. Changing a PR head rejects that entry; enqueue the new revision with a new entry id.
- Conflicts reject the conflicting entry with a reason; remaining batch entries return to the front. Failed or incomplete required checks bisect batches recursively, then reject a failing singleton. Later halves test against the base produced by earlier successful halves.
- Preparing, testing, and merging are persisted separately. Restarting during testing retains the same candidate and Job. Restarting after Git publication recognizes the candidate in base ancestry and completes the SQLite acknowledgement without merging again.
- CI failure, cancellation, and runner error are terminal results for the attempt. A singleton is rejected; a batch is split. Transient adapter/transport failures throw and retain the durable phase for retry.

## Adapter contract

Adapters expose async methods:

```js
getBase(baseBranch)                     // full SHA
getHead(entry)                          // full SHA at entry.prUrl
prepare({ baseSha, entries, method, idempotencyKey }) // { revision }
isMerged({ baseBranch, revision })      // whether candidate has already been published
merge({ baseBranch, baseSha, revision, entries, method, idempotencyKey })
// -> { status: 'merged', revision } | { status: 'base_changed'|'head_changed' }
```

`prepare` must be repeatable for an attempt and keep its candidate reachable across restart. `merge` must publish the exact candidate, comparing the tested base and all selected PR heads atomically. Only adapters providing this guarantee may set `atomicMerge = true`. The host should scope an adapter to the queue's repository. `createPullRequest` and `readChecks` are optional forge helper methods outside the queue publish interface.

### Local Git

`LocalGitAdapter` requires a bare repository for mutations. PRs are branches addressed as `local:<short-branch-name>`. Preparation uses a fresh temporary detached worktree, with hooks/signing disabled and a fixed factory commit identity/date. All three methods (`merge`, `squash`, `rebase`) produce a durable candidate under `refs/perpeto/candidates/`. Publication uses one `git update-ref --stdin` transaction to verify the branch heads and compare-and-swap the base. The base points to the exact revision CI tested. Preparing an already-cached attempt reuses its candidate.

Normal completion removes temporary worktrees. A hard process/OS crash during preparation can leave a temporary worktree for operator cleanup; the next attempt uses a fresh one. Candidate refs, historical jobs, and receipt rows are intentionally retained; no pruning/retention policy is implemented. The hub must make candidate objects available to remote user-owned runners, for example by fetching the candidate refs into a runner mirror. The adapter does not transfer objects across machines.

### GitHub CLI

`GitHubAdapter({repository:'owner/name',runner?,candidateAdapter?})` provides:

- `createPullRequest({branch,baseBranch,title,body})`: checks for an existing open PR, then uses `gh pr create` with the literal body on stdin.
- `getBase`, `getHead`, `readChecks({prUrl})`: repository-scoped reads. Checks identify the actual head, without inventing a config hash.
- `mergePullRequest({prUrl,headSha,method})`: direct head-guarded `gh pr merge --match-head-commit`; returns `merged` only after reading a completed merge, otherwise `pending`. Retries detect an already-merged PR.

All invocations use argv without a shell. Authentication stays in the user's existing `gh` credential store. Command failures expose generic messages, never raw subprocess output. The injected runner signature is `(command,args,{cwd?,env?,input?,timeoutMs?}) => Promise<{exitCode,stdout,stderr}>`.

**GitHub queue publication is deliberately unsupported:** the [GitHub CLI merge interface](https://cli.github.com/manual/gh_pr_merge) supplies a head guard but no atomic compare-and-swap against the tested base. The queue refuses publication with `ATOMIC_MERGE_UNSUPPORTED`; directly calling `mergePullRequest` supplies only the head guard. A future protected/native GitHub queue adapter must implement and verify the stronger invariant. `candidateAdapter` can prepare commits from a mirror whose objects the host already fetched; this library does not sync the mirror. Standalone forge helpers do not provide durable same-key/body receipts; wrap them at the host request boundary. The queue's own commands do provide those receipts.

## PR policy

`branchName({workItem,runId?})` returns a stable `perpeto/<run>/<title>-<identity-digest>` branch. `pullRequestPolicy({workItem,run,evidence})` returns `{branch,title,body}` with the work item, run, and evidence references. Attach optional `url` fields to work item/run data to make them links; evidence items take `{label,url}`. Evidence links are listed without asserting that they passed. Link schemes and embedded credentials are validated.

## Verification scope

Tests run actual Git commands only against temporary local repositories. They exercise real Node CI for candidate commits, serial/batch passes and failures, conflicts, base/head changes (including publication races), all merge methods, bisection, stale evidence, worker fencing, durable request receipts, and restart before/after publication. GitHub commands are stubbed; no test accesses a real forge. Hub/workflow wiring, remote runner transfer, protected GitHub integration, and live credentials are not verified here.
