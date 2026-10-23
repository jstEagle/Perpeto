/*
 * Storage janitor: types and tolerant decoding for `GET /storage`,
 * `GET /machines/:id/storage` and storage cleanups. The contract is new:
 * optional fields stay optional, malformed entries are dropped instead of
 * failing the screen, and unknown enum values decode to a neutral member.
 */

export type StorageState = 'ok' | 'low' | 'critical';
export type StorageKind = 'perpeto-workspace' | 'ci-workspace' | 'ci-cache' | 'perpeto-worktree' | 't3-worktree' | 'build-artifact' | 'global-cache';
export const STORAGE_KINDS: readonly StorageKind[] = ['perpeto-worktree', 'perpeto-workspace', 'ci-workspace', 'ci-cache', 'build-artifact', 't3-worktree', 'global-cache'];
export type CleanupMode = 'dry-run' | 'execute';
export type CleanupStatus = 'pending' | 'running' | 'completed';
export type CleanupActionStatus = 'deleted' | 'stripped' | 'would-delete' | 'would-strip' | 'skipped' | 'needs-attention' | 'failed';

export interface Disk {
  totalBytes: number;
  freeBytes: number;
}

export interface StorageTopItem {
  id: string;
  kind: StorageKind;
  path: string;
  bytes: number;
  reclaimable: boolean;
  attention?: boolean;
}

export interface StorageSummary {
  scannedAt: string;
  state: StorageState;
  disk?: Disk;
  truncated: boolean;
  reclaimableBytes: number;
  reclaimableByKind: Partial<Record<StorageKind, number>>;
  advisoryBytes: number;
  attentionCount: number;
  staleProcesses: number;
  items: number;
  top: StorageTopItem[];
}

export interface CleanupBrief {
  id: string;
  mode: CleanupMode;
  status: CleanupStatus;
  source: 'owner' | 'auto';
  freedBytes?: number;
  at?: string;
}

export interface MachineStorageSummary {
  machineId: string;
  name: string;
  status: string;
  online: boolean;
  state: StorageState;
  storage: StorageSummary | null;
  lastCleanup?: CleanupBrief;
}

export interface StorageAlert {
  machineId: string;
  name: string;
  state: StorageState;
  severity: 'warning' | 'critical';
  evidence: string;
  freePercent: number | null;
}

export interface StorageTotals {
  totalBytes: number;
  freeBytes: number;
  reclaimableBytes: number;
  advisoryBytes: number;
  attentionCount: number;
  reclaimableByKind: Partial<Record<StorageKind, number>>;
}

export interface StoragePolicy {
  finishedWorkspaceTtlHours?: number;
  idleArtifactTtlHours?: number;
  cleanupForeignWorktrees?: boolean;
  autoClean?: boolean;
  lowFreePercent?: number;
  criticalFreePercent?: number;
}

export interface FleetStorage {
  machines: MachineStorageSummary[];
  totals: StorageTotals;
  alerts: StorageAlert[];
  policy: StoragePolicy;
}

export interface GitState {
  branch?: string;
  dirty: boolean;
  unpushedCommits: number;
  merged?: boolean;
}

export interface StorageItem {
  id: string;
  kind: StorageKind;
  path: string;
  bytes: number;
  approximate?: boolean;
  lastModifiedAt?: string;
  owner: { runId?: string; assignmentId?: string; jobId?: string; threadId?: string; workItemId?: string };
  gitState?: GitState;
  reclaimable: boolean;
  action?: 'delete' | 'strip';
  reason: string;
  attention?: boolean;
  advisory?: boolean;
  parentId?: string;
  hint?: string;
  name?: string;
  repo?: string;
  ownedBy?: 'perpeto' | 'foreign' | 'system';
}

export interface StaleProcess {
  kind: 'dev-server' | 'simulator';
  name: string;
  pid?: number;
  udid?: string;
  elapsedSec?: number;
  cwd?: string;
  cwdMissing?: boolean;
  reason: string;
  hint?: string;
}

