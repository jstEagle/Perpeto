import { createHash } from 'node:crypto';
import { fail, integer, object, requireValue, strings } from './errors.js';

/**
 * Health-aware placement. Nodes report machine telemetry with each heartbeat; the hub turns it, the node's configured
 * capacity and the owner's per-machine schedule (cordon, drain, weight, overrides) into an effective capacity and the
 * reasons behind it. Leasing fills machines only to their effective capacity, and while a better machine is polling
 * with a free slot, a fresh item waits for it instead of piling onto the busiest machine.
 */
export const PLACEMENT_DEFAULTS = Object.freeze({
  loadSoftPerCore: 0.8, loadHardPerCore: 1.5, maxProcesses: 2000, minFreeDiskBytes: 10 * 1024 ** 3,
  allowOnBattery: false, healthStaleMs: 120000, spreadMargin: 10, deferMs: 5000,
});
const MAX_GIB = 1024 ** 5;

/** Validated placement settings (hub config `placement`). */
export function placementFields(value) {
  object(value, 'placement');
  requireValue(Object.keys(value).every(key => Object.hasOwn(PLACEMENT_DEFAULTS, key)), 'Unknown placement setting.');
  for (const key of ['loadSoftPerCore', 'loadHardPerCore', 'spreadMargin']) requireValue(typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 1000, `Invalid placement.${key}.`);
  requireValue(value.loadHardPerCore > value.loadSoftPerCore, 'placement.loadHardPerCore must exceed loadSoftPerCore.');
  integer(value.maxProcesses, 'placement.maxProcesses', 1, 10000000);
  integer(value.minFreeDiskBytes, 'placement.minFreeDiskBytes', 0, MAX_GIB);
  integer(value.healthStaleMs, 'placement.healthStaleMs', 1000, 86400000);
  integer(value.deferMs, 'placement.deferMs', 0, 600000);
  requireValue(typeof value.allowOnBattery === 'boolean', 'placement.allowOnBattery must be a boolean.');
  return value;
}

/** The key a repository is known by in machine workspace reports; nodes compute the same. */
export const repoKey = url => createHash('sha256').update(String(url)).digest('hex').slice(0, 32);

const finite = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const pick = (value, allowed) => allowed.includes(value) ? value : undefined;
const clean = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));

/**
 * Heartbeat telemetry, sanitized field by field. Telemetry never fails a heartbeat (liveness and cancellations matter
 * more): anything malformed is dropped.
 */
export function normalizeHealth(input, at) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const health = { reportedAt: at };
  if (Number.isSafeInteger(input.cpus) && input.cpus > 0 && input.cpus <= 4096) health.cpus = input.cpus;
  if (Array.isArray(input.load) && input.load.length === 3 && input.load.every(value => finite(value, 0, 1e6))) health.load = input.load.map(value => Math.round(value * 100) / 100);
  if (input.memory && typeof input.memory === 'object' && finite(input.memory.totalBytes, 1) && finite(input.memory.freeBytes)) {
    health.memory = clean({ totalBytes: input.memory.totalBytes, freeBytes: Math.min(input.memory.freeBytes, input.memory.totalBytes), pressure: pick(input.memory.pressure, ['normal', 'warn', 'critical']) });
  }
  if (Number.isSafeInteger(input.processes) && input.processes >= 0) health.processes = input.processes;
  if (input.power && typeof input.power === 'object' && ['ac', 'battery'].includes(input.power.source)) {
    health.power = clean({ source: input.power.source, percent: finite(input.power.percent, 0, 100) ? Math.round(input.power.percent) : undefined,
      charging: typeof input.power.charging === 'boolean' ? input.power.charging : undefined });
  }
  health.thermal = pick(input.thermal, ['nominal', 'fair', 'serious', 'critical']);
  if (finite(input.uptimeSec)) health.uptimeSec = Math.round(input.uptimeSec);
  if (typeof input.nodeVersion === 'string' && /^v?\d+\.\d+\.\d+[\w.-]{0,40}$/.test(input.nodeVersion)) health.nodeVersion = input.nodeVersion;
  if (input.runtime && typeof input.runtime.reachable === 'boolean') health.runtime = { reachable: input.runtime.reachable };
  if (input.disk && typeof input.disk === 'object' && finite(input.disk.totalBytes, 1) && finite(input.disk.freeBytes)) {
    health.disk = { totalBytes: input.disk.totalBytes, freeBytes: Math.min(input.disk.freeBytes, input.disk.totalBytes) };
  }
  // The storage janitor's verdict on the workspace volume, when a node runs one.
  const storage = pick(input.storage?.state, ['ok', 'low', 'critical']);
  if (storage) health.storage = { state: storage };
  return clean(health);
}

