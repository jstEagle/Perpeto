# Factory end-to-end tests

`node:test` suites that run the factory pieces together in one process tree: a real hub on an ephemeral port with temporary SQLite and secrets, a real node daemon enrolled with a one-time code, and a temporary bare Git repository standing in for the project remote. Nothing calls a model; a test executor registered on the node plays every role.

```sh
source ~/.nvm/nvm.sh && nvm use 24
npm run test:e2e   # both suites, about 3 seconds
npm test           # also discovers them
```

## What runs

`build-run.test.js` runs the default `build` template with every harness pointed at the `fake` provider, CI steps replaced by `git rev-parse HEAD` plus a content check, a 1-second builder retry backoff, and `expectedIterations: 1` on the review loop:

1. One input item; the planner returns two items.
2. Builders clone the bare repository, commit on `perpeto/<workItemId>` and push. The first `Farewell` build throws, the node reports a failed attempt, and the engine retries it after `notBefore`.
3. Reviewers reject each item once with `verdict: 'fail'`, then pass it. Builders address the feedback.
4. The node runs each CI job in a fresh clone at the item's exact head SHA.
5. The merge queue prepares a squash candidate, the node runs its speculative job on that candidate, and the queue publishes it to `main`.

It asserts the final Git state, work items, assignments, job revisions and logs, merge entries, events, run and project metrics (including `rework-loop` and `high-failure` evidence and builder errors/retries), usage records and an account snapshot delivered by heartbeat.

`architect.test.js` asks for a workflow draft. The architect's first reply is an invalid graph, so the hub retries with the validation errors; the second is saved as a draft version and activated. A follow-up request from the active version produces version 2 with a one-field diff, which is then activated.

## Not covered

A live T3 runtime or harness, real subscription accounts, remote Git or GitHub, more than one machine, and lease expiry under the node (that path is covered at the hub level in `packages/factory-hub/test/workflow-adapter.test.js`).
