import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRunMetrics } from '../src/index.js';
import { Driver, template, bare, sha, code } from './fixtures.js';

const built = n => ({ outcome: 'success', summary: 'built', branch: `b${n}`, prUrl: `https://git.example/pull/${n}`, headSha: sha(n) });
const minutesAfter = (iso, minutes) => new Date(Date.parse(iso) + minutes * 60000).toISOString();
const metricsOf = (run, options = {}) => computeRunMetrics(run.state, run.log, { now: run.event('clock').at, ...options });
const node = (metrics, id) => metrics.nodes.find(entry => entry.nodeId === id);
const edge = (metrics, id) => metrics.edges.find(entry => entry.edgeId === id);
const reasons = metrics => metrics.bottlenecks.map(b => `${b.nodeId}:${b.reason}:${b.severity}`);

function fullRun() {
  const run = new Driver();
  run.start();
  run.complete('planner', { outcome: 'success', items: [{ title: 'Login form' }] });
  const builder = run.open('builder')[0];
  run.hub('assignment.state', { assignmentId: builder.id, state: 'leased', machineId: 'mch_a' });
  run.hub('assignment.state', { assignmentId: builder.id, state: 'running', machineId: 'mch_a' });
  run.complete('builder', built(1));
  run.complete('reviewer', { outcome: 'success', verdict: 'fail', summary: 'Needs tests.' });
  run.complete('builder', built(2));
  run.complete('reviewer', { outcome: 'success' });
  run.apply('job.completed', { jobId: run.openJob().id, status: 'failed' });
  run.complete('builder', built(3));
  run.complete('reviewer', { outcome: 'success' });
  run.apply('job.completed', { jobId: run.openJob().id, status: 'passed' });
  run.apply('merge.completed', { mergeId: run.openMerge().id });
  return run;
}

test('measures nodes, edges and velocity for a finished run', () => {
  const run = fullRun();
  const builderAssignment = Object.values(run.state.assignments).find(a => a.nodeId === 'builder');
  const metrics = metricsOf(run, { usage: [
    { assignmentId: builderAssignment.id, inputTokens: 1000, outputTokens: 500, at: run.state.updatedAt },
    { assignmentId: builderAssignment.id, inputTokens: 1, outputTokens: 1, at: '2020-01-01T00:00:00Z' },
  ] });
  assert.equal(metrics.runId, 'run_test1');
  assert.equal(metrics.windowSec, 86400);

  const reviewer = node(metrics, 'reviewer');
  assert.deepEqual({ done: reviewer.done, failed: reviewer.failed, failureRate: reviewer.failureRate, concurrency: reviewer.concurrency, queued: reviewer.queued, active: reviewer.active, utilization: reviewer.utilization },
    { done: 2, failed: 1, failureRate: 0.33, concurrency: 2, queued: 0, active: 0, utilization: 0 });
  assert.equal(reviewer.serviceSec.avg, 60);
  const builder = node(metrics, 'builder');
  assert.equal(builder.done, 3);
  assert.equal(builder.tokens, 1500);
  // The first build was leased a minute after it was queued; the hub's start time drives wait and service.
  assert.deepEqual(builder.waitSec, { avg: 20, p90: 60 });
  assert.deepEqual(node(metrics, 'ci'), { ...node(metrics, 'ci'), done: 1, failed: 1, concurrency: null, utilization: null });
  assert.ok(builder.throughputPerHour > 0);

  assert.equal(edge(metrics, 'reviewer-fail').count, 1);
  assert.equal(edge(metrics, 'builder-reviewer').count, 3);
  assert.equal(edge(metrics, 'merge-pass').count, 1);
  assert.equal(edge(metrics, 'builder-helper').count, 0);
  assert.ok(metrics.edges.every(entry => entry.unplanned === false));

  const child = run.items(item => item.parentId)[0];
  assert.equal(metrics.run.cycleTimeSec.avg, (Date.parse(child.completedAt) - Date.parse(child.createdAt)) / 1000);
  assert.equal(metrics.run.wip, 0);
  assert.equal(metrics.run.velocity.trend.length, 24);
  assert.equal(metrics.run.velocity.trend.reduce((a, b) => a + b, 0), 1);
  assert.ok(metrics.run.velocity.itemsDonePerDay > 0);
  assert.equal(metrics.run.tokensPerItem, 1500);
  assert.equal(metrics.run.activeAgents, 0);
  assert.deepEqual(metrics.bottlenecks, []);
});

