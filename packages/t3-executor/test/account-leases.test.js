import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAccountPool } from '@perpeto/accounts';
import { createT3Executor, T3Client } from '../src/index.js';
import { startFakeT3, build } from './fake-t3.js';

async function fixture(t, { leaseMs = 1000 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'executor-lease-'));
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  for (const path of [dataDir, home, workspace]) await mkdir(path, { mode: 0o700 });
  await writeFile(join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'synthetic-test-only' } }), { mode: 0o600 });
  const pool = createAccountPool({ nodeDataDir: dataDir, machineId: 'mch_test', reservationLeaseMs: leaseMs });
  const account = pool.importAccount({ provider: 'codex', label: 'Synthetic', source: { kind: 'provider-home', homePath: home }, idempotencyKey: 'import' });
  const calls = [];
  const assignmentId = ({ assignmentId, attempt }) => `${assignmentId}-${attempt}`;
  const provider = {
    async acquire(input) {
      const selection = pool.select({ provider: input.provider, assignmentId: assignmentId(input), idempotencyKey: `select:${assignmentId(input)}` });
      calls.push(['acquire', input, selection]);
      return selection;
    },
    async renewReservation(input) { calls.push(['renew', input]); return pool.renewReservation({ ...input, assignmentId: assignmentId(input) }); },
    async bindingFor(id, options) { calls.push(['binding', { id, ...options }]); return pool.bindingFor(id, options); },
    async observe(input) { calls.push(['observe', input]); return pool.observe(input); },
    async release(selection, input) {
      calls.push(['release', input, selection]);
      return pool.release({ assignmentId: assignmentId(input), reservationId: input.reservationId, idempotencyKey: `release:${input.reservationId}` });
    },
  };
  const fake = await startFakeT3(); // Includes a ready operator login named "codex".
  const client = new T3Client({ baseUrl: fake.url, token: 'test-token', pingMs: 0 });
  const executor = createT3Executor({ accountProvider: provider,
    config: { url: fake.url, settleMs: 10, pollMs: 5, interruptGraceMs: 200, turnTimeoutMs: 5000 },
    createClient: () => client,
  });
  const controller = new AbortController();
  const ctx = { workspace, signal: controller.signal };
  const assignment = { id: 'asg_lease', attempt: 2, prompt: 'Work.', harness: { provider: 'codex', model: 'gpt-test' } };
  fake.state.onLaunch = launch => fake.emit(launch.threadId, 'run.updated', build.run(launch.threadId, 1, 'running'));
  fake.state.onCommand = command => {
    if (command.type === 'run.interrupt') fake.emit(command.threadId, 'run.updated', build.run(command.threadId, 1, 'interrupted'));
  };
  const complete = () => {
    const [threadId] = fake.state.threads.keys();
    fake.emit(threadId, 'turn-item.updated', build.assistant(threadId, 1, 'Done.'));
    fake.emit(threadId, 'run.updated', build.run(threadId, 1, 'completed'));
  };
  t.after(async () => { await executor.close(); await fake.close(); await rm(root, { recursive: true, force: true }); });
  return { pool, provider, account, calls, fake, client, executor, controller, ctx, assignment, complete };
}

test('renews through a long turn using fresh keys and forwards the reservation token', async t => {
  const f = await fixture(t);
  const renew = f.provider.renewReservation;
  f.provider.renewReservation = async input => {
    const renewed = await renew(input);
    assert.equal(f.pool.reservations()[0].id, input.reservationId);
    assert.throws(() => f.pool.select({ provider: 'codex', assignmentId: 'other', idempotencyKey: `other:${input.idempotencyKey}` }), { code: 'ACCOUNT_POOL_EXHAUSTED' });
    if (f.calls.filter(([kind]) => kind === 'renew').length === 3) {
      const [threadId] = f.fake.state.threads.keys();
      f.fake.emit(threadId, 'turn-item.updated', { id: 'provider-error', runId: build.run(threadId, 1).id, type: 'error', failure: { code: 'provider_error', message: 'Transient failure' } });
      f.complete();
    }
    return renewed;
  };
  const result = await f.executor.run(f.assignment, f.ctx);
  assert.equal(result.outcome, 'success');
  const selection = f.calls.find(([kind]) => kind === 'acquire')[2];
  assert.ok(Date.now() > Date.parse(selection.reservation.expiresAt), 'turn outlasted the initial lease');
  const renewals = f.calls.filter(([kind]) => kind === 'renew').map(([, input]) => input);
  assert.equal(renewals.length, 3);
  assert.equal(new Set(renewals.map(input => input.idempotencyKey)).size, 3);
  for (const [kind, input] of f.calls.filter(([kind]) => ['renew', 'binding', 'observe', 'release'].includes(kind))) {
    assert.equal(input.reservationId, selection.reservation.id, `${kind} receives the fencing token`);
  }
  assert.equal(f.pool.reservations().length, 0);
  assert.equal(f.fake.state.commands.find(item => item.tag === 'orchestration.launchThread').payload.modelSelection.instanceId, `factory_${f.account.id}`);
  await delay(550);
  assert.equal(f.calls.filter(([kind]) => kind === 'renew').length, 3, 'no renewal after release');
});

