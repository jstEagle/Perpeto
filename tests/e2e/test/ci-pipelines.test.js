import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNode, ExecutorRegistry } from '@perpeto/node';
import { eventually, git, startFactory } from './support.js';

// A repository pipeline: lint, then a two-way matrix of tests sharing a dependency cache, then packaging that
// collects an artifact. Tests run only in the `test` pool (machine A); packaging only in the `package` pool (machine B).
const ciJson = {
  version: 1,
  pipelines: {
    default: {
      triggers: [{ on: 'manual' }],
      env: { GREETING: 'hello from ci.json' },
      jobs: {
        lint: { steps: [{ name: 'lint', run: 'echo "streaming-marker $GREETING"; sleep 3; echo lint-done' }] },
        test: {
          needs: ['lint'], matrix: { shard: ['1', '2'] }, runsOn: { pool: 'test' },
          cache: [{ key: "deps-{{ hashFiles('package-lock.json') }}", paths: ['deps'] }],
          steps: [{ name: 'deps', run: 'if [ -f deps/marker ]; then echo "cache-restored $(cat deps/marker)"; else mkdir -p deps && echo built-once > deps/marker && echo cache-built; fi' },
            { name: 'test', run: 'echo "shard $MATRIX_SHARD at $PERPETO_REVISION"' }],
        },
        package: {
          needs: ['test'], runsOn: { pool: 'package' },
          artifacts: [{ name: 'bundle', paths: ['out/*.txt'], maxBytes: 4096 }],
          steps: [{ name: 'pack', run: 'mkdir -p out && echo "artifact for $PERPETO_REVISION" > out/result.txt && head -c 3000 /dev/zero > out/ignored.bin' }],
        },
      },
    },
  },
};

async function addNode(t, factory, name, config) {
  const enrollment = await factory.request('POST', '/machines/enrollment-codes', {});
  const root = await mkdtemp(join(tmpdir(), 'perpeto-e2e-runner-')); await chmod(root, 0o700);
  await writeFile(join(root, 'enrollment-code'), enrollment.code, { mode: 0o600 });
  await writeFile(join(root, 'node.json'), JSON.stringify({ hubUrl: factory.url, name, dataDir: './data', enrollmentCodeFile: './enrollment-code',
    labels: ['e2e'], providers: [], fake: {}, executorPackages: [], accounts: {},
    // The host's real load must not shrink test capacity; fleet tests inject their own health.
    health: { enabled: false },
    timing: { heartbeatMs: 200, renewMs: 1000, requestMs: 5000, pollIdleMs: 20, backoffMinMs: 20, backoffMaxMs: 200 }, ...config }));
  const node = await createNode({ configPath: join(root, 'node.json'), registry: new ExecutorRegistry().register({ kind: 'none', canRun: () => false, run: async () => ({ outcome: 'failure', summary: 'unused' }) }) });
  await node.start();
  t.after(async () => { await node.stop({ drain: false }).catch(() => {}); await rm(root, { recursive: true, force: true }); });
  return node;
}