test('windows exclude old activity', () => {
  const run = fullRun();
  const later = computeRunMetrics(run.state, run.log, { now: minutesAfter(run.state.updatedAt, 60 * 24 * 3), window: '24h' });
  assert.equal(node(later, 'reviewer').done, 0);
  assert.equal(edge(later, 'reviewer-fail').count, 0);
  assert.equal(later.run.velocity.itemsDonePerDay, 0);
  const week = computeRunMetrics(run.state, run.log, { now: minutesAfter(run.state.updatedAt, 60 * 24 * 3), window: '7d' });
  assert.equal(week.run.velocity.trend.length, 7);
  assert.equal(node(week, 'reviewer').done, 2);
});

test('reports active agents per machine and unplanned interactions', () => {
  const run = new Driver();
  run.start();
  run.complete('planner', { outcome: 'success', items: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] });
  const [first, second, third] = run.open('builder');
  run.hub('assignment.state', { assignmentId: first.id, state: 'running', machineId: 'mch_b' });
  run.hub('assignment.state', { assignmentId: second.id, state: 'leased', machineId: 'mch_a' });
  run.hub('assignment.state', { assignmentId: third.id, state: 'running', machineId: 'mch_b' });
  run.hub('agent.messaged', { from: 'builder', to: 'reviewer', edgeId: 'builder-reviewer-messages', unplanned: false });
  run.hub('agent.messaged', { from: 'reviewer', to: 'builder' });
  run.hub('agent.messaged', { from: 'helper', to: 'reviewer', unplanned: true });
  run.hub('agent.delegated', { from: 'builder', to: 'helper' });
  run.hub('agent.delegated', { from: 'planner', to: 'helper' });
  const metrics = metricsOf(run);
  assert.equal(metrics.run.activeAgents, 3);
  assert.deepEqual(metrics.run.machines, [
    { machineId: 'mch_a', activeAgents: 1, nodes: ['builder'] },
    { machineId: 'mch_b', activeAgents: 2, nodes: ['builder'] },
  ]);
  assert.equal(metrics.run.wip, 3);
  assert.equal(edge(metrics, 'builder-reviewer-messages').count, 2);
  assert.equal(edge(metrics, 'builder-helper').count, 1);
  assert.deepEqual(metrics.edges.filter(entry => entry.unplanned), [
    { edgeId: 'unplanned:delegates:planner->helper', kind: 'delegates', count: 1, unplanned: true, from: 'planner', to: 'helper' },
    { edgeId: 'unplanned:messages:helper->reviewer', kind: 'messages', count: 1, unplanned: true, from: 'helper', to: 'reviewer' },
  ]);
});

test('saturated agent pools are flagged with the numbers behind them', () => {
  const graph = template('build');
  graph.nodes.find(n => n.id === 'builder').config.concurrency = 2;
  const run = new Driver();
  run.start({ graph });
  run.complete('planner', { outcome: 'success', items: Array.from({ length: 6 }, (_, i) => ({ title: `Item ${i}` })) });
  const metrics = metricsOf(run);
  assert.deepEqual(node(metrics, 'builder'), { ...node(metrics, 'builder'), queued: 4, active: 2, utilization: 1 });
  const saturated = metrics.bottlenecks.find(b => b.reason === 'saturated');
  assert.deepEqual(saturated, {
    nodeId: 'builder', reason: 'saturated', severity: 'critical',
    evidence: 'utilization 1.00 (2 of 2 slots busy); queue 4, up from 0 at window start',
  });
});

test('queue growth while paused is flagged', () => {
  const run = new Driver();
  run.start();
  run.complete('planner', { outcome: 'success', items: Array.from({ length: 4 }, (_, i) => ({ title: `Item ${i}` })) });
  run.apply('run.paused');
  for (let i = 1; i <= 4; i += 1) run.complete('builder', built(i));
  const metrics = metricsOf(run);
  assert.equal(node(metrics, 'reviewer').queued, 4);
  assert.deepEqual(metrics.bottlenecks, [{ nodeId: 'reviewer', reason: 'queue-growing', severity: 'warning', evidence: 'queue 4, up from 0 at window start' }]);
});

