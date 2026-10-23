import { HubError } from './hub';
import type {
  CleanupAction,
  CleanupRequest,
  FleetStorage,
  MachineStorage,
  MachineStorageSummary,
  StaleProcess,
  StorageCleanup,
  StorageInventory,
  StorageItem,
  StorageKind,
  StoragePolicy,
  StorageState,
  StorageSummary,
} from './storage';

/*
 * Demo storage: the situation that motivated the janitor. The Mac mini is
 * nearly full (simulators, 36 T3 worktrees, old dev servers), the MacBook is
 * low and the Linux box is fine. Cleanups run in memory: a dry run lists what
 * would go, an executed one removes it and frees the disk.
 */

const GB = 1e9;
const MB = 1e6;
const HOUR = 3_600_000;

const POLICY: StoragePolicy = { finishedWorkspaceTtlHours: 24, idleArtifactTtlHours: 72, cleanupForeignWorktrees: false, autoClean: true, lowFreePercent: 15, criticalFreePercent: 5 };

interface DemoMachine {
  id: string;
  name: string;
  totalBytes: number;
  freeBytes: number;
  items: StorageItem[];
  processes: StaleProcess[];
}

let seq = 0;
const sid = () => `sti_${(++seq).toString(16).padStart(20, '0')}`;

type Spec = Partial<StorageItem> & { kind: StorageKind; path: string; bytes: number; hoursIdle: number };
function item(now: number, s: Spec): StorageItem {
  const { hoursIdle, ...rest } = s;
  return { id: sid(), owner: {}, reclaimable: false, reason: '', lastModifiedAt: new Date(now - hoursIdle * HOUR).toISOString(), ...rest };
}

