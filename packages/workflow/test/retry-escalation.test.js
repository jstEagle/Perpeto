import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateGraph, compileGraph, step, replay, canonicalJson, computeRunMetrics, RunStore, MAX_UNATTENDED_ESCALATIONS,
} from '../src/index.js';
import { Driver, template, bare, sha, code } from './fixtures.js';

const built = n => ({ outcome: 'success', summary: `built ${n}`, branch: `feat/${n}`, prUrl: `https://git.example/app/pull/${n}`, headSha: sha(n) });
const pass = { outcome: 'success', verdict: 'pass', summary: 'Ready.' };
const reject = summary => ({ outcome: 'success', verdict: 'fail', summary });
const crash = summary => ({ outcome: 'failure', summary });
const plus = (iso, seconds) => new Date(Date.parse(iso) + seconds * 1000).toISOString();
const codes = result => result.errors.map(error => error.code);
const harness = { provider: 'claudeAgent', model: 'claude-sonnet-5-5' };
const node = (id, type, config = {}) => ({ id, type, label: id, position: { x: 0, y: 0 }, config });
const flow = (id, from, to, port) => ({ id, kind: 'flow', from: port ? { node: from, port } : { node: from }, to: { node: to } });

/** Start the build template and plan one item straight to the builder. */
function building(graph = template('build')) {
  const run = new Driver();
  run.start({ graph });
  run.complete('planner', { outcome: 'success', items: [] });
  return run;
}
const item = run => run.items()[0];
const toReview = (run, n = 1) => { run.complete('builder', built(n)); return run; };

test('review verdicts decide the gate; legacy success still passes', () => {
  const run = toReview(building());
  run.complete('reviewer', reject('Add tests.'));
  assert.equal(item(run).loopCounts['review-loop'], 2);
  assert.equal(run.emitted('gate.result').at(-1).data.result, 'fail');
  assert.match(run.open('builder')[0].prompt, /review from reviewer\):\nAdd tests\./);
  assert.match(run.open('builder')[0].prompt, /This is attempt 2 in the current loop\./);

  toReview(run, 2);
  assert.match(run.open('reviewer')[0].prompt, /verdict "pass" if the work passes review, or verdict "fail"/);
  run.complete('reviewer', { outcome: 'success', summary: 'Fine.' });
  const gate = run.emitted('gate.result').at(-1).data;
  assert.deepEqual([gate.result, gate.legacyVerdict], ['pass', true]);
  assert.ok(run.openJob());

  assert.throws(() => run.apply('assignment.completed', { assignmentId: 'asg_x', result: { outcome: 'success', summary: '', verdict: 'maybe' } }), code('NOT_FOUND'));
  const other = toReview(building());
  assert.throws(() => other.complete('reviewer', { outcome: 'success', verdict: 'maybe' }), code('INVALID_EVENT'));
});

