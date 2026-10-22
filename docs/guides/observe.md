# Observe your own T3 Code sessions

Observe-only mode hooks Perpeto into the T3 Code desktop app you already run, on every Mac you use, and shows all sessions and subscription usage on one hub. Workflows, agents and the merge queue stay off. Each Mac runs a Perpeto node that watches its own T3 **read-only**; one hub collects what the nodes report.

```text
 this Mac                                  Mac mini
 T3 Code (desktop) ◀─ read-only ─ node     T3 Code (desktop) ◀─ read-only ─ node
                                   │                                         │
                                   └──────────▶ hub (this Mac) ◀── HTTPS, pinned ──┘
                                                 GET /sessions, /sessions/summary, /accounts, /pacing, /usage
```

## What Perpeto does and does not do to T3

| | |
| --- | --- |
| Reads | `server-runtime.json` (where the server listens), `server.getConfig` (provider instances, plan labels, usage windows), the orchestration shell stream (threads) and bounded thread snapshots (runs and per-turn token usage) |
| Writes | One auth session, minted once with T3's own CLI, scope `orchestration:read` only. Nothing else, ever |
| Never | Starts, steers, interrupts or configures threads; changes settings or provider instances; refreshes providers; touches files, terminals or previews |

The node's T3 client has an allowlist of three RPCs (`server.getConfig`, `orchestration.subscribeShell`, `orchestration.subscribeThread`) and refuses anything else before it reaches the socket. Tests run it against a fake T3 server that records every request and assert that nothing else is ever sent.

**What leaves the Mac:** thread ids, titles (optional), project name and folder name, branch and worktree folder name, provider, model, status, parent thread, times, turn counts, per-turn token counts, plan labels and usage-window percentages. Never message text, prompts, tool calls, file contents, emails or credentials.

One honest caveat: T3 has no usage-only read, so the thread snapshot that carries token usage also carries messages over the loopback socket. The node keeps only runs, attempts and provider-turn usage from it and drops the rest on receipt. The shell stream's message preview is dropped the same way.

## How auth works

T3 environment APIs need a session. On first start the node runs T3's own CLI, the wrapper the desktop app installs at `~/.t3/bin/t3`:

```sh
~/.t3/bin/t3 auth session issue --base-dir ~/.t3 --scope orchestration:read --ttl 30d --label perpeto-observer --token-only
```

`orchestration:read` is the narrowest scope T3 has that covers these reads; it grants no command, settings, provider, terminal or filesystem access. The wrapper runs the server build bundled with the running app, so the auth store is written by matching code. The token is kept in memory and in `<node data>/t3-observer-session.json` (mode 600) and reused until it is a day from expiry. If T3 rejects it, the node mints a new one, at most once every ten minutes. To see or revoke sessions, use T3's CLI: `~/.t3/bin/t3 auth session list` and `~/.t3/bin/t3 auth session revoke <id>`. Perpeto never revokes or edits them.

To mint nothing at all, put a token you issued yourself in an owner-only file and set `observe.credentialFile` in `node.json`.

## Install

Both Macs need Git and Node 24 (>=24.13.1). Install from a clean checkout outside `~/Documents`: launchd services cannot read `~/Documents` without extra privacy permissions. Observe-only does not need the T3 runtime build or pnpm, so the full installer is not required.

```sh
git clone https://github.com/jstEagle/Perpeto ~/.local/share/perpeto
cd ~/.local/share/perpeto
npm ci --ignore-scripts --no-audit --no-fund
mkdir -p ~/.local/bin && ln -s ~/.local/share/perpeto/apps/cli/bin/perpeto.js ~/.local/bin/perpeto
export PATH="$HOME/.local/bin:$PATH"   # add this line to ~/.zshrc too
```

### This Mac: hub and node

The hub listens with built-in HTTPS on the LAN so the mini can reach it; port 4340 avoids the development hub on 4320.

```sh
perpeto hub init --tls --host 0.0.0.0 --port 4340   # prints the certificate fingerprint
perpeto hub start
perpeto hub enroll-code                              # prints: perpeto node join pj1_…
perpeto node join pj1_… --observe --name "MacBook Pro"
perpeto hub enroll-code --url https://Justus-mac-pro.local:4340   # for the mini; copy the printed command
perpeto hub stop
perpeto service install                              # LaunchAgents com.perpeto.hub and com.perpeto.node
perpeto doctor
perpeto sessions
```