/** Repository keys with a checkout on the machine (warm workspaces). */
export function normalizeWorkspaces(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.repos)) return undefined;
  return { repos: [...new Set(input.repos.filter(value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)))].slice(0, 500) };
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const number = value => value.toLocaleString('en-US');
const gigabytes = bytes => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const SLOT = { assignment: 'agents', job: 'jobs' };

/**
 * One machine's placement view: its configured and effective capacity, the leases the hub holds on it, a status and
 * the reasons it is taking less (or no) work.
 */
export function assess(machine, { config, now, held = { agents: 0, jobs: 0 }, heartbeatMs }) {
  const settings = config.placement ?? PLACEMENT_DEFAULTS;
  const schedule = machine.schedule ?? {};
  const reasons = []; const add = (code, message, effect) => reasons.push({ code, message, effect });
  const offline = Boolean(machine.revokedAt) || machine.status === 'offline' || !(now - Date.parse(machine.lastHeartbeatAt) < heartbeatMs * 3);
  const configured = {
    agents: Math.min(machine.capacity?.maxAgents ?? 0, schedule.maxAgents ?? Infinity),
    jobs: Math.min(machine.capacity?.maxJobs ?? 0, schedule.maxJobs ?? Infinity),
  };
  for (const [key, label] of [['maxAgents', 'agents'], ['maxJobs', 'jobs']]) {
    if (schedule[key] != null && schedule[key] > (machine.capacity?.[key] ?? 0)) add('capped-by-node', `The node allows ${plural(machine.capacity?.[key] ?? 0, label.slice(0, -1))}; the override of ${schedule[key]} cannot raise that`, 'info');
  }
  if (!machine.capacity?.maxAgents && !machine.capacity?.maxJobs) add('capped-by-node', 'Observe-only: no agent or CI slots', 'info');
  let factor = 1; let blocked = false; const blocks = { agents: false, jobs: false };
  const block = (code, message) => { blocked = true; add(code, message, 'blocks'); };
  const health = machine.health;
  let loadPerCore;
  if (offline) add(machine.revokedAt ? 'revoked' : 'offline', machine.revokedAt ? 'Revoked by the owner' : `No heartbeat since ${machine.lastHeartbeatAt}`, 'blocks');
  else if (!health || !(now - Date.parse(health.reportedAt) < settings.healthStaleMs)) {
    add('no-telemetry', health ? 'Health telemetry is stale; placing by capacity only' : 'No health telemetry yet; placing by capacity only', 'info');
  } else {
    if (health.cpus && health.load) {
      loadPerCore = Math.round(health.load[0] / health.cpus * 100) / 100;
      if (loadPerCore >= settings.loadHardPerCore) block('overloaded', `Load ${loadPerCore.toFixed(1)} per core (limit ${settings.loadHardPerCore})`);
      else if (loadPerCore > settings.loadSoftPerCore) {
        factor *= (settings.loadHardPerCore - loadPerCore) / (settings.loadHardPerCore - settings.loadSoftPerCore);
        add('busy', `Load ${loadPerCore.toFixed(1)} per core; taking less work above ${settings.loadSoftPerCore}`, 'reduces');
      }
    }
    if (health.processes !== undefined && health.processes > settings.maxProcesses) block('too-many-processes', `${number(health.processes)} processes (limit ${number(settings.maxProcesses)})`);
    if (health.memory?.pressure === 'critical') block('memory-pressure', 'Memory pressure is critical');
    else if (health.memory?.pressure === 'warn') { factor *= 0.5; add('memory-pressure', 'Memory pressure is elevated; taking half the work', 'reduces'); }
    if (health.disk && health.disk.freeBytes < settings.minFreeDiskBytes) block('low-disk', `${gigabytes(health.disk.freeBytes)} free on the workspace disk (needs ${gigabytes(settings.minFreeDiskBytes)})`);
    else if (health.storage?.state === 'critical') block('low-disk', 'Workspace storage is critical');
    else if (health.storage?.state === 'low') { factor *= 0.5; add('low-disk', 'Workspace storage is low; taking half the work', 'reduces'); }
    const battery = schedule.allowOnBattery ?? settings.allowOnBattery;
    if (health.power?.source === 'battery' && !battery) block('on-battery', `On battery${health.power.percent !== undefined ? ` (${health.power.percent}%)` : ''}; battery work is off`);
    if (health.thermal === 'critical') block('thermal', 'Thermal state is critical');
    else if (health.thermal === 'serious') { factor *= 0.5; add('thermal', 'Running hot; taking half the work', 'reduces'); }
    if (health.runtime?.reachable === false) { blocks.agents = true; add('runtime-unreachable', 'The T3 runtime is not answering; CI jobs only', 'blocks-agents'); }
  }
  if (!offline && configured.agents > 0 && !(machine.providers ?? []).length) { blocks.agents = true; add('no-provider', 'No harness providers detected', 'blocks-agents'); }
  const cordoned = Boolean(schedule.cordoned); const draining = Boolean(schedule.drain) || machine.status === 'draining';
  if (cordoned) add('cordoned', 'Cordoned by the owner', 'blocks');
  const busy = held.agents + held.jobs;
  if (draining) add('draining', busy ? `Draining: ${[held.agents && plural(held.agents, 'agent'), held.jobs && plural(held.jobs, 'job')].filter(Boolean).join(' and ')} finishing` : 'Drained; nothing running', 'blocks');
  const stop = offline || blocked || cordoned || draining;
  const scale = value => Math.min(value, Math.round(value * factor));
  const effective = { agents: stop || blocks.agents ? 0 : scale(configured.agents), jobs: stop || blocks.jobs ? 0 : scale(configured.jobs) };
  if (!stop && (effective.agents || effective.jobs) && held.agents >= effective.agents && held.jobs >= effective.jobs) {
    add('full', [effective.agents && `All ${plural(effective.agents, 'agent slot')} in use`, effective.jobs && `all ${plural(effective.jobs, 'job slot')} in use`].filter(Boolean).join('; ').replace(/^all/, 'All'), 'info');
  }
  const status = offline ? 'offline' : cordoned ? 'cordoned' : draining ? (busy ? 'draining' : 'drained') : blocked ? 'overloaded'
    : factor < 1 || blocks.agents || blocks.jobs ? 'limited' : 'online';
  return { status, accepting: !stop && (effective.agents > held.agents || effective.jobs > held.jobs), configured: { agents: configured.agents, jobs: configured.jobs },
    effective, held, ...(loadPerCore !== undefined ? { loadPerCore } : {}), weight: schedule.weight ?? 1, reasons };
}

