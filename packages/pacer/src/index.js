/**
 * Subscription pacer. Pure and deterministic: no I/O, no clock, no randomness. Every input, including `now`, is an
 * argument, so the same inputs always give the same plan.
 *
 * Units: usage is a percentage of a provider window; a burn rate is percentage points of one window consumed per
 * agent-hour (one agent running for one hour on that account). Agent-hours left in a window are
 * `(targetUsePercent - usedPercent) / burnRate`.
 */

export const WINDOW_KINDS = Object.freeze(['session', 'weekly', 'monthly', 'other']);
export const DEFAULT_WINDOW_MINS = Object.freeze({ session: 300, weekly: 10080, monthly: 43200, other: 300 });
export const STRATEGIES = Object.freeze(['rotation', 'parallel']);
export const ACCOUNT_STATES = Object.freeze(['burning', 'next', 'resting', 'cooling', 'exhausted', 'unknown']);
/**
 * Defaults. Burn-rate priors are uncalibrated starting points (percent of a window per agent-hour) used until the hub
 * has learned a rate for an account's window from its own samples.
 */
export const PACING_DEFAULTS = Object.freeze({
  enabled: true, strategy: 'rotation', targetUsePercent: 95, minAgents: 0, maxAgents: null,
  handoverMins: 15, sprintMins: 90, horizonMins: 600, stepMins: 5, projectionDays: 8,
  priors: Object.freeze({
    default: Object.freeze({ session: 20, weekly: 2.5, monthly: 0.6, other: 20 }),
    claudeAgent: Object.freeze({ session: 20, weekly: 2.5 }),
    codex: Object.freeze({ session: 15, weekly: 2 }),
  }),
});
/** Percentage points either side of the target that still count as on track. */
export const ON_TRACK_TOLERANCE = 3;

const MINUTE = 60_000;
const HOUR = 3_600_000;
const EPS = 1e-9;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const positive = value => finite(value) && value > 0 ? value : undefined;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const round1 = value => Math.round(value * 10) / 10;
const iso = ms => new Date(ms).toISOString();
const timeOf = value => typeof value === 'number' ? value : Date.parse(value);

/** Defaults merged with overrides; priors merge per provider and window kind. */
export function pacingSettings(overrides = {}) {
  const priors = { ...Object.fromEntries(Object.entries(PACING_DEFAULTS.priors).map(([key, value]) => [key, { ...value }])) };
  for (const [provider, values] of Object.entries(overrides.priors ?? {})) priors[provider] = { ...(priors[provider] ?? {}), ...values };
  return { ...PACING_DEFAULTS, ...overrides, priors };
}

function prior(settings, provider, kind) {
  return positive(settings.priors[provider]?.[kind]) ?? positive(settings.priors.default?.[kind])
    ?? positive(settings.priors.default?.session) ?? PACING_DEFAULTS.priors.default.session;
}

