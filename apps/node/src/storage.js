import { readFileSync, realpathSync } from 'node:fs';
import { statfs as nodeStatfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createJanitor, mergePolicy, validatePolicy, summarize, planCleanup, POLICY_KEYS, workspaceName } from '@perpeto/janitor';
import { readSecret, writePrivate } from './config.js';
import { sleep } from './hub.js';
import { activeJobWorkspaces } from './job.js';

export { workspaceName };
/** Node-only storage settings beside the policy keys. */
const NODE_KEYS = ['ciTempDir', 'ciCacheDir', 'initialScanDelayMs'];
const MAX_REPORTED_ITEMS = 400;
const MAX_ACTIVE_BRANCHES = 5000;
const MAX_REMEMBERED_CLEANUPS = 100;
const MAX_SEEN_LEASES = 2000;

/** Validate a node's `storage` section: policy fields (see @perpeto/janitor) plus `ciTempDir` and `initialScanDelayMs`. */
export function storageConfig(value, root) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid storage configuration.');
  const policy = Object.fromEntries(Object.entries(value).filter(([key]) => !NODE_KEYS.includes(key)));
  try { validatePolicy(policy, 'storage'); mergePolicy(policy); } catch (error) { throw new Error(error.message); }
  if (value.ciTempDir !== undefined && (typeof value.ciTempDir !== 'string' || !value.ciTempDir.trim() || value.ciTempDir.includes('\0'))) throw new Error('Invalid storage.ciTempDir.');
  if (value.ciCacheDir !== undefined && (typeof value.ciCacheDir !== 'string' || !value.ciCacheDir.trim() || value.ciCacheDir.includes('\0'))) throw new Error('Invalid storage.ciCacheDir.');
  if (value.initialScanDelayMs !== undefined && (!Number.isSafeInteger(value.initialScanDelayMs) || value.initialScanDelayMs < 0 || value.initialScanDelayMs > 3_600_000)) throw new Error('Invalid storage.initialScanDelayMs.');
  return { policy, ciTempDir: value.ciTempDir !== undefined ? resolve(root, value.ciTempDir) : undefined, ciCacheDir: value.ciCacheDir !== undefined ? resolve(root, value.ciCacheDir) : undefined, initialScanDelayMs: value.initialScanDelayMs ?? 60_000 };
}

/**
 * The lease journal maps every lease ever seen to its attempt and was rewritten in full forever. Leases older than the
 * last few thousand can no longer be re-offered (their lease windows are long gone), so the oldest entries are dropped.
 */
export function pruneSeen(seen, max = MAX_SEEN_LEASES) {
  const keys = Object.keys(seen);
  for (const key of keys.slice(0, Math.max(0, keys.length - max))) delete seen[key];
  return seen;
}

/** Where the managed T3 runtime keeps its worktrees: `<baseDir>/worktrees`, Perpeto-owned. */
function runtimeWorktrees(config) {
  const runtime = config.runtime ?? {};
  const baseDir = runtime.t3?.baseDir ?? runtime.baseDir;
  if (baseDir) return [resolve(config.configRoot, baseDir, 'worktrees')];
  if (!runtime.repoRoot) return [];
  const repoRoot = resolve(config.configRoot, runtime.repoRoot);
  try {
    const settings = JSON.parse(readFileSync(resolve(repoRoot, 'config/perpeto.json'), 'utf8')).runtime;
    return settings?.dataDirectory ? [resolve(repoRoot, settings.dataDirectory, 'worktrees')] : [];
  } catch { return []; }
}

/**
 * The node's storage janitor: periodic scans, a compact summary for heartbeats, the full inventory on request, policy-safe
 * automatic cleanup, and owner-requested cleanups (dry-run or execute) the hub relays in heartbeat responses.
 * @param {{config: object, hub: object, signal: AbortSignal, active: () => {workspaces: object[], branches: object[]}, janitor?: object, statfs?: Function, log?: (event: object) => void}} options
 * `janitor` and `statfs` are injectable so tests use temporary folders and a fake disk.
 */
