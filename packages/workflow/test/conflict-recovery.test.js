import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileGraph, validateGraph, replay, RunStore, computeRunMetrics, getTemplate } from '../src/index.js';
import { Driver, template, sha, code } from './fixtures.js';

const built = n => ({ outcome: 'success', summary: 'built', branch: 'feature', prUrl: 'local:feature', headSha: sha(n) });
const node = (graph, id) => graph.nodes.find(n => n.id === id);
function ready(graph = template('build'), driver = new Driver()) {
  driver.start({ graph });
  driver.complete('planner', { outcome: 'success' });
  driver.complete('builder', built(1));
  driver.complete('reviewer', { outcome: 'success', verdict: 'pass' });
  driver.apply('job.completed', { jobId: driver.openJob().id, status: 'passed' });
  return driver;
}
const reject = (run, kind = 'conflict') => run.apply('merge.rejected', { mergeId: run.openMerge().id, kind, reason: 'Speculative candidate rejected.' });

test('conflict-only rebase uses the same builder, fresh CI and merge without repeating review or loops', () => {
  const run = ready();
  const loops = structuredClone(run.items()[0].loopCounts);
  const original = run.openMerge();
  reject(run);
  const assignment = run.open('builder')[0];
  assert.equal(assignment.step, 'rebase');
  assert.equal(assignment.rebaseOf, original.id);
  assert.deepEqual(assignment.harness, run.state.plan.roles.builder.harness);
  assert.match(assignment.prompt, /rebase onto.*main/i);
  assert.match(assignment.prompt, /resolve conflicts.*keep behavio[u]?r/i);
  assert.match(assignment.prompt, /rebaseTouchedBeyondConflicts/);
  assert.doesNotMatch(assignment.prompt, /Implement the work item on its own branch/);
  run.complete('builder', { ...built(2), rebaseTouchedBeyondConflicts: false });
  assert.equal(run.open('reviewer').length, 0);
  assert.equal(run.openJob().revision, sha(2));
  assert.deepEqual(run.items()[0].loopCounts, loops);
  run.apply('job.completed', { jobId: run.openJob().id, status: 'passed' });
  assert.equal(run.openMerge().headSha, sha(2));
  run.apply('merge.completed', { mergeId: run.openMerge().id });
  assert.equal(run.state.status, 'completed');
  assert.deepEqual(replay(run.events), run.state);
});

for (const [label, report, policy, review] of [
  ['extra changes', true, undefined, true], ['missing report', undefined, undefined, true],
  ['always', false, 'always', true], ['never', true, 'never', false],
]) test(`rebase review policy: ${label}`, () => {
  const graph = template('build');
  if (policy) node(graph, 'merge').config.rebaseReview = policy;
  const run = ready(graph);
  reject(run);
  run.complete('builder', { ...built(2), ...(report === undefined ? {} : { rebaseTouchedBeyondConflicts: report }) });
  assert.equal(run.open('reviewer').length > 0, review);
  assert.equal(Boolean(run.openJob()), !review);
});

test('CI and untyped rejections retain the existing failure route; onConflict review opts out', () => {
  for (const kind of ['ci', undefined, 'conflict']) {
    const graph = template('build');
    if (kind === 'conflict') node(graph, 'merge').config.onConflict = 'review';
    const run = ready(graph);
    run.apply('merge.rejected', { mergeId: run.openMerge().id, ...(kind ? { kind } : {}), reason: 'Merge conflict mentioned by failing CI.' });
    assert.equal(run.open('builder')[0].step, undefined);
    assert.equal(run.items()[0].loopCounts['delivery-loop'], 2);
  }
});

test('failed rebase retries remain rebase assignments and CI failure returns to normal repair', () => {
  const run = ready();
  reject(run);
  run.complete('builder', { outcome: 'failure', summary: 'Transient failure.' });
  assert.equal(run.open('builder')[0].step, 'rebase');
  assert.equal(run.open('builder')[0].attempt, 2);
  run.complete('builder', { ...built(2), rebaseTouchedBeyondConflicts: false });
  run.apply('job.completed', { jobId: run.openJob().id, status: 'failed' });
  assert.equal(run.open('builder')[0].step, undefined);
  assert.equal(run.items()[0].loopCounts['delivery-loop'], 2);
});

test('recovery repeats every successful CI gate and never bypasses a failed CI gate', () => {
  const graph = template('build');
  const ci2 = structuredClone(node(graph, 'ci'));
  ci2.id = 'ci2';
  graph.nodes.push(ci2);
  graph.edges.find(edge => edge.id === 'ci-pass').to.node = 'ci2';
  graph.edges.push(
    { id: 'ci2-pass', kind: 'flow', from: { node: 'ci2', port: 'pass' }, to: { node: 'merge' } },
    { id: 'ci2-fail', kind: 'flow', from: { node: 'ci2', port: 'fail' }, to: { node: 'delivery-loop' } },
  );
  const run = ready(graph);
  run.apply('job.completed', { jobId: run.openJob().id, status: 'passed' });
  reject(run);
  run.complete('builder', { ...built(2), rebaseTouchedBeyondConflicts: false });
  assert.equal(run.openJob().nodeId, 'ci');
  run.apply('job.completed', { jobId: run.openJob().id, status: 'passed' });
  assert.equal(run.openJob().nodeId, 'ci2');
  assert.equal(run.openMerge(), undefined);
  run.apply('job.completed', { jobId: run.openJob().id, status: 'passed' });
  assert.equal(run.openMerge().headSha, sha(2));
});

