import { plan as computePlan, learnBurnRates } from '@perpeto/pacer';
import { pacingFields } from './config.js';
import { nonblank, object, requireValue } from './errors.js';

/** Settings the owner may change through `PUT /pacing/settings`; the rest stay in hub config. */
export const PACING_SETTINGS = ['enabled', 'strategy', 'targetUsePercent', 'minAgents', 'maxAgents'];
const WINDOW_KINDS = ['session', 'weekly', 'monthly', 'other'];
const WINDOW_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MINUTE = 60000;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

/** A display string from a node or the owner: bounded, single line, never parsed further. */
export function displayText(value, name, max) {
  nonblank(value, name, max); requireValue(!CONTROL.test(value), `Invalid ${name}.`);
  return value.trim();
}

/**
 * Heartbeat `Account.usage`: window percentages, kinds, labels, resets and lengths only. Unknown fields are dropped
 * rather than refused, so a newer node cannot lose its account snapshot over an addition.
 */
export function accountUsage(value) {
  object(value, 'account usage');
  requireValue(iso(value.checkedAt), 'Invalid account usage checkedAt.');
  requireValue(Array.isArray(value.windows) && value.windows.length <= 16, 'Account usage windows must be an array of at most 16.');
  const windows = value.windows.map(window => {
    object(window, 'usage window');
    requireValue(typeof window.id === 'string' && WINDOW_ID.test(window.id), 'Invalid usage window id.');
    requireValue(WINDOW_KINDS.includes(window.kind), 'Invalid usage window kind.');
    requireValue(typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100, 'Invalid usage window usedPercent.');
    if (window.resetsAt !== undefined) requireValue(iso(window.resetsAt), 'Invalid usage window resetsAt.');
    if (window.windowMins !== undefined) requireValue(Number.isSafeInteger(window.windowMins) && window.windowMins > 0 && window.windowMins <= 527040, 'Invalid usage window windowMins.');
    return { id: window.id, kind: window.kind, label: displayText(window.label, 'usage window label', 80), usedPercent: window.usedPercent,
      ...(window.resetsAt !== undefined ? { resetsAt: new Date(window.resetsAt).toISOString() } : {}),
      ...(window.windowMins !== undefined ? { windowMins: window.windowMins } : {}) };
  });
  requireValue(new Set(windows.map(window => window.id)).size === windows.length, 'Duplicate usage window ids.');
  return { checkedAt: new Date(value.checkedAt).toISOString(), windows };
}

/**
 * Hub side of subscription pacing: learns burn rates from usage samples and agent time, runs the pure pacer over the
 * fleet, caps leases with the plan, and publishes per-account allowances to nodes.
 */
