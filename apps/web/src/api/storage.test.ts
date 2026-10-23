import { describe, expect, it } from 'vitest';
import { cleanupTotals, decodeCleanup, decodeFleetStorage, decodeMachineStorage, formatBytes, kindRows, previewedIds, attentionText } from './storage';
import { DemoStorage } from './storage-fixtures';

const id = (n: number) => `sti_${String(n).padStart(20, '0')}`;
const summary = {
  scannedAt: '2026-10-23T08:00:00.000Z',
  state: 'critical',
  disk: { totalBytes: 500e9, freeBytes: 20e9 },
  truncated: false,
  reclaimableBytes: 7e9,
  reclaimableByKind: { 'perpeto-worktree': 6e9, 'build-artifact': 1e9, bogus: 5 },
  advisoryBytes: 50e9,
  attentionCount: 2,
  staleProcesses: 1,
  items: 9,
  top: [{ id: id(1), kind: 'perpeto-worktree', path: '~/w', bytes: 6e9, reclaimable: true }, { id: id(2), kind: 'nope', path: '~/x', bytes: 1 }],
};

describe('storage decoding', () => {
  it('decodes the fleet view and drops malformed entries', () => {
    const fleet = decodeFleetStorage({
      machines: [{ machineId: 'mch_1', name: 'mini', status: 'online', online: true, state: 'critical', storage: summary }, { name: 'no id' }, { machineId: 'mch_2', storage: { state: 'ok' } }],
      totals: { totalBytes: 500e9, freeBytes: 20e9, reclaimableBytes: 7e9, reclaimableByKind: { 'perpeto-worktree': 6e9 } },
      alerts: [{ machineId: 'mch_1', name: 'mini', state: 'critical', severity: 'critical', evidence: '4% free', freePercent: 4 }],
      policy: { finishedWorkspaceTtlHours: 24, autoClean: true, junk: 1 },
    });
    expect(fleet.machines).toHaveLength(2);
    expect(fleet.machines[0].storage?.reclaimableByKind).toEqual({ 'perpeto-worktree': 6e9, 'build-artifact': 1e9 });
    expect(fleet.machines[0].storage?.top).toHaveLength(1);
    // A summary without a scan time is no summary; the machine stays.
    expect(fleet.machines[1]).toMatchObject({ machineId: 'mch_2', name: 'mch_2', storage: null, state: 'ok' });
    expect(fleet.alerts[0]).toMatchObject({ severity: 'critical', freePercent: 4 });
    expect(fleet.policy).toEqual({ finishedWorkspaceTtlHours: 24, autoClean: true });
  });

  it('tolerates an empty or odd body', () => {
    expect(decodeFleetStorage(null)).toEqual({ machines: [], totals: { totalBytes: 0, freeBytes: 0, reclaimableBytes: 0, advisoryBytes: 0, attentionCount: 0, reclaimableByKind: {} }, alerts: [], policy: {} });
    expect(decodeMachineStorage({ machineId: 'mch_1' }).inventory).toBeNull();
  });

  it('decodes a machine inventory and its cleanups', () => {
    const machine = decodeMachineStorage({
      machineId: 'mch_1',
      name: 'mini',
      online: true,
      storage: summary,
      inventory: {
        scannedAt: '2026-10-23T08:00:00.000Z',
        state: 'critical',
        aggressive: true,
        items: [
          { id: id(3), kind: 'perpeto-worktree', path: '~/w', bytes: 5, reclaimable: false, attention: true, reason: 'r', gitState: { branch: 'b', dirty: true, unpushedCommits: 2 }, owner: { runId: 'run_1', evil: 1 } },
          { id: id(4), kind: 'bad', path: '~/x' },
        ],
        processes: [{ kind: 'dev-server', name: 'vite', pid: 1, reason: 'old' }, { kind: 'daemon' }],
      },
      cleanups: [{ cleanup: { id: 'scl_1', status: 'completed', mode: 'execute', result: { freedBytes: 9, actions: [{ itemId: id(1), status: 'deleted', bytes: 9 }, { itemId: id(2), status: 'weird', bytes: 1 }] } } }],
    });
    expect(machine.inventory?.items).toHaveLength(1);
    expect(machine.inventory?.items[0].owner).toEqual({ runId: 'run_1' });
    expect(attentionText(machine.inventory!.items[0])).toBe('Uncommitted changes and 2 unpushed commits');
    expect(machine.inventory?.processes).toHaveLength(1);
    expect(machine.cleanups[0].result?.actions.map((a) => a.status)).toEqual(['deleted', 'skipped']);
  });

  it('reads a cleanup in its envelope and totals it', () => {
    const cleanup = decodeCleanup({
      cleanup: { id: 'scl_2', machineId: 'mch_1', mode: 'dry-run', status: 'completed', requestedAt: '2026-10-23T08:00:00.000Z', result: { dryRun: true, freedBytes: 30, actions: [
        { itemId: id(1), status: 'would-delete', bytes: 20 }, { itemId: id(2), status: 'would-strip', bytes: 10 }, { itemId: id(3), status: 'skipped', bytes: 4 } ] } },
    })!;
    expect(previewedIds(cleanup)).toEqual([id(1), id(2)]);
    expect(cleanupTotals(cleanup)).toEqual({ done: 2, bytes: 30, skipped: 1, attention: 0, failed: 0 });
    expect(decodeCleanup({})).toBeNull();
  });

  it('formats bytes in decimal units and orders kinds by size', () => {
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(29.4e9)).toBe('29.4 GB');
    expect(formatBytes(494e9)).toBe('494 GB');
    expect(formatBytes(1.2e12)).toBe('1.2 TB');
    expect(kindRows({ 'build-artifact': 1, 'perpeto-worktree': 5 }).map((r) => r.kind)).toEqual(['perpeto-worktree', 'build-artifact']);
  });
});

describe('demo storage', () => {
  it('previews, then executes, freeing the disk', () => {
    const now = Date.now();
    const demo = new DemoStorage(now, { studio: { id: 'mch_studio', name: 'mini' }, linux: { id: 'mch_linux', name: 'linux' } });
    const before = demo.fleet();
    expect(before.alerts.map((a) => a.severity)).toContain('critical');
    const mini = demo.machine('mch_studio');
    const ids = mini.inventory!.items.filter((i) => i.reclaimable).map((i) => i.id);
    const dry = demo.request('mch_studio', { mode: 'dry-run', itemIds: ids });
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 5000;
      const preview = demo.cleanup('mch_studio', dry.id);
      expect(preview.status).toBe('completed');
      expect(preview.result?.dryRun).toBe(true);
      expect(demo.machine('mch_studio').inventory!.items.length).toBe(mini.inventory!.items.length);
      const run = demo.request('mch_studio', { mode: 'execute', itemIds: previewedIds(preview) });
      Date.now = () => realNow() + 10_000;
      const done = demo.cleanup('mch_studio', run.id);
      expect(done.result?.freedBytes).toBe(preview.result?.freedBytes);
      expect(demo.machine('mch_studio').storage!.disk!.freeBytes).toBeGreaterThan(mini.storage!.disk!.freeBytes);
      expect(demo.machine('mch_studio').inventory!.items.some((i) => i.reclaimable)).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });
});
