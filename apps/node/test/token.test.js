import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createNode, loadConfig } from '../src/index.js';
import { fakeHub, nodeConfig, addCleanup, eventually, assignment } from './helpers.js';

async function start(t, configPath) {
  const node = await createNode({ configPath });
  addCleanup(t, () => node.stop({ drain: false }));
  await node.start();
  return node;
}

test('rotation is single-flight, replays a lost response, and persists privately before first use', async t => {
  let credentialFile;
  let persistedBeforeUse = false;
  const hub = await fakeHub(t, { async onRequest({ auth }) {
    if (!auth?.includes('private-machine-token_')) return;
    const saved = JSON.parse(await readFile(credentialFile));
    assert.equal(auth, `Bearer ${saved.token}`);
    assert.equal((await stat(credentialFile)).mode & 0o777, 0o600);
    persistedBeforeUse = true;
  } });
  const { configPath, config } = await nodeConfig(t, hub);
  credentialFile = join(config.dataDir, 'machine.json');
  const node = await start(t, configPath);
  assert.equal(typeof node.rotateToken, 'function');
  hub.dropToken = true;
  const [first, second] = await Promise.all([node.rotateToken(), node.rotateToken()]);
  assert.equal(hub.generation, 1);
  assert.deepEqual(first, second);
  assert.equal(first.generation, 1);
  assert.equal(Object.hasOwn(first, 'token'), false);
  const requests = hub.requests.filter(r => r.path.endsWith('/nodes/token'));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.idempotencyKey, requests[1].body.idempotencyKey);
  assert.ok(persistedBeforeUse);
  assert.equal(JSON.parse(await readFile(credentialFile)).tokenGeneration, 1);
  await node.rotateToken();
  assert.equal(hub.generation, 2);
  assert.notEqual(hub.requests.filter(r => r.path.endsWith('/nodes/token')).at(-1).body.idempotencyKey, requests[0].body.idempotencyKey);
});

test('a failed credential commit never activates the new token and startup resumes the durable rotation key', async t => {
  let credentialFile;
  let pending;
  let failCommit = true;
  const hub = await fakeHub(t, { async rotate() {
    if (!failCommit) return;
    pending = JSON.parse(await readFile(credentialFile));
    await rm(credentialFile);
    await mkdir(credentialFile);
  } });
  const { configPath, config } = await nodeConfig(t, hub);
  credentialFile = join(config.dataDir, 'machine.json');
  const node = await start(t, configPath);
  assert.equal(typeof node.rotateToken, 'function');
  await assert.rejects(node.rotateToken());
  assert.ok(pending.tokenRotationKey);
  assert.equal(hub.requests.some(r => r.auth?.includes('private-machine-token_')), false);
  await rm(credentialFile, { recursive: true });
  await writeFile(credentialFile, JSON.stringify(pending), { mode: 0o600 });
  failCommit = false;
  await node.stop();
  const restarted = await start(t, configPath);
  assert.equal(restarted.status.state, 'running');
  assert.equal(hub.generation, 1);
  assert.equal(JSON.parse(await readFile(credentialFile)).tokenGeneration, 1);
  const keys = hub.requests.filter(r => r.path.endsWith('/nodes/token')).map(r => r.body.idempotencyKey);
  assert.deepEqual(keys, [pending.tokenRotationKey, pending.tokenRotationKey]);
});

test('rotation interval is configurable and survives restart through its persisted timestamp', async t => {
  const hub = await fakeHub(t);
  const { configPath, config } = await nodeConfig(t, hub, { tokenRotationMs: 60 });
  const node = await start(t, configPath);
  await eventually(() => hub.generation >= 1);
  await node.stop();
  const credentialFile = join(config.dataDir, 'machine.json');
  const saved = JSON.parse(await readFile(credentialFile));
  saved.tokenRotatedAt = new Date(Date.now() - 1000).toISOString();
  await writeFile(credentialFile, JSON.stringify(saved), { mode: 0o600 });
  const before = hub.generation;
  await start(t, configPath);
  await eventually(() => hub.generation > before);
});

test('rotation interval rejects malformed configuration and zero disables automatic rotation', async t => {
  const hub = await fakeHub(t);
  const { configPath, config } = await nodeConfig(t, hub);
  for (const tokenRotationMs of [-1, 1.5, 'daily']) {
    await writeFile(configPath, JSON.stringify({ ...config, tokenRotationMs }));
    await assert.rejects(loadConfig(configPath));
  }
  await writeFile(configPath, JSON.stringify({ ...config, tokenRotationMs: 0 }));
  await start(t, configPath);
  await sleep(100);
  assert.equal(hub.generation, 0);
});

