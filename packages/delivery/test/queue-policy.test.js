import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MergeQueue, MergeQueueStore, createQueueState, reduceQueue, selectEntries, queuedOrder, stableHash,
  normalizeMergeQueueConfig, mergeQueueConfigs, queueForBranch, queuePolicy, matchBranch, parseCron, freezeAt, laneFor, queueMetrics, median,
} from '../src/index.js';
import { fixture, git } from './helpers.js';

const sha = text => createHash('sha1').update(text).digest('hex');
const ci = { steps: [{ name: 'test', run: 'npm test' }] };
const MINUTE = 60000;
const T0 = Date.parse('2026-10-23T09:00:00Z'); // a Friday

/** Deterministic in-memory forge: candidates are hashes of their parent and heads; publication is base CAS. */
function memoryForge() {
  const forge = {
    base: sha('base'), heads: new Map(), conflicts: new Set(), prepared: [], published: [],
    atomicMerge: true,
    async getBase() { return forge.base; },
    async getHead(entry) { return forge.heads.get(entry.id) ?? entry.headSha; },
    async prepare({ baseSha, entries }) {
      forge.prepared.push({ baseSha, ids: entries.map(entry => entry.id) });
      const conflict = entries.find(entry => forge.conflicts.has(entry.id));
      if (conflict) { const error = new Error('conflict'); error.code = 'MERGE_CONFLICT'; error.entryId = conflict.id; throw error; }
      return { revision: sha(`${baseSha}:${entries.map(entry => entry.headSha).join(',')}`) };
    },
    async isMerged() { return false; },
    async merge({ baseSha, revision }) {
      if (forge.base !== baseSha) return { status: 'base_changed' };
      forge.base = revision; forge.published.push(revision);
      return { status: 'merged', revision };
    },
  };
  return forge;
}

async function harness(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'perpeto-queue-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = { now: T0 };
  const forge = memoryForge();
  const config = { projectId: 'prj_policy', repo: { url: '/fixture.git' }, baseBranch: 'main', strategy: 'serial', method: 'squash', requiredChecks: ['test'], ci, ...overrides };
  const store = new MergeQueueStore(join(root, 'queue.sqlite'));
  t.after(() => store.close());
  const queue = new MergeQueue({ store, queueId: 'mq_policy', config, adapter: forge, clock: () => clock.now });
  let tick = 0;
  const h = {
    clock, forge, store, queue, config,
    enqueue(id, extra = {}) {
      return queue.enqueue({ id, projectId: 'prj_policy', prUrl: `local:${id}`, headSha: sha(id), baseBranch: 'main', ...extra }, { idempotencyKey: `enqueue:${id}` });
    },
    step() { return queue.step({ idempotencyKey: `tick:${++tick}` }); },
    /** Answer every queued job with `verdict(job, state)` ('passed'/'failed'), advancing the clock per step. */
    async drain(verdict = () => 'passed', { limit = 200, advance = MINUTE } = {}) {
      for (let index = 0; index < limit; index++) {
        clock.now += advance;
        const state = queue.state;
        for (const job of state.jobs.filter(job => job.status === 'queued')) {
          const status = verdict(job, state);
          if (status) queue.recordJobResult({ id: job.id, revision: job.revision, configHash: job.configHash, status }, { idempotencyKey: `result:${job.id}` });
        }
        const before = JSON.stringify(queue.state);
        await h.step();
        if (JSON.stringify(queue.state) === before && !queue.state.jobs.some(job => job.status === 'queued')) return queue.state;
      }
      return queue.state;
    },
  };
  return h;
}
const statuses = state => Object.fromEntries(state.entries.map(entry => [entry.id, entry.status]));
const failingIds = ids => (job, state) => state.entries.some(entry => entry.jobId === job.id && ids.includes(entry.id)) ? 'failed' : 'passed';

