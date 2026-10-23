import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../src/index.js';
import { loadConfig } from '../src/config.js';
import { createStubEngine } from '../src/engine/stub-engine.js';

async function fixture(t, config = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'perpeto-storage-'));
  const configPath = join(directory, 'hub.json');
  await writeFile(configPath, JSON.stringify({ port: 0, databasePath: './hub.sqlite', messagingDatabasePath: './messaging.sqlite', ownerTokenPath: './owner.secret',
    longPollMs: 0, maintenanceIntervalMs: 10, ...config }));
  const hub = await createHub({ configPath, engine: createStubEngine() });
  const baseUrl = await hub.listen();
  const owner = (await readFile(join(directory, 'owner.secret'), 'utf8')).trim();
  t.after(async () => { await hub.close(); await rm(directory, { recursive: true, force: true }); });
  const f = {
    hub, configPath,
    async request(method, path, body, token = owner) {
      const response = await fetch(`${baseUrl}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    },
    async enroll(name) {
      const code = await f.request('POST', '/machines/enrollment-codes', {});
      return (await f.request('POST', '/nodes/enroll', { code: code.body.code, name, os: 'darwin', arch: 'arm64', providers: [], labels: [], version: 'test' }, null)).body;
    },
    heartbeat(machine, storage) {
      return f.request('POST', '/nodes/heartbeat', { status: 'online', capacity: { maxAgents: 1, maxJobs: 0 }, running: { agents: 0, jobs: 0 }, providers: [], ...(storage !== undefined ? { storage } : {}) }, machine.token);
    },
  };
  return f;
}

const GB = 1024 ** 3;
const id = n => `sti_${String(n).padStart(20, '0')}`;
const summary = (freePercent, extra = {}) => ({ scannedAt: '2026-10-23T08:00:00.000Z', state: freePercent < 5 ? 'critical' : freePercent < 15 ? 'low' : 'ok',
  disk: { totalBytes: 1000 * GB, freeBytes: freePercent * 10 * GB }, truncated: false, reclaimableBytes: 30 * GB, reclaimableByKind: { 'perpeto-worktree': 20 * GB, 'build-artifact': 10 * GB, bogus: 5 },
  advisoryBytes: 55 * GB, attentionCount: 1, staleProcesses: 2, items: 3, top: [{ id: id(1), kind: 'perpeto-worktree', path: '~/.perpeto/runtime/worktrees/demo/a', bytes: 20 * GB, reclaimable: true }], ...extra });
const inventory = (extra = {}) => ({
  scannedAt: '2026-10-23T08:00:00.000Z', durationMs: 1200, truncated: false, disk: { totalBytes: 1000 * GB, freeBytes: 400 * GB }, state: 'ok', aggressive: false,
  items: [
    { id: id(1), kind: 'perpeto-worktree', path: '~/.perpeto/runtime/worktrees/demo/a', bytes: 20 * GB, lastModifiedAt: '2026-10-20T00:00:00.000Z', owner: {},
      gitState: { branch: 'wi-branch', dirty: false, unpushedCommits: 0, merged: true }, reclaimable: true, action: 'delete', reason: 'Merged.', ownedBy: 'perpeto', secretField: 'drop me' },
    { id: id(2), kind: 'perpeto-workspace', path: '~/.perpeto/node/assignments/asg_x--a1--abcd', bytes: GB, lastModifiedAt: '2026-10-20T00:00:00.000Z', owner: { assignmentId: 'asg_x' },
      reclaimable: false, reason: 'Has uncommitted changes', attention: true },
    { id: 'not-an-id', kind: 'perpeto-worktree', path: '/x', bytes: 1 },
    { id: id(3), kind: 'global-cache', path: '~/.npm/_cacache', bytes: 5 * GB, reclaimable: false, advisory: true, hint: 'npm cache clean --force', reason: 'Shared cache.' },
  ],
  processes: [{ kind: 'dev-server', name: 'vite', pid: 101, elapsedSec: 300000, cwd: '~/gone', cwdMissing: true, reason: 'Orphaned.', hint: 'kill 101' }, { kind: 'shell', name: 'x' }],
  ...extra,
});

test('heartbeats carry storage summaries onto the machine and get the policy, branches and cleanups back', async t => {
  const f = await fixture(t, { storage: { policy: { cleanupForeignWorktrees: false, finishedWorkspaceTtlHours: 12 }, machines: { 'Mac mini': { finishedWorkspaceTtlHours: 2, aggressive: { idleArtifactTtlHours: 4 } } } } });
  const mini = await f.enroll('Mac mini');
  const linux = await f.enroll('linux-box');
  // A node without a janitor gets no storage directive.
  assert.equal((await f.heartbeat(linux)).body.storage, undefined);
  // Announcing the janitor before the first scan returns the hub policy with this machine's override.
  const pending = await f.heartbeat(mini, { pending: true });
  assert.deepEqual(pending.body.storage.policy, { cleanupForeignWorktrees: false, finishedWorkspaceTtlHours: 2, aggressive: { idleArtifactTtlHours: 4 } });
  assert.deepEqual(pending.body.storage.activeBranches, []);
  assert.equal((await f.heartbeat(linux, { pending: true })).body.storage.policy.finishedWorkspaceTtlHours, 12);

  await f.heartbeat(mini, summary(40));
  let machines = (await f.request('GET', '/machines')).body.machines;
  assert.deepEqual(machines.find(machine => machine.id === mini.machineId).storage,
    { state: 'ok', totalBytes: 1000 * GB, freeBytes: 400 * GB, freePercent: 40, reclaimableBytes: 30 * GB, attentionCount: 1, scannedAt: '2026-10-23T08:00:00.000Z' });
  const fleet = (await f.request('GET', '/storage')).body;
  const entry = fleet.machines.find(machine => machine.machineId === mini.machineId);
  assert.deepEqual(entry.storage.reclaimableByKind, { 'perpeto-worktree': 20 * GB, 'build-artifact': 10 * GB }, 'unknown kinds are dropped');
  assert.equal(fleet.totals.reclaimableBytes, 30 * GB);
  assert.deepEqual(fleet.alerts, []);
  assert.equal(fleet.policy.cleanupForeignWorktrees, false);

  // Low, then critical: storage.low once per worsening, and the fleet alerts.
  await f.heartbeat(mini, summary(10));
  await f.heartbeat(mini, summary(10));
  await f.heartbeat(mini, summary(3));
  machines = (await f.request('GET', '/machines')).body.machines;
  assert.equal(machines.find(machine => machine.id === mini.machineId).storage.state, 'critical');
  const alerts = (await f.request('GET', '/storage')).body.alerts;
  assert.deepEqual(alerts.map(alert => [alert.name, alert.state, alert.severity, alert.freePercent]), [['Mac mini', 'critical', 'critical', 3]]);
  const events = (await f.request('GET', '/events?after=0&limit=200&types=storage.low')).body.events;
  assert.deepEqual(events.map(event => [event.data.state, event.data.previous]), [['low', 'ok'], ['critical', 'low']]);
  // A malformed summary never fails liveness.
  assert.equal((await f.heartbeat(mini, { scannedAt: 'nope', disk: 'x' })).status, 200);
});

test('inventories are sanitized, annotated with owners and readable per machine; node tokens only post their own', async t => {
  const f = await fixture(t);
  const mini = await f.enroll('Mac mini');
  assert.equal((await f.request('POST', '/nodes/storage', { inventory: inventory() })).status, 403);
  assert.equal((await f.request('GET', `/machines/${mini.machineId}/storage`, undefined, mini.token)).status, 403);
  assert.equal((await f.request('POST', '/nodes/storage', { inventory: { items: 'nope' } }, mini.token)).status, 400);
  const posted = await f.request('POST', '/nodes/storage', { inventory: inventory(), summary: summary(40) }, mini.token);
  assert.deepEqual(posted.body, { accepted: true, items: 3, cleanups: [] });
  const view = (await f.request('GET', `/machines/${mini.machineId}/storage`)).body;
  assert.equal(view.inventory.items.length, 3);
  assert.equal(view.inventory.items[0].secretField, undefined);
  assert.deepEqual(view.inventory.processes.map(item => item.name), ['vite']);
  assert.equal(view.state, 'ok');
  assert.equal(view.policy.cleanupForeignWorktrees, false);
  assert.equal((await f.request('GET', '/machines/mch_missing/storage')).status, 404);
  const scanned = (await f.request('GET', '/events?after=0&limit=50&types=storage.scanned')).body.events;
  assert.equal(scanned[0].data.items, 3);
  assert.equal(scanned[0].subject.id, mini.machineId);
});

test('owner cleanups are idempotent, relayed once to the machine, and completed by its result', async t => {
  const f = await fixture(t);
  const mini = await f.enroll('Mac mini');
  await f.request('POST', '/nodes/storage', { inventory: inventory() }, mini.token);
  assert.equal((await f.request('POST', `/machines/${mini.machineId}/storage/cleanup`, { mode: 'destroy' })).status, 400);
  assert.equal((await f.request('POST', `/machines/${mini.machineId}/storage/cleanup`, { mode: 'execute', itemIds: ['../../etc'] })).status, 400);
  assert.equal((await f.request('POST', `/machines/${mini.machineId}/storage/cleanup`, { mode: 'execute', path: '/' })).status, 400);
  const body = { mode: 'execute', itemIds: [id(1)], idempotencyKey: 'clean-once' };
  const first = await f.request('POST', `/machines/${mini.machineId}/storage/cleanup`, body);
  assert.equal(first.status, 202);
  assert.equal(first.body.cleanup.status, 'pending');
  assert.equal((await f.request('POST', `/machines/${mini.machineId}/storage/cleanup`, body)).body.cleanup.id, first.body.cleanup.id);
  assert.equal((await f.request('POST', `/machines/${mini.machineId}/storage/cleanup`, { ...body, mode: 'dry-run' })).status, 409);
  const cleanupId = first.body.cleanup.id;

  // Delivered in heartbeats until the machine reports a result.
  let directive = (await f.heartbeat(mini, summary(40))).body.storage;
  assert.deepEqual(directive.cleanups, [{ id: cleanupId, mode: 'execute', itemIds: [id(1)] }]);
  assert.equal((await f.request('GET', `/machines/${mini.machineId}/storage/cleanups/${cleanupId}`)).body.cleanup.status, 'running');
  directive = (await f.heartbeat(mini, summary(40))).body.storage;
  assert.equal(directive.cleanups.length, 1);
  const result = { id: cleanupId, mode: 'execute', dryRun: false, freedBytes: 20 * GB, startedAt: '2026-10-23T08:01:00.000Z', finishedAt: '2026-10-23T08:01:02.000Z',
    actions: [{ itemId: id(1), kind: 'perpeto-worktree', path: '~/.perpeto/runtime/worktrees/demo/a', action: 'delete', bytes: 20 * GB, status: 'deleted' }, { itemId: 'x', status: 'exploded' }] };
  const reported = await f.request('POST', '/nodes/storage', { cleanups: [result] }, mini.token);
  assert.deepEqual(reported.body.cleanups, [cleanupId]);
  // A replayed result changes nothing; another machine cannot complete it.
  await f.request('POST', '/nodes/storage', { cleanups: [result] }, mini.token);
  const other = await f.enroll('other');
  await f.request('POST', '/nodes/storage', { cleanups: [{ ...result, freedBytes: 1 }] }, other.token);
  const done = (await f.request('GET', `/machines/${mini.machineId}/storage/cleanups/${cleanupId}`)).body.cleanup;
  assert.equal(done.status, 'completed');
  assert.equal(done.result.freedBytes, 20 * GB);
  assert.deepEqual(done.result.actions.map(action => action.status), ['deleted']);
  assert.equal((await f.heartbeat(mini, summary(40))).body.storage.cleanups, undefined);
  const cleaned = (await f.request('GET', '/events?after=0&limit=50&types=storage.cleaned')).body.events;
  assert.equal(cleaned.length, 1);
  assert.deepEqual(cleaned[0].data.counts, { deleted: 1 });

  // Automatic cleanups the node ran on its own are recorded as such.
  await f.request('POST', '/nodes/storage', { cleanups: [{ id: 'auto_abc', mode: 'execute', dryRun: false, freedBytes: 5, actions: [] }] }, mini.token);
  const view = (await f.request('GET', `/machines/${mini.machineId}/storage`)).body;
  assert.deepEqual(view.cleanups.map(item => [item.id, item.source]), [['auto_abc', 'auto'], [cleanupId, 'owner']]);
  assert.equal(view.lastCleanup.id, 'auto_abc');

  // Scan requests ride the heartbeat until a newer inventory arrives.
  assert.equal((await f.request('POST', `/machines/${mini.machineId}/storage/scan`, {})).status, 202);
  assert.equal((await f.heartbeat(mini, summary(40))).body.storage.scan, true);
  await new Promise(resolve => setTimeout(resolve, 5));
  await f.request('POST', '/nodes/storage', { inventory: inventory() }, mini.token);
  assert.equal((await f.heartbeat(mini, summary(40))).body.storage.scan, undefined);
  // Revoked machines take no more requests.
  await f.request('POST', `/machines/${other.machineId}/revoke`, {});
  assert.equal((await f.request('POST', `/machines/${other.machineId}/storage/cleanup`, { mode: 'dry-run' })).status, 409);
});

test('storage config validates the policy and machine overrides', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'perpeto-storage-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'hub.json');
  for (const [storage, message] of [[{ policy: { nope: true } }, /Unknown/], [{ policy: { lowFreePercent: 2, criticalFreePercent: 4 } }, /cannot exceed/],
    [{ machines: { mini: { foreignWorktreeRoots: ['relative'] } } }, /absolute/], [{ other: {} }, /policy and machines/]]) {
    await writeFile(path, JSON.stringify({ storage }));
    assert.throws(() => loadConfig(path), message);
  }
  await writeFile(path, JSON.stringify({ storage: { policy: { cleanupForeignWorktrees: true } } }));
  assert.deepEqual(loadConfig(path).storage, { policy: { cleanupForeignWorktrees: true }, machines: {} });
  await writeFile(path, JSON.stringify({}));
  assert.deepEqual(loadConfig(path).storage, { policy: {}, machines: {} });
});
