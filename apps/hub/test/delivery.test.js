import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createHub } from '../src/index.js';
import { Hub } from '../src/hub.js';
import { loadConfig } from '../src/config.js';
import { createStubEngine } from '../src/engine/stub-engine.js';

const run = promisify(execFile);
const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@perpeto.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];
const git = async (cwd, ...args) => (await run('git', [...identity, ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(fn, message = 'Condition did not become true.') {
  for (let attempt = 0; attempt < 400; attempt++) { const value = await fn(); if (value) return value; await sleep(25); }
  assert.fail(message);
}

/** A bare repository with one commit on main, and a working clone that pushes PR branches to it. */
async function repository(root, name = 'project') {
  const bare = join(root, `${name}.git`); const work = join(root, `${name}-work`);
  await run('git', ['init', '--bare', '--initial-branch=main', bare]);
  await run('git', ['clone', bare, work]);
  await writeFile(join(work, 'README.md'), '# Fixture\n'); await git(work, 'add', '.'); await git(work, 'commit', '-m', 'Initial'); await git(work, 'push', 'origin', 'HEAD:main');
  return {
    bare,
    /** Push a branch adding one file on top of main and return its PR fields. */
    async branch(branch, file = `${branch}.txt`) {
      await git(work, 'fetch', 'origin'); await git(work, 'checkout', '-B', branch, 'origin/main');
      await writeFile(join(work, file), `${branch}\n`); await git(work, 'add', file); await git(work, 'commit', '-m', branch); await git(work, 'push', '--force', 'origin', `HEAD:refs/heads/${branch}`);
      return { branch, prUrl: `local:${branch}`, headSha: await git(work, 'rev-parse', 'HEAD') };
    },
    files: async () => (await git(bare, 'ls-tree', '--name-only', 'main')).split('\n'),
  };
}

const node = (id, type, config = {}) => ({ id, type, label: id, position: { x: 0, y: 0 }, config });
const flow = (from, to, port) => ({ id: `${from}-${port ?? 'next'}-${to}`, kind: 'flow', from: { node: from, ...(port ? { port } : {}) }, to: { node: to } });
const mergeGraph = strategy => ({ schema: 'perpeto.workflow/1', nodes: [
  node('ideas', 'input', { source: 'manual' }), node('builder', 'agent', { harness: { provider: 'codex', model: 'test' }, prompt: 'Build it.', concurrency: 1 }),
  node('merge', 'merge-queue', { strategy, method: 'squash', requiredChecks: [] }), node('done', 'output'),
], edges: [flow('ideas', 'builder'), flow('builder', 'merge'), flow('merge', 'done', 'pass'), flow('merge', 'done', 'fail')] });

/** A hub on the real engine and delivery queues, with one machine the test drives by hand. */
async function deliveryHub(t, config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'perpeto-hub-delivery-'));
  const configPath = join(root, 'hub.json');
  await writeFile(configPath, JSON.stringify({ port: 0, longPollMs: 0, maintenanceIntervalMs: 20, heartbeatIntervalMs: 60000, deliveryMaxStepFailures: 2, deliveryRetryBackoffMs: 1, ...config }));
  const hub = await createHub({ configPath }); const url = await hub.listen();
  t.after(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });
  const owner = (await readFile(join(root, 'owner.secret'), 'utf8')).trim();
  const request = async (method, path, body, token = owner) => {
    const response = await fetch(`${url}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    assert.ok(response.ok, `${method} ${path} -> ${response.status} ${JSON.stringify(data)}`);
    return data;
  };
  const code = (await request('POST', '/machines/enrollment-codes', {})).code;
  const machine = await request('POST', '/nodes/enroll', { code, name: 'machine', os: 'linux', arch: 'x64', providers: ['codex'], version: 'test' });
  await request('POST', '/nodes/heartbeat', { status: 'online', capacity: { maxAgents: 1, maxJobs: 1 }, running: { agents: 0, jobs: 0 }, providers: ['codex'] }, machine.token);
  const lease = async kind => (await request('POST', '/nodes/lease', { kinds: [kind], max: 1 }, machine.token))[kind === 'job' ? 'jobs' : 'assignments'][0];
  return {
    root, request,
    async project(repoUrl) { return request('POST', '/projects', { name: 'Delivery', repo: { url: repoUrl, defaultBranch: 'main' } }); },
    async start(project, strategy = 'serial') {
      const workflow = await request('POST', `/projects/${project.id}/workflows`, { name: 'Merge', graph: mergeGraph(strategy) });
      await request('POST', `/workflows/${workflow.id}/activate`, { version: 1 });
      return { workflow, run: await request('POST', `/workflows/${workflow.id}/runs`, { input: { items: [{ title: 'Change' }] } }) };
    },
    async again(workflow) { return request('POST', `/workflows/${workflow.id}/runs`, { input: { items: [{ title: 'Change' }] } }); },
    /** Lease the next builder assignment and report the given PR. */
    async build(pr) {
      const assignment = await eventually(() => lease('assignment'), 'no builder assignment');
      await request('POST', `/assignments/${assignment.id}/events`, { attempt: assignment.attempt, type: 'completed', data: { outcome: 'success', summary: 'Built.', ...pr } }, machine.token);
      return assignment;
    },
    /** Lease and pass the next speculative merge-queue job. */
    async pass() {
      const job = await eventually(() => lease('job'), 'no speculative job');
      assert.ok(job.delivery, 'leased a merge-queue job');
      await request('POST', `/jobs/${job.id}/events`, { attempt: job.attempt, type: 'completed', data: { status: 'passed', revision: job.revision, configHash: job.configHash } }, machine.token);
      return job;
    },
    lease,
    entries: async project => (await request('GET', `/projects/${project.id}/merge-queue`)).entries,
    entry: async (project, runId) => (await request('GET', `/projects/${project.id}/merge-queue`)).entries.find(value => value.runId === runId),
  };
}

test('a wedged merge entry is rejected after bounded retries and reported to its run, and the queue moves on (H2)', async t => {
  const h = await deliveryHub(t); const repo = await repository(h.root); const project = await h.project(repo.bare);
  const healthy = await repo.branch('healthy');
  // The first entry's PR branch does not exist (deleted after the agent reported it), so every getHead fails.
  const { workflow, run: wedgedRun } = await h.start(project);
  await h.build({ branch: 'gone', prUrl: 'local:gone', headSha: healthy.headSha });
  await eventually(async () => (await h.entry(project, wedgedRun.id))?.queueId, 'wedged entry admitted');
  const healthyRun = await h.again(workflow); await h.build(healthy);

  const wedged = await eventually(async () => { const value = await h.entry(project, wedgedRun.id); return value?.status === 'rejected' && value; }, 'wedged entry rejected');
  assert.match(wedged.reason, /gave up after 2 failed attempts/); assert.match(wedged.deliveryError, /COMMAND_FAILED/);
  assert.equal((await eventually(async () => { const value = await h.request('GET', `/runs/${wedgedRun.id}`); return value.status !== 'running' && value; })).status, 'completed');
  const gates = (await h.request('GET', '/events?limit=1000')).events.filter(event => event.runId === wedgedRun.id && event.type === 'gate.result' && event.data.gate === 'merge-queue');
  assert.equal(gates.length, 1); assert.equal(gates[0].data.result, 'fail'); assert.match(gates[0].data.summary, /gave up after 2 failed attempts/);

  await h.pass();
  await eventually(async () => (await h.entry(project, healthyRun.id))?.status === 'merged', 'healthy entry merged behind the wedged one');
  assert.ok((await repo.files()).includes('healthy.txt'));

  // local:main passes speculative CI but can never be published, so it fails in the merging phase. It is rejected only
  // after the hub confirms the base does not contain its candidate.
  const main = await git(repo.bare, 'rev-parse', 'main');
  const selfRun = await h.again(workflow); await h.build({ branch: 'main', prUrl: 'local:main', headSha: main });
  await h.pass();
  const refused = await eventually(async () => { const value = await h.entry(project, selfRun.id); return value?.status === 'rejected' && value; }, 'unpublishable entry rejected');
  assert.match(refused.deliveryError, /INVALID_INPUT/); assert.ok(refused.testedRevision === undefined || refused.mergedRevision === undefined);
  assert.equal((await eventually(async () => { const value = await h.request('GET', `/runs/${selfRun.id}`); return value.status !== 'running' && value; })).status, 'completed');
  assert.equal(await git(repo.bare, 'rev-parse', 'main'), main);
});

test('pausing one run does not stall merges of another run sharing its queue (M2)', async t => {
  const h = await deliveryHub(t); const repo = await repository(h.root); const project = await h.project(repo.bare);
  const first = await repo.branch('first'); const second = await repo.branch('second');
  const { workflow, run: paused } = await h.start(project); await h.build(first);
  await eventually(async () => (await h.entry(project, paused.id))?.jobId, 'paused run entry under test');
  const other = await h.again(workflow); await h.build(second);
  await h.request('POST', `/runs/${paused.id}/pause`, {});
  await h.pass();
  await h.pass();
  await eventually(async () => (await h.entry(project, other.id))?.status === 'merged', 'other run merged');
  assert.equal((await h.entry(project, paused.id)).status, 'merged');
  assert.ok((await repo.files()).includes('second.txt'));
});

test('a stopped run\'s batch entry is withdrawn before it can merge; the rest of the batch still merges (M3)', async t => {
  const h = await deliveryHub(t); const repo = await repository(h.root);
  // A relative repo URL blocks admission, so both entries are admitted together into one batch once it is fixed.
  const project = await h.project('relative.git');
  const stopped = await repo.branch('stopped'); const kept = await repo.branch('kept');
  const { workflow, run: stoppedRun } = await h.start(project, 'batch'); await h.build(stopped);
  const keptRun = await h.again(workflow); await h.build(kept);
  await eventually(async () => (await h.entries(project)).every(entry => entry.deliveryError), 'entries blocked');
  await h.request('PATCH', `/projects/${project.id}`, { repo: { url: repo.bare, defaultBranch: 'main' } });
  const batch = await eventually(async () => {
    const entries = await h.entries(project);
    return entries.length === 2 && entries.every(entry => entry.jobId && entry.jobId === entries[0].jobId) && entries[0].jobId;
  }, 'one batch job for both entries');
  await h.request('POST', `/runs/${stoppedRun.id}/stop`, {});
  // The stopped entry leaves the attempt, its batch job is cancelled, and the kept entry is retested alone.
  await eventually(async () => (await h.request('GET', `/jobs/${batch}`)).status === 'cancelled', 'batch job cancelled');
  const retest = await h.pass(); assert.notEqual(retest.id, batch); assert.deepEqual(retest.delivery.mergeEntryIds, [(await h.entry(project, keptRun.id)).id]);
  await eventually(async () => (await h.entry(project, keptRun.id))?.status === 'merged', 'kept entry merged');
  const files = await repo.files();
  assert.ok(files.includes('kept.txt')); assert.ok(!files.includes('stopped.txt'), 'stopped run change was published');
  assert.equal((await h.entry(project, stoppedRun.id)).status, 'rejected');
});

test('one project with an unusable repo URL does not halt merge admission for other projects (M17)', async t => {
  const h = await deliveryHub(t); const repo = await repository(h.root);
  const broken = await h.project('file://host/repo.git'); const healthy = await h.project(repo.bare);
  const change = await repo.branch('change');
  const { run: brokenRun } = await h.start(broken); await h.build(change);
  const { run: healthyRun } = await h.start(healthy); await h.build(change);
  const blocked = await eventually(async () => { const value = await h.entry(broken, brokenRun.id); return value?.deliveryError && value; }, 'broken entry blocked');
  assert.equal(blocked.status, 'queued'); assert.equal(blocked.queueId, undefined);
  await h.pass();
  await eventually(async () => (await h.entry(healthy, healthyRun.id))?.status === 'merged', 'healthy project merged');
  const events = (await h.request('GET', '/events?limit=1000')).events;
  assert.ok(events.some(event => event.type === 'merge-entry.blocked' && event.subject.id === blocked.id));
});

/** A hub without HTTP or maintenance, and one delivery queue with a prepared speculative job the hub has not mirrored. */
async function preparedQueue(t) {
  const root = await mkdtemp(join(tmpdir(), 'perpeto-hub-delivery-')); t.after(() => rm(root, { recursive: true, force: true }));
  const repo = await repository(root); const configPath = join(root, 'hub.json'); await writeFile(configPath, JSON.stringify({}));
  const hub = new Hub(loadConfig(configPath), createStubEngine()); t.after(() => hub.close());
  const pr = await repo.branch('feature');
  const record = hub.store.put('delivery-queue', { id: 'dq_test', projectId: 'prj_test', repository: repo.bare, checks: [], config: { projectId: 'prj_test',
    repo: { url: repo.bare, defaultBranch: 'main' }, baseBranch: 'main', strategy: 'serial', method: 'squash', requiredChecks: [], ci: { steps: [{ name: 'candidate', run: 'true' }], requirements: {} } } });
  const queue = hub.delivery.queue(record);
  queue.enqueue({ id: 'mq_test', projectId: 'prj_test', baseBranch: 'main', prUrl: pr.prUrl, headSha: pr.headSha }, { idempotencyKey: 'enqueue' });
  await queue.step({ idempotencyKey: 'start' }); await queue.step({ idempotencyKey: 'prepare' });
  assert.equal(queue.state.jobs[0].status, 'queued');
  return { hub, queue };
}

test('cancelled delivery job history the hub never mirrored does not keep a finished queue open (M16)', async t => {
  const { hub, queue } = await preparedQueue(t);
  // The entry's run closes it and the queue cancels the speculative job before the hub ever registered that job.
  hub.store.put('merge-entry', { id: 'mq_test', projectId: 'prj_test', status: 'rejected', reason: 'Closed by its run.' });
  queue.withdraw({ entryId: 'mq_test', reason: 'Closed by its run.' }, { idempotencyKey: 'withdraw' });
  assert.equal(queue.state.jobs[0].status, 'cancelled'); assert.equal(hub.store.get('job', queue.state.jobs[0].id), null);
  assert.deepEqual(await hub.store.transaction(() => hub.delivery.admit()), []);
  // A delivery outcome with no hub entry to mirror into is not pending work either.
  hub.store.remove('merge-entry', 'mq_test');
  assert.deepEqual(await hub.store.transaction(() => hub.delivery.admit()), []);
});

test('a second, different result for a speculative job keeps the recorded result instead of failing every retry (L2)', async t => {
  const { hub, queue } = await preparedQueue(t);
  const job = { ...queue.state.jobs[0], status: 'running', attempt: 1, delivery: { queueId: 'dq_test', mergeEntryIds: ['mq_test'] } };
  hub.store.put('job', job);
  hub.delivery.record({ ...job }, { status: 'passed' });
  // The hub request that sent "passed" rolled back after delivery committed it; the node's retry reports differently.
  const retry = { ...job, status: 'failed' }; hub.store.put('job', retry);
  assert.doesNotThrow(() => hub.delivery.record(retry, { status: 'failed' }));
  assert.equal(hub.store.get('job', job.id).status, 'passed'); assert.equal(queue.state.jobs[0].status, 'passed');
});
