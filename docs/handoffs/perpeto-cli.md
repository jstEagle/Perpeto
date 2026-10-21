# Perpeto CLI handoff

Owner: Francis Dirac, gpt-6.1-sol. Branch: `t3/perpeto-install-cli`. Base: `13cdd2d`. Scope: `apps/cli/**`, `install/**`, `docs/guides/install.md`, and this handoff. No other packages, architecture, root manifests, upstream source, services, or user account configuration were changed. No push or merge.

## Implemented

- Dependency-free ESM Node 24 package with executable `bin/perpeto.js`: hub init/start/stop/status/enroll-code, node join/start/stop/status/drain, service install/uninstall, doctor and authenticated hub overview.
- Default private `~/.perpeto` data/config directory, consistently overridden by CLI `--dir`. Hub/node JSON stores settings and file references; generated paths are relative to their JSON files. Node's default external runtime URL derives from `config/perpeto.json` through the existing launcher configuration reader.
- Hub init uses the real hub package to bootstrap durable state and its owner token without listening. Repeated init preserves identity/configuration. Hub start supports port zero and reports the actual listening URL; status works through local control even without a reachable hub API.
- Detached daemon management with private Unix sockets and process locks, graceful stop/drain, bounded CLI readiness/shutdown waits, and dead-PID lock recovery serialized by a recovery directory. No PID-based termination of an arbitrary process. Services invoke the same daemon in the foreground using internal `hub/node run` commands. Fatal node errors preserve a nonzero exit for service restart.
- Enrollment-code files are private; only `--show-code` prints a code and only `hub init --show-owner-token` prints the owner token. Node join supports the requested `--code` plus the safer `--code-file`; it persists the complete pending request and idempotency key privately before enrollment. Lost-response/crash retries recover the original machine identity. Successful join removes pending enrollment material; existing identities cannot be replaced.
- launchd and systemd user templates, absolute Node executable and captured PATH, data-directory logs, failure restart and graceful drain shutdown settings. Dry-run renders files without writing/loading them. Installation preserves unrelated/other-directory service files; failed manager actions retain generated files for inspection.
- Doctor checks Node >=24.13.1 <25, git/claude/codex executable versions, configured T3 build presence, hub health and known secret files' ownership/mode/type/link count. No command output or raw remote error bodies are printed. Credential-bearing URLs fail without disclosure.
- POSIX installer with configurable checkout/bin/repository/branch, existing version-manager Node 24 installation, explicit pnpm prerequisite, clean matching-origin fast-forward updates, setup/build and collision-safe user bin linking. No sudo, account login changes, service loading, automatic package-manager bootstrap or global Node installation without an existing version manager.

## Verification

Executed on macOS with Node `v24.22.0` selected through nvm:

- `node --test apps/cli/test/*.test.js`: **10 passed**. Parsing, non-secret config and init identity preservation, private/symlink secret checks, both service formats, real `plutil -lint`, stub-only service installation/removal/failure, stubbed doctor commands/health/build and URL redaction, live/stale process locks, actual ephemeral hub/node lifecycle, single-use enrollment and lost-response retry, overview, drain, restart, secret-free output/logs, cancellation during unreachable-hub startup and nonzero fatal daemon exits.
- Installer test uses a real local Git fixture, stubbed npm/pnpm, and a temporary user bin. It verifies first/repeated installation, a real fast-forward update, dirty-checkout preservation and unrelated-bin preservation. It does not download/build the full upstream runtime or install Node through real version managers.
- Root `npm test`: **219 passed**, including these 10 CLI tests.
- `sh -n install/install.sh`, `git diff --check`, and generated macOS plist syntax validation pass. Markdown links and terminology checked locally. No browser/rendered documentation review.
- Test cleanup stops temporary daemons before removing their directories. Final process inspection confirms no test daemons remain. Tests never load launchd/systemd services or modify real logins/accounts.

## Required integration outside this worker's ownership

1. The real hub workflow adapter remains intentionally unintegrated in `apps/hub/src/engine/workflow-adapter.js`. CLI liveness/overview/enrollment are real, but starting a workflow still needs the hub/workflow composition owned elsewhere.
2. Root/package wiring must make `@perpeto/t3-executor` and account integration resolvable from factory-node. The current account package exports AccountPool factories, while factory-node expects `createAccountProvider({config,configRoot})`. An adapter is needed before account acquisition, public metadata and T3 provider binding work together. This CLI does not silently substitute empty/fake implementations or import/copy real account credentials.
3. Hub enrollment codes currently store no label restrictions. `hub enroll-code --labels` saves labels as join defaults in the private enrollment file. Raw-code join needs explicit `--labels`; neither path treats labels as an enforced enrollment policy. Add hub-side code metadata/validation if restriction was intended.
4. Remote access requires an existing HTTPS/private-network endpoint. The hub has no TLS terminator, and node join refuses non-loopback HTTP. No firewall, relay, forwarding, Cloudflare policy or production infrastructure was changed.

## Operational limits

- Services are generated and manager calls tested with stubs only. Linux unit generation is covered but no Linux service manager was exercised. Installed services use one fixed name per role per user. Uninstall before changing settings/install paths/Node versions, then reinstall; repeated install against an already loaded launchd job can require uninstall first. Failed bootstrap may require inspecting/unloading the retained job/file with the service manager.
- User services follow login/session lifetime. Linux lingering is an explicit operator decision, not automatically enabled. Clean CLI stop does not trigger failure restart. Log rotation is not supplied.
- Node runtime supervision defaults disabled, with the external URL derived from launcher config (currently port 4310). Build/start/configure T3 authentication separately. This CLI does not prove executable authentication, provider readiness, an account swap, a harness turn, full workflow execution, remote-machine operation or hundreds-machine throughput.
- Overview requires a hub owner's directory; machine tokens deliberately cannot read the owner overview. Doctor checks configured/known secret files, not every file inside imported account homes.
- Socket paths are limited by the host OS; choose a short data path. A malformed/PID-reused process lock, abandoned recovery directory, or partially written bootstrap file fails closed and needs manual inspection. Persistent identity/configuration files are never automatically reset. The CLI lock does not replace the factory-node daemon's own lock/recovery policy.
- Enrollment response recovery assumes `join.secret` and any already-written machine credential remain intact. Labels/name/hub must match the original retry. Code files remain private until explicitly removed by the owner or expired at the hub.
- The installer must be published before its default remote-main download is usable. Source installation/build is heavier than a packaged binary; no release archive or one-shot cross-platform distribution is claimed.
