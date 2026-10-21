import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRunMetrics, step, validateGraph } from '../src/index.js';
import { Driver, bare, sha, template } from './fixtures.js';

const RESERVED = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString'];

test('M10: node, edge and role ids cannot be Object.prototype names', () => {
  for (const id of RESERVED) {
    const nodeGraph = bare('build');
    nodeGraph.nodes.find(entry => entry.id === 'helper').id = id;
    for (const edge of nodeGraph.edges) for (const end of [edge.from, edge.to]) if (end.node === 'helper') end.node = id;
    assert.ok(validateGraph(nodeGraph).errors.some(issue => issue.code === 'INVALID_NODE' && issue.message.includes('reserved')), `node ${id}`);

    const edgeGraph = bare('build');
    edgeGraph.edges[0].id = id;
    assert.ok(validateGraph(edgeGraph).errors.some(issue => issue.code === 'INVALID_EDGE' && issue.message.includes('reserved')), `edge ${id}`);

    const roleGraph = bare('build');
    roleGraph.nodes.find(entry => entry.id === 'helper').config.role = id;
    assert.ok(validateGraph(roleGraph).errors.some(issue => issue.code === 'INVALID_CONFIG' && issue.nodeId === 'helper'), `role ${id}`);
  }
});

/**
 * A run state compiled before the id check, with a node renamed to `constructor`. JSON keeps the name as an own key,
 * so this is what a stored state from an older engine looks like.
 */
function legacyState(placeholder, graph = bare('build')) {
  const rename = value => JSON.parse(JSON.stringify(value).replaceAll(`"${placeholder}"`, '"constructor"'));
  const run = new Driver((state, event) => {
    const result = step(state, event);
    return { ...result, state: rename(result.state), effects: rename(result.effects) };
  });
  return { run, graph };
}

test('M10: concurrency holds for a node named constructor in a stored state', () => {
  const { run, graph } = legacyState('builder');
  run.start({ graph });
  run.complete('planner', { outcome: 'success', items: [1, 2, 3, 4, 5, 6].map(n => ({ title: `Item ${n}` })) });
  // The builder allows 4 at once.
  assert.equal(run.open('constructor').length, 4);
});

test('M10: loop limits hold for a loop named constructor in a stored state', () => {
  const { run, graph } = legacyState('delivery-loop', template('build'));
  run.start({ graph });
  run.complete('planner', { outcome: 'success', items: [] });
  let n = 0;
  const ciFails = () => {
    run.complete('builder', { outcome: 'success', summary: 'built', headSha: sha(n += 1), prUrl: 'https://git.example/pull/1' });
    run.complete('reviewer', { outcome: 'success', verdict: 'pass' });
    run.apply('job.completed', { jobId: run.openJob().id, status: 'failed' });
  };
  for (let index = 0; index < 3; index += 1) ciFails();
  const [item] = run.items();
  assert.equal(run.state.workItems[item.id].nodeId, 'triage');
  // Escalation cleared the loop's own count, so the next entry must start a fresh, numeric budget.
  run.apply('human.decision', { workItemId: item.id, decision: 'pass' });
  assert.equal(run.state.workItems[item.id].loopCounts.constructor, 1);
  for (let index = 0; index < 3; index += 1) ciFails();
  assert.equal(run.state.workItems[item.id].nodeId, 'triage');
  assert.equal(run.emitted('workitem.escalated').filter(event => event.data.from === 'constructor').length, 2);
});

test('M10: metrics count a node named constructor as numbers', () => {
  const { run, graph } = legacyState('builder');
  run.start({ graph });
  run.complete('planner', { outcome: 'success', items: [] });
  const metrics = computeRunMetrics(run.state, run.log, { now: '2026-10-21T10:00:00Z' });
  const builder = metrics.nodes.find(entry => entry.nodeId === 'constructor');
  assert.deepEqual([builder.tokens, builder.retries, builder.escalations], [0, 0, 0]);
});
