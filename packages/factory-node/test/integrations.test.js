import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRuntimeSupervisor, detectProviders, ExecutorRegistry, createFakeExecutor, loadIntegrations, loadConfig } from '../src/index.js';
import { fakeHub, nodeConfig, addCleanup } from './helpers.js';

async function temp(t) {
  const path = await mkdtemp(join(tmpdir(), 'perpeto-integration-'));
  addCleanup(t, () => rm(path, { recursive: true, force: true }));
  return path;
}
async function availablePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('runtime supervisor launches the existing launcher interface and stops only its child', async t => {
  const root = await temp(t);
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'scripts/runtime.mjs'), `
    import { createServer } from 'node:http';
    if (process.argv[2] !== 'start') process.exit(2);
    createServer((req, res) => res.end('test-runtime')).listen(${port}, '127.0.0.1');
  `);
  const runtime = createRuntimeSupervisor({ enabled: true, repoRoot: root, url, startTimeoutMs: 3000 });
  addCleanup(t, () => runtime.stop());
  assert.equal(await runtime.start(), url);
  const response = await fetch(url);
  assert.equal(await response.text(), 'test-runtime');
  await runtime.stop();
  await assert.rejects(fetch(url));
});

test('runtime supervisor refuses an occupied URL without touching the existing server', async t => {
  const server = createServer((req, res) => res.end('user-server'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  addCleanup(t, () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const runtime = createRuntimeSupervisor({ enabled: true, repoRoot: '/does-not-exist', url });
  await assert.rejects(runtime.start(), /already in use/);
  await runtime.stop();
  assert.equal(await (await fetch(url)).text(), 'user-server');
});

test('provider discovery checks executable PATH entries without invoking harnesses', async t => {
  const root = await temp(t);
  await writeFile(join(root, 'codex'), '#!/bin/sh\nexit 91\n', { mode: 0o700 });
  await writeFile(join(root, 'claude'), '#!/bin/sh\nexit 92\n', { mode: 0o600 });
  assert.deepEqual(await detectProviders({ path: root }), ['codex']);
});

test('integration factories receive runtime/accounts configuration and missing explicit modules fail', async t => {
  const root = await temp(t);
  const executorFile = join(root, 'executor.mjs');
  const accountFile = join(root, 'accounts.mjs');
  await writeFile(accountFile, 'export const createAccountProvider = ({config}) => ({marker: config.marker, async list() { return []; }});');
  await writeFile(executorFile, `export const createT3Executor = ({ runtimeUrl, accountProvider }) => ({
    kind: 'stub-t3', canRun: () => true, async run() { return { outcome: 'success', summary: runtimeUrl + accountProvider.marker }; }
  });`);
  const { registry, accountProvider } = await loadIntegrations({ accountProviderPackage: pathToFileURL(accountFile).href,
    executorPackages: [pathToFileURL(executorFile).href], accounts: { marker: 'config-value' } }, { runtimeUrl: 'runtime-url:' });
  assert.equal(accountProvider.marker, 'config-value');
  assert.equal((await registry.find({ harness: { provider: 'codex' } }, {}).run()).summary, 'runtime-url:config-value');
  await assert.rejects(loadIntegrations({ executorPackages: ['@perpeto/definitely-missing'] }), /unavailable/);
  assert.throws(() => new ExecutorRegistry().register(createFakeExecutor()).register(createFakeExecutor()), /Duplicate/);
});

test('node JSON rejects embedded credentials, remote plaintext, invalid capacity, and unbounded log chunks', async t => {
  const hub = await fakeHub(t);
  const { configPath, config } = await nodeConfig(t, hub);
  for (const patch of [{ token: 'not-allowed' }, { hubUrl: 'http://remote.example' }, { capacity: { maxAgents: -1, maxJobs: 1 } }, { jobs: { maxLogChunkBytes: 0 } }]) {
    await writeFile(configPath, JSON.stringify({ ...config, ...patch }));
    await assert.rejects(loadConfig(configPath));
  }
});
