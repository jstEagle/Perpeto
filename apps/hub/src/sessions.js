import { createHash } from 'node:crypto';
import { fail, integer, nonblank, object, requireValue } from './errors.js';
import { accountUsage, displayText } from './pacing.js';

const STATUSES = ['running', 'waiting', 'idle', 'error'];
const WINDOWS = { '1h': 3600000, '24h': 86400000, '7d': 604800000 };
const HOUR = 3600000;
const CONTROL = /[\u0000-\u001f\u007f]/;
const LIMITS = { sessions: 500, usage: 2000, removed: 1000, providers: 50 };
/** A machine counts as observing while it reported a connected T3 within this long. */
const OBSERVING_MS = 90000;
/** `sessions.changed` is coalesced per machine: at most one per interval unless a session changed status. */
const CHANGED_EVENT_MS = 15000;
const short = (...parts) => createHash('sha256').update(parts.join('\0')).digest('hex');
const iso = (value, name) => { requireValue(typeof value === 'string' && Number.isFinite(Date.parse(value)), `Invalid ${name}.`); return new Date(value).toISOString(); };
const optionalText = (value, name, max) => value === undefined ? undefined : displayText(value, name, max);
const id = (value, name, max = 200) => { nonblank(value, name, max); requireValue(!CONTROL.test(value), `Invalid ${name}.`); return value; };
/** T3 derives child thread and provider turn ids from their parents, so they can be several hundred characters long. */
const LONG_ID = 1024;
const count = (value, name) => integer(value ?? 0, name, 0, Number.MAX_SAFE_INTEGER);

export const observedAccountId = (machineId, instanceId) => `acct_obs_${short(machineId, instanceId).slice(0, 24)}`;
export const observedSessionId = (machineId, threadId) => `obs_${short(machineId, threadId).slice(0, 24)}`;
const observedUsageId = (machineId, providerTurnId) => `use_obs_${short(machineId, providerTurnId).slice(0, 32)}`;
const emptyTokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });

/** Validate `POST /nodes/observations`. Unknown fields are dropped so a newer node cannot lose a batch over an addition. */
export function observationBody(body) {
  object(body, 'observation');
  id(body.batchId, 'batchId');
  object(body.source ?? {}, 'source');
  const source = { connected: body.source?.connected === true,
    ...(body.source?.serverVersion !== undefined ? { serverVersion: displayText(body.source.serverVersion, 'serverVersion', 100) } : {}),
    ...(body.source?.error !== undefined ? { error: displayText(body.source.error, 'source error', 60) } : {}) };
  const list = (value, name, max) => { requireValue(value === undefined || (Array.isArray(value) && value.length <= max), `${name} must be an array of at most ${max}.`); return value ?? []; };
  const sessions = list(body.sessions, 'sessions', LIMITS.sessions).map(session => {
    object(session, 'session');
    requireValue(STATUSES.includes(session.status), 'Invalid session status.');
    let project;
    if (session.project !== undefined) {
      object(session.project, 'session project');
      project = { name: displayText(session.project.name, 'project name', 200) };
      if (session.project.path !== undefined) { project.path = displayText(session.project.path, 'project path', 200); requireValue(!/[/\\]/.test(project.path), 'Project path is a directory name, not a path.'); }
    }
    const value = { threadId: id(session.threadId, 'threadId', LONG_ID), title: optionalText(session.title, 'title', 500), project,
      branch: optionalText(session.branch, 'branch', 200), worktree: optionalText(session.worktree, 'worktree', 200),
      provider: displayText(session.provider, 'provider', 100), providerInstanceId: id(session.providerInstanceId, 'providerInstanceId'),
      model: optionalText(session.model, 'model', 200), status: session.status,
      parentThreadId: session.parentThreadId === undefined ? undefined : id(session.parentThreadId, 'parentThreadId', LONG_ID),
      createdAt: iso(session.createdAt, 'createdAt'), lastActivityAt: iso(session.lastActivityAt, 'lastActivityAt'), turns: count(session.turns, 'turns') };
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
  });
  requireValue(new Set(sessions.map(session => session.threadId)).size === sessions.length, 'Duplicate sessions.');
  const removed = list(body.removedThreadIds, 'removedThreadIds', LIMITS.removed).map(value => id(value, 'removed threadId', LONG_ID));
  const usage = list(body.usage, 'usage', LIMITS.usage).map(record => {
    object(record, 'usage record');
    return { providerTurnId: id(record.providerTurnId, 'providerTurnId', LONG_ID), threadId: id(record.threadId, 'usage threadId', LONG_ID),
      providerInstanceId: id(record.providerInstanceId, 'usage providerInstanceId'), provider: displayText(record.provider, 'usage provider', 100),
      model: displayText(record.model, 'usage model', 200), inputTokens: count(record.inputTokens, 'inputTokens'), outputTokens: count(record.outputTokens, 'outputTokens'),
      cacheReadTokens: count(record.cacheReadTokens, 'cacheReadTokens'), cacheWriteTokens: count(record.cacheWriteTokens, 'cacheWriteTokens'),
      reasoningTokens: count(record.reasoningTokens, 'reasoningTokens'), at: iso(record.at, 'usage at') };
  });
  const providers = body.providers === undefined ? undefined : list(body.providers, 'providers', LIMITS.providers).map(provider => {
    object(provider, 'provider');
    return { instanceId: id(provider.instanceId, 'instanceId'), driver: displayText(provider.driver, 'driver', 100),
      ...(provider.displayName !== undefined ? { displayName: displayText(provider.displayName, 'displayName', 80) } : {}),
      ...(provider.plan !== undefined ? { plan: displayText(provider.plan, 'plan', 80) } : {}),
      ...(provider.usage !== undefined ? { usage: accountUsage(provider.usage) } : {}) };
  });
  if (providers) requireValue(new Set(providers.map(provider => provider.instanceId)).size === providers.length, 'Duplicate provider instances.');
  let resync;
  if (body.resync !== undefined) { object(body.resync, 'resync'); resync = { id: id(body.resync.id, 'resync id'), final: body.resync.final === true }; }
  return { batchId: body.batchId, source, sessions, removed, usage, providers, resync };
}

