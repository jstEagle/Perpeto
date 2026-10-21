import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GitHubAdapter, LocalGitAdapter, MergeQueue, createQueueState, stableHash } from '../src/index.js';
import { commandRunner } from '../src/commands.js';
import { fixture, git } from './helpers.js';

const url = number => `https://github.com/example/fixture/pull/${number}`;

// Only git runs for real, exclusively in temporary local fixtures. gh is always
// intercepted, even when an assertion fails. No external forge is contacted.
async function githubFixture(t, config = {}, count = 1) {
  const f = await fixture(t, config);
  const entries = [];
  for (let i = 1; i <= count; i++) {
    const entry = await f.branch(`feature-${i}`, { [`feature-${i}.txt`]: `feature ${i}` });
    entries.push({ ...entry, prUrl: url(i) });
  }
  const mirror = join(f.root, 'mirror.git');
  await git(f.root, 'clone', '--bare', f.repository, mirror);
  const calls = [], states = new Map(entries.map(entry => [entry.prUrl.split('/').at(-1), 'OPEN']));
  const controls = { beforePush: null, protected: false, crashAfterPush: false, failClose: false, lagMergeRecord: false, headOverride: null };
  const runner = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (command === 'git') {
      assert.equal(options.cwd, mirror);
      if (args[0] === 'push') {
        assert.deepEqual(args.slice(0, 2), ['push', 'origin']);
        assert.equal(args.length, 3); // No force, lease, alternate ref or option.
        if (controls.beforePush) { const action = controls.beforePush; controls.beforePush = null; await action(); }
        if (controls.protected) return { exitCode: 1, stdout: '', stderr: 'remote: GH006 protected branch hook declined; secret-do-not-leak' };
        const result = await commandRunner(command, args, options);
        if (controls.crashAfterPush) { controls.crashAfterPush = false; throw new Error('crash after push'); }
        return result;
      }
      return commandRunner(command, args, options);
    }
    assert.equal(command, 'gh');
    assert.equal(args[0], 'pr');
    const number = args[2], entry = entries[Number(number) - 1];
    assert.ok(entry);
    if (args[1] === 'close') {
      if (controls.failClose) { controls.failClose = false; throw new Error('close transport failed'); }
      states.set(number, 'CLOSED');
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    assert.equal(args[1], 'view');
    let state = states.get(number);
    const base = await git(f.repository, 'rev-parse', 'main');
    if (!controls.lagMergeRecord && f.config.method === 'merge' && state === 'OPEN') {
      const contains = await commandRunner('git', ['merge-base', '--is-ancestor', entry.headSha, base], { cwd: f.repository });
      if (!contains.exitCode) state = 'MERGED';
    }
    return { exitCode: 0, stderr: '', stdout: JSON.stringify({ state, headRefOid: controls.headOverride ?? entry.headSha, baseRefName: 'main', mergeCommit: state === 'MERGED' ? { oid: base } : null }) };
  };
  const candidateAdapter = new LocalGitAdapter({ repository: mirror });
  const adapter = new GitHubAdapter({ repository: 'example/fixture', candidateAdapter, runner });
  f.restart(adapter);
  entries.forEach(entry => f.enqueue(entry));
  const stepToMerge = async () => {
    await f.step(); await f.step();
    await f.runCI(undefined, mirror, [{ url: 'https://example.invalid/evidence/candidate' }]); await f.step();
    assert.equal(f.queue.state.active.phase, 'merging');
    return f.queue.state.active.revision;
  };
  return { f, mirror, adapter, entries, calls, states, controls, stepToMerge,
    pushes: () => calls.filter(call => call.command === 'git' && call.args[0] === 'push') };
}

