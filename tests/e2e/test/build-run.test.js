import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountProvider } from '@perpeto/node';
import { bareRepository, buildTemplate, createFactoryExecutor, eventually, git, startFactory } from './support.js';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('build template runs from input to merged output on a real hub, node and bare Git repository', async t => {
  const started = Date.now();
  const repoRoot = await mkdtemp(join(tmpdir(), 'perpeto-e2e-repo-'));
  t.after(() => import('node:fs/promises').then(fs => fs.rm(repoRoot, { recursive: true, force: true })));
  const repository = await bareRepository(repoRoot);
  const initialMain = await git(repository, 'rev-parse', 'main');
  const executor = createFactoryExecutor({ crashOnce: ['Farewell'] });
  const factory = await startFactory(t, { executor });
  const { request } = factory;

  // A synthetic subscription account in the node's pool must reach the hub through heartbeats.
  const machineId = factory.node.status.machineId;
  const operator = createAccountProvider({ config: {}, dataDir: factory.nodeDataDir }); operator.bind({ machineId });
  const source = await mkdtemp(join(tmpdir(), 'perpeto-e2e-account-')); await chmod(source, 0o700);
  t.after(() => import('node:fs/promises').then(fs => fs.rm(source, { recursive: true, force: true })));
  await writeFile(join(source, 'auth.json'), JSON.stringify({ tokens: { access_token: 'fixture-e2e-secret', refresh_token: 'fixture-refresh' } }), { mode: 0o600 });
  const account = operator.pool.importAccount({ provider: 'codex', label: 'E2E fixture', source: { kind: 'provider-home', homePath: source }, idempotencyKey: 'e2e-account' });

  const project = await request('POST', '/projects', { name: 'Fixture', repo: { url: repository, localPath: repository, defaultBranch: 'main' }, goals: ['Greet people'] });
  const graph = await buildTemplate(value => {
    const ci = value.nodes.find(node => node.id === 'ci');
    // Prints the checked-out commit, then requires every feature file to carry the reviewer's requested marker.
    ci.config.steps = [{ name: 'revision', run: 'git rev-parse HEAD', timeoutSec: 60 },
      { name: 'test', run: 'test -f README.md && for f in features/*.txt; do grep -q "reviewed: yes" "$f" || exit 1; done', timeoutSec: 60 }];
    // The run's review loop is expected to pass first time; one rejection per item is then measurable rework.
    value.nodes.find(node => node.id === 'review-loop').config.expectedIterations = 1;
    // Short backoff so the retry path runs within the test while still exercising notBefore.
    value.nodes.find(node => node.id === 'builder').config.retry = { maxAttempts: 3, backoffSec: 1 };
    return value;
  });
  const workflow = await request('POST', `/projects/${project.id}/workflows`, { name: 'Build', purpose: 'build', graph });
  await request('POST', `/workflows/${workflow.id}/activate`, { version: workflow.version });
  const run = await request('POST', `/workflows/${workflow.id}/runs`, { input: { items: [{ title: 'Greeting and farewell', body: 'Greet and say goodbye.' }] } });

  const finished = await eventually(async () => {
    const value = await request('GET', `/runs/${run.id}`);
    return ['completed', 'failed', 'stopped'].includes(value.status) && value;
  }, { message: 'Run did not finish.' });
  assert.equal(finished.status, 'completed');

  // Work items: the planner's parent plus two children, all done, each ending on a reviewed head.
  const { workItems } = await request('GET', `/runs/${run.id}/work-items`);
  const parent = workItems.find(item => !item.parentId); const children = workItems.filter(item => item.parentId);
  assert.equal(parent.status, 'done'); assert.equal(children.length, 2);
  assert.deepEqual(children.map(item => item.title).sort(), ['Farewell', 'Greeting']);
  for (const item of children) { assert.equal(item.status, 'done'); assert.equal(item.nodeId, 'shipped'); assert.match(item.headSha, /^[0-9a-f]{40}$/); assert.equal(item.loopCounts['review-loop'], 2); }

  // Assignments: one planner, two builds and two reviews per item, plus one retried build. Reviews decided on verdict.
  const { assignments } = await request('GET', `/runs/${run.id}/assignments`);
  const byNode = node => assignments.filter(value => value.nodeId === node);
  assert.equal(byNode('planner').length, 1); assert.equal(byNode('builder').length, 5); assert.equal(byNode('reviewer').length, 4);
  assert.ok(assignments.every(value => value.machineId === machineId));
  assert.ok(assignments.every(value => JSON.stringify(value.repo) === JSON.stringify(project.repo)));
  assert.ok(executor.calls.every(value => JSON.stringify(value.repo) === JSON.stringify(project.repo)));
  const crashed = assignments.filter(value => value.status === 'failed');
  assert.equal(crashed.length, 1); assert.equal(crashed[0].nodeId, 'builder'); assert.equal(crashed[0].result.outcome, 'failure');
  assert.ok(assignments.filter(value => value !== crashed[0]).every(value => value.status === 'succeeded'));
  const retry = assignments.find(value => value.retryOf === crashed[0].id);
  assert.equal(retry.attempt, 2); assert.equal(retry.status, 'succeeded'); assert.match(retry.prompt, /This is retry 2 of 3/);
  assert.deepEqual(byNode('reviewer').map(value => value.result.verdict).sort(), ['fail', 'fail', 'pass', 'pass']);
  assert.equal(executor.calls.filter(call => call.nodeType === 'agent' && call.prompt.includes('Feedback to address (review from reviewer)')).length, 2);

  // CI: the node ran each item's job at its exact head SHA, and the log shows the checked-out commit.
  const { jobs } = await request('GET', `/jobs?runId=${run.id}`);
  const ciJobs = jobs.filter(job => !job.delivery); const speculative = jobs.filter(job => job.delivery);
  assert.equal(ciJobs.length, 2);
  for (const item of children) {
    const job = ciJobs.find(value => value.workItemId === item.id);
    assert.equal(job.status, 'passed'); assert.equal(job.revision, item.headSha); assert.equal(job.machineId, machineId);
    const log = await request('GET', `/jobs/${job.id}/log`);
    assert.ok(log.chunks.some(chunk => chunk.chunk.includes(job.revision)));
  }

  // Merge queue: each entry merged after a speculative job passed on the exact candidate it then published.
  const { entries } = await request('GET', `/projects/${project.id}/merge-queue`);
  assert.equal(entries.length, 2);
  assert.ok(entries.every(entry => entry.status === 'merged' && /^[0-9a-f]{40}$/.test(entry.mergedRevision)));
  assert.equal(speculative.length, 2);
  for (const entry of entries) {
    const job = speculative.find(value => value.id === entry.jobId);
    assert.equal(job.status, 'passed'); assert.equal(job.revision, entry.mergedRevision); assert.deepEqual(job.delivery.mergeEntryIds, [entry.id]);
  }

  // Final Git state: main advanced from the initial commit to the last tested candidate and holds both reviewed files.
  const main = await git(repository, 'rev-parse', 'main');
  assert.notEqual(main, initialMain);
  assert.ok(entries.some(entry => entry.mergedRevision === main));
  assert.equal(await git(repository, 'merge-base', '--is-ancestor', initialMain, main).then(() => true), true);
  for (const name of ['greeting', 'farewell']) assert.match(await git(repository, 'show', `main:features/${name}.txt`), /reviewed: yes/);
  assert.equal((await git(repository, 'log', '--format=%s', 'main')).split('\n').filter(subject => subject.startsWith('Perpeto merge')).length, 2);

  // Events: lifecycle with machine placement, planned flow edges, review/CI/merge gates and run completion.
  const events = (await factory.events()).filter(event => event.runId === run.id);
  const types = new Set(events.map(event => event.type));
  for (const type of ['assignment.state', 'workitem.moved', 'gate.result', 'merge-entry.updated', 'loop.iteration', 'workitem.retried', 'run.updated']) assert.ok(types.has(type), type);
  // The hub did not lease the retry before the engine's backoff elapsed.
  const retried = events.find(event => event.type === 'workitem.retried');
  assert.equal(retried.data.assignmentId, crashed[0].id); assert.equal(retried.data.notBefore, retry.notBefore);
  const retryLeased = events.find(event => event.type === 'assignment.state' && event.subject.id === retry.id && event.data.state === 'leased');
  assert.ok(Date.parse(retryLeased.at) >= Date.parse(retry.notBefore), `retry leased at ${retryLeased.at}, before ${retry.notBefore}`);
  assert.ok(events.some(event => event.type === 'assignment.state' && event.data.state === 'leased' && event.data.machineId === machineId));
  const moves = events.filter(event => event.type === 'workitem.moved');
  assert.ok(moves.every(event => event.data.unplanned === false && event.data.edgeId));
  assert.equal(moves.filter(event => event.data.edgeId === 'reviewer-fail').length, 2);
  const gates = events.filter(event => event.type === 'gate.result');
  assert.deepEqual(gates.filter(event => event.data.source === 'review').map(event => event.data.result).sort(), ['fail', 'fail', 'pass', 'pass']);
  assert.equal(gates.filter(event => event.data.source === 'ci' && event.data.result === 'passed').length, 2);
  assert.equal(gates.filter(event => event.data.gate === 'merge-queue' && event.data.result === 'pass').length, 2);
  assert.ok(events.some(event => event.type === 'run.updated' && event.data.status === 'completed'));

  // Metrics: measured node numbers plus bottlenecks that carry their evidence.
  const metrics = await request('GET', `/runs/${run.id}/metrics?window=1h`);
  const reviewer = metrics.nodes.find(node => node.nodeId === 'reviewer');
  assert.equal(reviewer.done, 2); assert.equal(reviewer.failed, 2); assert.equal(reviewer.failureRate, 0.5);
  assert.equal(metrics.edges.find(edge => edge.edgeId === 'reviewer-fail').count, 2);
  const builder = metrics.nodes.find(node => node.nodeId === 'builder');
  assert.equal(builder.errors, 1); assert.equal(builder.retries, 1); assert.equal(builder.done, 4);
  const rework = metrics.bottlenecks.find(value => value.reason === 'rework-loop');
  assert.equal(rework.nodeId, 'review-loop'); assert.match(rework.evidence, /average 2 iterations over 2 items \(expected 1, limit 3\)/);
  assert.ok(metrics.bottlenecks.some(value => value.reason === 'high-failure' && value.nodeId === 'reviewer' && /2 of 4 finished visits failed/.test(value.evidence)));
  assert.equal(metrics.run.wip, 0); assert.ok(metrics.run.velocity.itemsDonePerDay > 0);
  const projectMetrics = await request('GET', `/projects/${project.id}/metrics?window=1h`);
  assert.deepEqual(projectMetrics.runs, [run.id]);
  assert.ok(projectMetrics.bottlenecks.some(value => value.reason === 'rework-loop' && value.runId === run.id));

  // Usage: one record per assignment, attributed to the run and machine.
  const usage = await request('GET', `/usage?runId=${run.id}&groupBy=model`);
  assert.equal(usage.totals.records, assignments.length);
  assert.equal(usage.totals.inputTokens, 120 * assignments.length); assert.equal(usage.totals.outputTokens, 30 * assignments.length);
  assert.deepEqual(usage.groups.map(group => group.key).sort(), ['fake-builder', 'fake-planner', 'fake-reviewer']);
  assert.ok((await request('GET', `/usage?machineId=${machineId}`)).totals.records >= assignments.length);

  // Accounts: the pool snapshot arrived through heartbeats without credential material.
  const { accounts } = await eventually(async () => { const value = await request('GET', '/accounts'); return value.accounts.some(item => item.id === account.id) && value; });
  assert.deepEqual(accounts.find(item => item.id === account.id), { id: account.id, machineId, provider: 'codex', label: 'E2E fixture', status: 'active' });
  assert.ok(!JSON.stringify(accounts).includes('fixture-e2e-secret'));

  t.diagnostic(`run completed in ${Date.now() - started} ms`);
});