function cursorOf(value) {
  if (value === null || value === '') return null;
  let parsed;
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { parsed = null; }
  requireValue(Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && typeof parsed[1] === 'string', 'Invalid cursor.');
  return { at: parsed[0], id: parsed[1] };
}
const encodeCursor = session => Buffer.from(JSON.stringify([session.lastActivityAt, session.id])).toString('base64url');

/**
 * Sessions machines observe in their operators' own T3 Code (read-only), the usage those sessions report, and the
 * provider instances they run on, which become `source: 'observed'` accounts.
 */
export class Sessions {
  constructor(hub) { this.hub = hub; this.store = hub.store; this.pending = new Map(); this.lastChanged = new Map(); }

  ingest(machine, body) {
    const batch = observationBody(body);
    const now = this.hub.now(); const time = this.hub.clock();
    const statusChanges = []; let changed = false;
    // Sessions idle past usage retention are not kept (the sweep would drop them), so resyncs do not churn them.
    const oldest = time - this.hub.config.usageRetentionMs;
    for (const session of batch.sessions) {
      if (Date.parse(session.lastActivityAt) < oldest) { if (this.store.removeObservedSession(machine.id, session.threadId)) changed = true; continue; }
      const previous = this.store.observedSession(machine.id, session.threadId);
      const value = { id: observedSessionId(machine.id, session.threadId), machineId: machine.id, ...session,
        tokens: previous?.tokens ?? emptyTokens(), firstSeenAt: previous?.firstSeenAt ?? now, updatedAt: now };
      if (previous && JSON.stringify({ ...previous, updatedAt: now, tokens: null }) === JSON.stringify({ ...value, tokens: null })) {
        if (batch.resync) this.store.putObservedSession(previous, batch.resync.id);
        continue;
      }
      this.store.putObservedSession(value, batch.resync?.id ?? null);
      changed = true;
      if (!previous || previous.status !== value.status) statusChanges.push({ value, previous: previous?.status });
    }
    for (const threadId of batch.removed) if (this.store.removeObservedSession(machine.id, threadId)) changed = true;
    if (batch.resync?.final && this.store.pruneObservedSessions(machine.id, batch.resync.id)) changed = true;

    // Usage: one ledger row per provider turn; a replay or a resend after a node restart adds nothing.
    const accounts = new Map(this.store.list('account', value => value.machineId === machine.id && value.source === 'observed').map(account => [account.providerInstanceId, account.id]));
    for (const provider of batch.providers ?? []) accounts.set(provider.instanceId, observedAccountId(machine.id, provider.instanceId));
    let accepted = 0;
    for (const record of batch.usage) {
      // Usage older than retention would land straight in the hourly rollups, where it can no longer be deduplicated.
      if (Date.parse(record.at) < oldest) continue;
      const usage = { id: observedUsageId(machine.id, record.providerTurnId), projectId: '', machineId: machine.id, accountId: accounts.get(record.providerInstanceId),
        provider: record.provider, model: record.model, inputTokens: record.inputTokens, outputTokens: record.outputTokens,
        cacheReadTokens: record.cacheReadTokens, cacheWriteTokens: record.cacheWriteTokens, at: record.at };
      if (!this.store.usageOnce(usage)) continue;
      accepted++;
      const session = this.store.observedSession(machine.id, record.threadId);
      if (!session) continue;
      const tokens = session.tokens ?? emptyTokens();
      session.tokens = { input: tokens.input + record.inputTokens, output: tokens.output + record.outputTokens, cacheRead: tokens.cacheRead + record.cacheReadTokens,
        cacheWrite: tokens.cacheWrite + record.cacheWriteTokens, reasoning: tokens.reasoning + record.reasoningTokens };
      this.store.putObservedSession(session); changed = true;
    }

    this.accounts(machine, batch.providers);
    if (statusChanges.length) { this.hub.pacing.dirty = true; this.hub.pacing.refresh(); }
    machine.observe = { connected: batch.source.connected, lastObservedAt: now, ...(batch.source.serverVersion ? { serverVersion: batch.source.serverVersion } : {}),
      ...(batch.source.error ? { error: batch.source.error } : {}) };
    this.store.put('machine', machine);

    for (const { value, previous } of statusChanges.slice(0, 50)) {
      this.hub.emit('session.updated', 'session', value, { machineId: machine.id, threadId: value.threadId, status: value.status, ...(previous ? { previous } : {}) });
    }
    if (changed) this.pending.set(machine.id, { statusChanged: (this.pending.get(machine.id)?.statusChanged ?? false) || statusChanges.length > 0 });
    this.flushEvents();
    return { accepted: true, sessions: batch.sessions.length, usage: accepted, duplicateUsage: batch.usage.length - accepted };
  }

