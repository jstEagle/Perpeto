# Perpeto CLI handoff

Owner: Adele Plotinus, gpt-6.1-sol. Branch: `t3/cli-review-fixes`. Base: main `938a453`. Implementation: `9a44a25`. Scope: `apps/cli/**`, `install/**`, `docs/guides/install.md`, this handoff and only CLI findings' annotations in `review-wave3.md`. Local commits only; no push, merge, actual service loading or account changes.

## Implemented in this follow-up

All open CLI review findings have regression tests in `apps/cli/test/review.test.js`. Each test was run failing before its fix:

- **L12:** systemd service ownership requires an entire matching marker line. A default-directory uninstall cannot disable/remove a staging-directory service. Both install/uninstall refuse foreign files before any manager call.
- **L13:** enrollment retries reuse the private saved configuration and request, including name, labels, OS and idempotency key. A changed hostname or runtime default no longer changes the retry. Explicit hub/code/name/label conflicts are refused.
- **L14:** CLI locks record process start identity alongside PID. A recycled live PID no longer blocks recovery; matching live owners and legacy PID-only locks remain conservative. No process is terminated during recovery.
- **L15:** hub init explicitly writes every current hub key. Hub, messaging, delivery and workflow DBs, repository cache and owner token all live under `hub/`. Delivery failure/backoff bounds are explicit. The install guide backs up the whole stopped hub directory and its JSON configuration.
- **L17 CLI half:** enrollment sends `windows` for Node's `win32` platform. The existing hub-side result/config-hash fix was not changed.

Generated node JSON includes capacity, timing/backoff, current executor package, CI timeouts, log chunk size, redaction patterns, protected paths and disabled runtime supervision. Data and credentials stay under `node/`; runtime `repoRoot` deliberately points at the installation source. Optional account pools, provider restrictions, fake executors and extra secret-file references remain opt-in. Adding an empty account pool or provider allowlist would change execution semantics, so these are not enabled by generation. Config-key regressions compare hub/node examples and check new values/paths. Existing init/join configuration is preserved; migration is never automatic.

New commands:

- `perpeto machines` lists machines as JSON; `perpeto machines revoke <id>` permanently revokes the machine through the owner API.
- `perpeto node rotate-token` serializes with CLI and direct-daemon locks, persists its request key and response privately, and atomically replaces credentials mode 600. Retry after interruption with the same directory; tokens never print. Stop/uninstall the managed service first so it cannot restart with stale credentials. Rotation never recovers a direct-daemon lock itself; start/stop the node to recover a stale one. The hub retires older generations on first use of the new token.
- `perpeto hub decide <workItemId> pass|fail [--note <text>]` discovers the item through projects/running runs, fetches its current `decisionId`, then posts it with a fresh idempotency key. The current hub has no single-item GET route. A competing decision produces HTTP 409 and cannot advance the next gate. Missing/non-waiting items fail before mutation.

Doctor validates current hub/node settings, including nested timing/job defaults, workflow/delivery paths and retry bounds. It warns with suggested fixes for missing explicit settings, data paths outside the CLI directory, old package/path references in JSON/runtime config, user service files and the CLI bin symlink. Examples include `@perpeto/factory-t3` → `@perpeto/t3-executor` and `packages/perpeto-cli` → `apps/cli`. Config values, remote error bodies and credentials are not echoed. Configured job redaction-file permissions are checked too.

## Verification

Node `v24.22.0`, selected using `source ~/.nvm/nvm.sh && nvm use 24`. Workspace dependencies installed with `npm ci --ignore-scripts --no-audit --no-fund`; manifests/lockfile unchanged.

- `npm test -w @perpeto/cli`: **21 passed**. Includes the original daemon lifecycle/enrollment/installer checks, five review regressions, real-hub machine listing/revocation/token retirement, live CLI/direct-daemon lock refusal, lost-response/saved-response rotation recovery, two human gates with a concurrent decision race, and config/migration diagnostics.
- Root `npm test`: **399 passed**, zero failures/skips (final run after the last code/test change).
- `sh -n install/install.sh`, `git diff --check`, changed-document relative links and the existing generated macOS `plutil -lint` check pass.

Tests create temporary private state, ephemeral loopback hubs and local Git fixtures. Service managers remain stubbed. The installer already migrates old `packages/perpeto-cli` bin links; its existing regression still passes, so no installer source change was needed.

## Retained behavior and limits

The earlier CLI implementation still supplies private `~/.perpeto` state overridden by `--dir`, detached/foreground hub/node daemons, local socket status/drain/stop, enrollment code files, launchd/systemd generation, safe installer updates and explicit-only owner-token/code display. Normal hub/node startup uses the current workspace packages; the hub now composes its real workflow/delivery adapters and node integration lives in its own package.

No real harness authentication/turn, subscription swap, remote-machine run, browser journey, Linux service manager or scale acceptance is claimed. T3 setup/build/authentication and an existing HTTPS/private-network endpoint remain operator prerequisites. User services follow session lifetime; Linux lingering is not enabled. Services retain fixed names per role and no log rotation. Enrollment-file labels are defaults, not an enforced hub restriction. Socket paths remain OS-limited. Ambiguous/malformed or live legacy locks fail closed. Doctor diagnoses configuration and executable/build/health/secret-file checks, not full execution readiness, every custom adapter secret location, or live provider authentication.
