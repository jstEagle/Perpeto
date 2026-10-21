# User-owned CI runner

This increment runs queued CI jobs on an owner-controlled macOS or Linux machine. The existing Perpeto/T3 environment server owns the durable SQLite queue and authenticates requests. A separate worker claims a matching job, checks out its exact Git revision in a temporary clone, executes an allowed executable with an argv array, and submits a bounded result. It can process one job or continuously watch the queue.

Shared operational defaults, storage settings and validation limits live in `config/limits.json`; machine-specific settings live in the runner JSON described below. No non-secret runner setting requires an environment variable.

No inference API is involved. This is CI execution infrastructure; harness adapters remain responsible for inference.

## Configure the runner machine

Install Node 24 and Git. Store a valid T3 bearer session token in an owner-only regular file, using the same credential-file convention as the messaging client. The token must have `orchestration:operate`; `orchestration:read` also permits reading job status. This uses the existing environment's session administration and revocation, with no new credential system.

Create local non-secret JSON configuration:

```json
{
  "baseUrl": "http://127.0.0.1:4310",
  "credentialFile": "./runner-session-token",
  "runnerId": "my-dev-box",
  "labels": ["linux", "node"],
  "repositories": {"app": "/absolute/path/to/app"},
  "executables": {"node": "/absolute/path/to/node"},
  "workDirectory": "./runner-work",
  "toolPath": "/usr/bin:/bin",
  "timeoutMs": 600000,
  "maxOutputBytes": 65536,
  "leaseMs": 30000,
  "artifactPaths": ["test-report.json"],
  "pollIntervalMs": 2000,
  "retryIntervalMs": 5000
}
```

Repository and executable mappings use absolute local paths. Credential/work paths resolve relative to the config file. Remote endpoints require HTTPS, or explicit `allowInsecureHttp: true` when the operator deliberately chooses a trusted HTTP route. Git is resolved through `toolPath`. Windows workers are explicitly unsupported in this increment; process-group cancellation is implemented for macOS/Linux.

A job file contains only non-secret execution instructions:

```json
{
  "projectId": "my-project",
  "repositoryId": "app",
  "revision": "0123456789012345678901234567890123456789",
  "command": ["node", "scripts/test.js"],
  "requiredLabels": ["node"],
  "idempotencyKey": "tests-for-full-commit-sha"
}
```

Replace the example revision with the full lowercase commit SHA from the configured local source repository. The source must already contain that commit. The runner clones tracked Git content and checks out the supplied SHA; it does not copy uncommitted source files or fetch credentials from the server.

```sh
node packages/factory-runner/src/worker.js submit --config /path/runner.json --job /path/job.json
node packages/factory-runner/src/worker.js once --config /path/runner.json
node packages/factory-runner/src/worker.js watch --config /path/runner.json
node packages/factory-runner/src/worker.js get --config /path/runner.json --id JOB_ID
node packages/factory-runner/src/worker.js retry --config /path/runner.json --id JOB_ID
```

`once` exits after one job, or immediately if no compatible queued job exists. `watch` processes one job at a time, immediately checks for the next compatible job after completion, and waits between empty claims. Optional `pollIntervalMs` and `retryIntervalMs` override the shared idle and error-backoff defaults in `config/limits.json`. Both accept 100–300000 milliseconds. Connection/credential errors are reported without raw response bodies and use the configured backoff rather than a tight failure loop. This increment does not install a background service; a service manager can run the watch command.

`watch` prints a JSON readiness event, one JSON outcome per completed job, and a final stopped event. Both `watch` and `once` handle SIGINT/SIGTERM by cancelling active request/command execution, cleaning up the command process group, and exiting with code 0 and a stopped event. Watch also interrupts idle waiting. Shutdown cancellation does not submit a failed or successful completion: an active lease expires to `lost` and requires explicit inspection/retry. This avoids treating an interrupted test as verified. Programmatic `runOnce(config, parentAbortSignal)` also accepts cancellation. Other configuration/startup failures exit 1.

Submissions are idempotent within a project when their key and execution instructions match. Changing the payload under the same key returns a conflict.