  /**
   * Provider instances become observed accounts, replacing this machine's previous ones; pacing integrates the running
   * session count as agent time and keeps each fresh usage reading as a sample. Owner label and plan edits stay on the
   * hub (`account-override`), since the operator's T3 is never written to.
   */
  accounts(machine, providers) {
    const stored = this.store.list('account', value => value.machineId === machine.id && value.source === 'observed');
    const running = new Map(this.store.observedRunning(machine.id));
    const next = providers === undefined ? stored : providers.map(provider => {
      const accountId = observedAccountId(machine.id, provider.instanceId);
      const override = this.store.get('account-override', accountId);
      const plan = override?.plan === null ? undefined : override?.plan ?? provider.plan;
      return { id: accountId, machineId: machine.id, provider: provider.driver, label: override?.label ?? provider.displayName ?? provider.instanceId,
        status: 'active', source: 'observed', providerInstanceId: provider.instanceId, ...(plan ? { plan } : {}), ...(provider.usage ? { usage: provider.usage } : {}) };
    });
    this.hub.pacing.observe(machine, next, new Map(next.map(account => [account.id, running.get(account.providerInstanceId) ?? 0])));
    if (providers === undefined) return;
    for (const account of stored) if (!next.some(value => value.id === account.id)) this.store.remove('account', account.id);
    for (const account of next) this.store.put('account', account);
    this.hub.pacing.dirty = true;
    this.hub.pacing.refresh({ force: true });
  }

  /** An owner edit of an observed account: kept on the hub and applied to every later observation. */
  override(account, changes) {
    const value = this.store.get('account-override', account.id) ?? { id: account.id, machineId: account.machineId };
    if (changes.label !== undefined) value.label = changes.label;
    if (changes.plan !== undefined) value.plan = changes.plan;
    this.store.put('account-override', value);
  }

  /** Emit coalesced `sessions.changed` events: at once after a status change, else at most once per interval. */
  flushEvents() {
    const time = this.hub.clock();
    for (const [machineId, pending] of this.pending) {
      if (!pending.statusChanged && time - (this.lastChanged.get(machineId) ?? -Infinity) < CHANGED_EVENT_MS) continue;
      const counts = Object.fromEntries(STATUSES.map(status => [status, 0]));
      for (const row of this.store.observedStatusCounts(new Date(0).toISOString())) if (row.machineId === machineId) counts[row.status] = row.count;
      this.hub.emit('sessions.changed', 'machine', { id: machineId }, { machineId, ...counts });
      this.lastChanged.set(machineId, time); this.pending.delete(machineId);
    }
  }

  view(session, machines, children) {
    const { firstSeenAt: _, updatedAt: __, ...rest } = session;
    return { ...rest, machineName: machines.get(session.machineId)?.name ?? null, childCount: children.get(session.machineId)?.get(session.threadId) ?? 0 };
  }

