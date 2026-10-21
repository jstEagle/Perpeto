import test from 'node:test';
import assert from 'node:assert/strict';
import { step, replay, canonicalJson } from '../src/index.js';
import { Driver, template, bare, sha, code } from './fixtures.js';

const built = n => ({ outcome: 'success', summary: `built ${n}`, branch: `feat/${n}`, prUrl: `https://git.example/app/pull/${n}`, headSha: sha(n) });

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

test('build template runs from input to merged output through review and CI retries', () => {
  const run = new Driver();
  run.start();
  assert.equal(run.state.status, 'running');
  const [idea] = run.items();
  assert.equal(idea.nodeId, 'planner');
  assert.equal(run.open('planner').length, 1);
  assert.match(run.open('planner')[0].prompt, /at most 8 work items/);

  run.complete('planner', { outcome: 'success', items: [{ title: 'Login form', body: 'Fields and validation.' }] });
  const child = run.items(item => item.parentId === idea.id)[0];
  assert.equal(child.title, 'Login form');
  assert.equal(child.nodeId, 'builder');
  assert.deepEqual(child.loopCounts, { 'delivery-loop': 1, 'review-loop': 1 });
  assert.equal(run.state.workItems[idea.id].status, 'active');
  const builderAssignment = run.open('builder')[0];
  assert.deepEqual(builderAssignment.policy, {
    maxSubagents: 2, allowedSubagentProviders: ['claudeAgent'], canMessage: ['helper', 'planner', 'reviewer'], maxTurns: 200,
  });
  assert.deepEqual(builderAssignment.harness, { provider: 'codex', model: 'gpt-6-astra' });
  assert.deepEqual(builderAssignment.requirements, { providers: ['codex'] });

  run.complete('builder', built(1));
  assert.equal(run.state.workItems[child.id].headSha, sha(1));
  assert.match(run.open('reviewer')[0].prompt, /Rubric:/);

  // Review fails: the item returns to the builder with feedback on iteration 2.
  run.complete('reviewer', { outcome: 'success', verdict: 'fail', summary: 'Add tests for empty passwords.' });
  assert.deepEqual(run.effectTypes(), [
    'assignment.state', 'gate.result', 'workitem.moved', 'loop.iteration', 'workitem.moved', 'create-assignment', 'assignment.state',
  ]);
  let item = run.state.workItems[child.id];
  assert.equal(item.iteration, 2);
  assert.match(run.open('builder')[0].prompt, /Feedback to address \(review from reviewer\):\nAdd tests for empty passwords\./);

  run.complete('builder', built(2));
  run.complete('reviewer', { outcome: 'success', summary: 'Looks good.' });
  let job = run.openJob();
  assert.equal(job.revision, sha(2));
  assert.equal(job.repo, 'file:///srv/git/app.git');
  assert.match(job.configHash, /^[0-9a-f]{64}$/);

  // CI fails: back through the delivery loop, which resets the review loop.
  run.apply('job.completed', { jobId: job.id, status: 'failed', summary: '2 tests failed', logRef: 'logs/job-1' });
  item = run.state.workItems[child.id];
  assert.deepEqual(item.loopCounts, { 'delivery-loop': 2, 'review-loop': 1 });
  assert.match(run.open('builder')[0].prompt, /ci from ci\):\n2 tests failed/);

  run.complete('builder', built(3));
  run.complete('reviewer', { outcome: 'success' });
  job = run.openJob();
  assert.equal(job.revision, sha(3));
  run.apply('job.completed', { jobId: job.id, status: 'passed' });
  const entry = run.openMerge();
  assert.deepEqual(
    { prUrl: entry.prUrl, headSha: entry.headSha, baseBranch: entry.baseBranch, method: entry.method, strategy: entry.strategy },
    { prUrl: 'https://git.example/app/pull/3', headSha: sha(3), baseBranch: 'main', method: 'squash', strategy: 'serial' },
  );
  assert.equal(run.state.status, 'running');

  run.apply('merge.completed', { mergeId: entry.id, mergedSha: sha(99) });
  assert.equal(run.state.workItems[child.id].status, 'done');
  assert.equal(run.state.workItems[child.id].nodeId, 'shipped');
  assert.equal(run.state.workItems[idea.id].status, 'done');
  assert.equal(run.state.status, 'completed');
  assert.equal(run.state.stoppedAt, run.events.at(-1).at);
  assert.deepEqual(run.effectTypes().slice(-4), ['workitem.moved', 'mark-item-done', 'mark-item-done', 'run.completed']);

  const gates = run.emitted('gate.result').map(event => `${event.data.gate}:${event.data.result}`);
  assert.deepEqual(gates, ['review:fail', 'review:pass', 'ci:fail', 'review:pass', 'ci:pass', 'merge-queue:pass']);
  const moves = run.emitted('workitem.moved');
  assert.ok(moves.every(event => event.data.unplanned === false && typeof event.data.edgeId === 'string'));
  assert.deepEqual(moves.filter(event => event.data.workItemId === child.id).map(event => event.data.edgeId).slice(0, 3),
    ['planner-delivery', 'delivery-review', 'review-builder']);
  const states = run.emitted('assignment.state').map(event => event.data.state);
  assert.equal(states.filter(state => state === 'queued').length, 7);
  // A rejection is a completed review: its assignment succeeded with verdict fail.
  assert.equal(states.filter(state => state === 'succeeded').length, 7);
  assert.equal(states.filter(state => state === 'failed').length, 0);
  const visits = run.state.workItems[child.id].visits;
  assert.deepEqual(visits.map(visit => `${visit.nodeId}:${visit.result}`), [
    'builder:pass', 'reviewer:fail', 'builder:pass', 'reviewer:pass', 'ci:fail', 'builder:pass', 'reviewer:pass', 'ci:pass', 'merge:pass',
  ]);

  // Replaying the same events reproduces the state exactly.
  assert.equal(canonicalJson(replay(run.events)), canonicalJson(run.state));
});

