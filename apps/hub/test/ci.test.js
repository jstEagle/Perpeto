import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../src/index.js';
import { createStubEngine } from '../src/engine/stub-engine.js';

const SHA_A = 'a'.repeat(40); const SHA_B = 'b'.repeat(40);
const config = (jobs, extra = {}) => ({ version: 1, pipelines: { default: { jobs }, ...extra } });

async function fixture(t, hubConfig = {}, { clock } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'perpeto-hub-ci-'));
  const configPath = join(directory, 'hub.json');
  await writeFile(configPath, JSON.stringify({ port: 0, databasePath: './hub.sqlite', messagingDatabasePath: './messaging.sqlite', ownerTokenPath: './owner.secret',
    longPollMs: 0, maintenanceIntervalMs: 60000, ...hubConfig }));
  const hub = await createHub({ configPath, engine: createStubEngine(), clock }); const baseUrl = await hub.listen();
  const owner = (await readFile(join(directory, 'owner.secret'), 'utf8')).trim();
  t.after(async () => { await hub.close(); await rm(directory, { recursive: true, force: true }); });
  let keys = 0;
  const f = {
    directory, hub, baseUrl, owner,
    async request(method, path, body, token = owner) {
      const payload = body && ['POST', 'PUT', 'PATCH'].includes(method) && body.idempotencyKey === undefined ? { ...body, idempotencyKey: `k${keys++}` } : body;
      const response = await fetch(`${baseUrl}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
      const type = response.headers.get('content-type') ?? '';
      return { status: response.status, body: type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
    },
    async ok(method, path, body, token) { const result = await f.request(method, path, body, token); assert.ok(result.status < 300, `${method} ${path}: ${result.status} ${JSON.stringify(result.body)}`); return result.body; },
    async project(name, ciConfig, repo = { url: `https://example.invalid/${name}.git`, defaultBranch: 'main' }) {
      const project = await f.ok('POST', '/projects', { name, repo });
      if (ciConfig) await f.ok('PUT', `/projects/${project.id}/ci-config`, { config: ciConfig });
      return project;
    },
    async machine(name, { runner, labels = [], capacity = { maxAgents: 0, maxJobs: 4 }, os = 'linux' } = {}) {
      const { code } = await f.ok('POST', '/machines/enrollment-codes', {});
      const { machineId, token } = await f.ok('POST', '/nodes/enroll', { code, name, os, arch: 'arm64', labels, providers: [], version: 'test' }, null);
      const node = {
        id: machineId, token,
        heartbeat: (extra = {}) => f.ok('POST', '/nodes/heartbeat', { status: 'online', capacity, running: { agents: 0, jobs: 0 }, ...(runner ? { runner } : {}), ...extra }, token),
        async lease(max = 10) { return (await f.ok('POST', '/nodes/lease', { kinds: ['job'], max }, token)).jobs; },
        event: (job, type, data = {}) => f.request('POST', `/jobs/${job.id}/events`, { type, attempt: job.attempt, data }, token),
        async finish(job, status = 'passed', extra = {}) {
          assert.equal((await node.event(job, 'started', { revision: job.revision, configHash: job.configHash })).status, 200);
          const result = await node.event(job, 'completed', { status, revision: job.revision, configHash: job.configHash, steps: [], artifacts: [], ...extra });
          assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
        },
      };
      await node.heartbeat();
      return node;
    },
    run: id => f.ok('GET', `/pipeline-runs/${id}`),
  };
  return f;
}