const lanes = [
  { name: 'hotfix', priority: 100, labels: ['hotfix'], branches: ['hotfix/*'] },
  { name: 'normal', priority: 50 },
  { name: 'dependencies', priority: 10, labels: ['dependencies'], branches: ['deps/**', 'dependabot/**'] },
];

test('configuration validates every field with JSON paths and fills defaults', () => {
  const valid = normalizeMergeQueueConfig({ version: 1, queues: [
    { name: 'main', strategy: 'batch', maxBatchSize: 4, requiredChecks: ['test', 'lint'], lanes, defaultLane: 'normal',
      freeze: { windows: [{ cron: '0 17 * * 5', durationMinutes: 3840, reason: 'Weekend' }, { start: '2026-12-20T00:00:00Z', end: '2027-01-02T00:00:00Z' }] },
      maxInFlight: 8, flakyRetries: 1, bisectOnBatchFailure: false, autoRebaseOnConflict: false, ejectAfterMinutes: 240, requiredApprovals: 1 },
    { name: 'release', branches: ['release/*'] },
  ] });
  assert.equal(valid.ok, true, JSON.stringify(valid.errors));
  assert.deepEqual(valid.config.queues[1], { name: 'release', branches: ['release/*'], strategy: 'serial', maxBatchSize: 8, depth: 3, requiredChecks: [], method: 'squash',
    publication: 'fast-forward-push', lanes: [], maxInFlight: null, flakyRetries: 0, bisectOnBatchFailure: true, autoRebaseOnConflict: true, ejectAfterMinutes: null,
    requiredApprovals: 0, freeze: { windows: [] } });
  assert.deepEqual(valid.config.queues[0].branches, ['main']);
  const invalid = normalizeMergeQueueConfig({ version: 2, extra: true, queues: [
    { name: 'main', strategy: 'parallel', depth: 2, publication: 'github-merge-queue', method: 'octopus', flakyRetries: 9, lanes: [{ name: 'a', priority: 2000 }, { name: 'a', priority: 1 }],
      defaultLane: 'missing', freeze: { windows: [{ cron: '61 * * * *', durationMinutes: 0 }, { start: '2026-01-02T00:00:00Z', end: '2026-01-01T00:00:00Z' }] }, typo: 1 },
    { name: 'main', branches: ['main', ' bad '] },
    'not a queue',
  ] });
  assert.equal(invalid.ok, false);
  const paths = invalid.errors.map(error => error.path);
  for (const path of ['$.version', '$.extra', '$.queues[0].strategy', '$.queues[0].method', '$.queues[0].flakyRetries', '$.queues[0].typo',
    '$.queues[0].lanes[0].priority', '$.queues[0].lanes[1].name', '$.queues[0].defaultLane', '$.queues[0].freeze.windows[0].cron',
    '$.queues[0].freeze.windows[0].durationMinutes', '$.queues[0].freeze.windows[1].end', '$.queues[1].name', '$.queues[1].branches', '$.queues[2]']) {
    assert.ok(paths.includes(path), `missing error at ${path}: ${JSON.stringify(invalid.errors)}`);
  }
  const native = normalizeMergeQueueConfig({ queues: [{ name: 'main', strategy: 'batch', publication: 'github-merge-queue' }] });
  assert.match(native.errors.find(error => error.path === '$.queues[0].publication').message, /serial/);
  assert.match(normalizeMergeQueueConfig({ queues: [{ name: 'a', branches: ['main'] }, { name: 'b', branches: ['main'] }] }).errors[0].message, /already covered/);
});

