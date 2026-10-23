import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runJob, CiCache, resolveKey, loadConfig, ciCacheRoot, runnerConfig } from '../src/index.js';
import { collectArtifacts } from '../src/artifacts.js';
import { addCleanup } from './helpers.js';
const exec = promisify(execFile);

async function temp(t, prefix = 'perpeto-ci-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  addCleanup(t, () => rm(root, { recursive: true, force: true }));
  return root;
}
async function repository(t, files) {
  const root = await temp(t); const source = join(root, 'source'); await mkdir(source);
  const git = async args => (await exec('git', args, { cwd: source })).stdout.trim();
  await git(['init', '--initial-branch=main']); await git(['config', 'user.email', 'ci@localhost']); await git(['config', 'user.name', 'CI']);
  for (const [name, content] of Object.entries(files)) { await mkdir(join(source, name, '..'), { recursive: true }); await writeFile(join(source, name), content); }
  await git(['add', '.']); await git(['commit', '-m', 'first']);
  return { root, source, revision: await git(['rev-parse', 'HEAD']) };
}
const context = () => { const events = []; return { events, signal: new AbortController().signal, report: async event => { events.push(event); return { accepted: true }; } }; };
const logText = ctx => ctx.events.filter(event => event.type === 'log').map(event => event.data.chunk).join('');

test('a pipeline job gets its env, restores and saves its dependency cache, and uploads matching artifacts', async t => {
  const repo = await repository(t, { 'package-lock.json': '{"v":1}\n', 'src/app.txt': 'app\n' });
  const cache = await new CiCache({ root: join(repo.root, 'cache'), maxBytes: 1024 * 1024 }).init();
  const job = { id: 'job_env', projectId: 'prj_one', pipelineJob: 'test (node=24)', attempt: 1, repo: { url: repo.source }, revision: repo.revision, configHash: 'hash', requirements: {},
    env: { STAGE: 'ci', CI: 'yes', MATRIX_NODE: '24' },
    cache: [{ key: "deps-{{ hashFiles('package-lock.json') }}", paths: ['deps'] }],
    collect: [{ name: 'report', paths: ['out/*.txt'], maxBytes: 1000, when: 'always' }, { name: 'only-failure', paths: ['out/*'], when: 'on-failure' }],
    steps: [{ name: 'build', run: 'test -d deps && echo "restored $(cat deps/v)" || (mkdir deps && echo v1 > deps/v && echo fresh); mkdir -p out; echo "$STAGE $CI $MATRIX_NODE $PERPETO_PIPELINE_JOB $HOME" > out/report.txt; head -c 2000 /dev/zero > out/big.txt' }] };
  const first = context();
  const result = await runJob(job, first, { dataDir: join(repo.root, 'data'), cache, artifactMaxBytes: 10000 });
  assert.equal(result.status, 'passed', logText(first));
  assert.match(logText(first), /fresh/); assert.match(logText(first), /cache miss: deps-[a-f0-9]{32}/); assert.match(logText(first), /cache saved: deps-/);
  assert.deepEqual(result.cache.map(item => item.hit), [false]);
  assert.match(logText(first), /artifact report: skipped out\/big\.txt, over the 1000 byte cap/);
  const uploads = first.events.filter(event => event.type === 'artifact');
  assert.deepEqual([...new Set(uploads.map(event => event.data.path))], ['out/report.txt']);
  const report = Buffer.concat(uploads.map(event => Buffer.from(event.data.data, 'base64'))).toString();
  assert.match(report, /^ci yes 24 test \(node=24\) \/.*\/home\n$/, 'pipeline env applies, but HOME stays the sandbox home');
  assert.deepEqual(result.artifacts.map(item => item.path), ['out/report.txt']);
  assert.equal(cache.stats().entries, 1); assert.ok(cache.stats().sizeBytes > 0);

  const second = context();
  const again = await runJob(job, second, { dataDir: join(repo.root, 'data'), cache });
  assert.equal(again.status, 'passed'); assert.deepEqual(again.cache.map(item => item.hit), [true]);
  assert.match(logText(second), /restored v1/); assert.ok(!logText(second).includes('cache saved'));
  // Another project with the same key never sees this project's entry.
  const other = context();
  await runJob({ ...job, projectId: 'prj_two' }, other, { dataDir: join(repo.root, 'data'), cache });
  assert.match(logText(other), /fresh/);
});

test('a job past its timeout stops with an error, and invalid pipeline fields are refused before checkout', async t => {
  const repo = await repository(t, { 'a.txt': 'a' });
  const base = { id: 'job_t', attempt: 1, repo: { url: repo.source }, revision: repo.revision, configHash: 'h', requirements: {} };
  const ctx = context();
  const result = await runJob({ ...base, timeoutSec: 1, steps: [{ name: 'slow', run: 'sleep 5' }, { name: 'never', run: 'echo never' }] }, ctx, { dataDir: join(repo.root, 'data') });
  assert.equal(result.status, 'error'); assert.equal(result.steps.length, 1);
  assert.ok(!logText(ctx).includes('never'));
  for (const invalid of [{ env: { PATH: '/tmp' } }, { env: { HOME: 'x' } }, { cache: [{ key: 'k', paths: ['../up'] }] }, { collect: [{ name: 'a/b', paths: ['x'] }] }, { timeoutSec: 0 }]) {
    const refused = await runJob({ ...base, ...invalid, steps: [{ name: 'x', run: 'true' }] }, context(), { dataDir: join(repo.root, 'data') });
    assert.equal(refused.status, 'error', JSON.stringify(invalid)); assert.equal(refused.reason, 'job_execution_error');
  }
});

