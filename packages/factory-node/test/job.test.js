import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { runJob, createNode, createLogStream } from '../src/index.js';
import { fakeHub, nodeConfig, eventually, addCleanup } from './helpers.js';
const exec = promisify(execFile);

async function repository(t) {
  const root = await mkdtemp(join(tmpdir(), 'perpeto-job-'));
  addCleanup(t, () => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(source);
  const git = async args => (await exec('git', args, { cwd: source })).stdout.trim();
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.email', 'node-test@localhost']);
  await git(['config', 'user.name', 'Node Test']);
  await writeFile(join(source, 'value.txt'), 'exact revision\n');
  await git(['add', '.']); await git(['commit', '-m', 'first']);
  const revision = await git(['rev-parse', 'HEAD']);
  await writeFile(join(source, 'value.txt'), 'newer revision\n');
  await git(['add', '.']); await git(['commit', '-m', 'second']);
  const latest = await git(['rev-parse', 'HEAD']);
  const bare = join(root, 'repo.git');
  await git(['clone', '--bare', source, bare]);
  return { root, source, bare, revision, latest };
}

function context(controller = new AbortController()) {
  const events = [];
  return { events, signal: controller.signal, report: async event => { events.push(event); } };
}
function job(repo, steps) {
  return { id: 'job_test', attempt: 1, repo: { url: repo.bare }, revision: repo.revision, configHash: 'config_exact', requirements: {}, steps };
}

test('CI clones a bare repo at the exact commit, streams bounded redacted logs, and cleans the workspace', async t => {
  const repo = await repository(t);
  const ctx = context();
  const result = await runJob(job(repo, [{ name: 'verify', run: 'test "$(git rev-parse HEAD)" = "' + repo.revision + '" && cat value.txt && printf "prefix secret-value suffix\\n" && printf "token=ABCD\\n"' }]), ctx,
    { dataDir: repo.root, maxLogChunkBytes: 128, redaction: { literals: ['secret-value'], patterns: ['token=[A-Z]+'] } });
  assert.equal(result.status, 'passed');
  assert.equal(result.revision, repo.revision);
  assert.equal(result.configHash, 'config_exact');
  assert.equal(result.steps[0].status, 'passed');
  const chunks = ctx.events.filter(event => event.type === 'log').map(event => event.data.chunk);
  assert.ok(chunks.every(chunk => Buffer.byteLength(chunk) <= 128));
  assert.match(chunks.join(''), /exact revision/);
  assert.equal(chunks.join('').includes('newer revision'), false);
  assert.equal(chunks.join('').includes('secret-value'), false);
  assert.equal(chunks.join('').includes('token=ABCD'), false);
  assert.match(chunks.join(''), /\[REDACTED\]/);
  assert.deepEqual(await readdir(join(repo.root, 'jobs')), []);
  assert.equal(await readFile(join(repo.source, 'value.txt'), 'utf8'), 'newer revision\n');
});

test('CI stops after a failed step and reports revision-bound step evidence', async t => {
  const repo = await repository(t);
  const ctx = context();
  const result = await runJob(job(repo, [{ name: 'failure', run: 'echo failure >&2; exit 7' }, { name: 'never', run: 'echo SHOULD_NOT_RUN' }]), ctx, { dataDir: repo.root });
  assert.equal(result.status, 'failed');
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].exitCode, 7);
  assert.equal(ctx.events.find(event => event.type === 'step').data.configHash, 'config_exact');
  assert.equal(JSON.stringify(ctx.events).includes('SHOULD_NOT_RUN'), false);
  assert.deepEqual(await readdir(join(repo.root, 'jobs')), []);
});

test('CI timeout terminates the shell and child processes', async t => {
  const repo = await repository(t);
  const marker = join(repo.root, 'escaped');
  const started = Date.now();
  const result = await runJob(job(repo, [{ name: 'timeout', run: `(sleep 0.5; touch '${marker}') & wait`, timeoutSec: 0.08 }]), context(), { dataDir: repo.root });
  assert.equal(result.status, 'error');
  assert.equal(result.steps[0].timedOut, true);
  assert.ok(Date.now() - started < 2000);
  await sleep(550);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  assert.deepEqual(await readdir(join(repo.root, 'jobs')), []);
});