test('loop limit fails the item, its parent and the run', () => {
  const run = new Driver();
  run.start({ graph: bare('build') });
  run.complete('planner', { outcome: 'success', items: [{ title: 'Risky' }] });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    run.complete('builder', built(attempt));
    run.complete('reviewer', { outcome: 'success', verdict: 'fail', summary: `still wrong ${attempt}` });
  }
  const child = run.items(item => item.parentId)[0];
  assert.equal(child.status, 'failed');
  assert.deepEqual(child.failure, { reason: 'loop_limit', message: 'Review loop reached its limit of 3 iterations.' });
  assert.equal(run.open('builder').length, 0);
  const parent = run.items(item => !item.parentId)[0];
  assert.equal(parent.failure.reason, 'children_failed');
  assert.equal(run.state.status, 'failed');
  assert.deepEqual(run.emitted('loop.iteration').filter(e => e.data.nodeId === 'review-loop').map(e => e.data.iteration), [1, 2, 3, 4]);
});

test('agent concurrency queues excess work in arrival order', () => {
  const run = new Driver();
  run.start();
  run.complete('planner', { outcome: 'success', items: Array.from({ length: 6 }, (_, i) => ({ title: `Item ${i + 1}` })) });
  assert.equal(run.open('builder').length, 4);
  const waiting = run.items(item => item.nodeId === 'builder' && item.status === 'queued');
  assert.deepEqual(waiting.map(item => item.title), ['Item 5', 'Item 6']);

  run.complete('builder', built(1));
  assert.equal(run.open('builder').length, 4);
  assert.equal(run.state.workItems[run.open('builder')[3].workItemId].title, 'Item 5');
  // Reviewer concurrency is 2: a third finished build waits for review.
  run.complete('builder', built(2));
  run.complete('builder', built(3));
  assert.equal(run.open('reviewer').length, 2);
  assert.equal(run.items(item => item.nodeId === 'reviewer' && item.status === 'queued').length, 1);
});