export class Pacing {
  constructor(hub) {
    this.hub = hub; this.store = hub.store;
    this.current = null; this.computedAt = -Infinity; this.dirty = true; this.capsByMachine = new Map();
  }
  settings() {
    const stored = this.store.get('pacing-settings', 'settings');
    const overrides = Object.fromEntries(PACING_SETTINGS.filter(key => stored && Object.hasOwn(stored, key)).map(key => [key, stored[key]]));
    return { ...this.hub.config.pacing, ...overrides };
  }
  updateSettings(body) {
    object(body, 'pacing settings');
    const changes = Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'idempotencyKey'));
    requireValue(Object.keys(changes).every(key => PACING_SETTINGS.includes(key)), `Pacing settings are ${PACING_SETTINGS.join(', ')}.`);
    const merged = { ...this.settings(), ...changes };
    pacingFields(changes, { partial: true });
    requireValue(merged.maxAgents === null || merged.minAgents <= merged.maxAgents, 'pacing.minAgents cannot exceed maxAgents.');
    const stored = this.store.get('pacing-settings', 'settings') ?? { id: 'settings' };
    this.store.put('pacing-settings', { ...stored, ...changes, updatedAt: this.hub.now() });
    this.hub.emit('pacing.settings-updated', 'pacing', { id: 'settings' }, changes);
    this.dirty = true;
    this.refresh({ force: true });
    return this.view();
  }

  /** Agents on each account now: live leases whose assignment reported the account it is bound to. */
  running(machineId) {
    const time = this.hub.clock(); const counts = new Map();
    const active = machineId ? this.store.held('assignment', machineId) : this.store.byStatus('assignment', ['leased', 'running']);
    for (const value of active) {
      if (!value.accountId || Date.parse(value.leaseExpiresAt) <= time) continue;
      counts.set(value.accountId, (counts.get(value.accountId) ?? 0) + 1);
    }
    return counts;
  }
  /** Accumulate agent-minutes per account up to now, assuming the running count held since the last integration. */
  integrate(accountId, running, time) {
    const value = this.store.get('pacing-account', accountId) ?? { id: accountId, agentMinutes: 0, integratedAt: time };
    // A long gap (hub down) is not credited as agent time: at most ten minutes per step.
    const elapsed = Math.min(Math.max(0, time - value.integratedAt), 10 * MINUTE);
    value.agentMinutes += running * elapsed / MINUTE; value.integratedAt = time;
    return value;
  }

  /**
   * A heartbeat's accounts, before they replace the stored snapshot: integrate agent time, keep each fresh usage
   * reading as a sample, and learn burn rates from it. A reading is fresh when its checkedAt moves; repeated stale
   * values never count as "no usage".
   */
  observe(machine, accounts) {
    const time = this.hub.clock(); const running = this.running(machine.id);
    for (const account of accounts) {
      const previous = this.store.get('account', account.id);
      const value = this.integrate(account.id, running.get(account.id) ?? 0, time);
      if (account.usage && account.usage.checkedAt !== previous?.usage?.checkedAt) {
        const at = Math.min(time, Date.parse(account.usage.checkedAt));
        this.store.accountUsage(account.id, machine.id, new Date(at).toISOString(), account.usage);
        value.learning = learnBurnRates(value.learning ?? null, { at, agentMinutes: value.agentMinutes, windows: account.usage.windows });
        this.dirty = true;
      }
      if (JSON.stringify([previous?.status, previous?.cooldownUntil, previous?.provider]) !== JSON.stringify([account.status, account.cooldownUntil, account.provider])) this.dirty = true;
      this.store.put('pacing-account', value);
    }
  }
  rates() {
    const rates = {};
    for (const value of this.store.list('pacing-account')) {
      const learned = Object.entries(value.learning?.rates ?? {}).filter(([, rate]) => rate?.samples > 0);
      if (learned.length) rates[value.id] = Object.fromEntries(learned.map(([id, rate]) => [id, rate.perAgentHour]));
    }
    return rates;
  }

  /** Useful agent work per provider: queued work of running runs (and project work) plus agents already working. */
  readyWork() {
    const work = {}; const runs = new Map(); const time = this.hub.clock();
    const status = runId => { if (!runs.has(runId)) runs.set(runId, this.store.get('run', runId)?.status); return runs.get(runId); };
    for (const value of this.store.byStatus('assignment', ['queued', 'leased', 'running'])) {
      const provider = value.harness?.provider;
      if (!provider) continue;
      if (value.status === 'queued' && value.runId && status(value.runId) !== 'running') continue;
      if (value.status !== 'queued' && Date.parse(value.leaseExpiresAt) <= time) continue;
      work[provider] = (work[provider] ?? 0) + 1;
    }
    return work;
  }

  compute() {
    const time = this.hub.clock(); const settings = this.settings();
    const accounts = this.store.list('account').map(account => ({ accountId: account.id, machineId: account.machineId, provider: account.provider,
      label: account.label, ...(account.plan ? { plan: account.plan } : {}), status: account.status,
      ...(account.cooldownUntil ? { cooldownUntil: account.cooldownUntil } : {}), ...(account.lastUsedAt ? { lastUsedAt: account.lastUsedAt } : {}),
      ...(account.usage ? { usage: account.usage } : {}) }));
    const heartbeatWindow = this.hub.config.heartbeatIntervalMs * 3;
    const machines = this.store.list('machine').map(machine => ({ machineId: machine.id, slots: machine.capacity?.maxAgents ?? 0, providers: machine.providers,
      online: machine.status === 'online' && !machine.revokedAt && time - Date.parse(machine.lastHeartbeatAt) < heartbeatWindow }));
    const running = Object.fromEntries(this.running());
    const result = computePlan({ now: time, settings, accounts, rates: this.rates(), running, machines, readyWork: this.readyWork() });
    return { enabled: settings.enabled, strategy: result.strategy, targetUsePercent: result.targetUsePercent,
      minAgents: settings.minAgents, maxAgents: settings.maxAgents, updatedAt: result.at,
      providers: result.providers, accounts: result.accounts, timeline: result.timeline };
  }

  /**
   * Recompute when inputs changed (at most once a second) or the plan is older than `recomputeMs`. Emits
   * `pacing.updated` when provider targets or account states/targets change, and wakes machines whose caps moved.
   */
  refresh({ force = false } = {}) {
    const time = this.hub.clock(); const settings = this.hub.config.pacing;
    const due = force || !this.current || time - this.computedAt >= settings.recomputeMs || (this.dirty && time - this.computedAt >= 1000);
    if (!due) return false;
    const next = this.compute(); this.dirty = false; this.computedAt = time;
    const digest = JSON.stringify([next.enabled, next.strategy, next.targetUsePercent,
      next.providers.map(item => [item.provider, item.targetAgents, item.limitedBy, item.starved]),
      next.accounts.map(item => [item.accountId, item.state, item.targetAgents])]);
    const stored = this.store.get('pacing-state', 'fleet');
    this.current = next;
    // A hub that has never had anything to pace records its empty plan without announcing it.
    const announce = stored || next.providers.length || next.accounts.length;
    if (stored?.digest !== digest) this.store.put('pacing-state', { id: 'fleet', digest, at: next.updatedAt });
    if (stored?.digest !== digest && announce) {
      this.hub.emit('pacing.updated', 'pacing', { id: 'fleet' }, { enabled: next.enabled, strategy: next.strategy,
        providers: next.providers.map(({ provider, targetAgents, runningAgents, limitedBy, starved }) => ({ provider, targetAgents, runningAgents, limitedBy, starved })),
        accounts: next.accounts.map(({ accountId, state, targetAgents }) => ({ accountId, state, targetAgents })) });
    }
    const caps = this.machineCaps();
    for (const machineId of new Set([...caps.keys(), ...this.capsByMachine.keys()])) {
      if (JSON.stringify(caps.get(machineId)) !== JSON.stringify(this.capsByMachine.get(machineId))) this.hub.signalMachine(machineId);
    }
    this.capsByMachine = caps;
    return true;
  }
  view() { if (!this.current) this.refresh({ force: true }); return this.current; }

  /** Agents allowed per provider on each machine: the sum of its accounts' targets, for paced providers only. */
  machineCaps() {
    const caps = new Map();
    if (!this.current?.enabled) return caps;
    const paced = new Set(this.current.providers.map(item => item.provider));
    for (const account of this.current.accounts) {
      if (!paced.has(account.provider)) continue;
      const machine = caps.get(account.machineId) ?? {};
      machine[account.provider] = (machine[account.provider] ?? 0) + account.targetAgents;
      caps.set(account.machineId, machine);
    }
    return caps;
  }
  /** Lease caps for one machine: `{ [provider]: { limit, held } }`, or null when pacing does not apply. */
  leaseCaps(machineId) {
    this.refresh();
    const limits = this.machineCaps().get(machineId);
    if (!limits) return null;
    const caps = Object.fromEntries(Object.entries(limits).map(([provider, limit]) => [provider, { limit, held: 0 }]));
    const time = this.hub.clock();
    for (const value of this.store.held('assignment', machineId)) {
      const provider = value.harness?.provider;
      if (caps[provider] && Date.parse(value.leaseExpiresAt) > time) caps[provider].held++;
    }
    return caps;
  }
  /** The heartbeat response's `pacing`, for this machine's accounts of paced providers. */
  allowances(machineId) {
    if (!this.current?.enabled) return null;
    const paced = new Set(this.current.providers.map(item => item.provider));
    const accounts = this.current.accounts.filter(account => account.machineId === machineId && paced.has(account.provider));
    return accounts.length ? { accounts: Object.fromEntries(accounts.map(account => [account.accountId, { targetAgents: account.targetAgents }])) } : null;
  }
  starved() {
    if (!this.current?.enabled) return [];
    return this.current.providers.filter(item => item.starved);
  }

  /**
   * Starved fleets nudge continuous intake: an idle keep-open run on a schedule source whose workflow uses the starved
   * provider gets one improvement pass ahead of its schedule, at most once per `nudgeIntervalMs`. The pass asks for
   * nothing when nothing is justified, so no busywork is created. Goal-sourced runs already ask whenever they are idle.
   */
  nudge() {
    const starved = new Set(this.starved().map(item => item.provider));
    if (!starved.size) return;
    const time = this.hub.clock(); const interval = this.hub.config.pacing.nudgeIntervalMs;
    for (const run of this.store.list('run', value => value.status === 'running' && value.keepOpen)) {
      if (run.pacingNudgedAt && time - Date.parse(run.pacingNudgedAt) < interval) continue;
      const graph = this.store.get('run-workflow', run.id)?.workflow?.graph;
      const provider = graph?.nodes?.map(node => node.config?.harness?.provider).find(value => starved.has(value));
      if (!provider) continue;
      const state = this.hub.intake.state(run);
      const source = this.hub.intake.view(run).source;
      const input = graph.nodes.find(node => node.type === 'input' && (source ?? node.config?.source) === 'schedule');
      if (!input || state?.intake?.paused) continue;
      if (Object.values(state?.workItems ?? {}).some(item => !['done', 'failed'].includes(item.status))) continue;
      if (this.store.forRun('intake-request', run.id, false).length) continue;
      const items = this.hub.intake.sourceItems(run, { source: 'schedule', nodeId: input.id, limit: 1 });
      if (!items.length) continue;
      this.hub.intake.request(run, { id: `nudge_${run.id}_${new Date(time).toISOString().slice(0, 16)}`, items });
      run.pacingNudgedAt = new Date(time).toISOString(); this.store.put('run', run);
      this.hub.emit('pacing.nudged', 'run', { ...run, runId: run.id }, { provider, nodeId: input.id });
    }
  }

  /** Under-burning findings for metrics: starved providers used by a running run, attached to its input node. */
  bottlenecks(runs) {
    const starved = this.starved();
    if (!starved.length) return [];
    const findings = [];
    for (const run of runs) {
      if (run.status !== 'running') continue;
      const graph = this.store.get('run-workflow', run.id)?.workflow?.graph;
      if (!graph?.nodes?.length) continue;
      const used = new Set(graph.nodes.map(node => node.config?.harness?.provider).filter(Boolean));
      const nodeId = (graph.nodes.find(node => node.type === 'input') ?? graph.nodes[0]).id;
      for (const fleet of starved) {
        if (!used.has(fleet.provider)) continue;
        findings.push({ nodeId, reason: 'under-burning', severity: 'warning', runId: run.id,
          evidence: `${fleet.provider}: ${fleet.readyWork} ready agent item${fleet.readyWork === 1 ? '' : 's'} for ${fleet.sustainableAgents} agents the subscriptions sustain; ${fleet.runningAgents} running, headroom will reset unused` });
      }
    }
    return findings;
  }
}