function macMini(now: number, id: string, name: string): DemoMachine {
  const merged = item(now, {
    kind: 'perpeto-worktree',
    path: '~/.perpeto/runtime/worktrees/perpeto/wi-hub-metrics',
    bytes: 3.4 * GB,
    hoursIdle: 52,
    reclaimable: true,
    action: 'delete',
    reason: 'Work is merged and no active work item uses it; idle 52 h.',
    gitState: { branch: 'wi-hub-metrics', dirty: false, unpushedCommits: 0, merged: true },
    owner: { runId: 'run_7q4m2x', workItemId: 'wi_7q4m2x_3' },
    ownedBy: 'perpeto',
    repo: 'perpeto',
  });
  const pushed = item(now, {
    kind: 'perpeto-worktree',
    path: '~/.perpeto/runtime/worktrees/perpeto/wi-node-drain',
    bytes: 2.6 * GB,
    hoursIdle: 31,
    reclaimable: true,
    action: 'delete',
    reason: 'Work is pushed and no active work item uses it; idle 31 h.',
    gitState: { branch: 'wi-node-drain', dirty: false, unpushedCommits: 0, merged: false },
    owner: { runId: 'run_7q4m2x', workItemId: 'wi_7q4m2x_5' },
    ownedBy: 'perpeto',
    repo: 'perpeto',
  });
  const dirty = item(now, {
    kind: 'perpeto-worktree',
    path: '~/.perpeto/runtime/worktrees/perpeto/wi-web-live-map',
    bytes: 2.2 * GB,
    hoursIdle: 80,
    attention: true,
    reason: 'Has uncommitted changes; review before deleting.',
    gitState: { branch: 'wi-web-live-map', dirty: true, unpushedCommits: 2 },
    owner: { runId: 'run_7q4m2x', workItemId: 'wi_7q4m2x_8' },
    ownedBy: 'perpeto',
    repo: 'perpeto',
  });
  const artifacts = [
    item(now, {
      kind: 'build-artifact',
      path: '~/.perpeto/runtime/worktrees/perpeto/wi-web-live-map/node_modules',
      name: 'node_modules',
      bytes: 1.5 * GB,
      hoursIdle: 80,
      parentId: dirty.id,
      reclaimable: true,
      action: 'strip',
      reason: 'Git-ignored build output in a worktree idle for 80 h.',
      ownedBy: 'perpeto',
    }),
    item(now, {
      kind: 'build-artifact',
      path: '~/.perpeto/runtime/worktrees/perpeto/wi-web-live-map/apps/web/dist',
      name: 'dist',
      bytes: 48 * MB,
      hoursIdle: 80,
      parentId: dirty.id,
      reclaimable: true,
      action: 'strip',
      reason: 'Git-ignored build output in a worktree idle for 80 h.',
      ownedBy: 'perpeto',
    }),
  ];
  const leftover = item(now, {
    kind: 'perpeto-workspace',
    path: '~/.perpeto/node/assignments/asg_9f2c1e--a2--3b7d91aa',
    bytes: 640 * MB,
    hoursIdle: 40,
    reclaimable: true,
    action: 'delete',
    reason: 'No running assignment uses it; idle 40 h.',
    owner: { assignmentId: 'asg_9f2c1e', runId: 'run_7q4m2x' },
    ownedBy: 'perpeto',
  });
  const unpushedWorkspace = item(now, {
    kind: 'perpeto-workspace',
    path: '~/.perpeto/node/assignments/asg_41aa07--a1--c0ffee12',
    bytes: 910 * MB,
    hoursIdle: 70,
    attention: true,
    reason: 'Has 1 unpushed commit; review before deleting.',
    gitState: { branch: 'wi-accounts-terms', dirty: false, unpushedCommits: 1 },
    owner: { assignmentId: 'asg_41aa07', runId: 'run_7q4m2x' },
    ownedBy: 'perpeto',
  });
  const ci = item(now, {
    kind: 'ci-workspace',
    path: '$TMPDIR/perpeto-ci-x81Hq2',
    bytes: 1.1 * GB,
    hoursIdle: 27,
    reclaimable: true,
    action: 'delete',
    reason: 'Left by a finished CI job; idle 27 h.',
    ownedBy: 'perpeto',
  });
  const t3 = (
    [
      ['perpeto/codex-observe-mode', 7.8, 5, true],
      ['perpeto/claude-pacer-rework', 6.1, 30, false],
      ['tiny-text/feature-export', 4.9, 210, true],
      ['perpeto/apple-tls-pin', 4.2, 96, true],
      ['cooler/fix-sync', 3.3, 400, false],
      ['perpeto/codex-web-usage', 2.7, 150, true],
    ] as const
  ).map(([rel, gb, idle, merged]) =>
    item(now, {
      kind: 't3-worktree',
      path: `~/.t3/worktrees/${rel}`,
      bytes: gb * GB,
      hoursIdle: idle,
      reason: 'Not created by Perpeto; inventory only (cleanupForeignWorktrees is off).',
      gitState: { branch: rel.split('/')[1], dirty: !merged, unpushedCommits: 0, merged },
      ownedBy: 'foreign',
      repo: rel.split('/')[0],
    }),
  );
  const caches = [
    item(now, {
      kind: 'global-cache',
      path: '~/Library/Developer/CoreSimulator/Devices',
      name: '14 unavailable simulators',
      bytes: 38 * GB,
      approximate: true,
      hoursIdle: 600,
      advisory: true,
      reason: 'Simulators for runtimes that are no longer installed.',
      hint: 'xcrun simctl delete unavailable',
      ownedBy: 'system',
    }),
    item(now, {
      kind: 'global-cache',
      path: '~/Library/Developer/Xcode/DerivedData',
      name: 'Xcode DerivedData',
      bytes: 12.4 * GB,
      hoursIdle: 20,
      advisory: true,
      reason: 'Shared cache; clearing it is your call.',
      hint: 'Remove folders in ~/Library/Developer/Xcode/DerivedData while Xcode is closed',
      ownedBy: 'system',
    }),
    item(now, {
      kind: 'global-cache',
      path: '~/.npm/_cacache',
      name: 'npm cache',
      bytes: 4.8 * GB,
      hoursIdle: 3,
      advisory: true,
      reason: 'Shared cache; clearing it is your call.',
      hint: 'npm cache clean --force',
      ownedBy: 'system',
    }),
  ];
  return {
    id,
    name,
    totalBytes: 494 * GB,
    freeBytes: 19.8 * GB,
    items: [merged, pushed, dirty, ...artifacts, leftover, unpushedWorkspace, ci, ...t3, ...caches],
    processes: [
      { kind: 'dev-server', name: 'vite', pid: 48211, elapsedSec: 3 * 86_400 + 7200, cwd: '~/.t3/worktrees/perpeto/codex-web-usage-old', cwdMissing: true, reason: 'Its working directory no longer exists; it is likely orphaned.', hint: 'kill 48211' },
      { kind: 'dev-server', name: 'esbuild', pid: 48230, elapsedSec: 3 * 86_400 + 7100, cwd: '~/.t3/worktrees/perpeto/codex-web-usage-old', cwdMissing: true, reason: 'Its working directory no longer exists; it is likely orphaned.', hint: 'kill 48230' },
      { kind: 'dev-server', name: 'next', pid: 51902, elapsedSec: 31 * 3600, cwd: '~/.t3/worktrees/tiny-text/feature-export', reason: 'Running for 31 h.', hint: 'kill 51902' },
      { kind: 'simulator', name: 'iPhone 17 Pro', udid: '6F1C2A90-1D7B-4E55-9C3A-2B8E4F1A7C11', reason: 'Booted simulator; each holds memory and disk while running.', hint: 'xcrun simctl shutdown 6F1C2A90-1D7B-4E55-9C3A-2B8E4F1A7C11' },
    ],
  };
}

