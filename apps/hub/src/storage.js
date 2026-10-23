import { randomUUID } from 'node:crypto';
import { KINDS, POLICY_DEFAULTS, mergePolicy, validatePolicy } from '@perpeto/janitor';
import { fail, object, requireValue } from './errors.js';

/**
 * Storage janitor on the hub: machines' storage summaries (from heartbeats) and inventories (from `POST /nodes/storage`),
 * owner cleanup requests relayed in heartbeat responses, fleet views and storage events. Deletion always happens on the
 * machine, against paths the machine found itself; the hub only ever names items by id.
 */

export const STORAGE_CONFIG_DEFAULTS = Object.freeze({ policy: {}, machines: {} });
const STATES = ['ok', 'low', 'critical'];
const ITEM_ID = /^sti_[a-f0-9]{20}$/;
const CLEANUPS_KEPT = 30;
const MAX_ITEMS = 2000;
const BRANCHES_TTL_MS = 30_000;

/** Validate the hub's `storage` config section: `{ policy, machines: { <machine id or name>: policy } }`. */
export function storageConfig(value = {}) {
  object(value, 'storage');
  requireValue(Object.keys(value).every(key => ['policy', 'machines'].includes(key)), 'storage accepts policy and machines.');
  const policy = value.policy ?? {};
  const machines = object(value.machines ?? {}, 'storage.machines');
  try {
    validatePolicy(policy, 'storage.policy'); mergePolicy(policy);
    for (const [name, override] of Object.entries(machines)) { validatePolicy(override, `storage.machines.${name}`); mergePolicy(policy, override); }
  } catch (error) { fail(400, 'INVALID_INPUT', error.message); }
  return { policy, machines };
}

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const text = (value, max = 4096) => typeof value === 'string' && value.length <= max && !value.includes('\0') ? value : undefined;
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
const pick = (source, keys) => Object.fromEntries(keys.filter(key => text(source?.[key], 200)).map(key => [key, source[key]]));

