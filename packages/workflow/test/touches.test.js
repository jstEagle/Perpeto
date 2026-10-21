import test from 'node:test';
import assert from 'node:assert/strict';
import { replay } from '../src/index.js';
import { Driver, template, sha, code } from './fixtures.js';

const built = n => ({ outcome: 'success', summary: 'built', branch: `b${n}`, prUrl: `local:b${n}`, headSha: sha(n) });
function start(items, serialize = true) {
  const graph = template('build');
  graph.nodes.find(n => n.id === 'planner').config.serializeOverlappingTouches = serialize;
  const run = new Driver();
  run.start({ graph });
  assert.match(run.open('planner')[0].prompt, /file\/module boundaries/);
  assert.match(run.open('planner')[0].prompt, /touches: string\[\]/);
  run.complete('planner', { outcome: 'success', items });
  return run;
}

test('overlapping paths wait until delivery completes while independent modules run concurrently', () => {
  const run = start([
    { title: 'A', touches: ['src/index.js'] }, { title: 'B', touches: ['./src/'] },
    { title: 'C', touches: ['src2/index.js'] },
  ]);
  assert.deepEqual(run.open('builder').map(a => run.state.workItems[a.workItemId].title), ['A', 'C']);
  run.complete('builder', built(1));
  assert.equal(run.open('builder').length, 1); // B must also wait throughout review and CI.
  run.complete('reviewer', { outcome: 'success' });
  run.apply('job.completed', { jobId: run.openJob().id, status: 'passed' });
  assert.equal(run.open('builder').length, 1);
  run.apply('merge.completed', { mergeId: run.openMerge().id });
  assert.deepEqual(run.open('builder').map(a => run.state.workItems[a.workItemId].title), ['C', 'B']);
  assert.deepEqual(run.items(i => i.title === 'B')[0].touches, ['src']);
  assert.match(run.open('builder')[1].prompt, /Declared touches: src/);
  assert.deepEqual(replay(run.events), run.state);
});

test('touch serialization is optional and undeclared legacy scopes remain concurrent', () => {
  for (const [serialize, items] of [
    [false, [{ title: 'A', touches: ['src'] }, { title: 'B', touches: ['src/index.js'] }]],
    [true, [{ title: 'A' }, { title: 'B', touches: [] }]],
  ]) assert.equal(start(items, serialize).open('builder').length, 2);
});

test('a failed holder releases its scope and overlapping waiters keep arrival order', () => {
  const run = start(['A', 'B', 'C'].map(title => ({ title, touches: ['src'] })));
  run.complete('builder', { outcome: 'blocked', summary: 'Need a person.' });
  run.apply('run.paused');
  const holder = run.items(i => i.title === 'A')[0];
  run.apply('human.decision', { workItemId: holder.id, decision: 'fail' });
  assert.equal(run.open('builder').length, 0);
  run.apply('run.resumed');
  assert.deepEqual(run.open('builder').map(a => run.state.workItems[a.workItemId].title), ['B']);
});

test('invalid touches are rejected before changing state', () => {
  for (const touches of ['src', [42], ['../outside'], ['/absolute'], ['a', 'a'], ['src\\index.js']]) {
    const run = new Driver();
    run.start();
    const before = structuredClone(run.state);
    assert.throws(() => run.complete('planner', { outcome: 'success', items: [{ title: 'A', touches }] }), code('INVALID_EVENT'));
    assert.deepEqual(run.state, before);
  }
});

test('a scope released by a synchronous dispatch failure does not strand its queued successor', () => {
  const run = start(['A', 'B'].map(title => ({ title, touches: ['src'] })));
  run.complete('builder', { outcome: 'success', summary: 'Missing head' });
  run.complete('reviewer', { outcome: 'success' }); // A fails missing_head_sha during CI dispatch.
  assert.equal(run.items(i => i.title === 'A')[0].status, 'failed');
  assert.deepEqual(run.open('builder').map(a => run.state.workItems[a.workItemId].title), ['B']);
});

test('directory scopes lock across builder roles and survive a state reload', () => {
  const graph = template('build');
  const second = structuredClone(graph.nodes.find(n => n.id === 'builder'));
  second.id = 'second-builder';
  second.config.concurrency = 2;
  graph.nodes.push(second);
  graph.edges.find(e => e.id === 'builder-reviewer').to.node = 'second-builder';
  graph.edges.push({ id: 'second-reviewer', kind: 'flow', from: { node: second.id }, to: { node: 'reviewer' } });
  const run = new Driver();
  run.start({ graph });
  run.complete('planner', { outcome: 'success', items: ['A', 'B'].map(title => ({ title, touches: ['.'] })) });
  run.state = JSON.parse(JSON.stringify(run.state));
  run.complete('builder', built(1));
  assert.equal(run.open('second-builder').length, 1);
  assert.equal(run.open('builder').length, 0);
  run.complete('second-builder', built(2));
  run.complete('reviewer', { outcome: 'success' });
  run.apply('job.completed', { jobId: run.openJob().id, status: 'passed' });
  run.apply('merge.completed', { mergeId: run.openMerge().id });
  assert.equal(run.open('builder').length, 1);
});