test('repository file overrides the hub per queue and field; an invalid file is reported, not applied', () => {
  const hub = { version: 1, queues: [{ name: 'main', strategy: 'batch', maxBatchSize: 4, requiredChecks: ['test'] }, { name: 'release', branches: ['release/*'] }] };
  const repo = { version: 1, queues: [{ name: 'main', maxBatchSize: 2, flakyRetries: 1 }, { name: 'docs', branches: ['docs'] }] };
  const merged = mergeQueueConfigs(hub, repo);
  assert.equal(merged.ok, true);
  const main = merged.config.queues.find(item => item.name === 'main');
  assert.deepEqual([main.strategy, main.maxBatchSize, main.flakyRetries, main.requiredChecks], ['batch', 2, 1, ['test']]);
  assert.deepEqual(merged.sources, { main: 'merged', release: 'hub', docs: 'repo' });
  assert.deepEqual(merged.config.queues.map(item => item.name), ['main', 'release', 'docs']);
  assert.equal(mergeQueueConfigs(hub, null).sources.main, 'hub');
  assert.equal(queueForBranch(merged.config, 'release/2026.10').name, 'release');
  assert.equal(queueForBranch(merged.config, 'main').name, 'main');
  assert.equal(queueForBranch(merged.config, 'feature/x'), null);
});

test('branch globs, cron parsing and freeze windows', () => {
  assert.ok(matchBranch('release/*', 'release/1.2'));
  assert.ok(!matchBranch('release/*', 'release/1.2/hotfix'));
  assert.ok(matchBranch('deps/**', 'deps/npm/react'));
  assert.ok(matchBranch('v?', 'v1') && !matchBranch('v?', 'v10'));
  assert.ok(matchBranch('a.b', 'a.b') && !matchBranch('a.b', 'axb'));
  assert.ok(parseCron('*/15 9-17 * * 1-5')); assert.equal(parseCron('* * *'), null); assert.equal(parseCron('60 * * * *'), null);
  const weekend = [{ cron: '0 17 * * 5', durationMinutes: 64 * 60, reason: 'Weekend freeze' }];
  assert.equal(freezeAt({ windows: weekend }, Date.parse('2026-10-23T16:59:00Z')), null);
  const friday = freezeAt({ windows: weekend }, Date.parse('2026-10-23T17:00:00Z'));
  assert.deepEqual(friday, { kind: 'window', reason: 'Weekend freeze', since: Date.parse('2026-10-23T17:00:00Z'), until: Date.parse('2026-10-26T09:00:00Z') });
  assert.equal(freezeAt({ windows: weekend }, Date.parse('2026-10-25T12:00:00Z')).until, Date.parse('2026-10-26T09:00:00Z'));
  assert.equal(freezeAt({ windows: weekend }, Date.parse('2026-10-26T09:00:00Z')), null);
  const range = [{ start: '2026-12-20T00:00:00.000Z', end: '2027-01-02T00:00:00.000Z' }];
  assert.equal(freezeAt({ windows: range }, Date.parse('2026-12-25T00:00:00Z')).kind, 'window');
  assert.equal(freezeAt({ windows: range }, Date.parse('2027-01-02T00:00:00Z')), null);
  assert.deepEqual(freezeAt({ manual: { reason: 'Incident', at: 5 }, windows: [] }, undefined), { kind: 'manual', reason: 'Incident', since: 5 });
  assert.equal(freezeAt({ windows: weekend }, undefined), null);
});

test('queues without a policy keep their exact configuration hash and FIFO order', () => {
  const config = { projectId: 'p', repo: { url: '/r.git' }, baseBranch: 'main', strategy: 'batch', method: 'merge', requiredChecks: ['test'], ci };
  const legacy = { projectId: 'p', repo: { url: '/r.git' }, baseBranch: 'main', strategy: 'batch', method: 'merge', publication: 'fast-forward-push',
    requiredChecks: ['test'], ci: { steps: [{ name: 'test', run: 'npm test' }], requirements: {} }, batchSize: 8 };
  assert.equal(stableHash(createQueueState(config).config), stableHash(legacy));
  assert.equal(stableHash(createQueueState({ ...config, policy: {} }).config), stableHash(legacy));
  let state = createQueueState(config);
  for (const id of ['a', 'b', 'c']) state = reduceQueue(state, { type: 'enqueue', entry: { id, projectId: 'p', prUrl: `local:${id}`, headSha: sha(id), baseBranch: 'main' } });
  assert.deepEqual(selectEntries(state).map(entry => entry.id), ['a', 'b', 'c']);
  assert.equal(state.entries[0].seq, undefined); assert.equal(state.entries[0].lane, undefined);
});