for (const method of ['merge', 'squash', 'rebase']) {
  test(`GitHub ${method} pushes exactly the candidate that passed real CI to local origin`, async t => {
    const g = await githubFixture(t, { method });
    const revision = await g.stepToMerge();
    assert.equal(await git(g.f.repository, 'rev-parse', 'main'), g.f.queue.state.active.baseSha);
    await g.f.step();
    assert.equal(await git(g.f.repository, 'rev-parse', 'main'), revision);
    assert.equal(g.f.queue.state.entries[0].status, 'merged');
    assert.equal(g.f.queue.state.entries[0].mergedRevision, revision);
    assert.equal(g.f.queue.state.entries[0].testedRevision, revision);
    assert.equal(g.pushes().length, 1);
    assert.deepEqual(g.pushes()[0].args, ['push', 'origin', `${revision}:refs/heads/main`]);
    const closes = g.calls.filter(call => call.command === 'gh' && call.args[1] === 'close');
    assert.equal(closes.length, method === 'merge' ? 0 : 1);
    if (closes.length) {
      const comment = closes[0].args.at(-1);
      assert.ok(comment.includes(`https://github.com/example/fixture/commit/${revision}`));
      assert.ok(comment.includes(g.f.queue.state.jobs[0].id));
      assert.ok(comment.includes(g.f.queue.state.jobs[0].configHash));
      assert.ok(comment.includes('https://example.invalid/evidence/candidate'));
      assert.equal(g.states.get('1'), 'CLOSED');
    }
  });
}

test('GitHub fast-forward batch publishes one tested candidate and finalizes every PR', async t => {
  const g = await githubFixture(t, { strategy: 'batch', method: 'squash' }, 2);
  const revision = await g.stepToMerge(); await g.f.step();
  assert.equal(await git(g.f.repository, 'rev-parse', 'main'), revision);
  assert.ok(g.f.queue.state.entries.every(entry => entry.status === 'merged'));
  assert.equal(g.calls.filter(call => call.command === 'gh' && call.args[1] === 'close').length, 2);
});

test('Base changes between final ls-remote and push: non-force origin rejects and queue retests', async t => {
  const g = await githubFixture(t);
  const first = await g.stepToMerge();
  let moved;
  g.controls.beforePush = async () => {
    moved = await g.f.branch('advance', { 'concurrent.txt': 'concurrent' });
    await git(g.f.repository, 'update-ref', 'refs/heads/main', moved.headSha);
  };
  await g.f.step();
  assert.equal(await git(g.f.repository, 'rev-parse', 'main'), moved.headSha);
  assert.equal(g.f.queue.state.active, null);
  assert.equal(g.f.queue.state.entries[0].status, 'queued');
  assert.match(g.f.queue.state.entries[0].reason, /Base changed/);
  await g.f.step();
  // The host synchronizes the mirror before preparing the new base.
  await git(g.mirror, 'fetch', 'origin', 'main');
  await g.f.step();
  assert.notEqual(g.f.queue.state.active.revision, first);
  assert.equal(g.f.queue.state.jobs.length, 2);
  await g.f.runCI(undefined, g.mirror); await g.f.step(); await g.f.step();
  assert.equal(g.f.queue.state.entries[0].status, 'merged');
});

test('Protected-branch rejection is terminal and never leaks remote output', async t => {
  const g = await githubFixture(t); await g.stepToMerge();
  g.controls.protected = true; await g.f.step();
  assert.equal(g.f.queue.state.entries[0].status, 'rejected');
  assert.match(g.f.queue.state.entries[0].reason, /branch protection/);
  assert.ok(!JSON.stringify(g.f.queue.state).includes('secret-do-not-leak'));
  await g.f.step(); assert.equal(g.pushes().length, 1);
});

for (const method of ['merge', 'squash', 'rebase']) {
  test(`Crash after ${method} push before record: restart finalizes once without pushing again`, async t => {
    const g = await githubFixture(t, { method }); const revision = await g.stepToMerge();
    g.controls.crashAfterPush = true;
    await assert.rejects(g.f.step(), /crash after push/);
    assert.equal(await git(g.f.repository, 'rev-parse', 'main'), revision);
    assert.equal(g.f.queue.state.active.phase, 'merging');
    // Prove ancestry recovery even if a later writer advances main before restart.
    await git(g.f.seed, 'fetch', 'origin', 'main');
    const later = await g.f.branch('later', { 'later.txt': 'later' }, 'FETCH_HEAD');
    await git(g.f.repository, 'update-ref', 'refs/heads/main', later.headSha);
    g.f.restart(g.adapter); await g.f.step();
    assert.equal(g.f.queue.state.entries[0].mergedRevision, revision);
    assert.equal(g.pushes().length, 1);
    assert.equal(g.calls.filter(call => call.command === 'gh' && call.args[1] === 'close').length, method === 'merge' ? 0 : 1);
  });
}