function buildAccount(raw, settings, rates, running, now) {
  const learned = rates?.[raw.accountId] ?? {};
  const windows = (Array.isArray(raw.usage?.windows) ? raw.usage.windows : [])
    .filter(window => window && typeof window.id === 'string' && finite(window.usedPercent))
    .map(window => {
      const kind = WINDOW_KINDS.includes(window.kind) ? window.kind : 'other';
      const len = Number.isSafeInteger(window.windowMins) && window.windowMins > 0 ? window.windowMins : DEFAULT_WINDOW_MINS[kind];
      const reported = clamp(window.usedPercent, 0, 100);
      const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
      let used = reported; let resetMs = null; let started = false;
      if (finite(reset) && reset > now) { resetMs = reset; started = true; }
      else if (finite(reset)) used = 0; // The window has reset since this sample.
      else if (used > 0) { resetMs = now + len * MINUTE; started = true; } // In use with no known reset: assume a full window ahead.
      const rate = positive(learned[window.id]);
      return {
        id: window.id, kind, label: typeof window.label === 'string' && window.label ? window.label : window.id,
        short: kind === 'session' || (kind === 'other' && len <= 1440), len, used, resetMs, started,
        rate: rate ?? prior(settings, raw.provider, kind), learned: rate !== undefined, real: true,
        reported, reportedReset: finite(reset) && reset > now ? iso(reset) : undefined,
        cycleStartMs: started ? now : null, cycleStartUsed: used, projection: null, everStarted: started,
      };
    });
  const unknown = windows.length === 0;
  // Without usage the account is treated as a fresh session at the provider prior.
  if (unknown) windows.push({ id: '_session', kind: 'session', short: true, len: DEFAULT_WINDOW_MINS.session, used: 0, resetMs: null,
    started: false, rate: prior(settings, raw.provider, 'session'), learned: false, real: false });
  const cooldown = raw.cooldownUntil ? Date.parse(raw.cooldownUntil) : NaN;
  return {
    id: raw.accountId, machineId: raw.machineId, provider: raw.provider, label: raw.label ?? raw.accountId,
    ...(typeof raw.plan === 'string' && raw.plan ? { plan: raw.plan } : {}),
    status: raw.status ?? 'active', excluded: ['disabled', 'invalid'].includes(raw.status),
    cooldownMs: raw.status === 'cooling' ? (finite(cooldown) ? cooldown : Infinity) : (finite(cooldown) && cooldown > now ? cooldown : null),
    lastUsedMs: raw.lastUsedAt ? Date.parse(raw.lastUsedAt) || 0 : 0,
    running: Math.max(0, Math.floor(running?.[raw.accountId] ?? 0)), unknown, windows,
  };
}

const limit = target => Math.min(target, 100);
const available = (account, t) => !account.excluded && !(account.cooldownMs !== null && account.cooldownMs > t);
const windowHours = (window, target) => Math.max(0, limit(target) - window.used) / window.rate;
const accountHours = (account, target) => Math.min(...account.windows.map(window => windowHours(window, target)));
const atTarget = (account, target) => account.windows.some(window => window.used >= limit(target) - 0.01);
const hardExhausted = (account, target) => account.windows.some(window => window.used >= 100 - EPS
  || (!window.short && window.used >= limit(target) - 0.01));

/** Agents per hour this account's long windows (weekly, monthly) can sustain until each resets. */
function longRate(account, t, target) {
  let rate = Infinity;
  for (const window of account.windows) if (!window.short) {
    const hours = window.started ? Math.max((window.resetMs - t) / HOUR, 1 / 60) : window.len / 60;
    rate = Math.min(rate, windowHours(window, target) / hours);
  }
  return rate;
}
/** Agents per hour full session windows deliver in steady rotation. */
function shortRate(account, target) {
  let rate = Infinity;
  for (const window of account.windows) if (window.short) rate = Math.min(rate, (limit(target) / window.rate) / (window.len / 60));
  return rate;
}

function sessionInProgress(account, target) {
  const live = account.windows.filter(window => window.short && window.started && window.used < limit(target) - 0.01);
  return live.length ? Math.min(...live.map(window => window.resetMs)) : null;
}

/**
 * Eligible accounts in rotation order: sessions already ticking (soonest reset first, so their headroom is not lost),
 * then fresh accounts by weekly urgency (most long-window headroom per hour until its reset), least recently used
 * first on ties, then accounts without usage.
 */
function rotationOrder(accounts, t, target) {
  return accounts.filter(account => available(account, t) && !atTarget(account, target) && accountHours(account, target) > EPS)
    .map(account => {
      const live = sessionInProgress(account, target);
      const urgency = Math.min(longRate(account, t, target), 1e9);
      return { account, group: live !== null ? 0 : account.unknown ? 2 : 1, key: live ?? Math.round(-urgency * 1e6) / 1e6 };
    })
    .sort((a, b) => a.group - b.group || a.key - b.key || a.account.lastUsedMs - b.account.lastUsedMs || a.account.id.localeCompare(b.account.id))
    .map(entry => entry.account);
}

