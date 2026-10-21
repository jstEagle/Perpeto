import test from 'node:test';
import assert from 'node:assert/strict';
import { MergeQueueStore, MergeQueue, LocalGitAdapter, DeliveryError, commandRunner } from '../src/index.js';
import { fixture, git } from './helpers.js';

test('Two local PRs: test exact merged results, merge passing PR and reject failed CI', async t => {
  const f = await fixture(t);
  const good = await f.branch('good', { 'good.txt': 'ready' }); const bad = await f.branch('bad', { 'fail.txt': 'break CI' });
  f.enqueue(good); f.enqueue(bad);
  const state = await f.drain();
  assert.deepEqual(state.entries.map(entry => entry.status), ['merged', 'rejected']);
  assert.match(state.entries[1].reason, /CI failed/);
  assert.equal(state.jobs.length, 2);
  assert.notEqual(state.jobs[0].revision, good.headSha);
  assert.equal(await git(f.repository, 'show', 'main:good.txt'), 'ready');
  await assert.rejects(git(f.repository, 'show', 'main:fail.txt'));
  assert.equal(await f.adapter.getBase('main'), state.jobs[0].revision);
});

test('Conflict rejects the conflicting PR, preserving earlier batch work', async t => {
  const f = await fixture(t, { strategy: 'batch' });
  f.enqueue(await f.branch('first', { 'shared.txt': 'first\n' }));
  f.enqueue(await f.branch('conflict', { 'shared.txt': 'second\n' }));
  const state = await f.drain();
  assert.deepEqual(state.entries.map(entry => entry.status), ['merged', 'rejected']);
  assert.match(state.entries[1].reason, /conflict/);
  assert.equal(state.jobs.length, 1);
  assert.equal(await git(f.repository, 'show', 'main:shared.txt'), 'first');
});

test('Base moved after CI: passing evidence becomes obsolete and a new candidate is tested', async t => {
  const f = await fixture(t);
  f.enqueue(await f.branch('feature', { 'feature.txt': 'yes' }));
  await f.step(); await f.step(); const old = f.queue.state.jobs[0]; await f.runCI(old);
  await f.branch('main', { 'base-moved.txt': 'new base' });
  await f.step();
  assert.equal(f.queue.state.active, null); assert.equal(f.queue.state.entries[0].status, 'queued');
  const state = await f.drain();
  assert.equal(state.entries[0].status, 'merged'); assert.equal(state.jobs.length, 2);
  assert.notEqual(state.jobs[1].revision, old.revision);
  assert.equal(await git(f.repository, 'show', 'main:base-moved.txt'), 'new base');
});

test('Batch pass publishes both PRs atomically at one tested revision', async t => {
  const f = await fixture(t, { strategy: 'batch' });
  f.enqueue(await f.branch('a', { 'a.txt': 'a' })); f.enqueue(await f.branch('b', { 'b.txt': 'b' }));
  const state = await f.drain();
  assert.deepEqual(state.entries.map(entry => entry.status), ['merged', 'merged']);
  assert.equal(state.jobs.length, 1); assert.equal(state.entries[0].jobId, state.entries[1].jobId);
  assert.equal(await git(f.repository, 'show', 'main:a.txt'), 'a'); assert.equal(await git(f.repository, 'show', 'main:b.txt'), 'b');
  assert.equal(await f.adapter.getBase('main'), state.jobs[0].revision);
});

test('Failed batch is bisected; good half merges and bad half is rejected after its own CI', async t => {
  const f = await fixture(t, { strategy: 'batch' });
  f.enqueue(await f.branch('a', { 'a.txt': 'a' })); f.enqueue(await f.branch('b', { 'fail.txt': 'b' }));
  const state = await f.drain();
  assert.deepEqual(state.entries.map(entry => entry.status), ['merged', 'rejected']);
  assert.deepEqual(state.jobs.map(job => job.status), ['failed', 'passed', 'failed']);
  assert.equal(await git(f.repository, 'show', 'main:a.txt'), 'a');
});