export function createStorage({ config, hub, signal, active, janitor = createJanitor(), statfs = nodeStatfs, log = () => {} }) {
  const settings = config.storage;
  const local = settings?.policy ?? {};
  let hubPolicy = {};
  let policy = mergePolicy(local);
  let activeBranches = [];
  let report; let locations = new Map(); let summary;
  let scanning; let loopTask; let queue = Promise.resolve();
  let wake = () => {};
  let pendingCleanupResults = [];
  const done = new Map();
  const cleanupsFile = resolve(config.dataDir, 'storage-cleanups.json');
  const journal = janitor.journal(resolve(config.dataDir, 'storage-journal.jsonl'));
  const roots = () => ({
    // CI runner cache root: `storage.ciCacheDir`, else the runner's own dependency cache (`runner.cacheDir`).
    dataDir: config.dataDir, assignments: resolve(config.dataDir, 'assignments'), ciTemp: settings.ciTempDir ?? tmpdir(), ...(settings.ciCacheDir ?? config.runner?.cacheDir ? { ciCache: settings.ciCacheDir ?? config.runner.cacheDir } : {}),
    perpetoWorktrees: [...runtimeWorktrees(config), ...policy.perpetoWorktreeRoots], foreignWorktrees: policy.foreignWorktreeRoots, diskPath: config.dataDir,
  });
  const allowedRoots = () => { const value = roots(); return [value.assignments, value.ciTemp, ...(value.ciCache ? [value.ciCache] : []), ...value.perpetoWorktrees, ...(policy.cleanupForeignWorktrees || policy.stripForeignArtifacts ? value.foreignWorktrees : [])]; };
  const activeWork = () => {
    const current = active();
    return { workspaces: current.workspaces, branches: [...current.branches, ...activeBranches], ciWorkspaces: [...activeJobWorkspaces].map(path => ({ path })) };
  };
  const real = path => { try { return realpathSync(path); } catch { return path; } };
  const isActive = path => [...active().workspaces.map(entry => entry.path), ...activeJobWorkspaces].some(candidate => real(candidate) === path);

  async function scan() {
    scanning ??= (async () => {
      const result = await janitor.scan({ roots: roots(), policy, active: activeWork() });
      report = result.report; locations = result.locations; summary = summarize(report);
      return report;
    })().finally(() => { scanning = undefined; });
    return scanning;
  }
  /** The inventory as sent to the hub: the largest items, every item needing attention, and processes. */
  function outgoing() {
    const keep = [...report.items].sort((a, b) => b.bytes - a.bytes);
    const kept = new Set(keep.slice(0, MAX_REPORTED_ITEMS).map(item => item.id));
    for (const item of report.items) if (item.attention) kept.add(item.id);
    return { ...report, items: report.items.filter(item => kept.has(item.id)), ...(kept.size < report.items.length ? { itemsOmitted: report.items.length - kept.size } : {}) };
  }
  async function send(cleanups = []) {
    const body = { inventory: outgoing(), summary, ...(cleanups.length ? { cleanups } : {}) };
    try { await hub.retry('/nodes/storage', body, { signal }); pendingCleanupResults = []; }
    catch (error) {
      if (signal.aborted) return;
      // Results are re-sent with the next report; an older hub without the route simply never receives them.
      pendingCleanupResults = cleanups;
      log({ event: 'storage.report-failed', status: error?.status, code: error?.code });
    }
  }
  async function remember(id, result) {
    done.set(id, result);
    for (const key of [...done.keys()].slice(0, Math.max(0, done.size - MAX_REMEMBERED_CLEANUPS))) done.delete(key);
    await writePrivate(cleanupsFile, Object.fromEntries(done)).catch(() => {});
  }
  async function cleanup({ id, mode, itemIds, source }) {
    await scan();
    const plan = planCleanup(report, itemIds ? { itemIds } : {});
    const result = await janitor.execute({ plan, locations, allowedRoots: allowedRoots(), policy, journal, dryRun: mode === 'dry-run', cleanupId: id, isActive });
    if (mode !== 'dry-run' && result.actions.some(action => ['deleted', 'stripped'].includes(action.status))) await scan();
    return { id, mode, ...(source ? { source } : {}), ...result };
  }
  /** One scan cycle: inventory, automatic cleanup of policy-safe items, report. */
  async function cycle() {
    await scan();
    const results = [...pendingCleanupResults];
    if (policy.autoClean && report.items.some(item => item.reclaimable)) {
      const result = await cleanup({ id: `auto_${Date.now().toString(36)}`, mode: 'execute', source: 'auto' });
      if (result.actions.some(action => action.status !== 'skipped')) results.push(result);
    }
    await send(results);
  }
  function enqueue(task) {
    const next = queue.then(task);
    queue = next.catch(error => { if (!signal.aborted) log({ event: 'storage.failed', message: String(error?.message ?? error).slice(0, 200) }); });
    return next;
  }
  async function loop() {
    let wait = settings.initialScanDelayMs;
    while (!signal.aborted) {
      await new Promise(resolve => { const timer = setTimeout(resolve, wait); wake = () => { clearTimeout(timer); resolve(); }; signal.addEventListener('abort', wake, { once: true }); });
      if (signal.aborted) return;
      await enqueue(cycle).catch(() => {});
      wait = policy.scanIntervalMs;
    }
  }

  return {
    get enabled() { return Boolean(settings) && policy.enabled; },
    get policy() { return policy; },
    get report() { return report; },
    async start() {
      if (!settings) return;
      try {
        const saved = JSON.parse(await readSecret(cleanupsFile));
        if (saved && typeof saved === 'object' && !Array.isArray(saved)) for (const [key, value] of Object.entries(saved)) done.set(key, value);
      } catch { /* No earlier cleanups. */ }
      if (policy.enabled) loopTask = loop();
    },
    async stop() { wake(); await loopTask; await queue.catch(() => {}); },
    /** New agent work stops while the disk is critically full; running work and CI continue. */
    blocksAgents() { return this.enabled && summary?.state === 'critical'; },
    /** The heartbeat's storage summary, with fresh disk numbers. */
    async heartbeat() {
      if (!this.enabled) return undefined;
      // Before the first scan: announce the janitor so the hub sends its policy and active branches.
      if (!summary) return { pending: true };
      try {
        const stats = await statfs(config.dataDir);
        const disk = { totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize };
        const percent = disk.totalBytes ? (disk.freeBytes / disk.totalBytes) * 100 : 100;
        summary = { ...summary, disk, state: percent < policy.criticalFreePercent ? 'critical' : percent < policy.lowFreePercent ? 'low' : 'ok' };
      } catch { /* Keep the scan's numbers. */ }
      return summary;
    },
    /** The hub's part of a heartbeat response: its policy, active work branches, a scan request and cleanups to run. */
    directive(value) {
      if (!settings || !value || typeof value !== 'object') return;
      if (value.policy && typeof value.policy === 'object') {
        const key = JSON.stringify(value.policy);
        if (key !== JSON.stringify(hubPolicy)) {
          try { policy = mergePolicy(value.policy, local); hubPolicy = value.policy; }
          catch { log({ event: 'storage.policy-refused' }); }
        }
      }
      if (Array.isArray(value.activeBranches)) {
        activeBranches = value.activeBranches.slice(0, MAX_ACTIVE_BRANCHES).filter(entry => typeof entry?.branch === 'string')
          .map(entry => ({ branch: entry.branch, ...(typeof entry.runId === 'string' ? { runId: entry.runId } : {}), ...(typeof entry.workItemId === 'string' ? { workItemId: entry.workItemId } : {}) }));
      }
      if (!policy.enabled) return;
      if (value.scan === true && !scanning) void enqueue(async () => { await scan(); await send(pendingCleanupResults); });
      for (const request of Array.isArray(value.cleanups) ? value.cleanups.slice(0, 20) : []) {
        if (typeof request?.id !== 'string' || !['dry-run', 'execute'].includes(request.mode)) continue;
        if (request.itemIds !== undefined && (!Array.isArray(request.itemIds) || request.itemIds.some(id => typeof id !== 'string'))) continue;
        const previous = done.get(request.id);
        if (previous) {
          // Already ran (or running): report the same result again, at most once a minute, instead of running it twice.
          if (!previous.pending && Date.now() - (previous.resentAt ?? 0) > 60_000) { previous.resentAt = Date.now(); void enqueue(() => send([previous])); }
          continue;
        }
        done.set(request.id, { id: request.id, pending: true });
        void enqueue(async () => {
          const result = await cleanup(request);
          await remember(request.id, result);
          await send([result]);
        });
      }
    },
    scanNow() { return enqueue(async () => { await scan(); await send(pendingCleanupResults); return report; }); },
    cycleNow() { return enqueue(cycle); },
  };
}
