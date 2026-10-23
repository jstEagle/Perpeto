# Storage janitor handoff

Status: implemented and covered by local tests on 23 October 2026. **Not run against a real machine's storage**: every test scans temporary folders with fake disks and fake process tables. No real worktree, cache or process was scanned, deleted or signalled.

Justus's Mac mini reached 98% disk: 55 GB of CoreSimulator devices, 36 T3 worktrees holding 29 GB, days-old vite/esbuild dev servers and orphaned test daemons. He asked Perpeto to keep machines from filling up. (The Mac this was built on also reported about 2.6% free during development, which the first unit test run caught before tests were given a fake disk.)

## How it fits together

```text
node (storage section in config)                                hub
 ├─ janitor scan every 15 min ─ inventory ─▶ POST /nodes/storage ─▶ storage-inventory, storage.scanned
 ├─ auto-clean policy-safe items ─ results ─▶ POST /nodes/storage ─▶ storage-cleanup (source auto), storage.cleaned
 ├─ heartbeat { storage: summary } ─────────────────────────────────▶ machine.storage, storage.low on worsening
 └─ heartbeat response { storage: { policy, activeBranches, scan?, cleanups? } } ◀── owner POST /machines/:id/storage/cleanup
```

| Piece | Where | What it does |
| --- | --- | --- |
| Janitor | `packages/janitor` | Policy (validate, layer, disk state, retention), bounded du-style sizing with a cache, read-only Git checks, stale process detection, inventory, cleanup plan, journaled execution. `fs` and `exec` are injected. |
| Node | `apps/node/src/storage.js`, small hooks in `node.js`, `config.js`, `job.js` | Roots, periodic scans, auto-clean, heartbeat summary, hub directives, cleanup dedup (`storage-cleanups.json`), deletion journal (`storage-journal.jsonl`), lease journal pruning, pause of agent leases while critical. Assignment workspaces are now named `<assignmentId>--a<attempt>--<suffix>`. |
| Hub | `apps/hub/src/storage.js`, a few lines in `hub.js` and `config.js` | Sanitizes summaries and inventories, owner annotation (assignment and branch to run and work item), cleanup requests relayed in heartbeat responses, fleet view and alerts, events, `storage` config. |
| CLI | `apps/cli/src/storage.js` | `perpeto storage [--machine <id>]`, `perpeto storage clean [--machine <id>] [--dry-run] [--items <ids>]`; `node join` writes `storage: {}` so nodes run the janitor. |
| Web, Apple | `apps/web/src/routes/storage.tsx`, `apps/apple` Storage view | Fleet disk bars, reclaimable by kind, items needing attention, advisory items with their commands, dry-run preview then cleanup. Demo data included. |

