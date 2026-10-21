import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../src/index.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const harness = { provider: 'codex', model: 'test-model' };
const graph = {
  schema: 'perpeto.workflow/1',
  nodes: [
    { id: 'ideas', type: 'input', label: 'Ideas', position: { x: 0, y: 0 }, config: { source: 'manual' } },
    { id: 'loop', type: 'loop', label: 'Review loop', position: { x: 1, y: 0 }, config: { until: 'review-pass', maxIterations: 3 } },
    { id: 'builder', type: 'agent', label: 'Builder', position: { x: 2, y: 0 }, config: { harness, prompt: 'Build it.', retry: { maxAttempts: 2, backoffSec: 1 } } },
    { id: 'reviewer', type: 'review', label: 'Reviewer', position: { x: 3, y: 0 }, config: { harness, prompt: 'Review it.', retry: { maxAttempts: 2 } } },
    { id: 'done', type: 'output', label: 'Done', position: { x: 4, y: 0 }, config: {} },
  ],
  edges: [
    { id: 'ideas-loop', from: { node: 'ideas' }, to: { node: 'loop' }, kind: 'flow' },
    { id: 'loop-builder', from: { node: 'loop' }, to: { node: 'builder' }, kind: 'flow' },
    { id: 'builder-reviewer', from: { node: 'builder' }, to: { node: 'reviewer' }, kind: 'flow' },
    { id: 'reviewer-pass', from: { node: 'reviewer', port: 'pass' }, to: { node: 'done' }, kind: 'flow' },
    { id: 'reviewer-fail', from: { node: 'reviewer', port: 'fail' }, to: { node: 'loop' }, kind: 'flow' },
  ],
};

test('real engine adapter: lost leases and verdict-less reviews become engine retries that honour notBefore', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'perpeto-hub-engine-'));
  const configPath = join(directory, 'hub.json');
  await writeFile(configPath, JSON.stringify({ port: 0, longPollMs: 0, maintenanceIntervalMs: 20, leaseDurationMs: 300, heartbeatIntervalMs: 60000 }));
  const hub = await createHub({ configPath }); const url = await hub.listen();
  t.after(async () => { await hub.close(); await rm(directory, { recursive: true, force: true }); });
  const owner = (await readFile(join(directory, 'owner.secret'), 'utf8')).trim();
  const request = async (method, path, body, token = owner) => {
    const response = await fetch(`${url}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const code = (await request('POST', '/machines/enrollment-codes', {})).body.code;
  const node = (await request('POST', '/nodes/enroll', { code, name: 'machine', os: 'linux', arch: 'x64', providers: ['codex'], version: 'test' })).body;
  await request('POST', '/nodes/heartbeat', { status: 'online', capacity: { maxAgents: 1, maxJobs: 0 }, running: { agents: 0, jobs: 0 }, providers: ['codex'] }, node.token);
  const lease = async () => (await request('POST', '/nodes/lease', { kinds: ['assignment'], max: 1 }, node.token)).body.assignments[0];
  const finish = (assignment, data) => request('POST', `/assignments/${assignment.id}/events`, { attempt: assignment.attempt, type: data.outcome === 'failure' ? 'failed' : 'completed', data }, node.token);

  const project = (await request('POST', '/projects', { name: 'Adapter', repo: { url: '/tmp/unused.git', defaultBranch: 'main' } })).body;
  const workflow = (await request('POST', `/projects/${project.id}/workflows`, { name: 'Loop', graph })).body;
  assert.equal((await request('POST', `/workflows/${workflow.id}/validate`, {})).body.valid, true);
  await request('POST', `/workflows/${workflow.id}/activate`, { version: 1 });
  const run = (await request('POST', `/workflows/${workflow.id}/runs`, { input: { items: [{ title: 'Feature' }] } })).body;

  // The first build is leased and never renewed: the hub reports the lost lease, the engine schedules retry 2.
  const first = await lease(); assert.equal(first.nodeId, 'builder'); assert.equal(first.attempt, 1);
  let retry;
  for (let index = 0; index < 100 && !retry; index++) {
    await sleep(20);
    retry = (await request('GET', `/runs/${run.id}/assignments`)).body.assignments.find(value => value.retryOf === first.id);
  }
  assert.ok(retry, 'engine created a retry'); assert.equal(retry.attempt, 2); assert.ok(retry.notBefore);
  assert.equal((await request('GET', `/assignments/${first.id}`)).body.status, 'failed');
  assert.equal((await finish(first, { outcome: 'success', summary: 'Too late.' })).status, 409, 'the lost attempt is fenced off');
  if (Date.parse(retry.notBefore) - Date.now() > 100) assert.equal(await lease(), undefined, 'no lease before notBefore');
  await sleep(Math.max(0, Date.parse(retry.notBefore) - Date.now()) + 30);
  const second = await lease(); assert.equal(second.id, retry.id);
  await finish(second, { outcome: 'success', summary: 'Built.', branch: 'feature', headSha: 'a'.repeat(40) });

  // A review that succeeds without a verdict is an error the engine retries, not a pass and not a rejection.
  const review = await lease(); assert.equal(review.nodeId, 'reviewer'); assert.match(review.prompt, /verdict/);
  await finish(review, { outcome: 'success', summary: 'Looks fine.' });
  const reviewRetry = await lease(); assert.equal(reviewRetry.retryOf, review.id);
  await finish(reviewRetry, { outcome: 'success', verdict: 'pass', summary: 'Ready.' });

  assert.equal((await request('GET', `/runs/${run.id}`)).body.status, 'completed');
  const events = (await request('GET', '/events?limit=1000')).body.events.filter(event => event.runId === run.id);
  assert.deepEqual(events.filter(event => event.type === 'gate.result').map(event => event.data.result), ['error', 'pass']);
  assert.equal(events.filter(event => event.type === 'workitem.retried').length, 2);
  const metrics = (await request('GET', `/runs/${run.id}/metrics?window=1h`)).body;
  assert.equal(metrics.nodes.find(value => value.nodeId === 'builder').errors, 1);
  assert.equal(metrics.nodes.find(value => value.nodeId === 'reviewer').retries, 1);
});

test('hub validates merge publication before a workflow can reach delivery', async () => {
  const { createWorkflowAdapter } = await import('../src/engine/workflow-adapter.js');
  const { readFile } = await import('node:fs/promises');
  const graph = JSON.parse(await readFile(new URL('../../factory-workflow/templates/build.json', import.meta.url), 'utf8'));
  const merge = graph.nodes.find(node => node.type === 'merge-queue'); const adapter = createWorkflowAdapter();
  for (const publication of ['fast-forward-push', 'github-merge-queue']) {
    merge.config.publication = publication; merge.config.strategy = 'serial';
    assert.equal(adapter.validate(graph).valid, true);
  }
  merge.config.strategy = 'batch'; assert.equal(adapter.validate(graph).valid, false);
  merge.config.publication = 'invalid'; assert.equal(adapter.validate(graph).valid, false);
});