test('a failed review without a verdict is retried with backoff, then escalated to the senior reviewer', () => {
  const run = toReview(building());
  const first = run.open('reviewer')[0];
  run.complete('reviewer', crash('Harness crashed.'));
  const at = run.events.at(-1).at;
  assert.equal(run.emitted('gate.result').length, 0, 'an error is not a verdict');
  assert.equal(item(run).loopCounts['review-loop'], 1, 'an error does not count as a loop iteration');
  const second = run.open('reviewer')[0];
  assert.deepEqual({ attempt: second.attempt, retryOf: second.retryOf, notBefore: second.notBefore }, { attempt: 2, retryOf: first.id, notBefore: plus(at, 30) });
  assert.match(second.prompt, /This is retry 2 of 3 at this step\. The previous attempt failed: Harness crashed\./);
  assert.deepEqual(run.emitted('workitem.retried')[0].data, {
    workItemId: item(run).id, nodeId: 'reviewer', attempt: 2, maxAttempts: 3, reason: 'review_error', summary: 'Harness crashed.',
    assignmentId: first.id, notBefore: plus(at, 30),
  });

  run.complete('reviewer', crash('Crashed again.'));
  assert.equal(run.open('reviewer')[0].notBefore, plus(run.events.at(-1).at, 60), 'backoff doubles');
  const third = run.open('reviewer')[0];
  run.complete('reviewer', crash('Third crash.'));
  const [escalated] = run.emitted('workitem.escalated');
  assert.deepEqual(escalated.data, {
    workItemId: item(run).id, from: 'reviewer', to: 'senior-reviewer', reason: 'retries_exhausted',
    evidence: {
      attempts: 3, maxAttempts: 3, error: 'review_error', lastError: 'Third crash.',
      refs: [{ assignmentId: first.id }, { assignmentId: second.id }, { assignmentId: third.id }],
    },
  });
  const senior = run.open('senior-reviewer')[0];
  assert.equal(senior.attempt, 1);
  assert.match(senior.prompt, /Escalated to you from reviewer:\nReviewer failed all 3 attempts\. Last error: Third crash\./);
  run.complete('senior-reviewer', pass);
  assert.ok(run.openJob(), 'senior pass goes to CI');
  assert.deepEqual(item(run).visits.filter(v => v.nodeId === 'reviewer').map(v => v.result), ['error', 'error', 'error']);
});

test('agent failures retry with exponential backoff, then go to triage where a person decides', () => {
  const run = building();
  for (const [n, delay] of [[1, 60], [2, 120]]) {
    run.complete('builder', crash(`Out of disk ${n}.`));
    const next = run.open('builder')[0];
    assert.deepEqual([next.attempt, next.notBefore], [n + 1, plus(run.events.at(-1).at, delay)]);
  }
  run.complete('builder', crash('Out of disk 3.'));
  const triaged = item(run);
  assert.equal(triaged.nodeId, 'triage');
  assert.equal(triaged.status, 'blocked');
  assert.equal(run.emitted('workitem.escalated')[0].data.reason, 'retries_exhausted');
  const request = run.emitted('human.requested')[0].data;
  assert.equal(request.nodeId, 'triage');
  assert.deepEqual(request.context, { kind: 'escalation', from: 'builder', summary: 'Builder failed all 3 attempts. Last error: Out of disk 3.' });

  run.apply('human.decision', { workItemId: triaged.id, decision: 'pass', note: 'Disk cleaned up.' });
  assert.equal(item(run).loopCounts['delivery-loop'], 2);
  const builder = run.open('builder')[0];
  assert.equal(builder.attempt, 1, 'a fresh visit starts at attempt 1');
  assert.match(builder.prompt, /human from triage\):\nDisk cleaned up\./);

  for (let n = 1; n <= 3; n += 1) run.complete('builder', crash('Still broken.'));
  run.apply('human.decision', { workItemId: triaged.id, decision: 'fail', note: 'Not worth it.' });
  assert.deepEqual(item(run).failure, { reason: 'rejected_by_human', message: 'Not worth it.' });
  assert.equal(run.state.status, 'failed');
});

test('without escalation, exhausted retries fail the item with the original reason', () => {
  const graph = bare('build');
  graph.nodes.find(n => n.id === 'planner').config.retry = { maxAttempts: 2 };
  const run = new Driver();
  run.start({ graph });
  run.complete('planner', crash('Model overloaded.'));
  assert.equal(run.open('planner')[0].attempt, 2);
  assert.equal(run.open('planner')[0].notBefore, undefined, 'no backoff configured');
  run.complete('planner', crash('Model overloaded.'));
  assert.deepEqual(item(run).failure, { reason: 'assignment_failed', message: 'Planner failed all 2 attempts. Last error: Model overloaded.' });
});

