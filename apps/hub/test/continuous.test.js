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

async function fixture(t, { clock, config = {}, workflowGraph = graph } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'perpeto-intake-'));
  const configPath = join(dir, 'hub.json');
  await writeFile(configPath, JSON.stringify({ port: 0, maintenanceIntervalMs: 86400000, heartbeatIntervalMs: 86400000, longPollMs: 0, ...config }));
  let app = await createHub({ configPath, clock }); let url = await app.listen();
  const token = (await readFile(join(dir, 'owner.secret'), 'utf8')).trim();
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const request = async (method, path, body, auth = token) => {
    const response = await fetch(`${url}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const project = (await request('POST', '/projects', { name: 'Continuous', repo: { url: '/tmp/unused.git', defaultBranch: 'main' }, goals: ['Ship feature', 'Improve quality'] })).body;
  async function workflow(name = 'Build') {
    const result = await request('POST', `/projects/${project.id}/workflows`, { name, purpose: name === 'Build' ? 'build' : 'improve', graph: workflowGraph });
    assert.equal(result.status, 201);
    await request('POST', `/workflows/${result.body.id}/activate`, { version: 1 });
    return result.body;
  }
  const wf = await workflow();
  const start = async (input, id = wf.id) => { const result = await request('POST', `/workflows/${id}/runs`, { input }); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body; };
  const items = async run => (await request('GET', `/runs/${run.id}/work-items`)).body.workItems;
  return { request, project, wf, workflow, start, items, get hub() { return app.hub; },
    tick: at => app.hub.maintenance(at),
    async restart() { await app.close(); app = await createHub({ configPath, clock }); url = await app.listen(); },
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

test('run budget usage is present from creation with UTC window bounds, even without intake state', async t => {
  const f = await fixture(t);
  for (const input of [{ keepOpen: true }, { keepOpen: true, budget: { maxTokensPerDay: 10 } }]) {
    const run = await f.start(input);
    const day = run.startedAt.slice(0, 10);
    const expected = { day, tokens: 0, items: 0, windowStart: `${day}T00:00:00.000Z`,
      windowEnd: new Date(Date.parse(`${day}T00:00:00.000Z`) + 86400000).toISOString() };
    assert.deepEqual(run.budgetUsage, expected);
    // Legacy engine snapshots can have counters before their first intake request.
    const state = f.hub.intake.state(run);
    delete state.intake;
    state.budgetUsage.tokens = 7; expected.tokens = 7;
    await f.hub.serialize(() => f.hub.store.transaction(() => f.hub.store.put('engine-state', { id: run.id, state })));
    assert.deepEqual((await f.request('GET', `/runs/${run.id}`)).body.budgetUsage, expected);
    assert.deepEqual((await f.request('GET', '/overview')).body.runs.find(value => value.id === run.id).budgetUsage, expected);
    assert.deepEqual((await f.request('GET', `/projects/${f.project.id}/runs`)).body.runs.find(value => value.id === run.id).budgetUsage, expected);
    for (const action of ['pause', 'resume', 'stop']) {
      assert.deepEqual((await f.request('POST', `/runs/${run.id}/${action}`, {})).body.budgetUsage, expected);
    }
    delete state.budgetUsage;
    await f.hub.serialize(() => f.hub.store.transaction(() => f.hub.store.put('engine-state', { id: run.id, state })));
    assert.deepEqual((await f.request('GET', `/runs/${run.id}`)).body.budgetUsage, { ...expected, tokens: 0 });
  }
});

test('maintenance and usage preserve freshly leased attempts through scheduling and config changes', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T12:00:00.000Z') });
  const f = await fixture(t); const machine = await f.machine();
  const run = await f.start({ keepOpen: true, items: [{ title: 'Leased work' }], budget: { maxTokensPerDay: 100 } });
  const assignment = (await f.request('POST', '/nodes/lease', { kinds: ['assignment'] }, machine.token)).body.assignments[0];
  for (const type of ['started', 'usage']) {
    const result = await f.request('POST', `/assignments/${assignment.id}/events`, { attempt: assignment.attempt, type,
      data: type === 'usage' ? { provider: 'codex', model: 'test', inputTokens: 5, outputTokens: 2 } : {} }, machine.token);
    assert.equal(result.status, 200);
    await f.tick();
  }
  await f.request('PATCH', `/runs/${run.id}`, { budget: { maxTokensPerDay: 200 } });
  await f.tick();
  const stored = (await f.request('GET', `/assignments/${assignment.id}`)).body;
  assert.equal(stored.status, 'running'); assert.equal(stored.attempt, assignment.attempt);
  assert.equal(stored.machineId, machine.machineId);
  assert.equal((await f.request('POST', `/assignments/${assignment.id}/renew`, { attempt: assignment.attempt }, machine.token)).status, 200);
  assert.equal((await f.request('POST', `/assignments/${assignment.id}/renew`, { attempt: assignment.attempt + 1 }, machine.token)).body.error.code, 'lease_lost');
  const events = (await f.request('GET', `/events?runId=${run.id}&limit=1000`)).body.events;
  assert.equal(events.some(event => ['assignment.requeued', 'assignment.expired'].includes(event.type)), false);
  assert.equal((await f.request('GET', `/runs/${run.id}`)).body.budgetUsage.tokens, 7);
});


test('lease deadlines, maintenance expiry and retry notBefore use the injected hub clock', async t => {
  let time = Date.parse('2026-10-21T12:00:00.000Z');
  const workflowGraph = structuredClone(graph);
  workflowGraph.nodes.find(node => node.id === 'builder').config.retry = { maxAttempts: 3, backoffSec: 10 };
  const f = await fixture(t, { clock: () => time, config: { leaseDurationMs: 60000 }, workflowGraph });
  const machine = await f.machine();
  const run = await f.start({ keepOpen: true, items: [{ title: 'Hold through maintenance' }] });
  const lease = async () => (await f.request('POST', '/nodes/lease', { kinds: ['assignment'] }, machine.token)).body.assignments[0];
  const report = (work, type) => f.request('POST', `/assignments/${work.id}/events`, { attempt: work.attempt, type }, machine.token);
  const first = await lease();
  assert.equal(first.leaseExpiresAt, '2026-10-21T12:01:00.000Z');
  assert.equal((await report(first, 'started')).status, 200);
  time = Date.parse(first.leaseExpiresAt) - 1;
  await f.tick();
  assert.equal((await f.request('GET', `/assignments/${first.id}`)).body.status, 'running');
  time++;
  assert.equal((await report(first, 'progress')).body.error.code, 'lease_lost', 'expiry fences even before maintenance');
  await f.tick();
  const attempts = (await f.request('GET', `/runs/${run.id}/assignments`)).body.assignments;
  const retry = attempts.find(value => value.retryOf === first.id);
  assert.ok(retry); assert.equal(retry.attempt, first.attempt + 1);
  assert.equal(retry.notBefore, '2026-10-21T12:01:10.000Z');
  assert.equal((await f.request('GET', `/assignments/${first.id}`)).body.status, 'failed');
  time = Date.parse(retry.notBefore) - 1;
  await f.tick(); assert.equal(await lease(), undefined, 'backoff cannot be leased early');
  time++;
  await f.tick();
  const second = await lease(); assert.equal(second.id, retry.id);
  assert.equal((await report(first, 'started')).body.error.code, 'lease_lost');
  assert.equal((await report(second, 'started')).status, 200);
  assert.equal((await f.request('POST', `/assignments/${second.id}/renew`, { attempt: second.attempt }, machine.token)).status, 200);
});

test('a seed waiting on an empty lease poll can outlive its held lease, then gets fenced', async t => {
  let time = Date.parse('2026-10-21T12:00:00.000Z');
  const f = await fixture(t, { clock: () => time, config: { leaseDurationMs: 1000, longPollMs: 1000 } });
  const machine = await f.machine();
  const draft = (await f.request('POST', `/projects/${f.project.id}/workflows/drafts`, { prompt: 'Draft a workflow.' })).body;
  const first = (await f.request('POST', '/nodes/lease', { kinds: ['assignment'] }, machine.token)).body.assignments[0];
  assert.equal(first.id, draft.id);
  const pending = f.request('POST', '/nodes/lease', { kinds: ['assignment'] }, machine.token);
  for (let tries = 0; !f.hub.waiters.size && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.hub.waiters.size, 1, 'empty poll is waiting while the seed holds its prior lease');
  time = Date.parse(first.leaseExpiresAt) - 1;
  await f.tick();
  assert.equal((await f.request('GET', `/assignments/${first.id}`)).body.status, 'leased');
  time++;
  await f.tick();
  const second = (await pending).body.assignments[0];
  assert.equal(second.id, first.id); assert.equal(second.attempt, first.attempt + 1);
  assert.equal((await f.request('POST', `/assignments/${first.id}/renew`, { attempt: first.attempt }, machine.token)).body.error.code, 'lease_lost');
  const requeued = (await f.request('GET', '/events?limit=1000')).body.events.filter(event => event.type === 'assignment.requeued');
  assert.equal(requeued.length, 1); assert.equal(requeued[0].at, first.leaseExpiresAt, 'requeue occurs at expiry, not at leasing');
});