test('CI cancellation kills running work and returns cancelled evidence', async t => {
  const repo = await repository(t);
  const controller = new AbortController();
  const ctx = context(controller);
  const running = runJob(job(repo, [{ name: 'cancel', run: 'echo running; sleep 30' }]), ctx, { dataDir: repo.root });
  await eventually(() => ctx.events.some(event => event.type === 'log'));
  controller.abort();
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.steps[0].status, 'cancelled');
  assert.deepEqual(await readdir(join(repo.root, 'jobs')), []);
});

test('CI rejects moving revisions and inaccessible commits with no false pass', async t => {
  const repo = await repository(t);
  for (const revision of ['main', '0'.repeat(40)]) {
    const result = await runJob({ ...job(repo, []), revision }, context(), { dataDir: repo.root });
    assert.equal(result.status, 'error');
  }
  assert.deepEqual(await readdir(join(repo.root, 'jobs')), []);
});

test('redaction spans input chunks, preserves UTF-8, masks oversized lines, and never exceeds the chunk limit', async () => {
  const events = [];
  const stream = createLogStream({ maxBytes: 128, literals: ['SECRET'], patterns: ['token=[a-z]+'], step: 0, stream: 'stdout', report: async event => events.push(event) });
  await stream.write(Buffer.from('prefix SEC'));
  await stream.write(Buffer.from('RET token=abc'));
  await stream.write(Buffer.from('def\n'));
  const unicode = Buffer.from('🙂終\n');
  await stream.write(unicode.subarray(0, 2));
  await stream.write(unicode.subarray(2));
  await stream.write(Buffer.from('a'.repeat(140) + 'SECRET'));
  await stream.write(Buffer.from('more secret text\nlast SEC'));
  await stream.write(Buffer.from('RET'));
  await stream.end();
  const text = events.map(event => event.data.chunk).join('');
  assert.equal(text.includes('SECRET'), false);
  assert.equal(text.includes('token=abcdef'), false);
  assert.equal(text.includes('secret text'), false);
  assert.ok(text.includes('🙂終'));
  assert.ok(text.includes('[REDACTED oversized log line]'));
  assert.ok(events.every(event => Buffer.byteLength(event.data.chunk) <= 128));
});

test('daemon leases jobs independently from agents and sends exact-revision final evidence', async t => {
  const hub = await fakeHub(t, { ttl: 1000 });
  const repo = await repository(t);
  const { configPath } = await nodeConfig(t, hub, { capacity: { maxAgents: 0, maxJobs: 1 } });
  hub.jobs.push(job(repo, [{ name: 'ci', run: 'cat value.txt' }]), { ...job(repo, [{ name: 'failed', run: 'exit 2' }]), id: 'job_second' });
  const node = await createNode({ configPath });
  await node.start();
  addCleanup(t, () => node.stop({ drain: false }));
  await eventually(() => hub.events.filter(event => event.type === 'completed').length === 2);
  const finals = hub.events.filter(event => event.type === 'completed');
  assert.deepEqual(finals.map(event => event.data.status), ['passed', 'failed']);
  assert.ok(finals.every(event => event.data.revision === repo.revision && event.data.configHash === 'config_exact'));
  assert.ok(hub.requests.filter(req => req.path.endsWith('/lease')).every(req => req.body.kinds[0] === 'job' && req.body.max === 1));
});

test('daemon abandons a running CI process on lease_lost, removes its clone, and sends no completion', async t => {
  const hub = await fakeHub(t, { ttl: 1000 });
  const repo = await repository(t);
  const marker = join(repo.root, 'stale-process');
  const { configPath, config } = await nodeConfig(t, hub, { capacity: { maxAgents: 0, maxJobs: 1 } });
  hub.jobs.push(job(repo, [{ name: 'lose', run: `echo running; sleep 0.5; touch '${marker}'` }]));
  const node = await createNode({ configPath });
  await node.start();
  addCleanup(t, () => node.stop({ drain: false }));
  await eventually(() => hub.events.some(event => event.type === 'log'));
  hub.lost = true;
  await eventually(() => node.status.running.jobs === 0);
  assert.equal(hub.events.filter(event => event.type === 'completed').length, 0);
  assert.deepEqual(await readdir(join(config.dataDir, 'jobs')), []);
  await sleep(550);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});
