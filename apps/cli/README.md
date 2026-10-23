# Perpeto CLI

Dependency-free Node 24 command line for local hub/node lifecycle, machine enrollment/revocation, token rotation, human decisions, hub overview, diagnostics and user services. See [the install guide](../../docs/guides/install.md) for the single-machine and second-machine paths, and [Join machines over a LAN or tailnet](../../docs/guides/remote-machines.md) for `hub init --tls`, `hub expose --tailscale`, `hub enroll-code` join commands, `node join <join-code>`, `hub tls status|rotate|activate` and `node repin`.

```sh
source ~/.nvm/nvm.sh && nvm use 24
node apps/cli/bin/perpeto.js --help
node --test apps/cli/test/*.test.js
npm test -w @perpeto/cli       # same suite through the workspace script
```

The CLI imports `@perpeto/hub` and `@perpeto/node` through the root npm workspaces and does not change their adapters. The installer links this bin into a user bin directory. Runtime setup/build remain owned by `scripts/runtime.mjs`.

`hub/node start` detach one process with private Unix-socket control and a process lock under `--dir` (default `~/.perpeto`). User services run the same implementation in the foreground with `hub/node run`. `service install --dry-run` renders templates without creating or loading service files; service tests use stubbed managers only. No inference, account copying, public network setup or service-manager deployment is claimed by package tests.

Owner commands: `perpeto machines [--json]`, `perpeto machines cordon|uncordon|drain <name>`, `perpeto machines set <name> [--max-agents N] [--max-jobs N] [--labels a,b] [--weight W] [--battery allow|deny|default]`, `perpeto hub invite [--ttl 10m]`, `perpeto machines revoke <name>`, and `perpeto hub decide <workItemId> pass|fail [--note <text>]`. Decisions fetch the current decision ID before posting and leave a concurrent gate change to the hub's 409 fence. Item discovery uses the existing project/run lists because the hub has no direct item GET route.

`perpeto node rotate-token` requires a stopped node, serializes with CLI/direct daemon locks, saves retry state privately and atomically replaces credentials without displaying tokens. Retry the same command after interruption. Managed services should be uninstalled before rotation and reinstalled afterward.

Generated hub JSON includes all current keys and keeps its DBs/cache under `hub/`. Generated node JSON includes timing, CI job controls and the current executor package; optional account pools, provider restrictions, test fakes and extra secrets remain opt-in. Doctor validates settings and warns about missing defaults, data outside `--dir`, and obsolete package/path references in configs, bin links and user services, with migration suggestions. It never migrates or overwrites existing state automatically.
