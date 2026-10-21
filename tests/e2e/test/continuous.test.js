import test from 'node:test';
import assert from 'node:assert/strict';
import { startFactory, eventually } from './support.js';

const graph = { schema: 'perpeto.workflow/1', nodes: [
  { id: 'input', type: 'input', label: 'Input', position: { x: 0, y: 0 }, config: { source: 'manual' } },
  { id: 'worker', type: 'agent', label: 'Worker', position: { x: 1, y: 0 },
    config: { harness: { provider: 'fake', model: 'intake-test' }, prompt: 'Complete the work item.' } },
  { id: 'output', type: 'output', label: 'Output', position: { x: 2, y: 0 }, config: {} },
], edges: [['input', 'worker'], ['worker', 'output']].map(([from, to]) => ({ id: `${from}-${to}`, kind: 'flow', from: { node: from }, to: { node: to } })) };

async function fixture(t) {
  let time = Date.parse('2026-10-21T12:00:00.000Z');
  const calls = [];
  const f = await startFactory(t, { clock: () => time, hub: { maintenanceIntervalMs: 86400000 }, executor: {
    kind: 'intake-fake', canRun: assignment => assignment.harness?.provider === 'fake',
    async run(assignment, ctx) {
      calls.push(assignment);
      await ctx.report({ type: 'usage', data: { provider: 'fake', model: 'intake-test', inputTokens: 5, outputTokens: 2, cacheReadTokens: 100 } });
      return { outcome: 'success', summary: 'Finished by the fake executor.' };
    },
  } });
  const project = await f.request('POST', '/projects', { name: 'Intake E2E', repo: { url: '/tmp/unused.git', defaultBranch: 'main' },
    goals: [{ id: 'goal_finished', title: 'Already completed' }, { id: 'goal_unfinished', title: 'Ship the feature' }, { id: 'goal_another', title: 'Improve quality' },
      { id: 'goal_done', title: 'Owner marked done', status: 'done' }, { id: 'goal_dropped', title: 'No longer needed', status: 'dropped' }] });
  const workflow = await f.request('POST', `/projects/${project.id}/workflows`, { name: 'Continuous', graph });
  await f.request('POST', `/workflows/${workflow.id}/activate`, { version: 1 });
  const start = input => f.request('POST', `/workflows/${workflow.id}/runs`, { input });
  const items = async run => (await f.request('GET', `/runs/${run.id}/work-items`)).workItems;
  const completed = run => eventually(async () => { const all = await items(run); return all.length && all.every(item => item.status === 'done') && all; });
  const tick = () => f.hub.hub.maintenance();
  const advance = async at => {
    time = Date.parse(at);
    // Let the real daemon heartbeat in the new window before the explicit maintenance sweep.
    await eventually(async () => (await f.request('GET', '/machines')).machines.some(machine => machine.lastHeartbeatAt === at));
    await tick();
  };
  return { ...f, calls, project, start, items, completed, tick, advance };
}

test('Goals intake executes unfinished goals, pauses at its item budget and resumes next window', async t => {
  const f = await fixture(t);
  const previous = await f.start({ items: [{ title: 'Already completed', goalId: 'goal_finished' }] });
  await f.completed(previous);
  const run = await f.start({ keepOpen: true, source: 'goals', budget: { maxItemsPerDay: 1 } });
  assert.equal(run.budgetUsage.tokens, 0);
  assert.equal(run.budgetUsage.windowStart, '2026-10-21T00:00:00.000Z');
  await f.tick();
  const first = await f.completed(run);
  assert.deepEqual(first.map(item => item.goalId), ['goal_unfinished']);
  assert.match(f.calls.find(call => call.workItemId === first[0].id).prompt, /Ship the feature/);
  await f.advance('2026-10-21T12:01:00.000Z');
  let detail = await f.request('GET', `/runs/${run.id}`);
  assert.equal(detail.status, 'running'); assert.equal(detail.intake.paused, true);
  assert.equal(detail.intake.reason.limit, 'maxItemsPerDay');
  assert.equal((await f.items(run)).length, 1);
  await f.advance('2026-10-22T00:00:00.000Z');
  const all = await eventually(async () => { const values = await f.completed(run); return values.length === 2 && values; });
  assert.deepEqual(all.map(item => item.goalId).sort(), ['goal_another', 'goal_unfinished']);
  detail = await f.request('GET', `/runs/${run.id}`);
  assert.equal(detail.budgetUsage.items, 1); assert.equal(detail.budgetUsage.day, '2026-10-22');
  assert.equal(detail.budgetUsage.windowEnd, '2026-10-23T00:00:00.000Z');
  const events = (await f.events()).filter(event => event.runId === run.id);
  assert.ok(events.some(event => event.type === 'budget.exhausted'));
  assert.ok(events.some(event => event.type === 'budget.available'));
  await f.tick(); assert.equal((await f.items(run)).length, 2);
});

test('Schedule intake executes only on its tick, pauses for tokens and resumes next UTC window', async t => {
  const f = await fixture(t);
  const run = await f.start({ keepOpen: true, source: 'schedule', schedule: '1 * * * *', budget: { maxTokensPerDay: 7 } });
  await f.tick(); assert.equal((await f.items(run)).length, 0);
  await f.advance('2026-10-21T12:01:00.000Z');
  const first = await f.completed(run);
  assert.equal(first.length, 1); assert.equal(first[0].title, 'Scheduled improvement pass');
  let detail = await f.request('GET', `/runs/${run.id}`);
  assert.equal(detail.budgetUsage.tokens, 7); assert.equal(detail.intake.paused, true);
  assert.equal(detail.intake.reason.limit, 'maxTokensPerDay');
  await f.advance('2026-10-21T13:01:00.000Z');
  assert.equal((await f.items(run)).length, 1, 'a due schedule cannot bypass exhausted tokens');
  await f.advance('2026-10-22T00:00:00.000Z');
  detail = await f.request('GET', `/runs/${run.id}`);
  assert.equal(detail.intake.paused, false); assert.equal(detail.budgetUsage.tokens, 0);
  assert.equal(detail.budgetUsage.windowStart, '2026-10-22T00:00:00.000Z');
  await f.advance('2026-10-22T00:01:00.000Z');
  await eventually(async () => (await f.completed(run)).length === 2);
  await f.tick(); assert.equal((await f.items(run)).length, 2, 'same minute is not replayed');
  assert.equal(f.calls.filter(call => call.runId === run.id).length, 2);
  const events = (await f.events()).filter(event => event.runId === run.id);
  assert.deepEqual(events.filter(event => event.type === 'budget.available').map(event => event.at), ['2026-10-22T00:00:00.000Z']);
  assert.equal(events.filter(event => event.type === 'budget.exhausted' && event.data.limit === 'maxTokensPerDay').length, 2);
});
