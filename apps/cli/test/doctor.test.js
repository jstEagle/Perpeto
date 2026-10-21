import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { doctor } from '../src/doctor.js';
import { hubConfig, nodeConfig } from '../src/config.js';

test('doctor checks current configs, missing delivery settings and obsolete package/path references with fixes', async t => {
  const dir = await mkdtemp(resolve(tmpdir(), 'pcli-doctor-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const hub = hubConfig(dir); const node = nodeConfig(dir, 'https://hub.example');
  await writeFile(resolve(dir, 'hub.json'), JSON.stringify(hub));
  await writeFile(resolve(dir, 'node.json'), JSON.stringify(node));
  const options = { root: dir, run: () => ({ status: 0 }), fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'ok' }) }),
    binPath: resolve(dir, 'bin/perpeto'), home: dir };
  let checks = await doctor(dir, options);
  for (const role of ['hub', 'node']) assert.equal(checks.find(c => c.name === `${role} config`).status, 'ok');
  delete hub.deliveryDatabasePath; delete hub.workflowDatabasePath; delete hub.deliveryMaxStepFailures;
  hub.deliveryRetryBackoffMs = 0;
  node.executorPackages = ['@perpeto/factory-t3']; node.runtime.repoRoot = '/old/packages/perpeto-cli';
  node.jobs.maxLogChunkBytes = 0; delete node.timing.backoffMinMs;
  await writeFile(resolve(dir, 'hub.json'), JSON.stringify(hub));
  await writeFile(resolve(dir, 'node.json'), JSON.stringify(node));
  await mkdir(resolve(dir, 'bin')); await symlink('/old/packages/perpeto-cli/bin/perpeto.js', options.binPath);
  await mkdir(resolve(dir, '.config/systemd/user'), { recursive: true });
  await writeFile(resolve(dir, '.config/systemd/user/perpeto-node.service'), 'ExecStart=/old/packages/perpeto-cli/bin/perpeto.js');
  checks = await doctor(dir, options);
  assert.equal(checks.find(c => c.name === 'hub config').status, 'fail');
  assert.equal(checks.find(c => c.name === 'node config').status, 'fail');
  const text = JSON.stringify(checks);
  for (const key of ['deliveryDatabasePath', 'workflowDatabasePath', 'deliveryMaxStepFailures', 'deliveryRetryBackoffMs', 'timing.backoffMinMs']) assert.ok(text.includes(key), key);
  for (const fix of ['@perpeto/t3-executor', 'apps/cli', 'reinstall', './hub/delivery.sqlite']) assert.ok(text.includes(fix), fix);
  assert.ok(checks.filter(c => c.status === 'warn').length >= 3);
});

test('doctor warns about misplaced durable paths without disclosing raw config values', async t => {
  const dir = await mkdtemp(resolve(tmpdir(), 'pcli-paths-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const hub = hubConfig(dir); hub.deliveryDatabasePath = '../delivery.sqlite';
  const node = nodeConfig(dir, 'https://hub.example'); node.jobs.protectedPaths = ['private-value/packages/factory-node'];
  await writeFile(resolve(dir, 'hub.json'), JSON.stringify(hub));
  await writeFile(resolve(dir, 'node.json'), JSON.stringify(node));
  const checks = await doctor(dir, { root: dir, home: dir, run: () => ({ status: 0 }), fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'ok' }) }) });
  assert.ok(checks.some(c => c.status === 'warn' && c.detail.includes('deliveryDatabasePath') && c.detail.includes('./hub/delivery.sqlite')));
  assert.ok(!JSON.stringify(checks).includes('private-value'));
});