function linuxBox(now: number, id: string, name: string): DemoMachine {
  return {
    id,
    name,
    totalBytes: 2_000 * GB,
    freeBytes: 1_220 * GB,
    items: [
      item(now, { kind: 'ci-workspace', path: '$TMPDIR/perpeto-ci-Qm7a0c', bytes: 2.3 * GB, hoursIdle: 3, reason: 'Idle 3 h; CI workspaces are kept 24 h.', ownedBy: 'perpeto' }),
      item(now, {
        kind: 'perpeto-worktree',
        path: '~/.perpeto/runtime/worktrees/perpeto/wi-delivery-batching',
        bytes: 1.9 * GB,
        hoursIdle: 1,
        reason: 'Its work item is still active.',
        gitState: { branch: 'wi-delivery-batching', dirty: true, unpushedCommits: 0 },
        owner: { runId: 'run_7q4m2x', workItemId: 'wi_7q4m2x_2' },
        ownedBy: 'perpeto',
      }),
      item(now, {
        kind: 'perpeto-worktree',
        path: '~/.perpeto/runtime/worktrees/perpeto/wi-cli-install',
        bytes: 1.2 * GB,
        hoursIdle: 4,
        reason: 'Idle 4 h; finished worktrees are kept 24 h.',
        gitState: { branch: 'wi-cli-install', dirty: false, unpushedCommits: 0, merged: true },
        ownedBy: 'perpeto',
      }),
      item(now, { kind: 'global-cache', path: '~/.npm/_cacache', name: 'npm cache', bytes: 3.1 * GB, hoursIdle: 2, advisory: true, reason: 'Shared cache; clearing it is your call.', hint: 'npm cache clean --force', ownedBy: 'system' }),
    ],
    processes: [],
  };
}

function macBook(now: number): DemoMachine {
  const worktree = item(now, {
    kind: 'perpeto-worktree',
    path: '~/.perpeto/runtime/worktrees/perpeto/wi-goals-intake',
    bytes: 1.8 * GB,
    hoursIdle: 6,
    reason: 'Idle 6 h; finished worktrees are kept 2 h.',
    reclaimable: true,
    action: 'delete',
    gitState: { branch: 'wi-goals-intake', dirty: false, unpushedCommits: 0, merged: true },
    ownedBy: 'perpeto',
  });
  worktree.reason = 'Work is merged and no active work item uses it; idle 6 h (aggressive retention).';
  return {
    id: 'mch_macbook',
    name: 'justus-macbook',
    totalBytes: 994 * GB,
    freeBytes: 109 * GB,
    items: [
      worktree,
      item(now, {
        kind: 't3-worktree',
        path: '~/.t3/worktrees/perpeto/claude-docs-pass',
        bytes: 2.4 * GB,
        hoursIdle: 12,
        reason: 'Not created by Perpeto; inventory only (cleanupForeignWorktrees is off).',
        gitState: { branch: 'claude-docs-pass', dirty: false, unpushedCommits: 0, merged: false },
        ownedBy: 'foreign',
      }),
      item(now, {
        kind: 'global-cache',
        path: '~/Library/Developer/Xcode/DerivedData',
        name: 'Xcode DerivedData',
        bytes: 21 * GB,
        hoursIdle: 1,
        advisory: true,
        reason: 'Shared cache; clearing it is your call.',
        hint: 'Remove folders in ~/Library/Developer/Xcode/DerivedData while Xcode is closed',
        ownedBy: 'system',
      }),
    ],
    processes: [],
  };
}

