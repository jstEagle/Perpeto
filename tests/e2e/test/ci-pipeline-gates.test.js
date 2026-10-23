import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eventually, git, startFactory } from './support.js';

// A workflow whose ci node and merge-queue required check both name the repository pipeline `checks`.
const node = (id, type, config = {}) => ({ id, type, label: id, position: { x: 0, y: 0 }, config });
const graph = { schema: 'perpeto.workflow/1', nodes: [
  node('input', 'input', { source: 'manual', docs: [] }),
  node('builder', 'agent', { harness: { provider: 'fake', model: 'test' }, prompt: 'Build', concurrency: 1, policy: { maxSubagents: 0, allowedSubagentProviders: [] } }),
  node('ci', 'ci', { pipeline: 'checks' }),
  node('merge', 'merge-queue', { strategy: 'serial', method: 'squash', requiredChecks: ['checks'] }),
  node('output', 'output'),
], edges: [
  { id: 'a', kind: 'flow', from: { node: 'input' }, to: { node: 'builder' } }, { id: 'b', kind: 'flow', from: { node: 'builder' }, to: { node: 'ci' } },
  { id: 'c', kind: 'flow', from: { node: 'ci', port: 'pass' }, to: { node: 'merge' } }, { id: 'd', kind: 'flow', from: { node: 'ci', port: 'fail' }, to: { node: 'output' } },
  { id: 'e', kind: 'flow', from: { node: 'merge', port: 'pass' }, to: { node: 'output' } },
] };
const ciJson = { version: 1, pipelines: { checks: { triggers: [{ on: 'merge-queue' }, { on: 'pull-request' }], jobs: {
  unit: { steps: [{ name: 'unit', run: 'test -f feature.txt && echo unit-ok' }] },
  integration: { needs: ['unit'], matrix: { mode: ['fast', 'slow'] }, steps: [{ name: 'integration', run: 'echo "integration $MATRIX_MODE"' }] },
} } } };

test('workflow ci nodes and merge-queue required checks run repository pipelines and gate on their outcome', async t => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'perpeto-e2e-gates-')); t.after(() => rm(repoRoot, { recursive: true, force: true }));
  const repository = join(repoRoot, 'project.git'); const seed = join(repoRoot, 'seed');
  await git(repoRoot, 'init', '--bare', '--initial-branch=main', repository); await git(repoRoot, 'clone', repository, seed);
  await mkdir(join(seed, '.perpeto')); await writeFile(join(seed, '.perpeto/ci.json'), JSON.stringify(ciJson));
  await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'Initial'); await git(seed, 'push', 'origin', 'HEAD:main');

  const executor = { kind: 'fixture', canRun: () => true, async run(assignment, ctx) {
    const source = join(ctx.workspace, 'source');
    await git(ctx.workspace, 'clone', assignment.repo.url, source);
    await git(source, 'checkout', '-b', 'feature'); await writeFile(join(source, 'feature.txt'), 'gated');
    await git(source, 'add', '.'); await git(source, 'commit', '-m', 'Feature'); await git(source, 'push', 'origin', 'HEAD:feature');
    return { outcome: 'success', summary: 'Feature ready', branch: 'feature', prUrl: 'local:feature', headSha: await git(source, 'rev-parse', 'HEAD') };
  } };
  const factory = await startFactory(t, { executor, separateNode: true, node: { capacity: { maxAgents: 1, maxJobs: 3 } } });
  const project = await factory.request('POST', '/projects', { name: 'Gates', repo: { url: repository, defaultBranch: 'main' } });
  const workflow = await factory.request('POST', `/projects/${project.id}/workflows`, { name: 'Build', graph });
  await factory.request('POST', `/workflows/${workflow.id}/activate`, { version: 1 });
  const started = await factory.request('POST', `/workflows/${workflow.id}/runs`, { input: { items: [{ title: 'One feature' }] } });
  const finished = await eventually(async () => { const value = await factory.request('GET', `/runs/${started.id}`); return ['completed', 'failed'].includes(value.status) && value; },
    { timeoutMs: 90000, message: 'workflow run did not finish' });
  assert.equal(finished.status, 'completed');
  const [entry] = (await factory.request('GET', `/projects/${project.id}/merge-queue`)).entries;
  assert.equal(entry.status, 'merged');
  assert.equal(await git(repoRoot, '--git-dir', repository, 'show', 'main:feature.txt'), 'gated');

  const { runs } = await factory.request('GET', `/pipeline-runs?projectId=${project.id}`);
  const kinds = runs.map(run => run.trigger.kind).sort();
  // The feature head triggers its pull-request pipeline, the ci node its own run, and the candidate its merge-queue run.
  assert.deepEqual(kinds, ['merge-queue', 'pull-request', 'workflow']);
  for (const run of runs) {
    assert.equal(run.status, 'passed', `${run.trigger.kind}: ${JSON.stringify(run.jobs.map(job => [job.key, job.status]))}`);
    assert.deepEqual(run.jobs.map(job => job.key), ['unit', 'integration (mode=fast)', 'integration (mode=slow)']);
  }
  const proxies = (await factory.request('GET', `/jobs?projectId=${project.id}`)).jobs.filter(job => job.pipelineProxy);
  assert.equal(proxies.length, 2, 'the ci node job and the speculative merge job are pipeline proxies');
  assert.ok(proxies.every(job => job.status === 'passed' && !job.machineId), 'proxies are never leased');
  const mergeRun = runs.find(run => run.trigger.kind === 'merge-queue');
  assert.notEqual(mergeRun.revision, runs.find(run => run.trigger.kind === 'workflow').revision, 'the merge pipeline tested the candidate, not the branch head');
  const unitLog = (await factory.request('GET', `/jobs/${mergeRun.jobs[0].jobId}/log`)).chunks.map(chunk => chunk.chunk).join('');
  assert.match(unitLog, /unit-ok/);
});