function disk(value) {
  if (!value || typeof value !== 'object') return undefined;
  const totalBytes = count(value.totalBytes); const freeBytes = count(value.freeBytes);
  return totalBytes ? { totalBytes, freeBytes: Math.min(freeBytes, totalBytes) } : undefined;
}
function byKind(value) {
  const result = {};
  for (const kind of KINDS) if (count(value?.[kind])) result[kind] = count(value[kind]);
  return result;
}
/** A heartbeat summary, keeping only known fields; a malformed one is ignored rather than failing liveness. */
export function sanitizeSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !time(value.scannedAt)) return null;
  return {
    scannedAt: value.scannedAt, state: STATES.includes(value.state) ? value.state : 'ok', ...(disk(value.disk) ? { disk: disk(value.disk) } : {}),
    truncated: value.truncated === true, reclaimableBytes: count(value.reclaimableBytes), reclaimableByKind: byKind(value.reclaimableByKind),
    advisoryBytes: count(value.advisoryBytes), attentionCount: count(value.attentionCount), staleProcesses: count(value.staleProcesses), items: count(value.items),
    top: (Array.isArray(value.top) ? value.top.slice(0, 10) : []).filter(item => ITEM_ID.test(item?.id) && KINDS.includes(item.kind) && text(item.path))
      .map(item => ({ id: item.id, kind: item.kind, path: item.path, bytes: count(item.bytes), reclaimable: item.reclaimable === true, ...(item.attention === true ? { attention: true } : {}) })),
  };
}
function sanitizeItem(item) {
  if (!item || !ITEM_ID.test(item.id) || !KINDS.includes(item.kind) || !text(item.path)) return null;
  const git = item.gitState && typeof item.gitState === 'object' ? { ...(text(item.gitState.branch, 500) ? { branch: item.gitState.branch } : {}), dirty: item.gitState.dirty === true,
    unpushedCommits: count(item.gitState.unpushedCommits), ...(typeof item.gitState.merged === 'boolean' ? { merged: item.gitState.merged } : {}) } : undefined;
  return {
    id: item.id, kind: item.kind, path: item.path, bytes: count(item.bytes), ...(item.approximate === true ? { approximate: true } : {}),
    lastModifiedAt: time(item.lastModifiedAt) ?? null, owner: pick(item.owner, ['runId', 'assignmentId', 'jobId', 'threadId', 'workItemId']),
    ...(git ? { gitState: git } : {}), reclaimable: item.reclaimable === true, ...(['delete', 'strip'].includes(item.action) ? { action: item.action } : {}),
    reason: text(item.reason, 500) ?? '', ...(item.attention === true ? { attention: true } : {}), ...(item.advisory === true ? { advisory: true } : {}),
    ...(ITEM_ID.test(item.parentId ?? '') ? { parentId: item.parentId } : {}), ...(text(item.hint, 300) ? { hint: item.hint } : {}),
    ...(text(item.name, 200) ? { name: item.name } : {}), ...(text(item.repo, 200) ? { repo: item.repo } : {}),
    ...(['perpeto', 'foreign', 'system'].includes(item.ownedBy) ? { ownedBy: item.ownedBy } : {}),
  };
}
function sanitizeProcess(value) {
  if (!value || !['dev-server', 'simulator'].includes(value.kind)) return null;
  return { kind: value.kind, name: text(value.name, 120) ?? value.kind, ...(Number.isSafeInteger(value.pid) ? { pid: value.pid } : {}), ...(text(value.udid, 100) ? { udid: value.udid } : {}),
    ...(Number.isSafeInteger(value.elapsedSec) ? { elapsedSec: value.elapsedSec } : {}), ...(text(value.cwd) ? { cwd: value.cwd } : {}), ...(value.cwdMissing === true ? { cwdMissing: true } : {}),
    reason: text(value.reason, 300) ?? '', ...(text(value.hint, 300) ? { hint: value.hint } : {}) };
}
const STATUSES = ['deleted', 'stripped', 'would-delete', 'would-strip', 'skipped', 'needs-attention', 'failed'];
function sanitizeResult(value) {
  const actions = (Array.isArray(value?.actions) ? value.actions.slice(0, MAX_ITEMS) : []).filter(action => typeof action?.itemId === 'string' && STATUSES.includes(action.status))
    .map(action => ({ itemId: action.itemId.slice(0, 100), ...(KINDS.includes(action.kind) ? { kind: action.kind } : {}), ...(text(action.path) ? { path: action.path } : {}),
      ...(['delete', 'strip'].includes(action.action) ? { action: action.action } : {}), bytes: count(action.bytes), status: action.status, ...(text(action.reason, 500) ? { reason: action.reason } : {}) }));
  return { dryRun: value?.dryRun === true, ...(time(value?.startedAt) ? { startedAt: value.startedAt } : {}), ...(time(value?.finishedAt) ? { finishedAt: value.finishedAt } : {}),
    freedBytes: count(value?.freedBytes), actions };
}
const tally = actions => Object.fromEntries(STATUSES.map(status => [status, actions.filter(action => action.status === status).length]).filter(([, n]) => n));