test('PR close transport retry resumes published squash without another push or repeated close', async t => {
  const g = await githubFixture(t, { method: 'squash' }); await g.stepToMerge();
  g.controls.failClose = true; await assert.rejects(g.f.step(), /close transport/);
  g.f.restart(g.adapter); await g.f.step(); await g.f.step();
  assert.equal(g.pushes().length, 1);
  assert.equal(g.f.queue.state.entries[0].status, 'merged');
  assert.equal(g.calls.filter(call => call.command === 'gh' && call.args[1] === 'close').length, 2); // failed call plus successful retry
});

test('Merge push waits for GitHub MERGED state and does not repush while GitHub catches up', async t => {
  const g = await githubFixture(t); await g.stepToMerge();
  g.controls.lagMergeRecord = true; await g.f.step();
  assert.equal(g.f.queue.state.active.publicationState, 'awaiting-github-merge-record');
  assert.equal(g.f.queue.state.entries[0].status, 'merging');
  g.controls.lagMergeRecord = false; await g.f.step();
  assert.equal(g.f.queue.state.entries[0].status, 'merged'); assert.equal(g.pushes().length, 1);
});

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const nativeState = (state = 'OPEN', extra = {}) => ({ data: { repository: { pullRequest: {
  state, headRefOid: B, baseRefName: 'main', mergeCommit: state === 'MERGED' ? { oid: C } : null,
  autoMergeRequest: null, mergeQueue: { id: 'MQ_BASE' }, mergeQueueEntry: null, ...extra,
} } } });
function nativeRunner(t, responses) {
  const calls = [];
  t.after(() => assert.equal(responses.length, 0));
  return { calls, runner: async (command, args) => {
    assert.equal(command, 'gh'); calls.push(args);
    assert.ok(responses.length, `Unexpected gh call ${args.join(' ')}`);
    const response = responses.shift();
    return response.exitCode !== undefined ? response : { exitCode: 0, stdout: JSON.stringify(response), stderr: '' };
  } };
}
const nativeRequest = { entries: [{ prUrl: url(1), headSha: B }], baseBranch: 'main', baseSha: A, revision: B,
  method: 'squash', idempotencyKey: 'native-1' };

test('Native queue enqueues only after speculative CI and tracks queued state through restart/base advance', async t => {
  const f = await fixture(t, { publication: 'github-merge-queue' });
  const entry = await f.branch('native', { 'native.txt': 'native' });
  const fake = nativeRunner(t, [
    { data: { repository: { pullRequest: { ...nativeState().data.repository.pullRequest, headRefOid: entry.headSha } } } },
    { exitCode: 0, stdout: '', stderr: '' },
    { data: { repository: { pullRequest: { ...nativeState().data.repository.pullRequest, headRefOid: entry.headSha, mergeQueueEntry: { id: 'MQ_1' } } } } },
    { data: { repository: { pullRequest: { ...nativeState('MERGED').data.repository.pullRequest, headRefOid: entry.headSha } } } },
  ]);
  const adapter = new GitHubAdapter({ repository: 'example/fixture', publication: 'github-merge-queue', candidateAdapter: f.adapter, runner: fake.runner });
  // Reads before publication remain local for this fixture. The native merge API
  // is exercised through the real queue after its candidate CI gate.
  const wrapped = { atomicMerge: true, publication: adapter.publication,
    getBase: f.adapter.getBase.bind(f.adapter), getHead: () => entry.headSha,
    prepare: f.adapter.prepare.bind(f.adapter), merge: adapter.merge.bind(adapter) };
  f.restart(wrapped); f.enqueue({ ...entry, prUrl: url(1) });
  await f.step(); await f.step(); assert.equal(fake.calls.length, 0);
  await f.runCI(); await f.step(); assert.equal(fake.calls.length, 0);
  const tested = f.queue.state.active.revision; await f.step();
  assert.equal(f.queue.state.active.publicationState, 'github-queued');
  assert.deepEqual(fake.calls.find(args => args[0] === 'pr'), ['pr', 'merge', '1', '--repo', 'example/fixture', '--auto', '--match-head-commit', entry.headSha]);
  const later = await f.branch('advance-native', { 'advance.txt': 'advance' });
  await git(f.repository, 'update-ref', 'refs/heads/main', later.headSha);
  f.restart(wrapped); await f.step();
  assert.equal(f.queue.state.entries[0].status, 'merged');
  assert.equal(f.queue.state.entries[0].mergedRevision, C);
  assert.equal(f.queue.state.entries[0].testedRevision, tested);
  assert.equal(fake.calls.filter(args => args[0] === 'pr').length, 1);
});

