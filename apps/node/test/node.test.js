import test from 'node:test';
import assert from 'node:assert/strict';
import { stat, readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createNode, ExecutorRegistry, createFakeExecutor } from '../src/index.js';
import { fakeHub, assignment, nodeConfig, eventually, addCleanup } from './helpers.js';

async function startNode(t, configPath, options = {}) {
  const node = await createNode({ configPath, ...options });
  await node.start();
  addCleanup(t, () => node.stop({ drain: false }));
  return node;
}

const completed = hub => hub.events.filter(event => ['completed', 'failed'].includes(event.type));

test('enrolls once with retry-safe exchange, persists owner-only credentials, and heartbeats sanitized accounts', async t => {
  const hub = await fakeHub(t);
  hub.dropEnrollment = true;
  const { configPath, config } = await nodeConfig(t, hub);
  const runtime = { starts: 0, stops: 0, async start() { this.starts++; return 'http://127.0.0.1:4310'; }, async stop() { this.stops++; } };
  const accountProvider = { async list() { return [{ id: 'acct_test', provider: 'codex', status: 'active', token: 'NEVER_SEND' }]; } };
  const node = await startNode(t, configPath, { runtimeSupervisor: runtime, accountProvider });
  assert.equal(hub.enrollments, 1);
  const credential = join(config.dataDir, 'machine.json');
  assert.equal((await stat(credential)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(credential)).machineId, 'mch_test');
  await eventually(() => hub.heartbeats.length >= 2);
  assert.deepEqual(hub.heartbeats[0].capacity, { maxAgents: 1, maxJobs: 0 });
  assert.deepEqual(hub.heartbeats[0].accounts, [{ id: 'acct_test', provider: 'codex', status: 'active' }]);
  assert.equal(JSON.stringify(hub.requests).includes('NEVER_SEND'), false);
  assert.equal(hub.requests.find(req => req.path.endsWith('/enroll')).body.os, process.platform === 'win32' ? 'windows' : process.platform);
  await node.stop();
  assert.equal(runtime.starts, 1);
  assert.equal(runtime.stops, 1);
  const second = await startNode(t, configPath);
  assert.equal(hub.enrollments, 1);
  await second.stop();
});

test('rejects permissive credential files and concurrent daemon data directories', async t => {
  const hub = await fakeHub(t);
  const { configPath, config } = await nodeConfig(t, hub);
  const first = await startNode(t, configPath);
  const second = await createNode({ configPath });
  await assert.rejects(second.start(), /already in use/);
  await first.stop();
  await chmod(join(config.dataDir, 'machine.json'), 0o644);
  await assert.rejects((await createNode({ configPath })).start(), /credential/);
});

test('honors agent capacity, renews during execution, forwards usage, and never double-runs an attempt', async t => {
  const hub = await fakeHub(t);
  const { configPath } = await nodeConfig(t, hub, { capacity: { maxAgents: 2, maxJobs: 0 }, fake: { delayMs: 110, usage: { inputTokens: 3, outputTokens: 2 } } });
  hub.assignments.push(assignment('asg_1'), assignment('asg_2'), assignment('asg_1'), assignment('asg_3'));
  const states = [];
  await startNode(t, configPath, { onStatus: status => states.push(status) });
  await eventually(() => completed(hub).length === 3);
  assert.equal(Math.max(...states.map(state => state.running.agents)), 2);
  assert.equal(completed(hub).filter(event => event.path.includes('asg_1/')).length, 1);
  assert.ok(hub.renewals.length > 0);
  assert.ok(hub.renewals.every(item => item.body.attempt === 1));
  assert.equal(hub.events.filter(event => event.type === 'usage').length, 3);
  assert.ok(hub.requests.filter(req => req.path.endsWith('/lease')).every(req => req.body.max <= 2 && req.body.kinds.length === 1));
});

test('lease_lost abandons work promptly and suppresses stale final events', async t => {
  const hub = await fakeHub(t);
  const { configPath } = await nodeConfig(t, hub, { fake: { delayMs: 1000 } });
  hub.assignments.push(assignment('asg_lost'));
  const node = await startNode(t, configPath);
  await eventually(() => hub.events.some(event => event.type === 'started'));
  hub.lost = true;
  await eventually(() => node.status.running.agents === 0);
  assert.ok(hub.renewals.length > 0);
  assert.equal(completed(hub).length, 0);
});

test('local lease expiry aborts even when renew endpoint stays unreachable', async t => {
  const hub = await fakeHub(t, { ttl: 120 });
  const { configPath } = await nodeConfig(t, hub, { fake: { delayMs: 1000 } });
  hub.assignments.push(assignment('asg_expired'));
  const node = await startNode(t, configPath);
  await eventually(() => hub.events.some(event => event.type === 'started'));
  hub.renewOutage = true;
  await eventually(() => node.status.running.agents === 0);
  assert.equal(completed(hub).length, 0);
});

