import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, chmod, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAccountProvider, createNode, ExecutorRegistry } from '../src/index.js';
import { addCleanup, eventually, fakeHub, nodeConfig, assignment } from './helpers.js';

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
  assert.ok(first.reservation?.id);
  await assert.rejects(provider.acquire({ provider: 'codex', assignmentId: 'asg_1', attempt: 2 }), { code: 'ACCOUNT_POOL_EXHAUSTED' },
    'an enrolled but exhausted pool must not fall back to a default login');
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


test('startup reconciles durably settled attempts while retaining another handle’s live reservation', async t => {
  const hub = await fakeHub(t);
  const { configPath, config } = await nodeConfig(t, hub, { accounts: { maxConcurrentPerAccount: 2 } });
  const accounts = createAccountProvider({ dataDir: config.dataDir, config: config.accounts });
  let completedSelection;
  const registry = new ExecutorRegistry().register({ kind: 'test-reservation', canRun: () => true,
    async run(item, ctx) {
      completedSelection = await ctx.accountProvider.acquire({ provider: 'codex', assignmentId: item.id, attempt: item.attempt });
      // Simulate an executor that stopped but failed to release its account reservation.
      return { outcome: 'success', summary: 'Work stopped.' };
    } });
  const first = await createNode({ configPath, registry, accountProvider: accounts });
  addCleanup(t, () => first.stop({ drain: false }));
  await first.start();
  accounts.pool.importAccount({ provider: 'codex', label: 'fixture', source: await codexSource(t), idempotencyKey: 'import' });
  hub.assignments.push(assignment('asg_settled'));
  await eventually(() => hub.events.some(e => e.type === 'completed') && first.status.running.agents === 0);
  await first.stop();
  const foreign = await accounts.acquire({ provider: 'codex', assignmentId: 'operator', attempt: 1 });
  assert.equal(accounts.pool.reservations().length, 2);
  assert.equal(JSON.parse(await readFile(join(config.dataDir, 'settled-reservations.json')))['asg_settled-1'], completedSelection.reservation.id);
  const second = await createNode({ configPath });
  addCleanup(t, () => second.stop({ drain: false }));
  await second.start();
  assert.deepEqual(accounts.pool.reservations().map(r => r.id), [foreign.reservation.id]);
  assert.ok(!accounts.pool.reservations().some(r => r.id === completedSelection.reservation.id));
  assert.deepEqual(JSON.parse(await readFile(join(config.dataDir, 'settled-reservations.json'))), {});
});

test('startup preserves uncertain crash reservations, including ones recorded in the acceptance journal', async t => {
  const hub = await fakeHub(t);
  const { configPath, config } = await nodeConfig(t, hub, { accounts: {} });
  const accounts = createAccountProvider({ dataDir: config.dataDir });
  accounts.bind({ machineId: 'mch_test' });
  accounts.pool.importAccount({ provider: 'codex', label: 'fixture', source: await codexSource(t), idempotencyKey: 'import' });
  const held = await accounts.acquire({ provider: 'codex', assignmentId: 'asg_uncertain', attempt: 1 });
  await writeFile(join(config.dataDir, 'leases.json'), JSON.stringify({ 'assignment:asg_uncertain': 1 }), { mode: 0o600 });
  const node = await createNode({ configPath });
  addCleanup(t, () => node.stop({ drain: false }));
  await node.start();
  assert.deepEqual(accounts.pool.reservations().map(r => r.id), [held.reservation.id]);
  const otherHandle = createAccountProvider({ dataDir: config.dataDir });
  otherHandle.bind({ machineId: 'mch_test' });
  assert.deepEqual(otherHandle.pool.reservations().map(r => r.id), [held.reservation.id]);
});