test('pipeline DAG: jobs queue when their needs pass, a failure skips dependents, the retry policy reruns, and a pass after a failure is flaky', async t => {
  const f = await fixture(t);
  const project = await f.project('dag', config({
    build: { steps: [{ name: 'build', run: 'make' }] },
    test: { needs: ['build'], matrix: { shard: ['1', '2'] }, retry: { maxAttempts: 2 }, steps: [{ name: 'test', run: 'make test' }], env: { MODE: 'ci' } },
    deploy: { needs: ['test'], steps: [{ name: 'deploy', run: 'echo deploy' }] },
    docs: { steps: [{ name: 'docs', run: 'echo docs' }] },
  }));
  const node = await f.machine('runner');
  const run = await f.ok('POST', '/pipeline-runs', { projectId: project.id, pipeline: 'default', revision: SHA_A });
  assert.equal(run.configSource, 'project');
  assert.deepEqual(run.jobs.map(job => [job.key, job.status]), [['build', 'queued'], ['test (shard=1)', 'waiting'], ['test (shard=2)', 'waiting'], ['deploy', 'waiting'], ['docs', 'queued']]);

  let leased = await node.lease();
  assert.deepEqual(leased.map(job => job.pipelineJob).sort(), ['build', 'docs']);
  assert.ok(leased.every(job => job.revision === SHA_A && job.repo.url && !job.source), 'a remote project is cloned by the runner');
  assert.equal((await f.run(run.id)).jobs.find(job => job.key === 'build').status, 'leased');
  for (const job of leased) await node.finish(job);
  leased = await node.lease();
  assert.deepEqual(leased.map(job => job.pipelineJob).sort(), ['test (shard=1)', 'test (shard=2)']);
  assert.deepEqual(leased[0].env, { MODE: 'ci', MATRIX_SHARD: leased[0].pipelineJob.includes('1') ? '1' : '2' });
  const shard1 = leased.find(job => job.pipelineJob === 'test (shard=1)'); const shard2 = leased.find(job => job.pipelineJob === 'test (shard=2)');
  await node.finish(shard1, 'passed', { cache: [{ key: 'deps-1', hit: true }] });
  await node.finish(shard2, 'failed');
  // The retry policy queues a second attempt as a new job; deploy keeps waiting.
  let current = await f.run(run.id);
  const retried = current.jobs.find(job => job.key === 'test (shard=2)');
  assert.equal(retried.status, 'queued'); assert.equal(retried.attempt, 2); assert.equal(retried.attempts[0].status, 'failed');
  assert.notEqual(retried.jobId, shard2.id);
  assert.equal(current.jobs.find(job => job.key === 'deploy').status, 'waiting');
  assert.deepEqual(current.jobs.find(job => job.key === 'test (shard=1)').cache, [{ key: 'deps-1', hit: true }]);
  const [second] = await node.lease();
  assert.equal(second.id, retried.jobId);
  await node.finish(second, 'passed');
  current = await f.run(run.id);
  assert.equal(current.jobs.find(job => job.key === 'test (shard=2)').flaky, true);
  const [deploy] = await node.lease();
  assert.equal(deploy.pipelineJob, 'deploy');
  await node.finish(deploy, 'failed');
  current = await f.run(run.id);
  assert.equal(current.status, 'failed'); assert.ok(current.durationMs >= 0); assert.ok(current.finishedAt);
  const { flaky } = await f.ok('GET', `/ci/flaky?projectId=${project.id}`);
  assert.deepEqual(flaky.map(item => [item.pipeline, item.job, item.occurrences, item.lastRevision]), [['default', 'test (shard=2)', 1, SHA_A]]);

  // Manual retry reruns the failed job only; passed jobs keep their evidence.
  const retry = await f.ok('POST', `/pipeline-runs/${run.id}/retry`, { job: 'deploy' });
  assert.equal(retry.status, 'running');
  assert.equal(retry.jobs.find(job => job.key === 'deploy').status, 'queued');
  assert.equal(retry.jobs.find(job => job.key === 'build').status, 'passed');
  const [again] = await node.lease();
  await node.finish(again, 'passed');
  current = await f.run(run.id);
  assert.equal(current.status, 'passed'); assert.equal(current.retries, 1);
  assert.equal((await f.request('POST', `/pipeline-runs/${run.id}/retry`, {})).status, 400, 'nothing left to retry');

  // A failed job with no retries left skips everything downstream.
  const failing = await f.ok('POST', '/pipeline-runs', { projectId: project.id, pipeline: 'default', revision: SHA_B });
  for (const job of await node.lease()) await node.finish(job, job.pipelineJob === 'build' ? 'failed' : 'passed');
  current = await f.run(failing.id);
  assert.equal(current.status, 'failed');
  assert.deepEqual(current.jobs.map(job => job.status), ['failed', 'skipped', 'skipped', 'skipped', 'passed']);
  const insights = await f.ok('GET', `/ci/insights?projectId=${project.id}&window=24h`);
  assert.equal(insights.pipelines[0].runs, 2); assert.equal(insights.pipelines[0].passRate, 0.5);
  assert.equal(insights.pipelines[0].jobs.find(job => job.name === 'test').flaky, 1);
});