test('a repository pipeline runs as a matrix DAG across two machines with streamed logs, an artifact and a cache hit on the next run', async t => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'perpeto-e2e-cirepo-')); t.after(() => rm(repoRoot, { recursive: true, force: true }));
  const repository = join(repoRoot, 'project.git'); const seed = join(repoRoot, 'seed');
  await git(repoRoot, 'init', '--bare', '--initial-branch=main', repository); await git(repoRoot, 'clone', repository, seed);
  await mkdir(join(seed, '.perpeto'));
  await writeFile(join(seed, '.perpeto/ci.json'), JSON.stringify(ciJson, null, 2));
  await writeFile(join(seed, 'package-lock.json'), '{"lockfileVersion":3}\n');
  await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'Add CI'); await git(seed, 'push', 'origin', 'HEAD:main');
  const revision = await git(seed, 'rev-parse', 'HEAD');

  const executor = { kind: 'none', canRun: () => false, run: async () => ({ outcome: 'failure', summary: 'unused' }) };
  // Machine A: CI only, a `test` pool of two. Machine B: agents and CI, a `package` pool of one.
  const factory = await startFactory(t, { executor, separateNode: true, node: { name: 'runner-a', capacity: { maxAgents: 0, maxJobs: 2 }, runner: { pools: [{ name: 'test', maxJobs: 2 }], labels: ['fast-disk'] } } });
  await addNode(t, factory, 'runner-b', { capacity: { maxAgents: 1, maxJobs: 1 }, runner: { pools: [{ name: 'package', maxJobs: 1 }] } });
  const machines = await eventually(async () => { const { machines } = await factory.request('GET', '/machines'); return machines.length === 2 && machines.every(item => item.runner) && machines; });
  const machineA = machines.find(item => item.name === 'runner-a'); const machineB = machines.find(item => item.name === 'runner-b');

  const project = await factory.request('POST', '/projects', { name: 'CI fixture', repo: { url: repository, defaultBranch: 'main' } });
  const listed = await factory.request('GET', `/pipelines?projectId=${project.id}`);
  assert.equal(listed.source, 'repo'); assert.equal(listed.revision, revision);
  assert.deepEqual(listed.pipelines[0].jobs.map(job => job.key), ['lint', 'test (shard=1)', 'test (shard=2)', 'package']);

  const first = await factory.request('POST', '/pipeline-runs', { projectId: project.id, pipeline: 'default', idempotencyKey: 'run-1' });
  assert.equal(first.revision, revision); assert.equal(first.status, 'queued');
  assert.deepEqual(first.jobs.map(job => [job.key, job.status]), [['lint', 'queued'], ['test (shard=1)', 'waiting'], ['test (shard=2)', 'waiting'], ['package', 'waiting']]);

  // The lint step's first line reaches the hub while the step is still sleeping.
  const lintJobId = first.jobs[0].jobId;
  const streamed = await eventually(async () => {
    const text = (await factory.request('GET', `/jobs/${lintJobId}/log`)).chunks.map(chunk => chunk.chunk).join('');
    return text.includes('streaming-marker hello from ci.json') && text;
  }, { intervalMs: 50, message: 'the first log line never reached the hub' });
  assert.ok(!streamed.includes('lint-done'), 'the first line arrived while the step was still running, not with its end');

  const done = await eventually(async () => { const run = await factory.request('GET', `/pipeline-runs/${first.id}`); return ['passed', 'failed', 'error', 'cancelled'].includes(run.status) && run; },
    { message: 'first pipeline run did not finish' });
  assert.equal(done.status, 'passed', JSON.stringify(done.jobs.map(job => [job.key, job.status])));
  const byKey = Object.fromEntries(done.jobs.map(job => [job.key, job]));
  for (const key of ['test (shard=1)', 'test (shard=2)']) {
    assert.equal(byKey[key].machineId, machineA.id, 'test jobs run in the test pool');
    assert.deepEqual(byKey[key].cache.map(item => item.hit), [false]);
    assert.ok(Date.parse(byKey[key].startedAt) >= Date.parse(byKey.lint.finishedAt), 'tests wait for lint');
  }
  assert.equal(byKey.package.machineId, machineB.id, 'packaging runs in the package pool on the other machine');
  assert.ok(Date.parse(byKey.package.startedAt) >= Math.max(...['test (shard=1)', 'test (shard=2)'].map(key => Date.parse(byKey[key].finishedAt))));
  assert.ok(Number.isFinite(done.durationMs) && done.durationMs > 0);

  const testLog = (await factory.request('GET', `/jobs/${byKey['test (shard=2)'].jobId}/log`)).chunks.map(chunk => chunk.chunk).join('');
  assert.match(testLog, new RegExp(`shard 2 at ${revision}`)); assert.match(testLog, /cache-built/); assert.match(testLog, /cache miss: deps-/);

  // The artifact: one matching file within the cap (the oversized binary does not match the glob), downloadable.
  const { artifacts } = await factory.request('GET', `/jobs/${byKey.package.jobId}/artifacts`);
  assert.deepEqual(artifacts.map(item => [item.name, item.path, item.complete]), [['bundle', 'out/result.txt', true]]);
  const download = await fetch(`${factory.url}/api/v1/jobs/${byKey.package.jobId}/artifacts/${artifacts[0].id}`, { headers: { Authorization: `Bearer ${factory.owner}` } });
  assert.equal(download.status, 200); assert.equal(await download.text(), `artifact for ${revision}\n`);
  assert.deepEqual(byKey.package.artifacts.map(item => item.path), ['out/result.txt']);

  // A second run restores the cache machine A saved after the first.
  const second = await factory.request('POST', '/pipeline-runs', { projectId: project.id, pipeline: 'default', idempotencyKey: 'run-2' });
  const again = await eventually(async () => { const run = await factory.request('GET', `/pipeline-runs/${second.id}`); return ['passed', 'failed', 'error', 'cancelled'].includes(run.status) && run; },
    { message: 'second pipeline run did not finish' });
  assert.equal(again.status, 'passed');
  for (const job of again.jobs.filter(item => item.name === 'test')) {
    assert.deepEqual(job.cache.map(item => item.hit), [true], `${job.key} restores the cache`);
    const log = (await factory.request('GET', `/jobs/${job.jobId}/log`)).chunks.map(chunk => chunk.chunk).join('');
    assert.match(log, /cache-restored built-once/);
  }

  const runners = await eventually(async () => {
    const view = await factory.request('GET', '/runners');
    return view.runners.find(item => item.machineId === machineA.id)?.cache?.sizeBytes > 0 && view;
  }, { message: 'machine A never reported its cache size' });
  const a = runners.runners.find(item => item.machineId === machineA.id);
  assert.equal(a.mode, 'ci'); assert.deepEqual(a.pools.map(pool => pool.name), ['test']); assert.ok(a.labels.includes('fast-disk'));
  assert.equal(runners.runners.find(item => item.machineId === machineB.id).mode, 'both');
  assert.ok(a.utilisation > 0);
  const insights = await factory.request('GET', `/ci/insights?projectId=${project.id}`);
  assert.equal(insights.pipelines[0].runs, 2); assert.equal(insights.pipelines[0].passRate, 1); assert.ok(insights.queueWait.samples >= 8);
  const runs = await factory.request('GET', `/pipeline-runs?projectId=${project.id}`);
  assert.deepEqual(runs.runs.map(run => run.id), [second.id, first.id]);
});