export interface StorageInventory {
  scannedAt: string;
  durationMs: number;
  truncated: boolean;
  disk?: Disk;
  state: StorageState;
  aggressive: boolean;
  retention?: { finishedWorkspaceTtlHours: number; idleArtifactTtlHours: number; cleanupForeignWorktrees: boolean; autoClean: boolean };
  items: StorageItem[];
  processes: StaleProcess[];
  itemsOmitted?: number;
}

export interface CleanupAction {
  itemId: string;
  kind?: StorageKind;
  path?: string;
  action?: 'delete' | 'strip';
  bytes: number;
  status: CleanupActionStatus;
  reason?: string;
}

export interface StorageCleanup {
  id: string;
  machineId: string;
  mode: CleanupMode;
  itemIds?: string[];
  source: 'owner' | 'auto';
  status: CleanupStatus;
  requestedAt: string;
  deliveredAt?: string;
  completedAt?: string;
  result?: { dryRun: boolean; freedBytes: number; actions: CleanupAction[] };
}

export interface MachineStorage extends MachineStorageSummary {
  policy: StoragePolicy;
  inventory: StorageInventory | null;
  inventoryAt: string | null;
  scanRequestedAt?: string;
  cleanups: StorageCleanup[];
}

export interface CleanupRequest {
  mode: CleanupMode;
  itemIds?: string[];
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const bytes = (v: unknown): number => Math.max(0, Math.round(num(v) ?? 0));
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const time = (v: unknown): string | undefined => {
  const s = str(v);
  return s && !Number.isNaN(Date.parse(s)) ? s : undefined;
};
function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}
const STATES = ['ok', 'low', 'critical'] as const;
const ACTION_STATUSES = ['deleted', 'stripped', 'would-delete', 'would-strip', 'skipped', 'needs-attention', 'failed'] as const;
const isKind = (v: unknown): v is StorageKind => typeof v === 'string' && (STORAGE_KINDS as readonly string[]).includes(v);
const state = (v: unknown): StorageState => oneOf(v, STATES, 'ok');

function decodeDisk(v: unknown): Disk | undefined {
  const o = obj(v);
  const total = num(o?.totalBytes);
  if (!o || !total || total <= 0) return undefined;
  return { totalBytes: total, freeBytes: Math.min(total, bytes(o.freeBytes)) };
}

function decodeByKind(v: unknown): Partial<Record<StorageKind, number>> {
  const o = obj(v) ?? {};
  const out: Partial<Record<StorageKind, number>> = {};
  for (const [k, value] of Object.entries(o)) if (isKind(k) && bytes(value) > 0) out[k] = bytes(value);
  return out;
}

export function decodeSummary(v: unknown): StorageSummary | null {
  const o = obj(v);
  const scannedAt = time(o?.scannedAt);
  if (!o || !scannedAt) return null;
  const disk = decodeDisk(o.disk);
  return {
    scannedAt,
    state: state(o.state),
    ...(disk ? { disk } : {}),
    truncated: o.truncated === true,
    reclaimableBytes: bytes(o.reclaimableBytes),
    reclaimableByKind: decodeByKind(o.reclaimableByKind),
    advisoryBytes: bytes(o.advisoryBytes),
    attentionCount: bytes(o.attentionCount),
    staleProcesses: bytes(o.staleProcesses),
    items: bytes(o.items),
    top: arr(o.top).flatMap((x) => {
      const t = obj(x);
      const id = str(t?.id);
      const path = str(t?.path);
      if (!t || !id || !path || !isKind(t.kind)) return [];
      return [{ id, kind: t.kind, path, bytes: bytes(t.bytes), reclaimable: t.reclaimable === true, ...(t.attention === true ? { attention: true } : {}) }];
    }),
  };
}

function decodeBrief(v: unknown): CleanupBrief | undefined {
  const o = obj(v);
  const id = str(o?.id);
  if (!o || !id) return undefined;
  return {
    id,
    mode: oneOf(o.mode, ['dry-run', 'execute'] as const, 'dry-run'),
    status: oneOf(o.status, ['pending', 'running', 'completed'] as const, 'pending'),
    source: oneOf(o.source, ['owner', 'auto'] as const, 'owner'),
    ...(num(o.freedBytes) !== undefined ? { freedBytes: bytes(o.freedBytes) } : {}),
    ...(time(o.at) ? { at: time(o.at) } : {}),
  };
}