test('explicit node re-enrollment rebinds an idle account pool without losing private homes', async t => {
  const oldHub = await fakeHub(t, { machineId: 'mch_old' });
  const { configPath, config } = await nodeConfig(t, oldHub, { accounts: {} });
  const first = await createNode({ configPath });
  addCleanup(t, () => first.stop({ drain: false }));
  await first.start();
  const operator = createAccountProvider({ dataDir: config.dataDir });
  operator.bind({ machineId: 'mch_old' });
  const account = operator.pool.importAccount({ provider: 'codex', label: 'fixture', source: await codexSource(t), idempotencyKey: 'import' });
  await first.stop();
  const newHub = await fakeHub(t, { machineId: 'mch_new' });
  await writeFile(configPath, JSON.stringify({ ...config, hubUrl: newHub.url }));
  await unlink(join(config.dataDir, 'machine.json'));
  const second = await createNode({ configPath });
  addCleanup(t, () => second.stop({ drain: false }));
  await second.start();
  assert.equal(second.status.machineId, 'mch_new');
  const rebound = createAccountProvider({ dataDir: config.dataDir });
  rebound.bind({ machineId: 'mch_new' });
  const selected = await rebound.acquire({ provider: 'codex', assignmentId: 'new_assignment', attempt: 1 });
  assert.equal(selected.account.id, account.id);
  assert.equal(selected.account.machineId, 'mch_new');
  assert.match(selected.binding.instance.config.homePath, /accounts/);
  await assert.rejects(operator.list(), { code: 'INVALID_REGISTRY' });
});

test('re-enrollment with live reservations fails closed and resumes without exchanging the code again', async t => {
  const oldHub = await fakeHub(t, { machineId: 'mch_old' });
  const { configPath, config } = await nodeConfig(t, oldHub, { accounts: {} });
  const first = await createNode({ configPath });
  addCleanup(t, () => first.stop({ drain: false }));
  await first.start();
  await first.stop();
  const operator = createAccountProvider({ dataDir: config.dataDir });
  operator.bind({ machineId: 'mch_old' });
  operator.pool.importAccount({ provider: 'codex', label: 'fixture', source: await codexSource(t), idempotencyKey: 'import' });
  const held = await operator.acquire({ provider: 'codex', assignmentId: 'operator', attempt: 1 });
  const newHub = await fakeHub(t, { machineId: 'mch_new' });
  await writeFile(configPath, JSON.stringify({ ...config, hubUrl: newHub.url }));
  await unlink(join(config.dataDir, 'machine.json'));
  const blocked = await createNode({ configPath });
  addCleanup(t, () => blocked.stop({ drain: false }));
  await assert.rejects(blocked.start(), { code: 'ACTIVE_RESERVATIONS' });
  assert.equal(JSON.parse(await readFile(join(config.dataDir, 'machine.json'))).pendingAccountRebind, true);
  assert.deepEqual(operator.pool.reservations().map(r => r.id), [held.reservation.id]);
  await operator.release(held, { assignmentId: 'operator', attempt: 1 });
  const retry = await createNode({ configPath });
  addCleanup(t, () => retry.stop({ drain: false }));
  await retry.start();
  assert.equal(retry.status.machineId, 'mch_new');
  assert.equal(newHub.enrollments, 1);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(join(config.dataDir, 'machine.json'))), 'pendingAccountRebind'), false);
});

test('startup cannot release a reservation created by another handle after its snapshot', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'perpeto-startup-race-'));
  addCleanup(t, () => rm(dataDir, { recursive: true, force: true }));
  const accounts = createAccountProvider({ dataDir, config: { maxConcurrentPerAccount: 2 } });
  accounts.bind({ machineId: 'mch_test' });
  accounts.pool.importAccount({ provider: 'codex', label: 'fixture', source: await codexSource(t), idempotencyKey: 'import' });
  const settled = await accounts.acquire({ provider: 'codex', assignmentId: 'asg_done', attempt: 1 });
  const other = createAccountProvider({ dataDir, config: { maxConcurrentPerAccount: 2 } });
  other.bind({ machineId: 'mch_test' });
  const original = accounts.pool.reservations.bind(accounts.pool);
  let raced;
  t.mock.method(accounts.pool, 'reservations', () => {
    const snapshot = original();
    raced ??= other.pool.select({ provider: 'codex', assignmentId: 'operator-1', idempotencyKey: 'other-select' });
    return snapshot;
  });
  await accounts.prepare({ machineId: 'mch_test', settledReservations: { 'asg_done-1': settled.reservation.id } });
  const held = other.pool.reservations();
  assert.ok(!held.some(value => value.id === settled.reservation.id));
  assert.ok(held.some(value => value.id === raced.reservation.id));
});