The contract is in the [architecture document](../architecture/README.md#storage-janitor).

## What it inventories

| Kind | Where | Deleted when (default policy) |
| --- | --- | --- |
| `perpeto-workspace` | `<node data>/assignments/*`, left by a crash or interrupted cleanup | No running assignment uses it, idle 24 h, and any clone or worktree inside is clean and pushed |
| `ci-workspace` | `$TMPDIR/perpeto-ci-*` (or `storage.ciTempDir`) | No running job uses it and idle 24 h. Other temp folders are never listed |
| `ci-cache` | `storage.ciCacheDir` (one folder per cache key; meant for the CI runners' `ciCacheRoot(config)`, not wired on this branch) | No CI job running and unused for 72 h; rebuilt on demand |
| `perpeto-worktree` | The managed runtime's `<baseDir>/worktrees/<repo>/<branch>` plus `perpetoWorktreeRoots` | Its branch is not an unfinished work item, no process runs in it, idle 24 h, clean and no unpushed commits |
| `t3-worktree` | `foreignWorktreeRoots` (default `~/.t3/worktrees`) | Only with `cleanupForeignWorktrees: true`, and only merged (ancestor or squash-equivalent), clean, pushed and idle 168 h |
| `build-artifact` | `node_modules`, `dist`, `build`, `.next`, `target`, `DerivedData`, `.build`, `.turbo`, caches… up to `maxDepth` inside kept worktrees | Stripped after 72 h idle, only if Git ignores it. Inside foreign worktrees only with `stripForeignArtifacts: true` |
| `global-cache` | npm cache, Xcode DerivedData, unavailable CoreSimulator devices | Never. Advisory, with the command to run |

Processes are advisory only: dev servers (vite, esbuild, next, webpack) whose working directory is gone or that ran longer than `staleProcessHours`, and booted simulators. A worktree any dev server still runs in is never reclaimable.

"Unpushed" means commits on HEAD that are on no remote-tracking branch and not in the base branch. "Idle" is the newest mtime in the tree outside artifact folders. Anything Git cannot answer reads as dirty.

Below `lowFreePercent` (15) a machine is `low` and retention shortens to 2 h for workspaces and 12 h for artifacts. Below `criticalFreePercent` (5) it is `critical`: the node stops polling for agent work until space frees (CI jobs and running work continue), the hub emits `storage.low` and `GET /storage` lists a critical alert. The fleet placement work can read `machine.storage.state`; the hub's own leasing does not yet consult it.

## Safety

- The hub only ever names items by id. The node acts on paths from its own latest scan, which re-runs before every cleanup.
- Right before deleting, each item is re-checked: still a real directory, not a symlink, real path unchanged, strictly inside an allowed root (the roots the node scanned; foreign roots only when foreign cleanup or stripping is on), not used by running work, Git still clean and pushed (artifacts: still ignored, foreign: still merged). A change since the scan gives `needs-attention` or `skipped`, never a deletion.
- `rm` unlinks symlinks inside a tree without following them. Sizing uses `lstat` and never follows links.
- Every deletion writes an intent line before and a done or failed line after to `<data>/storage-journal.jsonl` (rotated at 1 MB). A deleted linked worktree is pruned from its repository's worktree list.
- Scans are bounded: 400,000 entries and 120 s per scan, depth 4 for artifacts, 500 worktrees per root, 10 s per command, Git without optional locks. Sizes stop early as `approximate`; results are cached for 6 h while a folder's mtime is unchanged.
- Dry runs run every check and delete nothing. Owner cleanups are idempotent by `idempotencyKey`; the node remembers the last 100 cleanup ids and never runs one twice.

## Also fixed

Review wave 3 L10: assignment workspaces left by a crash are now found and cleaned (and carry their assignment id), and the lease journal keeps only the latest 2,000 leases instead of growing forever.

## Verification

- `packages/janitor`: 8 tests with real Git repositories, bare origins and linked worktrees in temp folders: classification, retention and aggressive mode, foreign opt-in, dry run versus execute, journal and worktree pruning, symlink swap, late edits, roots outside the allowed set, sizing budget and symlinks, stale processes with a fake `ps`/`lsof`/`simctl`.
- `apps/hub/test/storage.test.js`: 4 tests (summaries onto machines, overrides, low/critical events and alerts, sanitization, owner annotation, token boundaries, idempotent cleanups relayed and completed once, auto cleanups, scan requests, revoked machines, config validation).
- `apps/node/test/storage.test.js`: 3 tests (config, auto-clean of leftovers, relayed dry run not re-run, critical disk pauses agent leases, workspace naming, journal pruning).
- `apps/cli/test/storage.test.js`: 2 tests against a real hub.
- `tests/e2e/test/storage.test.js`: a real hub and a real node daemon over HTTP: first scan, per-machine policy override, dry run, idempotent execute of one item, worktree pruned, critical disk raised.
- Full runs on this branch: `npm test` **642/642**, web Vitest **147/147** plus `tsc --noEmit`, Apple `swift test` **124 tests**. Web screenshots (demo data, light and dark, desktop, mobile and cleanup preview) are in `apps/web/screenshots/storage/`.

## Not verified

- No real disk, worktree, cache or process. Sizes on a 55 GB CoreSimulator folder or 29 GB of worktrees, scan duration on APFS, and `lsof`/`simctl` output parsing on a live Mac are untested beyond fixtures.
- Linux `/proc/<pid>/cwd` detection is written but only the macOS path is covered by tests.
- Squash-merge detection uses `git merge-tree --write-tree` (Git 2.38+); older Git treats such branches as unmerged, which only keeps more.
- T3's own record of a deleted factory worktree is not updated; T3 recreates a missing managed worktree when a thread needs it.
- `ciCacheDir` must be set to the CI runners' cache root once both branches merge.
- The hub does not yet skip critical machines when leasing; the node does. Worker B's placement is expected to read `machine.storage.state`.
- A node's local `storage` fields are not reported back, so the hub's `GET /machines/:id/storage` policy omits them.