/**
 * Agent-hours the fleet is behind a straight-line path from each binding long window's start to the target at its reset.
 * A window that has not started yet counts as slightly behind, so it gets started.
 */
function scheduleBehind(accounts, t, target) {
  let behind = 0;
  for (const account of accounts) {
    if (account.excluded) continue;
    let binding = null; let rate = Infinity;
    for (const window of account.windows) if (!window.short) {
      const hours = window.started ? Math.max((window.resetMs - t) / HOUR, 1 / 60) : window.len / 60;
      const value = windowHours(window, target) / hours;
      if (value < rate) { rate = value; binding = window; }
    }
    if (!binding) continue;
    if (!binding.started) { behind += 0.5; continue; }
    const elapsed = clamp(1 - (binding.resetMs - t) / (binding.len * MINUTE), 0, 1);
    behind += (limit(target) * elapsed - binding.used) / binding.rate;
  }
  return behind;
}

/** Fleet target for one provider at time t. `previous` is the agent count currently running, for hysteresis. */
function fleetTarget(accounts, t, settings, { slots, work, previous }) {
  const target = settings.targetUsePercent;
  let weekly = 0; let session = 0; let combined = 0;
  for (const account of accounts) {
    if (account.excluded) continue;
    const long = longRate(account, t, target); const short = shortRate(account, target);
    weekly += long; session += short; combined += Math.min(long, short);
  }
  let capacity;
  if (combined === Infinity) capacity = Infinity;
  else if (combined > 0 && combined < 1 && weekly <= session) {
    // Less than one agent sustainable and the week binds: run one agent while the fleet is behind its weekly
    // schedule, with half an agent-hour of slack before stopping, so the idle time spreads across the week instead
    // of collecting at its start.
    const behind = scheduleBehind(accounts, t, target);
    capacity = (previous ?? 0) >= 1 ? (behind > -0.5 ? 1 : 0) : (behind > 0 ? 1 : 0);
  } else {
    capacity = Math.round(combined);
    // Hysteresis: keep the running count while the sustainable rate stays within 0.75 of it, so the plan does not
    // flip every recompute when the rate sits near a half agent.
    if (Number.isSafeInteger(previous) && previous !== capacity && Math.abs(combined - previous) < 0.75) capacity = previous;
  }
  const binder = combined === Infinity ? 'none' : weekly <= session ? 'weekly' : 'session';
  const cap = Math.min(slots, settings.maxAgents ?? Infinity);
  let n = Math.max(capacity, settings.minAgents ?? 0);
  n = Math.min(n, cap, work);
  const options = [[binder, capacity], ['slots', cap], ['work', work]];
  let limitedBy = 'none'; let best = Infinity;
  for (const [name, value] of options) if (value < best) { best = value; limitedBy = name; }
  if (limitedBy === 'none' && best === Infinity) limitedBy = 'none';
  const sustainable = Math.min(Math.max(capacity, settings.minAgents ?? 0), cap);
  const starved = work < sustainable;
  return { n: Number.isFinite(n) ? n : 0, limitedBy, starved, weekly, session, sustainable: Number.isFinite(sustainable) ? sustainable : 0 };
}