test('CI jobs that error or are cancelled are retried at the same commit, then escalated', () => {
  const run = toReview(building());
  run.complete('reviewer', pass);
  const first = run.openJob();
  run.apply('job.completed', { jobId: first.id, status: 'error', summary: 'Runner lost.', logRef: 'logs/1' });
  assert.equal(run.emitted('gate.result').filter(e => e.data.gate === 'ci').length, 0);
  assert.equal(item(run).feedback, undefined, 'an infrastructure error is not CI feedback');
  const second = run.openJob();
  assert.deepEqual([second.attempt, second.revision, second.retryOf, second.notBefore], [2, first.revision, first.id, plus(run.events.at(-1).at, 120)]);
  run.apply('job.completed', { jobId: second.id, status: 'cancelled' });
  assert.equal(run.emitted('workitem.retried').at(-1).data.reason, 'job_cancelled');
  run.apply('job.completed', { jobId: run.openJob().id, status: 'error' });
  assert.equal(item(run).nodeId, 'triage');
  assert.equal(run.emitted('workitem.escalated')[0].data.evidence.refs.length, 3);
  assert.throws(() => run.apply('job.completed', { jobId: first.id, status: 'exploded' }), code('INVALID_EVENT'));

  const strict = toReview(building(bare('build')));
  strict.complete('reviewer', pass);
  strict.apply('job.completed', { jobId: strict.openJob().id, status: 'error', summary: 'Runner lost.' });
  assert.deepEqual(item(strict).failure, { reason: 'job_error', message: 'Runner lost.' });
});

test('an exhausted review loop escalates to the senior reviewer with the rework evidence', () => {
  const run = building();
  for (let n = 1; n <= 3; n += 1) { toReview(run, n); run.complete('reviewer', reject(`Problem ${n}.`)); }
  const [escalated] = run.emitted('workitem.escalated');
  assert.equal(escalated.data.reason, 'loop_limit');
  assert.deepEqual(escalated.data.evidence.feedback, { kind: 'review', from: 'reviewer', summary: 'Problem 3.' });
  assert.deepEqual([escalated.data.evidence.iterations, escalated.data.evidence.maxIterations], [3, 3]);
  assert.deepEqual(escalated.data.evidence.visits.map(v => `${v.nodeId}:${v.result}`),
    ['builder:pass', 'reviewer:fail', 'builder:pass', 'reviewer:fail', 'builder:pass', 'reviewer:fail']);
  const current = item(run);
  assert.equal(current.loopCounts['review-loop'], undefined, 'escalation clears the exhausted loop count');
  assert.deepEqual(current.escalations.map(r => [r.from, r.to, r.reason, r.iterations]), [['review-loop', 'senior-reviewer', 'loop_limit', 3]]);
  assert.match(run.open('senior-reviewer')[0].prompt,
    /Escalated to you from review-loop:\nReview loop reached its limit of 3 iterations\.\n\nLatest feedback \(review from reviewer\):\nProblem 3\./);

  run.complete('senior-reviewer', reject('Needs a design decision.'));
  assert.equal(item(run).nodeId, 'triage');
  assert.equal(run.emitted('human.requested')[0].data.context.summary, 'Needs a design decision.');
  run.apply('human.decision', { workItemId: current.id, decision: 'pass', note: 'Use the simpler schema.' });
  assert.deepEqual(item(run).loopCounts, { 'delivery-loop': 2, 'review-loop': 1 });
  assert.match(run.open('builder')[0].prompt, /Use the simpler schema\./);
});

test('an exhausted delivery loop goes to triage and a pass restarts its count', () => {
  const run = building();
  for (let n = 1; n <= 3; n += 1) {
    toReview(run, n);
    run.complete('reviewer', pass);
    run.apply('job.completed', { jobId: run.openJob().id, status: 'failed', summary: `red ${n}` });
  }
  assert.equal(item(run).nodeId, 'triage');
  assert.equal(run.emitted('workitem.escalated')[0].data.from, 'delivery-loop');
  run.apply('human.decision', { workItemId: item(run).id, decision: 'pass' });
  assert.equal(item(run).loopCounts['delivery-loop'], 1);
  assert.equal(item(run).nodeId, 'builder');
});

