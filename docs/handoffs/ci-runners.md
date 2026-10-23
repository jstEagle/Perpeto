# CI runner pools and repository pipelines handoff

Worker D, 23 October 2026, branch `worktree-agent-a545abd7bff71914d` from main `4316b1d`. Justus asked for CI runners as part of the full software factory. Nothing was pushed or merged, and no real machine other than loopback test daemons on this Mac ran a job.

## What is built

- **Pipeline configuration** (`packages/delivery/src/pipelines.js`, exported from `@perpeto/delivery`): `.perpeto/ci.json` version 1 with named pipelines, jobs with steps, `needs` (cycle-checked DAG), matrix (up to 64 combinations), `runsOn` (pool, os, labels), `timeoutSec`, non-secret `env`, `cache` keys with `hashFiles`, size-capped `artifacts`, `retry`, and `manual`/`merge-queue`/`pull-request`/`schedule` triggers. Validation returns every problem with a JSON path. The schema is documented in [the CI guide](../guides/ci.md).
- **Hub pipeline runs** (`apps/hub/src/ci/`): `PipelineRun` entities, configuration from the repository file at the exact revision (hub-held repositories) or a project-level fallback (`PUT /projects/:id/ci-config`). Jobs are created only once their needs passed; failures skip dependents; policy and manual retry; cancel; superseding by ref; flaky detection; duration, queue wait and utilisation insights. Routes and entities are in [the architecture contract](../architecture/README.md#ci-pipelines-and-runner-pools).
- **Gates**: a workflow `ci` node may name `pipeline` instead of `steps`, and merge-queue `requiredChecks` may name pipelines. Both become proxy Jobs that the hub completes from the pipeline outcome; the engine and `@perpeto/delivery` see one ordinary job result. Merge candidates run pipelines at the candidate revision from the queue's repository.
- **Runner pools** (`apps/hub/src/ci/runners.js`, node `runner` config): pools with their own concurrency and runner labels in heartbeats, separate from agent slots, so a machine can be agents-only, CI-only or both. Leasing honours pools and labels and interleaves projects, fewest running jobs first.
- **Node runner** (`apps/node/src/job.js`, `ci-cache.js`, `artifacts.js`): pipeline env (reserved names refused), whole-job timeout, per-project dependency cache with `hashFiles` keys, LRU eviction above `runner.cacheMaxBytes` and symlink-escape guards, artifact collection (regular files inside the checkout only, capped) uploaded in 512 KiB chunks through the lease-checked event route. `ciCacheRoot(config)` exposes the cache root for the storage janitor (`ci-cache` kind).
- **Logs and artifacts on the hub** (`apps/hub/src/ci/store.js`): logs already streamed in chunks during a step; the hub now caps them per job (`ci.logMaxBytesPerJob`), masks common credential formats, the owner token and `ci.redactPatterns`, pages by cursor, and deletes them after `ci.logRetentionMs`. Artifacts are written at the node's offsets (retries are idempotent), digest-checked, capped per job and swept after `ci.artifactRetentionMs`.
- **CLI**: `perpeto ci run <pipeline> [--rev] [--ref] [--project]`, `ci status`, `ci logs <job> [--follow]`, `ci validate [--file]` (offline).
- **Clients**: web CI screen (`/projects/:id/ci`, run detail with job DAG, live log, cache, artifacts, runners, flaky list, duration trends) and the Apple CI list and detail with a polling log, both with demo data.

Shared hot files touched, all small and additive: `apps/hub/src/hub.js` (construct `HubPipelines`, lease pool slots and fair-share order, heartbeat `runner`, route dispatch, log/artifact/started/finished/head hooks, `cancelWork` hook and no cancellation record for unleased proxies, maintenance tick, bundle repository lookup), `apps/hub/src/index.js` (artifact download), `apps/hub/src/config.js` (`ci` key), `apps/hub/src/delivery/index.js` (pipelines in queue records and candidate jobs), `apps/node/src/node.js` (cache, heartbeat runner, protected cache path), web nav/router/shell, Apple navigation.

## How it was verified

Node `v24.22.0` on macOS, isolated temp directories only.

| Command | Result |
| --- | --- |
| `npm test` (root) | 646 passed, 0 failed, three consecutive full runs after the last fix |
| `cd apps/web && npx vitest run && npx tsc --noEmit` | 154 passed; typecheck clean |
| `cd apps/apple && swift test` | 120 passed |

New tests: `packages/delivery/test/pipelines.test.js` (schema, expansion, every error path), `packages/workflow/test/ci-pipeline.test.js`, `apps/hub/test/ci.test.js` (DAG, retry policy, flaky, manual retry, pools/labels/fair share, cancel and supersede, log cap/redaction/paging, artifact chunks/gaps/digest/caps/download/retention, config sources, schedules), `apps/node/test/ci-runner.test.js` (env, cache hit/miss/namespace/LRU/symlinks, artifacts, timeout, runner config), `apps/cli/test/ci.test.js`, and two e2e suites. `tests/e2e/test/ci-pipelines.test.js` runs a temp repository's `.perpeto/ci.json` with a 3-job DAG and a 2-way matrix across two loopback node daemons in different pools, checks a log line reaches the hub while its step still runs, downloads the collected artifact, and sees cache hits on the second run. `tests/e2e/test/ci-pipeline-gates.test.js` drives a workflow whose ci node and merge-queue required check name a pipeline to a real merge, and a failing pipeline to a failed gate with skipped dependents.

Screenshots: `apps/web/screenshots/ci/` (light and dark, desktop and mobile) and `apps/apple/screenshots/ci/`, reviewed.

## Not verified or not built

- No second physical machine, hosted CI, Windows or Linux runner, or live GitHub repository was used. Linux sandboxing (bwrap) is unchanged and untested here.
- The hub reads `.perpeto/ci.json` only from repositories it holds (local projects and merge-queue mirrors). GitHub projects outside the merge queue use the project-level config; the hub does not fetch the remote for pull-request or schedule triggers.
- Pull-request triggers fire on agent-reported head commits, not on forge webhooks. Schedules need a hub-held default branch.
- Cache copies use `fs.cp`; large `node_modules` trees are copied, not cloned (no APFS clonefile or hardlinks). Cache entries are trusted within a project: a job can poison its own project's cache for later runs of the same key.
- Artifact uploads go through JSON events (base64), so very large artifacts are slow; caps keep them bounded. Log redaction on the hub is pattern-based and chunk-local, a backstop for the node's line-level redaction.
- Utilisation counts job start to finish, including checkout; queue wait runs from queue to the `started` event.
- A merge queue whose required pipelines change on the default branch gets a new queue identity, because the pipeline list is part of the queue digest. Worker C's merge-queue changes may restructure `queueRecord`; the naming contract above is the stable part.
- Pipeline runs and flaky records are retained for `ci.runRetentionMs` and then deleted, not archived.
