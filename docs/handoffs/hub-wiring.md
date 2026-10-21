# Hub wiring and crash recovery

Branch: `t3/hub-delivery-recovery`, based on Perpeto main `9881b7b`. Changes stay within `apps/hub/**`, `packages/sdk/**`, `tests/e2e/**`, `config/hub.example.json` and this handoff. **No factory-delivery fixes were needed.** Nothing was pushed or merged; no real GitHub repository was accessed or mutated.

## Implemented

- Every new workflow Assignment receives its project's `repo: {url, defaultBranch, localPath?}`, ignoring executor-supplied repository metadata. A queued assignment retains its original snapshot. Architect assignments copy the same shape, including retries. The existing node lease protocol preserves it unchanged; build and architect e2es assert both API and executor payloads. The build executor now uses Assignment.repo rather than a test-injected repository path.
- GitHub HTTPS/SSH clone URLs select factory-delivery's GitHub adapter. A GitHub PR URL also selects it when the configured origin is a local/remote Git repository. The hub owns an isolated bare candidate mirror, fetches each observed immutable base/head before preparation, and exposes the mirror URL to speculative jobs. Existing local-only PRs retain LocalGitAdapter.
- Merge-queue node `config.publication` selects `fast-forward-push` by default or `github-merge-queue` explicitly. Hub validation rejects unknown values and native batch mode. Queue configuration persists the selection. The hub mirrors `testedRevision` and `mergedRevision` separately, because GitHub's native queue can publish a different revision. Old unsupported queued entries are reconsidered, and successful admission clears deliveryError.
- FactoryClient defaults to `/api/v1/messaging`; JSON `messagingPrefix: "/api/perpeto"` retains T3-hosted compatibility. Actual MCP stdio sends against a real hub produce exactly one `agent.messaged` interaction when the same send is retried. Existing node-token authorization is unchanged; the client uses an owner credential for hub messaging.
- `GET /projects/:id/runs?status=` returns `{runs}` scoped to the project, newest first. Status filtering, empty results, unknown project/status, owner authorization and restart persistence are tested.

## Recovery fixes

`Hub.maintenance()` previously returned before its delivery pump call, making that call unreachable. A fresh process could load a queue without ever advancing it. Maintenance now finishes its serialized lease work and schedules delivery outside the request serializer, including at startup; remote I/O cannot block the HTTP listener from starting.

The queue-admission scan also previously ignored fully terminal delivery queues once their speculative jobs existed in the hub. A crash after delivery committed `merged` but before the hub projection committed would leave the run waiting forever. Pending terminal projections now stay eligible for synchronization. Delivery's accepted terminal CI evidence is reconciled into still-active hub jobs if the surrounding hub transaction was interrupted.

Crash tests send actual **SIGKILL** to a separate hub CLI process, reopen its original SQLite files and port, and keep the same node daemon running:

1. After the tested candidate was pushed and the fake forge persisted PR closure, before publication returned. Recovery publishes no replacement candidate and closes the PR once.
2. After delivery committed the merged entry, before the hub synchronized it. A test-only preload pauses this exact boundary; restart emits one terminal merge gate event and completes the run.
3. Across a 1.2-second assignment lease deadline. The live node aborts its old executor during the outage; restart creates engine retry 2, the same node completes it, and an explicit stale result receives `409 lease_lost`.

New JSON configuration: `deliveryRepositoriesPath` (default `./delivery-repositories`, relative to the config file) and `deliveryLeaseDurationMs` (default 60000). A crashed queue worker retains its fence until this delivery lease expires. Node leases remain independently configured.

## Verification

Executed locally on macOS, Node **v24.22.0**, Git **2.54.0**, after:

```sh
source ~/.nvm/nvm.sh && nvm use 24
```

| Exact command from repository root | Result |
| --- | --- |
| `npm test` | 271 passed, 0 failed |
| `node --test tests/e2e/test/*.test.js` | 9 passed, 0 failed |
| `node --test apps/hub/test/*.test.js packages/sdk/test/*.test.js` | 38 passed, 0 failed |
| `git diff --check` | Passed |

The original root `npm run test:e2e` still names only the build/architect files; use the glob above (or package-local `node --test`) for the new wiring/crash suites. Root `npm test` discovers every new suite automatically.

All Git pushes target temporary local bare origins. `gh` is a PATH-injected executable implementing PR list/create/view/close and native queue observations. The default-publication case uses a public-form GitHub project URL rewritten to its local bare origin by a fixture gitconfig. It verifies that the published main revision equals the speculative CI revision and the PR close comment contains candidate evidence. Native mode verifies serial submission with `--auto --match-head-commit`, and distinguishes the tested candidate from the final published SHA.

## Limits and contract follow-ups

- No live T3 harness, real account, hosted CI, network Git/GitHub, branch-protection acceptance, deployment or multi-machine acceptance was performed. Only public github.com URLs are recognized. Other forges remain explicitly unsupported.
- Candidate jobs currently clone the hub's mirror path. The executing node must be on the same machine or have equivalent filesystem access. Transferring candidate objects to independent machines remains an integration requirement; these tests do not establish that capability.
- Fast-forward publication inherits factory-delivery's documented limitations: non-force remote ref advancement is atomic, but it is not an exact old-SHA CAS or atomic PR-head check. Native mode delegates final ordering, method and required checks to GitHub. Squash/rebase publication closes PRs with evidence rather than creating a GitHub MERGED record. A real crash inside separate gh comment/close operations can still duplicate a comment.
- Messaging and delivery use separate SQLite databases from the hub. Reconciliation repairs the tested queue projection gaps, but cross-database atomic commits are not claimed. Hard crashes can leave a temporary mirror clone or candidate worktree for cleanup; no retention policy was added.
- `docs/architecture/README.md` was not edited. Please record `deliveryRepositoriesPath`, `deliveryLeaseDurationMs`, merge-node `publication`, and optional MergeEntry `testedRevision`. The shared workflow graph schema still reports publication as an unknown optional configuration warning; hub validation accepts and validates it. The workflow owner should add the field to the shared schema. Assignment.repo, the MergeEntry delivery fields, lease-loss retries and the new project runs route are already binding upstream contracts.