test('priority lanes order the queue; owners can reprioritize and requeue to the back', () => {
  const policy = queuePolicy(normalizeMergeQueueConfig({ queues: [{ name: 'main', lanes, defaultLane: 'normal' }] }).config.queues[0]);
  assert.equal(laneFor(policy, { labels: ['dependencies'] }).name, 'dependencies');
  assert.equal(laneFor(policy, { headBranch: 'hotfix/login' }).name, 'hotfix');
  assert.equal(laneFor(policy, { labels: ['dependencies', 'hotfix'] }).name, 'hotfix');
  assert.equal(laneFor(policy, {}).name, 'normal');
  let state = createQueueState({ projectId: 'p', repo: { url: '/r.git' }, baseBranch: 'main', strategy: 'serial', method: 'squash', requiredChecks: [], ci, policy });
  const add = (id, extra = {}, at = 0) => { state = reduceQueue(state, { type: 'enqueue', at, entry: { id, projectId: 'p', prUrl: `local:${id}`, headSha: sha(id), baseBranch: 'main', ...extra } }); };
  add('deps', { headBranch: 'dependabot/npm/react' }); add('feature-1'); add('fix', { labels: ['hotfix'] }); add('feature-2');
  assert.deepEqual(queuedOrder(state).map(entry => `${entry.id}:${entry.lane}`), ['fix:hotfix', 'feature-1:normal', 'feature-2:normal', 'deps:dependencies']);
  assert.deepEqual(selectEntries(state).map(entry => entry.id), ['fix']);
  // Within a lane the queue stays first come, first served: deps joined before fix.
  state = reduceQueue(state, { type: 'prioritize', entryId: 'deps', lane: 'hotfix' });
  assert.deepEqual(queuedOrder(state).map(entry => entry.id), ['deps', 'fix', 'feature-1', 'feature-2']);
  state = reduceQueue(state, { type: 'requeue-entry', entryId: 'feature-1', at: 10 });
  assert.deepEqual(queuedOrder(state).map(entry => entry.id), ['deps', 'fix', 'feature-2', 'feature-1']);
  assert.throws(() => reduceQueue(state, { type: 'prioritize', entryId: 'fix', lane: 'nope' }), /Unknown lane/);
  // A reconfigure moves unpinned entries between lanes but keeps owner choices.
  state = reduceQueue(state, { type: 'configure', config: { ...state.config, policy: { ...policy, lanes: lanes.map(lane => lane.name === 'normal' ? { ...lane, priority: 200 } : lane) } } });
  assert.deepEqual(queuedOrder(state).map(entry => entry.id), ['feature-2', 'feature-1', 'deps', 'fix']);
});

test('maxInFlight caps a batch and required approvals gate admission', () => {
  let state = createQueueState({ projectId: 'p', repo: { url: '/r.git' }, baseBranch: 'main', strategy: 'batch', batchSize: 5, method: 'squash', requiredChecks: [], ci,
    policy: { maxInFlight: 2, requiredApprovals: 1 } });
  const entry = (id, approvals) => ({ id, projectId: 'p', prUrl: `local:${id}`, headSha: sha(id), baseBranch: 'main', approvals });
  assert.throws(() => reduceQueue(state, { type: 'enqueue', entry: entry('none', 0) }), error => error.code === 'APPROVALS_REQUIRED' && /needs 1 approving review/.test(error.message));
  assert.throws(() => reduceQueue(state, { type: 'enqueue', entry: { ...entry('missing'), approvals: undefined } }), { code: 'APPROVALS_REQUIRED' });
  for (const id of ['a', 'b', 'c']) state = reduceQueue(state, { type: 'enqueue', entry: entry(id, 2) });
  assert.equal(state.entries[0].approvals, 2);
  assert.deepEqual(selectEntries(state).map(item => item.id), ['a', 'b']);
});

