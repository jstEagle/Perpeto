import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../src/index.js';
import { createStubEngine } from '../src/engine/stub-engine.js';

const START = Date.parse('2026-10-22T08:00:00.000Z');
const at = minutes => new Date(START + minutes * 60_000).toISOString();

async function fixture(t, config = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'perpeto-sessions-'));
  const configPath = join(directory, 'hub.json');
  await writeFile(configPath, JSON.stringify({ port: 0, databasePath: './hub.sqlite', messagingDatabasePath: './messaging.sqlite', ownerTokenPath: './owner.secret',
    longPollMs: 0, maintenanceIntervalMs: 10, ...config }));
  let time = START;
  const engine = createStubEngine();
  const hub = await createHub({ configPath, engine, clock: () => time });
  const baseUrl = await hub.listen();
  const owner = (await readFile(join(directory, 'owner.secret'), 'utf8')).trim();
  t.after(async () => { await hub.close(); await rm(directory, { recursive: true, force: true }); });
  const f = {
    hub, advance(ms) { time += ms; },
    async request(method, path, body, token = owner) {
      const response = await fetch(`${baseUrl}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: response.status === 204 ? null : await response.json() };
    },
    async enroll(name) {
      const code = await f.request('POST', '/machines/enrollment-codes', {});
      const enrolled = await f.request('POST', '/nodes/enroll', { code: code.body.code, name, os: 'darwin', arch: 'arm64', providers: [], labels: [], version: 'test' }, null);
      const machine = enrolled.body;
      // Observe-only: no agent or CI slots.
      await f.request('POST', '/nodes/heartbeat', { status: 'online', capacity: { maxAgents: 0, maxJobs: 0 }, running: { agents: 0, jobs: 0 }, providers: [] }, machine.token);
      return machine;
    },
    observe(machine, batch) { return f.request('POST', '/nodes/observations', { batchId: crypto.randomUUID(), source: { connected: true, serverVersion: '0.1.1-test' }, sessions: [], ...batch }, machine.token); },
  };
  return f;
}

const session = (threadId, extra = {}) => ({ threadId, title: `Thread ${threadId}`, project: { name: 'Perpeto', path: 'perpeto' }, provider: 'claudeAgent', providerInstanceId: 'claudeAgent',
  model: 'claude-opus', status: 'idle', createdAt: at(0), lastActivityAt: at(1), turns: 1, ...extra });
const turn = (providerTurnId, threadId, extra = {}) => ({ providerTurnId, threadId, providerInstanceId: 'claudeAgent', provider: 'claudeAgent', model: 'claude-opus',
  inputTokens: 100, outputTokens: 20, cacheReadTokens: 1000, cacheWriteTokens: 50, reasoningTokens: 5, at: at(2), ...extra });
const claude = (session, weekly, checkedAt = at(0)) => ({ instanceId: 'claudeAgent', driver: 'claudeAgent', displayName: 'Claude', plan: 'Claude Max Subscription',
  usage: { checkedAt, windows: [
    { id: 'five_hour', kind: 'session', label: 'Session', usedPercent: session, resetsAt: at(240), windowMins: 300 },
    { id: 'seven_day', kind: 'weekly', label: 'Weekly', usedPercent: weekly, resetsAt: at(3 * 1440), windowMins: 10080 }] } });

test('observation batches become sessions, deduplicated usage and observed accounts', async t => {
  const f = await fixture(t);
  const mac = await f.enroll('Justus MacBook');
  const mini = await f.enroll('Mac mini');

  // Only machine tokens may post observations.
  assert.equal((await f.request('POST', '/nodes/observations', { batchId: 'x', sessions: [] })).status, 403);

  const batch = { batchId: 'batch-1', source: { connected: true, serverVersion: '0.1.1-test' }, resync: { id: 'r1', final: true },
    sessions: [session('root', { status: 'running', branch: 'feature/x', lastActivityAt: at(3) }), session('child', { parentThreadId: 'root', provider: 'codex', providerInstanceId: 'codex', model: 'gpt-6' }),
      session('waiting', { status: 'waiting', lastActivityAt: at(2) })],
    usage: [turn('turn-1', 'root'), turn('turn-2', 'root', { outputTokens: 30 }), turn('turn-c', 'child', { provider: 'codex', providerInstanceId: 'codex', model: 'gpt-6' })],
    providers: [claude(10, 30)] };
  const first = await f.request('POST', '/nodes/observations', { ...batch, idempotencyKey: 'batch-1' }, mac.token);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { accepted: true, sessions: 3, usage: 3, duplicateUsage: 0 });
  // The same batch again is a replay; the same turns in a new batch add nothing.
  assert.deepEqual((await f.request('POST', '/nodes/observations', { ...batch, idempotencyKey: 'batch-1' }, mac.token)).body, first.body);
  const again = await f.observe(mac, { usage: [turn('turn-1', 'root'), turn('turn-3', 'root')] });
  assert.deepEqual(again.body, { accepted: true, sessions: 0, usage: 1, duplicateUsage: 1 });
  // The same provider turn id on another machine is another turn.
  await f.observe(mini, { sessions: [session('root', { provider: 'codex', providerInstanceId: 'codex', model: 'gpt-6', lastActivityAt: at(0) })], usage: [turn('turn-1', 'root', { provider: 'codex', providerInstanceId: 'codex', model: 'gpt-6' })] });

  const list = await f.request('GET', '/sessions');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.sessions.map(item => [item.machineName, item.threadId, item.status]),
    [['Justus MacBook', 'root', 'running'], ['Justus MacBook', 'waiting', 'waiting'], ['Justus MacBook', 'child', 'idle'], ['Mac mini', 'root', 'idle']]);
  const root = list.body.sessions[0];
  assert.deepEqual(root, { id: root.id, machineId: mac.machineId, threadId: 'root', title: 'Thread root', project: { name: 'Perpeto', path: 'perpeto' }, branch: 'feature/x',
    provider: 'claudeAgent', providerInstanceId: 'claudeAgent', model: 'claude-opus', status: 'running', createdAt: at(0), lastActivityAt: at(3), turns: 1,
    tokens: { input: 300, output: 70, cacheRead: 3000, cacheWrite: 150, reasoning: 15 }, machineName: 'Justus MacBook', childCount: 1 });
  assert.equal(list.body.sessions[2].parentThreadId, 'root');

  // Filters and cursor paging.
  assert.deepEqual((await f.request('GET', '/sessions?status=running')).body.sessions.map(item => item.threadId), ['root']);
  assert.deepEqual((await f.request('GET', `/sessions?machineId=${mini.machineId}`)).body.sessions.map(item => item.provider), ['codex']);
  assert.deepEqual((await f.request('GET', '/sessions?provider=codex')).body.sessions.length, 2);
  assert.deepEqual((await f.request('GET', `/sessions?since=${encodeURIComponent(at(2))}`)).body.sessions.map(item => item.threadId), ['root', 'waiting']);
  const page1 = (await f.request('GET', '/sessions?limit=3')).body;
  const page2 = (await f.request('GET', `/sessions?limit=3&cursor=${page1.nextCursor}`)).body;
  assert.equal(page1.sessions.length, 3); assert.deepEqual(page2.sessions.map(item => item.machineName), ['Mac mini']); assert.equal(page2.nextCursor, undefined);
  assert.equal((await f.request('GET', '/sessions?status=busy')).status, 400);
  assert.equal((await f.request('GET', '/sessions?cursor=nope')).status, 400);

  // Usage ledger: observed rows have no project and appear with source=observed, grouped by machine.
  const usage = (await f.request('GET', '/usage?source=observed&groupBy=machine')).body;
  assert.deepEqual(usage.totals, { inputTokens: 500, outputTokens: 110, cacheReadTokens: 5000, cacheWriteTokens: 250, costUsd: 0, records: 5 });
  assert.deepEqual(usage.groups.map(group => group.key).sort(), [mac.machineId, mini.machineId].sort());
  assert.equal((await f.request('GET', '/usage?source=factory')).body.totals.records, 0);

  // The provider instance is an observed account; heartbeats without it keep it; owner edits stay on the hub.
  let accounts = (await f.request('GET', '/accounts')).body.accounts;
  const account = accounts.find(item => item.source === 'observed');
  assert.deepEqual({ ...account, id: undefined }, { id: undefined, machineId: mac.machineId, provider: 'claudeAgent', label: 'Claude', status: 'active', source: 'observed',
    providerInstanceId: 'claudeAgent', plan: 'Claude Max Subscription', usage: claude(10, 30).usage });
  const beat = await f.request('POST', '/nodes/heartbeat', { status: 'online', capacity: { maxAgents: 0, maxJobs: 0 }, running: { agents: 0, jobs: 0 }, accounts: [] }, mac.token);
  assert.ok((await f.request('GET', '/accounts')).body.accounts.some(item => item.id === account.id));
  assert.equal((await f.request('PATCH', `/accounts/${account.id}`, { label: 'My Claude' })).status, 200);
  const relayed = await f.request('POST', '/nodes/heartbeat', { status: 'online', capacity: { maxAgents: 0, maxJobs: 0 }, running: { agents: 0, jobs: 0 } }, mac.token);
  assert.equal(relayed.body.accountUpdates, undefined, 'nothing is relayed to the operator T3');
  await f.observe(mac, { providers: [claude(12, 30, at(5))] });
  accounts = (await f.request('GET', '/accounts')).body.accounts;
  assert.equal(accounts.find(item => item.id === account.id).label, 'My Claude');
  assert.equal(beat.status, 200);

  // Events: status transitions per session, and coalesced sessions.changed per machine.
  const events = (await f.request('GET', '/events?types=session.updated,sessions.changed&limit=100')).body.events;
  assert.deepEqual(events.filter(event => event.type === 'session.updated' && event.data.machineId === mac.machineId).map(event => event.data.threadId).sort(), ['child', 'root', 'waiting']);
  const changed = events.filter(event => event.type === 'sessions.changed' && event.data.machineId === mac.machineId);
  assert.equal(changed.length, 1, 'token-only batches within the interval are coalesced');
  assert.deepEqual([changed[0].data.running, changed[0].data.waiting, changed[0].data.idle], [1, 1, 1]);
  f.advance(20_000);
  await f.hub.hub.maintenance();
  assert.equal((await f.request('GET', '/events?types=sessions.changed&limit=100')).body.events.filter(event => event.data.machineId === mac.machineId).length, 2);

  // Removal and a final resync prune sessions T3 no longer lists.
  await f.observe(mac, { removedThreadIds: ['waiting'] });
  await f.observe(mac, { resync: { id: 'r2', final: true }, sessions: [session('root', { status: 'idle', lastActivityAt: at(9) })] });
  assert.deepEqual((await f.request('GET', `/sessions?machineId=${mac.machineId}`)).body.sessions.map(item => [item.threadId, item.status, item.tokens.output]), [['root', 'idle', 70]]);

  // Sessions idle past usage retention are not stored.
  assert.equal((await f.observe(mac, { sessions: [session('ancient', { createdAt: '2025-01-01T00:00:00.000Z', lastActivityAt: '2025-01-01T00:00:00.000Z' })] })).body.sessions, 1);
  assert.ok(!(await f.request('GET', '/sessions?limit=500')).body.sessions.some(item => item.threadId === 'ancient'));
  // T3 derives child thread and turn ids from their parents; long ones are accepted whole.
  const long = `${'child:'.repeat(50)}x`;
  assert.equal((await f.observe(mac, { sessions: [session(long, { parentThreadId: long.slice(6) })], usage: [turn(`${long}:turn`, long)] })).status, 200);
  assert.equal((await f.request('GET', `/sessions?machineId=${mac.machineId}&limit=500`)).body.sessions.find(item => item.threadId === long).tokens.output, 20);
  // Validation.
  assert.equal((await f.observe(mac, { sessions: [session('x', { status: 'busy' })] })).status, 400);
  assert.equal((await f.observe(mac, { sessions: [session('x', { project: { name: 'P', path: '/Users/me/p' } })] })).status, 400);
  assert.equal((await f.observe(mac, { sessions: Array.from({ length: 501 }, (_, index) => session(`s${index}`)) })).status, 400);
});

test('summary: machines observing, totals and observed tokens by provider, model, machine and hour', async t => {
  const f = await fixture(t);
  const mac = await f.enroll('mac');
  const quiet = await f.enroll('quiet');
  await f.observe(mac, { sessions: [session('a', { status: 'running', lastActivityAt: at(0) }), session('b', { status: 'waiting', lastActivityAt: at(0) }),
    session('old', { createdAt: '2026-10-01T00:00:00.000Z', lastActivityAt: '2026-10-01T00:00:00.000Z' })],
  usage: [turn('t1', 'a', { at: at(-90) }), turn('t2', 'a', { at: at(-30), provider: 'codex', model: 'gpt-6' })] });
  await f.request('POST', '/nodes/observations', { batchId: 'q', source: { connected: false, error: 'T3_NOT_RUNNING' }, sessions: [] }, quiet.token);
  const summary = (await f.request('GET', '/sessions/summary?window=24h')).body;
  assert.equal(summary.window, '24h');
  assert.deepEqual(summary.machines.map(item => [item.name, item.online, item.observing, item.running, item.waiting, item.idle]), [['mac', true, true, 1, 1, 0], ['quiet', true, false, 0, 0, 0]]);
  assert.equal(summary.machines[1].observeError, 'T3_NOT_RUNNING');
  assert.deepEqual(summary.totals, { running: 1, waiting: 1, sessionsActive: 2 });
  assert.deepEqual(summary.tokens.byProvider, [{ provider: 'claudeAgent', input: 100, output: 20, cacheRead: 1000, cacheWrite: 50 }, { provider: 'codex', input: 100, output: 20, cacheRead: 1000, cacheWrite: 50 }]);
  assert.deepEqual(summary.tokens.byModel.map(item => item.model), ['claude-opus', 'gpt-6']);
  assert.deepEqual(summary.tokens.byMachine.map(item => [item.name, item.output]), [['mac', 40]]);
  assert.equal(summary.tokens.series.length, 25);
  assert.deepEqual(summary.tokens.series.filter(point => point.output).map(point => [point.at, point.output]), [[at(-120), 20], [at(-60), 20]]);
  assert.equal((await f.request('GET', '/sessions/summary?window=1h')).body.tokens.series.length, 2);
  assert.equal((await f.request('GET', '/sessions/summary?window=2d')).status, 400);
  // A machine whose observer stopped reporting stops counting as observing.
  f.advance(120_000);
  await f.request('POST', '/nodes/heartbeat', { status: 'online', capacity: { maxAgents: 0, maxJobs: 0 }, running: { agents: 0, jobs: 0 } }, mac.token);
  assert.equal((await f.request('GET', '/sessions/summary')).body.machines[0].observing, false);
  // Retention follows usageRetentionMs.
  f.advance(31 * 86_400_000);
  assert.ok((await f.hub.hub.store.transaction(() => f.hub.hub.sweep(START + 31 * 86_400_000))).observedSessions >= 3);
});

test('pacing advises on observed subscriptions and learns their burn from running sessions', async t => {
  const f = await fixture(t);
  const mac = await f.enroll('mac');
  await f.observe(mac, { providers: [claude(10, 30)], sessions: [session('a', { status: 'running' }), session('b', { status: 'running' })] });
  let pacing = (await f.request('GET', '/pacing')).body;
  assert.equal(pacing.mode, 'advise');
  assert.deepEqual(pacing.providers, []);
  let account = pacing.accounts.find(item => item.source === 'observed');
  assert.equal(account.advisory, true); assert.equal(account.targetAgents, 0);
  assert.equal(account.runningAgents, 2); assert.equal(account.state, 'burning'); assert.equal(account.idleForecastMins, 0);
  // Two agents at the prior 20 %/agent-hour for 4 h of session: 10 + 160 → capped at 100, over target.
  assert.deepEqual(account.windows.map(window => [window.id, window.projectedPercentAtReset, window.onTrack]), [['five_hour', 100, 'over'], ['seven_day', 100, 'over']]);
  assert.ok(account.windows[0].exhaustsAt);
  // Weekly binds: (95 − 30) / (2.5 × 72 h) ≈ 0.36 agents, so no headroom for more.
  assert.equal(account.sustainableAgents, 0.4); assert.equal(account.headroomAgents, 0);

  // Measured burn: two agents for 30 minutes moved the session window by 6 points → 6 %/agent-hour learned.
  // Batches arrive every few seconds in practice; pacing credits at most ten minutes per step.
  for (let step = 0; step < 5; step++) { f.advance(5 * 60_000); await f.observe(mac, {}); }
  f.advance(5 * 60_000); await f.observe(mac, { providers: [claude(16, 30, at(30))] });
  await f.request('PUT', '/pacing/settings', { targetUsePercent: 95 });
  pacing = (await f.request('GET', '/pacing')).body;
  account = pacing.accounts.find(item => item.source === 'observed');
  assert.equal(account.burnPerAgentHour, 6);
  assert.equal(account.windows[0].learned, true);

  // Nobody running: resting, idle across the horizon, headroom estimated, projections stay where they are.
  await f.observe(mac, { sessions: [session('a', { status: 'idle' }), session('b', { status: 'idle' })] });
  await f.request('PUT', '/pacing/settings', { targetUsePercent: 90 });
  account = (await f.request('GET', '/pacing')).body.accounts.find(item => item.source === 'observed');
  assert.deepEqual([account.state, account.runningAgents, account.idleForecastMins], ['resting', 0, 600]);
  assert.deepEqual(account.windows.map(window => window.onTrack), ['under', 'under']);
  // Observed accounts never cap leases or reach node allowances.
  assert.equal(f.hub.hub.pacing.machineCaps().size, 0);
  assert.equal(f.hub.hub.pacing.allowances(mac.machineId), null);
});
