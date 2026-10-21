import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAccountProvider, createNode } from '../src/index.js';
import { addCleanup, eventually, fakeHub, nodeConfig } from './helpers.js';

// Synthetic fixture material only; no real account is read.
async function codexSource(t) {
  const homePath = await mkdtemp(join(tmpdir(), 'perpeto-codex-source-'));
  addCleanup(t, () => rm(homePath, { recursive: true, force: true }));
  await chmod(homePath, 0o700);
  await writeFile(join(homePath, 'auth.json'), JSON.stringify({ tokens: { access_token: 'fixture-codex-secret', refresh_token: 'fixture-refresh' } }), { mode: 0o600 });
  return { kind: 'provider-home', homePath };
}

test('account adapter binds after enrollment, reserves per attempt and never exposes bindings in list()', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpeto-accounts-node-'));
  addCleanup(t, () => rm(dataDir, { recursive: true, force: true }));
  const provider = createAccountProvider({ config: {}, dataDir });
  assert.deepEqual(await provider.list(), []);
  await assert.rejects(provider.acquire({ provider: 'codex', assignmentId: 'asg_1' }), /not bound/);
  provider.bind({ machineId: 'mch_one' });
  assert.throws(() => provider.bind({ machineId: 'mch_two' }), /another machine/);
  const account = provider.pool.importAccount({ provider: 'codex', label: 'Fixture', source: await codexSource(t), idempotencyKey: 'import-fixture' });

  const listed = await provider.list();
  assert.deepEqual(listed.map(({ id, machineId, provider: kind, status }) => ({ id, machineId, kind, status })), [{ id: account.id, machineId: 'mch_one', kind: 'codex', status: 'active' }]);
  assert.ok(!JSON.stringify(listed).includes('fixture-codex-secret') && !JSON.stringify(listed).includes(dataDir));

  const first = await provider.acquire({ provider: 'codex', assignmentId: 'asg_1', attempt: 1 });
  assert.equal(first.account.id, account.id); assert.equal(first.binding.providerInstanceId, `factory_${account.id}`);
  assert.deepEqual(await provider.acquire({ provider: 'codex', assignmentId: 'asg_1', attempt: 1 }), first, 'same attempt replays its reservation');
  assert.equal(await provider.acquire({ provider: 'codex', assignmentId: 'asg_1', attempt: 2 }), null, 'a newer attempt does not share the older reservation');
  assert.equal(await provider.acquire({ provider: 'fake', assignmentId: 'asg_2' }), null, 'providers without pool support fall back');
  assert.deepEqual(await provider.release(first, { assignmentId: 'asg_1', attempt: 1 }), { released: true });
  assert.equal((await provider.acquire({ provider: 'codex', assignmentId: 'asg_1', attempt: 2 })).account.id, account.id);
});

test('node heartbeats report factory-accounts snapshots once enrolled', async t => {
  const hub = await fakeHub(t);
  const { configPath, config } = await nodeConfig(t, hub, { accounts: {} });
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const node = await createNode({ configPath });
  addCleanup(t, () => node.stop({ drain: false }));
  await node.start();
  // The account pool shares the node's data directory; enroll a fixture account through an independent handle.
  const operator = createAccountProvider({ config: {}, dataDir: config.dataDir });
  operator.bind({ machineId: 'mch_test' });
  const account = operator.pool.importAccount({ provider: 'codex', label: 'Fixture', source: await codexSource(t), idempotencyKey: 'import' });
  await eventually(() => hub.heartbeats.some(beat => beat.accounts.some(value => value.id === account.id && value.machineId === 'mch_test' && value.status === 'active')));
  assert.ok(hub.heartbeats.every(beat => !JSON.stringify(beat).includes('fixture-codex-secret')));
});