export class Storage {
  constructor(hub) { this.hub = hub; this.branches = { at: -Infinity, list: [] }; }
  get config() { return this.hub.config.storage ?? STORAGE_CONFIG_DEFAULTS; }
  get store() { return this.hub.store; }
  /** Hub policy plus the machine's override (by id, then name). The node applies its own config on top. */
  policyFor(machine) {
    const override = this.config.machines[machine.id] ?? this.config.machines[machine.name] ?? {};
    return { ...this.config.policy, ...override, ...(this.config.policy.aggressive || override.aggressive ? { aggressive: { ...this.config.policy.aggressive, ...override.aggressive } } : {}) };
  }
  effectivePolicy(machine) { return mergePolicy(machine ? this.policyFor(machine) : this.config.policy); }
  record(machineId) { return this.store.get('machine-storage', machineId) ?? { id: machineId }; }
  /** Branches of unfinished work items: their worktrees are never deleted. Cached briefly; leases are hotter than this. */
  activeBranches() {
    if (this.hub.clock() - this.branches.at < BRANCHES_TTL_MS) return this.branches.list;
    const list = this.store.byStatus('work-item', ['queued', 'active', 'blocked'], item => typeof item.branch === 'string' && item.branch)
      .slice(0, 5000).map(item => ({ branch: item.branch, ...(item.runId ? { runId: item.runId } : {}), workItemId: item.id }));
    this.branches = { at: this.hub.clock(), list };
    return list;
  }
  view(machine, summary) {
    if (!summary) return undefined;
    const freePercent = summary.disk ? Math.round((summary.disk.freeBytes / summary.disk.totalBytes) * 1000) / 10 : undefined;
    return { state: summary.state, ...(summary.disk ? { totalBytes: summary.disk.totalBytes, freeBytes: summary.disk.freeBytes, freePercent } : {}),
      reclaimableBytes: summary.reclaimableBytes, attentionCount: summary.attentionCount, scannedAt: summary.scannedAt };
  }
  /** Move to a new disk state; worsening raises `storage.low`. */
  transition(machine, record, state, summary) {
    const previous = record.state ?? 'ok';
    record.state = state;
    if (STATES.indexOf(state) > STATES.indexOf(previous)) {
      this.hub.emit('storage.low', 'machine', machine, { machineId: machine.id, state, previous, ...(summary?.disk ? { freeBytes: summary.disk.freeBytes, totalBytes: summary.disk.totalBytes } : {}),
        severity: state === 'critical' ? 'critical' : 'warning' });
    }
  }
  /**
   * From the heartbeat handler: record the summary on the machine (`machine.storage`) and return the directive for the
   * response. Nodes without a janitor send no `storage` and get nothing back.
   */
  heartbeat(machine, value) {
    if (value === undefined) return undefined;
    const record = this.record(machine.id);
    const summary = sanitizeSummary(value);
    if (summary) {
      record.summary = summary; record.summaryAt = this.hub.now();
      this.transition(machine, record, summary.state, summary);
      machine.storage = this.view(machine, summary);
    }
    const cleanups = this.store.list('storage-cleanup', item => item.machineId === machine.id && ['pending', 'running'].includes(item.status));
    for (const cleanup of cleanups) if (cleanup.status === 'pending') { cleanup.status = 'running'; cleanup.deliveredAt = this.hub.now(); this.store.put('storage-cleanup', cleanup); }
    this.store.put('machine-storage', record);
    const scan = record.scanRequestedAt && (!record.inventoryAt || record.inventoryAt < record.scanRequestedAt);
    return { policy: this.policyFor(machine), activeBranches: this.activeBranches(), ...(scan ? { scan: true } : {}),
      ...(cleanups.length ? { cleanups: cleanups.map(item => ({ id: item.id, mode: item.mode, ...(item.itemIds ? { itemIds: item.itemIds } : {}) })) } : {}) };
  }
  /** `POST /nodes/storage`: the machine's inventory and any cleanup results. */
  ingest(machine, body) {
    object(body);
    const record = this.record(machine.id);
    let items = 0;
    if (body.inventory !== undefined) {
      const inventory = object(body.inventory, 'inventory');
      requireValue(Array.isArray(inventory.items) && inventory.items.length <= MAX_ITEMS, 'inventory.items must be an array of at most 2000 items.');
      const clean = inventory.items.map(sanitizeItem).filter(Boolean);
      this.annotate(clean);
      const stored = {
        scannedAt: time(inventory.scannedAt) ?? this.hub.now(), durationMs: count(inventory.durationMs), truncated: inventory.truncated === true,
        ...(disk(inventory.disk) ? { disk: disk(inventory.disk) } : {}), state: STATES.includes(inventory.state) ? inventory.state : 'ok', aggressive: inventory.aggressive === true,
        ...(inventory.retention && typeof inventory.retention === 'object' ? { retention: {
          finishedWorkspaceTtlHours: Number(inventory.retention.finishedWorkspaceTtlHours) || 0, idleArtifactTtlHours: Number(inventory.retention.idleArtifactTtlHours) || 0,
          cleanupForeignWorktrees: inventory.retention.cleanupForeignWorktrees === true, autoClean: inventory.retention.autoClean === true } } : {}),
        items: clean, processes: (Array.isArray(inventory.processes) ? inventory.processes.slice(0, 200) : []).map(sanitizeProcess).filter(Boolean),
        ...(count(inventory.itemsOmitted) ? { itemsOmitted: count(inventory.itemsOmitted) } : {}),
      };
      // The inventory is large and changes once a scan; the per-heartbeat record stays small.
      this.store.put('storage-inventory', { id: machine.id, ...stored });
      record.inventoryAt = this.hub.now();
      items = clean.length;
      const summary = sanitizeSummary(body.summary);
      if (summary) { record.summary = summary; record.summaryAt = this.hub.now(); machine.storage = this.view(machine, summary); this.store.put('machine', machine); }
      this.transition(machine, record, stored.state, summary ?? record.summary);
      this.hub.emit('storage.scanned', 'machine', machine, { machineId: machine.id, state: stored.state, items, reclaimableBytes: summary?.reclaimableBytes ?? 0,
        attentionCount: summary?.attentionCount ?? clean.filter(item => item.attention).length, truncated: stored.truncated });
    }
    const accepted = [];
    for (const value of Array.isArray(body.cleanups) ? body.cleanups.slice(0, 20) : []) {
      if (typeof value?.id !== 'string' || !/^(?:scl|auto)_[A-Za-z0-9_-]{1,80}$/.test(value.id)) continue;
      const result = sanitizeResult(value);
      let cleanup = this.store.get('storage-cleanup', value.id);
      if (cleanup && cleanup.machineId !== machine.id) continue;
      if (cleanup?.status === 'completed') { accepted.push(cleanup.id); continue; }
      cleanup ??= { id: value.id, machineId: machine.id, mode: value.mode === 'dry-run' ? 'dry-run' : 'execute', source: 'auto', requestedAt: result.startedAt ?? this.hub.now() };
      Object.assign(cleanup, { status: 'completed', completedAt: this.hub.now(), result });
      this.store.put('storage-cleanup', cleanup);
      this.prune(machine.id);
      accepted.push(cleanup.id);
      this.hub.emit('storage.cleaned', 'machine', machine, { machineId: machine.id, cleanupId: cleanup.id, mode: cleanup.mode, source: cleanup.source,
        freedBytes: result.freedBytes, counts: tally(result.actions) });
    }
    this.store.put('machine-storage', record);
    return { accepted: true, items, cleanups: accepted };
  }
  /** Fill in run and work item from what the hub knows: assignment ids from workspace names, branches from work items. */
  annotate(items) {
    const branches = new Map(this.activeBranches().map(entry => [entry.branch, entry]));
    for (const item of items) {
      if (item.owner.assignmentId && !item.owner.runId) {
        const assignment = this.store.find('assignment', item.owner.assignmentId);
        if (assignment?.runId) item.owner.runId = assignment.runId;
        if (assignment?.workItemId) item.owner.workItemId = assignment.workItemId;
      }
      const entry = item.gitState?.branch ? branches.get(item.gitState.branch) : undefined;
      if (entry && !item.owner.workItemId) Object.assign(item.owner, { workItemId: entry.workItemId, ...(entry.runId ? { runId: entry.runId } : {}) });
    }
  }
  prune(machineId) {
    const list = this.store.list('storage-cleanup', item => item.machineId === machineId && item.status === 'completed');
    for (const item of list.slice(0, Math.max(0, list.length - CLEANUPS_KEPT))) this.store.remove('storage-cleanup', item.id);
  }
  cleanups(machineId, limit = 20) {
    return this.store.list('storage-cleanup', item => item.machineId === machineId).reverse().slice(0, limit);
  }
  machineSummary(machine) {
    const record = this.store.get('machine-storage', machine.id);
    const online = machine.status !== 'offline' && this.hub.clock() - Date.parse(machine.lastHeartbeatAt) < this.hub.config.heartbeatIntervalMs * 3;
    const last = this.cleanups(machine.id, 1)[0];
    return { machineId: machine.id, name: machine.name, status: machine.status, online, state: record?.summary?.state ?? 'ok', storage: record?.summary ?? null,
      ...(last ? { lastCleanup: { id: last.id, mode: last.mode, status: last.status, source: last.source, ...(last.result ? { freedBytes: last.result.freedBytes } : {}), at: last.completedAt ?? last.requestedAt } } : {}) };
  }
  /** `GET /storage`: every machine's disk and reclaimable space, fleet totals and low-disk alerts. */
  fleet() {
    const machines = this.store.list('machine', machine => !machine.revokedAt).map(machine => this.machineSummary(machine));
    const totals = { totalBytes: 0, freeBytes: 0, reclaimableBytes: 0, advisoryBytes: 0, attentionCount: 0, reclaimableByKind: {} };
    for (const { storage } of machines) {
      if (!storage) continue;
      totals.totalBytes += storage.disk?.totalBytes ?? 0; totals.freeBytes += storage.disk?.freeBytes ?? 0;
      totals.reclaimableBytes += storage.reclaimableBytes; totals.advisoryBytes += storage.advisoryBytes; totals.attentionCount += storage.attentionCount;
      for (const [kind, bytes] of Object.entries(storage.reclaimableByKind)) totals.reclaimableByKind[kind] = (totals.reclaimableByKind[kind] ?? 0) + bytes;
    }
    const alerts = machines.filter(machine => machine.storage && machine.state !== 'ok').map(machine => {
      const disk = machine.storage.disk;
      const percent = disk ? Math.round((disk.freeBytes / disk.totalBytes) * 1000) / 10 : null;
      return { machineId: machine.machineId, name: machine.name, state: machine.state, severity: machine.state === 'critical' ? 'critical' : 'warning',
        evidence: `${percent ?? '?'}% free${machine.state === 'critical' ? '; new agent work is paused on this machine' : '; aggressive retention is on'}`, freePercent: percent };
    });
    return { machines, totals, alerts, policy: this.effectivePolicy() };
  }
  /** `GET /machines/:id/storage`. */
  machine(machineId) {
    const machine = this.store.need('machine', machineId);
    const record = this.store.get('machine-storage', machine.id);
    const stored = this.store.get('storage-inventory', machine.id);
    const inventory = stored ? (({ id, ...rest }) => rest)(stored) : null;
    return { ...this.machineSummary(machine), policy: this.effectivePolicy(machine), inventory, inventoryAt: record?.inventoryAt ?? null,
      ...(record?.scanRequestedAt ? { scanRequestedAt: record.scanRequestedAt } : {}), cleanups: this.cleanups(machine.id) };
  }
  requestScan(machineId) {
    const machine = this.store.need('machine', machineId);
    if (machine.revokedAt) fail(409, 'MACHINE_REVOKED', 'The machine is revoked.');
    const record = this.record(machine.id);
    record.scanRequestedAt = this.hub.now();
    this.store.put('machine-storage', record);
    return { machineId: machine.id, scanRequestedAt: record.scanRequestedAt };
  }
  /** `POST /machines/:id/storage/cleanup` `{ mode: 'dry-run'|'execute', itemIds? }`; the machine runs it on its next heartbeat. */
  requestCleanup(machineId, body) {
    const machine = this.store.need('machine', machineId);
    if (machine.revokedAt) fail(409, 'MACHINE_REVOKED', 'The machine is revoked.');
    requireValue(Object.keys(body).every(key => ['mode', 'itemIds', 'idempotencyKey'].includes(key)), 'Cleanup accepts mode and itemIds.');
    requireValue(['dry-run', 'execute'].includes(body.mode ?? 'dry-run'), 'mode must be dry-run or execute.');
    if (body.itemIds !== undefined) requireValue(Array.isArray(body.itemIds) && body.itemIds.length > 0 && body.itemIds.length <= MAX_ITEMS && body.itemIds.every(id => ITEM_ID.test(id)), 'itemIds must be storage item ids.');
    const cleanup = { id: `scl_${randomUUID().replaceAll('-', '')}`, machineId: machine.id, mode: body.mode ?? 'dry-run', ...(body.itemIds ? { itemIds: [...new Set(body.itemIds)] } : {}),
      source: 'owner', status: 'pending', requestedAt: this.hub.now() };
    this.store.put('storage-cleanup', cleanup);
    this.hub.emit('storage.cleanup-requested', 'machine', machine, { machineId: machine.id, cleanupId: cleanup.id, mode: cleanup.mode, items: cleanup.itemIds?.length ?? null });
    return cleanup;
  }
}