test('automatic escalations stop after the unattended limit', () => {
  const graph = {
    schema: 'perpeto.workflow/1',
    nodes: [
      node('in', 'input', { source: 'manual' }),
      node('loop', 'loop', { until: 'review-pass', maxIterations: 1, onExhausted: 'fixer' }),
      node('dev', 'agent', { harness, prompt: 'Build.' }),
      node('rev', 'review', { harness, prompt: 'Review.' }),
      node('fixer', 'agent', { harness, prompt: 'Fix the stuck item.' }),
      node('out', 'output'),
    ],
    edges: [flow('a', 'in', 'loop'), flow('b', 'loop', 'dev'), flow('c', 'dev', 'rev'), flow('d', 'rev', 'out', 'pass'),
      flow('e', 'rev', 'loop', 'fail'), flow('f', 'fixer', 'loop')],
  };
  assert.deepEqual(validateGraph(graph), { ok: true, errors: [], warnings: [] });
  const run = new Driver();
  run.start({ graph, repo: undefined });
  for (let round = 1; round <= MAX_UNATTENDED_ESCALATIONS; round += 1) {
    run.complete('dev', { outcome: 'success', summary: 'built' });
    run.complete('rev', reject('no'));
    run.complete('fixer', { outcome: 'success', summary: 'tried' });
  }
  run.complete('dev', { outcome: 'success', summary: 'built' });
  run.complete('rev', reject('no'));
  assert.equal(run.emitted('workitem.escalated').length, MAX_UNATTENDED_ESCALATIONS);
  assert.equal(item(run).failure.reason, 'loop_limit');
  assert.match(item(run).failure.message, /Not escalated to fixer: 3 automatic escalations already happened without a person\./);
});

test('blocked work routes to a human gate when one is configured, otherwise waits in place', () => {
  const run = building();
  run.complete('builder', { outcome: 'blocked', summary: 'Need database credentials.' });
  const blocked = item(run);
  assert.deepEqual([blocked.nodeId, blocked.status, blocked.waiting], ['triage', 'blocked', { kind: 'human', nodeId: 'triage', decisionId: 'hd_test1_1' }]);
  assert.deepEqual(run.emitted('workitem.blocked')[0].data, { workItemId: blocked.id, nodeId: 'builder', summary: 'Need database credentials.', routedTo: 'triage' });
  assert.deepEqual(run.emitted('workitem.escalated')[0].data, {
    workItemId: blocked.id, from: 'builder', to: 'triage', reason: 'blocked', evidence: { summary: 'Need database credentials.' },
  });
  assert.equal(run.emitted('human.requested')[0].data.context.kind, 'blocked');
  const metrics = computeRunMetrics(run.state, run.log, { now: plus(run.state.updatedAt, 7200) });
  assert.deepEqual(metrics.bottlenecks, [{ nodeId: 'triage', reason: 'waiting-on-human', severity: 'warning', evidence: '1 item waiting for a person; oldest 2h' }]);
  assert.equal(metrics.run.waitingOnHuman, 1);

  // The planner has no human gate configured, so a blocked plan waits at the planner.
  const held = new Driver();
  held.start();
  held.complete('planner', { outcome: 'blocked', summary: 'Which product area?' });
  assert.deepEqual(item(held).waiting, { kind: 'retry', nodeId: 'planner', summary: 'Which product area?', decisionId: 'hd_test1_1' });
  const waiting = computeRunMetrics(held.state, held.log, { now: plus(held.state.updatedAt, 60) });
  assert.deepEqual(waiting.bottlenecks.map(b => `${b.nodeId}:${b.reason}`), ['planner:waiting-on-human']);
  assert.equal(waiting.run.waitingOnHuman, 1);
});

