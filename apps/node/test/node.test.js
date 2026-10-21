import test from 'node:test';
import assert from 'node:assert/strict';
import { stat, readFile, writeFile, chmod, mkdir, rm, readdir } from 'node:fs/promises';
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
  assert.match(hub.heartbeats[0].accounts[0].id, /^mch_test:/);
  assert.deepEqual(Object.keys(hub.heartbeats[0].accounts[0]).sort(), ['id', 'machineId', 'provider', 'status']);
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
  assert.equal(completed(hub)[0].data.outcome, 'failure');
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


test('H5: journal writes recover after a transient failure before running another lease', async t => {
  const hub = await fakeHub(t);
  const { configPath, config } = await nodeConfig(t, hub);
  const node = await startNode(t, configPath);
  const journal = join(config.dataDir, 'leases.json');
  await mkdir(journal);
  hub.assignments.push(assignment('asg_write_failed'));
  await eventually(() => completed(hub).length === 1);
  await rm(journal, { recursive: true });
  hub.assignments.push(assignment('asg_write_recovered'));
  await eventually(() => completed(hub).length === 2);
  assert.equal(completed(hub)[1].data.outcome, 'success');
  assert.equal(JSON.parse(await readFile(journal))['assignment:asg_write_recovered'], 1);
  assert.equal(node.error, undefined);
});

test('M5: heartbeat cancellation aborts immediately and acknowledges the leased attempt once', async t => {
  let cancel = false;
  const hub = await fakeHub(t, { ttl: 5000, heartbeat: () => cancel ? { cancel: { assignments: ['asg_remote_cancel'], jobs: [] } } : {} });
  const { configPath } = await nodeConfig(t, hub, { fake: { delayMs: 10000 }, timing: { heartbeatMs: 20, renewMs: 2000, pollIdleMs: 5 } });
  hub.assignments.push(assignment('asg_remote_cancel'));
  const node = await startNode(t, configPath);
  await eventually(() => hub.events.some(e => e.type === 'started'));
  cancel = true;
  await eventually(() => node.status.running.agents === 0, 500);
  const ack = hub.events.filter(e => e.type === 'cancelled');
  assert.equal(ack.length, 1);
  assert.equal(ack[0].attempt, 1);
  assert.equal(hub.renewals.length, 0);
});