test('planner item limit truncates and an empty plan builds the input directly', () => {
  const run = new Driver();
  run.start();
  run.complete('planner', { outcome: 'success', items: Array.from({ length: 10 }, (_, i) => ({ title: `Item ${i}` })) });
  assert.equal(run.items(item => item.parentId).length, 8);
  assert.deepEqual(run.emitted('planner.items_truncated')[0].data.proposed, 10);

  const small = new Driver();
  small.start();
  small.complete('planner', { outcome: 'success', items: [] });
  assert.equal(small.items().length, 1);
  assert.equal(small.items()[0].nodeId, 'builder');
});

test('pause holds new work, resume dispatches it, stop cancels everything', () => {
  const run = new Driver();
  run.start();
  run.complete('planner', { outcome: 'success', items: [{ title: 'A' }, { title: 'B' }] });
  run.apply('run.paused');
  assert.equal(run.state.status, 'paused');
  assert.equal(run.apply('run.paused').ignored, 'already_paused');

  run.complete('builder', built(1));
  assert.equal(run.open('reviewer').length, 0, 'no new assignments while paused');
  assert.equal(run.items(item => item.nodeId === 'reviewer')[0].status, 'queued');
  run.apply('input.added', { items: [{ title: 'Late idea' }] });
  assert.equal(run.open('planner').length, 0);

  run.apply('run.resumed');
  assert.equal(run.open('reviewer').length, 1);
  assert.equal(run.open('planner').length, 1);

  const reviewer = run.open('reviewer')[0];
  run.apply('run.stopped', { reason: 'Changing plans.' });
  assert.equal(run.state.status, 'stopped');
  const cancelled = run.last.effects.filter(effect => effect.type === 'cancel-assignment').map(effect => effect.assignmentId);
  assert.ok(cancelled.includes(reviewer.id));
  assert.equal(cancelled.length, 3);
  assert.ok(run.items().every(item => item.status === 'failed' && item.failure.reason === 'run_stopped'));

  assert.equal(run.apply('assignment.completed', { assignmentId: reviewer.id, result: { outcome: 'success', summary: 'late' } }).ignored, 'run_not_active');
  assert.equal(run.apply('run.stopped').ignored, 'already_stopped');
  assert.throws(() => run.apply('input.added', { items: [{ title: 'x' }] }), code('RUN_NOT_ACTIVE'));
  assert.throws(() => run.apply('run.resumed'), code('INVALID_TRANSITION'));
});

test('stop cancels CI jobs and merge entries', () => {
  const run = new Driver();
  run.start({ inputs: [{ title: 'A' }, { title: 'B' }] });
  run.complete('planner', { outcome: 'success', items: [] });
  run.complete('planner', { outcome: 'success', items: [] });
  run.complete('builder', built(1));
  run.complete('builder', built(2));
  run.complete('reviewer', { outcome: 'success' });
  run.complete('reviewer', { outcome: 'success' });
  const [first] = Object.values(run.state.jobs);
  run.apply('job.completed', { jobId: first.id, status: 'passed' });
  run.apply('run.stopped');
  assert.deepEqual(run.effectTypes(run.last).filter(type => type.startsWith('cancel')).sort(), ['cancel-job', 'cancel-merge']);
});

test('a duplicate result for a closed assignment is ignored without changing state', () => {
  const run = new Driver();
  run.start();
  const planner = run.open('planner')[0];
  run.complete('planner', { outcome: 'success', items: [{ title: 'A' }] });
  const before = run.state;
  const result = step(before, run.event('assignment.completed', { assignmentId: planner.id, result: { outcome: 'success', summary: 'again', items: [{ title: 'B' }] } }));
  assert.equal(result.ignored, 'assignment_closed');
  assert.equal(result.state, before);
  assert.deepEqual(result.effects, []);
});

