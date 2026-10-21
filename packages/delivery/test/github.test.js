import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubAdapter, MergeQueue } from '../src/index.js';
import { fixture } from './helpers.js';

const A = 'a'.repeat(40), B = 'b'.repeat(40);
const prUrl = 'https://github.com/example/fixture/pull/42';
function stub(t, responses) {
  const calls = [];
  t.after(() => assert.equal(responses.length, 0, 'Every expected stubbed command was consumed'));
  return {
    calls,
    runner: async (command, args, options = {}) => {
      assert.equal(command, 'gh', 'The stub never executes any external command');
      calls.push({ args, options });
      assert.ok(responses.length, `Unexpected gh invocation: ${args.join(' ')}`);
      const response = responses.shift();
      return { exitCode: 0, stderr: '', stdout: typeof response === 'string' ? response : JSON.stringify(response) };
    },
  };
}

test('GitHub PR creation uses repo-scoped argv and preserves literal multiline body through stdin', async t => {
  const fake = stub(t, [[], prUrl, { headRefOid: A }]);
  const adapter = new GitHubAdapter({ repository: 'example/fixture', runner: fake.runner });
  const body = 'Work item\n\nLiteral `code` and $(not-a-command)';
  assert.deepEqual(await adapter.createPullRequest({ branch: 'perpeto/feature', baseBranch: 'main', title: 'Implement feature', body }), { prUrl, headSha: A });
  assert.deepEqual(fake.calls[1].args, ['pr', 'create', '--repo', 'example/fixture', '--head', 'perpeto/feature', '--base', 'main', '--title', 'Implement feature', '--body-file', '-']);
  assert.equal(fake.calls[1].options.input, body);
});

test('GitHub PR creation recovers an already-created open PR rather than creating another', async t => {
  const fake = stub(t, [[{ url: prUrl, headRefOid: A }]]);
  const adapter = new GitHubAdapter({ repository: 'example/fixture', runner: fake.runner });
  assert.deepEqual(await adapter.createPullRequest({ branch: 'feature', baseBranch: 'main', title: 'Feature', body: 'Details' }), { prUrl, headSha: A });
  assert.equal(fake.calls.length, 1);
});

test('GitHub check evidence is head-bound and never gains an invented configuration hash', async t => {
  const fake = stub(t, [{ headRefOid: A, statusCheckRollup: [
    { name: 'test', conclusion: 'SUCCESS', detailsUrl: 'https://example.invalid/check' },
    { context: 'lint', state: 'PENDING' }, { name: 'build', conclusion: 'FAILURE' },
    { name: 'skipped', conclusion: 'SKIPPED' }, { name: 'neutral', conclusion: 'NEUTRAL' },
  ] }]);
  const adapter = new GitHubAdapter({ repository: 'example/fixture', runner: fake.runner });
  const checks = await adapter.readChecks({ prUrl });
  assert.deepEqual(checks.map(check => check.status), ['passed', 'pending', 'failed', 'pending', 'pending']);
  assert.ok(checks.every(check => check.revision === A && check.configHash === undefined));
});

for (const method of ['merge', 'squash', 'rebase']) {
  test(`GitHub direct ${method} merge is head-guarded and verifies actual completion`, async t => {
    const fake = stub(t, [{ state: 'OPEN', headRefOid: A }, '', { state: 'MERGED', mergeCommit: { oid: B } }]);
    const adapter = new GitHubAdapter({ repository: 'example/fixture', runner: fake.runner });
    assert.deepEqual(await adapter.mergePullRequest({ prUrl, headSha: A, method }), { status: 'merged', revision: B });
    assert.deepEqual(fake.calls[1].args, ['pr', 'merge', '42', '--repo', 'example/fixture', `--${method}`, '--match-head-commit', A]);
  });
}

test('GitHub direct merge reports pending when branch protection queues the PR', async t => {
  const fake = stub(t, [{ state: 'OPEN', headRefOid: A }, '', { state: 'OPEN', mergeCommit: null }]);
  const adapter = new GitHubAdapter({ repository: 'example/fixture', runner: fake.runner });
  assert.deepEqual(await adapter.mergePullRequest({ prUrl, headSha: A, method: 'merge' }), { status: 'pending' });
});

test('GitHub direct merge retry recognizes prior merge; changed heads cannot merge', async t => {
  const fake = stub(t, [{ state: 'MERGED', headRefOid: A, mergeCommit: { oid: B } }, { state: 'OPEN', headRefOid: B }]);
  const adapter = new GitHubAdapter({ repository: 'example/fixture', runner: fake.runner });
  assert.deepEqual(await adapter.mergePullRequest({ prUrl, headSha: A, method: 'merge' }), { status: 'merged', revision: B });
  await assert.rejects(adapter.mergePullRequest({ prUrl, headSha: A, method: 'merge' }), { code: 'HEAD_CHANGED' });
});

test('GitHub validation rejects unrelated repositories, option injection, malformed data, and leaked command errors', async () => {
  const adapter = new GitHubAdapter({ repository: 'example/fixture', runner: async () => { throw new Error('Runner must not be reached'); } });
  for (const url of ['https://github.com/other/repo/pull/42', 'https://evil.invalid/example/fixture/pull/42', '--help']) {
    await assert.rejects(adapter.getHead({ prUrl: url }), { code: 'INVALID_INPUT' });
  }
  await assert.rejects(adapter.createPullRequest({ branch: '--help', baseBranch: 'main', title: 'x', body: 'x' }), { code: 'INVALID_INPUT' });
  const malformed = new GitHubAdapter({ repository: 'example/fixture', runner: async () => ({ exitCode: 0, stdout: 'invalid JSON' }) });
  await assert.rejects(malformed.getHead({ prUrl }), { code: 'ADAPTER_ERROR' });
  const denied = new GitHubAdapter({ repository: 'example/fixture', runner: async () => ({ exitCode: 1, stderr: 'secret token', stdout: '' }) });
  await assert.rejects(denied.getHead({ prUrl }), error => error.code === 'COMMAND_FAILED' && !JSON.stringify(error.toJSON()).includes('secret'));
});

test('Speculative queue refuses a forge without atomic base/head protection', async t => {
  const f = await fixture(t); f.enqueue(await f.branch('a', { 'a.txt': 'a' }));
  await f.step(); await f.step(); await f.runCI(); await f.step();
  const adapter = Object.create(f.adapter);
  for (const name of ['getBase', 'getHead', 'prepare', 'isMerged']) adapter[name] = f.adapter[name].bind(f.adapter);
  adapter.atomicMerge = false; adapter.merge = () => { throw new Error('Unsafe merge must not be called'); };
  const queue = new MergeQueue({ store: f.store, queueId: 'mq_test', config: f.config, adapter });
  await assert.rejects(queue.step({ idempotencyKey: 'unsafe-publish' }), { code: 'ATOMIC_MERGE_UNSUPPORTED' });
  assert.equal(queue.state.entries[0].status, 'merging');
});