test('runner pools, runner labels and fair share decide which machine leases which job', async t => {
  const f = await fixture(t);
  const jobs = { gpu: { runsOn: { pool: 'gpu', labels: ['cuda'] }, steps: [{ name: 'train', run: 'x' }] }, mac: { runsOn: { os: 'darwin' }, steps: [{ name: 'x', run: 'x' }] },
    any: { steps: [{ name: 'x', run: 'x' }] } };
  const alpha = await f.project('alpha', config(jobs)); const beta = await f.project('beta', config({ one: { steps: [{ name: 'x', run: 'x' }] } }));
  const linux = await f.machine('linux', { runner: { pools: [{ name: 'default', maxJobs: 1 }], labels: [] } });
  const gpu = await f.machine('gpu', { runner: { pools: [{ name: 'gpu', maxJobs: 1 }, { name: 'default', maxJobs: 0 }], labels: ['cuda'] } });
  const agentsOnly = await f.machine('agents', { capacity: { maxAgents: 2, maxJobs: 0 } });
  await f.ok('POST', '/pipeline-runs', { projectId: alpha.id, pipeline: 'default', revision: SHA_A });
  await f.ok('POST', '/pipeline-runs', { projectId: alpha.id, pipeline: 'default', revision: SHA_B, ref: 'other' });
  await f.ok('POST', '/pipeline-runs', { projectId: beta.id, pipeline: 'default', revision: SHA_A });
  assert.deepEqual(await agentsOnly.lease(), [], 'an agents-only machine runs no CI');
  const gpuJobs = await gpu.lease();
  assert.deepEqual(gpuJobs.map(job => job.pipelineJob), ['gpu'], 'the gpu pool takes only gpu jobs, one at a time');
  assert.equal(gpuJobs[0].pool, 'gpu');
  // Alpha already has a job running, so beta's first job goes before alpha's older queued jobs.
  const first = await linux.lease();
  assert.deepEqual(first.map(job => [job.projectId, job.pipelineJob]), [[beta.id, 'one']], 'one default slot, fair share picks the idle project');
  assert.deepEqual(await linux.lease(), [], 'the pool is full');
  await linux.finish(first[0]);
  const next = await linux.lease();
  assert.deepEqual(next.map(job => job.pipelineJob), ['any'], 'darwin jobs never reach a linux machine');
  const view = await f.ok('GET', '/runners');
  const byName = Object.fromEntries(view.runners.map(runner => [runner.name, runner]));
  assert.equal(byName.gpu.mode, 'ci'); assert.equal(byName.agents.mode, 'agents');
  assert.deepEqual(byName.gpu.pools, [{ name: 'gpu', maxJobs: 1, busy: 1 }, { name: 'default', maxJobs: 0, busy: 0 }]);
  assert.ok(byName.gpu.labels.includes('cuda'));
  const gpuPool = view.pools.find(pool => pool.name === 'gpu');
  assert.equal(gpuPool.busy, 1); assert.equal(gpuPool.queued, 1, 'the second run waits for the gpu pool');
  assert.equal((await f.request('POST', '/nodes/heartbeat', { status: 'online', capacity: { maxAgents: 0, maxJobs: 1 }, running: { agents: 0, jobs: 0 }, runner: { pools: [{ name: 'bad name', maxJobs: 1 }] } }, linux.token)).status, 400);
});

