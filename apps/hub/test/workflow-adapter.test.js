import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHub } from '../src/index.js';
import { createWorkflowAdapter } from '../src/engine/workflow-adapter.js';
import { step } from '@perpeto/workflow';

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
  const graph = JSON.parse(await readFile(new URL(import.meta.resolve('@perpeto/workflow/templates/build.json')), 'utf8'));
  const merge = graph.nodes.find(node => node.type === 'merge-queue'); const adapter = createWorkflowAdapter();
  for (const publication of ['fast-forward-push', 'github-merge-queue']) {
    merge.config.publication = publication; merge.config.strategy = 'serial';
    assert.equal(adapter.validate(graph).valid, true);
  }
  merge.config.strategy = 'batch'; assert.equal(adapter.validate(graph).valid, false);
  merge.config.publication = 'invalid'; assert.equal(adapter.validate(graph).valid, false);
});

const node = (id, type, config = {}) => ({ id, type, label: id, position: { x: 0, y: 0 }, config });
const flow = (from, to, port) => ({ id: `${from}-${port ?? 'next'}-${to}`, kind: 'flow', from: { node: from, ...(port ? { port } : {}) }, to: { node: to } });

/** A hub on the real engine adapter with one enrolled machine that leases agents and jobs. */
async function engineHub(t, { engine = createWorkflowAdapter() } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'perpeto-hub-engine-'));
  const configPath = join(directory, 'hub.json');
  await writeFile(configPath, JSON.stringify({ port: 0, longPollMs: 0, maintenanceIntervalMs: 20, heartbeatIntervalMs: 60000 }));
  let hub = await createHub({ configPath, engine }); let url = await hub.listen();
  t.after(async () => { await hub.close(); await rm(directory, { recursive: true, force: true }); });
  const owner = (await readFile(join(directory, 'owner.secret'), 'utf8')).trim();
  const request = async (method, path, body, token = owner) => {
    const response = await fetch(`${url}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const code = (await request('POST', '/machines/enrollment-codes', {})).body.code;
  const machine = (await request('POST', '/nodes/enroll', { code, name: 'machine', os: 'linux', arch: 'x64', providers: ['codex'], version: 'test' })).body;
  await request('POST', '/nodes/heartbeat', { status: 'online', capacity: { maxAgents: 1, maxJobs: 1 }, running: { agents: 0, jobs: 0 }, providers: ['codex'] }, machine.token);
  const project = (await request('POST', '/projects', { name: 'Adapter', repo: { url: '/tmp/unused.git', defaultBranch: 'main' } })).body;
  return {
    request, token: machine.token, directory,
    async restart() { await hub.close(); hub = await createHub({ configPath, engine }); url = await hub.listen(); },
    async start(value, items = [{ title: 'Feature' }]) {
      const workflow = (await request('POST', `/projects/${project.id}/workflows`, { name: 'Flow', graph: value })).body;
      assert.equal((await request('POST', `/workflows/${workflow.id}/activate`, { version: 1 })).status, 200, JSON.stringify(workflow));
      return (await request('POST', `/workflows/${workflow.id}/runs`, { input: { items } })).body;
    },
    lease: async kind => (await request('POST', '/nodes/lease', { kinds: [kind], max: 1 }, machine.token)).body[kind === 'job' ? 'jobs' : 'assignments'][0],
    finish: (assignment, data) => request('POST', `/assignments/${assignment.id}/events`, { attempt: assignment.attempt, type: data.outcome === 'failure' ? 'failed' : 'completed', data }, machine.token),
  };
}

test('cancelling a run CI job reports the cancelled attempt to the engine, which retries it and finishes the run (H4)', async t => {
  const hub = await engineHub(t);
  const run = await hub.start({ schema: 'perpeto.workflow/1', nodes: [
    node('ideas', 'input', { source: 'manual' }), node('builder', 'agent', { harness, prompt: 'Build it.' }),
    node('ci', 'ci', { steps: [{ name: 'test', run: 'true' }], retry: { maxAttempts: 3, backoffSec: 0 } }), node('done', 'output'),
  ], edges: [flow('ideas', 'builder'), flow('builder', 'ci'), flow('ci', 'done', 'pass'), flow('ci', 'done', 'fail')] });
  const build = await hub.lease('assignment');
  assert.equal((await hub.finish(build, { outcome: 'success', summary: 'Built.', branch: 'feature', headSha: 'a'.repeat(40) })).status, 200);
  const first = await hub.lease('job'); assert.ok(first);
  assert.equal((await hub.request('POST', `/jobs/${first.id}/cancel`, {})).body.status, 'cancelled');
  // The node's cancellation acknowledgement is accepted and does not report the attempt a second time.
  const ack = await hub.request('POST', `/jobs/${first.id}/events`, { attempt: first.attempt, type: 'completed', data: { status: 'cancelled', revision: first.revision, configHash: first.configHash } }, hub.token);
  assert.equal(ack.status, 200);
  const retry = await hub.lease('job');
  assert.ok(retry, 'the engine queued another CI attempt'); assert.notEqual(retry.id, first.id); assert.equal(retry.revision, first.revision);
  assert.equal((await hub.request('POST', `/jobs/${retry.id}/events`, { attempt: retry.attempt, type: 'completed', data: { status: 'passed', revision: retry.revision, configHash: retry.configHash } }, hub.token)).status, 200);
  assert.equal((await hub.request('GET', `/runs/${run.id}`)).body.status, 'completed');
  const events = (await hub.request('GET', '/events?limit=1000')).body.events.filter(event => event.runId === run.id);
  assert.equal(events.filter(event => event.type === 'workitem.retried' && event.data.reason === 'job_cancelled').length, 1);
});

test('results the engine would reject become explicit failures the engine retries, never a lost 400 (M1)', async t => {
  const hub = await engineHub(t);
  const run = await hub.start({ schema: 'perpeto.workflow/1', nodes: [
    node('ideas', 'input', { source: 'manual' }), node('builder', 'agent', { harness, prompt: 'Build it.', retry: { maxAttempts: 3, backoffSec: 0 } }), node('done', 'output'),
  ], edges: [flow('ideas', 'builder'), flow('builder', 'done')] });
  for (const invalid of [{ headSha: 'abc1234' }, { branch: 'b'.repeat(300) }]) {
    const build = await hub.lease('assignment');
    const response = await hub.finish(build, { outcome: 'success', summary: 'Pushed my change.', branch: 'feature', ...invalid });
    assert.equal(response.status, 200); assert.equal(response.body.status, 'failed'); assert.match(response.body.reason, /result\.(headSha|branch)/);
    const stored = (await hub.request('GET', `/assignments/${build.id}`)).body;
    assert.equal(stored.status, 'failed'); assert.equal(stored.result.outcome, 'failure');
    assert.match(stored.result.summary, /Pushed my change\./); assert.match(stored.result.summary, /result\.(headSha|branch)/);
  }
  const last = await hub.lease('assignment'); assert.equal(last.attempt, 3);
  assert.equal((await hub.finish(last, { outcome: 'success', summary: 'Fixed.', branch: 'feature', headSha: 'b'.repeat(40) })).status, 200);
  assert.equal((await hub.request('GET', `/runs/${run.id}`)).body.status, 'completed');

  const planned = await hub.start({ schema: 'perpeto.workflow/1', nodes: [
    node('ideas', 'input', { source: 'manual' }), node('planner', 'planner', { harness, prompt: 'Plan.', maxItems: 4, retry: { maxAttempts: 2, backoffSec: 0 } }), node('done', 'output'),
  ], edges: [flow('ideas', 'planner'), flow('planner', 'done')] });
  const plan = await hub.lease('assignment');
  const response = await hub.finish(plan, { outcome: 'success', summary: 'Two items.', items: [{ title: 'One', body: null }, { title: 't'.repeat(201) }] });
  assert.equal(response.status, 200); assert.equal(response.body.status, 'failed');
  const retry = await hub.lease('assignment'); assert.equal(retry.retryOf, plan.id);
  assert.equal((await hub.request('GET', `/runs/${planned.id}`)).body.status, 'running');
});

test('escalations are not logged as unplanned flow moves without endpoints (L4)', async t => {
  const hub = await engineHub(t);
  const run = await hub.start({ schema: 'perpeto.workflow/1', nodes: [
    node('ideas', 'input', { source: 'manual' }), node('builder', 'agent', { harness, prompt: 'Build it.', onExhausted: 'senior' }),
    node('senior', 'agent', { harness, prompt: 'Take over.' }), node('done', 'output'),
  ], edges: [flow('ideas', 'builder'), flow('builder', 'done'), flow('senior', 'done')] });
  const build = await hub.lease('assignment');
  assert.equal((await hub.finish(build, { outcome: 'failure', summary: 'Stuck.' })).status, 200);
  const senior = await hub.lease('assignment'); assert.equal(senior.nodeId, 'senior');
  const events = (await hub.request('GET', '/events?limit=1000')).body.events.filter(event => event.runId === run.id);
  assert.equal(events.filter(event => event.type === 'workitem.escalated').length, 1);
  assert.deepEqual(events.filter(event => event.type === 'workitem.moved' && event.data.unplanned), []);
  const metrics = (await hub.request('GET', `/runs/${run.id}/metrics?window=1h`)).body;
  assert.deepEqual(metrics.edges.filter(edge => edge.unplanned), []);
  assert.equal(metrics.nodes.find(value => value.nodeId === 'builder').escalations, 1, 'escalations are still counted, at their node');
});

const humanGates = { schema: 'perpeto.workflow/1', nodes: [
  node('ideas', 'input', { source: 'manual' }), node('design', 'human', { prompt: 'Approve the design.' }),
  node('release', 'human', { prompt: 'Approve the release.' }), node('done', 'output'),
], edges: [flow('ideas', 'design'), flow('design', 'release', 'pass'), flow('design', 'done', 'fail'), flow('release', 'done', 'pass'), flow('release', 'done', 'fail')] };

test('a human decision is bound to the gate it answers by decisionId, so a repeat cannot pass the next gate (M4)', async t => {
  const hub = await engineHub(t);
  const run = await hub.start(humanGates);
  const item = (await hub.request('GET', `/runs/${run.id}/work-items`)).body.workItems[0];
  assert.equal(item.status, 'blocked'); assert.equal(item.nodeId, 'design'); assert.match(item.decisionId, /^hd_/);
  const requested = (await hub.request('GET', '/events?limit=1000')).body.events.filter(event => event.type === 'human.requested');
  assert.equal(requested.length, 1); assert.equal(requested[0].data.decisionId, item.decisionId);
  const decide = body => hub.request('POST', `/work-items/${item.id}/decision`, body);
  assert.equal((await decide({ decision: 'pass', decisionId: item.decisionId })).status, 200);
  const next = (await hub.request('GET', `/runs/${run.id}/work-items`)).body.workItems[0];
  assert.equal(next.nodeId, 'release'); assert.notEqual(next.decisionId, item.decisionId);
  // A client retry, or a second person answering the design gate, must not approve the release.
  const stale = await decide({ decision: 'pass', decisionId: item.decisionId });
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'STALE_DECISION');
  assert.equal((await hub.request('GET', `/runs/${run.id}/work-items`)).body.workItems[0].nodeId, 'release');
  assert.equal((await hub.request('POST', `/work-items/${item.id}/decision`, { decision: 'pass', decisionId: 7 })).status, 400);
  assert.equal((await decide({ decision: 'pass', decisionId: next.decisionId })).status, 200);
  assert.equal((await hub.request('GET', `/runs/${run.id}`)).body.status, 'completed');
  const gates = (await hub.request('GET', '/events?limit=1000')).body.events.filter(event => event.type === 'gate.result' && event.data.source === 'human');
  assert.deepEqual(gates.map(event => event.data.decisionId), [item.decisionId, next.decisionId]);
});

/** Read a hub-owned SQLite file while the hub runs. */
function query(file, sql, ...args) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
}

test('run state lives in the workflow RunStore; the hub keeps only a sequence per run and work items read from it (M15)', async t => {
  const hub = await engineHub(t);
  const items = Array.from({ length: 60 }, (_, index) => ({ title: `Item ${index}`, body: 'x'.repeat(4096) }));
  const run = await hub.start({ schema: 'perpeto.workflow/1', nodes: [
    node('ideas', 'input', { source: 'manual' }), node('builder', 'agent', { harness, prompt: 'Build it.', concurrency: 1 }), node('done', 'output'),
  ], edges: [flow('ideas', 'builder'), flow('builder', 'done')] }, items);
  const hubState = query(join(hub.directory, 'hub.sqlite'), "SELECT data FROM entities WHERE kind='engine-state' AND id=?", run.id);
  assert.equal(hubState.length, 1); assert.ok(hubState[0].data.length < 200, `hub engine-state is ${hubState[0].data.length} bytes`);
  assert.deepEqual(Object.keys(JSON.parse(hubState[0].data)).sort(), ['id', 'seq']);
  assert.equal(query(join(hub.directory, 'workflow.sqlite'), 'SELECT COUNT(*) AS count FROM work_items WHERE run_id=?', run.id)[0].count, 60);
  for (const suffix of ['', '-wal']) assert.equal((await stat(join(hub.directory, `workflow.sqlite${suffix}`))).mode & 0o777, 0o600);
  const listed = (await hub.request('GET', `/runs/${run.id}/work-items`)).body.workItems;
  assert.equal(listed.length, 60); assert.equal(listed[0].projectId, run.projectId); assert.equal(listed[0].body.length, 4096);
  const build = await hub.lease('assignment');
  assert.equal((await hub.finish(build, { outcome: 'success', summary: 'Built.' })).status, 200);
  await hub.restart();
  assert.equal((await hub.request('GET', `/runs/${run.id}/work-items`)).body.workItems.filter(item => item.status === 'done').length, 1);
  const second = await hub.lease('assignment'); assert.ok(second); assert.notEqual(second.id, build.id);
  const seq = query(join(hub.directory, 'workflow.sqlite'), 'SELECT last_seq FROM runs WHERE id=?', run.id)[0].last_seq;
  assert.equal(JSON.parse(query(join(hub.directory, 'hub.sqlite'), "SELECT data FROM entities WHERE kind='engine-state' AND id=?", run.id)[0].data).seq, seq);
  const metrics = (await hub.request('GET', `/runs/${run.id}/metrics?window=1h`)).body;
  assert.equal(metrics.nodes.find(value => value.nodeId === 'builder').done, 1);
});

test('effects the RunStore committed are applied after the hub transaction that carried them rolls back (M15)', async t => {
  const engine = createWorkflowAdapter(); const applyEvent = engine.applyEvent.bind(engine); let fail = true;
  engine.applyEvent = input => {
    const result = applyEvent(input);
    if (fail && input.event.type === 'input') { fail = false; throw new Error('Simulated hub failure after the engine committed.'); }
    return result;
  };
  const hub = await engineHub(t, { engine });
  const run = await hub.start({ schema: 'perpeto.workflow/1', nodes: [
    node('ideas', 'input', { source: 'manual' }), node('builder', 'agent', { harness, prompt: 'Build it.', concurrency: 2 }), node('done', 'output'),
  ], edges: [flow('ideas', 'builder'), flow('builder', 'done')] }, [{ title: 'First' }]);
  assert.equal((await hub.request('POST', `/runs/${run.id}/inputs`, { items: [{ title: 'Second' }] })).status, 500);
  // Maintenance applies the outbox effects the hub missed; nothing is applied twice.
  const assignments = await (async () => {
    for (let index = 0; index < 200; index++) {
      const value = (await hub.request('GET', `/runs/${run.id}/assignments`)).body.assignments;
      if (value.length === 2) return value;
      await sleep(20);
    }
    assert.fail('missed effects were not applied');
  })();
  assert.equal(new Set(assignments.map(value => value.id)).size, 2);
  assert.equal((await hub.request('GET', `/runs/${run.id}/work-items`)).body.workItems.length, 2);
  await sleep(100);
  assert.equal(query(join(hub.directory, 'workflow.sqlite'), 'SELECT COUNT(*) AS count FROM effects WHERE acked_at IS NULL')[0].count, 0, 'outbox drained');
  assert.equal((await hub.request('GET', `/runs/${run.id}/assignments`)).body.assignments.length, 2);
});

test('runs whose whole engine state predates the RunStore keep advancing from the hub-held state (M15)', async t => {
  const hub = await engineHub(t);
  const started = await hub.start({ schema: 'perpeto.workflow/1', nodes: [
    node('ideas', 'input', { source: 'manual' }), node('builder', 'agent', { harness, prompt: 'Build it.' }), node('done', 'output'),
  ], edges: [flow('ideas', 'builder'), flow('builder', 'done')] }, [{ title: 'Current' }]);
  const db = new DatabaseSync(join(hub.directory, 'hub.sqlite')); t.after(() => { if (db.isOpen) db.close(); });
  const get = (kind, id) => JSON.parse(db.prepare('SELECT data FROM entities WHERE kind=? AND id=?').get(kind, id).data);
  const put = (kind, value) => db.prepare('INSERT INTO entities VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind, value.id, JSON.stringify(value));
  const legacyId = 'run_legacy00000000000000000000001';
  const run = { ...get('run', started.id), id: legacyId }; const workflow = get('run-workflow', started.id).workflow;
  const { state } = step(null, { id: `run:${legacyId}`, at: new Date().toISOString(), type: 'run.started', data: { runId: legacyId, projectId: run.projectId,
    workflowId: workflow.id, workflowVersion: workflow.version, graph: workflow.graph, repo: { url: '/tmp/unused.git', defaultBranch: 'main' } } });
  put('run', run); put('run-workflow', { id: legacyId, workflow }); put('engine-state', { id: legacyId, state });
  db.close();
  assert.equal((await hub.request('POST', `/runs/${legacyId}/inputs`, { items: [{ title: 'Legacy' }] })).status, 202);
  const items = (await hub.request('GET', `/runs/${legacyId}/work-items`)).body.workItems;
  assert.deepEqual(items.map(item => item.title), ['Legacy']); assert.equal(items[0].projectId, run.projectId);
  assert.equal((await hub.request('GET', `/runs/${legacyId}/assignments`)).body.assignments.length, 1);
  const stored = JSON.parse(query(join(hub.directory, 'hub.sqlite'), "SELECT data FROM entities WHERE kind='engine-state' AND id=?", legacyId)[0].data);
  assert.equal(Object.keys(stored.state.workItems).length, 1, 'the legacy run keeps its state in the hub');
  assert.equal(query(join(hub.directory, 'workflow.sqlite'), 'SELECT COUNT(*) AS count FROM runs WHERE id=?', legacyId)[0].count, 0);
});

test('merge rejection kind uses the engine conflict-recovery contract', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'perpeto-rejection-'));
  const path = join(directory, 'workflow.sqlite');
  const adapter = createWorkflowAdapter(); adapter.open({ databasePath: path });
  t.after(async () => { adapter.close(); await rm(directory, { recursive: true, force: true }); });
  const { DatabaseSync } = await import('node:sqlite');
  const value = { schema: 'perpeto.workflow/1', nodes: [
    node('input', 'input', { source: 'manual' }), node('builder', 'agent', { harness, prompt: 'Build.' }),
    node('merge', 'merge-queue', { strategy: 'serial', method: 'squash', requiredChecks: [] }), node('done', 'output'),
  ], edges: [flow('input', 'builder'), flow('builder', 'merge'), flow('merge', 'done', 'pass'), flow('merge', 'done', 'fail')] };
  const workflow = { id: 'wf_test', version: 1, graph: value };
  for (const rejectionKind of ['conflict', 'ci', 'other']) {
    const run = { id: `run_${rejectionKind}`, projectId: 'prj_test', status: 'running' };
    adapter.startRun({ run, workflow, input: { keepOpen: true, items: [{ title: 'Change' }] }, project: { repo: { url: '/tmp/unused', defaultBranch: 'main' } } });
    const assignment = Object.values(adapter.runState(run.id).assignments)[0];
    adapter.applyEvent({ run, workflow, event: { type: 'assignment.finished', assignmentId: assignment.id, value: assignment, data: { outcome: 'success', summary: 'Built.', branch: 'feature', prUrl: 'local:feature', headSha: 'a'.repeat(40) } } });
    const merge = Object.values(adapter.runState(run.id).merges)[0];
    adapter.applyEvent({ run, workflow, event: { type: 'merge.finished', mergeEntryId: merge.id, data: { status: 'rejected', reason: 'Rejected.', rejectionKind } } });
  }
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  const rows = db.prepare("SELECT event FROM run_events WHERE type='merge.rejected' ORDER BY seq").all();
  assert.deepEqual(rows.map(row => JSON.parse(row.event).data.kind), ['conflict', 'ci', 'other']);
});

test('conflict metrics aggregate across runs and rebase results skip review only on explicit false', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'perpeto-conflict-metrics-'));
  const adapter = createWorkflowAdapter(); adapter.open({ databasePath: join(directory, 'workflow.sqlite') });
  t.after(async () => { adapter.close(); await rm(directory, { recursive: true, force: true }); });
  const value = { schema: 'perpeto.workflow/1', nodes: [
    node('input', 'input', { source: 'manual' }), node('builder', 'agent', { harness, prompt: 'Build.' }),
    node('review', 'review', { harness, prompt: 'Review.' }), node('merge', 'merge-queue', { strategy: 'serial', method: 'squash', requiredChecks: [] }), node('done', 'output'),
  ], edges: [flow('input', 'builder'), flow('builder', 'review'), flow('review', 'merge', 'pass'), flow('review', 'builder', 'fail'), flow('merge', 'done', 'pass'), flow('merge', 'done', 'fail')] };
  // Use a loop for the review fail route so this is a valid graph.
  value.nodes.push(node('loop', 'loop', { until: 'review-pass', maxIterations: 3 }));
  value.edges.find(edge => edge.from.node === 'input').to.node = 'loop';
  value.edges.find(edge => edge.id === 'review-fail-builder').to.node = 'loop';
  value.edges.push(flow('loop', 'builder'));
  const workflow = { id: 'wf_test', version: 1, graph: value };
  const runs = [];
  for (let n = 0; n < 2; n++) {
    const run = { id: `run_metrics${n}`, projectId: 'prj_test', status: 'running' }; runs.push(run);
    adapter.startRun({ run, workflow, input: { keepOpen: true, items: [{ title: 'Change' }] }, project: { repo: { url: '/tmp/unused', defaultBranch: 'main' } } });
    const state = () => adapter.runState(run.id);
    const open = role => Object.values(state().assignments).find(assignment => assignment.nodeId === role && assignment.status === 'queued');
    const finish = (assignment, data) => adapter.applyEvent({ run, workflow, event: { type: 'assignment.finished', assignmentId: assignment.id, value: assignment, data } });
    const built = digit => ({ outcome: 'success', summary: 'Built.', branch: 'feature', prUrl: 'local:feature', headSha: String(digit).repeat(40) });
    finish(open('builder'), built(1)); finish(open('review'), { outcome: 'success', verdict: 'pass', summary: 'Approved.' });
    for (let conflict = 0; conflict < 2; conflict++) {
      const merge = Object.values(state().merges).find(entry => entry.status === 'queued');
      adapter.applyEvent({ run, workflow, event: { type: 'merge.finished', mergeEntryId: merge.id, data: { status: 'rejected', reason: 'Candidate rejected.', rejectionKind: 'conflict' } } });
      const rebase = open('builder'); assert.equal(rebase.step, 'rebase'); assert.equal(rebase.rebaseOf, merge.id);
      finish(rebase, { ...built(conflict + 2), rebaseTouchedBeyondConflicts: n === 1 });
      if (n === 0) assert.equal(open('review'), undefined, 'explicit conflict-only result bypasses repeated review');
      else {
        assert.ok(open('review'), 'behavior-changing evidence preserves the review path');
        finish(open('review'), { outcome: 'success', verdict: 'pass', summary: 'Re-reviewed.' });
      }
    }
  }
  const at = new Date().toISOString();
  const metrics = adapter.computeRunMetrics({ runs, events: [], machines: [], usage: [], window: '1h', at });
  assert.equal(metrics.run.conflictRejections, 4); assert.equal(metrics.run.rebases, 4);
  assert.equal(metrics.nodes.find(node => node.nodeId === 'merge').conflictRejections, 4);
  assert.equal(metrics.nodes.find(node => node.nodeId === 'builder').rebases, 4);
  assert.equal(metrics.bottlenecks.filter(value => value.reason === 'conflict-churn').length, 2);
});
