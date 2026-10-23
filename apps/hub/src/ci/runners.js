import { integer, object, requireValue, strings } from '../errors.js';

const DAY_MS = 86400000;
const POOL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Runner pools. A machine's CI capacity (`capacity.maxJobs`) is split into named pools with their own concurrency,
 * advertised in heartbeats as `runner: { pools, labels, cache }`, separately from agent slots. A machine without a
 * runner section has one `default` pool of `maxJobs`. Jobs choose a pool and runner labels through `runsOn`; jobs
 * without a pool take a slot in any pool. Leasing interleaves projects so one project's burst cannot starve another.
 */
export function runnerInfo(value) {
  object(value, 'runner');
  requireValue(Object.keys(value).every(key => ['pools', 'labels', 'cache'].includes(key)), 'Unknown runner field.');
  const result = { pools: [], labels: [] };
  if (value.pools !== undefined) {
    requireValue(Array.isArray(value.pools) && value.pools.length <= 16, 'runner.pools must be an array of at most 16 pools.');
    for (const pool of value.pools) {
      object(pool, 'runner pool');
      requireValue(typeof pool.name === 'string' && POOL.test(pool.name), 'Runner pool names are letters, digits, ".", "_" or "-".');
      result.pools.push({ name: pool.name, maxJobs: integer(pool.maxJobs, 'runner pool maxJobs', 0, 100000) });
    }
    requireValue(new Set(result.pools.map(pool => pool.name)).size === result.pools.length, 'Runner pool names must be distinct.');
  }
  if (value.labels !== undefined) { strings(value.labels, 'runner.labels'); requireValue(value.labels.length <= 64, 'At most 64 runner labels.'); result.labels = [...value.labels]; }
  if (value.cache !== undefined && value.cache !== null) {
    object(value.cache, 'runner.cache');
    result.cache = { sizeBytes: integer(value.cache.sizeBytes, 'runner.cache.sizeBytes'), maxBytes: integer(value.cache.maxBytes, 'runner.cache.maxBytes'),
      entries: integer(value.cache.entries ?? 0, 'runner.cache.entries') };
  }
  return result;
}

export function poolsOf(machine) {
  return machine.runner?.pools?.length ? machine.runner.pools : [{ name: 'default', maxJobs: machine.capacity?.maxJobs ?? 0 }];
}
const runnerLabels = machine => new Set([...(machine.labels ?? []), ...(machine.runner?.labels ?? [])]);
export const modeOf = machine => {
  const agents = machine.capacity?.maxAgents > 0; const jobs = machine.capacity?.maxJobs > 0;
  return agents && jobs ? 'both' : jobs ? 'ci' : agents ? 'agents' : 'observe';
};