/** Per-account targets for one provider. Mutates `free` (machine slots). */
function allocate(accounts, t, settings, n, free) {
  const target = settings.targetUsePercent;
  const handover = settings.handoverMins / 60;
  const order = rotationOrder(accounts, t, target);
  const targets = new Map(accounts.map(account => [account.id, 0]));
  // What an account can absorb over one handover period; at least one agent so its last crumbs are finished
  // before a fresh session is started.
  const cap = account => Math.max(1, Math.floor(accountHours(account, target) / handover + EPS));
  let remaining = n;
  const give = (account, count) => {
    const take = Math.min(count, remaining, free.get(account.machineId) ?? 0);
    if (take <= 0) return 0;
    targets.set(account.id, targets.get(account.id) + take); remaining -= take;
    free.set(account.machineId, free.get(account.machineId) - take);
    return take;
  };
  if (settings.strategy === 'parallel') {
    // Proportional to headroom, rounded down; leftover agents go in rotation order (ticking sessions by soonest reset
    // first), which keeps a small fleet on the same accounts instead of starting every session.
    const total = order.reduce((sum, account) => sum + accountHours(account, target), 0);
    if (total > 0) for (const account of order) give(account, Math.min(cap(account), Math.floor(n * accountHours(account, target) / total + EPS)));
    for (let progress = true; remaining > 0 && progress;) {
      progress = false;
      for (const account of order) {
        if (remaining <= 0) break;
        if (targets.get(account.id) < cap(account) && give(account, 1)) progress = true;
      }
    }
  } else {
    // Rotation: fill the burning account up to what it can absorb over one handover period, then the next, so the
    // next account starts before the current one reaches its target.
    for (const account of order) { if (remaining <= 0) break; give(account, cap(account)); }
  }
  return { targets, placed: n - remaining, order };
}

/** End-of-window sprint: finish a ticking session that would otherwise reset with headroom, if weekly slack allows. */
function sprint(accounts, t, settings, targets, free, { weekly, slots, work, placed }) {
  const target = settings.targetUsePercent;
  // Weekly slack rounds like the fleet target, so a fractional allowance can finish a ticking session.
  let slack = weekly === Infinity ? Infinity : Math.round(weekly - placed);
  let room = Math.min(slots, settings.maxAgents ?? Infinity, work) - placed;
  const sprinting = new Set();
  const candidates = accounts.filter(account => available(account, t) && sessionInProgress(account, target) !== null)
    .sort((a, b) => sessionInProgress(a, target) - sessionInProgress(b, target) || a.id.localeCompare(b.id));
  for (const account of candidates) {
    if (slack <= 0 || room <= 0) break;
    const reset = sessionInProgress(account, target);
    if (reset - t > settings.sprintMins * MINUTE) continue;
    const hours = (reset - t) / HOUR;
    const session = account.windows.filter(window => window.short && window.started && window.resetMs === reset)
      .reduce((least, window) => Math.min(least, windowHours(window, target)), Infinity);
    const longHours = Math.min(Infinity, ...account.windows.filter(window => !window.short).map(window => windowHours(window, target)));
    const current = targets.get(account.id);
    if (current * hours >= session - EPS || longHours < session) continue;
    const extra = Math.min(Math.ceil(session / hours - EPS) - current, slack, room, free.get(account.machineId) ?? 0);
    if (extra <= 0) continue;
    targets.set(account.id, current + extra); free.set(account.machineId, free.get(account.machineId) - extra);
    slack -= extra; room -= extra; sprinting.add(account.id);
  }
  return sprinting;
}

/** One planning step for every provider, sharing machine slots. */
function step(state, t, settings, previous) {
  const free = new Map(state.machines.map(machine => [machine.machineId, machine.online === false ? 0 : machine.slots]));
  const result = new Map();
  const ordered = [...state.providers].sort((a, b) => a.localeCompare(b));
  for (const provider of ordered) {
    const accounts = state.accounts.filter(account => account.provider === provider);
    const owners = new Set(accounts.filter(account => !account.excluded).map(account => account.machineId));
    const slots = state.machines.filter(machine => machine.online !== false && owners.has(machine.machineId)
      && (!Array.isArray(machine.providers) || machine.providers.includes(provider))).reduce((sum, machine) => sum + machine.slots, 0);
    const work = state.readyWork[provider] ?? 0;
    const fleet = fleetTarget(accounts, t, settings, { slots, work, previous: previous.get(provider) });
    const { targets, placed, order } = allocate(accounts, t, settings, fleet.n, free);
    const sprinting = sprint(accounts, t, settings, targets, free, { weekly: fleet.weekly, slots, work, placed });
    let total = 0; for (const value of targets.values()) total += value;
    let limitedBy = fleet.limitedBy;
    // Accounts that cannot take agents right now (all at target or cooling) hold the fleet below its target.
    if (placed < fleet.n) limitedBy = 'session';
    result.set(provider, { provider, targetAgents: total, slots, readyWork: work, limitedBy, starved: fleet.starved, sustainable: fleet.sustainable, targets, order, sprinting });
  }
  return result;
}