test('a manual freeze holds new attempts and tested publication until unfrozen', async t => {
  const h = await harness(t);
  h.enqueue('a'); h.enqueue('b');
  await h.step(); await h.step(); // start, prepare
  assert.equal(h.queue.state.active.phase, 'testing');
  h.queue.freeze({ reason: 'Incident 42', by: 'owner' }, { idempotencyKey: 'freeze-1' });
  assert.deepEqual(h.queue.freeze({ reason: 'Incident 42', by: 'owner' }, { idempotencyKey: 'freeze-1' }).freeze, h.queue.state.freeze);
  const held = await h.drain();
  assert.equal(held.active.phase, 'testing'); assert.equal(held.jobs[0].status, 'passed');
  assert.deepEqual(statuses(held), { a: 'testing', b: 'queued' });
  assert.deepEqual(h.forge.published, []);
  assert.equal(h.queue.view().frozen.reason, 'Incident 42');
  h.queue.unfreeze({ idempotencyKey: 'unfreeze-1' });
  const done = await h.drain();
  assert.deepEqual(statuses(done), { a: 'merged', b: 'merged' });
  assert.equal(h.forge.published.length, 2);
});

test('freeze windows follow the fake clock', async t => {
  const h = await harness(t, { policy: { freezeWindows: [{ cron: '0 17 * * 5', durationMinutes: 64 * 60, reason: 'Weekend' }] } });
  h.clock.now = Date.parse('2026-10-23T17:30:00Z');
  h.enqueue('a');
  const frozen = await h.drain();
  assert.equal(frozen.active, null); assert.equal(frozen.entries[0].status, 'queued');
  assert.equal(h.queue.view().frozen.until, '2026-10-26T09:00:00.000Z');
  h.clock.now = Date.parse('2026-10-26T09:00:00Z');
  assert.equal((await h.drain()).entries[0].status, 'merged');
});

test('flaky retry reruns the same candidate before rejecting', async t => {
  const h = await harness(t, { policy: { flakyRetries: 2 } });
  h.enqueue('flaky'); h.enqueue('broken');
  let runs = 0;
  const state = await h.drain((job, current) => {
    const entry = current.entries.find(item => item.jobId === job.id);
    if (entry.id === 'flaky') return ++runs === 1 ? 'failed' : 'passed';
    return 'failed';
  });
  assert.deepEqual(statuses(state), { flaky: 'merged', broken: 'rejected' });
  const flakyJobs = state.jobs.filter(job => job.queueAttemptId === state.history.find(item => item.entryIds.includes('flaky')).id);
  assert.equal(flakyJobs.length, 2); assert.equal(new Set(flakyJobs.map(job => job.revision)).size, 1);
  const broken = state.entries.find(entry => entry.id === 'broken');
  assert.match(broken.reason, /after 3 runs/); assert.equal(broken.cause, 'ci'); assert.equal(broken.retries, 2);
  assert.equal(queueMetrics(state, h.clock.now).flakyRetries, 3);
});

test('batch failure bisects by default and rejects the whole batch when bisection is off', async t => {
  const on = await harness(t, { strategy: 'batch' });
  for (const id of ['a', 'b', 'c', 'd']) on.enqueue(id);
  assert.deepEqual(statuses(await on.drain(failingIds(['c']))), { a: 'merged', b: 'merged', c: 'rejected', d: 'merged' });
  const off = await harness(t, { strategy: 'batch', policy: { bisect: false } });
  for (const id of ['a', 'b', 'c', 'd']) off.enqueue(id);
  const state = await off.drain(failingIds(['c']));
  assert.deepEqual(statuses(state), { a: 'rejected', b: 'rejected', c: 'rejected', d: 'rejected' });
  assert.ok(state.entries.every(entry => entry.cause === 'ci'));
  assert.deepEqual(queueMetrics(state, off.clock.now).batches, { total: 1, succeeded: 0, successRate: 0 });
});