test('cancel and supersede stop active jobs; heartbeats carry the cancellation to the machine', async t => {
  const f = await fixture(t);
  const project = await f.project('cancel', config({ a: { steps: [{ name: 'a', run: 'x' }] }, b: { needs: ['a'], steps: [{ name: 'b', run: 'x' }] } }));
  const node = await f.machine('runner');
  const first = await f.ok('POST', '/pipeline-runs', { projectId: project.id, pipeline: 'default', revision: SHA_A, ref: 'refs/heads/feature' });
  const [job] = await node.lease();
  await node.event(job, 'started', { revision: job.revision, configHash: job.configHash });
  const second = await f.ok('POST', '/pipeline-runs', { projectId: project.id, pipeline: 'default', revision: SHA_B, ref: 'refs/heads/feature' });
  const old = await f.run(first.id);
  assert.equal(old.status, 'cancelled'); assert.equal(old.supersededBy, second.id);
  assert.deepEqual(old.jobs.map(item => item.status), ['cancelled', 'cancelled']);
  const beat = await node.heartbeat();
  assert.deepEqual(beat.cancel.jobs, [job.id]);
  assert.equal((await node.event(job, 'completed', { status: 'cancelled', revision: job.revision, configHash: job.configHash })).status, 200);
  const cancelled = await f.ok('POST', `/pipeline-runs/${second.id}/cancel`, { reason: 'Not needed.' });
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.reason, 'Not needed.');
  assert.deepEqual(await node.lease(), []);
  const events = (await f.ok('GET', '/events?types=pipeline-run.superseded,pipeline-run.cancelled,pipeline-run.finished')).events.map(event => event.type);
  assert.ok(events.includes('pipeline-run.superseded') && events.includes('pipeline-run.cancelled'));
});

test('CI logs are bounded per job, redacted on the hub and paged by cursor', async t => {
  const f = await fixture(t, { ci: { logMaxBytesPerJob: 2048, redactPatterns: ['corp-[0-9]{6}'] } });
  const project = await f.project('logs', config({ a: { steps: [{ name: 'a', run: 'x' }] } }));
  const node = await f.machine('runner');
  await f.ok('POST', '/pipeline-runs', { projectId: project.id, pipeline: 'default', revision: SHA_A });
  const [job] = await node.lease();
  await node.event(job, 'log', { chunk: `token ghp_${'x'.repeat(30)} and corp-123456 and owner ${f.owner}\n` });
  for (let index = 0; index < 5; index++) assert.equal((await node.event(job, 'log', { chunk: `${String(index).repeat(600)}\n` })).status, 200);
  const all = await f.ok('GET', `/jobs/${job.id}/log`);
  const text = all.chunks.map(chunk => chunk.chunk).join('');
  assert.ok(!text.includes('ghp_') && !text.includes('corp-123456') && !text.includes(f.owner), 'secrets are masked');
  assert.match(text, /\[REDACTED\]/);
  assert.equal(all.truncated, true); assert.ok(all.bytes <= 2048);
  assert.match(text, /log truncated at 2048 bytes/);
  const page = await f.ok('GET', `/jobs/${job.id}/log?after=0&limit=2`);
  assert.equal(page.chunks.length, 2); assert.equal(page.hasMore, true);
  const rest = await f.ok('GET', `/jobs/${job.id}/log?after=${page.nextCursor}&limit=100`);
  assert.equal(rest.hasMore, false);
  assert.deepEqual([...page.chunks, ...rest.chunks].map(chunk => chunk.seq), all.chunks.map(chunk => chunk.seq));
});