function advance(state, plan, t, stepMs) {
  const hours = stepMs / HOUR; const end = t + stepMs;
  for (const account of state.accounts) {
    const agents = plan.get(account.provider)?.targets.get(account.id) ?? 0;
    if (agents > 0) account.lastUsedMs = t;
    for (const window of account.windows) {
      if (agents > 0) {
        if (!window.started) {
          window.started = true; window.everStarted = true; window.resetMs = t + window.len * MINUTE;
          window.cycleStartMs = t; window.cycleStartUsed = window.used;
        }
        window.used = Math.min(100, window.used + window.rate * agents * hours);
      }
      if (window.started && window.resetMs <= end) {
        if (window.real && window.projection === null) window.projection = window.used;
        window.used = 0; window.started = false; window.resetMs = null;
      }
    }
  }
}

function onTrack(projection, target) {
  if (projection > limit(target) + ON_TRACK_TOLERANCE) return 'over';
  if (projection < limit(target) - ON_TRACK_TOLERANCE) return 'under';
  return 'on';
}

/**
 * Plan agents per provider and account.
 *
 * @param {{
 *   now: string|number,
 *   settings?: object,
 *   accounts: Array<{ accountId: string, machineId: string, provider: string, label?: string, plan?: string,
 *     status?: 'active'|'cooling'|'disabled'|'invalid', cooldownUntil?: string, lastUsedAt?: string,
 *     usage?: { checkedAt?: string, windows: Array<{ id: string, kind: string, label?: string, usedPercent: number, resetsAt?: string, windowMins?: number }> } }>,
 *   rates?: Record<string, Record<string, number>>,   // learned percent per agent-hour, by account then window id
 *   running?: Record<string, number>,                  // agents running per account
 *   machines: Array<{ machineId: string, slots: number, providers?: string[], online?: boolean }>,
 *   readyWork?: Record<string, number>,                // useful agent work available per provider
 * }} input
 */