/** How well a machine suits one item: free headroom, cool CPUs, affinity and the owner's weight. */
export function score(machine, view, kind, { previous, repo, config }) {
  const slot = SLOT[kind]; const effective = view.effective[slot]; const held = view.held[slot];
  const hard = (config.placement ?? PLACEMENT_DEFAULTS).loadHardPerCore;
  const reasons = [`least loaded: ${held} of ${effective} ${slot} in use`];
  let value = 40 * Math.max(0, effective - held) / Math.max(1, effective);
  if (view.loadPerCore !== undefined) { value += 20 * (1 - Math.min(view.loadPerCore, hard) / hard); reasons.push(`load ${view.loadPerCore} per core`); }
  else value += 10;
  if (previous && previous === machine.id) { value += 25; reasons.push('previous attempt ran here'); }
  if (repo && machine.workspaces?.repos?.includes(repo)) { value += 15; reasons.push('warm workspace'); }
  if (view.weight !== 1) { value *= view.weight; reasons.push(`weight ${view.weight}`); }
  return { score: Math.round(value * 10) / 10, reasons };
}

const SCHEDULE_DEFAULTS = Object.freeze({ cordoned: false, drain: false, weight: 1, maxAgents: null, maxJobs: null, labels: null, allowOnBattery: null });
const PATCH_KEYS = [...Object.keys(SCHEDULE_DEFAULTS), 'idempotencyKey'];

