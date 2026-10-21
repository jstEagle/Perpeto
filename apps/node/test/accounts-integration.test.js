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
  if (first.reservation) {
    await assert.rejects(provider.acquire({ provider: 'codex', assignmentId: 'asg_1', attempt: 2 }), { code: 'ACCOUNT_POOL_EXHAUSTED' },
      'an enrolled but exhausted pool must not fall back to a default login');
  } else {
    assert.equal(await provider.acquire({ provider: 'codex', assignmentId: 'asg_1', attempt: 2 }), null, 'legacy pool compatibility');
  }
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

test('account reservation tokens and fresh renewal keys survive the node adapter unchanged', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpeto-reservation-contract-'));
  addCleanup(t, () => rm(dataDir, { recursive: true, force: true }));
  const provider = createAccountProvider({ dataDir });
  provider.bind({ machineId: 'mch_contract' });
  const calls = [];
  const reservationId = 'rsv_original';
  provider.pool.renewReservation = async input => {
    calls.push(['renew', input]);
    return { id: reservationId, assignmentId: input.assignmentId, accountId: 'acct_test', expiresAt: '2026-10-22T00:00:00.000Z' };
  };
  t.mock.method(provider.pool, 'observe', async input => { calls.push(['observe', input]); });
  t.mock.method(provider.pool, 'release', async input => { calls.push(['release', input]); return { released: true }; });
  t.mock.method(provider.pool, 'bindingFor', async (...input) => { calls.push(['bindingFor', input]); return { providerInstanceId: 'factory_acct_test' }; });
  assert.equal(typeof provider.renewReservation, 'function');
  for (const key of ['renew-tick-1', 'renew-tick-2']) {
    const receipt = await provider.renewReservation({ assignmentId: 'asg_test', attempt: 3, reservationId, idempotencyKey: key });
    assert.equal(receipt.id, reservationId);
    assert.equal(receipt.accountId, 'acct_test');
    assert.equal(receipt.expiresAt, '2026-10-22T00:00:00.000Z');
  }
  await provider.observe({ accountId: 'acct_test', reservationId, message: { status: 'ok' }, idempotencyKey: 'observe-1' });
  await provider.bindingFor('acct_test', { reservationId });
  await provider.release({ reservation: { id: reservationId } }, { assignmentId: 'asg_test', attempt: 3, reservationId, result: { outcome: 'success' } });
  assert.deepEqual(calls.slice(0, 2).map(([, input]) => input), [
    { assignmentId: 'asg_test-3', reservationId, idempotencyKey: 'renew-tick-1' },
    { assignmentId: 'asg_test-3', reservationId, idempotencyKey: 'renew-tick-2' },
  ]);
  assert.equal(calls[2][1].reservationId, reservationId);
  assert.deepEqual(calls[3][1], ['acct_test', { reservationId }]);
  assert.equal(calls[4][1].reservationId, reservationId);
  assert.deepEqual(calls[4][1].result, { outcome: 'success' });
});