export function plan(input) {
  const settings = pacingSettings(input.settings);
  const now = timeOf(input.now);
  if (!finite(now)) throw new TypeError('plan needs a valid now.');
  if (!STRATEGIES.includes(settings.strategy)) throw new TypeError('Unknown pacing strategy.');
  const target = settings.targetUsePercent;
  const accounts = (input.accounts ?? []).map(raw => buildAccount(raw, settings, input.rates, input.running, now));
  // A provider is paced once at least one of its accounts reports usage windows; until then nodes keep their own policy.
  const providers = [...new Set(accounts.filter(account => !account.unknown && !account.excluded).map(account => account.provider))];
  const machines = (input.machines ?? []).map(machine => ({ ...machine, slots: Math.max(0, Math.floor(machine.slots ?? 0)) }));
  const state = { accounts: accounts.filter(account => providers.includes(account.provider)), providers, machines, readyWork: input.readyWork ?? {} };

  const stepMs = settings.stepMins * MINUTE;
  const horizonEnd = now + settings.horizonMins * MINUTE;
  const latestReset = Math.max(0, ...state.accounts.flatMap(account => account.windows.filter(window => window.started).map(window => window.resetMs)));
  // Nothing paced: no simulation to run.
  const simEnd = state.accounts.length ? Math.min(now + settings.projectionDays * 1440 * MINUTE, Math.max(horizonEnd, latestReset + stepMs)) : now;
  const runningByProvider = new Map(providers.map(provider => [provider, state.accounts.filter(account => account.provider === provider)
    .reduce((sum, account) => sum + account.running, 0)]));

  let previous = runningByProvider; let first = null;
  const horizon = new Map(state.accounts.map(account => [account.id, []]));
  const idle = new Map(state.accounts.map(account => [account.id, 0]));
  for (let t = now; t < simEnd; t += stepMs) {
    const current = step(state, t, settings, previous);
    if (!first) first = { result: current, accounts: structuredClone(state.accounts) };
    if (t < horizonEnd) {
      for (const account of state.accounts) {
        const agents = current.get(account.provider)?.targets.get(account.id) ?? 0;
        horizon.get(account.id).push(agents);
        if (agents === 0 && available(account, t) && !atTarget(account, target) && sessionInProgress(account, target) !== null) {
          idle.set(account.id, idle.get(account.id) + settings.stepMins);
        }
      }
    }
    advance(state, current, t, stepMs);
    previous = new Map([...current].map(([provider, value]) => [provider, value.targetAgents]));
  }
  const end = Math.max(now, simEnd);
  const projections = new Map();
  for (const account of state.accounts) for (const window of account.windows) if (window.real) {
    let value = window.projection;
    if (value === null && window.started) {
      // Still open at the end of the projection: extend its simulated pace to its reset.
      const span = end - window.cycleStartMs;
      const pace = span > 0 ? (window.used - window.cycleStartUsed) / span : 0;
      value = Math.min(100, window.used + pace * Math.max(0, window.resetMs - end));
    }
    projections.set(`${account.id}\0${window.id}`, { value, everStarted: window.everStarted });
  }

  const plans = first?.result ?? new Map();
  const initial = new Map((first?.accounts ?? []).map(account => [account.id, account]));
  const ordered = [...accounts].sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
  const nextIds = new Set();
  for (const value of plans.values()) {
    const candidate = value.order.find(account => value.targets.get(account.id) === 0);
    if (candidate) nextIds.add(candidate.id);
  }
  const accountViews = ordered.map(original => {
    const account = initial.get(original.id) ?? original;
    const paced = providers.includes(account.provider);
    const agents = paced ? plans.get(account.provider)?.targets.get(account.id) ?? 0 : 0;
    let state;
    if (account.status === 'cooling' && account.cooldownMs !== null && account.cooldownMs > now) state = 'cooling';
    else if (account.excluded) state = 'resting';
    else if (!account.unknown && hardExhausted(account, target)) state = 'exhausted';
    else if (agents > 0 || (account.running > 0 && !atTarget(account, target))) state = 'burning';
    else if (!paced) state = 'unknown';
    else if (nextIds.has(account.id)) state = 'next';
    else if (account.unknown) state = 'unknown';
    else state = 'resting';
    const windows = account.windows.filter(window => window.real).map(window => {
      const projected = projections.get(`${account.id}\0${window.id}`) ?? { value: window.used, everStarted: window.started };
      const value = projected.value ?? window.used;
      return {
        id: window.id, kind: window.kind, label: window.label, usedPercent: round1(window.reported),
        ...(window.reportedReset ? { resetsAt: window.reportedReset } : {}),
        projectedPercentAtReset: round1(value),
        onTrack: window.reported > limit(target) + ON_TRACK_TOLERANCE ? 'over' : projected.everStarted ? onTrack(value, target) : 'on',
      };
    });
    const rateWindow = account.windows.find(window => window.real && window.short && window.learned)
      ?? account.windows.find(window => window.real && window.learned);
    return {
      accountId: account.id, machineId: account.machineId, provider: account.provider, label: account.label,
      ...(account.plan ? { plan: account.plan } : {}), status: account.status, state, targetAgents: agents,
      runningAgents: account.running, ...(rateWindow ? { burnPerAgentHour: round1(rateWindow.rate) } : {}),
      windows, idleForecastMins: idle.get(account.id) ?? 0,
    };
  });

  const timeline = [];
  for (const account of state.accounts) {
    if (account.excluded) continue;
    const series = horizon.get(account.id);
    let from = 0;
    for (let index = 1; index <= series.length; index++) {
      if (index === series.length || (series[index] > 0) !== (series[from] > 0)) {
        timeline.push({ accountId: account.id, from: iso(now + from * stepMs), to: iso(Math.min(horizonEnd, now + index * stepMs)), phase: series[from] > 0 ? 'burn' : 'rest' });
        from = index;
      }
    }
  }
  timeline.sort((a, b) => a.from.localeCompare(b.from) || a.accountId.localeCompare(b.accountId));

  const providerViews = [...providers].sort((a, b) => a.localeCompare(b)).map(provider => {
    const value = plans.get(provider);
    return { provider, targetAgents: value?.targetAgents ?? 0, runningAgents: runningByProvider.get(provider) ?? 0,
      slots: value?.slots ?? 0, readyWork: value?.readyWork ?? 0, limitedBy: value?.limitedBy ?? 'none', starved: value?.starved ?? false,
      sustainableAgents: value?.sustainable ?? 0 };
  });
  return { at: iso(now), strategy: settings.strategy, targetUsePercent: target, providers: providerViews, accounts: accountViews, timeline };
}