test('a durable settlement proof cannot release a replacement token for the same attempt', async t => {
  const hub = await fakeHub(t);
  const { configPath, config } = await nodeConfig(t, hub, { accounts: {} });
  const accounts = createAccountProvider({ dataDir: config.dataDir });
  let original;
  const registry = new ExecutorRegistry().register({ kind: 'settled-token', canRun: () => true, async run(item, ctx) {
    original = await ctx.accountProvider.acquire({ provider: 'codex', assignmentId: item.id, attempt: item.attempt });
    return { outcome: 'success', summary: 'Stopped.' };
  } });
  const first = await createNode({ configPath, registry, accountProvider: accounts });
  addCleanup(t, () => first.stop({ drain: false }));
  await first.start();
  accounts.pool.importAccount({ provider: 'codex', label: 'fixture', source: await codexSource(t), idempotencyKey: 'import' });
  hub.assignments.push(assignment('asg_replaced'));
  await eventually(() => hub.events.some(e => e.type === 'completed') && first.status.running.agents === 0);
  await first.stop();
  await accounts.release(original, { assignmentId: 'asg_replaced', attempt: 1 });
  const replacement = accounts.pool.select({ provider: 'codex', assignmentId: 'asg_replaced-1', idempotencyKey: 'external-replacement' });
  const second = await createNode({ configPath });
  addCleanup(t, () => second.stop({ drain: false }));
  await second.start();
  assert.deepEqual(accounts.pool.reservations().map(r => r.id), [replacement.reservation.id]);
});

test('heartbeats carry plan and usage; hub allowances drive paced selection and relayed edits reach the pool', async t => {
  let response = {};
  const hub = await fakeHub(t, { heartbeat: () => response });
  const { configPath, config } = await nodeConfig(t, hub, { accounts: {} });
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const accountProvider = createAccountProvider({ config: {}, dataDir: config.dataDir });
  const node = await createNode({ configPath, accountProvider });
  addCleanup(t, () => node.stop({ drain: false }));
  await node.start();
  const first = accountProvider.pool.importAccount({ provider: 'codex', label: 'First', source: await codexSource(t), idempotencyKey: 'import-1' });
  const second = accountProvider.pool.importAccount({ provider: 'codex', label: 'Second', source: await codexSource(t), idempotencyKey: 'import-2' });
  const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
  accountProvider.pool.observe({ accountId: first.id, plan: 'ChatGPT Pro', idempotencyKey: 'usage-1', message: { windows: [
    { id: 'primary', kind: 'session', label: '5-hour limit', usedPercent: 30, resetsAt, windowDurationMins: 300 }] } });
  const reportsUsage = value => value.accounts?.some(account => account.id === first.id && account.usage);
  await eventually(() => hub.heartbeats.some(reportsUsage));
  const beat = hub.heartbeats.findLast(reportsUsage);
  const reported = beat.accounts.find(account => account.id === first.id);
  assert.equal(reported.plan, 'ChatGPT Pro');
  assert.deepEqual(reported.usage.windows, [{ id: 'primary', kind: 'session', label: '5-hour limit', usedPercent: 30, resetsAt, windowMins: 300 }]);
  assert.ok(!JSON.stringify(hub.heartbeats).includes('fixture-codex-secret') && !JSON.stringify(hub.heartbeats).includes(config.dataDir));

  // The plan burns the second account; selection follows it rather than least-recently-used order.
  response = { pacing: { accounts: { [first.id]: { targetAgents: 0 }, [second.id]: { targetAgents: 2 } } },
    accountUpdates: [{ id: 'aup_test', accountId: first.id, label: 'Rotation A', plan: 'ChatGPT Pro (team)' }] };
  await eventually(async () => (await accountProvider.list()).find(account => account.id === first.id).label === 'Rotation A');
  assert.equal((await accountProvider.list()).find(account => account.id === first.id).plan, 'ChatGPT Pro (team)');
  assert.equal((await accountProvider.acquire({ provider: 'codex', assignmentId: 'asg_paced', attempt: 1 })).account.id, second.id);
  assert.equal((await accountProvider.acquire({ provider: 'codex', assignmentId: 'asg_paced_2', attempt: 1 })).account.id, second.id);
  // No plan in the response: selection returns to its own policy.
  response = {};
  await eventually(async () => {
    const selection = await accountProvider.acquire({ provider: 'codex', assignmentId: `asg_free_${Date.now()}`, attempt: 1 }).catch(() => null);
    return selection?.account.id === first.id;
  });
});
