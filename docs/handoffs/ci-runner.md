# User-owned CI runner increment

Implemented 20 October 2026. Owner: T3 integration worker.

## Delivered

- `packages/factory-runner/src/queue.js`: SQLite durable queue, idempotent submissions, capability/repository matching, atomic claims, lease heartbeats, fencing, persisted results and explicit retries.
- `packages/factory-runner/src/worker.js`: standalone submit/get/retry CLI plus one-shot actual runner. Owner-controlled file config maps repository IDs and executable names to local paths. Jobs use argv arrays, exact full commit SHA, fresh per-job Git clone/HOME/TMPDIR, minimal environment, timeout/process-group cancellation, bounded logs and artifact summaries.
- Inherited `perpeto/Runner.ts` and `runnerHttp.ts`, mounted in `server.ts`, reuse existing environment authentication and read/operate scopes. Queue storage is under the existing server state directory.
- Exported existing messaging `ApiError` and bounded `readJsonBody` for the runner transport; coordinated with the messaging-history worker.
- Setup, contract, sample configuration and commands: `packages/factory-runner/README.md`.

## Recovery policy

Expired leases become `lost`, never silently retried. An operator may explicitly retry lost/failed work; each new claim receives a new token. Stale completion/heartbeat requests return conflict. If heartbeat confirmation fails, the worker stops its process group and withholds completion. A crash can occur after external command effects but before persistence: no exactly-once execution promise is made.

## Verification

- Root runner tests: 7 passing, including actual worker subprocess + temporary HTTP test endpoint + SQLite queue, dirty source preserved, exact revision retained, parent test secret omitted, artifact summary, timeout/truncation, independent simultaneous claimant processes, lease expiry/fencing/retry and restart durability. Review regressions prove unref descendants are killed on normal exit, stalled heartbeats stop execution before the confirmed lease expires, and control-heavy output completes under the HTTP envelope limit.
- Inherited `apps/server/src/perpeto/runnerHttp.test.ts`: 1 passing actual-auth HTTP integration test; missing/revoked 401, reader mutation/claim 403, stale completion 409 and successful completion.
- Inherited server typecheck: no TypeScript errors in the complete server project at verification time; informational upstream Effect suggestions remain.
- Lead owns packaged runtime build and a full production-route/worker smoke before claiming that combined path verified.

## Limits

Initial workers support macOS/Linux, not Windows. This is a one-shot runner, not an installed service, GitHub Actions adapter, UI or artifact upload service. Artifact summaries persist but files are removed with temporary checkouts. Environment operators are trusted; checkout isolation is not an OS sandbox. Two physical hosts and external provider CI have not been tested. Existing T3 authentication and harness integration boundaries remain in force.

## Independent review fixes completed 21 October 2026

- Kill the command process group when its parent exits normally, before checkout cleanup.
- Track conservative confirmed lease deadlines with a monotonic clock, enforce a local watchdog, and bound heartbeat requests by the remaining confirmed lease.
- Bound the JSON-serialized result to 384 KiB, reserving headroom under the 512 KiB transport cap even when control characters expand during JSON encoding.

Operational defaults and validation caps were extracted without behavior changes to `packages/factory-runner/config/limits.json`, including queue leases/SQLite settings, request timeouts, completion size, watchdog margin, minimal command environment and worker validation ranges.
