import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { hubConfig, nodeConfig, readJson } from '../src/config.js';
import { service, generateService } from '../src/service.js';
import { acquireLock } from '../src/process.js';
import { join } from '../src/api.js';

async function temporary(t) {
  const dir = await mkdtemp(resolve(tmpdir(), 'pcli-review-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('L12 systemd ownership requires the entire marker line before any manager call', async t => {
  const home = await temporary(t); const dir = resolve(home, 'perpeto');
  await mkdir(dir, { mode: 0o700 });
  await writeFile(resolve(dir, 'hub.json'), '{}');
  const other = await generateService({ role: 'hub', dir: `${dir}-staging`, home, platform: 'linux' });
  await mkdir(resolve(home, '.config/systemd/user'), { recursive: true });
  await writeFile(other.file, other.contents);
  let calls = 0;
  const options = { home, platform: 'linux', run() { calls++; return { status: 0 }; } };
  for (const action of ['install', 'uninstall']) await assert.rejects(service(action, dir, 'hub', options), /another installation/);
  assert.equal(calls, 0);
  assert.equal(await readFile(other.file, 'utf8'), other.contents);
});

test('L13 enrollment retry uses saved defaults after a hostname change and rejects explicit changes', async t => {
  const dir = await temporary(t); const url = 'https://hub.example';
  await mkdir(resolve(dir, 'node'), { mode: 0o700 });
  const config = nodeConfig(dir, url, { name: 'old-hostname', labels: ['saved'] });
  const body = { code: 'fixture', name: config.name, os: 'darwin', arch: 'arm64', labels: config.labels, providers: [], version: '0.0.1', idempotencyKey: 'original-key' };
  await writeFile(resolve(dir, 'join.secret'), JSON.stringify({ config, body }), { mode: 0o600 });
  const fetchImpl = async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), body);
    return { ok: true, json: async () => ({ machineId: 'mch_fixture', token: 'private-fixture' }) };
  };
  await assert.rejects(join(dir, url, { code: 'fixture', name: 'different', fetchImpl }), /different enrollment/);
  await join(dir, url, { code: 'fixture', fetchImpl });
  assert.deepEqual(await readJson(resolve(dir, 'node.json')), config);
  await assert.rejects(access(resolve(dir, 'join.secret')));
});

test('L14 locks record process start identity and recover a recycled live PID', async t => {
  const dir = await temporary(t);
  const release = await acquireLock(dir, 'hub');
  const lock = await readJson(resolve(dir, 'hub.lock'));
  assert.equal(typeof lock.startIdentity, 'string'); assert.ok(lock.startIdentity.length);
  await assert.rejects(acquireLock(dir, 'hub'), /already running/);
  await release();
  await writeFile(resolve(dir, 'hub.lock'), JSON.stringify({ ...lock, startIdentity: 'previous-process' }));
  const recovered = await acquireLock(dir, 'hub'); await recovered();
  await writeFile(resolve(dir, 'hub.lock'), JSON.stringify({ pid: process.pid }));
  await assert.rejects(acquireLock(dir, 'hub'), /already running/);
});

test('L15 generated hub config covers the current contract and keeps durable data together', async () => {
  const example = await readJson(new URL('../../../config/hub.example.json', import.meta.url));
  const config = hubConfig('/tmp/perpeto');
  assert.deepEqual(Object.keys(config).sort(), Object.keys(example).sort());
  for (const key of ['databasePath', 'messagingDatabasePath', 'deliveryDatabasePath', 'workflowDatabasePath', 'deliveryRepositoriesPath', 'ownerTokenPath']) assert.match(config[key], /^\.\/hub\//);
  assert.equal(config.deliveryMaxStepFailures, 5); assert.equal(config.deliveryRetryBackoffMs, 2000);
  const node = nodeConfig('/tmp/perpeto', 'https://hub.example');
  const nodeExample = await readJson(new URL('../../../config/node.example.json', import.meta.url));
  for (const key of Object.keys(nodeExample).filter(key => key !== 'enrollmentCodeFile')) assert.ok(Object.hasOwn(node, key), key);
  assert.equal(node.dataDir, './node'); assert.equal(node.credentialFile, './node/machine.json');
  assert.deepEqual(node.executorPackages, ['@perpeto/t3-executor']);
  assert.equal(node.timing.renewMs, 20000); assert.equal(node.jobs.maxLogChunkBytes, 8192);
  assert.deepEqual(node.jobs.protectedPaths, []);
});

test('L17 enrollment sends the contract Windows OS name', async t => {
  const dir = await temporary(t);
  await join(dir, 'https://hub.example', { code: 'fixture', platformName: 'win32', fetchImpl: async (_url, options) => {
    assert.equal(JSON.parse(options.body).os, 'windows');
    return { ok: true, json: async () => ({ machineId: 'mch_windows', token: 'private-fixture' }) };
  } });
});