test('step is pure and deterministic', () => {
  const a = new Driver(), b = new Driver();
  for (const run of [a, b]) {
    run.start();
    run.complete('planner', { outcome: 'success', items: [{ title: 'A' }, { title: 'B' }] });
  }
  assert.equal(canonicalJson(a.state), canonicalJson(b.state));
  assert.deepEqual(a.effects, b.effects);
  const frozen = deepFreeze(structuredClone(a.state));
  const snapshot = canonicalJson(frozen);
  const result = step(frozen, a.event('assignment.completed', { assignmentId: a.open('builder')[0].id, result: built(1) }));
  assert.equal(canonicalJson(frozen), snapshot);
  assert.notEqual(result.state, frozen);
  assert.equal(JSON.parse(JSON.stringify(result.state)).status, 'running', 'state round-trips through JSON');
});

test('blocked assignments wait for a person to retry or fail them', () => {
  const run = new Driver();
  run.start({ graph: bare('build') });
  run.complete('planner', { outcome: 'success', items: [{ title: 'A' }, { title: 'B' }] });
  run.complete('builder', { outcome: 'blocked', summary: 'Need database credentials.' });
  const blocked = run.items(item => item.status === 'blocked')[0];
  assert.deepEqual(blocked.waiting, { kind: 'retry', nodeId: 'builder', summary: 'Need database credentials.', decisionId: 'hd_test1_1' });
  assert.equal(run.open('builder').length, 1);

  run.apply('human.decision', { workItemId: blocked.id, decision: 'pass', note: 'Credentials are in the vault now.' });
  assert.equal(run.open('builder').length, 2);
  assert.match(run.open('builder')[1].prompt, /human from human\):\nCredentials are in the vault now\./);
  assert.throws(() => run.apply('human.decision', { workItemId: blocked.id, decision: 'pass' }), code('NOT_WAITING'));

  run.complete('builder', { outcome: 'blocked', summary: 'Still stuck.' }, 1);
  run.apply('human.decision', { workItemId: blocked.id, decision: 'fail' });
  assert.equal(run.state.workItems[blocked.id].failure.reason, 'rejected_by_human');
});

test('human gates route on the decision', () => {
  const graph = template('improve');
  graph.nodes.push({ id: 'approve', type: 'human', label: 'Approve', position: { x: 0, y: 0 }, config: { prompt: 'Approve this merge?' } });
  graph.edges.find(edge => edge.id === 'ci-pass').to.node = 'approve';
  graph.edges.push(
    { id: 'approve-pass', kind: 'flow', from: { node: 'approve', port: 'pass' }, to: { node: 'merge' } },
    { id: 'approve-fail', kind: 'flow', from: { node: 'approve', port: 'fail' }, to: { node: 'improve-loop' } },
  );
  const run = new Driver();
  run.start({ graph });
  run.complete('auditor', { outcome: 'success', items: [] });
  run.complete('improver', built(1));
  run.complete('reviewer', { outcome: 'success' });
  run.apply('job.completed', { jobId: run.openJob().id, status: 'passed' });
  const [item] = run.items();
  assert.equal(item.status, 'blocked');
  assert.equal(run.emitted('human.requested')[0].data.prompt, 'Approve this merge?');

  run.apply('human.decision', { workItemId: item.id, decision: 'fail', note: 'Rename the flag first.' });
  assert.equal(run.state.workItems[item.id].iteration, 2);
  assert.match(run.open('improver')[0].prompt, /Rename the flag first\./);
  run.complete('improver', built(2));
  run.complete('reviewer', { outcome: 'success' });
  run.apply('job.completed', { jobId: run.openJob().id, status: 'passed' });
  run.apply('human.decision', { workItemId: item.id, decision: 'pass' });
  assert.ok(run.openMerge());
  assert.deepEqual(run.emitted('gate.result').filter(e => e.data.gate === 'human').map(e => e.data.result), ['fail', 'pass']);
});