function decodeMachineSummary(v: unknown): MachineStorageSummary | null {
  const o = obj(v);
  const machineId = str(o?.machineId);
  if (!o || !machineId) return null;
  const storage = decodeSummary(o.storage);
  const last = decodeBrief(o.lastCleanup);
  return {
    machineId,
    name: str(o.name) ?? machineId,
    status: str(o.status) ?? 'offline',
    online: o.online === true,
    state: storage?.state ?? state(o.state),
    storage,
    ...(last ? { lastCleanup: last } : {}),
  };
}

function decodePolicy(v: unknown): StoragePolicy {
  const o = obj(v) ?? {};
  const out: StoragePolicy = {};
  for (const k of ['finishedWorkspaceTtlHours', 'idleArtifactTtlHours', 'lowFreePercent', 'criticalFreePercent'] as const) if (num(o[k]) !== undefined) out[k] = num(o[k]);
  for (const k of ['cleanupForeignWorktrees', 'autoClean'] as const) if (typeof o[k] === 'boolean') out[k] = o[k] as boolean;
  return out;
}

/** `GET /storage`. */
export function decodeFleetStorage(body: unknown): FleetStorage {
  const o = obj(body) ?? {};
  const t = obj(o.totals) ?? {};
  const machines = arr(o.machines)
    .map(decodeMachineSummary)
    .filter((m): m is MachineStorageSummary => m !== null);
  return {
    machines,
    totals: {
      totalBytes: bytes(t.totalBytes),
      freeBytes: bytes(t.freeBytes),
      reclaimableBytes: bytes(t.reclaimableBytes),
      advisoryBytes: bytes(t.advisoryBytes),
      attentionCount: bytes(t.attentionCount),
      reclaimableByKind: decodeByKind(t.reclaimableByKind),
    },
    alerts: arr(o.alerts).flatMap((x) => {
      const a = obj(x);
      const machineId = str(a?.machineId);
      if (!a || !machineId) return [];
      const s = state(a.state);
      return [
        {
          machineId,
          name: str(a.name) ?? machineId,
          state: s,
          severity: a.severity === 'critical' || s === 'critical' ? ('critical' as const) : ('warning' as const),
          evidence: str(a.evidence) ?? '',
          freePercent: num(a.freePercent) ?? null,
        },
      ];
    }),
    policy: decodePolicy(o.policy),
  };
}

function decodeItem(v: unknown): StorageItem | null {
  const o = obj(v);
  const id = str(o?.id);
  const path = str(o?.path);
  if (!o || !id || !path || !isKind(o.kind)) return null;
  const owner = obj(o.owner) ?? {};
  const g = obj(o.gitState);
  return {
    id,
    kind: o.kind,
    path,
    bytes: bytes(o.bytes),
    ...(o.approximate === true ? { approximate: true } : {}),
    ...(time(o.lastModifiedAt) ? { lastModifiedAt: time(o.lastModifiedAt) } : {}),
    owner: Object.fromEntries(['runId', 'assignmentId', 'jobId', 'threadId', 'workItemId'].flatMap((k) => (str(owner[k]) ? [[k, str(owner[k])]] : []))),
    ...(g ? { gitState: { ...(str(g.branch) ? { branch: str(g.branch) } : {}), dirty: g.dirty === true, unpushedCommits: bytes(g.unpushedCommits), ...(typeof g.merged === 'boolean' ? { merged: g.merged } : {}) } } : {}),
    reclaimable: o.reclaimable === true,
    ...(o.action === 'delete' || o.action === 'strip' ? { action: o.action } : {}),
    reason: str(o.reason) ?? '',
    ...(o.attention === true ? { attention: true } : {}),
    ...(o.advisory === true ? { advisory: true } : {}),
    ...(str(o.parentId) ? { parentId: str(o.parentId) } : {}),
    ...(str(o.hint) ? { hint: str(o.hint) } : {}),
    ...(str(o.name) ? { name: str(o.name) } : {}),
    ...(str(o.repo) ? { repo: str(o.repo) } : {}),
    ...(o.ownedBy === 'perpeto' || o.ownedBy === 'foreign' || o.ownedBy === 'system' ? { ownedBy: o.ownedBy } : {}),
  };
}