test('repeated review failures show as high-failure and rework-loop', () => {
  const run = new Driver();
  run.start({ graph: bare('build') });
  run.complete('planner', { outcome: 'success', items: [{ title: 'A' }, { title: 'B' }] });
  for (let round = 1; round <= 3; round += 1) {
    run.complete('builder', built(round));
    run.complete('builder', built(round + 10));
    run.complete('reviewer', { outcome: 'success', verdict: 'fail', summary: 'no' });
    run.complete('reviewer', { outcome: 'success', verdict: 'fail', summary: 'no' });
  }
  const metrics = metricsOf(run);
  assert.deepEqual(reasons(metrics), ['review-loop:rework-loop:critical', 'reviewer:high-failure:critical']);
  const failure = metrics.bottlenecks.find(b => b.reason === 'high-failure');
  assert.equal(failure.evidence, '6 of 6 finished visits failed (100%) in the last 24h');
  assert.equal(metrics.bottlenecks[0].evidence, 'average 3 iterations over 2 items (expected 2, limit 3); 2 hit the limit');
});

test('rework above the expected average is a warning before the limit', () => {
  const run = new Driver();
  run.start();
  run.complete('planner', { outcome: 'success', items: [{ title: 'A' }] });
  run.complete('builder', built(1));
  run.complete('reviewer', { outcome: 'success', verdict: 'fail', summary: 'no' });
  run.complete('builder', built(2));
  run.complete('reviewer', { outcome: 'success', verdict: 'fail', summary: 'no' });
  assert.deepEqual(reasons(metricsOf(run)), ['review-loop:rework-loop:warning']);
});

test('blocked work is waiting on a person', () => {
  const run = new Driver();
  run.start({ graph: bare('build') });
  run.complete('planner', { outcome: 'success', items: [{ title: 'A' }] });
  run.complete('builder', { outcome: 'blocked', summary: 'Need credentials.' });
  const soon = computeRunMetrics(run.state, run.log, { now: minutesAfter(run.state.updatedAt, 10) });
  assert.deepEqual(soon.bottlenecks, [{ nodeId: 'builder', reason: 'waiting-on-human', severity: 'info', evidence: '1 item waiting for a person; oldest 10m' }]);
  const later = computeRunMetrics(run.state, run.log, { now: minutesAfter(run.state.updatedAt, 150) });
  assert.equal(later.bottlenecks[0].severity, 'warning');
  assert.equal(later.bottlenecks[0].evidence, '1 item waiting for a person; oldest 2.5h');
});

test('work no online machine can take is no-capacity', () => {
  const run = new Driver();
  run.start();
  run.complete('planner', { outcome: 'success', items: [{ title: 'A' }, { title: 'B' }] });
  const machines = [
    { id: 'mch_a', os: 'darwin', providers: ['claudeAgent'], labels: [], status: 'online' },
    { id: 'mch_b', os: 'linux', providers: ['codex'], labels: [], status: 'offline' },
  ];
  assert.deepEqual(metricsOf(run, { machines }).bottlenecks, [{
    nodeId: 'builder', reason: 'no-capacity', severity: 'critical',
    evidence: '2 waiting assignments need providers codex; 0 of 1 online machines match',
  }]);
  machines[1].status = 'online';
  assert.deepEqual(metricsOf(run, { machines }).bottlenecks, []);
  assert.deepEqual(metricsOf(run).bottlenecks, [], 'rule needs machine data');
});

test('rejects bad input', () => {
  const run = fullRun();
  assert.throws(() => computeRunMetrics(run.state, run.log, {}), code('INVALID_INPUT'));
  assert.throws(() => computeRunMetrics(run.state, run.log, { now: run.state.updatedAt, window: '3w' }), code('INVALID_INPUT'));
  assert.throws(() => computeRunMetrics(null, [], { now: run.state.updatedAt }), code('INVALID_INPUT'));
  assert.equal(computeRunMetrics(run.state, run.log, { now: run.state.updatedAt, window: 600 }).windowSec, 600);
});