export class Placement {
  constructor(hub) {
    this.hub = hub;
    // Items deferred to a better machine, by kind:id, with when the first deferral happened. In memory: a restart only
    // restarts the short deferral window.
    this.deferred = new Map();
    // The machine that last leased work for a work item, so retries and later steps of the item prefer it.
    this.lastMachine = new Map();
  }
  get config() { return this.hub.config; }
  now() { return this.hub.clock(); }
  /** Live leases the hub holds per machine and kind. */
  heldCounts() {
    const at = this.now(); const counts = new Map();
    for (const kind of ['assignment', 'job']) {
      for (const value of this.hub.store.byStatus(kind, ['leased', 'running'])) {
        if (!value.machineId || !(Date.parse(value.leaseExpiresAt) > at)) continue;
        const entry = counts.get(value.machineId) ?? { agents: 0, jobs: 0 };
        entry[SLOT[kind]]++; counts.set(value.machineId, entry);
      }
    }
    return counts;
  }
  assess(machine, held) {
    if (!held) {
      const at = this.now(); held = { agents: 0, jobs: 0 };
      for (const kind of ['assignment', 'job']) held[SLOT[kind]] = this.hub.store.held(kind, machine.id).filter(value => Date.parse(value.leaseExpiresAt) > at).length;
    }
    return assess(machine, { config: this.config, now: this.now(), held, heartbeatMs: this.config.heartbeatIntervalMs });
  }
  view(machine, held) { return { ...machine, placement: this.assess(machine, held) }; }
  views() {
    const counts = this.heldCounts();
    return this.hub.store.list('machine').map(machine => this.view(machine, counts.get(machine.id) ?? { agents: 0, jobs: 0 }));
  }
  /** What changes leasing on a machine, so a heartbeat that changes it wakes the machine's polls. */
  signature(machine) {
    const view = this.assess(machine, { agents: 0, jobs: 0 });
    return `${view.status}:${view.effective.agents}:${view.effective.jobs}`;
  }
  /** Apply heartbeat telemetry and labels; emits an event when the placement status changes. */
  heartbeat(machine, body) {
    if (body.labels !== undefined) machine.reportedLabels = body.labels;
    if (machine.schedule?.labels) machine.labels = machine.schedule.labels;
    else if (machine.reportedLabels) machine.labels = machine.reportedLabels;
    const health = normalizeHealth(body.health, new Date(this.now()).toISOString());
    if (health) machine.health = health;
    const workspaces = normalizeWorkspaces(body.workspaces);
    if (workspaces) machine.workspaces = workspaces;
    this.transition(machine);
  }
  /** Record status transitions (online, limited, overloaded, …) in the event log; steady heartbeats write nothing. */
  transition(machine) {
    const view = this.assess(machine);
    if (machine.placementStatus === view.status) return;
    const previous = machine.placementStatus; machine.placementStatus = view.status;
    if (previous !== undefined) this.hub.emit('machine.placement-changed', 'machine', machine, { from: previous, to: view.status, reasons: view.reasons.filter(reason => reason.effect !== 'info').map(reason => reason.code) });
  }
  /** `PATCH /machines/:id`: cordon, drain, weight and overrides. Setting a value it already has changes nothing. */
  patch(machineId, body) {
    const machine = this.hub.store.need('machine', machineId);
    object(body);
    requireValue(Object.keys(body).every(key => PATCH_KEYS.includes(key)), `Machines accept ${Object.keys(SCHEDULE_DEFAULTS).join(', ')}.`);
    requireValue(Object.keys(body).some(key => key !== 'idempotencyKey'), 'Set at least one machine setting.');
    for (const key of ['cordoned', 'drain']) if (body[key] !== undefined) requireValue(typeof body[key] === 'boolean', `${key} must be a boolean.`);
    if (body.weight !== undefined) requireValue(finite(body.weight, 0, 10), 'weight must be a number from 0 to 10.');
    for (const key of ['maxAgents', 'maxJobs']) if (body[key] !== undefined && body[key] !== null) integer(body[key], key, 0, 100000);
    if (body.labels !== undefined && body.labels !== null) strings(body.labels, 'labels');
    if (body.allowOnBattery !== undefined && body.allowOnBattery !== null) requireValue(typeof body.allowOnBattery === 'boolean', 'allowOnBattery must be a boolean or null.');
    if (machine.revokedAt) fail(409, 'MACHINE_REVOKED', 'A revoked machine cannot be scheduled.');
    const schedule = { ...SCHEDULE_DEFAULTS, ...machine.schedule };
    const changes = {};
    for (const key of Object.keys(SCHEDULE_DEFAULTS)) {
      if (body[key] === undefined || JSON.stringify(body[key]) === JSON.stringify(schedule[key])) continue;
      changes[key] = { from: schedule[key], to: body[key] }; schedule[key] = body[key];
    }
    if (!Object.keys(changes).length) return this.view(machine);
    machine.schedule = { ...schedule, updatedAt: new Date(this.now()).toISOString() };
    if (changes.labels) { machine.reportedLabels ??= machine.labels; machine.labels = schedule.labels ?? machine.reportedLabels; }
    this.hub.store.put('machine', machine);
    if (changes.cordoned) this.hub.emit(schedule.cordoned ? 'machine.cordoned' : 'machine.uncordoned', 'machine', machine);
    if (changes.drain) this.hub.emit(schedule.drain ? 'machine.draining' : 'machine.drain-cancelled', 'machine', machine, { source: 'owner' });
    const rest = Object.fromEntries(Object.entries(changes).filter(([key]) => !['cordoned', 'drain'].includes(key)));
    if (Object.keys(rest).length) this.hub.emit('machine.updated', 'machine', machine, { changes: rest });
    this.transition(machine); this.hub.store.put('machine', machine);
    // Its polls re-evaluate at once: an uncordoned machine leases without waiting for new work.
    this.hub.signalMachine(machine.id);
    return this.view(machine);
  }
  /**
   * The placement chooser for one lease call: decides, item by item, whether this machine should take it now. It
   * defers a fresh item while another machine that is polling right now, fits the item and has a free slot would
   * score clearly better, and wakes that machine. Items older than `deferMs` go to any eligible machine.
   */
  chooser(machine, kind, view) {
    const settings = this.config.placement ?? PLACEMENT_DEFAULTS; const slot = SLOT[kind]; const now = this.now();
    const mine = { ...view, held: { ...view.held } };
    let others;
    const candidates = () => {
      if (others) return others;
      const counts = this.heldCounts();
      others = [];
      for (const other of this.hub.store.list('machine')) {
        if (other.id === machine.id) continue;
        // Only a machine long-polling for this kind right now is a better home: it is woken and leases at once.
        if (![...(this.hub.waiters.get(other.id) ?? [])].some(waiter => waiter.kinds.includes(kind))) continue;
        const otherView = this.assess(other, counts.get(other.id) ?? { agents: 0, jobs: 0 });
        if (otherView.effective[slot] > otherView.held[slot]) others.push({ machine: other, view: otherView, promised: 0 });
      }
      return others;
    };
    return value => {
      const context = { previous: (value.workItemId && this.lastMachine.get(value.workItemId)) ?? value.placement?.machineId, repo: value.repo?.url ? repoKey(value.repo.url) : undefined, config: this.config };
      const own = score(machine, mine, kind, context);
      const key = `${kind}:${value.id}`; const since = this.deferred.get(key);
      if (settings.deferMs > 0 && (since === undefined || now - since < settings.deferMs)) {
        let best = null;
        for (const other of candidates()) {
          if (other.view.effective[slot] - other.view.held[slot] - other.promised <= 0 || !fits(other.machine, value, kind)) continue;
          // CI jobs also need the runner pool and labels they ask for, or that machine is no home at all.
          if (kind === 'job' && this.hub.pipelines && !this.hub.pipelines.runners.fits(other.machine, value)) continue;
          // A machine that handed this item back is not offered it again for a while, so it is no better home.
          if (value.releasedBy?.machineId === other.machine.id && Date.parse(value.releasedBy.until) > now) continue;
          const theirs = score(other.machine, { ...other.view, held: { ...other.view.held, [slot]: other.view.held[slot] + other.promised } }, kind, context);
          if (theirs.score >= own.score + settings.spreadMargin && (!best || theirs.score > best.score)) best = { ...theirs, other };
        }
        if (best) {
          if (since === undefined) { this.deferred.set(key, now); if (this.deferred.size > 10000) this.deferred.delete(this.deferred.keys().next().value); }
          best.other.promised++; this.hub.signalMachine(best.other.machine.id);
          return null;
        }
      }
      this.deferred.delete(key);
      mine.held[slot]++;
      if (value.workItemId) {
        this.lastMachine.delete(value.workItemId); this.lastMachine.set(value.workItemId, machine.id);
        if (this.lastMachine.size > 10000) this.lastMachine.delete(this.lastMachine.keys().next().value);
      }
      return { machineId: machine.id, score: own.score, reasons: own.reasons, at: new Date(now).toISOString() };
    };
  }
}

/** Whether a machine meets an item's requirements (the same rules leasing applies). */
export function fits(machine, value, kind) {
  const requirements = value.requirements ?? {};
  if (requirements.os && requirements.os !== machine.os) return false;
  if (!(requirements.labels ?? []).every(label => machine.labels.includes(label))) return false;
  if (!(requirements.providers ?? []).every(provider => machine.providers.includes(provider))) return false;
  return !(kind === 'assignment' && value.harness?.provider && !machine.providers.includes(value.harness.provider));
}