function decodeProcess(v: unknown): StaleProcess | null {
  const o = obj(v);
  if (!o || (o.kind !== 'dev-server' && o.kind !== 'simulator')) return null;
  return {
    kind: o.kind,
    name: str(o.name) ?? o.kind,
    ...(num(o.pid) !== undefined ? { pid: num(o.pid) } : {}),
    ...(str(o.udid) ? { udid: str(o.udid) } : {}),
    ...(num(o.elapsedSec) !== undefined ? { elapsedSec: num(o.elapsedSec) } : {}),
    ...(str(o.cwd) ? { cwd: str(o.cwd) } : {}),
    ...(o.cwdMissing === true ? { cwdMissing: true } : {}),
    reason: str(o.reason) ?? '',
    ...(str(o.hint) ? { hint: str(o.hint) } : {}),
  };
}

function decodeInventory(v: unknown): StorageInventory | null {
  const o = obj(v);
  const scannedAt = time(o?.scannedAt);
  if (!o || !scannedAt) return null;
  const disk = decodeDisk(o.disk);
  const r = obj(o.retention);
  return {
    scannedAt,
    durationMs: bytes(o.durationMs),
    truncated: o.truncated === true,
    ...(disk ? { disk } : {}),
    state: state(o.state),
    aggressive: o.aggressive === true,
    ...(r
      ? {
          retention: {
            finishedWorkspaceTtlHours: num(r.finishedWorkspaceTtlHours) ?? 0,
            idleArtifactTtlHours: num(r.idleArtifactTtlHours) ?? 0,
            cleanupForeignWorktrees: r.cleanupForeignWorktrees === true,
            autoClean: r.autoClean === true,
          },
        }
      : {}),
    items: arr(o.items)
      .map(decodeItem)
      .filter((x): x is StorageItem => x !== null),
    processes: arr(o.processes)
      .map(decodeProcess)
      .filter((x): x is StaleProcess => x !== null),
    ...(bytes(o.itemsOmitted) ? { itemsOmitted: bytes(o.itemsOmitted) } : {}),
  };
}

/** A cleanup, bare or in its `{ cleanup }` envelope. */
export function decodeCleanup(body: unknown): StorageCleanup | null {
  const root = obj(body) ?? {};
  const o = obj(root.cleanup) ?? root;
  const id = str(o.id);
  if (!id) return null;
  const r = obj(o.result);
  return {
    id,
    machineId: str(o.machineId) ?? '',
    mode: oneOf(o.mode, ['dry-run', 'execute'] as const, 'dry-run'),
    ...(Array.isArray(o.itemIds) ? { itemIds: o.itemIds.filter((x): x is string => typeof x === 'string') } : {}),
    source: oneOf(o.source, ['owner', 'auto'] as const, 'owner'),
    status: oneOf(o.status, ['pending', 'running', 'completed'] as const, 'pending'),
    requestedAt: time(o.requestedAt) ?? new Date(0).toISOString(),
    ...(time(o.deliveredAt) ? { deliveredAt: time(o.deliveredAt) } : {}),
    ...(time(o.completedAt) ? { completedAt: time(o.completedAt) } : {}),
    ...(r
      ? {
          result: {
            dryRun: r.dryRun === true,
            freedBytes: bytes(r.freedBytes),
            actions: arr(r.actions).flatMap((x) => {
              const a = obj(x);
              const itemId = str(a?.itemId);
              if (!a || !itemId) return [];
              return [
                {
                  itemId,
                  ...(isKind(a.kind) ? { kind: a.kind } : {}),
                  ...(str(a.path) ? { path: str(a.path) } : {}),
                  ...(a.action === 'delete' || a.action === 'strip' ? { action: a.action } : {}),
                  bytes: bytes(a.bytes),
                  status: oneOf(a.status, ACTION_STATUSES, 'skipped'),
                  ...(str(a.reason) ? { reason: str(a.reason) } : {}),
                },
              ];
            }),
          },
        }
      : {}),
  };
}