function stateOf(m: DemoMachine): StorageState {
  const free = (m.freeBytes / m.totalBytes) * 100;
  return free < (POLICY.criticalFreePercent ?? 5) ? 'critical' : free < (POLICY.lowFreePercent ?? 15) ? 'low' : 'ok';
}

function summarize(m: DemoMachine, scannedAt: string): StorageSummary {
  const deleted = new Set(m.items.filter((i) => i.reclaimable && i.action === 'delete').map((i) => i.id));
  const byKind: Partial<Record<StorageKind, number>> = {};
  for (const i of m.items) if (i.reclaimable && !(i.parentId && deleted.has(i.parentId))) byKind[i.kind] = (byKind[i.kind] ?? 0) + i.bytes;
  return {
    scannedAt,
    state: stateOf(m),
    disk: { totalBytes: m.totalBytes, freeBytes: m.freeBytes },
    truncated: false,
    reclaimableBytes: Object.values(byKind).reduce((s, b) => s + (b ?? 0), 0),
    reclaimableByKind: byKind,
    advisoryBytes: m.items.filter((i) => i.advisory).reduce((s, i) => s + i.bytes, 0),
    attentionCount: m.items.filter((i) => i.attention).length,
    staleProcesses: m.processes.length,
    items: m.items.length,
    top: m.items
      .filter((i) => i.reclaimable || i.attention)
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 5)
      .map((i) => ({ id: i.id, kind: i.kind, path: i.path, bytes: i.bytes, reclaimable: i.reclaimable, ...(i.attention ? { attention: true } : {}) })),
  };
}

/** The demo hub's storage: a fleet view, per-machine inventories and in-memory cleanups. */
export class DemoStorage {
  #machines: DemoMachine[];
  #cleanups: (StorageCleanup & { readyAt: number })[] = [];
  #scannedAt: string;

  constructor(now: number, known: { studio: { id: string; name: string }; linux: { id: string; name: string } }) {
    seq = 0;
    this.#machines = [macMini(now, known.studio.id, known.studio.name), macBook(now), linuxBox(now, known.linux.id, known.linux.name)];
    this.#scannedAt = new Date(now - 6 * 60_000).toISOString();
  }