test('a failing pipeline fails the workflow ci gate, and its jobs skip their dependents', async t => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'perpeto-e2e-gates-')); t.after(() => rm(repoRoot, { recursive: true, force: true }));
  const repository = join(repoRoot, 'project.git'); const seed = join(repoRoot, 'seed');
  await git(repoRoot, 'init', '--bare', '--initial-branch=main', repository); await git(repoRoot, 'clone', repository, seed);
  await mkdir(join(seed, '.perpeto'));
  await writeFile(join(seed, '.perpeto/ci.json'), JSON.stringify({ version: 1, pipelines: { checks: { jobs: {
    unit: { steps: [{ name: 'unit', run: 'echo failing; exit 3' }] }, integration: { needs: ['unit'], steps: [{ name: 'never', run: 'true' }] } } } } }));
  await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'Initial'); await git(seed, 'push', 'origin', 'HEAD:main');
  const executor = { kind: 'fixture', canRun: () => true, async run(assignment, ctx) {
    const source = join(ctx.workspace, 'source');
    await git(ctx.workspace, 'clone', assignment.repo.url, source);
    await git(source, 'checkout', '-b', 'feature'); await writeFile(join(source, 'feature.txt'), 'x');
    await git(source, 'add', '.'); await git(source, 'commit', '-m', 'Feature'); await git(source, 'push', '--force', 'origin', 'HEAD:feature');
    return { outcome: 'success', summary: 'Feature ready', branch: 'feature', prUrl: 'local:feature', headSha: await git(source, 'rev-parse', 'HEAD') };
  } };
  const factory = await startFactory(t, { executor, separateNode: true });
  const project = await factory.request('POST', '/projects', { name: 'Gates', repo: { url: repository, defaultBranch: 'main' } });
  const failing = structuredClone(graph);
  failing.nodes.find(item => item.id === 'ci').config = { pipeline: 'checks', retry: { maxAttempts: 1 } };
  const workflow = await factory.request('POST', `/projects/${project.id}/workflows`, { name: 'Build', graph: failing });
  await factory.request('POST', `/workflows/${workflow.id}/activate`, { version: 1 });
  const started = await factory.request('POST', `/workflows/${workflow.id}/runs`, { input: { items: [{ title: 'One feature' }] } });
  const run = await eventually(async () => {
    const { runs } = await factory.request('GET', `/pipeline-runs?projectId=${project.id}`);
    return runs.find(item => item.trigger.kind === 'workflow' && item.status === 'failed');
  }, { timeoutMs: 60000, message: 'pipeline run did not fail' });
  assert.deepEqual(run.jobs.map(job => [job.key, job.status]), [['unit', 'failed'], ['integration', 'skipped']]);
  await eventually(async () => {
    const jobs = (await factory.request('GET', `/jobs?runId=${started.id}`)).jobs;
    return jobs.some(job => job.pipelineProxy && job.status === 'failed');
  }, { message: 'the ci gate proxy did not fail' });
  const events = await factory.events();
  assert.ok(events.some(event => event.type === 'gate.result' && event.data.source === 'ci' && event.data.result === 'failed'), 'the gate failure is observable');
  assert.equal((await factory.request('GET', `/projects/${project.id}/merge-queue`)).entries.length, 0, 'nothing reached the merge queue');
});
