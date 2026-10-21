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

CLI configuration/data default to `~/.perpeto` (mode `700`); CLI `--dir /absolute/data` selects another installation. Non-secret settings live in `hub.json`/`node.json`, with relative paths resolved from those files. Secrets use mode `600`; logs are `hub.log`/`node.log`. Init preserves existing settings. `hub init --port 0` selects a temporary port printed by start/status. Edit JSON while stopped to change settings. Back up hub DBs with `hub/owner.secret`.

`hub status`/`node status` show local state. `node drain` finishes current work without accepting more. `node stop`/`hub stop` stop daemons, reporting ongoing drain after ten seconds. Factory-wide `status` requires the hub owner's directory. Only `hub init --show-owner-token` explicitly displays the owner token.

## Add a second machine

Install the same revision there. Configure an HTTPS endpoint through your existing private-network proxy. The hub supplies HTTP only and binds loopback by default; this CLI does not provision TLS, forwarding or public access.

```sh
# Hub machine:
perpeto hub enroll-code --show-code
# Second machine:
perpeto node join https://your-private-hub.example --code '<displayed-code>' --labels linux,ci
perpeto node start
```

Codes are single-use and expire after ten minutes by default. Prefer securely transferring the private file and using `--code-file` to avoid shell history/process arguments. Enrollment `--labels` adds file-based join defaults, not enforced restrictions. Machine tokens never print. Failed joins retain a private retry request; retry the same command. Existing node identities cannot be replaced by rejoining.

## Run as a service

```sh
perpeto node stop
perpeto hub stop
perpeto service install --dry-run   # inspect without writing/loading
perpeto service install            # configured roles; or specify hub / node
perpeto service uninstall          # stops, disables and removes owned files
```

macOS uses `~/Library/LaunchAgents/com.perpeto.{hub,node}.plist`; Linux uses `~/.config/systemd/user/perpeto-{hub,node}.service`. Services capture Node/PATH, append logs and restart on failure. Uninstall/reinstall to change settings or Node version. One installation per role owns these names. Services follow user-session lifetime; Linux boot without login needs separately configured lingering.

Doctor checks executable presence, build, health and known secret-file permissions, not harness authentication. Node runtime management defaults off; configure/start T3 separately. Workflow, executor and account integration still need composition on this base revision. Real harness execution, service loading and hundreds of physical machines are unverified. See [the implementation handoff](handoffs/perpeto-cli.md) for operational limits.
