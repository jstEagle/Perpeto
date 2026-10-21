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

async function remainingJobs(root) {
  return readdir(join(root, 'jobs')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
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
  assert.deepEqual(await remainingJobs(repo.root), []);
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
  assert.deepEqual(await remainingJobs(repo.root), []);
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
  assert.deepEqual(await remainingJobs(repo.root), []);
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
  assert.deepEqual(await remainingJobs(repo.root), []);
});

test('CI rejects moving revisions and inaccessible commits with no false pass', async t => {
  const repo = await repository(t);
  for (const revision of ['main', '0'.repeat(40)]) {
    const result = await runJob({ ...job(repo, []), revision }, context(), { dataDir: repo.root });
    assert.equal(result.status, 'error');
  }
  assert.deepEqual(await remainingJobs(repo.root), []);
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
  assert.deepEqual(await remainingJobs(config.dataDir), []);
  await sleep(550);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});


test('M8: a background child retaining stdout cannot turn a successful shell exit into a timeout', async t => {
  const repo = await repository(t);
  const marker = join(repo.root, 'background-survived');
  const start = Date.now();
  const ctx = context();
  const result = await runJob(job(repo, [{ name: 'background', run: `(sleep 1; touch '${marker}') & echo hi; exit 0`, timeoutSec: 0.3 }]), ctx, { dataDir: repo.root });
  assert.equal(result.status, 'passed');
  assert.equal(result.steps[0].timedOut, false);
  assert.ok(Date.now() - start < 1000);
  assert.match(ctx.events.filter(e => e.type === 'log').map(e => e.data.chunk).join(''), /hi/);
  await sleep(1100);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('M18: thousands of short lines share bounded log requests with no dropped UTF-8 or secrets', async () => {
  const events = [];
  const stream = createLogStream({ maxBytes: 128, literals: ['secret'], step: 0, stream: 'stdout', report: async e => events.push(e) });
  const input = '🙂 secret\n'.repeat(3000);
  for (const line of input.split(/(?<=\n)/)) await stream.write(Buffer.from(line));
  await stream.end();
  assert.ok(events.length < 500, `one request per line: ${events.length}`);
  assert.equal(events.map(e => e.data.chunk).join(''), '🙂 [REDACTED]\n'.repeat(3000));
  assert.ok(events.every(e => Buffer.byteLength(e.data.chunk) <= 128));
});

test('M18: quiet output flushes within a time bound and flush errors propagate', async () => {
  const events = [];
  const stream = createLogStream({ maxBytes: 128, flushMs: 20, step: 0, stream: 'stdout', report: async e => events.push(e) });
  await stream.write(Buffer.from('still running\n'));
  assert.equal(events.length, 0);
  await eventually(() => events.length === 1, 300);
  await stream.end();
  const failed = createLogStream({ flushMs: 5, report: async () => { throw new Error('log delivery failed'); } });
  await failed.write(Buffer.from('line\n'));
  await sleep(30);
  await assert.rejects(failed.end(), /log delivery failed/);
});

test('H6: CI cannot inherit environment credentials or read node secrets, including through symlinks', async t => {
  const repo = await repository(t);
  const dataDir = join(repo.root, 'private-data');
  const outside = join(repo.root, 'external-credentials');
  await mkdir(dataDir);
  await writeFile(join(dataDir, 'machine.json'), 'NODE_SECRET', { mode: 0o600 });
  await writeFile(outside, 'EXTERNAL_SECRET', { mode: 0o600 });
  const previous = process.env.PERPETO_NODE_TEST_TOKEN;
  process.env.PERPETO_NODE_TEST_TOKEN = 'ENV_SECRET';
  t.after(() => { if (previous === undefined) delete process.env.PERPETO_NODE_TEST_TOKEN; else process.env.PERPETO_NODE_TEST_TOKEN = previous; });
  const ctx = context();
  const command = `test -z "$PERPETO_NODE_TEST_TOKEN" && ! cat '${dataDir}/machine.json' && ! cat '${outside}' && ln -s '${outside}' linked && ! cat linked && test "$HOME" != '${process.env.HOME}' && pwd`;
  const result = await runJob(job(repo, [{ name: 'isolation', run: command }]), ctx, { dataDir, protectedPaths: [outside] });
  assert.equal(result.status, 'passed');
  const output = ctx.events.filter(e => e.type === 'log').map(e => e.data.chunk).join('');
  assert.equal(/NODE_SECRET|EXTERNAL_SECRET|ENV_SECRET/.test(output), false);
  assert.equal(output.includes(`${dataDir}/jobs`), false);
  const checkout = ctx.events.filter(e => e.type === 'log' && e.data.stream === 'stdout').map(e => e.data.chunk).join('').trim().split('\n').at(-1);
  assert.match(checkout, /perpeto-ci-.*\/source$/);
  await assert.rejects(readFile(join(checkout, 'value.txt')), { code: 'ENOENT' });
});


test('M5: heartbeat cancellation stops CI and acknowledges the exact job revision and attempt', async t => {
  let cancel = false;
  const hub = await fakeHub(t, { ttl: 5000, heartbeat: () => cancel ? { cancel: { jobs: ['job_test'], assignments: [] } } : {} });
  const repo = await repository(t);
  const { configPath } = await nodeConfig(t, hub, { capacity: { maxAgents: 0, maxJobs: 1 }, timing: { heartbeatMs: 20, renewMs: 2000 } });
  hub.jobs.push(job(repo, [{ name: 'wait', run: 'echo running; sleep 30' }]));
  const node = await createNode({ configPath });
  addCleanup(t, () => node.stop({ drain: false }));
  await node.start();
  await eventually(() => hub.events.some(e => e.type === 'log'));
  cancel = true;
  await eventually(() => node.status.running.jobs === 0, 1500);
  const ack = hub.events.filter(e => e.type === 'cancelled');
  assert.equal(ack.length, 1);
  assert.equal(ack[0].attempt, 1);
  assert.equal(ack[0].data.revision, repo.revision);
  assert.equal(ack[0].data.configHash, 'config_exact');
  assert.equal(hub.events.filter(e => e.type === 'completed').length, 0);
});

test('H6: daemon protects external credential/redaction/account paths and redacts its token automatically', async t => {
  const hub = await fakeHub(t, { ttl: 5000 });
  const repo = await repository(t);
  const { dir, configPath, config } = await nodeConfig(t, hub, { capacity: { maxAgents: 0, maxJobs: 1 } });
  const credentialFile = join(dir, 'outside-machine.json');
  const redactionFile = join(dir, 'redaction.json');
  const accountDir = join(dir, 'outside-accounts');
  await writeFile(`${credentialFile}.rotation.tmp`, 'ROTATION_TEMP_SECRET', { mode: 0o600 });
  await mkdir(accountDir, { mode: 0o700 });
  await writeFile(join(accountDir, 'secret'), 'ACCOUNT_SECRET', { mode: 0o600 });
  await writeFile(redactionFile, JSON.stringify({ literals: ['EXACT_SECRET'] }), { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({ ...config, credentialFile, accounts: { nodeDataDir: accountDir }, jobs: { redactionFile } }));
  hub.jobs.push(job(repo, [{ name: 'probe', run: `! cat '${credentialFile}' && ! cat '${credentialFile}.rotation.tmp' && ! cat '${redactionFile}' && ! cat '${accountDir}/secret' && printf 'private-machine-token\\nEXACT_SECRET\\n'` }]));
  const node = await createNode({ configPath });
  addCleanup(t, () => node.stop({ drain: false }));
  await node.start();
  await eventually(() => hub.events.some(e => e.type === 'completed'), 5000);
  assert.equal(hub.events.find(e => e.type === 'completed').data.status, 'passed');
  const output = hub.events.filter(e => e.type === 'log').map(e => e.data.chunk).join('');
  assert.equal(/private-machine-token|EXACT_SECRET|ACCOUNT_SECRET|ROTATION_TEMP_SECRET/.test(output), false);
  assert.match(output, /REDACTED/);
});

test('H6: trusted checkout remote rewrites remain available without exposing Git config to CI steps', async t => {
  const repo = await repository(t);
  const configFile = join(repo.root, 'checkout.gitconfig');
  const remote = 'https://perpeto-fixture.invalid/repo.git';
  await writeFile(configFile, `[url "${repo.bare}"]\n  insteadOf = ${remote}\n# CONFIG_SECRET\n`, { mode: 0o600 });
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = configFile;
  t.after(() => { if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous; });
  const ctx = context();
  const result = await runJob({ ...job(repo, [{ name: 'verify', run: `test -z "$GIT_CONFIG_GLOBAL" && ! cat '${configFile}' && git rev-parse HEAD` }]), repo: remote }, ctx, { dataDir: repo.root });
  assert.equal(result.status, 'passed');
  assert.equal(JSON.stringify(ctx.events).includes('CONFIG_SECRET'), false);
});

test('a hub-sourced job fetches its bundle into the job workspace and runs at exactly its revision; a bundle without it fails', async t => {
  const repo = await repository(t);
  // What the hub serves: a bundle of one ref at the job's revision, holding no newer commits.
  const bundles = join(repo.root, 'bundles'); await mkdir(bundles);
  const make = async (name, revision) => {
    await exec('git', ['update-ref', `refs/perpeto/bundles/${name}`, revision], { cwd: repo.bare });
    await exec('git', ['bundle', 'create', join(bundles, `${name}.bundle`), `refs/perpeto/bundles/${name}`], { cwd: repo.bare });
  };
  await make('exact', repo.revision);
  const requests = [];
  const source = name => ({ ...context(), fetchSource: async (path, file) => { requests.push(path); await writeFile(file, await readFile(join(bundles, `${name}.bundle`))); } });
  const ctx = source('exact');
  const hubJob = { ...job(repo, [{ name: 'verify', run: `test "$(git rev-parse HEAD)" = "${repo.revision}" && cat value.txt` }]), repo: { defaultBranch: 'main' }, source: { kind: 'hub-bundle', path: '/jobs/job_hub/bundle' } };
  const result = await runJob(hubJob, ctx, { dataDir: repo.root });
  assert.equal(result.status, 'passed'); assert.deepEqual(requests, ['/jobs/job_hub/bundle']);
  assert.match(ctx.events.filter(event => event.type === 'log').map(event => event.data.chunk).join(''), /exact revision/);
  // A bundle that does not hold the job's revision never yields a pass.
  const wrong = await runJob({ ...hubJob, revision: repo.latest }, source('exact'), { dataDir: repo.root });
  assert.equal(wrong.status, 'error');
  for (const path of ['/jobs/../bundle', '/elsewhere', 'http://evil/jobs/x/bundle']) {
    assert.equal((await runJob({ ...hubJob, source: { kind: 'hub-bundle', path } }, source('exact'), { dataDir: repo.root })).status, 'error', path);
  }
});