test('M6: executable providers without a registered executor are never advertised', async t => {
  const hub = await fakeHub(t);
  const { configPath, dir } = await nodeConfig(t, hub, { executorPackages: [], fake: undefined });
  await writeFile(join(dir, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = dir;
  t.after(() => { process.env.PATH = previousPath; });
  await startNode(t, configPath, { registry: new ExecutorRegistry() });
  assert.deepEqual(hub.requests.find(r => r.path.endsWith('/enroll')).body.providers, []);
});

test('M6: an unsupported leased provider fails for retry rather than blocking on a human', async t => {
  const hub = await fakeHub(t);
  const { configPath } = await nodeConfig(t, hub, { executorPackages: [] });
  hub.assignments.push(assignment('asg_no_executor', { harness: { provider: 'unavailable', model: 'test' } }));
  await startNode(t, configPath, { registry: new ExecutorRegistry() });
  await eventually(() => completed(hub).length === 1);
  assert.equal(completed(hub)[0].data.outcome, 'failure');
});

test('M7: snapshot failures and account heartbeat 409s preserve running work and recover', async t => {
  let fail = false;
  let conflict = false;
  const hub = await fakeHub(t, { heartbeat: body => conflict && body.accounts ? { statusCode: 409, body: { error: { code: 'CONFLICT' } } } : {} });
  const { configPath } = await nodeConfig(t, hub, { fake: { delayMs: 500 } });
  const accounts = { async list() { if (fail) throw new Error('LOCAL_STORAGE_ERROR'); return [{ id: 'chosen', provider: 'fake', label: 'test', status: 'active' }]; } };
  hub.assignments.push(assignment('asg_snapshot'));
  const node = await startNode(t, configPath, { accountProvider: accounts });
  await eventually(() => hub.events.some(e => e.type === 'started'));
  fail = true;
  await sleep(90);
  assert.equal(node.status.state, 'running');
  conflict = true;
  await sleep(90);
  assert.equal(node.status.state, 'running');
  assert.ok(hub.heartbeats.some(body => !Object.hasOwn(body, 'accounts')));
  fail = false; conflict = false;
  await eventually(() => completed(hub).length === 1);
  assert.equal(completed(hub)[0].data.outcome, 'success');
  assert.match(hub.heartbeats[0].accounts[0].id, /^mch_test:/);
});

test('M7: an unavailable initial account snapshot or initial account conflict does not block startup', async t => {
  const hub = await fakeHub(t, { heartbeat: body => body.accounts ? { statusCode: 409, body: { error: { code: 'CONFLICT' } } } : {} });
  const { configPath } = await nodeConfig(t, hub);
  const node = await startNode(t, configPath, { accountProvider: { async list() { throw new Error('LOCAL_STORAGE_ERROR'); } } });
  assert.equal(node.status.state, 'running');
});

test('M9: incompatible leases are relinquished immediately and heartbeat carries current labels', async t => {
  const hub = await fakeHub(t);
  const { configPath } = await nodeConfig(t, hub, { labels: ['current'] });
  hub.assignments.push(assignment('asg_wrong_labels', { requirements: { labels: ['old'] } }));
  const node = await startNode(t, configPath);
  await eventually(() => completed(hub).length === 1);
  assert.equal(completed(hub)[0].data.outcome, 'failure');
  assert.equal(hub.events.filter(e => e.type === 'started').length, 0);
  assert.deepEqual(hub.heartbeats[0].labels, ['current']);
  assert.equal(node.status.running.agents, 0);
});

test('L6: capacity above the hub per-request limit is leased in bounded batches', async t => {
  const hub = await fakeHub(t);
  const { configPath } = await nodeConfig(t, hub, { capacity: { maxAgents: 1001, maxJobs: 0 } });
  await startNode(t, configPath);
  await eventually(() => hub.requests.some(r => r.path.endsWith('/lease')));
  assert.ok(hub.requests.filter(r => r.path.endsWith('/lease')).every(r => r.body.max <= 1000));
});

test('L10: finished assignment workspaces are removed', async t => {
  const hub = await fakeHub(t);
  const { configPath, config } = await nodeConfig(t, hub);
  hub.assignments.push(assignment('asg_cleanup'));
  const node = await startNode(t, configPath);
  await eventually(() => completed(hub).length === 1 && node.status.running.agents === 0);
  assert.deepEqual(await readdir(join(config.dataDir, 'assignments')), []);
});

test('L14: a reused live PID with a different process start identity does not block recovery', async t => {
  const hub = await fakeHub(t);
  const { configPath, config } = await nodeConfig(t, hub);
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(join(config.dataDir, 'daemon.lock'), JSON.stringify({ pid: process.pid, startedAt: 'previous-process' }), { mode: 0o600 });
  const node = await startNode(t, configPath);
  assert.equal(node.status.state, 'running');
  const lock = JSON.parse(await readFile(join(config.dataDir, 'daemon.lock')));
  assert.equal(lock.pid, process.pid);
  assert.equal(typeof lock.startedAt, 'string');
});


test('M7: a conflicting legacy UUID is scoped before retrying its account snapshot', async t => {
  const id = 'acct_0123456789abcdef0123456789abcdef';
  const hub = await fakeHub(t, { heartbeat: body => body.accounts?.some(a => a.id === id) ? { statusCode: 409, body: { error: { code: 'CONFLICT' } } } : {} });
  const { configPath } = await nodeConfig(t, hub);
  const node = await startNode(t, configPath, { accountProvider: { async list() { return [{ id, provider: 'codex', label: 'shared', status: 'active' }]; } } });
  assert.equal(node.status.state, 'running');
  assert.match(hub.heartbeats.at(-1).accounts[0].id, /^mch_test:/);
});
