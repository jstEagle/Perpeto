# Install Perpeto

Requires macOS/Linux, Git, Node **>=24.13.1 <25**, and pnpm **11.10.0**. The installer can install Node through an existing nvm, fnm, mise, asdf or Volta; otherwise it explains the prerequisite. It never uses sudo.

From a checkout, run `sh install/install.sh`. Once published to main, download the same script:

```sh
curl -fsSL https://raw.githubusercontent.com/jstEagle/Perpeto/main/install/install.sh -o /tmp/perpeto-install.sh
sh /tmp/perpeto-install.sh
```

Defaults: checkout `~/.local/share/perpeto`, bin `~/.local/bin/perpeto`. Add the bin directory to PATH. Installer options: `--dir /absolute/checkout`, `--bin-dir /absolute/bin`, `--repo URL`, `--ref BRANCH`. It runs runtime setup/build. Updates require a matching origin, clean checkout and fast-forward history. Stop daemons/services before updating; restart afterward. Inspect repository code before running its installer/hooks.

## Single machine

```sh
perpeto hub init
perpeto hub start
perpeto hub enroll-code
# Substitute the private enrollment file path printed above:
perpeto node join http://127.0.0.1:4320 --code-file /path/to/enrollment.secret
perpeto node start
perpeto doctor
perpeto status
```

CLI configuration/data default to `~/.perpeto` (mode `700`); CLI `--dir /absolute/data` selects another installation. Non-secret settings live in `hub.json`/`node.json`, with relative paths resolved from those files. Secrets use mode `600`; logs are `hub.log`/`node.log`. Init preserves existing settings. `hub init --port 0` selects a temporary port printed by start/status. Edit JSON while stopped to change settings. Stop the hub before a filesystem backup, then back up all of `hub/` together with `hub.json`. This includes `hub.sqlite`, `messaging.sqlite`, `delivery.sqlite`, `workflow.sqlite`, their SQLite sidecars, `repositories/`, `owner.secret`, `credentials.key` and, with built-in HTTPS, `tls/`. Without `credentials.key` the hub refuses to start. Restore them together to preserve identity and workflow/delivery state.

`hub status`/`node status` show local state. `node drain` finishes current work without accepting more. `node stop`/`hub stop` stop daemons, reporting ongoing drain after ten seconds. Factory-wide `status`, `machines`, `machines revoke <id>` and `hub decide <workItemId> pass|fail --note "Reviewed"` require the hub owner's directory. Decisions fetch the current `decisionId` through project/run work-item lists and send it back; a concurrent answer returns HTTP 409 rather than applying to the next gate. Only `hub init --show-owner-token` explicitly displays the owner token.

To only watch the T3 Code sessions and subscriptions you already run on each Mac, without workflows or agents, follow [Observe your own T3 Code sessions](observe.md).

## Add a second machine

Install the same revision there. The hub binds loopback by default; reach it through your tailnet (recommended) or the hub's built-in HTTPS, as described in [Join machines over a LAN or tailnet](remote-machines.md). Either way, `perpeto hub enroll-code` prints one command to paste on the new machine:

```sh
# Hub machine (after perpeto hub expose --tailscale, or hub init --tls):
perpeto hub enroll-code
# Second machine:
perpeto node join pj1_… --labels linux,ci
perpeto node start
```

The join command carries the hub URL, the certificate fingerprint to pin (for built-in HTTPS) and a one-time code. Codes are single-use and expire after ten minutes by default, so treat the command as a secret. The older form `perpeto node join <https-url> --code-file <path>` still works with the private enrollment file. Enrollment `--labels` adds file-based join defaults, not enforced restrictions. Machine tokens never print. Failed joins retain a private retry request; retry the same command. Existing node identities cannot be replaced by rejoining. Retries reuse the saved name, labels, platform and idempotency key even if the machine hostname changes; explicit conflicting options are refused.

## Machine credentials

`perpeto machines` lists the hub's machines as JSON. `perpeto machines revoke <id>` permanently revokes every token for that machine and expires its leases. Recovery requires enrollment with a new code and a fresh node directory.

To rotate a local node's token, stop its service or daemon first:

```sh
perpeto node stop
perpeto node rotate-token
perpeto node start
```

For a managed node, use `perpeto service uninstall node` before rotation, then reinstall afterward. Rotation refuses a live CLI or direct node daemon. An existing direct-daemon lock is never removed by rotation; start/stop the node to recover a stale lock before retrying. A private `rotate.secret` preserves the request key and response across interruptions; retry `node rotate-token` with the same `--dir`. The credential file is replaced atomically, mode 600, and tokens never print. The hub retires older generations when the new token is first used.

## Run as a service

```sh
perpeto node stop
perpeto hub stop
perpeto service install --dry-run   # inspect without writing/loading
perpeto service install            # configured roles; or specify hub / node
perpeto service uninstall          # stops, disables and removes owned files
```

macOS uses `~/Library/LaunchAgents/com.perpeto.{hub,node}.plist`; Linux uses `~/.config/systemd/user/perpeto-{hub,node}.service`. Services capture Node/PATH, append logs and restart on failure. Uninstall/reinstall to change settings or Node version. One installation per role owns these names. Services follow user-session lifetime; Linux boot without login needs separately configured lingering.

New hub configs explicitly include all current hub settings, with every DB, repository cache and owner secret under `hub/`. Node configs include capacity, timing, job timeout/log/redaction settings, the current `@perpeto/t3-executor` package, and a disabled external T3 runtime. Optional provider restrictions, account pools, fake executors and extra secret-file references require deliberate configuration; join does not create them. Account state defaults under the node data directory when enabled.

Doctor checks configuration, executable presence, build, health and known secret-file permissions, not harness authentication. It warns when settings are missing, durable paths escape the CLI directory, or configuration, service files or the bin link reference pre-restructure names such as `@perpeto/factory-t3` or `packages/perpeto-cli`. It suggests current names and reinstall commands. Init/join preserve existing configs; stop and back up before moving DBs or editing JSON. Node runtime management defaults off; configure/start T3 separately. Real harness execution, service loading and hundreds of physical machines are unverified. See [the implementation handoff](../handoffs/perpeto-cli.md) for operational limits.
