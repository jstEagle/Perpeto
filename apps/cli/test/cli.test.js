import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, chmod, lstat, access, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { parseArgs } from '../src/args.js';
import { hubConfig, nodeConfig, repoRoot, readSecret, privateDir, initHub, readJson } from '../src/config.js';
import { doctor, supportedNode } from '../src/doctor.js';
import { generateService, service, serviceCommands } from '../src/service.js';
import { acquireLock, control, stop as stopDaemon } from '../src/process.js';
import { join, enrollCode, request } from '../src/api.js';

const exec = promisify(execFile);
const bin = resolve(repoRoot, 'apps/cli/bin/perpeto.js');
async function temporary(t) {
  const dir = await mkdtemp(resolve(tmpdir(), 'pcli-'));
  t.after(async () => {
    for (const role of ['node', 'hub']) assert.equal((await stopDaemon(dir, role)).state, 'stopped');
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}
async function cli(dir, ...args) {
  const { stdout, stderr } = await exec(process.execPath, [bin, ...args, '--dir', dir], { timeout: 20000 });
  assert.doesNotMatch(stderr, /Bearer|token|enrollment/i);
  return stdout.trim();
}

test('argument parsing validates commands, explicit secret display and option values', () => {
  assert.equal(parseArgs([]).help, true);
  const parsed = parseArgs(['--dir', '/tmp/control', 'hub', 'init', '--port=0']);
  assert.equal(parsed.dir, '/tmp/control'); assert.equal(parsed.flags.port, '0');
  assert.deepEqual(parseArgs(['service', 'install', 'node', '--dry-run']).positionals, ['node']);
  assert.equal(parseArgs(['hub', 'enroll-code', '--show-code']).flags['show-code'], true);
  assert.equal(parseArgs(['node', 'join', 'https://hub.example', '--code', 'fixture']).flags.code, 'fixture');
  for (const args of [ ['wat'], ['hub', 'start', 'extra'], ['hub', 'start', '--code', 'fixture'],
    ['hub', 'init', '--port', '65536'], ['hub', 'init', '--port', '-1'], ['hub', 'init', '--port'],
    ['hub', 'init', '--show-owner-token=false'], ['hub', 'init', '--port', '1', '--port', '2'],
    ['service', 'install', 'other'], ['status', 'extra'], ['node', 'join', 'https://hub.example'],
    ['node', 'join', 'https://hub.example', '--code', 'x', '--code-file', '/tmp/x'] ]) assert.throws(() => parseArgs(args));
});

test('configuration contains paths rather than credentials and rejects unsafe hub URLs', async t => {
  const dir = await temporary(t);
  const hub = hubConfig(dir, { port: 0 });
  assert.equal(hub.port, 0); assert.equal(hub.ownerTokenPath, './hub/owner.secret');
  const node = nodeConfig(dir, 'https://hub.example', { labels: ['ci'] });
  assert.deepEqual(node.labels, ['ci']); assert.equal(node.runtime.enabled, false);
  assert.equal(Object.hasOwn(node, 'token'), false);
  for (const url of ['http://remote.example', 'https://user:pass@hub.example', 'https://hub.example?token=x', 'https://hub.example/api/v1', 'file:///tmp/x']) {
    assert.throws(() => nodeConfig(dir, url));
  }
  await initHub(dir, { port: 0 });
  const before = await readFile(resolve(dir, 'hub/owner.secret'), 'utf8');
  await initHub(dir, { port: 4444 });
  assert.equal((await readJson(resolve(dir, 'hub.json'))).port, 0);
  assert.equal(await readSecret(resolve(dir, 'hub/owner.secret')), before);
  await chmod(resolve(dir, 'hub/owner.secret'), 0o644);
  await assert.rejects(readSecret(resolve(dir, 'hub/owner.secret')), /owner-only/);
  await symlink(resolve(dir, 'hub/owner.secret'), resolve(dir, 'linked.secret'));
  await assert.rejects(readSecret(resolve(dir, 'linked.secret')), /owner-only/);
  await chmod(dir, 0o755); await assert.rejects(privateDir(dir), /owner-only/); await chmod(dir, 0o700);
});

test('service templates escape paths and use foreground daemons with restart-on-failure', async t => {
  const home = await temporary(t);
  const dir = resolve(home, 'factory & "quoted" %n $VAR');
  const mac = await generateService({ dir, role: 'hub', platform: 'darwin', home, node: '/node & binary', path: '/usr/bin:/test & dir' });
  assert.match(mac.contents, /factory &amp; &quot;quoted&quot; %n \$VAR/);
  assert.match(mac.contents, /<string>run<\/string>/); assert.match(mac.contents, /<key>SuccessfulExit<\/key><false\/>/);
  assert.match(mac.contents, /hub.log/); assert.ok(!mac.contents.includes('owner.secret'));
  const linux = await generateService({ dir, role: 'node', platform: 'linux', home, node: '/node binary' });
  assert.match(linux.contents, /Restart=on-failure/); assert.match(linux.contents, /%%n \$\$VAR/);
  assert.match(linux.contents, /ExecStart="\/node binary" .* node run --dir/);
  assert.match(linux.contents, /StandardOutput=append:\//);
  assert.deepEqual(serviceCommands('install', linux, 'linux')[1], ['systemctl', ['--user', 'enable', '--now', 'perpeto-node.service']]);
  await assert.rejects(generateService({ dir: '/tmp/line\nbreak', role: 'hub', platform: 'linux' }));
  await assert.rejects(generateService({ dir, role: 'hub', platform: 'win32' }));
  if (process.platform === 'darwin') {
    const path = resolve(home, 'check.plist'); await writeFile(path, mac.contents);
    await exec('plutil', ['-lint', path]);
  }
});

test('service dry-run writes/loads nothing; real mutations use only stubbed service managers', async t => {
  const home = await temporary(t); const dir = resolve(home, 'data');
  await initHub(dir, { port: 0 });
  const calls = [];
  const options = { home, platform: 'linux', run(cmd, args) { calls.push([cmd, args]); return { status: 0 }; } };
  const [preview] = await service('install', dir, 'hub', { ...options, dryRun: true });
  assert.equal(calls.length, 0); await assert.rejects(access(preview.file));
  await service('install', dir, 'hub', options);
  assert.equal(calls.length, 2); assert.equal((await lstat(preview.file)).mode & 0o777, 0o600);
  await service('install', dir, 'hub', options); // same file is safe to reuse
  await service('uninstall', dir, 'hub', options); await assert.rejects(access(preview.file));
  await service('uninstall', dir, 'hub', options);
  await mkdir(resolve(home, '.config/systemd/user'), { recursive: true });
  await writeFile(preview.file, 'unrelated service');
  await assert.rejects(service('install', dir, 'hub', options), /another installation/);
  await assert.rejects(service('uninstall', dir, 'hub', options), /another installation/);
  assert.equal(await readFile(preview.file, 'utf8'), 'unrelated service');
  await rm(preview.file);
  await assert.rejects(service('install', dir, 'hub', { ...options, run: () => ({ status: 1 }) }), /retained/);
  await access(preview.file);
});

test('doctor checks versions, stubbed CLIs, build, reachability and secret permissions', async t => {
  const dir = await temporary(t); const root = resolve(dir, 'repo');
  await mkdir(resolve(root, 'config'), { recursive: true }); await mkdir(resolve(root, 'runtime/apps/server/dist'), { recursive: true });
  await writeFile(resolve(root, 'config/perpeto.json'), JSON.stringify({ runtime: { directory: 'runtime' } }));
  await writeFile(resolve(root, 'runtime/apps/server/dist/bin.mjs'), '');
  await writeFile(resolve(dir, 'node.json'), JSON.stringify({ hubUrl: 'https://hub.example', credentialFile: 'machine.json' }));
  await writeFile(resolve(dir, 'machine.json'), 'fixture', { mode: 0o600 });
  const calls = [];
  const options = { root, version: 'v24.13.1', run: command => { calls.push(command); return { status: command === 'claude' ? 1 : 0 }; },
    fetchImpl: async url => { assert.equal(url, 'https://hub.example/api/v1/health'); return { ok: true, json: async () => ({ status: 'ok' }) }; } };
  let checks = await doctor(dir, options);
  assert.deepEqual(calls, ['git', 'claude', 'codex']);
  assert.equal(checks.find(c => c.name === 'claude').status, 'fail');
  for (const name of ['Node', 'git', 'codex', 'T3 build', 'Hub', 'Secret permissions']) assert.equal(checks.find(c => c.name === name).status, 'ok');
  await chmod(resolve(dir, 'machine.json'), 0o644);
  checks = await doctor(dir, { ...options, version: 'v25.0.0', fetchImpl: async () => { throw new Error('fixture'); } });
  for (const name of ['Node', 'Hub', 'Secret permissions']) assert.equal(checks.find(c => c.name === name).status, 'fail');
  for (const v of ['v24.13.0', 'v23.99.0', 'v25.0.0']) assert.equal(supportedNode(v), false);
  for (const v of ['v24.13.1', 'v24.22.0']) assert.equal(supportedNode(v), true);
  await writeFile(resolve(dir, 'node.json'), JSON.stringify({ hubUrl: 'https://private-credential@hub.example', credentialFile: 'machine.json' }));
  let called = false;
  checks = await doctor(dir, { ...options, fetchImpl: async () => { called = true; } });
  assert.equal(called, false); assert.ok(!JSON.stringify(checks).includes('private-credential'));
});

test('process locks refuse live owners and recover dead owners without signalling them', async t => {
  const dir = await temporary(t);
  const release = await acquireLock(dir, 'hub');
  await assert.rejects(acquireLock(dir, 'hub'), /already running/); await release();
  await writeFile(resolve(dir, 'hub.lock'), JSON.stringify({ pid: 2147483647 }));
  const recovered = await acquireLock(dir, 'hub'); await recovered();
  await writeFile(resolve(dir, 'hub.lock'), '{}'); await assert.rejects(acquireLock(dir, 'hub'), /Invalid process lock/);
});

test('real hub/node lifecycle, enrollment, overview, drain, restart and secret-free output', { timeout: 60000 }, async t => {
  const dir = await temporary(t); const nodeDir = await temporary(t);
  const initialized = await cli(dir, 'hub', 'init', '--port', '0'); assert.match(initialized, /Hub initialized/);
  const token = (await readSecret(resolve(dir, 'hub/owner.secret'))).trim();
  assert.ok(!initialized.includes(token));
  assert.ok((await cli(dir, 'hub', 'init', '--show-owner-token')).includes(token));
  const started = JSON.parse(await cli(dir, 'hub', 'start'));
  assert.equal(started.state, 'running'); assert.match(started.url, /^http:\/\/127.0.0.1:\d+$/);
  assert.notEqual(new URL(started.url).port, '0');
  assert.equal(JSON.parse(await cli(dir, 'hub', 'start')).url, started.url);
  assert.equal(JSON.parse(await cli(dir, 'hub', 'status')).url, started.url);
  assert.match(await cli(dir, 'status'), /Machines online: 0/);
  const enrollment = await cli(dir, 'hub', 'enroll-code', '--labels', 'ci,local');
  const path = enrollment.split('\n').find(line => line.startsWith('Enrollment file: ')).slice('Enrollment file: '.length);
  const secret = JSON.parse(await readSecret(path)); assert.ok(!enrollment.includes(secret.code));
  assert.equal(Object.hasOwn(secret, 'hubUrl'), false); // The destination can be the hub's HTTPS proxy alias.
  const joined = await cli(nodeDir, 'node', 'join', started.url, '--code-file', path);
  const credential = JSON.parse(await readSecret(resolve(nodeDir, 'node/machine.json')));
  assert.ok(!joined.includes(credential.token)); assert.deepEqual((await readJson(resolve(nodeDir, 'node.json'))).labels, ['ci', 'local']);
  await assert.rejects(join(await temporary(t), started.url, { code: secret.code }));
  // Simulate a response lost after the hub consumed the code, then recover with the persisted request.
  const retryDir = await temporary(t); await mkdir(resolve(retryDir, 'node'));
  const retryCode = await enrollCode(dir);
  const retryConfig = nodeConfig(retryDir, started.url, { name: 'retry-node' });
  const body = { code: retryCode.code, name: 'retry-node', os: process.platform, arch: process.arch,
    labels: [], providers: [], version: '0.0.1', idempotencyKey: 'cli-enrollment-retry' };
  await writeFile(resolve(retryDir, 'join.secret'), JSON.stringify({ config: retryConfig, body }), { mode: 0o600 });
  const original = await request(started.url, '/nodes/enroll', { body });
  const retried = await join(retryDir, started.url, { code: retryCode.code, name: 'retry-node' });
  assert.equal(retried.machineId, original.machineId);
  assert.equal(JSON.parse(await readSecret(resolve(retryDir, 'node/machine.json'))).token, original.token);
  await assert.rejects(access(resolve(retryDir, 'join.secret')));
  const runningNode = JSON.parse(await cli(nodeDir, 'node', 'start')); assert.equal(runningNode.state, 'running');
  assert.match(await cli(dir, 'status'), /Machines online: 2/);
  assert.equal(JSON.parse(await cli(nodeDir, 'node', 'drain')).state, 'draining');
  assert.equal(JSON.parse(await cli(nodeDir, 'node', 'stop')).state, 'stopped');
  assert.equal(JSON.parse(await cli(dir, 'hub', 'stop')).state, 'stopped');
  assert.equal(JSON.parse(await cli(dir, 'hub', 'status')).state, 'stopped');
  await cli(dir, 'hub', 'start');
  assert.match(await cli(dir, 'status'), /Active agents: 0/);
  assert.equal((await readSecret(resolve(dir, 'hub/owner.secret'))).trim(), token);
  const logs = await readFile(resolve(dir, 'hub.log'), 'utf8');
  assert.ok(!logs.includes(token)); assert.ok(!logs.includes(secret.code));
  assert.ok(!(await readFile(resolve(nodeDir, 'node.log'), 'utf8')).includes(credential.token));
});

test('a node can be stopped while startup retries an unreachable hub', { timeout: 15000 }, async t => {
  const dir = await temporary(t);
  const config = nodeConfig(dir, 'http://127.0.0.1:1');
  config.timing = { requestMs: 100, backoffMinMs: 10, backoffMaxMs: 50 };
  await writeFile(resolve(dir, 'node.json'), JSON.stringify(config));
  await mkdir(resolve(dir, 'node'));
  await writeFile(resolve(dir, 'node/machine.json'), JSON.stringify({ machineId: 'mch_fixture', token: 'fixture' }), { mode: 0o600 });
  const child = spawn(process.execPath, [bin, 'node', 'run', '--dir', dir], { stdio: 'ignore' });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  const deadline = Date.now() + 3000; let status;
  while (Date.now() < deadline) {
    status = await control(dir, 'node').catch(() => null);
    if (status) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(status.state, 'starting');
  assert.equal(JSON.parse(await cli(dir, 'node', 'stop')).state, 'stopped');
  await exited;
});

test('fatal daemon authorization errors preserve a failure exit for service restart', { timeout: 10000 }, async t => {
  const dir = await temporary(t);
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(request.url.endsWith('/heartbeat') ? 200 : 401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ status: 'online', cancel: { assignments: [], jobs: [] } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const config = nodeConfig(dir, `http://127.0.0.1:${server.address().port}`);
  await writeFile(resolve(dir, 'node.json'), JSON.stringify(config)); await mkdir(resolve(dir, 'node'));
  await writeFile(resolve(dir, 'node/machine.json'), JSON.stringify({ machineId: 'mch_fixture', token: 'fixture' }), { mode: 0o600 });
  await assert.rejects(exec(process.execPath, [bin, 'node', 'run', '--dir', dir], { timeout: 5000 }), error => error.code === 1);
  await assert.rejects(access(resolve(dir, 'node.lock')));
});
