# Fleet: machine health and cross-machine placement

Status: built and tested on loopback, 23 October 2026. Not yet run against the real Mac mini and MacBook Pro.

## Why

The Mac mini hub machine was offered work while it sat at load average 130+ with about 2,700 processes, because leasing only looked at configured capacity, labels and providers. The fleet work makes the hub see each machine's health, fill it only to what it can take now, spread work across machines, and say why a machine is not taking work.

## What is built

| Area | Where | What |
| --- | --- | --- |
| Telemetry | `apps/node/src/health.js`, wired in `node.js` | Each heartbeat carries `health`: CPUs, 1/5/15 load, memory free/total and pressure (`sysctl kern.memorystatus_vm_pressure_level` on macOS, PSI on Linux), process count, battery/AC (`pmset -g batt`, `/sys/class/power_supply`), thermal state (`pmset -g therm`), uptime, Node version, T3 runtime reachability, workspace-volume disk total/free, and `storage.state` when a storage janitor supplies `storageState()`. Spawning probes run concurrently with a 2 s timeout and are cached for `health.slowProbeMs` (30 s). Also `workspaces.repos`: hashed repo URLs worked on in the last `warmRepoMs` (1 h), plus whatever `warmRepos()` returns. All injectable (`healthCollector`, `storageState`, `warmRepos`). |
| Placement | `apps/hub/src/placement.js`, a few lines in `hub.js` and `config.js` | Effective capacity per machine from node capacity, owner overrides, load per core, processes, memory pressure, disk/storage, battery, thermal state, runtime and providers. Lease fills only to effective capacity, scores candidates (headroom, cool CPUs, previous-attempt/work-item affinity, warm workspace, weight) and lets a fresh item wait up to `deferMs` for a clearly better machine that is long-polling. Leases record `placement: { machineId, score, reasons, at }`; `GET /machines` returns each machine's computed `placement` with reasons. Settings: hub config `placement` (see `config/hub.example.json`). |
| Management | `PATCH /machines/:id` | Cordon, drain (placement-only, reversible), weight, maxAgents/maxJobs/labels/allowOnBattery overrides (`null` resets). Idempotent; events only on change. |
| CLI | `apps/cli/src/fleet.js`, `invite.js`, `reach.js` | `perpeto machines [--json]`, `machines cordon|uncordon|drain|set|revoke <name or id>`, `hub invite [--ttl] [--labels]` (join code with `alts`: Tailscale name and IPs, then LAN; pinned), `node join` tries each address, and `doctor` explains hub failures (pin mismatch, refused, timeout, no route, DNS, wrong protocol). The join code is the only secret printed, as with `enroll-code`. |
| Web | `apps/web/src/routes/machines.tsx`, `lib/fleet.ts`, `api/fleet-fixtures.ts` | Fleet screen (nav "Fleet"): summary, health columns, status chips, reasons, cordon/uncordon/drain, filter and sort above 6 machines. Demo `?fleet=50`. Screenshots in `apps/web/screenshots/fleet/`. |
| Apple | `PerpetoKit/Models/Fleet*.swift`, `Data/DemoFleet.swift`, `FactoryScreens.swift` | Same screen for macOS and iOS; demo "Busy fleet". Screenshots in `apps/apple/screenshots/fleet/`. |

## How it was verified

- `npm test` (root): all pass, including `apps/hub/test/placement.test.js` (assessment rules, sanitizing, scoring, PATCH semantics and events, overloaded recovery, deferral to a polling machine), `apps/node/test/health.test.js` (probe parsing against real `pmset`/`sysctl` output from this Mac, caching, hung probes) and `apps/cli/test/fleet.test.js` (grammar, formatting, invite candidates, real-socket diagnoses including a pin mismatch, CLI against a real TLS hub).
- `tests/e2e/test/fleet.test.js`: a real hub and three real node daemons in temp dirs on loopback with injected telemetry. Six items split 3/3 across the two healthy nodes and none on the overloaded one (five repeated runs, same split); after cordoning one and letting the overloaded one recover, the cordoned node gets nothing and the other two share the work.
- Web: `vitest` 156 pass, `tsc --noEmit` clean, screenshots light/dark at 2 and 50 machines reviewed. Apple: `swift test` 128 pass, screenshots reviewed.

## Not verified, and known gaps

- No run on the real Mac mini or MacBook Pro: thresholds (1.5 load per core, 2,000 processes, 10 GiB) are starting points, not tuned. On the mini at load 130, `ps` may take a while; it is bounded at 2 s and then omitted.
- Linux battery/PSI and Windows paths are written but untested; Windows sends no load average.
- Thermal parsing of `pmset -g therm` warning lines is based on documented output, not observed throttling.
- "Warm workspace" is weak today: the executor clones fresh per assignment and deletes it, so the signal is "worked on this repo recently" until worktrees are kept (storage janitor, worker A). Plug kept checkouts in through `warmRepos()`.
- Deferral is in memory and only targets machines long-polling at that moment; a restart only resets the 5 s window. Pacing caps on the other machine are not considered, so an item can wait up to `deferMs` before falling back.
- Owner `maxAgents` above the node's config cannot raise it (the node limits its own polls); the reason `capped-by-node` says so.
- Hub-side drain does not stop the node; the legacy `POST /machines/:id/drain` still shuts the node's lease loop and is not reversible without a node restart.
- Web summary can read "6 of 4" when an overloaded machine keeps running work above its new limit of 0; the "over limit" note explains it.
- `node join` with an invite retried after the first address changed reachability can report "A different enrollment is pending"; rerun with the same address or a fresh invite.