## Execution and recovery

Jobs persist through `queued → leased → succeeded/failed`. Claims are atomic across worker processes, matched against repository IDs and capability labels. Each claim gets a fresh fencing token. Heartbeats renew only the active unexpired lease; late heartbeat/completion requests cannot change a reassigned job.

An expired lease becomes `lost`, never automatically queued again. An operator must explicitly retry a lost or failed job. A worker that loses heartbeat confirmation stops its process group and withholds completion. A monotonic watchdog stops work before the last confirmed lease deadline, and heartbeat request timeouts are bounded by that remaining lease. A crash can occur after a command caused external effects and before its result was saved: execution is not exactly once. Explicit retry can repeat those effects, so choose retry-safe CI commands and inspect lost work before retrying.

Each job gets its own temporary Git clone, home and temporary directory. Commands receive only configured PATH, fresh HOME/TMPDIR, LANG, CI and Git's system-config exclusion; generic parent credentials/environment variables are not copied. The configured executable allowlist maps the first argv entry to an absolute binary; no shell command string is accepted. The checkout is isolated from the source working tree, but this is not an OS security sandbox: allowed commands run as the runner's user. Runner submission/claim permissions therefore belong to trusted environment operators.

The timeout covers checkout preparation and command execution. Remaining descendants in the command process group are terminated on normal parent exit as well as timeout/lease cancellation. Output is capped and marked when truncated; serialized completion results are further bounded to 384 KiB so escaped control output cannot overflow the HTTP request limit; the worker records exit code, timeout, bounded log, exact requested revision and artifact path/size summaries. Artifact files are not uploaded or retained after temporary checkout cleanup. Results and execution attempt count are durable; a full historical record of every retry is not implemented.

## HTTP contract

All routes are under `/api/perpeto/runner` and reuse environment authentication. GET requires `orchestration:read`; POST requires `orchestration:operate`.

| Route | Purpose |
|---|---|
| POST `/jobs` | Submit the job JSON above; returns `{job,duplicate}` |
| GET `/jobs?projectId=...&limit=100` | List recent jobs for the project; returns `{jobs}` |
| GET `/jobs/:id` | Get a job, result and status; lease tokens are omitted |
| POST `/claim` | `{runnerId,labels,repositoryIds,leaseMs}`; returns a lease or `null` |
| POST `/jobs/:id/heartbeat` | `{runnerId,leaseToken,leaseMs}` |
| POST `/jobs/:id/complete` | `{runnerId,leaseToken,result}` |
| POST `/jobs/:id/retry` | Explicitly retry lost/failed work; body `{}` |

Claims return `{job,leaseToken,leaseExpiresAt}`. Completion result is `{exitCode,timedOut,logsTruncated,log,artifacts:[{path,size}]}`. Every successful route returns 200; expected validation/auth/not-found/conflict errors use the existing `{error:{code,message}}` envelope and 400/401/403/404/409. Bounded request reads use the messaging transport's 512 KiB limit. Project IDs namespace jobs but do not enforce separate tenant membership, consistent with the environment permission boundary. The queue lives at `stateDir/perpeto-runner.sqlite`.

## Verified boundary

Root tests exercise temporary SQLite databases, restart persistence, simultaneous claimant subprocesses, expiry/manual retry/fencing, actual worker subprocess execution over HTTP, lease heartbeats, stalled-heartbeat cancellation before expiry, cleanup of unref descendants, completion of heavily escaped output within the HTTP size limit, pinned checkout isolation despite dirty source files, omission of a test parent secret, artifact summary, output truncation and timeout. Watch subprocess tests also cover jobs arriving after idle polling, prompt idle/active signal shutdown, descendant cleanup with completion withheld, eventual lost/manual-retry state, and configured error backoff. Inherited server tests independently exercise real environment authentication, scoped runner routes, revocation and completion fencing.

Two physical hosts, Windows, GitHub Actions compatibility, artifact uploads and a runner UI remain unverified or unimplemented. There is no claim of a complete CI platform.