test('Native mode refuses ordinary auto-merge when branch has no merge-queue rule', async t => {
  const fake = nativeRunner(t, [nativeState('OPEN', { mergeQueue: null })]);
  const adapter = new GitHubAdapter({ repository: 'example/fixture', publication: 'github-merge-queue', runner: fake.runner });
  assert.equal((await adapter.merge(nativeRequest)).status, 'rejected');
  assert.equal(fake.calls.filter(args => args[0] === 'pr').length, 0);
});

test('Native retries recognize an already queued PR without duplicate enqueue', async t => {
  const fake = nativeRunner(t, [nativeState('OPEN', { mergeQueueEntry: { id: 'MQ_1' } })]);
  const adapter = new GitHubAdapter({ repository: 'example/fixture', publication: 'github-merge-queue', runner: fake.runner });
  assert.deepEqual(await adapter.merge(nativeRequest), { status: 'pending', publicationState: 'github-queued' });
  assert.equal(fake.calls.filter(args => args[0] === 'pr').length, 0);
});

test('Native stale heads and closed PRs are terminal; protection submission rejection is explicit', async t => {
  const fake = nativeRunner(t, [nativeState('OPEN', { headRefOid: A }), nativeState('CLOSED'),
    nativeState(), { exitCode: 1, stdout: '', stderr: 'required reviews: private secret' }, nativeState()]);
  const adapter = new GitHubAdapter({ repository: 'example/fixture', publication: 'github-merge-queue', runner: fake.runner });
  assert.equal((await adapter.merge(nativeRequest)).status, 'head_changed');
  assert.equal((await adapter.merge(nativeRequest)).status, 'rejected');
  const denied = await adapter.merge(nativeRequest);
  assert.equal(denied.status, 'rejected'); assert.ok(!denied.reason.includes('private secret'));
});

test('Publication configuration defaults, validates and does not silently batch native PRs', async t => {
  const f = await fixture(t);
  assert.equal(f.queue.state.config.publication, 'fast-forward-push');
  assert.throws(() => createQueueState({ ...f.config, publication: 'force-push' }), { code: 'INVALID_INPUT' });
  assert.throws(() => createQueueState({ ...f.config, publication: 'github-merge-queue', strategy: 'batch' }), { code: 'INVALID_INPUT' });
  assert.throws(() => new GitHubAdapter({ repository: 'example/fixture', publication: 'force-push' }), { code: 'INVALID_INPUT' });
});

test('A changed PR head is rejected before push', async t => {
  const g = await githubFixture(t); await g.stepToMerge();
  g.controls.headOverride = A; await g.f.step();
  assert.equal(g.f.queue.state.entries[0].status, 'rejected');
  assert.match(g.f.queue.state.entries[0].reason, /head changed/);
  assert.equal(g.pushes().length, 0);
});

test('A changed base before publication requeues without attempting a push', async t => {
  const g = await githubFixture(t); await g.stepToMerge();
  const later = await g.f.branch('early-advance', { 'advance.txt': 'advance' });
  await git(g.f.repository, 'update-ref', 'refs/heads/main', later.headSha);
  await g.f.step();
  assert.equal(g.f.queue.state.entries[0].status, 'queued'); assert.equal(g.pushes().length, 0);
});

test('Squash publication rejects a merge-shaped candidate before mutating origin', async t => {
  const g = await githubFixture(t); const revision = await g.stepToMerge();
  await assert.rejects(g.adapter.merge({ ...g.f.queue.state.active, baseBranch: 'main', revision,
    entries: g.entries, method: 'squash', idempotencyKey: 'bad-shape',
    evidence: g.f.queue.state.jobs.at(-1) }), { code: 'INVALID_CANDIDATE' });
  assert.equal(g.pushes().length, 0);
});