export class Runners {
  constructor(hub) { this.hub = hub; }
  /** Whether a machine could ever run a job, ignoring free slots. */
  fits(machine, job) {
    const pool = job.runsOn?.pool;
    if (pool && !poolsOf(machine).some(item => item.name === pool && item.maxJobs > 0)) return false;
    const labels = runnerLabels(machine);
    return (job.runsOn?.labels ?? []).every(label => labels.has(label));
  }
  /** Free slots per pool on a machine, from the leases the hub holds. `take(job)` claims one if the job fits. */
  slots(machine) {
    const pools = poolsOf(machine);
    const free = new Map(pools.map(pool => [pool.name, pool.maxJobs]));
    const held = this.hub.store.held('job', machine.id).filter(job => Date.parse(job.leaseExpiresAt) > this.hub.clock());
    // Held jobs with a pool count against it; the rest fill whichever pool has room, in order.
    for (const job of held.filter(item => item.pool)) free.set(job.pool, (free.get(job.pool) ?? 0) - 1);
    for (const job of held.filter(item => !item.pool)) { const pool = pools.find(item => free.get(item.name) > 0); if (pool) free.set(pool.name, free.get(pool.name) - 1); }
    return {
      take: job => {
        if (!this.fits(machine, job)) return false;
        const name = job.runsOn?.pool ?? pools.find(item => free.get(item.name) > 0)?.name;
        if (!name || !(free.get(name) > 0)) return false;
        free.set(name, free.get(name) - 1); job.pool = name;
        return true;
      },
    };
  }
  /**
   * Queued jobs in lease order: projects take turns (fewest jobs running first), and within a project oldest first.
   * Returned as one page shaped like HubStore.queuedPage.
   */
  queued(limit = 2000) {
    const rows = [];
    for (let after = 0, page; rows.length < limit && (page = this.hub.store.queuedPage('job', after, 500)).length;) {
      rows.push(...page); after = page.at(-1).rowid;
      if (page.length < 500) break;
    }
    const running = new Map(this.hub.store.db.prepare(`SELECT json_extract(data,'$.projectId') AS project, COUNT(*) AS count FROM entities
      WHERE kind='job' AND json_extract(data,'$.status') IN ('leased','running') AND json_extract(data,'$.machineId') IS NOT NULL GROUP BY project`).all().map(row => [row.project, row.count]));
    const byProject = new Map();
    for (const row of rows) { const key = row.value.projectId ?? ''; if (!byProject.has(key)) byProject.set(key, []); byProject.get(key).push(row); }
    const projects = [...byProject.keys()].sort((a, b) => (running.get(a) ?? 0) - (running.get(b) ?? 0) || byProject.get(a)[0].rowid - byProject.get(b)[0].rowid);
    const ordered = [];
    for (let round = 0; ordered.length < rows.length; round++) for (const project of projects) { const row = byProject.get(project)[round]; if (row) ordered.push(row); }
    return ordered;
  }
  /** Fleet view for GET /runners: per machine pools, busy slots, cache and 24-hour utilisation, and per pool totals. */
  view() {
    const { store } = this.hub; const time = this.hub.clock(); const from = time - DAY_MS;
    const machines = store.list('machine', machine => !machine.revokedAt);
    const busy = new Map();
    for (const job of store.byStatus('job', ['leased', 'running'], value => Boolean(value.machineId))) {
      const entry = busy.get(job.machineId) ?? { total: 0, pools: new Map() };
      entry.total++; if (job.pool) entry.pools.set(job.pool, (entry.pools.get(job.pool) ?? 0) + 1);
      busy.set(job.machineId, entry);
    }
    const used = this.usedMs(from, time);
    const agents = new Map(store.db.prepare(`SELECT json_extract(data,'$.machineId') AS machine, COUNT(*) AS count FROM entities WHERE kind='assignment'
      AND json_extract(data,'$.status') IN ('leased','running') GROUP BY machine`).all().map(row => [row.machine, row.count]));
    const runners = machines.map(machine => {
      const load = busy.get(machine.id) ?? { total: 0, pools: new Map() };
      const pools = poolsOf(machine).map(pool => ({ name: pool.name, maxJobs: pool.maxJobs, busy: load.pools.get(pool.name) ?? 0 }));
      // Jobs without a recorded pool (leased before pools existed) fill pools in order for display.
      let unassigned = load.total - pools.reduce((sum, pool) => sum + pool.busy, 0);
      for (const pool of pools) { const add = Math.max(0, Math.min(unassigned, pool.maxJobs - pool.busy)); pool.busy += add; unassigned -= add; }
      const maxJobs = machine.capacity?.maxJobs ?? 0;
      const online = machine.status !== 'offline' && time - Date.parse(machine.lastHeartbeatAt) < this.hub.config.heartbeatIntervalMs * 3;
      return { machineId: machine.id, name: machine.name, os: machine.os, arch: machine.arch, status: online ? machine.status : 'offline',
        labels: [...runnerLabels(machine)], pools, maxJobs, busy: load.total, maxAgents: machine.capacity?.maxAgents ?? 0, agents: agents.get(machine.id) ?? 0,
        mode: modeOf(machine), cache: machine.runner?.cache ?? null, utilisation: maxJobs ? Math.min(1, (used.get(machine.id) ?? 0) / (DAY_MS * maxJobs)) : 0 };
    });
    const queued = new Map();
    for (const { value } of this.queued(5000)) { const key = value.runsOn?.pool ?? '*'; queued.set(key, (queued.get(key) ?? 0) + 1); }
    const pools = new Map();
    for (const runner of runners) for (const pool of runner.pools) {
      const entry = pools.get(pool.name) ?? { name: pool.name, machines: 0, slots: 0, busy: 0, queued: queued.get(pool.name) ?? 0 };
      entry.machines++; if (runner.status !== 'offline') entry.slots += pool.maxJobs; entry.busy += pool.busy; pools.set(pool.name, entry);
    }
    for (const [name, count] of queued) if (name !== '*' && !pools.has(name)) pools.set(name, { name, machines: 0, slots: 0, busy: 0, queued: count });
    return { runners, pools: [...pools.values()], unpooledQueued: queued.get('*') ?? 0 };
  }
  /** Job-milliseconds each machine spent running CI between `from` and `to`, from job start and finish times. */
  usedMs(from, to) {
    const used = new Map();
    const rows = this.hub.store.db.prepare(`SELECT data FROM entities WHERE kind='job' AND (json_extract(data,'$.finishedAt')>=? OR json_extract(data,'$.status') IN ('leased','running'))`)
      .all(new Date(from).toISOString());
    for (const { data } of rows) {
      const job = JSON.parse(data);
      if (!job.machineId || !job.startedAt) continue;
      const start = Math.max(from, Date.parse(job.startedAt)); const end = Math.min(to, job.finishedAt ? Date.parse(job.finishedAt) : to);
      if (end > start) used.set(job.machineId, (used.get(job.machineId) ?? 0) + end - start);
    }
    return used;
  }
}


