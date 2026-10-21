import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJob, isEvidenceCurrent, stableHash, checksPass, branchName, pullRequestPolicy, createQueueState, reduceQueue } from '../src/index.js';

const A = 'a'.repeat(40), B = 'b'.repeat(40);
const config = { steps: [{ name: 'test', run: 'node --test', timeoutSec: 30 }], requirements: { os: 'linux', labels: ['x', 'y'] } };
const input = { id: 'job_1', projectId: 'prj_1', repo: { url: '/temporary/repo' }, config, workItem: { id: 'wi_1', runId: 'run_1', headSha: A } };

test('CI Job contract, stable configuration hashing, source immutability', () => {
  const original = structuredClone(input), job = buildJob(input);
  assert.deepEqual(input, original);
  assert.equal(job.revision, A); assert.equal(job.workItemId, 'wi_1'); assert.equal(job.status, 'queued');
  assert.deepEqual(job.artifacts, []); assert.equal(job.attempt, 0);
  assert.equal(job.configHash, buildJob({ ...input, config: { requirements: { labels: ['y', 'x'], os: 'linux' }, steps: config.steps } }).configHash);
  assert.notEqual(job.configHash, buildJob({ ...input, config: { ...config, steps: [{ name: 'test', run: 'different' }] } }).configHash);
  assert.notEqual(job.configHash, buildJob({ ...input, config: { ...config, requirements: { os: 'darwin' } } }).configHash);
  assert.equal(stableHash({ b: 2, a: [1, 2] }), stableHash({ a: [1, 2], b: 2 }));
  assert.notEqual(stableHash([1, 2]), stableHash([2, 1]));
});

test('Evidence requires exact revision and configuration; current failure never passes', () => {
  const job = buildJob(input);
  assert.equal(isEvidenceCurrent({ revision: A, configHash: job.configHash }, job), true);
  assert.equal(isEvidenceCurrent({ revision: B, configHash: job.configHash }, job), false);
  assert.equal(isEvidenceCurrent({ revision: A, configHash: 'old' }, job), false);
  assert.equal(isEvidenceCurrent({}, {}), false);
  job.status = 'failed'; assert.equal(isEvidenceCurrent(job, job), true); assert.equal(checksPass(job, ['test']), false);
  job.status = 'passed'; assert.equal(checksPass(job, ['test']), true); assert.equal(checksPass(job, ['security']), false);
  job.checks = [{ name: 'security', status: 'passed', revision: B, configHash: job.configHash }];
  assert.equal(checksPass(job, ['security']), false);
  job.checks[0].revision = A; assert.equal(checksPass(job, ['security']), true);
  job.checks.push({ name: 'test', status: 'failed', revision: A, configHash: job.configHash });
  assert.equal(checksPass(job, ['test']), false);
});

test('Reject invalid or ambiguous CI input', () => {
  for (const headSha of ['main', '123abc', A.toUpperCase(), undefined]) assert.throws(() => buildJob({ ...input, workItem: { headSha } }), { code: 'INVALID_INPUT' });
  for (const invalid of [{ steps: [] }, { steps: [null] }, { steps: [config.steps[0], config.steps[0]] }, { steps: [{ name: 'x', run: 'x', env: {} }] }, { steps: [{ name: 'x', run: 'x', timeoutSec: 0 }] }, { ...config, requirements: { os: 'plan9' } }]) {
    assert.throws(() => buildJob({ ...input, config: invalid }), { code: 'INVALID_INPUT' });
  }
  assert.throws(() => stableHash({ missing: undefined }), { code: 'INVALID_INPUT' });
});

test('PR policy creates stable valid names and complete review references', () => {
  const workItem = { id: 'wi_1', runId: 'run_1', title: 'Fix ../ spaces & 日本語', body: 'Purpose', url: 'https://example.invalid/work/1' };
  const name = branchName({ workItem });
  assert.match(name, /^perpeto\/run-1\/fix-spaces-[a-f0-9]{12}$/);
  assert.equal(name, branchName({ workItem }));
  assert.notEqual(name, branchName({ workItem: { ...workItem, id: 'wi_2' } }));
  const policy = pullRequestPolicy({ workItem, run: { id: 'run_1', url: 'https://example.invalid/runs/1' }, evidence: [{ label: 'CI', url: 'https://example.invalid/evidence/1' }] });
  assert.equal(policy.branch, name); assert.equal(policy.title, `${workItem.title} (wi_1)`);
  for (const text of ['Work item: [wi_1]', 'Run: [run_1]', 'Purpose', '- [CI]']) assert.ok(policy.body.includes(text));
  assert.throws(() => pullRequestPolicy({ workItem, run: { id: 'run_1', url: 'https://token:secret@example.invalid/' } }), { code: 'INVALID_INPUT' });
});

test('Pure transition does not mutate input and rejects approving absent CI', () => {
  const state = createQueueState({ projectId: 'prj_1', repo: input.repo, baseBranch: 'main', ci: config, strategy: 'serial', method: 'merge', requiredChecks: ['test'] });
  const before = structuredClone(state);
  const enqueued = reduceQueue(state, { type: 'enqueue', entry: { id: 'mq_1', projectId: 'prj_1', prUrl: 'local:feature', headSha: A, baseBranch: 'main', status: 'merged' } });
  assert.deepEqual(state, before); assert.equal(enqueued.entries[0].status, 'queued');
  const started = reduceQueue(enqueued, { type: 'start', attemptId: 'mq_attempt', entryIds: ['mq_1'], baseSha: B });
  assert.throws(() => reduceQueue(started, { type: 'approve', attemptId: 'mq_attempt' }), { code: 'CONFLICT' });
});