test('the dependency cache evicts least recently used entries above its cap and never follows symlinks out of the checkout', async t => {
  const root = await temp(t); const checkout = join(root, 'checkout'); await mkdir(join(checkout, 'deps'), { recursive: true });
  const cache = await new CiCache({ root: join(root, 'cache'), maxBytes: 2500 }).init();
  for (const name of ['restore-one', 'r1', 'r2']) await mkdir(join(root, name));
  await writeFile(join(checkout, 'deps/file'), 'x'.repeat(1000));
  assert.equal((await cache.save('p', 'one', ['deps'], checkout)).saved, true);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await cache.save('p', 'two', ['deps'], checkout)).saved, true);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(await cache.restore('p', 'one', ['deps'], join(root, 'restore-one')), true, 'touching one makes two the oldest');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await cache.save('p', 'three', ['deps'], checkout)).saved, true);
  assert.equal(cache.stats().entries, 2); assert.ok(cache.stats().sizeBytes <= 2500);
  assert.equal(await cache.restore('p', 'two', ['deps'], join(root, 'r2')), false, 'the least recently used entry was evicted');
  assert.equal(await cache.restore('p', 'one', ['deps'], join(root, 'r1')), true);
  assert.equal((await cache.save('p', 'one', ['deps'], checkout)).reason, 'exists');
  const small = await new CiCache({ root: join(root, 'small'), maxBytes: 10 }).init();
  assert.equal((await small.save('p', 'k', ['deps'], checkout)).reason, 'too-large');

  // A symlinked parent directory pointing outside is neither saved from nor restored into.
  const outside = join(root, 'outside'); await mkdir(join(outside, 'deps'), { recursive: true }); await writeFile(join(outside, 'deps/secret'), 'secret');
  const hostile = join(root, 'hostile'); await mkdir(hostile); await symlink(outside, join(hostile, 'link'));
  const saved = await cache.save('p', 'hostile', ['link/deps'], hostile);
  assert.equal(saved.saved, true);
  assert.equal(await cache.restore('p', 'hostile', ['link/deps'], hostile), true);
  assert.deepEqual(await readdir(join(outside, 'deps')), ['secret'], 'the outside directory is untouched');
  const entry = cache.entryPath('p', 'hostile');
  assert.deepEqual(await readdir(join(entry, 'files')), [], 'nothing from outside was cached');
});

test('cache keys hash file contents, and artifacts ignore files reached through symlinked directories', async t => {
  const root = await temp(t);
  await writeFile(join(root, 'lock.json'), 'one');
  const first = await resolveKey("deps-{{ hashFiles('lock.json', 'missing/**') }}", root);
  assert.equal(first, await resolveKey("deps-{{ hashFiles('lock.json', 'missing/**') }}", root));
  await writeFile(join(root, 'lock.json'), 'two');
  assert.notEqual(first, await resolveKey("deps-{{ hashFiles('lock.json', 'missing/**') }}", root));
  await assert.rejects(resolveKey('bad key with {{ odd }}', root));

  const outside = await temp(t); await writeFile(join(outside, 'passwd.txt'), 'root');
  await mkdir(join(root, 'out')); await writeFile(join(root, 'out/ok.txt'), 'fine');
  await symlink(outside, join(root, 'out/escape')); await symlink(join(outside, 'passwd.txt'), join(root, 'out/link.txt'));
  const events = [];
  const { uploaded } = await collectArtifacts([{ name: 'a', paths: ['out/**/*.txt', 'out/*.txt'] }], { checkout: root, status: 'passed', report: async event => { events.push(event); } });
  assert.deepEqual(uploaded.map(item => item.path), ['out/ok.txt']);
  assert.deepEqual(events.map(event => event.data.path), ['out/ok.txt']);
  const empty = await collectArtifacts([{ name: 'b', paths: ['none/*'] }, { name: 'c', paths: ['out/ok.txt'], when: 'on-failure' }], { checkout: root, status: 'passed', report: async () => {} });
  assert.deepEqual(empty.uploaded, []); assert.deepEqual(empty.notes, ['artifact b: no files matched']);
});

test('runner configuration: pools derive job capacity, labels and cache root are exposed, invalid pools are refused', async t => {
  const root = await temp(t);
  const write = async value => { const path = join(root, `node-${Math.random()}.json`); await writeFile(path, JSON.stringify({ hubUrl: 'http://127.0.0.1:1', dataDir: './data', ...value })); return path; };
  const config = await loadConfig(await write({ runner: { pools: [{ name: 'linux', maxJobs: 2 }, { name: 'gpu', maxJobs: 1 }], labels: ['cuda'], cacheMaxBytes: 1024 } }));
  assert.deepEqual(config.capacity, { maxAgents: 1, maxJobs: 3 });
  assert.equal(ciCacheRoot(config), join(root, 'data', 'ci-cache')); assert.equal(config.runner.cacheMaxBytes, 1024);
  const custom = await loadConfig(await write({ runner: { cacheDir: './cache-here' } }));
  assert.equal(ciCacheRoot(custom), join(root, 'cache-here'));
  for (const runner of [{ pools: [] }, { pools: [{ name: 'a b', maxJobs: 1 }] }, { pools: [{ name: 'a', maxJobs: 1 }, { name: 'a', maxJobs: 2 }] }, { unknown: true }, { cacheMaxBytes: -1 }]) {
    await assert.rejects(loadConfig(await write({ runner })), /runner/i, JSON.stringify(runner));
  }
  assert.equal(runnerConfig(undefined, root, join(root, 'd')).cacheDir, join(root, 'd', 'ci-cache'));
});