test('entries waiting past the timeout are ejected, but never while publishing', async t => {
  const h = await harness(t, { policy: { ejectAfterMs: 30 * MINUTE } });
  h.enqueue('slow');
  await h.step(); await h.step();
  h.clock.now += 31 * MINUTE;
  await h.step();
  const entry = h.queue.state.entries[0];
  assert.equal(entry.status, 'rejected'); assert.equal(entry.cause, 'timeout'); assert.match(entry.reason, /longer than 30 minutes/);
  assert.equal(h.queue.state.active, null); assert.equal(h.queue.state.jobs[0].status, 'cancelled');
  // A publishing entry is out of reach of the timeout.
  const late = await harness(t, { policy: { ejectAfterMs: 30 * MINUTE } });
  late.enqueue('publishing');
  await late.step(); await late.step();
  const job = late.queue.state.jobs[0];
  late.queue.recordJobResult({ id: job.id, revision: job.revision, configHash: job.configHash, status: 'passed' }, { idempotencyKey: 'r' });
  await late.step();
  assert.equal(late.queue.state.entries[0].status, 'merging');
  late.clock.now += 60 * MINUTE;
  await late.step();
  assert.equal(late.queue.state.entries[0].status, 'merged');
});

test('owners eject and requeue entries without the worker lease', async t => {
  const h = await harness(t, { strategy: 'batch' });
  for (const id of ['a', 'b', 'c']) h.enqueue(id);
  await h.step(); await h.step();
  const token = h.store.acquire('mq_policy', 60000);
  h.queue.eject({ entryId: 'b', reason: 'Not ready' }, { idempotencyKey: 'eject-b' });
  h.store.release('mq_policy', token);
  let state = h.queue.state;
  assert.equal(state.entries[1].status, 'rejected'); assert.equal(state.entries[1].cause, 'manual');
  assert.equal(state.active, null); assert.deepEqual(state.groups, [['a', 'c']]);
  h.queue.requeueEntry({ entryId: 'a' }, { idempotencyKey: 'requeue-a' });
  state = h.queue.state;
  assert.deepEqual(queuedOrder(state).map(entry => entry.id), ['c', 'a']);
  assert.throws(() => h.queue.eject({ entryId: 'b' }, { idempotencyKey: 'eject-b-again' }), { code: 'CONFLICT' });
  const done = await h.drain();
  assert.deepEqual(statuses(done), { a: 'merged', b: 'rejected', c: 'merged' });
});

test('speculative queues test stacked candidates concurrently and publish them in order', async t => {
  const h = await harness(t, { strategy: 'speculative', policy: { depth: 3 } });
  for (const id of ['a', 'b', 'c', 'd']) h.enqueue(id);
  // start a, prepare a, speculate b, prepare b on a, speculate c, prepare c on b; depth 3 stops there.
  for (let index = 0; index < 6; index++) await h.step();
  let state = h.queue.state;
  assert.equal(state.jobs.length, 3);
  assert.deepEqual(state.pipeline.map(attempt => attempt.entryIds[0]), ['b', 'c']);
  assert.equal(state.pipeline[0].baseSha, state.active.revision);
  assert.equal(state.pipeline[1].baseSha, state.pipeline[0].revision);
  assert.deepEqual(statuses(state), { a: 'testing', b: 'testing', c: 'testing', d: 'queued' });
  const view = h.queue.view();
  assert.deepEqual(view.attempts.map(attempt => [attempt.head, attempt.entryIds[0]]), [[true, 'a'], [false, 'b'], [false, 'c']]);
  assert.deepEqual(view.entries.map(entry => entry.id), ['a', 'b', 'c', 'd']);
  state = await h.drain();
  assert.deepEqual(statuses(state), { a: 'merged', b: 'merged', c: 'merged', d: 'merged' });
  // Each publication fast-forwards onto the previous candidate: no candidate was rebuilt.
  assert.equal(state.jobs.length, 4);
  assert.deepEqual(h.forge.published, state.entries.map(entry => entry.mergedRevision));
  assert.equal(h.forge.base, state.entries.at(-1).mergedRevision);
});