/** Node allowances from a plan: only accounts of paced providers. */
export function allowances(result) {
  const paced = new Set(result.providers.map(provider => provider.provider));
  return Object.fromEntries(result.accounts.filter(account => paced.has(account.provider))
    .map(account => [account.accountId, { targetAgents: account.targetAgents }]));
}

/**
 * Learn burn rates (percent of a window per agent-hour) from successive usage samples and the agent-minutes that ran on
 * the account between them. Exponentially weighted; robust to sparse or unchanged samples (they accumulate until there
 * is enough evidence) and to resets (a drop or a moved reset re-anchors without learning).
 *
 * @param {{ anchors?: object, rates?: object }|null} previous
 * @param {{ at: string|number, agentMinutes: number, windows: Array<{ id: string, usedPercent: number, resetsAt?: string }> }} sample
 *   `agentMinutes` is cumulative agent time on this account, so differences between samples are agent time between them.
 */
export function learnBurnRates(previous, sample, { alpha = 0.3, minAgentHours = 0.05, maxAgentHours = 1, minDelta = 1, minRate = 0.05, maxRate = 500 } = {}) {
  const anchors = { ...(previous?.anchors ?? {}) };
  const rates = { ...(previous?.rates ?? {}) };
  const at = timeOf(sample.at);
  for (const window of sample.windows ?? []) {
    if (!window || typeof window.id !== 'string' || !finite(window.usedPercent)) continue;
    const used = clamp(window.usedPercent, 0, 100);
    const anchor = anchors[window.id];
    const fresh = { usedPercent: used, ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}), agentMinutes: sample.agentMinutes, at };
    if (!anchor) { anchors[window.id] = fresh; continue; }
    const moved = anchor.resetsAt && window.resetsAt && Math.abs(Date.parse(anchor.resetsAt) - Date.parse(window.resetsAt)) > 2 * MINUTE;
    if (used < anchor.usedPercent - 0.5 || moved) { anchors[window.id] = fresh; continue; }
    const delta = used - anchor.usedPercent;
    const agentHours = (sample.agentMinutes - anchor.agentMinutes) / 60;
    let observed = null;
    if (delta >= minDelta && agentHours >= minAgentHours) observed = delta / agentHours;
    else if (agentHours >= maxAgentHours) observed = Math.max(delta, 0) / agentHours;
    else if (delta >= minDelta) { anchors[window.id] = fresh; continue; } // Usage our agents cannot account for.
    else continue; // Not enough evidence yet; keep accumulating from the same anchor.
    observed = clamp(observed, minRate, maxRate);
    const previousRate = rates[window.id];
    rates[window.id] = previousRate
      ? { perAgentHour: previousRate.perAgentHour + alpha * (observed - previousRate.perAgentHour), samples: previousRate.samples + 1 }
      : { perAgentHour: observed, samples: 1 };
    anchors[window.id] = fresh;
  }
  return { anchors, rates };
}
