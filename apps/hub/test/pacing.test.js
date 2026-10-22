import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../src/index.js';
import { loadConfig, PACING_CONFIG_DEFAULTS } from '../src/config.js';
import { createStubEngine } from '../src/engine/stub-engine.js';

const START = Date.parse('2026-10-22T08:00:00.000Z');
const graph = { schema: 'perpeto.workflow/1', edges: [], nodes: [
  { id: 'in', type: 'input', label: 'Input', position: { x: 0, y: 0 }, config: { source: 'manual' } },
  { id: 'builder', type: 'agent', label: 'Builder', position: { x: 1, y: 0 }, config: { harness: { provider: 'claudeAgent', model: 'claude-test' } } }] };

async function fixture(t, config = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'perpeto-pacing-'));
  const configPath = join(directory, 'hub.json');
  await writeFile(configPath, JSON.stringify({ port: 0, databasePath: './hub.sqlite', messagingDatabasePath: './messaging.sqlite', ownerTokenPath: './owner.secret',
    longPollMs: 0, maintenanceIntervalMs: 10, ...config }));
  let time = START;
  const clock = () => time;
  const engine = createStubEngine();
  let hub = await createHub({ configPath, engine, clock }); let baseUrl = await hub.listen();
  const owner = (await readFile(join(directory, 'owner.secret'), 'utf8')).trim();
  t.after(async () => { await hub.close(); await rm(directory, { recursive: true, force: true }); });
  const f = {
    get hub() { return hub; }, advance(ms) { time += ms; }, now: () => time,
    async restart() { await hub.close(); hub = await createHub({ configPath, engine, clock }); baseUrl = await hub.listen(); },
    async request(method, path, body, token = owner) {
      const response = await fetch(`${baseUrl}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: response.status === 204 ? null : await response.json() };
    },
    async enroll(name, maxAgents = 4) {
      const code = await f.request('POST', '/machines/enrollment-codes', {});
      const enrolled = await f.request('POST', '/nodes/enroll', { code: code.body.code, name, os: 'darwin', arch: 'arm64', providers: ['claudeAgent', 'codex'], labels: [], version: 'test' }, null);
      assert.equal(enrolled.status, 201);
      return { ...enrolled.body, maxAgents };
    },
    heartbeat(machine, accounts, running = 0) {
      return f.request('POST', '/nodes/heartbeat', { status: 'online', capacity: { maxAgents: machine.maxAgents, maxJobs: 1 }, running: { agents: running, jobs: 0 },
        providers: ['claudeAgent', 'codex'], accounts }, machine.token);
    },
    async run() {
      const project = await f.request('POST', '/projects', { name: 'Pacing', repo: { url: '/tmp/repo.git', defaultBranch: 'main' } });
      const workflow = await f.request('POST', `/projects/${project.body.id}/workflows`, { name: 'Build', purpose: 'build', graph });
      await f.request('POST', `/workflows/${workflow.body.id}/activate`, { version: workflow.body.version });
      return (await f.request('POST', `/workflows/${workflow.body.id}/runs`, {})).body;
    },
    async seed(runId, count, provider = 'claudeAgent', prefix = 'asg') {
      const assignments = Array.from({ length: count }, (_, index) => ({ id: `${prefix}_${index}`, nodeId: 'builder', role: 'builder', prompt: 'Build',
        harness: { provider, model: 'test-model' }, policy: { maxSubagents: 0, allowedSubagentProviders: [], canMessage: [] }, requirements: {} }));
      assert.equal((await f.request('POST', `/runs/${runId}/inputs`, { assignments })).status, 202);
    },
    lease(machine, max = 10) { return f.request('POST', '/nodes/lease', { kinds: ['assignment'], max }, machine.token); },
  };
  return f;
}
const at = (base, minutes) => new Date(base + minutes * 60_000).toISOString();
const usage = (checkedAt, session, weekly, sessionReset, weeklyReset) => ({ checkedAt, windows: [
  { id: 'five_hour', kind: 'session', label: '5-hour limit', usedPercent: session, windowMins: 300, ...(sessionReset ? { resetsAt: sessionReset } : {}) },
  { id: 'seven_day', kind: 'weekly', label: 'Weekly limit', usedPercent: weekly, windowMins: 10080, resetsAt: weeklyReset }] });
const claude = (id, extra = {}) => ({ id, provider: 'claudeAgent', label: id, status: 'active', ...extra });

test('heartbeats carry plan and usage; the hub validates, stores samples and serves a pacing plan', async t => {
  const f = await fixture(t, { pacing: { priors: { claudeAgent: { weekly: 0.5 } } } });
  const machine = await f.enroll('studio');
  const weeklyReset = at(START, 4 * 1440);
  const accounts = [claude('acct_a', { plan: 'Claude Max', usage: usage(at(START, 0), 60, 30, at(START, 120), weeklyReset) }),
    claude('acct_b', { usage: usage(at(START, 0), 0, 10, undefined, weeklyReset) })];
  const beat = await f.heartbeat(machine, accounts);
  assert.equal(beat.status, 200);
  const stored = (await f.request('GET', '/accounts')).body.accounts;
  assert.equal(stored[0].plan, 'Claude Max');
  assert.deepEqual(stored[0].usage.windows[0], { id: 'five_hour', kind: 'session', label: '5-hour limit', usedPercent: 60, windowMins: 300, resetsAt: at(START, 120) });
  assert.equal(f.hub.hub.store.accountUsageSamples('acct_a').length, 1);
  // Unchanged readings are not stored again.
  await f.heartbeat(machine, accounts);
  assert.equal(f.hub.hub.store.accountUsageSamples('acct_a').length, 1);

  const run = await f.run(); await f.seed(run.id, 3);
  f.hub.hub.pacing.refresh({ force: true });
  const pacing = (await f.request('GET', '/pacing')).body;
  assert.equal(pacing.enabled, true); assert.equal(pacing.strategy, 'rotation'); assert.equal(pacing.targetUsePercent, 95);
  assert.ok(Number.isFinite(Date.parse(pacing.updatedAt)));
  const [fleet] = pacing.providers;
  assert.equal(fleet.provider, 'claudeAgent'); assert.equal(fleet.readyWork, 3); assert.equal(fleet.slots, 4);
  assert.ok(['weekly', 'session', 'slots', 'work', 'none'].includes(fleet.limitedBy));
  const a = pacing.accounts.find(item => item.accountId === 'acct_a');
  assert.equal(a.state, 'burning'); assert.equal(a.plan, 'Claude Max'); assert.equal(a.machineId, machine.machineId);
  assert.deepEqual(Object.keys(a.windows[0]).sort(), ['id', 'kind', 'label', 'onTrack', 'projectedPercentAtReset', 'resetsAt', 'usedPercent']);
  assert.equal(pacing.accounts.find(item => item.accountId === 'acct_b').state, 'next');
  assert.ok(pacing.timeline.some(item => item.accountId === 'acct_a' && item.phase === 'burn'));
  // The heartbeat response publishes this machine's allowances.
  const response = (await f.heartbeat(machine, accounts)).body;
  assert.deepEqual(response.pacing, { accounts: { acct_a: { targetAgents: a.targetAgents }, acct_b: { targetAgents: 0 } } });

  // Invalid usage is refused (the node then retries without accounts); unknown fields are dropped; nothing secret is kept.
  const invalid = [{ windows: [] }, { checkedAt: at(START, 0), windows: [{ id: 'x', kind: 'daily', label: 'x', usedPercent: 1 }] },
    { checkedAt: at(START, 0), windows: [{ id: 'x', kind: 'session', label: 'x', usedPercent: 101 }] },
    { checkedAt: at(START, 0), windows: [{ id: '../x', kind: 'session', label: 'x', usedPercent: 1 }] }];
  for (const bad of invalid) assert.equal((await f.heartbeat(machine, [claude('acct_a', { usage: bad })])).status, 400);
  assert.equal((await f.heartbeat(machine, [claude('acct_a', { plan: 'a\nb' })])).status, 400);
  await f.heartbeat(machine, [claude('acct_a', { credentials: 'secret-value', usage: { ...usage(at(START, 1), 61, 30, at(START, 120), weeklyReset), email: 'x@example.test' } })]);
  const text = JSON.stringify((await f.request('GET', '/accounts')).body);
  assert.ok(!text.includes('secret-value') && !text.includes('x@example.test'));
});

test('leases are capped per machine at its accounts\' planned agents; unpaced providers and disabled pacing are not capped', async t => {
  const f = await fixture(t, { pacing: { priors: { claudeAgent: { session: 20, weekly: 0.2 } } } });
  const studio = await f.enroll('studio', 6); const linux = await f.enroll('linux', 6);
  const weeklyReset = at(START, 6 * 1440);
  // Studio's account is mid-session; linux's account is fresh, so rotation burns studio's first.
  await f.heartbeat(studio, [claude('acct_studio', { usage: usage(at(START, 0), 20, 5, at(START, 240), weeklyReset) })]);
  await f.heartbeat(linux, [claude('acct_linux', { usage: usage(at(START, 0), 0, 5, undefined, weeklyReset) })]);
  const run = await f.run(); await f.seed(run.id, 8); await f.seed(run.id, 2, 'codex', 'cdx');
  f.hub.hub.pacing.refresh({ force: true });
  const pacing = (await f.request('GET', '/pacing')).body;
  const studioTarget = pacing.accounts.find(item => item.accountId === 'acct_studio').targetAgents;
  const linuxTarget = pacing.accounts.find(item => item.accountId === 'acct_linux').targetAgents;
  assert.ok(studioTarget >= 1);
  const fromLinux = (await f.lease(linux)).body.assignments;
  // Codex has no accounts with usage: it is not paced, so linux still takes codex work.
  assert.deepEqual(fromLinux.filter(item => item.harness.provider === 'claudeAgent').length, linuxTarget);
  assert.equal(fromLinux.filter(item => item.harness.provider === 'codex').length, 2);
  const fromStudio = (await f.lease(studio)).body.assignments;
  assert.equal(fromStudio.length, studioTarget, 'never above the plan');
  assert.equal((await f.lease(studio)).body.assignments.length, 0);

  // Disabling pacing lifts the caps and stops publishing allowances.
  const disabled = await f.request('PUT', '/pacing/settings', { enabled: false, idempotencyKey: 'off' });
  assert.equal(disabled.status, 200); assert.equal(disabled.body.enabled, false);
  const response = (await f.heartbeat(studio, [claude('acct_studio', { usage: usage(at(START, 0), 20, 5, at(START, 240), weeklyReset) })])).body;
  assert.equal(response.pacing, undefined);
  const remaining = 8 - linuxTarget - studioTarget;
  assert.equal((await f.lease(studio)).body.assignments.length, Math.min(remaining, 6 - studioTarget));
});

test('pacing settings validate, are idempotent, persist across restart and emit pacing events', async t => {
  const f = await fixture(t, { pacing: { strategy: 'parallel', targetUsePercent: 90 } });
  assert.equal(loadConfig(join(f.hub.hub.config.databasePath, '..', 'hub.json')).pacing.handoverMins, 15, 'partial config keeps defaults');
  const example = JSON.parse(await readFile(new URL('../../../config/hub.example.json', import.meta.url), 'utf8'));
  assert.deepEqual(example.pacing, JSON.parse(JSON.stringify(PACING_CONFIG_DEFAULTS)), 'example config matches hub defaults');
  let view = (await f.request('GET', '/pacing')).body;
  assert.deepEqual({ enabled: view.enabled, strategy: view.strategy, targetUsePercent: view.targetUsePercent, minAgents: view.minAgents, maxAgents: view.maxAgents },
    { enabled: true, strategy: 'parallel', targetUsePercent: 90, minAgents: 0, maxAgents: null });
  for (const bad of [{ targetUsePercent: 49 }, { targetUsePercent: 101 }, { strategy: 'greedy' }, { enabled: 'yes' }, { minAgents: -1 }, { maxAgents: 1.5 },
    { minAgents: 5, maxAgents: 2 }, { handoverMins: 5 }, { priors: {} }]) {
    assert.equal((await f.request('PUT', '/pacing/settings', bad)).status, 400, JSON.stringify(bad));
  }
  const body = { strategy: 'rotation', targetUsePercent: 97, maxAgents: 12, idempotencyKey: 'set-1' };
  const first = await f.request('PUT', '/pacing/settings', body);
  assert.equal(first.status, 200);
  assert.deepEqual((await f.request('PUT', '/pacing/settings', body)).body, first.body);
  assert.equal((await f.request('PUT', '/pacing/settings', { ...body, targetUsePercent: 80 })).status, 409);
  await f.restart();
  view = (await f.request('GET', '/pacing')).body;
  assert.deepEqual([view.strategy, view.targetUsePercent, view.maxAgents], ['rotation', 97, 12]);
  assert.equal((await f.request('PUT', '/pacing/settings', { maxAgents: null })).body.maxAgents, null);
  const events = (await f.request('GET', '/events?types=pacing.updated,pacing.settings-updated')).body.events;
  assert.ok(events.some(event => event.type === 'pacing.settings-updated' && event.data.targetUsePercent === 97));
  assert.ok(events.some(event => event.type === 'pacing.updated'));

  // A material change (a new account with usage) emits pacing.updated; an unchanged recompute does not.
  const machine = await f.enroll('studio');
  const count = async () => (await f.request('GET', '/events?types=pacing.updated')).body.events.length;
  const before = await count();
  await f.heartbeat(machine, [claude('acct_a', { usage: usage(at(START, 0), 10, 10, at(START, 100), at(START, 5000)) })]);
  f.hub.hub.pacing.refresh({ force: true });
  const after = await count();
  assert.equal(after, before + 1);
  f.hub.hub.pacing.refresh({ force: true });
  assert.equal(await count(), after);
  // Node tokens cannot read or change pacing.
  assert.equal((await f.request('GET', '/pacing', undefined, machine.token)).status, 403);
  assert.equal((await f.request('PUT', '/pacing/settings', { enabled: false }, machine.token)).status, 403);
});

test('PATCH /accounts relays label and plan to the owning node until its snapshot agrees', async t => {
  const f = await fixture(t);
  const machine = await f.enroll('studio');
  await f.heartbeat(machine, [claude('acct_a', { plan: 'Claude Pro' })]);
  for (const bad of [{}, { label: '' }, { plan: 'x'.repeat(81) }, { label: 'a\u0007b' }, { other: 1 }]) {
    assert.equal((await f.request('PATCH', '/accounts/acct_a', bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await f.request('PATCH', '/accounts/acct_missing', { label: 'x' })).status, 404);
  const patched = await f.request('PATCH', '/accounts/acct_a', { label: 'Rotation A', plan: 'Claude Max 20x', idempotencyKey: 'patch-1' });
  assert.equal(patched.status, 200); assert.equal(patched.body.label, 'Rotation A'); assert.equal(patched.body.plan, 'Claude Max 20x');
  // The node's next heartbeat still has the old values: the hub keeps showing the edit and relays it.
  const relay = (await f.heartbeat(machine, [claude('acct_a', { plan: 'Claude Pro' })])).body;
  assert.match(relay.accountUpdates[0].id, /^aup_[a-f0-9]{32}$/);
  assert.deepEqual(relay.accountUpdates.map(({ id, ...rest }) => rest), [{ accountId: 'acct_a', label: 'Rotation A', plan: 'Claude Max 20x' }]);
  assert.equal((await f.request('GET', '/accounts')).body.accounts[0].label, 'Rotation A');
  // Once applied, the relay stops.
  const applied = (await f.heartbeat(machine, [claude('acct_a', { label: 'Rotation A', plan: 'Claude Max 20x' })])).body;
  assert.equal(applied.accountUpdates, undefined);
  // Clearing the operator plan relays null once, then the node's detected plan shows again.
  await f.request('PATCH', '/accounts/acct_a', { plan: null });
  const clearing = (await f.heartbeat(machine, [claude('acct_a', { label: 'Rotation A', plan: 'Claude Max 20x' })])).body.accountUpdates;
  assert.notEqual(clearing[0].id, relay.accountUpdates[0].id);
  assert.deepEqual(clearing.map(({ id, ...rest }) => rest), [{ accountId: 'acct_a', plan: null }]);
  assert.equal((await f.request('GET', '/accounts')).body.accounts[0].plan, undefined);
  const done = (await f.heartbeat(machine, [claude('acct_a', { label: 'Rotation A', plan: 'Claude Pro' })])).body;
  assert.equal(done.accountUpdates, undefined);
  assert.equal((await f.request('GET', '/accounts')).body.accounts[0].plan, 'Claude Pro');
  const events = (await f.request('GET', '/events?types=account.updated')).body.events;
  assert.equal(events.length, 2);
});

test('agents bound to an account count toward it and fresh readings teach the burn rate', async t => {
  // A low session prior lets one account sustain several agents, so both assignments lease.
  const f = await fixture(t, { leaseDurationMs: 600000, pacing: { priors: { claudeAgent: { session: 5, weekly: 0.1 } } } });
  const machine = await f.enroll('studio');
  const weeklyReset = at(START, 5000); const sessionReset = at(START, 280);
  await f.heartbeat(machine, [claude('acct_a', { usage: usage(at(START, 0), 10, 10, sessionReset, weeklyReset) })]);
  const run = await f.run(); await f.seed(run.id, 2);
  f.hub.hub.pacing.refresh({ force: true });
  const leased = (await f.lease(machine)).body.assignments;
  assert.equal(leased.length, 2);
  for (const assignment of leased) {
    const bound = await f.request('POST', `/assignments/${assignment.id}/events`, { type: 'progress', attempt: assignment.attempt,
      data: { interaction: 'account.bound', accountId: 'acct_a', provider: 'claudeAgent' } }, machine.token);
    assert.equal(bound.status, 200);
  }
  assert.equal((await f.request('GET', `/assignments/${leased[0].id}`)).body.accountId, 'acct_a');
  // An account of another machine is never attached.
  const other = await f.enroll('other');
  await f.heartbeat(other, [claude('acct_other')]);
  // Two agents for 30 minutes, renewing leases, then a reading 20 points higher: 20 % per agent-hour.
  for (let minute = 0; minute < 30; minute += 5) {
    f.advance(5 * 60_000);
    for (const assignment of leased) await f.request('POST', `/assignments/${assignment.id}/renew`, { attempt: assignment.attempt }, machine.token);
    await f.heartbeat(machine, [claude('acct_a', { usage: usage(at(START, 0), 10, 10, sessionReset, weeklyReset) })], 2);
  }
  await f.heartbeat(machine, [claude('acct_a', { usage: usage(at(START, 30), 30, 11, sessionReset, weeklyReset) })], 2);
  f.hub.hub.pacing.refresh({ force: true });
  const account = (await f.request('GET', '/pacing')).body.accounts.find(item => item.accountId === 'acct_a');
  assert.equal(account.runningAgents, 2);
  assert.equal(account.burnPerAgentHour, 20);
  assert.equal(f.hub.hub.store.accountUsageSamples('acct_a').length, 2);
});

test('a starved fleet raises an under-burning bottleneck and nudges an idle scheduled run once', async t => {
  const f = await fixture(t);
  const machine = await f.enroll('studio', 6);
  await f.heartbeat(machine, [1, 2, 3].map(n => claude(`acct_${n}`, { usage: usage(at(START, 0), 0, 0, undefined, at(START, 6000)) })));
  const run = await f.run();
  f.hub.hub.pacing.refresh({ force: true });
  const [fleet] = (await f.request('GET', '/pacing')).body.providers;
  assert.equal(fleet.starved, true); assert.equal(fleet.limitedBy, 'work'); assert.equal(fleet.targetAgents, 0); assert.ok(fleet.sustainableAgents > 0);
  const metrics = (await f.request('GET', `/runs/${run.id}/metrics`)).body;
  const finding = metrics.bottlenecks.find(item => item.reason === 'under-burning');
  assert.equal(finding.nodeId, 'in'); assert.equal(finding.severity, 'warning'); assert.match(finding.evidence, /claudeAgent: 0 ready agent items/);
  const project = (await f.request('GET', `/projects/${run.projectId}/metrics`)).body;
  assert.equal(project.bottlenecks.find(item => item.reason === 'under-burning').runId, run.id);

  // A keep-open run with scheduled intake is nudged; the stub engine ignores the input but the request is recorded once.
  const store = f.hub.hub.store;
  const scheduled = { ...store.get('run', run.id), keepOpen: true };
  store.put('run', scheduled);
  const workflow = store.get('run-workflow', run.id);
  workflow.workflow.graph.nodes[0].config.source = 'schedule';
  store.put('run-workflow', workflow);
  await store.transaction(() => f.hub.hub.pacing.nudge());
  await store.transaction(() => f.hub.hub.pacing.nudge());
  const nudges = (await f.request('GET', '/events?types=pacing.nudged')).body.events;
  assert.equal(nudges.length, 1); assert.deepEqual(nudges[0].data, { provider: 'claudeAgent', nodeId: 'in' });
});