macOS may ask once whether `node` may accept incoming connections; allow it so the mini can connect.

### Mac mini: node

After the same install steps, paste the command `hub enroll-code --url …` printed on this Mac. It is a one-time secret and expires after ten minutes.

```sh
perpeto node join pj1_… --observe --name "Mac mini"
perpeto service install node
perpeto doctor
```

`--observe` writes a node with `capacity: { maxAgents: 0, maxJobs: 0 }`, no executor packages, `runtime.enabled: false` and an `observe` section. The join pins the hub's certificate fingerprint, so the node sends nothing to any other server. Logs go to `~/.perpeto/hub.log` and `~/.perpeto/node.log`; `perpeto service uninstall` removes the LaunchAgents.

## Configuration

`observe` in `node.json`. Everything is non-secret.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Watch this Mac's T3 |
| `t3BaseDir` | `~/.t3/userdata` | T3 runtime directory; its parent is the home T3's CLI takes as `--base-dir` |
| `url` | from `server-runtime.json` | Loopback origin of the T3 server, if it should not be read from the runtime file |
| `pollMs` | `5000` | How often changes are sent and changed threads are read |
| `includeTitles` | `true` | Send thread titles; `--no-titles` on join turns this off |
| `cli` | `<t3 home>/bin/t3` | T3's CLI used to mint the read-only session |
| `credentialFile` | none | Owner-only file with a token you issued; then nothing is minted |
| `tokenTtl` | `30d` | Lifetime of a minted session |
| `backfillHours` | `168` | Threads active in this window get their token usage read after a start |
| `fetchesPerPoll` | `2` | Thread snapshots read per poll, to keep the load on T3 low |

## What the hub shows

- `GET /sessions?machineId&status&provider&since&limit&cursor`: every session, newest activity first, with machine name, child (subagent) count and token totals.
- `GET /sessions/summary?window=1h|24h|7d`: machines (online, observing, running, waiting, idle), totals and observed tokens by provider, model, machine and hour.
- `GET /accounts`: each provider instance with a plan or usage windows becomes an account with `source: 'observed'`.
- `GET /pacing`: `mode: 'advise'` when no machine has agent slots. Observed accounts carry `advisory: true`, the projected percent at each window's reset at the current measured burn, `onTrack`, `idleForecastMins`, `sustainableAgents` and `headroomAgents`. Nothing is enforced.
- `GET /usage?source=observed`: the usage ledger, tagged by machine, without a project.
- Events `session.updated` (a session appeared or changed status) and `sessions.changed` (per machine, at most every 15 seconds unless a status changed).

`perpeto sessions` prints the 24-hour summary from the hub's machine.

## Limits

- Running counts are T3 threads, including subagent threads T3 records. Provider-native subagents inside one thread count once, and T3 reports only main-agent tokens for a turn.
- Token usage covers threads active within `backfillHours` of a start, then every turn as it finishes. Threads imported from T3's older v1 format are listed but their usage is not read, because T3 rewrites such a thread the first time it is opened.
- Usage windows are as fresh as T3's own snapshot: the node never asks T3 to re-probe a provider. Burn rates are learned from running sessions and each fresh reading, and start from uncalibrated priors.
- Sessions idle for longer than the hub's `usageRetentionMs` (30 days) are not kept.
- The hub's HTTPS uses a self-signed certificate; browsers warn about it. Use the Apple app, or Tailscale for the web app ([remote machines](remote-machines.md)).

## Verification

Covered by `npm test`: the observer against the contract-checked fake T3 (minting with the read-only scope, mapping, usage deduplication, reconnects, a T3 restart on a new port with a revoked session, refused mutating RPCs), hub routes, retention, advisory pacing, an end-to-end hub and node, and the CLI join, doctor and service files.

A read-only run against the live T3 desktop app on this Mac on 22 October 2026 (temporary hub and node, no titles) found 249 threads in T3 and stored 205 (the other 44 are imported threads idle for months, past retention), 194 of them subagent threads, none running at the time. Codex, Claude and Antigravity reported usage windows. Within 60 seconds the ledger held 3.19 M input, 3.25 M output, 627 M cache-read and 6.44 M cache-write tokens for the past week. The service install on both Macs and the mini's LAN join have not been run.