/** Storage routes; null when the request is not one of them. */
export function storageRoute(hub, method, segments, body, auth) {
  const [collection, entityId, action, childId, grandchild] = segments;
  if (collection === 'nodes' && entityId === 'storage' && segments.length === 2 && method === 'POST') {
    if (auth.kind !== 'node') fail(403, 'FORBIDDEN', 'A machine token is required.');
    return { status: 200, body: hub.storage.ingest(hub.store.need('machine', auth.machineId), body) };
  }
  if (collection === 'storage' && segments.length === 1 && method === 'GET') return { status: 200, body: hub.storage.fleet() };
  if (collection === 'storage' && entityId === 'policy' && segments.length === 2 && method === 'GET') return { status: 200, body: { policy: hub.storage.effectivePolicy(), defaults: POLICY_DEFAULTS, hub: hub.storage.config } };
  if (collection !== 'machines' || !entityId || action !== 'storage') return null;
  if (segments.length === 3 && method === 'GET') return { status: 200, body: hub.storage.machine(entityId) };
  if (segments.length === 4 && childId === 'scan' && method === 'POST') return { status: 202, body: hub.storage.requestScan(entityId) };
  if (segments.length === 4 && childId === 'cleanup' && method === 'POST') return { status: 202, body: { cleanup: hub.storage.requestCleanup(entityId, body) } };
  if (segments.length === 5 && childId === 'cleanups' && method === 'GET') {
    const cleanup = hub.store.get('storage-cleanup', grandchild);
    if (!cleanup || cleanup.machineId !== entityId) fail(404, 'NOT_FOUND', 'Cleanup not found.');
    return { status: 200, body: { cleanup } };
  }
  return null;
}