test('validation checks retry policies and escalation targets', () => {
  const minimal = () => ({
    schema: 'perpeto.workflow/1',
    nodes: [node('in', 'input', { source: 'manual' }), node('dev', 'agent', { harness, prompt: 'Build it.' }), node('out', 'output')],
    edges: [flow('e1', 'in', 'dev'), flow('e2', 'dev', 'out')],
  });
  const withDev = config => { const graph = minimal(); Object.assign(graph.nodes[1].config, config); return graph; };
  const human = node('help', 'human', { prompt: 'Help?' });

  assert.ok(codes(validateGraph(withDev({ retry: { maxAttempts: 0 } }))).includes('INVALID_RETRY'));
  assert.ok(codes(validateGraph(withDev({ retry: { maxAttempts: 2, backoffSec: -1 } }))).includes('INVALID_RETRY'));
  assert.ok(codes(validateGraph(withDev({ retry: { maxAttempts: 2, jitter: true } }))).includes('INVALID_RETRY'));
  assert.ok(codes(validateGraph(withDev({ onExhausted: 'ghost' }))).includes('INVALID_ESCALATION'));
  assert.ok(codes(validateGraph(withDev({ onExhausted: 'dev' }))).includes('INVALID_ESCALATION'));
  assert.ok(codes(validateGraph(withDev({ onExhausted: 'out' }))).includes('INVALID_ESCALATION'));
  assert.ok(codes(validateGraph(withDev({ onExhausted: 7 }))).includes('INVALID_ESCALATION'));

  // A human escalation target needs only a pass edge and is reachable through the escalation alone.
  const ok = withDev({ retry: { maxAttempts: 2, backoffSec: 10 }, onExhausted: 'help' });
  ok.nodes.push(human);
  ok.edges.push(flow('e3', 'help', 'out', 'pass'));
  assert.deepEqual(validateGraph(ok), { ok: true, errors: [], warnings: [] });
  const plan = compileGraph(ok);
  assert.deepEqual(plan.nodes.dev.escalation, { exhausted: 'help', blocked: 'help' });
  assert.deepEqual(plan.nodes.dev.config.retry, { maxAttempts: 2, backoffSec: 10 });
  assert.deepEqual(plan.escalations, [{ from: 'dev', to: 'help', on: 'exhausted' }]);
  assert.deepEqual(compileGraph(minimal()).nodes.dev.config.retry, { maxAttempts: 1, backoffSec: 0 });

  const notHuman = withDev({ onBlocked: 'fixer' });
  notHuman.nodes.push(node('fixer', 'agent', { harness, prompt: 'Fix.' }));
  notHuman.edges.push(flow('e3', 'fixer', 'out'));
  assert.ok(codes(validateGraph(notHuman)).includes('INVALID_ESCALATION'));

  const unwired = minimal();
  unwired.nodes.push(human);
  unwired.edges = [flow('e1', 'in', 'help'), flow('e3', 'help', 'dev', 'pass'), flow('e2', 'dev', 'out')];
  assert.ok(codes(validateGraph(unwired)).includes('GATE_UNWIRED'), 'only escalation targets may leave fail unwired');

  const cycle = withDev({ onExhausted: 'fixer' });
  cycle.nodes.push(node('fixer', 'agent', { harness, prompt: 'Fix.' }));
  cycle.edges.push(flow('e3', 'fixer', 'dev'));
  assert.ok(codes(validateGraph(cycle)).includes('FLOW_CYCLE'), 'a cycle through an escalation needs a loop');
});