  #machine(id: string): DemoMachine {
    const m = this.#machines.find((x) => x.id === id);
    if (!m) throw new HubError(404, 'NOT_FOUND', 'Machine was not found.');
    return m;
  }

  #summary(m: DemoMachine): MachineStorageSummary {
    const last = this.#cleanups.filter((c) => c.machineId === m.id).at(-1);
    return {
      machineId: m.id,
      name: m.name,
      status: 'online',
      online: true,
      state: stateOf(m),
      storage: summarize(m, this.#scannedAt),
      ...(last ? { lastCleanup: { id: last.id, mode: last.mode, status: last.status, source: last.source, ...(last.result ? { freedBytes: last.result.freedBytes } : {}), at: last.completedAt ?? last.requestedAt } } : {}),
    };
  }

  fleet(): FleetStorage {
    const machines = this.#machines.map((m) => this.#summary(m));
    const byKind: Partial<Record<StorageKind, number>> = {};
    for (const m of machines) for (const [k, b] of Object.entries(m.storage?.reclaimableByKind ?? {})) byKind[k as StorageKind] = (byKind[k as StorageKind] ?? 0) + (b ?? 0);
    return {
      machines,
      totals: {
        totalBytes: this.#machines.reduce((s, m) => s + m.totalBytes, 0),
        freeBytes: this.#machines.reduce((s, m) => s + m.freeBytes, 0),
        reclaimableBytes: machines.reduce((s, m) => s + (m.storage?.reclaimableBytes ?? 0), 0),
        advisoryBytes: machines.reduce((s, m) => s + (m.storage?.advisoryBytes ?? 0), 0),
        attentionCount: machines.reduce((s, m) => s + (m.storage?.attentionCount ?? 0), 0),
        reclaimableByKind: byKind,
      },
      alerts: this.#machines
        .filter((m) => stateOf(m) !== 'ok')
        .map((m) => {
          const s = stateOf(m);
          const pct = Math.round((m.freeBytes / m.totalBytes) * 1000) / 10;
          return {
            machineId: m.id,
            name: m.name,
            state: s,
            severity: s === 'critical' ? ('critical' as const) : ('warning' as const),
            evidence: `${pct}% free${s === 'critical' ? '; new agent work is paused on this machine' : '; aggressive retention is on'}`,
            freePercent: pct,
          };
        }),
      policy: POLICY,
    };
  }

  machine(id: string): MachineStorage {
    const m = this.#machine(id);
    this.#settle();
    const inventory: StorageInventory = {
      scannedAt: this.#scannedAt,
      durationMs: 8_400,
      truncated: false,
      disk: { totalBytes: m.totalBytes, freeBytes: m.freeBytes },
      state: stateOf(m),
      aggressive: stateOf(m) !== 'ok',
      retention: { finishedWorkspaceTtlHours: stateOf(m) === 'ok' ? 24 : 2, idleArtifactTtlHours: stateOf(m) === 'ok' ? 72 : 12, cleanupForeignWorktrees: false, autoClean: true },
      items: structuredClone(m.items),
      processes: structuredClone(m.processes),
    };
    return { ...this.#summary(m), policy: POLICY, inventory, inventoryAt: this.#scannedAt, cleanups: structuredClone(this.#cleanups.filter((c) => c.machineId === id).reverse()) };
  }

  request(machineId: string, request: CleanupRequest): StorageCleanup {
    this.#machine(machineId);
    const cleanup = {
      id: `scl_${Math.random().toString(36).slice(2, 10)}`,
      machineId,
      mode: request.mode,
      ...(request.itemIds ? { itemIds: [...request.itemIds] } : {}),
      source: 'owner' as const,
      status: 'pending' as const,
      requestedAt: new Date().toISOString(),
      // The node picks it up on its next heartbeat and reports back a moment later.
      readyAt: Date.now() + 900,
    };
    this.#cleanups.push(cleanup);
    return structuredClone(cleanup);
  }

  scan(machineId: string) {
    this.#machine(machineId);
    this.#scannedAt = new Date().toISOString();
    return { machineId, scanRequestedAt: this.#scannedAt };
  }

  cleanup(machineId: string, cleanupId: string): StorageCleanup {
    this.#settle();
    const c = this.#cleanups.find((x) => x.id === cleanupId && x.machineId === machineId);
    if (!c) throw new HubError(404, 'NOT_FOUND', 'Cleanup not found.');
    return structuredClone(c);
  }

  /** Complete cleanups whose machine has "reported back". */
  #settle() {
    const now = Date.now();
    for (const c of this.#cleanups) {
      if (c.status === 'completed') continue;
      if (now < c.readyAt - 600) continue;
      if (now < c.readyAt) {
        c.status = 'running';
        c.deliveredAt ??= new Date().toISOString();
        continue;
      }
      const m = this.#machine(c.machineId);
      const wanted = c.itemIds ? m.items.filter((i) => c.itemIds!.includes(i.id)) : m.items.filter((i) => i.reclaimable);
      const deleting = new Set(wanted.filter((i) => i.action === 'delete').map((i) => i.id));
      const actions: CleanupAction[] = [];
      for (const i of wanted) {
        if (i.parentId && deleting.has(i.parentId)) continue;
        if (!i.reclaimable || !i.action) {
          actions.push({ itemId: i.id, kind: i.kind, path: i.path, bytes: i.bytes, status: 'skipped', reason: i.reason });
          continue;
        }
        const dry = c.mode === 'dry-run';
        actions.push({ itemId: i.id, kind: i.kind, path: i.path, action: i.action, bytes: i.bytes, status: dry ? (i.action === 'strip' ? 'would-strip' : 'would-delete') : i.action === 'strip' ? 'stripped' : 'deleted' });
      }
      const freed = actions.filter((a) => ['deleted', 'stripped', 'would-delete', 'would-strip'].includes(a.status)).reduce((s, a) => s + a.bytes, 0);
      if (c.mode === 'execute') {
        const gone = new Set(actions.filter((a) => a.status === 'deleted' || a.status === 'stripped').map((a) => a.itemId));
        m.items = m.items.filter((i) => !gone.has(i.id) && !(i.parentId && gone.has(i.parentId)));
        m.freeBytes = Math.min(m.totalBytes, m.freeBytes + freed);
        this.#scannedAt = new Date().toISOString();
      }
      c.status = 'completed';
      c.deliveredAt ??= new Date().toISOString();
      c.completedAt = new Date().toISOString();
      c.result = { dryRun: c.mode === 'dry-run', freedBytes: freed, actions };
    }
  }
}