test('artifacts upload in chunks under the lease, are capped per job, verified by digest and downloadable', async t => {
  const f = await fixture(t, { ci: { artifactMaxBytesPerJob: 4096 } });
  const project = await f.project('artifacts', config({ a: { steps: [{ name: 'a', run: 'x' }], artifacts: [{ name: 'out', paths: ['out/**'] }] } }));
  const node = await f.machine('runner');
  const run = await f.ok('POST', '/pipeline-runs', { projectId: project.id, pipeline: 'default', revision: SHA_A });
  const [job] = await node.lease();
  assert.deepEqual(job.collect, [{ name: 'out', paths: ['out/**'], maxBytes: 50 * 1024 ** 2, when: 'always' }]);
  const content = Buffer.from('hello artifact '.repeat(100));
  const sha256 = createHash('sha256').update(content).digest('hex');
  const chunk = (offset, end, extra = {}) => node.event(job, 'artifact', { name: 'out', path: 'out/report.txt', size: content.length, sha256, offset, data: content.subarray(offset, end).toString('base64'), ...extra });
  assert.equal((await chunk(0, 1000)).status, 200);
  assert.equal((await chunk(0, 1000)).status, 200, 'a repeated chunk is a harmless retry');
  assert.equal((await chunk(1200, 1300)).body.error.code, 'ARTIFACT_GAP');
  const last = await chunk(1000, content.length);
  assert.equal(last.body.artifact.complete, true);
  const bad = Buffer.from('corrupt');
  assert.equal((await node.event(job, 'artifact', { name: 'out', path: 'out/bad.txt', size: bad.length, sha256: 'f'.repeat(64), offset: 0, data: bad.toString('base64') })).body.error.code, 'ARTIFACT_CORRUPT');
  assert.equal((await node.event(job, 'artifact', { name: 'out', path: 'out/huge.bin', size: 5000, sha256, offset: 0, data: '' })).status, 413);
  assert.equal((await node.event(job, 'artifact', { name: 'out', path: '../escape', size: 1, sha256, offset: 0, data: 'eA==' })).status, 400);
  await node.finish(job, 'passed', { artifacts: [{ name: 'forged', path: '/etc/passwd' }] });
  const { artifacts } = await f.ok('GET', `/jobs/${job.id}/artifacts`);
  assert.deepEqual(artifacts.map(item => [item.path, item.size, item.complete]), [['out/report.txt', content.length, true]]);
  const hubJob = await f.ok('GET', `/jobs/${job.id}`);
  assert.deepEqual(hubJob.artifacts.map(item => item.path), ['out/report.txt'], 'the hub lists what it stored, not what the node claimed');
  assert.deepEqual((await f.run(run.id)).jobs[0].artifacts.map(item => item.id), [artifacts[0].id]);
  const download = await f.request('GET', `/jobs/${job.id}/artifacts/${artifacts[0].id}`);
  assert.equal(download.status, 200); assert.deepEqual(download.body, content);
  assert.equal((await f.request('GET', `/jobs/${job.id}/artifacts/art_missing`)).status, 404);
  assert.equal((await f.request('GET', `/jobs/${job.id}/artifacts`, undefined, node.token)).status, 403, 'machines cannot list artifacts');
  // Retention removes the files and records.
  const counts = f.hub.hub.pipelines.sweep(Date.now() + 8 * 86400000);
  assert.equal(counts.artifacts, 1);
  assert.deepEqual(await readdir(join(f.directory, 'ci-artifacts', job.id)), []);
});