test('backs off through a hub outage and resumes leases and heartbeats on recovery', async t => {
  const hub = await fakeHub(t);
  const { configPath } = await nodeConfig(t, hub);
  const node = await startNode(t, configPath);
  hub.outage = true;
  const before = hub.requests.length;
  await sleep(130);
  const retries = hub.requests.length - before;
  assert.ok(retries < 35, `unbounded request loop: ${retries}`);
  hub.assignments.push(assignment('asg_recovered'));
  hub.outage = false;
  await eventually(() => completed(hub).length === 1 && hub.heartbeats.length >= 2);
  assert.equal(node.status.state, 'running');
});

test('drain finishes active work, accepts no further leases, and closes runtime afterward', async t => {
  const hub = await fakeHub(t);
  const { configPath } = await nodeConfig(t, hub, { fake: { delayMs: 90 } });
  hub.assignments.push(assignment('asg_first'), assignment('asg_waiting'));
  const node = await startNode(t, configPath);
  await eventually(() => hub.events.some(event => event.type === 'started'));
  node.drain();
  assert.equal(node.status.state, 'draining');
  await node.stop();
  assert.equal(completed(hub).length, 1);
  assert.equal(hub.assignments.length, 1);
  assert.equal(node.status.state, 'stopped');
});

test('forced shutdown cancels execution and reports a terminal outcome while lease is valid', async t => {
  const hub = await fakeHub(t);
  const { configPath } = await nodeConfig(t, hub, { fake: { delayMs: 1000 } });
  hub.assignments.push(assignment('asg_cancel'));
  const node = await startNode(t, configPath);
  await eventually(() => hub.events.some(event => event.type === 'started'));
  await node.stop({ drain: false });
  assert.equal(completed(hub).length, 1);
  assert.equal(completed(hub)[0].data.outcome, 'blocked');
});

test('restart journal suppresses already-seen attempts but accepts a later attempt', async t => {
  const hub = await fakeHub(t);
  const { configPath } = await nodeConfig(t, hub);
  hub.assignments.push(assignment('asg_restart'));
  const node = await startNode(t, configPath);
  await eventually(() => completed(hub).length === 1);
  await node.stop();
  hub.assignments.push(assignment('asg_restart'), assignment('asg_restart', { attempt: 2 }));
  await startNode(t, configPath);
  await eventually(() => completed(hub).length === 2);
  assert.equal(completed(hub)[1].attempt, 2);
});

test('runtime URL and account provider reach the executor interface', async t => {
  const hub = await fakeHub(t);
  const { configPath } = await nodeConfig(t, hub);
  const accountProvider = { async list() { return []; } };
  let context;
  const registry = new ExecutorRegistry().register({ ...createFakeExecutor(), async run(item, ctx) { context = ctx; return { outcome: 'success', summary: 'done' }; } });
  hub.assignments.push(assignment('asg_ctx'));
  await startNode(t, configPath, { registry, accountProvider, runtimeSupervisor: { async start() { return 'http://127.0.0.1:9999'; }, async stop() {} } });
  await eventually(() => completed(hub).length === 1);
  assert.equal(context.runtimeUrl, 'http://127.0.0.1:9999');
  assert.equal(context.accountProvider, accountProvider);
  assert.ok(context.workspace.includes('assignments'));
});

test('stop interrupts enrollment retry during startup', async t => {
  const hub = await fakeHub(t);
  hub.outage = true;
  const { configPath } = await nodeConfig(t, hub);
  const node = await createNode({ configPath });
  const starting = node.start();
  const rejected = assert.rejects(starting);
  await eventually(() => hub.requests.length > 0);
  await node.stop();
  await rejected;
  assert.equal(node.status.state, 'stopped');
});


test('a lost lease response retries with the same key and runs the leased work once', async t => {
  const hub = await fakeHub(t);
  const { configPath } = await nodeConfig(t, hub);
  hub.assignments.push(assignment('asg_retry'));
  hub.dropLease = true;
  await startNode(t, configPath);
  await eventually(() => completed(hub).length === 1);
  const polls = hub.requests.filter(req => req.path.endsWith('/lease'));
  assert.equal(polls[0].body.idempotencyKey, polls[1].body.idempotencyKey);
  assert.equal(hub.events.filter(event => event.type === 'started').length, 1);
});

test('concurrent stale-lock recovery allows only one daemon to start', async t => {
  const hub = await fakeHub(t);
  const { configPath, config } = await nodeConfig(t, hub);
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(join(config.dataDir, 'daemon.lock'), '2147483647', { mode: 0o600 });
  const first = await createNode({ configPath });
  const second = await createNode({ configPath });
  addCleanup(t, () => first.stop({ drain: false }));
  addCleanup(t, () => second.stop({ drain: false }));
  const results = await Promise.allSettled([first.start(), second.start()]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(hub.enrollments, 1);
});
