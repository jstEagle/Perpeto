import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
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

test('Idle and unchanged testing ticks leave no receipts or state history', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.filename); t.after(() => db.close());
  const count = () => db.prepare('SELECT count(*) AS n FROM delivery_receipts').get().n;
  for (let i = 0; i < 20; i++) await f.step();
  assert.equal(count(), 0);
  await f.queue.step({ idempotencyKey: 'idle' });
  f.enqueue(await f.branch('a', { 'a.txt': 'a' }));
  // No-effect tick keys are intentionally unreserved.
  await f.queue.step({ idempotencyKey: 'idle' }); await f.step();
  const before = count();
  const history = db.prepare('SELECT count(*) AS n FROM delivery_revisions').get().n;
  for (let i = 0; i < 20; i++) await f.step();
  assert.equal(count(), before);
  assert.equal(db.prepare('SELECT count(*) AS n FROM delivery_revisions').get().n, history);
});

test('Receipts stay compact while replay returns the exact original state after restart', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.filename); t.after(() => db.close());
  const entry = await f.branch('a', { 'a.txt': 'a' }); const original = f.enqueue(entry);
  for (let i = 0; i < 30; i++) f.enqueue({ ...entry, id: `mq_${i}`, prUrl: `local:other-${i}` });
  await f.step(); await f.step();
  const bytes = db.prepare('SELECT max(length(result)) AS n FROM delivery_receipts').get().n;
  assert.ok(bytes < 256, `Receipt was ${bytes} bytes`);
  const historyBytes = db.prepare('SELECT sum(length(undo)) AS n FROM delivery_revisions').get().n;
  assert.ok(historyBytes < JSON.stringify(f.queue.state).length, `Inverse history was ${historyBytes} bytes`);
  f.restart();
  assert.deepEqual(f.enqueue(entry), original);
  assert.equal(f.queue.state.entries.length, 31);
  assert.throws(() => f.enqueue({ ...entry, headSha: 'a'.repeat(40) }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('Receipt retention bounds count and age while retained receipts still replay', async t => {
  const f = await fixture(t);
  const store = new MergeQueueStore(f.filename, { maxReceipts: 3, receiptRetentionMs: 1000 });
  t.after(() => store.close());
  const queue = new MergeQueue({ store, queueId: 'mq_test', config: f.config, adapter: f.adapter });
  const entry = await f.branch('a', { 'a.txt': 'a' });
  const states = [];
  for (let i = 0; i < 6; i++) states.push(queue.enqueue({ ...entry, id: `mq_${i}`, prUrl: `local:${i}` }, { idempotencyKey: `e:${i}` }));
  const db = new DatabaseSync(f.filename); t.after(() => db.close());
  assert.equal(db.prepare('SELECT count(*) AS n FROM delivery_receipts').get().n, 3);
  assert.equal(store.receipt('mq_test', 'e:0', {}), null);
  assert.deepEqual(queue.enqueue({ ...entry, id: 'mq_3', prUrl: 'local:3' }, { idempotencyKey: 'e:3' }), states[3]);
  db.prepare('UPDATE delivery_receipts SET created_at=?').run(Date.now() - 2000);
  queue.enqueue({ ...entry, id: 'mq_6', prUrl: 'local:6' }, { idempotencyKey: 'e:6' });
  assert.equal(db.prepare('SELECT count(*) AS n FROM delivery_receipts').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM delivery_revisions').get().n, 0);
});

for (const phase of ['queued', 'preparing', 'testing', 'merging']) {
  test(`Permanent rejection during ${phase} releases the attempt and advances surviving batch entries`, async t => {
    const f = await fixture(t, { strategy: 'batch' });
    const bad = await f.branch('bad', { 'bad.txt': 'bad' });
    f.enqueue(bad); f.enqueue(await f.branch('good', { 'good.txt': 'good' }));
    if (phase !== 'queued') await f.step();
    if (['testing', 'merging'].includes(phase)) await f.step();
    if (phase === 'merging') { await f.runCI(); await f.step(); }
    const reason = 'PR branch unavailable after 3 attempts.';
    const result = f.queue.rejectEntry({ entryId: bad.id, reason }, { idempotencyKey: 'reject:bad' });
    assert.equal(result.entries[0].status, 'rejected'); assert.equal(result.entries[0].reason, reason);
    assert.equal(result.active, null);
    assert.ok(result.jobs.every(job => job.status !== 'queued'));
    f.restart(); const state = await f.drain();
    assert.deepEqual(state.entries.map(entry => entry.status), ['rejected', 'merged']);
    assert.deepEqual(f.queue.rejectEntry({ entryId: bad.id, reason }, { idempotencyKey: 'reject:bad' }), result);
    assert.throws(() => f.queue.rejectEntry({ entryId: bad.id, reason: 'different' }, { idempotencyKey: 'reject:bad' }), { code: 'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(git(f.repository, 'show', 'main:bad.txt'));
  });
}

test('Withdrawing the only active entry cancels an unmirrored job and makes future ticks idle', async t => {
  const f = await fixture(t); const entry = await f.branch('a', { 'a.txt': 'a' });
  f.enqueue(entry); await f.step(); await f.step(); const job = f.queue.state.jobs[0];
  const result = f.queue.withdraw({ entryId: entry.id, reason: 'run_stopped' }, { idempotencyKey: 'withdraw:a' });
  assert.equal(result.active, null); assert.equal(result.jobs[0].status, 'cancelled');
  const db = new DatabaseSync(f.filename); t.after(() => db.close());
  const before = db.prepare('SELECT count(*) AS n FROM delivery_receipts').get().n;
  f.restart(); for (let i = 0; i < 20; i++) await f.step();
  assert.equal(db.prepare('SELECT count(*) AS n FROM delivery_receipts').get().n, before);
  assert.throws(() => f.result({ ...job, status: 'passed' }), { code: 'STALE_ATTEMPT' });
});

test('Permanent rejection cannot race a publishing worker or rewrite a merged entry', async t => {
  const f = await fixture(t); const entry = await f.branch('a', { 'a.txt': 'a' }); f.enqueue(entry);
  const token = f.store.acquire('mq_test', 60_000);
  assert.throws(() => f.queue.rejectEntry({ entryId: entry.id, reason: 'failed' }, { idempotencyKey: 'fail' }), { code: 'BUSY' });
  f.store.release('mq_test', token); await f.drain();
  assert.throws(() => f.queue.rejectEntry({ entryId: entry.id, reason: 'failed' }, { idempotencyKey: 'fail' }), { code: 'CONFLICT' });
});

for (const legacy of [false, true]) {
  test(`Publication head race rejects only the changed batch member (legacy adapter: ${legacy})`, async t => {
    const f = await fixture(t, { strategy: 'batch' });
    f.enqueue(await f.branch('a', { 'a.txt': 'a' })); f.enqueue(await f.branch('b', { 'b.txt': 'b' }));
    await f.step(); await f.step(); await f.runCI(); await f.step();
    const adapter = new LocalGitAdapter({ repository: f.repository, runner: async (cmd, args, options) => {
      if (args.includes('--stdin')) await f.branch('b', { 'b.txt': 'changed' });
      return commandRunner(cmd, args, options);
    } });
    if (legacy) {
      const merge = adapter.merge.bind(adapter);
      adapter.merge = async request => { const result = await merge(request); delete result.entryId; return result; };
    }
    f.restart(adapter); await f.step();
    assert.deepEqual(f.queue.state.entries.map(entry => entry.status), ['queued', 'rejected']);
    f.restart();
    assert.deepEqual((await f.drain()).entries.map(entry => entry.status), ['merged', 'rejected']);
    await assert.rejects(git(f.repository, 'show', 'main:b.txt'));
  });
}

for (const defect of ['missing branch', 'unsupported URL']) {
  test(`Host can reject ${defect} after bounded retries and unblock later PRs`, async t => {
    const f = await fixture(t); const bad = await f.branch('bad', { 'bad.txt': 'bad' });
    if (defect === 'unsupported URL') bad.prUrl = 'https://github.com/example/repo/pull/1';
    f.enqueue(bad); f.enqueue(await f.branch('good', { 'good.txt': 'good' }));
    if (defect === 'missing branch') await git(f.repository, 'update-ref', '-d', 'refs/heads/bad');
    await f.step();
    for (let i = 0; i < 3; i++) await assert.rejects(f.step(), { code: defect === 'missing branch' ? 'COMMAND_FAILED' : 'INVALID_INPUT' });
    f.queue.rejectEntry({ entryId: bad.id, reason: `${defect} after 3 attempts` }, { idempotencyKey: 'permanent:bad' });
    assert.deepEqual((await f.drain()).entries.map(entry => entry.status), ['rejected', 'merged']);
  });
}

test('All retained phase and result receipts replay exactly through batch bisection and restart', async t => {
  const f = await fixture(t, { strategy: 'batch' });
  f.enqueue(await f.branch('a', { 'a.txt': 'a' })); f.enqueue(await f.branch('b', { 'fail.txt': 'failure' }));
  const receipts = [];
  for (let i = 0; f.queue.state.entries.some(entry => !['merged', 'rejected'].includes(entry.status)); i++) {
    assert.ok(i < 40);
    const state = f.queue.state;
    if (state.active?.phase === 'testing' && state.jobs.at(-1).status === 'queued') {
      const result = await f.runCI();
      receipts.push({ key: `result:${result.id}`, body: { type: 'result', attemptId: state.active.id, result }, state: f.queue.state });
    } else {
      const key = `history:${i}`;
      receipts.push({ key, body: { type: 'step' }, state: await f.queue.step({ idempotencyKey: key }) });
    }
  }
  f.restart();
  for (const receipt of receipts) assert.deepEqual(f.store.receipt('mq_test', receipt.key, receipt.body), receipt.state);
});

test('Schema 1 snapshot receipts migrate without losing retry responses or current work', async t => {
  const f = await fixture(t); const entry = await f.branch('a', { 'a.txt': 'a' }); const original = f.enqueue(entry);
  await f.step(); await f.step(); const current = f.queue.state;
  const filename = `${f.root}/legacy.sqlite`;
  const db = new DatabaseSync(filename);
  db.exec(`CREATE TABLE delivery_queues (id TEXT PRIMARY KEY,config_hash TEXT NOT NULL,state TEXT NOT NULL) STRICT;
    CREATE TABLE delivery_receipts (queue_id TEXT NOT NULL,key TEXT NOT NULL,body_hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(queue_id,key)) STRICT;
    PRAGMA user_version=1;`);
  const { stableHash } = await import('../src/index.js');
  db.prepare('INSERT INTO delivery_queues VALUES(?,?,?)').run('mq_test', stableHash(current.config), JSON.stringify(current));
  db.prepare('INSERT INTO delivery_receipts VALUES(?,?,?,?)').run('mq_test', 'enqueue:mq_a', stableHash({ type: 'enqueue', entry }), JSON.stringify(original));
  db.close();
  let store = new MergeQueueStore(filename);
  const queue = new MergeQueue({ store, queueId: 'mq_test', config: f.config, adapter: f.adapter });
  assert.deepEqual(queue.state, current); assert.deepEqual(queue.enqueue(entry, { idempotencyKey: 'enqueue:mq_a' }), original);
  queue.withdraw({ entryId: entry.id, reason: 'stopped' }, { idempotencyKey: 'withdraw:a' });
  store.close(); store = new MergeQueueStore(filename); t.after(() => store.close());
  assert.deepEqual(store.receipt('mq_test', 'enqueue:mq_a', { type: 'enqueue', entry }), original);
  assert.equal(store.read('mq_test').active, null);
});

test('Unchanged publication polling writes no history but changed polling states remain durable', async t => {
  const f = await fixture(t); f.enqueue(await f.branch('a', { 'a.txt': 'a' }));
  await f.step(); await f.step(); await f.runCI(); await f.step();
  let publicationState = 'waiting-a';
  f.restart({ atomicMerge: true, merge: async () => ({ status: 'pending', publicationState }) });
  await f.step();
  const db = new DatabaseSync(f.filename); t.after(() => db.close());
  const before = db.prepare('SELECT count(*) AS n FROM delivery_receipts').get().n;
  for (let i = 0; i < 20; i++) await f.step();
  assert.equal(db.prepare('SELECT count(*) AS n FROM delivery_receipts').get().n, before);
  publicationState = 'waiting-b'; await f.step();
  publicationState = 'waiting-a'; await f.step();
  assert.equal(f.queue.state.active.publicationState, 'waiting-a');
});
