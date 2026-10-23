import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { owner, request } from './api.js';

const KIND_LABELS = { 'perpeto-workspace': 'assignment workspaces', 'ci-workspace': 'CI workspaces', 'ci-cache': 'CI caches', 'perpeto-worktree': 'Perpeto worktrees', 't3-worktree': 'T3 worktrees',
  'build-artifact': 'build artifacts', 'global-cache': 'global caches' };
export function bytes(value) {
  if (!Number.isFinite(value)) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0; let amount = value;
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index++; }
  return `${amount >= 100 || index === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[index]}`;
}
const free = storage => storage?.disk ? `${((storage.disk.freeBytes / storage.disk.totalBytes) * 100).toFixed(1)}% free (${bytes(storage.disk.freeBytes)} of ${bytes(storage.disk.totalBytes)})` : 'disk unknown';

/** `perpeto storage [--machine <id>]`: the fleet, or one machine's inventory. */
export async function showStorage(dir, { machine, fetchImpl = fetch, print = console.log } = {}) {
  const { url, token, pins } = await owner(dir);
  const get = path => request(url, path, { token, pins, fetchImpl });
  if (!machine) {
    const fleet = await get('/storage');
    if (!fleet.machines.length) { print('No machines enrolled.'); return fleet; }
    for (const entry of fleet.machines) {
      const storage = entry.storage;
      print(`${entry.name} (${entry.machineId}): ${storage ? `${entry.state}, ${free(storage)}, ${bytes(storage.reclaimableBytes)} reclaimable${storage.attentionCount ? `, ${storage.attentionCount} need attention` : ''}` : 'no storage report yet'}${entry.online ? '' : ', offline'}`);
    }
    for (const alert of fleet.alerts) print(`${alert.severity === 'critical' ? 'CRITICAL' : 'LOW'} ${alert.name}: ${alert.evidence}`);
    const kinds = Object.entries(fleet.totals.reclaimableByKind).sort((a, b) => b[1] - a[1]).map(([kind, value]) => `${KIND_LABELS[kind] ?? kind} ${bytes(value)}`);
    print(`Reclaimable across the fleet: ${bytes(fleet.totals.reclaimableBytes)}${kinds.length ? ` (${kinds.join(', ')})` : ''}`);
    return fleet;
  }
  const view = await get(`/machines/${encodeURIComponent(machine)}/storage`);
  print(`${view.name}: ${view.state}, ${free(view.storage)}`);
  if (!view.inventory) { print('No inventory yet; the machine reports after its first scan.'); return view; }
  const items = view.inventory.items;
  const section = (title, list, line) => { if (!list.length) return; print(`\n${title}`); for (const item of list.slice(0, 25)) print(line(item)); if (list.length > 25) print(`  … ${list.length - 25} more`); };
  const describe = item => `  ${item.id}  ${bytes(item.bytes).padStart(8)}  ${item.path}${item.gitState?.branch ? ` [${item.gitState.branch}]` : ''}\n      ${item.reason}`;
  section('Needs attention', items.filter(item => item.attention), describe);
  section('Reclaimable', items.filter(item => item.reclaimable).sort((a, b) => b.bytes - a.bytes), item => `${describe(item)} (${item.action})`);
  section('Advisory', items.filter(item => item.advisory), item => `  ${bytes(item.bytes).padStart(8)}  ${item.name ?? item.path}: ${item.hint ?? item.reason}`);
  section('Processes', view.inventory.processes, item => `  ${item.name}${item.pid ? ` (pid ${item.pid})` : ''}: ${item.reason}${item.hint ? ` Run: ${item.hint}` : ''}`);
  print(`\nScanned ${view.inventory.scannedAt}${view.inventory.truncated ? ' (sizes are approximate; the scan hit its limits)' : ''}.`);
  return view;
}

/**
 * `perpeto storage clean [--machine <id>] [--dry-run] [--items <ids>]`: ask machines to clean (or preview) and wait for
 * their results. Without --machine every online machine with a storage report is asked. Deletion happens on the machine.
 */
export async function cleanStorage(dir, { machine, dryRun = false, itemIds, fetchImpl = fetch, print = console.log, timeoutMs = 90_000, pollMs = 1000 } = {}) {
  const { url, token, pins } = await owner(dir);
  const call = (path, body) => request(url, path, { token, pins, fetchImpl, ...(body ? { body } : {}) });
  const targets = machine ? [machine] : (await call('/storage')).machines.filter(entry => entry.online && entry.storage).map(entry => entry.machineId);
  if (!targets.length) { print('No online machine has reported storage yet.'); return []; }
  const mode = dryRun ? 'dry-run' : 'execute';
  const requested = [];
  for (const target of targets) {
    const { cleanup } = await call(`/machines/${encodeURIComponent(target)}/storage/cleanup`, { mode, ...(itemIds?.length ? { itemIds } : {}), idempotencyKey: randomUUID() });
    requested.push(cleanup);
  }
  const results = [];
  const deadline = Date.now() + timeoutMs;
  for (const cleanup of requested) {
    let current = cleanup;
    while (current.status !== 'completed' && Date.now() < deadline) {
      await delay(pollMs);
      current = (await call(`/machines/${encodeURIComponent(cleanup.machineId)}/storage/cleanups/${encodeURIComponent(cleanup.id)}`)).cleanup;
    }
    results.push(current);
    if (current.status !== 'completed') { print(`${cleanup.machineId}: requested (${cleanup.id}); the machine has not reported yet. It runs on its next heartbeat.`); continue; }
    const actions = current.result.actions;
    const done = actions.filter(action => ['deleted', 'stripped', 'would-delete', 'would-strip'].includes(action.status));
    print(`${cleanup.machineId}: ${dryRun ? 'would free' : 'freed'} ${bytes(current.result.freedBytes)} (${done.length} item${done.length === 1 ? '' : 's'})`);
    for (const action of actions.slice(0, 40)) print(`  ${action.status.padEnd(15)} ${bytes(action.bytes).padStart(8)}  ${action.path ?? action.itemId}${action.reason ? `: ${action.reason}` : ''}`);
    if (actions.length > 40) print(`  … ${actions.length - 40} more`);
  }
  return results;
}
