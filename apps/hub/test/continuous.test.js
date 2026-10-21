import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../src/index.js';
import { listTemplates } from '@perpeto/workflow';

const graph = { schema: 'perpeto.workflow/1', nodes: [
  { id: 'input', type: 'input', label: 'Input', position: { x: 0, y: 0 }, config: { source: 'manual' } },
  { id: 'builder', type: 'agent', label: 'Builder', position: { x: 1, y: 0 }, config: { role: 'implementer', harness: { provider: 'codex', model: 'test' }, prompt: 'Build.' } },
  { id: 'output', type: 'output', label: 'Output', position: { x: 2, y: 0 }, config: {} },
], edges: [ ['input', 'builder'], ['builder', 'output'] ].map(([from, to]) => ({ id: `${from}-${to}`, kind: 'flow', from: { node: from }, to: { node: to } })) };

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'perpeto-intake-'));
  const configPath = join(dir, 'hub.json');
  await writeFile(configPath, JSON.stringify({ port: 0, maintenanceIntervalMs: 86400000, heartbeatIntervalMs: 86400000, longPollMs: 0 }));
  let app = await createHub({ configPath }); let url = await app.listen();
  const token = (await readFile(join(dir, 'owner.secret'), 'utf8')).trim();
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const request = async (method, path, body, auth = token) => {
    const response = await fetch(`${url}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const project = (await request('POST', '/projects', { name: 'Continuous', repo: { url: '/tmp/unused.git', defaultBranch: 'main' }, goals: ['Ship feature', 'Improve quality'] })).body;
  async function workflow(name = 'Build') {
    const result = await request('POST', `/projects/${project.id}/workflows`, { name, purpose: name === 'Build' ? 'build' : 'improve', graph });
    assert.equal(result.status, 201);
    await request('POST', `/workflows/${result.body.id}/activate`, { version: 1 });
    return result.body;
  }
  const wf = await workflow();
  const start = async (input, id = wf.id) => { const result = await request('POST', `/workflows/${id}/runs`, { input }); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body; };
  const items = async run => (await request('GET', `/runs/${run.id}/work-items`)).body.workItems;
  return { request, project, wf, workflow, start, items, get hub() { return app.hub; },
    tick: at => app.hub.maintenance(at),
    async restart() { await app.close(); app = await createHub({ configPath }); url = await app.listen(); },
    async machine() {
      const code = (await request('POST', '/machines/enrollment-codes', {})).body.code;
      const node = (await request('POST', '/nodes/enroll', { code, name: 'Worker', os: 'linux', arch: 'x64', providers: ['codex'], version: 'test' })).body;
      await request('POST', '/nodes/heartbeat', { status: 'online', capacity: { maxAgents: 4, maxJobs: 0 }, running: { agents: 0, jobs: 0 }, providers: ['codex'] }, node.token);
      return node;
    },
  };
}

test('templates, concurrent workflows, durable goal intake and minute scheduling', async t => {
  const f = await fixture(t);
  const templates = await f.request('GET', '/workflow-templates');
  assert.equal(templates.status, 200);
  assert.deepEqual(templates.body.templates.map(({ id, description }) => ({ id, description })), listTemplates());
  assert.ok(templates.body.templates.every(template => template.graph.schema === graph.schema));
  const build = await f.start({ keepOpen: true, source: 'goals' });
  const improve = await f.workflow('Improve');
  const audit = await f.start({ keepOpen: true, source: 'schedule', schedule: '* * * * *' }, improve.id);
  await f.tick(); await f.tick();
  const goals = await f.items(build);
  assert.equal(goals.length, 2);
  assert.ok(goals.every(item => item.goalId?.startsWith('goal_')));
  assert.deepEqual((await f.request('GET', `/projects/${f.project.id}`)).body.goals.map(goal => goal.workItemIds.length), [1, 1]);
  assert.match(goals[0].body, /goals|Goals/);
  assert.equal((await f.items(audit)).length, 1);
  await f.restart(); await f.tick();
  assert.equal((await f.items(build)).length, 2);
  assert.equal((await f.items(audit)).length, 1, 'restart does not repeat a scheduled minute');
  const next = new Date(Date.now() + 60000).toISOString();
  await f.tick(next); await f.tick(next);
  assert.equal((await f.items(audit)).length, 2);
  const duplicate = await f.start({ keepOpen: true, source: 'goals' }, improve.id);
  await f.tick(next);
  assert.equal((await f.items(duplicate)).length, 0, 'goals already active in another workflow are excluded');
  await f.request('POST', `/runs/${audit.id}/pause`, {});
  await f.tick(new Date(Date.now() + 120000).toISOString());
  assert.equal((await f.items(audit)).length, 2);
});

test('PATCH config survives restart, validates cron and changes live intake without replacing work', async t => {
  const f = await fixture(t);
  const run = await f.start({ keepOpen: true, items: [{ title: 'Existing' }] });
  assert.equal((await f.request('PATCH', `/runs/${run.id}`, { source: 'schedule', schedule: 'invalid' })).status, 400);
  const patched = await f.request('PATCH', `/runs/${run.id}`, { keepOpen: true, source: 'schedule', schedule: '* * * * *', budget: { maxActiveItems: 2 } });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  await f.tick();
  assert.equal((await f.items(run)).length, 2);
  await f.restart(); await f.tick();
  assert.equal((await f.items(run)).length, 2);
  assert.equal((await f.request('GET', `/runs/${run.id}`)).body.budget.maxActiveItems, 2);
  await f.request('PATCH', `/runs/${run.id}`, { source: 'manual', budget: {}, keepOpen: false });
  await f.tick(new Date(Date.now() + 60000).toISOString());
  assert.equal((await f.items(run)).length, 2);
});

test('ledger usage exhausts intake once, keeps manual batches and resumes next UTC day', async t => {
  const f = await fixture(t); const machine = await f.machine();
  const run = await f.start({ keepOpen: true, source: 'manual', budget: { maxTokensPerDay: 10, maxItemsPerDay: 3, maxActiveItems: 2 }, items: [{ title: 'First' }] });
  const assignment = (await f.request('POST', '/nodes/lease', { kinds: ['assignment'], max: 1 }, machine.token)).body.assignments[0];
  const usage = { attempt: assignment.attempt, type: 'usage', idempotencyKey: 'usage-one', data: { provider: 'codex', model: 'test', inputTokens: 7, outputTokens: 3, cacheReadTokens: 100 } };
  assert.equal((await f.request('POST', `/assignments/${assignment.id}/events`, usage, machine.token)).status, 200);
  await f.request('POST', `/assignments/${assignment.id}/events`, usage, machine.token);
  await f.tick();
  let detail = (await f.request('GET', `/runs/${run.id}`)).body;
  assert.equal(detail.intake.paused, true); assert.equal(detail.budgetUsage.tokens, 10);
  assert.equal((await f.request('POST', `/runs/${run.id}/inputs`, { items: [{ title: 'Second' }, { title: 'Third' }], idempotencyKey: 'pending' })).status, 202);
  await f.tick(); assert.equal((await f.items(run)).length, 1);
  await f.restart();
  const overview = (await f.request('GET', '/overview')).body;
  assert.equal(overview.runs.find(value => value.id === run.id).intake.paused, true);
  const tomorrow = new Date(Date.now() + 86400000).toISOString();
  await f.tick(tomorrow);
  assert.equal((await f.items(run)).length, 2, 'only available active capacity admitted');
  detail = (await f.request('GET', `/runs/${run.id}`)).body;
  assert.equal(detail.budgetUsage.tokens, 0);
  const grouped = await f.request('GET', `/usage?groupBy=role&runId=${run.id}`);
  assert.equal(grouped.status, 200); assert.equal(grouped.body.groups[0].key, 'implementer'); assert.equal(grouped.body.totals.inputTokens, 7);
  const events = (await f.request('GET', `/events?runId=${run.id}&limit=1000`)).body.events;
  assert.equal(events.filter(event => event.type === 'budget.exhausted' && event.data.limit === 'maxTokensPerDay').length, 1);
  assert.ok(events.some(event => event.type === 'budget.available'));
});

test('completed and stopped runs have precise terminal timestamps', async t => {
  const f = await fixture(t); const machine = await f.machine();
  const run = await f.start({ items: [{ title: 'Finish' }] });
  const assignment = (await f.request('POST', '/nodes/lease', { kinds: ['assignment'], max: 1 }, machine.token)).body.assignments[0];
  await f.request('POST', `/assignments/${assignment.id}/events`, { attempt: assignment.attempt, type: 'completed', data: { outcome: 'success', summary: 'Done.' } }, machine.token);
  const completed = (await f.request('GET', `/runs/${run.id}`)).body;
  assert.equal(completed.status, 'completed'); assert.ok(completed.completedAt); assert.ok(completed.stoppedAt);
  assert.equal(completed.completedAt, f.hub.engine.runState(run.id).stoppedAt);
  const open = await f.start({ keepOpen: true });
  const stopped = (await f.request('POST', `/runs/${open.id}/stop`, {})).body;
  assert.ok(stopped.stoppedAt); assert.equal(stopped.completedAt, undefined);
});

test('architect keeps template provenance and saves every proposal as a separately activatable draft', async t => {
  const f = await fixture(t); const machine = await f.machine();
  const requested = await f.request('POST', `/projects/${f.project.id}/workflows/drafts`, { prompt: 'Add build and improve workflows.' });
  assert.equal(requested.status, 202);
  const assignment = (await f.request('POST', '/nodes/lease', { kinds: ['assignment'], max: 1 }, machine.token)).body.assignments[0];
  assert.match(assignment.prompt, /Build/);
  const result = await f.request('POST', `/assignments/${assignment.id}/events`, { attempt: assignment.attempt, type: 'completed', data: {
    outcome: 'success', summary: 'Two independent workflows.', graph, rationale: 'Build.', templateId: 'build',
    additionalWorkflows: [{ name: 'Continuous improvement', graph, rationale: 'Improve separately.', templateId: 'improve' }],
  } }, machine.token);
  assert.equal(result.status, 200);
  const saved = (await f.request('GET', `/assignments/${assignment.id}`)).body;
  assert.equal(saved.drafts.length, 2);
  for (const draft of saved.drafts) {
    const workflow = (await f.request('GET', `/workflows/${draft.workflowId}`)).body;
    assert.equal(workflow.status, 'draft'); assert.ok(workflow.templateId);
    await f.request('POST', `/workflows/${draft.workflowId}/activate`, { version: draft.version });
  }
  assert.equal((await f.request('GET', `/workflows/${f.wf.id}`)).body.status, 'active');
});

test('invalid additional architect graph retries the whole proposal without partial saves', async t => {
  const f = await fixture(t); const machine = await f.machine();
  await f.request('POST', `/projects/${f.project.id}/workflows/drafts`, { prompt: 'Add two workflows.' });
  const assignment = (await f.request('POST', '/nodes/lease', { kinds: ['assignment'], max: 1 }, machine.token)).body.assignments[0];
  await f.request('POST', `/assignments/${assignment.id}/events`, { attempt: assignment.attempt, type: 'completed', data: {
    outcome: 'success', summary: 'Proposals.', graph, rationale: 'Build.', additionalWorkflows: [{ name: 'Broken', graph: {}, rationale: 'Improve.' }],
  } }, machine.token);
  const saved = (await f.request('GET', `/assignments/${assignment.id}`)).body;
  assert.equal(saved.status, 'failed'); assert.equal(saved.architectErrors[0].workflowIndex, 1);
  assert.equal((await f.request('GET', `/projects/${f.project.id}/workflows`)).body.workflows.length, 1);
});

test('ledger delivery and source input survive engine commit followed by hub rollback', async t => {
  const f = await fixture(t); const machine = await f.machine();
  const run = await f.start({ keepOpen: true, budget: { maxTokensPerDay: 100 }, items: [{ title: 'First' }] });
  const assignment = (await f.request('POST', '/nodes/lease', { kinds: ['assignment'], max: 1 }, machine.token)).body.assignments[0];
  const original = f.hub.applyEffects.bind(f.hub);
  let fail = true;
  f.hub.applyEffects = (run, result) => {
    if (fail && result.effects.some(effect => effect.type === 'input-delivered')) { fail = false; throw new Error('Simulated crash'); }
    original(run, result);
  };
  assert.equal((await f.request('POST', `/runs/${run.id}/inputs`, { items: [{ title: 'Durable batch' }], idempotencyKey: 'durable-batch' })).status, 500);
  await f.restart();
  assert.equal((await f.items(run)).length, 2);
  await f.tick(new Date(Date.now() + 60000).toISOString());
  assert.equal((await f.items(run)).length, 2, 'recovered source delivery is not repeated');
  // The ledger transaction commits first; failure to deliver the token delta leaves a durable intent.
  const apply = f.hub.engine.applyEvent.bind(f.hub.engine);
  f.hub.engine.applyEvent = args => { if (args.event.type === 'usage.recorded') throw new Error('Simulated crash'); return apply(args); };
  assert.equal((await f.request('POST', `/assignments/${assignment.id}/events`, { attempt: assignment.attempt, type: 'usage', idempotencyKey: 'ledger', data: { provider: 'codex', model: 'test', inputTokens: 12, outputTokens: 4 } }, machine.token)).status, 500);
  await f.restart();
  assert.equal((await f.request('GET', `/runs/${run.id}`)).body.budgetUsage.tokens, 16);
  assert.equal((await f.request('GET', `/usage?runId=${run.id}`)).body.totals.inputTokens, 12);
});

test('finite budgeted batches retain every item until capacity and daily allowances return', async t => {
  const f = await fixture(t); const machine = await f.machine();
  const run = await f.start({ budget: { maxActiveItems: 1, maxItemsPerDay: 1 }, items: [{ title: 'One' }, { title: 'Two' }] });
  await f.tick();
  assert.equal((await f.items(run)).length, 1);
  const assignment = (await f.request('POST', '/nodes/lease', { kinds: ['assignment'], max: 1 }, machine.token)).body.assignments[0];
  await f.request('POST', `/assignments/${assignment.id}/events`, { attempt: assignment.attempt, type: 'completed', data: { outcome: 'success', summary: 'Done.' } }, machine.token);
  assert.equal((await f.request('GET', `/runs/${run.id}`)).body.status, 'running', 'the deferred input batch keeps a finite run open');
  await f.tick(new Date(Date.now() + 86400000).toISOString());
  assert.equal((await f.items(run)).length, 2);
  const next = (await f.request('POST', '/nodes/lease', { kinds: ['assignment'], max: 1 }, machine.token)).body.assignments[0];
  await f.request('POST', `/assignments/${next.id}/events`, { attempt: next.attempt, type: 'completed', data: { outcome: 'success', summary: 'Done.' } }, machine.token);
  assert.equal((await f.request('GET', `/runs/${run.id}`)).body.status, 'completed');
});

test('role usage survives rollup and assignment deletion', async t => {
  const f = await fixture(t); const machine = await f.machine();
  const run = await f.start({ keepOpen: true, items: [{ title: 'Work' }] });
  const assignment = (await f.request('POST', '/nodes/lease', { kinds: ['assignment'], max: 1 }, machine.token)).body.assignments[0];
  await f.request('POST', `/assignments/${assignment.id}/events`, { attempt: assignment.attempt, type: 'usage', data: { provider: 'codex', model: 'test', inputTokens: 5, outputTokens: 2 } }, machine.token);
  const before = (await f.request('GET', `/usage?runId=${run.id}&groupBy=role`)).body;
  await f.hub.serialize(() => f.hub.store.transaction(() => {
    f.hub.store.sweep({ usageBefore: new Date(Date.now() + 1000).toISOString(), finishedBefore: '2000-01-01', eventsBefore: '2000-01-01', idempotencyBefore: '2000-01-01', batch: 500 });
    f.hub.store.remove('assignment', assignment.id);
  }));
  assert.deepEqual((await f.request('GET', `/usage?runId=${run.id}&groupBy=role`)).body, before);
});

test('scheduler tick recovers after engine commit without repeating a scheduled minute', async t => {
  const f = await fixture(t);
  const run = await f.start({ keepOpen: true, source: 'schedule', schedule: '* * * * *' });
  const next = new Date(Date.now() + 60000).toISOString();
  const original = f.hub.applyEffects.bind(f.hub);
  let fail = true;
  f.hub.applyEffects = (run, result) => {
    if (fail && result.effects.some(effect => effect.type === 'request-input')) { fail = false; throw new Error('Crash after tick committed'); }
    return original(run, result);
  };
  await assert.rejects(f.tick(next), /Crash after tick committed/);
  await f.restart(); await f.tick(next); await f.tick(next);
  assert.equal((await f.items(run)).length, 2);
  await f.tick(new Date(Date.now() + 300000).toISOString());
  assert.equal((await f.items(run)).length, 3, 'missed minutes are not replayed');
});

test('late usage stays in its ledger day instead of consuming the current budget window', async t => {
  const f = await fixture(t); const machine = await f.machine();
  const run = await f.start({ keepOpen: true, budget: { maxTokensPerDay: 10 }, items: [{ title: 'Work' }] });
  const assignment = (await f.request('POST', '/nodes/lease', { kinds: ['assignment'], max: 1 }, machine.token)).body.assignments[0];
  await f.request('POST', `/assignments/${assignment.id}/events`, { attempt: assignment.attempt, type: 'usage', data: { provider: 'codex', model: 'test', inputTokens: 3, outputTokens: 1 } }, machine.token);
  await f.request('POST', `/assignments/${assignment.id}/events`, { attempt: assignment.attempt, type: 'usage', data: { provider: 'codex', model: 'test', inputTokens: 100, at: new Date(Date.now() - 86400000).toISOString() } }, machine.token);
  assert.equal((await f.request('GET', `/runs/${run.id}`)).body.budgetUsage.tokens, 4);
  assert.equal((await f.request('GET', `/usage?runId=${run.id}`)).body.totals.inputTokens, 103);
});

test('planner touches survive HTTP assignment results and serialize overlapping children', async t => {
  const f = await fixture(t); const machine = await f.machine();
  const planned = structuredClone(graph);
  planned.nodes.find(node => node.id === 'builder').config.concurrency = 2;
  planned.nodes.push({ id: 'planner', type: 'planner', label: 'Plan', position: { x: 0, y: 1 }, config: { harness: { provider: 'codex', model: 'test' }, prompt: 'Plan.' } });
  planned.edges[0].to.node = 'planner';
  planned.edges.push({ id: 'plan-build', kind: 'flow', from: { node: 'planner' }, to: { node: 'builder' } });
  const wf = (await f.request('POST', `/projects/${f.project.id}/workflows`, { name: 'Scoped plan', graph: planned })).body;
  await f.request('POST', `/workflows/${wf.id}/activate`, { version: 1 });
  const run = await f.start({ items: [{ title: 'Plan two changes' }] }, wf.id);
  const assignment = (await f.request('POST', '/nodes/lease', { kinds: ['assignment'], max: 1 }, machine.token)).body.assignments[0];
  const items = [{ title: 'One', touches: ['src/shared.js'] }, { title: 'Two', touches: ['src/shared.js'] }];
  await f.request('POST', `/assignments/${assignment.id}/events`, { attempt: assignment.attempt, type: 'completed', data: { outcome: 'success', summary: 'Shared scope.', items } }, machine.token);
  const children = (await f.items(run)).filter(item => item.parentId);
  assert.deepEqual(children.map(item => item.touches), items.map(item => item.touches));
  assert.equal((await f.request('GET', `/runs/${run.id}/assignments`)).body.assignments.filter(value => value.nodeId === 'builder').length, 1);
});
