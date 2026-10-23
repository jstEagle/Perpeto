import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createHub } from '../src/index.js';

const run = promisify(execFile);
const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@perpeto.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];
const git = async (cwd, ...args) => (await run('git', [...identity, ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(fn, message = 'Condition did not become true.') {
  for (let attempt = 0; attempt < 400; attempt++) { const value = await fn(); if (value) return value; await sleep(25); }
  assert.fail(message);
}

/** A temporary bare repository with one commit on main, and a working clone that pushes branches to it. */
async function repository(root) {
  const bare = join(root, 'project.git'); const work = join(root, 'project-work');
  await run('git', ['init', '--bare', '--initial-branch=main', bare]);
  await run('git', ['clone', bare, work]);
  await writeFile(join(work, 'README.md'), '# Fixture\n'); await git(work, 'add', '.'); await git(work, 'commit', '-m', 'Initial'); await git(work, 'push', 'origin', 'HEAD:main');
  return {
    bare,
    async branch(branch) {
      const file = `${branch.replaceAll('/', '-')}.txt`;
      await git(work, 'fetch', 'origin'); await git(work, 'checkout', '-B', branch, 'origin/main');
      await writeFile(join(work, file), `${branch}\n`); await git(work, 'add', file); await git(work, 'commit', '-m', branch); await git(work, 'push', '--force', 'origin', `HEAD:refs/heads/${branch}`);
      return { branch, prUrl: `local:${branch}`, headSha: await git(work, 'rev-parse', 'HEAD') };
    },
    /** Commit the repository merge queue file on main. */
    async commitConfig(contents) {
      await git(work, 'fetch', 'origin'); await git(work, 'checkout', '-B', 'main', 'origin/main');
      await mkdir(join(work, '.perpeto'), { recursive: true });
      await writeFile(join(work, '.perpeto', 'merge-queue.json'), typeof contents === 'string' ? contents : JSON.stringify(contents));
      await git(work, 'add', '.perpeto'); await git(work, 'commit', '-m', 'Queue config'); await git(work, 'push', 'origin', 'HEAD:main');
    },
    files: async () => (await git(bare, 'ls-tree', '--name-only', 'main')).split('\n'),
  };
}

const node = (id, type, config = {}) => ({ id, type, label: id, position: { x: 0, y: 0 }, config });
const flow = (from, to, port) => ({ id: `${from}-${port ?? 'next'}-${to}`, kind: 'flow', from: { node: from, ...(port ? { port } : {}) }, to: { node: to } });
const graph = merge => ({ schema: 'perpeto.workflow/1', nodes: [
  node('ideas', 'input', { source: 'manual' }), node('builder', 'agent', { harness: { provider: 'codex', model: 'test' }, prompt: 'Build it.', concurrency: 4 }),
  node('merge', 'merge-queue', merge), node('done', 'output'),
], edges: [flow('ideas', 'builder'), flow('builder', 'merge'), flow('merge', 'done', 'pass'), flow('merge', 'done', 'fail')] });

async function queueHub(t) {
  const root = await mkdtemp(join(tmpdir(), 'perpeto-hub-merge-queues-'));
  const configPath = join(root, 'hub.json');
  await writeFile(configPath, JSON.stringify({ port: 0, longPollMs: 0, maintenanceIntervalMs: 20, heartbeatIntervalMs: 60000, deliveryMaxStepFailures: 2, deliveryRetryBackoffMs: 1 }));
  const hub = await createHub({ configPath }); const url = await hub.listen();
  t.after(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });
  const owner = (await readFile(join(root, 'owner.secret'), 'utf8')).trim();
  const raw = async (method, path, body, token = owner) => {
    const response = await fetch(`${url}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const request = async (method, path, body, token) => {
    const { status, data } = await raw(method, path, body, token);
    assert.ok(status < 300, `${method} ${path} -> ${status} ${JSON.stringify(data)}`);
    return data;
  };
  const code = (await request('POST', '/machines/enrollment-codes', {})).code;
  const machine = await request('POST', '/nodes/enroll', { code, name: 'machine', os: 'linux', arch: 'x64', providers: ['codex'], version: 'test' });
  await request('POST', '/nodes/heartbeat', { status: 'online', capacity: { maxAgents: 4, maxJobs: 4 }, running: { agents: 0, jobs: 0 }, providers: ['codex'] }, machine.token);
  const lease = async kind => (await request('POST', '/nodes/lease', { kinds: [kind], max: 1 }, machine.token))[kind === 'job' ? 'jobs' : 'assignments'][0];
  const events = async () => (await request('GET', '/events?limit=1000')).events;
  return {
    root, raw, request, lease, events,
    async start(project, merge, items = 1) {
      const workflow = await request('POST', `/projects/${project.id}/workflows`, { name: 'Merge', graph: graph(merge) });
      await request('POST', `/workflows/${workflow.id}/activate`, { version: 1 });
      return request('POST', `/workflows/${workflow.id}/runs`, { input: { items: Array.from({ length: items }, (_, index) => ({ title: `Change ${index + 1}` })) } });
    },
    async build(pr) {
      const assignment = await eventually(() => lease('assignment'), 'no builder assignment');
      await request('POST', `/assignments/${assignment.id}/events`, { attempt: assignment.attempt, type: 'completed', data: { outcome: 'success', summary: 'Built.', ...pr } }, machine.token);
      return assignment;
    },
    async pass() {
      const job = await eventually(() => lease('job'), 'no speculative job');
      await request('POST', `/jobs/${job.id}/events`, { attempt: job.attempt, type: 'completed', data: { status: 'passed', revision: job.revision, configHash: job.configHash } }, machine.token);
      return job;
    },
    entries: async project => (await request('GET', `/projects/${project.id}/merge-queue`)).entries,
  };
}

const mainQueue = { name: 'main', strategy: 'batch', maxBatchSize: 4, method: 'squash',
  lanes: [{ name: 'hotfix', priority: 100, branches: ['hotfix/*'] }, { name: 'normal', priority: 50 }, { name: 'dependencies', priority: 10, branches: ['deps/*'] }], defaultLane: 'normal' };

test('project merge queue settings validate inline, version, and merge the committed repository file', async t => {
  const h = await queueHub(t); const repo = await repository(h.root);
  const project = await h.request('POST', '/projects', { name: 'Queues', repo: { url: repo.bare, defaultBranch: 'main' } });
  const empty = await h.request('GET', `/projects/${project.id}/merge-queues`);
  assert.equal(empty.version, 0); assert.deepEqual(empty.effective.queues, []); assert.equal(empty.repo.found, false);

  const invalid = await h.raw('PUT', `/projects/${project.id}/merge-queues`, { config: { version: 1, queues: [{ name: 'main', strategy: 'parallel', flakyRetries: 9 }] }, idempotencyKey: 'bad' });
  assert.equal(invalid.status, 400); assert.equal(invalid.data.error.code, 'INVALID_MERGE_QUEUE_CONFIG');
  assert.deepEqual(invalid.data.error.details.map(error => error.path).sort(), ['$.queues[0].flakyRetries', '$.queues[0].strategy']);

  const saved = await h.request('PUT', `/projects/${project.id}/merge-queues`, { config: { version: 1, queues: [mainQueue, { name: 'release', branches: ['release/*'] }] }, baseVersion: 0, idempotencyKey: 'save-1' });
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.queues.map(queue => [queue.name, queue.kind, queue.source]), [['main', 'project', 'hub'], ['release', 'project', 'hub']]);
  assert.ok(saved.queues.every(queue => /^mqn_/.test(queue.id)));
  assert.deepEqual(await h.request('PUT', `/projects/${project.id}/merge-queues`, { config: { version: 1, queues: [mainQueue, { name: 'release', branches: ['release/*'] }] }, baseVersion: 0, idempotencyKey: 'save-1' }), saved);
  const stale = await h.raw('PUT', `/projects/${project.id}/merge-queues`, { config: { version: 1, queues: [] }, baseVersion: 0, idempotencyKey: 'save-stale' });
  assert.equal(stale.status, 409); assert.equal(stale.data.error.code, 'VERSION_CONFLICT');

  await repo.commitConfig({ version: 1, queues: [{ name: 'main', maxBatchSize: 2, flakyRetries: 1 }, { name: 'docs', branches: ['docs'] }] });
  const merged = await h.request('GET', `/projects/${project.id}/merge-queues`);
  assert.equal(merged.repo.found, true); assert.equal(merged.repo.applied, true); assert.match(merged.repo.revision, /^[0-9a-f]{40}$/);
  const main = merged.effective.queues.find(queue => queue.name === 'main');
  assert.deepEqual([main.strategy, main.maxBatchSize, main.flakyRetries, main.lanes.length], ['batch', 2, 1, 3]);
  assert.deepEqual(merged.queues.map(queue => [queue.name, queue.source]), [['main', 'merged'], ['release', 'hub'], ['docs', 'repo']]);
  assert.equal(merged.config.queues.length, 2, 'the hub document itself is unchanged');

  await repo.commitConfig({ version: 1, queues: [{ name: 'main', strategy: 'sideways' }] });
  const rejected = await h.request('GET', `/projects/${project.id}/merge-queues`);
  assert.equal(rejected.repo.applied, false); assert.equal(rejected.repo.errors[0].path, '$.queues[0].strategy');
  assert.equal(rejected.effective.queues.find(queue => queue.name === 'main').maxBatchSize, 4);
  await repo.commitConfig('{ not json');
  assert.equal((await h.request('GET', `/projects/${project.id}/merge-queues`)).repo.error, 'The file is not valid JSON.');
  const types = (await h.events()).map(event => event.type);
  assert.equal(types.filter(type => type === 'merge-queue.config-updated').length, 1);
});

test('a workflow node naming a project queue gets its lanes, freeze, live view and owner commands', async t => {
  const h = await queueHub(t); const repo = await repository(h.root);
  const project = await h.request('POST', '/projects', { name: 'Queues', repo: { url: repo.bare, defaultBranch: 'main' } });
  // The node names a queue that does not exist yet: its entry waits, blocked, until the queue is configured.
  const runs = await h.start(project, { queue: 'main' }, 3);
  await h.build(await repo.branch('feature-a'));
  const blocked = await eventually(async () => (await h.entries(project)).find(entry => entry.deliveryError), 'entry blocked on the missing queue');
  assert.match(blocked.deliveryError, /No project merge queue is named "main"/);

  const saved = await h.request('PUT', `/projects/${project.id}/merge-queues`, { config: { version: 1, queues: [mainQueue] }, idempotencyKey: 'save' });
  const queueId = saved.queues[0].id;
  await h.request('POST', `/merge-queues/${queueId}/freeze`, { reason: 'Release in progress', idempotencyKey: 'freeze-1' });
  await h.build(await repo.branch('deps/bump'));
  await h.build(await repo.branch('hotfix/login'));
  await eventually(async () => (await h.entries(project)).filter(entry => entry.queueId).length === 3, 'all three admitted');

  let view = await h.request('GET', `/merge-queues/${queueId}`);
  assert.equal(view.frozen.reason, 'Release in progress');
  assert.deepEqual(view.entries.map(entry => [entry.headBranch, entry.lane, entry.status]),
    [['hotfix/login', 'hotfix', 'queued'], ['feature-a', 'normal', 'queued'], ['deps/bump', 'dependencies', 'queued']]);
  assert.equal(await h.lease('job'), undefined, 'a frozen queue starts no CI');

  // Owner commands: send the dependency bump to the hotfix lane, and eject the feature.
  const deps = view.entries.find(entry => entry.headBranch === 'deps/bump');
  const prioritized = await h.request('POST', `/merge-entries/${deps.id}/priority`, { lane: 'hotfix', idempotencyKey: 'prio-1' });
  assert.equal(prioritized.lane, 'hotfix');
  const feature = view.entries.find(entry => entry.headBranch === 'feature-a');
  const ejected = await h.request('POST', `/merge-entries/${feature.id}/eject`, { reason: 'Superseded', idempotencyKey: 'eject-1' });
  assert.equal(ejected.status, 'rejected'); assert.equal(ejected.cause, 'manual'); assert.equal(ejected.reason, 'Superseded');
  const ejectedAgain = await h.raw('POST', `/merge-entries/${feature.id}/eject`, { idempotencyKey: 'eject-2' });
  assert.equal(ejectedAgain.status, 409);
  view = await h.request('GET', `/merge-queues/${queueId}`);
  assert.deepEqual(view.entries.map(entry => entry.headBranch), ['deps/bump', 'hotfix/login']);

  await h.request('POST', `/merge-queues/${queueId}/unfreeze`, { idempotencyKey: 'unfreeze-1' });
  const job = await h.pass();
  assert.equal(job.delivery.mergeEntryIds.length, 2, 'both remaining entries test as one batch');
  await eventually(async () => (await h.entries(project)).filter(entry => entry.status === 'merged').length === 2, 'batch merged');
  const files = await repo.files();
  assert.ok(files.includes('deps-bump.txt') && files.includes('hotfix-login.txt') && !files.includes('feature-a.txt'));
  await eventually(async () => (await h.request('GET', `/runs/${runs.id}`)).status !== 'running' || (await h.request('GET', `/runs/${runs.id}/work-items`)).workItems.every(item => ['done', 'failed'].includes(item.status)), 'run settled');

  view = await h.request('GET', `/merge-queues/${queueId}?window=24h`);
  assert.equal(view.frozen, null);
  assert.equal(view.metrics.merged, 2); assert.equal(view.metrics.rejected, 1);
  assert.deepEqual(view.metrics.failuresByReason.map(item => item.cause), ['manual']);
  assert.deepEqual(view.metrics.batches, { total: 1, succeeded: 1, successRate: 1 });
  assert.equal(view.recent.length, 3);
  const types = new Set((await h.events()).map(event => event.type));
  for (const type of ['merge-queue.frozen', 'merge-queue.unfrozen', 'merge-entry.prioritized', 'merge-entry.ejected', 'merge-queue.config-updated']) assert.ok(types.has(type), type);
  const list = await h.request('GET', `/projects/${project.id}/merge-queues`);
  assert.equal(list.queues[0].counts.queued, 0);
  const badWindow = await h.raw('GET', `/merge-queues/${queueId}?window=2y`);
  assert.equal(badWindow.status, 400);
  assert.equal((await h.raw('GET', '/merge-queues/mqn_missing')).status, 404);
});

test('required approvals refuse entries without passing reviews; workflow queues still appear and can freeze', async t => {
  const h = await queueHub(t); const repo = await repository(h.root);
  const project = await h.request('POST', '/projects', { name: 'Queues', repo: { url: repo.bare, defaultBranch: 'main' } });
  await h.request('PUT', `/projects/${project.id}/merge-queues`, { config: { version: 1, queues: [{ name: 'main', requiredApprovals: 1 }] }, idempotencyKey: 'save' });
  const gated = await h.start(project, { queue: 'main' });
  await h.build(await repo.branch('unreviewed'));
  // The queue refuses the entry at admission and hands it back to its run, which takes the fail route and finishes.
  const refused = await eventually(async () => (await h.entries(project)).find(entry => entry.runId === gated.id && entry.deliveryRejected), 'unreviewed entry refused');
  assert.match(refused.deliveryError, /APPROVALS_REQUIRED: This queue needs 1 approving review; the change has 0/);
  await eventually(async () => (await h.request('GET', `/runs/${gated.id}`)).status === 'completed', 'gated run finished');

  // A classic inline node keeps working exactly as before, and its queue is listed as a workflow queue.
  const inline = await h.start(project, { strategy: 'serial', method: 'squash', requiredChecks: [] });
  await h.build(await repo.branch('inline'));
  const entry = await eventually(async () => (await h.entries(project)).find(value => value.runId === inline.id && value.jobId), 'inline entry testing');
  const listed = await h.request('GET', `/projects/${project.id}/merge-queues`);
  const workflowQueue = listed.queues.find(queue => queue.kind === 'workflow');
  assert.equal(workflowQueue.id, entry.queueId); assert.equal(workflowQueue.counts.testing, 1);
  await h.request('POST', `/merge-queues/${workflowQueue.id}/freeze`, { idempotencyKey: 'freeze-inline' });
  await h.pass();
  await sleep(200);
  const held = (await h.entries(project)).find(value => value.id === entry.id);
  assert.equal(held.status, 'testing', 'publication waits while frozen');
  assert.equal((await h.request('GET', `/merge-queues/${workflowQueue.id}`)).frozen.kind, 'manual');
  await h.request('POST', `/merge-queues/${workflowQueue.id}/unfreeze`, { idempotencyKey: 'unfreeze-inline' });
  await eventually(async () => (await h.entries(project)).find(value => value.id === entry.id).status === 'merged', 'inline merged after unfreeze');
});