test('configuration: validation reports paths, invalid repository files are not silently replaced, and pipelines list their jobs', async t => {
  const f = await fixture(t);
  const invalid = await f.ok('POST', '/ci/validate', { config: { version: 1, pipelines: { p: { jobs: { a: { steps: [] } } } } } });
  assert.equal(invalid.valid, false); assert.equal(invalid.errors[0].path, '$.pipelines.p.jobs.a.steps');
  assert.deepEqual((await f.ok('POST', '/ci/validate', { config: JSON.stringify(config({ a: { steps: [{ name: 'a', run: 'x' }] } })) })).pipelines, ['default']);
  const project = await f.project('cfg');
  const rejected = await f.request('PUT', `/projects/${project.id}/ci-config`, { config: { version: 2 } });
  assert.equal(rejected.status, 400); assert.equal(rejected.body.error.code, 'PIPELINE_CONFIG_INVALID');
  assert.equal((await f.ok('GET', `/pipelines?projectId=${project.id}`)).source, 'none');
  assert.equal((await f.request('POST', '/pipeline-runs', { projectId: project.id, pipeline: 'default', revision: SHA_A })).body.error.code, 'PIPELINE_NOT_FOUND');
  assert.equal((await f.request('POST', '/pipeline-runs', { projectId: project.id, pipeline: 'default' })).body.error.code, 'REVISION_REQUIRED');

  // A local repository: the file at the revision wins over the project fallback, and an invalid file is an error.
  const repoRoot = join(f.directory, 'repo'); await mkdir(repoRoot);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repoRoot, encoding: 'utf8' }).trim();
  git('init', '--quiet', '--initial-branch=main');
  await mkdir(join(repoRoot, '.perpeto'));
  await writeFile(join(repoRoot, '.perpeto/ci.json'), JSON.stringify(config({ repo: { steps: [{ name: 'r', run: 'x' }] } })));
  git('add', '.'); git('commit', '--quiet', '-m', 'ci'); const good = git('rev-parse', 'HEAD');
  await writeFile(join(repoRoot, '.perpeto/ci.json'), '{"version": 1, "pipelines": {}}');
  git('commit', '--quiet', '-am', 'broken'); const broken = git('rev-parse', 'HEAD');
  const local = await f.project('local', config({ fallback: { steps: [{ name: 'f', run: 'x' }] } }), { url: repoRoot, defaultBranch: 'main' });
  const atGood = await f.ok('GET', `/pipelines?projectId=${local.id}&revision=${good}`);
  assert.equal(atGood.source, 'repo'); assert.equal(atGood.path, '.perpeto/ci.json'); assert.deepEqual(atGood.pipelines[0].jobs.map(job => job.key), ['repo']);
  const head = await f.ok('GET', `/pipelines?projectId=${local.id}`);
  assert.equal(head.revision, broken); assert.equal(head.error.code, 'PIPELINE_CONFIG_INVALID'); assert.deepEqual(head.pipelines, []);
  assert.equal((await f.request('POST', '/pipeline-runs', { projectId: local.id, pipeline: 'default' })).body.error.code, 'PIPELINE_CONFIG_INVALID');
  const manual = await f.ok('POST', '/pipeline-runs', { projectId: local.id, pipeline: 'default', revision: good });
  assert.equal(manual.configSource, 'repo');
  const node = await f.machine('runner');
  const [job] = await node.lease();
  assert.deepEqual(job.source, { kind: 'hub-bundle', path: `/jobs/${job.id}/bundle` }, 'the hub serves its own revision');
  assert.ok(!JSON.stringify(job).includes(repoRoot), 'no hub path leaves the hub');
});

test('schedule triggers fire once per matching minute from the default branch head', async t => {
  let now = Date.parse('2026-10-23T02:59:30.000Z');
  const f = await fixture(t, {}, { clock: () => now });
  const repoRoot = join(f.directory, 'repo'); await mkdir(repoRoot);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repoRoot, encoding: 'utf8' }).trim();
  git('init', '--quiet', '--initial-branch=main'); await mkdir(join(repoRoot, '.perpeto'));
  await writeFile(join(repoRoot, '.perpeto/ci.json'), JSON.stringify({ version: 1, pipelines: { nightly: { triggers: [{ on: 'schedule', cron: '0 3 * * *' }], jobs: { a: { steps: [{ name: 'a', run: 'x' }] } } } } }));
  git('add', '.'); git('commit', '--quiet', '-m', 'ci'); const head = git('rev-parse', 'HEAD');
  const project = await f.project('scheduled', null, { url: repoRoot, defaultBranch: 'main' });
  await f.hub.hub.maintenance();
  assert.equal((await f.ok('GET', `/pipeline-runs?projectId=${project.id}`)).runs.length, 0);
  now = Date.parse('2026-10-23T03:00:10.000Z'); await f.hub.hub.maintenance();
  now = Date.parse('2026-10-23T03:00:40.000Z'); await f.hub.hub.maintenance();
  const { runs } = await f.ok('GET', `/pipeline-runs?projectId=${project.id}`);
  assert.equal(runs.length, 1); assert.equal(runs[0].trigger.kind, 'schedule'); assert.equal(runs[0].revision, head); assert.equal(runs[0].ref, 'refs/heads/main');
});