test('Candidate based elsewhere is rejected even when it could fast-forward origin', async t => {
  const g = await githubFixture(t); await g.stepToMerge();
  const tree = await git(g.mirror, 'rev-parse', `${g.f.queue.state.active.revision}^{tree}`);
  const baseSha = g.f.queue.state.active.baseSha;
  const identity = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid'];
  const root = await git(g.mirror, ...identity, 'commit-tree', tree, '-m', 'foreign root');
  const invalid = await git(g.mirror, ...identity, 'commit-tree', tree, '-p', root, '-p', baseSha, '-m', 'base only as second parent');
  await assert.rejects(g.adapter.merge({ baseSha, revision: invalid, baseBranch: 'main', entries: g.entries,
    method: 'merge', idempotencyKey: 'invalid-shape' }), { code: 'INVALID_CANDIDATE' });
  assert.equal(g.pushes().length, 0);
});

test('Crash after successful PR closure resumes without a duplicate comment/close', async t => {
  const g = await githubFixture(t, { method: 'rebase' }); await g.stepToMerge();
  const wrapped = { atomicMerge: true, merge: async request => { await g.adapter.merge(request); throw new Error('crash before delivery receipt'); } };
  const crashing = new MergeQueue({ store: g.f.store, queueId: 'mq_test', config: g.f.config, adapter: wrapped });
  await assert.rejects(crashing.step({ idempotencyKey: 'crash-after-close' }), /crash before delivery receipt/);
  assert.equal(g.states.get('1'), 'CLOSED');
  g.f.restart(g.adapter); await g.f.step();
  assert.equal(g.f.queue.state.entries[0].status, 'merged');
  assert.equal(g.pushes().length, 1);
  assert.equal(g.calls.filter(call => call.command === 'gh' && call.args[1] === 'close').length, 1);
});

test('Origin pushurl override cannot bypass expected-old verification', async t => {
  const g = await githubFixture(t); await g.stepToMerge();
  await git(g.mirror, 'remote', 'set-url', '--push', 'origin', g.f.seed);
  await assert.rejects(g.f.step(), { code: 'INVALID_INPUT' });
  assert.equal(g.pushes().length, 0);
});

test('Native queue removal is rejected rather than automatically resubmitted forever', async t => {
  const fake = nativeRunner(t, [nativeState()]);
  const adapter = new GitHubAdapter({ repository: 'example/fixture', publication: 'github-merge-queue', runner: fake.runner });
  const result = await adapter.merge({ ...nativeRequest, publicationState: 'github-queued' });
  assert.equal(result.status, 'rejected'); assert.match(result.reason, /removed/);
  assert.equal(fake.calls.filter(args => args[0] === 'pr').length, 0);
});

test('Native auto-merge waiting is tracked, and node publication overrides adapter default', async t => {
  const fake = nativeRunner(t, [nativeState('OPEN', { autoMergeRequest: { enabledAt: '2026-10-21T00:00:00Z' } })]);
  const adapter = new GitHubAdapter({ repository: 'example/fixture', runner: fake.runner });
  assert.deepEqual(await adapter.merge({ ...nativeRequest, publication: 'github-merge-queue' }),
    { status: 'pending', publicationState: 'github-auto-merge-enabled' });
  assert.equal(fake.calls.filter(args => args[0] === 'pr').length, 0);
});


test('Legacy queue snapshots normalize default publication while preserving attempts and receipts', async t => {
  const f = await fixture(t);
  f.enqueue(await f.branch('legacy', { 'legacy.txt': 'legacy' }));
  const original = await f.step();
  const before = f.queue.state;
  const legacy = structuredClone(before); delete legacy.config.publication;
  const db = new DatabaseSync(f.filename);
  try {
    db.prepare('UPDATE delivery_queues SET config_hash=?,state=? WHERE id=?')
      .run(stableHash(legacy.config), JSON.stringify(legacy), 'mq_test');
  } finally { db.close(); }
  f.restart();
  assert.deepEqual(f.queue.state, before);
  assert.deepEqual(await f.queue.step({ idempotencyKey: 'step:1' }), original);
  assert.equal(f.queue.state.active.id, before.active.id);
});