/** `GET /machines/:id/storage`. */
export function decodeMachineStorage(body: unknown): MachineStorage {
  const o = obj(body) ?? {};
  const base = decodeMachineSummary(o) ?? { machineId: '', name: '', status: 'offline', online: false, state: 'ok' as const, storage: null };
  return {
    ...base,
    policy: decodePolicy(o.policy),
    inventory: decodeInventory(o.inventory),
    inventoryAt: time(o.inventoryAt) ?? null,
    ...(time(o.scanRequestedAt) ? { scanRequestedAt: time(o.scanRequestedAt) } : {}),
    cleanups: arr(o.cleanups)
      .map(decodeCleanup)
      .filter((x): x is StorageCleanup => x !== null),
  };
}

/* ---------- Presentation helpers (pure, tested) ---------- */

export const KIND_LABEL: Record<StorageKind, string> = {
  'perpeto-worktree': 'Perpeto worktrees',
  'perpeto-workspace': 'Assignment workspaces',
  'ci-workspace': 'CI workspaces',
  'ci-cache': 'CI caches',
  'build-artifact': 'Build artifacts',
  't3-worktree': 'T3 worktrees',
  'global-cache': 'Global caches',
};

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
/** Decimal units, as Finder and df -H show them: "29 GB", "1.4 TB". */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n < 1000) return `${Math.max(0, Math.round(n))} B`;
  let value = n;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, '')} ${UNITS[unit]}`;
}

export function freePercent(disk: Disk | undefined): number | null {
  return disk && disk.totalBytes > 0 ? (disk.freeBytes / disk.totalBytes) * 100 : null;
}

export const STATE_LABEL: Record<StorageState, string> = { ok: 'Healthy', low: 'Low on space', critical: 'Critically full' };

/** Reclaimable bytes by kind, largest first, kinds with nothing omitted. */
export function kindRows(byKind: Partial<Record<StorageKind, number>>): { kind: StorageKind; label: string; bytes: number }[] {
  return STORAGE_KINDS.flatMap((kind) => (byKind[kind] ? [{ kind, label: KIND_LABEL[kind], bytes: byKind[kind]! }] : [])).sort((a, b) => b.bytes - a.bytes);
}

/** Why an item needs a person, in a few words. */
export function attentionText(item: StorageItem): string {
  const g = item.gitState;
  if (g?.dirty && g.unpushedCommits) return `Uncommitted changes and ${g.unpushedCommits} unpushed commit${g.unpushedCommits === 1 ? '' : 's'}`;
  if (g?.dirty) return 'Uncommitted changes';
  if (g?.unpushedCommits) return `${g.unpushedCommits} unpushed commit${g.unpushedCommits === 1 ? '' : 's'}`;
  return item.reason;
}

/** Counts and bytes a cleanup result reports, for its one-line summary. */
export function cleanupTotals(cleanup: StorageCleanup): { done: number; bytes: number; skipped: number; attention: number; failed: number } {
  const actions = cleanup.result?.actions ?? [];
  const done = actions.filter((a) => ['deleted', 'stripped', 'would-delete', 'would-strip'].includes(a.status));
  return {
    done: done.length,
    bytes: cleanup.result?.freedBytes ?? done.reduce((s, a) => s + a.bytes, 0),
    skipped: actions.filter((a) => a.status === 'skipped').length,
    attention: actions.filter((a) => a.status === 'needs-attention').length,
    failed: actions.filter((a) => a.status === 'failed').length,
  };
}

/** Item ids a dry run found safe to remove: what "Clean up" then executes. */
export function previewedIds(cleanup: StorageCleanup): string[] {
  return (cleanup.result?.actions ?? []).filter((a) => a.status === 'would-delete' || a.status === 'would-strip').map((a) => a.itemId);
}