test('Restart while testing retains candidate, job identity, and idempotent receipts', async t => {
  const f = await fixture(t); const entry = await f.branch('a', { 'a.txt': 'a' });
  const original = f.enqueue(entry);
  await f.step(); await f.step(); const candidate = f.queue.state.jobs[0];
  f.restart();
  assert.deepEqual(f.enqueue(entry), original);
  assert.throws(() => f.enqueue({ ...entry, headSha: 'a'.repeat(40) }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.deepEqual(f.queue.state.jobs[0], candidate);
  const result = await f.runCI(candidate); const receipt = f.queue.state;
  const state = await f.drain();
  assert.equal(state.jobs.length, 1); assert.equal(state.entries[0].status, 'merged');
  assert.deepEqual(f.queue.recordJobResult(result, { idempotencyKey: `result:${result.id}` }), receipt);
});

test('Restart after git publish but before SQLite acknowledgement reconciles without another merge', async t => {
  const f = await fixture(t); f.enqueue(await f.branch('a', { 'a.txt': 'a' }));
  await f.step(); await f.step(); await f.runCI(); await f.step();
  assert.equal(f.queue.state.active.phase, 'merging');
  const adapter = f.adapter; let calls = 0;
  const crash = Object.create(adapter);
  // Bind methods that use private fields to the original adapter.
  for (const name of ['getBase', 'getHead', 'prepare', 'isMerged']) crash[name] = adapter[name].bind(adapter);
  crash.merge = async input => { calls++; await adapter.merge(input); throw new DeliveryError('SIMULATED_CRASH', 'Injected crash.'); };
  f.restart(crash);
  await assert.rejects(f.step(), { code: 'SIMULATED_CRASH' });
  assert.equal(f.queue.state.active.phase, 'merging');
  f.restart(); await f.step();
  assert.equal(f.queue.state.entries[0].status, 'merged'); assert.equal(f.queue.state.jobs.length, 1); assert.equal(calls, 1);
});

test('Stale evidence and missing required checks cannot advance a PR', async t => {
  const f = await fixture(t, { requiredChecks: ['security'] });
  f.enqueue(await f.branch('a', { 'a.txt': 'a' })); await f.step(); await f.step();
  const job = f.queue.state.jobs[0];
  assert.throws(() => f.result({ id: job.id, revision: 'a'.repeat(40), configHash: job.configHash, status: 'passed' }), { code: 'STALE_EVIDENCE' });
  assert.throws(() => f.result({ id: job.id, revision: job.revision, configHash: 'wrong', status: 'passed' }), { code: 'STALE_EVIDENCE' });
  await f.runCI(); await f.step();
  assert.equal(f.queue.state.entries[0].status, 'rejected'); assert.match(f.queue.state.entries[0].reason, /Required checks/);
});

test('Head moved while testing is rejected and its queued job is cancelled', async t => {
  const f = await fixture(t); f.enqueue(await f.branch('a', { 'a.txt': 'a' })); await f.step(); await f.step();
  await f.branch('a', { 'a.txt': 'new' }); await f.step();
  assert.equal(f.queue.state.entries[0].status, 'rejected'); assert.match(f.queue.state.entries[0].reason, /head changed/);
  assert.equal(f.queue.state.jobs[0].status, 'cancelled');
});

for (const method of ['merge', 'squash', 'rebase']) {
  test(`Local adapter prepares and publishes the exact tested revision with ${method}`, async t => {
    const f = await fixture(t, { method }); f.enqueue(await f.branch('a', { 'a.txt': method }));
    const state = await f.drain();
    assert.equal(state.entries[0].status, 'merged'); assert.equal(await f.adapter.getBase('main'), state.jobs[0].revision);
    assert.equal(await git(f.repository, 'show', 'main:a.txt'), method);
    assert.equal(await git(f.repository, 'worktree', 'list', '--porcelain').then(text => (text.match(/^worktree /gm) ?? []).length), 1);
  });
}

test('Atomic git publication rejects a racing base change', async t => {
  const f = await fixture(t); const entry = await f.branch('a', { 'a.txt': 'a' });
  const baseSha = await f.adapter.getBase('main');
  const candidate = await f.adapter.prepare({ baseSha, entries: [entry], method: 'merge', idempotencyKey: 'candidate' });
  assert.deepEqual(await f.adapter.prepare({ baseSha, entries: [entry], method: 'merge', idempotencyKey: 'candidate' }), candidate);
  let raced = false;
  const adapter = new LocalGitAdapter({ repository: f.repository, runner: async (cmd, args, options) => {
    if (args.includes('--stdin') && !raced) { raced = true; await f.branch('main', { 'moved.txt': 'moved' }); }
    return commandRunner(cmd, args, options);
  } });
  assert.equal((await adapter.merge({ baseBranch: 'main', baseSha, revision: candidate.revision, entries: [entry] })).status, 'base_changed');
  assert.equal(await git(f.repository, 'show', 'main:moved.txt'), 'moved');
});

test('Atomic git publication rejects a racing PR head change', async t => {
  const f = await fixture(t); const entry = await f.branch('a', { 'a.txt': 'a' });
  const baseSha = await f.adapter.getBase('main');
  const candidate = await f.adapter.prepare({ baseSha, entries: [entry], method: 'merge', idempotencyKey: 'candidate' });
  const adapter = new LocalGitAdapter({ repository: f.repository, runner: async (cmd, args, options) => {
    if (args.includes('--stdin')) await f.branch('a', { 'a.txt': 'new' });
    return commandRunner(cmd, args, options);
  } });
  assert.equal((await adapter.merge({ baseBranch: 'main', baseSha, revision: candidate.revision, entries: [entry] })).status, 'head_changed');
  assert.equal(await f.adapter.getBase('main'), baseSha);
});

test('SQLite worker lease fences another process and permits recovery after expiry', async t => {
  const f = await fixture(t); const second = new MergeQueueStore(f.filename); t.after(() => second.close());
  const token = f.store.acquire('mq_test', 20);
  await assert.rejects(f.step(), { code: 'BUSY' });
  await new Promise(resolve => setTimeout(resolve, 30));
  const next = second.acquire('mq_test', 1000);
  assert.throws(() => f.store.assertLock('mq_test', token), { code: 'LEASE_LOST' });
  second.release('mq_test', next); await f.step();
});

test('Step retries return original snapshot; queue configuration is immutable on reopen', async t => {
  const f = await fixture(t); f.enqueue(await f.branch('a', { 'a.txt': 'a' }));
  const state = await f.queue.step({ idempotencyKey: 'fixed-step' });
  await f.step(); assert.deepEqual(await f.queue.step({ idempotencyKey: 'fixed-step' }), state);
  assert.throws(() => new MergeQueue({ store: f.store, queueId: 'mq_test', config: { ...f.config, method: 'squash' }, adapter: f.adapter }), { code: 'CONFLICT' });
});

test('Recursive batch bisection and pending groups survive a restart', async t => {
  const f = await fixture(t, { strategy: 'batch' });
  for (const name of ['a', 'b', 'c']) f.enqueue(await f.branch(name, { [`${name}.txt`]: name }));
  f.enqueue(await f.branch('d', { 'fail.txt': 'failure in last quarter' }));
  await f.step(); await f.step(); await f.runCI(); await f.step();
  assert.deepEqual(f.queue.state.groups, [['mq_a', 'mq_b'], ['mq_c', 'mq_d']]);
  f.restart();
  const state = await f.drain();
  assert.deepEqual(state.entries.map(entry => entry.status), ['merged', 'merged', 'merged', 'rejected']);
  assert.deepEqual(state.jobs.map(job => job.status), ['failed', 'passed', 'failed', 'passed', 'failed']);
});

test('Obsolete speculative results cannot finish a newer attempt', async t => {
  const f = await fixture(t); f.enqueue(await f.branch('a', { 'a.txt': 'a' }));
  await f.step(); await f.step(); const old = f.queue.state.jobs[0];
  await f.branch('main', { 'moved.txt': 'moved' }); await f.step();
  assert.equal(f.queue.state.jobs[0].status, 'cancelled');
  await f.step(); await f.step();
  assert.throws(() => f.result({ id: old.id, revision: old.revision, configHash: old.configHash, status: 'passed' }), { code: 'STALE_ATTEMPT' });
  const latest = f.queue.state.jobs[1];
  f.result({ id: latest.id, revision: latest.revision, configHash: latest.configHash, status: 'failed' });
  assert.throws(() => f.result({ id: latest.id, revision: latest.revision, configHash: latest.configHash, status: 'passed' }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('Local mutation refuses a non-bare developer checkout', async t => {
  const f = await fixture(t); const entry = await f.branch('a', { 'a.txt': 'a' });
  const adapter = new LocalGitAdapter({ repository: f.seed });
  await assert.rejects(adapter.prepare({ baseSha: await f.adapter.getBase('main'), entries: [entry], method: 'merge', idempotencyKey: 'invalid' }), { code: 'INVALID_INPUT' });
});

test('Crash after phase transition cannot lose a tick receipt or advance work twice', async t => {
  const f = await fixture(t); f.enqueue(await f.branch('a', { 'a.txt': 'a' }));
  f.store.completeStep = () => { throw new DeliveryError('SIMULATED_CRASH', 'Injected crash.'); };
  await assert.rejects(f.queue.step({ idempotencyKey: 'crashing-tick' }), { code: 'SIMULATED_CRASH' });
  const saved = f.queue.state; assert.equal(saved.active.phase, 'preparing');
  f.restart();
  assert.deepEqual(await f.queue.step({ idempotencyKey: 'crashing-tick' }), saved);
  assert.equal(f.queue.state.active.phase, 'preparing'); assert.equal(f.queue.state.jobs.length, 0);
});