  /** `GET /sessions`: newest activity first, filtered, with an opaque cursor. */
  list(query) {
    const machineId = query.get('machineId') || undefined; const status = query.get('status') || undefined; const provider = query.get('provider') || undefined;
    if (status) requireValue(STATUSES.includes(status), 'status must be running, waiting, idle or error.');
    for (const [name, value] of [['machineId', machineId], ['provider', provider]]) if (value) nonblank(value, name, 200);
    const since = query.get('since') ? iso(query.get('since'), 'since') : undefined;
    const limit = integer(Number(query.get('limit') ?? 100), 'limit', 1, 500);
    const rows = this.store.observedSessionPage({ machineId, status, provider, since, cursor: cursorOf(query.get('cursor')), limit: limit + 1 });
    const page = rows.slice(0, limit);
    const machines = new Map(this.store.list('machine').map(machine => [machine.id, machine]));
    const children = new Map();
    for (const machine of new Set(page.map(session => session.machineId))) children.set(machine, this.store.observedChildCounts(machine, page.filter(session => session.machineId === machine).map(session => session.threadId)));
    return { sessions: page.map(session => this.view(session, machines, children)), ...(rows.length > limit ? { nextCursor: encodeCursor(page.at(-1)) } : {}) };
  }

  /** `GET /sessions/summary`: machines, totals and observed token usage for a window. */
  summary(query) {
    const window = query.get('window') ?? '24h';
    requireValue(Object.hasOwn(WINDOWS, window), 'window must be 1h, 24h or 7d.');
    const time = this.hub.clock(); const from = new Date(time - WINDOWS[window]).toISOString(); const to = this.hub.now();
    const counts = new Map();
    let sessionsActive = 0;
    for (const row of this.store.observedStatusCounts(from)) {
      const value = counts.get(row.machineId) ?? { running: 0, waiting: 0, idle: 0, error: 0 };
      value[row.status] = row.status === 'idle' || row.status === 'error' ? row.recent : row.count;
      counts.set(row.machineId, value); sessionsActive += row.recent;
    }
    const heartbeat = this.hub.config.heartbeatIntervalMs * 3;
    const machineList = this.store.list('machine');
    const machines = machineList.map(machine => {
      const online = machine.status === 'online' && !machine.revokedAt && time - Date.parse(machine.lastHeartbeatAt) < heartbeat;
      const observedAt = machine.observe?.lastObservedAt;
      return { machineId: machine.id, name: machine.name, online, observing: Boolean(machine.observe?.connected && observedAt && time - Date.parse(observedAt) < OBSERVING_MS),
        ...(observedAt ? { lastObservedAt: observedAt } : {}), ...(machine.observe?.error ? { observeError: machine.observe.error } : {}),
        ...(counts.get(machine.id) ?? { running: 0, waiting: 0, idle: 0, error: 0 }) };
    });
    const totals = { running: 0, waiting: 0, sessionsActive };
    for (const value of counts.values()) { totals.running += value.running; totals.waiting += value.waiting; }
    const names = new Map(machineList.map(machine => [machine.id, machine.name]));
    const groups = group => this.store.usageGroups({ source: 'observed' }, { from, to, group });
    const tokens = row => ({ input: row.inputTokens, output: row.outputTokens, cacheRead: row.cacheReadTokens, cacheWrite: row.cacheWriteTokens });
    const hours = new Map(groups('hour').map(row => [row.key, row]));
    const series = [];
    for (let at = Math.floor((time - WINDOWS[window]) / HOUR) * HOUR; at <= time; at += HOUR) {
      const key = new Date(at).toISOString(); const row = hours.get(key);
      series.push({ at: key, input: row?.inputTokens ?? 0, output: row?.outputTokens ?? 0 });
    }
    return { window, machines, totals, tokens: {
      byProvider: groups('provider').map(row => ({ provider: row.key, ...tokens(row) })),
      byModel: groups('model').map(row => ({ model: row.key, ...tokens(row) })),
      byMachine: groups('machine').map(row => ({ machineId: row.key, name: names.get(row.key) ?? null, ...tokens(row) })),
      series } };
  }
}

export function sessionsRoute(hub, method, segments, query, body, auth) {
  if (segments[0] === 'nodes' && segments[1] === 'observations') {
    if (method !== 'POST') return null;
    if (auth.kind !== 'node') fail(403, 'FORBIDDEN', 'A machine token is required.');
    return hub.sessions.ingest(hub.store.need('machine', auth.machineId), body);
  }
  if (segments[0] !== 'sessions' || method !== 'GET' || segments.length > 2) return null;
  if (segments.length === 1) return hub.sessions.list(query);
  if (segments[1] === 'summary') return hub.sessions.summary(query);
  return null;
}