test('runs with retries and escalations replay deterministically and survive a store restart', t => {
  const directory = mkdtempSync(join(tmpdir(), 'perpeto-retry-'));
  const filename = join(directory, 'runs.sqlite');
  const holder = { store: new RunStore(filename) };
  t.after(() => { try { holder.store.close(); } catch { /* Already closed. */ } rmSync(directory, { recursive: true, force: true }); });
  const run = new Driver((_state, event) => holder.store.apply('run_test1', event));
  run.start();
  run.complete('planner', { outcome: 'success', items: [{ title: 'A' }, { title: 'B' }] });
  run.complete('builder', crash('Flaky network.'));
  run.complete('builder', built(1), 0);
  run.complete('reviewer', crash('Reviewer crashed.'));

  holder.store.close();
  holder.store = new RunStore(filename);
  run.state = holder.store.getState('run_test1');
  const pending = holder.store.pendingEffects({ limit: 500 }).map(entry => entry.effect);
  const retried = pending.filter(effect => effect.type === 'create-assignment' && effect.assignment.attempt === 2);
  assert.deepEqual(retried.map(effect => effect.assignment.nodeId).sort(), ['builder', 'reviewer']);
  assert.ok(retried.every(effect => effect.assignment.notBefore && effect.assignment.retryOf));

  for (let n = 2; n <= 3; n += 1) run.complete('reviewer', crash('Reviewer crashed.'));
  run.complete('senior-reviewer', reject('Wrong approach.'));
  run.complete('builder', { outcome: 'blocked', summary: 'Need a token.' });
  assert.equal(run.items(entry => entry.nodeId === 'triage').length, 2);

  holder.store.close();
  holder.store = new RunStore(filename);
  run.state = holder.store.getState('run_test1');
  for (const entry of run.items(candidate => candidate.nodeId === 'triage')) run.apply('human.decision', { workItemId: entry.id, decision: 'fail' });
  assert.equal(run.state.status, 'failed');
  assert.deepEqual(holder.store.verify('run_test1'), { ok: true, events: run.events.length });
  assert.equal(canonicalJson(replay(run.events)), canonicalJson(run.state));
  // Same events, fresh engine: identical effects.
  let state = null;
  const effects = [];
  for (const event of run.events) { const result = step(state, event); state = result.state; effects.push(...result.effects); }
  assert.deepEqual(effects, run.effects);
});

test('metrics count retries, errors and escalations, and rework-loop evidence names the escalation', () => {
  const run = building();
  run.complete('builder', crash('Flaky.'));
  for (let n = 1; n <= 3; n += 1) { toReview(run, n); run.complete('reviewer', reject(`Problem ${n}.`)); }
  const metrics = computeRunMetrics(run.state, run.log, { now: run.event('clock').at });
  const builder = metrics.nodes.find(entry => entry.nodeId === 'builder');
  assert.deepEqual({ done: builder.done, errors: builder.errors, retries: builder.retries, failureRate: builder.failureRate }, { done: 3, errors: 1, retries: 1, failureRate: 0.25 });
  assert.equal(metrics.nodes.find(entry => entry.nodeId === 'review-loop').escalations, 1);
  assert.deepEqual([metrics.run.retries, metrics.run.escalations, metrics.run.waitingOnHuman], [1, 1, 0]);
  const rework = metrics.bottlenecks.find(b => b.reason === 'rework-loop');
  assert.deepEqual(rework, {
    nodeId: 'review-loop', reason: 'rework-loop', severity: 'critical',
    evidence: 'average 3 iterations over 1 item (expected 2, limit 3); 1 hit the limit; 1 escalated to senior-reviewer',
  });

  const flaky = building();
  for (let n = 1; n <= 3; n += 1) flaky.complete('builder', crash('Flaky.'));
  flaky.apply('human.decision', { workItemId: item(flaky).id, decision: 'pass' });
  flaky.complete('builder', crash('Flaky.'));
  const failing = computeRunMetrics(flaky.state, flaky.log, { now: flaky.event('clock').at });
  assert.deepEqual(failing.bottlenecks.find(b => b.reason === 'high-failure'), {
    nodeId: 'builder', reason: 'high-failure', severity: 'critical',
    evidence: '4 of 4 finished visits failed (100%) in the last 24h; 4 were errors, 3 retried',
  });
});