test('a failing speculative head discards the stack and its culprit alone is rejected', async t => {
  const h = await harness(t, { strategy: 'speculative', policy: { depth: 3 } });
  for (const id of ['a', 'b', 'c']) h.enqueue(id);
  for (let index = 0; index < 6; index++) await h.step();
  assert.equal(h.queue.state.pipeline.length, 2);
  for (const job of h.queue.state.jobs) {
    const failed = job.queueAttemptId === h.queue.state.active.id;
    h.queue.recordJobResult({ id: job.id, revision: job.revision, configHash: job.configHash, status: failed ? 'failed' : 'passed' }, { idempotencyKey: `result:${job.id}` });
  }
  const state = await h.drain();
  assert.deepEqual(statuses(state), { a: 'rejected', b: 'merged', c: 'merged' });
  assert.ok(state.history.some(item => item.outcome === 'discarded'));
  // Their passing speculative results were built on a, so b and c were tested again on the unchanged base.
  assert.equal(state.jobs.length, 5);
  // b and c were rebuilt on the unchanged base after a failed.
  assert.equal(h.forge.published.length, 2);
});

test('a speculative conflict waits blocked and is decided at the head', async t => {
  const h = await harness(t, { strategy: 'speculative', policy: { depth: 2 } });
  h.enqueue('a'); h.enqueue('b');
  h.forge.conflicts.add('b');
  for (let index = 0; index < 4; index++) await h.step();
  assert.equal(h.queue.state.pipeline[0].phase, 'blocked');
  assert.match(h.queue.state.pipeline[0].reason, /Conflicts with the change ahead/);
  const state = await h.drain();
  assert.deepEqual(statuses(state), { a: 'merged', b: 'rejected' });
  assert.equal(state.entries[1].cause, 'conflict'); assert.equal(state.entries[1].rejectionKind, 'conflict');
});

test('reconfiguring a named queue keeps its state and retests changed candidates', async t => {
  const h = await harness(t);
  h.enqueue('a');
  await h.step(); await h.step();
  assert.throws(() => new MergeQueue({ store: h.store, queueId: 'mq_policy', config: { ...h.config, method: 'merge' }, adapter: h.forge }), { code: 'CONFLICT' });
  const lanesOnly = new MergeQueue({ store: h.store, queueId: 'mq_policy', config: { ...h.config, policy: { flakyRetries: 1 } }, adapter: h.forge, reconfigure: true, clock: () => h.clock.now });
  assert.equal(lanesOnly.state.active.phase, 'testing');
  assert.deepEqual(lanesOnly.state.config.policy, { flakyRetries: 1 });
  lanesOnly.reconfigure({ ...h.config, method: 'merge', policy: { flakyRetries: 1 } });
  const state = lanesOnly.state;
  assert.equal(state.active, null); assert.equal(state.entries[0].status, 'queued'); assert.match(state.entries[0].reason, /configuration changed/);
  assert.equal(state.config.method, 'merge');
});