test('revoked authorization is fatal, aborts active work, and asks for re-enrollment without repeated 401 retries', async t => {
  const hub = await fakeHub(t, { ttl: 5000 });
  const { configPath } = await nodeConfig(t, hub, { fake: { delayMs: 10000 } });
  hub.assignments.push(assignment('asg_revoked'));
  const node = await start(t, configPath);
  await eventually(() => hub.events.some(e => e.type === 'started'));
  hub.revoked = true;
  await eventually(() => node.status.state === 'error' && node.status.running.agents === 0);
  assert.match(node.error.message, /machine revoked.*re.enroll/i);
  const before = hub.requests.length;
  await sleep(100);
  assert.equal(hub.requests.length, before);
  assert.equal(hub.events.some(e => e.type === 'completed'), false);
});

test('real hub accepts node rotation and heartbeat labels, retires the old token, and revokes authorization', async t => {
  const { createHub } = await import('@perpeto/hub');
  const { configPath, config, dir } = await nodeConfig(t, { url: 'http://127.0.0.1:1' }, {
    tokenRotationMs: 0, labels: ['updated'], timing: { heartbeatMs: 30, requestMs: 2000, renewMs: 100, pollIdleMs: 5 },
  });
  const hubConfigPath = join(dir, 'hub.json');
  await writeFile(hubConfigPath, JSON.stringify({ port: 0, databasePath: './hub/hub.sqlite', messagingDatabasePath: './hub/messaging.sqlite',
    deliveryDatabasePath: './hub/delivery.sqlite', ownerTokenPath: './hub/owner.secret', longPollMs: 20, maintenanceIntervalMs: 20 }));
  const server = await createHub({ configPath: hubConfigPath });
  addCleanup(t, () => server.close());
  const url = await server.listen();
  const owner = (await readFile(join(dir, 'hub/owner.secret'), 'utf8')).trim();
  const request = async (path, body, bearer = owner) => {
    const response = await fetch(`${url}/api/v1${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(2000) });
    return { status: response.status, body: await response.json() };
  };
  const enrollment = await request('/machines/enrollment-codes', {});
  await writeFile(config.enrollmentCodeFile, enrollment.body.code, { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({ ...config, hubUrl: url }));
  const node = await start(t, configPath);
  const old = JSON.parse(await readFile(join(config.dataDir, 'machine.json')));
  await node.rotateToken();
  const saved = JSON.parse(await readFile(join(config.dataDir, 'machine.json')));
  assert.notEqual(saved.token, old.token);
  assert.equal((await request('/nodes/heartbeat', { capacity: config.capacity, running: { agents: 0, jobs: 0 } }, old.token)).status, 401);
  const machines = (await request('/machines')).body.machines;
  assert.deepEqual(machines.find(machine => machine.id === node.status.machineId).labels, ['updated']);
  assert.equal(machines.find(machine => machine.id === node.status.machineId).tokenGeneration, 1);
  assert.equal((await request(`/machines/${node.status.machineId}/revoke`, { reason: 'fixture revocation' })).status, 200);
  await eventually(() => node.status.state === 'error');
  assert.match(node.error.message, /machine revoked.*re.enroll/i);
});

test('CLI rotates on SIGUSR2 and exits nonzero with re-enrollment guidance after revocation, including startup', { skip: process.platform === 'win32' }, async t => {
  const { spawn } = await import('node:child_process');
  const hub = await fakeHub(t);
  const { configPath } = await nodeConfig(t, hub, { tokenRotationMs: 0 });
  async function launch() {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/perpeto-node.js', import.meta.url)), '--config', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
    addCleanup(t, async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      try { await exited; } finally { clearTimeout(timer); }
    });
    return { child, exited, output: () => output };
  }
  const running = await launch();
  await eventually(() => hub.heartbeats.length > 0);
  running.child.kill('SIGUSR2');
  await eventually(() => hub.generation === 1);
  hub.revoked = true;
  assert.equal(await running.exited, 1);
  assert.match(running.output(), /machine revoked.*re.enroll/i);
  assert.equal(running.output().includes('private-machine-token'), false);
  const restarted = await launch();
  assert.equal(await restarted.exited, 1);
  assert.match(restarted.output(), /machine revoked.*re.enroll/i);
  assert.equal(hub.enrollments, 1);
});