test('docs rebase relies on speculative queue CI when no authored CI gate exists', () => {
  const run = new Driver();
  run.start({ graph: template('docs') });
  run.complete('doc-writer', built(1));
  run.complete('doc-reviewer', { outcome: 'success', verdict: 'pass' });
  reject(run);
  assert.equal(run.open('doc-writer')[0].step, 'rebase');
  run.complete('doc-writer', { ...built(2), rebaseTouchedBeyondConflicts: false });
  assert.equal(run.open('doc-reviewer').length, 0);
  assert.equal(run.openMerge().headSha, sha(2));
});

test('a rebase exhausted into triage cannot leak the rebase step into subsequent repair', () => {
  const graph = template('build');
  node(graph, 'builder').config.retry.maxAttempts = 1;
  const run = ready(graph);
  reject(run);
  run.complete('builder', { outcome: 'failure', summary: 'Cannot safely resolve.' });
  const item = run.items()[0];
  assert.equal(item.nodeId, 'triage');
  run.apply('human.decision', { workItemId: item.id, decision: 'pass' });
  assert.equal(run.open('builder')[0].step, undefined);
});

test('a rebase must report a new head; invalid reports and rejection kinds fail validation', () => {
  const run = ready();
  reject(run);
  const rebaseId = run.open('builder')[0].id;
  assert.throws(() => run.complete('builder', { ...built(2), rebaseTouchedBeyondConflicts: 'false' }), code('INVALID_EVENT'));
  run.complete('builder', { outcome: 'success', summary: 'No revision', rebaseTouchedBeyondConflicts: false });
  assert.equal(run.state.assignments[rebaseId].status, 'failed');
  assert.equal(run.openJob(), undefined);
  assert.equal(run.open('builder')[0].step, 'rebase');
  assert.equal(run.open('builder')[0].attempt, 2);
  const second = ready();
  assert.throws(() => reject(second, 'typo'), code('INVALID_EVENT'));
});

test('rebase survives pause, stale results, SQLite reopen and event replay', () => {
  const directory = mkdtempSync(join(tmpdir(), 'perpeto-rebase-'));
  let store = new RunStore(join(directory, 'run.sqlite'));
  try {
    const run = ready(undefined, new Driver((_state, event) => store.apply('run_test1', event)));
    reject(run);
    const assignmentId = run.open('builder')[0].id;
    store.close();
    store = new RunStore(join(directory, 'run.sqlite'));
    run.state = store.getState('run_test1');
    run.apply('run.paused');
    run.complete('builder', { ...built(2), rebaseTouchedBeyondConflicts: false });
    assert.equal(run.openJob(), undefined);
    run.apply('run.resumed');
    assert.equal(run.openJob().revision, sha(2));
    run.apply('assignment.completed', { assignmentId, result: built(3) });
    assert.equal(run.last.ignored, 'assignment_closed');
    assert.deepEqual(replay(run.events), run.state);
    assert.equal(store.verify('run_test1').ok, true);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('conflict counters are per node and windowed; churn evidence includes associated rebases', () => {
  const run = ready();
  for (let n = 2; n <= 3; n++) {
    reject(run);
    run.complete('builder', { ...built(n), rebaseTouchedBeyondConflicts: false });
    run.apply('job.completed', { jobId: run.openJob().id, status: 'passed' });
  }
  const metrics = computeRunMetrics(run.state, run.log, { now: run.state.updatedAt });
  assert.equal(metrics.nodes.find(n => n.nodeId === 'merge').conflictRejections, 2);
  assert.equal(metrics.nodes.find(n => n.nodeId === 'builder').rebases, 2);
  assert.equal(metrics.run.conflictRejections, 2);
  assert.equal(metrics.run.rebases, 2);
  assert.ok(metrics.edges.every(edge => !edge.unplanned), 'engine recovery is not an unplanned role interaction');
  const churn = metrics.bottlenecks.find(b => b.reason === 'conflict-churn');
  assert.equal(churn.nodeId, 'merge');
  assert.equal(churn.severity, 'warning');
  assert.match(churn.evidence, /2 conflict rejections.*2 rebase assignments.*24h/);
  const later = computeRunMetrics(run.state, [], { now: '2026-10-23T09:00:00Z' });
  assert.ok(later.nodes.every(n => n.rebases === 0 && n.conflictRejections === 0));
  assert.ok(!later.bottlenecks.some(b => b.reason === 'conflict-churn'));
});

test('concurrency controls validate, default and appear in every template', () => {
  const graph = template('build');
  delete node(graph, 'merge').config.onConflict;
  delete node(graph, 'merge').config.rebaseReview;
  delete node(graph, 'planner').config.serializeOverlappingTouches;
  const plan = compileGraph(graph);
  assert.equal(plan.nodes.merge.config.onConflict, 'rebase');
  assert.equal(plan.nodes.merge.config.rebaseReview, 'changed');
  assert.equal(plan.nodes.planner.config.serializeOverlappingTouches, true);
  for (const [id, key, value] of [['merge', 'onConflict', 'typo'], ['merge', 'rebaseReview', 'typo'], ['planner', 'serializeOverlappingTouches', 'true']]) {
    const invalid = structuredClone(graph);
    node(invalid, id).config[key] = value;
    assert.ok(validateGraph(invalid).errors.some(e => e.code === 'INVALID_CONFIG' && e.nodeId === id));
  }
  for (const id of ['build', 'improve', 'bugfix', 'docs', 'security-audit', 'dependency-upgrade']) {
    for (const n of getTemplate(id).nodes) {
      if (n.type === 'merge-queue') assert.equal(n.config.onConflict, 'rebase');
      if (n.type === 'planner') {
        assert.equal(n.config.serializeOverlappingTouches, true);
        assert.match(n.config.prompt, /touches/);
      }
    }
  }
});