test('merge rejection returns through the delivery loop, or fails without a fail route', () => {
  const run = new Driver();
  run.start();
  run.complete('planner', { outcome: 'success', items: [] });
  run.complete('builder', built(1));
  run.complete('reviewer', { outcome: 'success' });
  run.apply('job.completed', { jobId: run.openJob().id, status: 'passed' });
  run.apply('merge.rejected', { mergeId: run.openMerge().id, reason: 'Conflicts with main.' });
  assert.equal(run.state.workItems[run.items()[0].id].loopCounts['delivery-loop'], 2);
  assert.match(run.open('builder')[0].prompt, /merge from merge\):\nConflicts with main\./);

  const graph = template('build');
  graph.edges = graph.edges.filter(edge => edge.id !== 'merge-fail');
  const strict = new Driver();
  strict.start({ graph });
  strict.complete('planner', { outcome: 'success', items: [] });
  strict.complete('builder', built(1));
  strict.complete('reviewer', { outcome: 'success' });
  strict.apply('job.completed', { jobId: strict.openJob().id, status: 'passed' });
  strict.apply('merge.rejected', { mergeId: strict.openMerge().id, reason: 'Branch protection.' });
  assert.equal(strict.items()[0].failure.reason, 'merge_rejected');
});

test('CI without a head commit and agent failure fail the item', () => {
  const run = new Driver();
  run.start({ graph: bare('build'), inputs: [{ title: 'A' }, { title: 'B' }] });
  run.complete('planner', { outcome: 'success', items: [] });
  run.complete('planner', { outcome: 'success', items: [] });
  run.complete('builder', { outcome: 'success', summary: 'forgot to push' });
  run.complete('reviewer', { outcome: 'success' });
  run.complete('builder', { outcome: 'failure', summary: 'Cannot build on this OS.' });
  const reasons = run.items().map(item => item.failure?.reason).sort();
  assert.deepEqual(reasons, ['assignment_failed', 'missing_head_sha']);
  assert.equal(run.state.status, 'failed');
});

test('keepOpen runs wait for more input instead of completing', () => {
  const run = new Driver();
  const graph = { schema: 'perpeto.workflow/1', nodes: [
    { id: 'in', type: 'input', label: 'In', position: { x: 0, y: 0 }, config: { source: 'manual' } },
    { id: 'out', type: 'output', label: 'Out', position: { x: 1, y: 0 }, config: {} },
  ], edges: [{ id: 'e', kind: 'flow', from: { node: 'in' }, to: { node: 'out' } }] };
  run.start({ graph, repo: undefined, keepOpen: true });
  assert.equal(run.items()[0].status, 'done');
  assert.equal(run.state.status, 'running');
  run.apply('input.added', { items: [{ title: 'More' }] });
  assert.equal(run.items().length, 2);
});

test('rejects invalid events', () => {
  const run = new Driver();
  assert.throws(() => run.apply('job.completed', { jobId: 'job_x', status: 'passed' }), code('RUN_NOT_FOUND'));
  assert.throws(() => run.start({ graph: { schema: 'perpeto.workflow/1', nodes: [], edges: [] } }), code('INVALID_GRAPH'));
  assert.throws(() => run.start({ repo: undefined }), code('INVALID_EVENT'));
  run.start();
  assert.throws(() => run.start(), code('RUN_EXISTS'));
  const assignmentId = run.open('planner')[0].id;
  assert.throws(() => run.apply('assignment.completed', { assignmentId: 'asg_missing', result: { outcome: 'success', summary: '' } }), code('NOT_FOUND'));
  assert.throws(() => run.apply('assignment.completed', { assignmentId, result: { outcome: 'great', summary: '' } }), code('INVALID_EVENT'));
  assert.throws(() => run.apply('assignment.completed', { assignmentId, result: { outcome: 'success', summary: '', headSha: 'abc' } }), code('INVALID_EVENT'));
  assert.throws(() => step(run.state, { id: 'x', type: 'run.exploded', at: '2026-10-21T00:00:00Z' }), code('INVALID_EVENT'));
  assert.throws(() => step(run.state, { id: 'x', type: 'run.paused', at: 'yesterday' }), code('INVALID_EVENT'));
  assert.throws(() => run.apply('input.added', { items: [] }), code('INVALID_EVENT'));
});