test('metrics: throughput, median time in queue, failure rate by reason and batch success', async t => {
  const h = await harness(t, { strategy: 'batch', batchSize: 2 });
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) h.enqueue(id);
  h.forge.conflicts.add('d');
  const state = await h.drain(failingIds(['b']), { advance: 5 * MINUTE });
  // [a,b] fails CI and bisects; [c,d] conflicts on d and c retries alone; [e,f] passes as a batch.
  assert.deepEqual(statuses(state), { a: 'merged', b: 'rejected', c: 'merged', d: 'rejected', e: 'merged', f: 'merged' });
  const metrics = queueMetrics(state, h.clock.now, { windowMs: 24 * 60 * MINUTE });
  assert.equal(metrics.merged, 4); assert.equal(metrics.rejected, 2);
  assert.equal(metrics.throughputPerHour, Math.round((4 / 24) * 100) / 100);
  assert.equal(metrics.failureRate, 0.333);
  assert.deepEqual(metrics.failuresByReason.map(item => [item.cause, item.count]), [['ci', 1], ['conflict', 1]]);
  assert.deepEqual(metrics.batches, { total: 3, succeeded: 1, successRate: 0.333 });
  const merged = state.entries.filter(entry => entry.status === 'merged');
  assert.equal(metrics.medianTimeInQueueMs, median(merged.map(entry => entry.finishedAt - entry.enqueuedAt)));
  assert.equal(metrics.hourly.length, 24);
  assert.equal(metrics.hourly.reduce((sum, hour) => sum + hour.merged, 0), 4);
  const outside = queueMetrics(state, h.clock.now + 48 * 60 * MINUTE);
  assert.equal(outside.merged, 0); assert.equal(outside.failureRate, null);
});

test('live view orders entries and estimates arrival from recent attempt durations', async t => {
  const h = await harness(t);
  h.enqueue('first');
  await h.drain(undefined, { advance: 10 * MINUTE });
  for (const id of ['x', 'y', 'z']) h.enqueue(id);
  await h.step(); await h.step();
  const view = h.queue.view();
  assert.deepEqual(view.entries.map(entry => [entry.id, entry.position, entry.status]), [['x', 1, 'testing'], ['y', 2, 'queued'], ['z', 3, 'queued']]);
  assert.ok(view.eta.attemptMs > 0);
  const [x, y, z] = view.entries.map(entry => Date.parse(entry.etaAt));
  assert.ok(x <= y && y < z);
  assert.equal(z - y, view.eta.attemptMs);
  assert.deepEqual(view.testing, ['x']);
  assert.equal(view.recent[0].id, 'first');
  assert.equal(view.metrics.merged, 1);
});

test('the example merge queue configuration is valid', async () => {
  const { readFile } = await import('node:fs/promises');
  const example = JSON.parse(await readFile(new URL('../../../config/merge-queue.example.json', import.meta.url), 'utf8'));
  const result = normalizeMergeQueueConfig(example);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.config.queues.map(item => item.name), ['main', 'release']);
});

test('speculative candidates fast-forward a real bare repository in order', async t => {
  const f = await fixture(t, { strategy: 'speculative', policy: { depth: 3 } });
  for (const name of ['one', 'two', 'three']) f.enqueue(await f.branch(name, { [`${name}.txt`]: name }));
  for (let index = 0; index < 40; index++) {
    const state = f.queue.state;
    if (!state.active && !state.entries.some(entry => entry.status === 'queued')) break;
    const queued = state.jobs.filter(job => job.status === 'queued');
    // Let the whole stack build before running CI, so all three candidates exist at once.
    if (queued.length && (state.pipeline?.length === 2 || !state.entries.some(entry => entry.status === 'queued'))) { for (const job of queued) await f.runCI(job); }
    else await f.step();
  }
  const state = f.queue.state;
  assert.deepEqual(state.entries.map(entry => entry.status), ['merged', 'merged', 'merged']);
  assert.equal(state.jobs.length, 3);
  assert.equal(await f.adapter.getBase('main'), state.entries[2].mergedRevision);
  for (const name of ['one', 'two', 'three']) assert.equal(await git(f.repository, 'show', `main:${name}.txt`), name);
  assert.equal(await git(f.repository, 'merge-base', '--is-ancestor', state.entries[0].mergedRevision, state.entries[1].mergedRevision), '');
});