test('renewal loss interrupts root and child runs before releasing the reservation', async t => {
  const f = await fixture(t);
  f.fake.state.onLaunch = launch => {
    f.fake.emit(launch.threadId, 'run.updated', build.run(launch.threadId, 1, 'running'));
    f.fake.emit(launch.threadId, 'subagent.updated', { id: 'child-task', origin: 'app_owned', childThreadId: 'child', driver: 'codex', status: 'running' });
    f.fake.emit('child', 'run.updated', build.run('child', 1, 'running'));
  };
  f.fake.state.onCommand = command => {
    if (command.type !== 'run.interrupt') return;
    f.fake.emit(command.threadId, 'run.updated', build.run(command.threadId, 1, 'interrupted'));
    const [root] = f.fake.state.threads.keys();
    f.fake.emit(root, 'subagent.updated', { id: 'child-task', origin: 'app_owned', childThreadId: 'child', driver: 'codex', status: 'interrupted' });
  };
  f.provider.renewReservation = async () => { throw Object.assign(new Error('lost'), { code: 'RESERVATION_ENDED' }); };
  const release = f.provider.release;
  f.provider.release = async (...args) => {
    assert.equal(f.fake.commandsOf('run.interrupt').length, 2);
    for (const thread of f.fake.state.threads.values()) assert.equal([...thread.runs.values()][0].status, 'interrupted');
    return release(...args);
  };
  const result = await f.executor.run(f.assignment, f.ctx);
  assert.equal(result.outcome, 'failure');
  assert.match(result.summary, /Account reservation lost.*retry with backoff/is);
  assert.ok(result.threadRef);
  assert.equal(f.pool.reservations().length, 0);
  assert.ok(f.fake.commandsOf('run.interrupt').every(item => item.payload.holdQueue));
});

test('a hung renewal stops work before confirmed expiry and cannot restart after release', async t => {
  const f = await fixture(t, { leaseMs: 300 });
  let resolveRenewal;
  f.provider.renewReservation = () => new Promise(resolve => { resolveRenewal = resolve; });
  const result = await f.executor.run(f.assignment, f.ctx);
  assert.equal(result.outcome, 'failure');
  assert.match(result.summary, /Account reservation lost/);
  assert.equal(f.fake.commandsOf('run.interrupt').length, 1);
  const selected = f.calls.find(([kind]) => kind === 'acquire')[2];
  resolveRenewal({ ...selected.reservation, expiresAt: new Date(Date.now() + 300).toISOString() });
  await delay(200);
  assert.equal(f.calls.filter(([kind]) => kind === 'release').length, 1);
  assert.equal(f.pool.reservations().length, 0);
});

test('exhausted pools fail without registering or launching the operator login', async t => {
  const f = await fixture(t);
  f.pool.select({ provider: 'codex', assignmentId: 'other', idempotencyKey: 'other' });
  const result = await f.executor.run(f.assignment, f.ctx);
  assert.equal(result.outcome, 'failure');
  assert.match(result.summary, /ACCOUNT_POOL_EXHAUSTED.*Retry with backoff/);
  assert.equal(f.fake.state.commands.length, 0);
  assert.equal(f.pool.reservations()[0].assignmentId, 'other');
});

test('external cancellation interrupts, releases once, and stops future renewals', async t => {
  const f = await fixture(t, { leaseMs: 300 });
  f.fake.state.onLaunch = launch => {
    f.fake.emit(launch.threadId, 'run.updated', build.run(launch.threadId, 1, 'running'));
    f.controller.abort(new Error('assignment lease ended'));
  };
  await assert.rejects(f.executor.run(f.assignment, f.ctx), /assignment lease ended/);
  assert.equal(f.fake.commandsOf('run.interrupt').length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === 'release').length, 1);
  assert.equal(f.pool.reservations().length, 0);
  await delay(200);
  assert.equal(f.calls.filter(([kind]) => kind === 'renew').length, 0);
});

test('renewal loss during provider setup prevents launch and releases its token', async t => {
  const f = await fixture(t, { leaseMs: 300 });
  f.fake.state.newInstanceStatus = 'starting';
  f.provider.renewReservation = async () => { throw new Error('renewal failed'); };
  const result = await f.executor.run(f.assignment, f.ctx);
  assert.equal(result.outcome, 'failure');
  assert.match(result.summary, /Account reservation lost/);
  assert.equal(f.fake.state.threads.size, 0);
  assert.equal(f.pool.reservations().length, 0);
});

test('a stale release cannot free the replacement reservation after renewal loss', async t => {
  const f = await fixture(t, { leaseMs: 300 });
  let replacement;
  f.provider.renewReservation = async input => {
    const assignmentId = `${input.assignmentId}-${input.attempt}`;
    f.pool.release({ assignmentId, reservationId: input.reservationId, idempotencyKey: 'end-old' });
    replacement = f.pool.select({ provider: 'codex', assignmentId, idempotencyKey: 'replace' });
    return f.pool.renewReservation({ ...input, assignmentId });
  };
  const result = await f.executor.run(f.assignment, f.ctx);
  assert.equal(result.outcome, 'failure');
  assert.equal(f.fake.commandsOf('run.interrupt').length, 1);
  assert.equal(f.pool.reservations()[0].id, replacement.reservation.id);
  assert.notEqual(f.calls.find(([kind]) => kind === 'release')[1].reservationId, replacement.reservation.id);
});

test('renewal loss before the launch reply still interrupts the turn T3 started', async t => {
  const f = await fixture(t, { leaseMs: 300 });
  const launch = f.client.launchThread.bind(f.client);
  f.client.launchThread = async (input, options) => {
    const result = await launch(input, options);
    await delay(200);
    options.signal.throwIfAborted();
    return result;
  };
  f.provider.renewReservation = async () => { throw new Error('renewal lost'); };
  const result = await f.executor.run(f.assignment, f.ctx);
  assert.equal(result.outcome, 'failure');
  assert.ok(result.threadRef);
  assert.equal(f.fake.commandsOf('run.interrupt').length, 1);
  assert.equal(f.pool.reservations().length, 0);
});
