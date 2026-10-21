import test from 'node:test';
import assert from 'node:assert/strict';
import { Driver, bare, code } from './fixtures.js';

const node = (id, type, config = {}) => ({ id, type, label: id, position: { x: 0, y: 0 }, config });
const flow = (id, from, to, port) => ({ id, kind: 'flow', from: { node: from, ...(port ? { port } : {}) }, to: { node: to } });

/** input → design (human) → release (human) → shipped, with fails to rejected. */
const twoGates = () => ({
  schema: 'perpeto.workflow/1',
  nodes: [
    node('ideas', 'input', { source: 'manual' }),
    node('design', 'human', { prompt: 'Approve the design?' }),
    node('release', 'human', { prompt: 'Approve the release?' }),
    node('shipped', 'output'), node('rejected', 'output'),
  ],
  edges: [
    flow('ideas-design', 'ideas', 'design'),
    flow('design-pass', 'design', 'release', 'pass'), flow('design-fail', 'design', 'rejected', 'fail'),
    flow('release-pass', 'release', 'shipped', 'pass'), flow('release-fail', 'release', 'rejected', 'fail'),
  ],
});

test('M4: a repeated human decision cannot pass the next gate', () => {
  const run = new Driver();
  run.start({ graph: twoGates(), repo: undefined });
  const [item] = run.items();
  const design = run.emitted('human.requested')[0].data;
  assert.equal(design.nodeId, 'design');
  assert.equal(design.decisionId, run.state.workItems[item.id].waiting.decisionId);

  run.apply('human.decision', { workItemId: item.id, decision: 'pass', decisionId: design.decisionId });
  const release = run.emitted('human.requested')[1].data;
  assert.equal(release.nodeId, 'release');
  assert.notEqual(release.decisionId, design.decisionId);

  // A client retry, or a second person answering the design gate, reaches the release gate.
  assert.throws(() => run.apply('human.decision', { workItemId: item.id, decision: 'pass', decisionId: design.decisionId }), code('STALE_DECISION'));
  assert.equal(run.state.workItems[item.id].status, 'blocked');
  assert.equal(run.state.workItems[item.id].nodeId, 'release');

  run.apply('human.decision', { workItemId: item.id, decision: 'pass', decisionId: release.decisionId });
  assert.equal(run.state.status, 'completed');
});

test('M4: retry waits are bound to their visit too', () => {
  const run = new Driver();
  run.start({ graph: bare('build') });
  run.complete('planner', { outcome: 'success', items: [] });
  run.complete('builder', { outcome: 'blocked', summary: 'Need credentials.' });
  const [item] = run.items();
  const first = run.state.workItems[item.id].waiting.decisionId;
  assert.equal(run.emitted('workitem.blocked')[0].data.decisionId, first);
  run.apply('human.decision', { workItemId: item.id, decision: 'pass', decisionId: first });
  run.complete('builder', { outcome: 'blocked', summary: 'Still stuck.' });
  const second = run.state.workItems[item.id].waiting.decisionId;
  assert.notEqual(second, first);
  assert.throws(() => run.apply('human.decision', { workItemId: item.id, decision: 'fail', decisionId: first }), code('STALE_DECISION'));
  assert.throws(() => run.apply('human.decision', { workItemId: item.id, decision: 'fail', decisionId: 7 }), code('INVALID_EVENT'));
  run.apply('human.decision', { workItemId: item.id, decision: 'fail', decisionId: second });
  assert.equal(run.state.workItems[item.id].failure.reason, 'rejected_by_human');
});
