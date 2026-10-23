import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '@perpeto/hub';
import { createNode, ExecutorRegistry } from '@perpeto/node';
import { eventually } from './support.js';

const GB = 1024 ** 3;
const healthy = () => ({ cpus: 10, load: [0.5, 0.5, 0.5], memory: { totalBytes: 32 * GB, freeBytes: 16 * GB, pressure: 'normal' }, processes: 500, disk: { totalBytes: 500 * GB, freeBytes: 300 * GB } });
const overloaded = () => ({ ...healthy(), load: [130, 125, 110], processes: 2700 });

function graph() {
  const node = (id, type, config = {}) => ({ id, type, label: id, position: { x: 0, y: 0 }, config });
  return { schema: 'perpeto.workflow/1', nodes: [
    node('input', 'input', { source: 'manual', docs: [] }),
    node('builder', 'agent', { harness: { provider: 'fake', model: 'test' }, prompt: 'Build', concurrency: 20, policy: { maxSubagents: 0, allowedSubagentProviders: [] }, retry: { maxAttempts: 1, backoffSec: 0 } }),
    node('output', 'output'),
  ], edges: [{ id: 'a', kind: 'flow', from: { node: 'input' }, to: { node: 'builder' } }, { id: 'b', kind: 'flow', from: { node: 'builder' }, to: { node: 'output' } }] };
}

/** Holds every assignment until the test opens the gate, recording which machine ran it. */
function holdingExecutor(name, gate) {
  const ran = [];
  return { ran, executor: { kind: `hold-${name}`, canRun: assignment => assignment.harness?.provider === 'fake',
    async run(assignment, ctx) {
      ran.push(assignment.id);
      await new Promise((resolve, reject) => { gate.waiters.push(resolve); ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true }); });
      return { outcome: 'success', summary: `Built on ${name}.` };
    } } };
}

test('three loopback nodes: work spreads, an overloaded node is skipped and a cordoned node gets nothing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perpeto-fleet-')); await chmod(root, 0o700);
  const cleanups = [];
  t.after(async () => { for (const fn of cleanups.reverse()) await fn().catch(() => {}); await rm(root, { recursive: true, force: true }); });
  const hubPath = join(root, 'hub.json');
  await writeFile(hubPath, JSON.stringify({ port: 0, databasePath: './hub/hub.sqlite', messagingDatabasePath: './hub/messaging.sqlite', deliveryDatabasePath: './hub/delivery.sqlite',
    ownerTokenPath: './hub/owner.secret', heartbeatIntervalMs: 1000, leaseDurationMs: 15000, longPollMs: 2000, maintenanceIntervalMs: 50 }));
  const hub = await createHub({ configPath: hubPath }); const url = await hub.listen(); cleanups.push(() => hub.close());
  const owner = (await readFile(join(root, 'hub/owner.secret'), 'utf8')).trim();
  const request = async (method, path, body) => {
    const response = await fetch(`${url}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${owner}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json(); assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(data)}`); return data;
  };

  // Three machines in their own temporary directories; each reports telemetry the test controls.
  const gate = { waiters: [] }; const machines = {};
  for (const name of ['alpha', 'bravo', 'mini']) {
    const dir = join(root, name); await mkdir(dir, { mode: 0o700 });
    await writeFile(join(dir, 'code'), (await request('POST', '/machines/enrollment-codes', {})).code, { mode: 0o600 });
    await writeFile(join(dir, 'node.json'), JSON.stringify({ hubUrl: url, name, dataDir: './data', enrollmentCodeFile: './code', labels: [], capacity: { maxAgents: 4, maxJobs: 0 },
      providers: [], fake: {}, executorPackages: [], accounts: {}, tokenRotationMs: 0,
      timing: { heartbeatMs: 100, renewMs: 1000, requestMs: 5000, pollIdleMs: 20, backoffMinMs: 20, backoffMaxMs: 200 } }));
    const machine = { name, health: name === 'mini' ? overloaded() : healthy(), ...holdingExecutor(name, gate) };
    machine.node = await createNode({ configPath: join(dir, 'node.json'), registry: new ExecutorRegistry().register(machine.executor),
      healthCollector: { collect: async () => machine.health } });
    await machine.node.start(); cleanups.push(() => machine.node.stop({ drain: false }));
    machine.id = machine.node.status.machineId; machines[name] = machine;
  }
  const view = async () => Object.fromEntries((await request('GET', '/machines')).machines.map(machine => [machine.name, machine]));
  await eventually(async () => (await view()).mini?.placement.status === 'overloaded', { message: 'mini never reported its load' });
  assert.deepEqual((await view()).mini.placement.reasons.map(reason => reason.message), ['Load 13.0 per core (limit 1.5)', '2,700 processes (limit 2,000)']);

  const project = await request('POST', '/projects', { name: 'Fleet', repo: { url: join(root, 'unused.git'), defaultBranch: 'main' } });
  const workflow = await request('POST', `/projects/${project.id}/workflows`, { name: 'Fleet', graph: graph() });
  await request('POST', `/workflows/${workflow.id}/activate`, { version: 1 });
  const start = count => request('POST', `/workflows/${workflow.id}/runs`, { input: { items: Array.from({ length: count }, (_, index) => ({ title: `Item ${index}` })) } });
  const leasedOn = async () => {
    const events = (await request('GET', '/events?types=assignment.leased&limit=1000')).events;
    const counts = { alpha: 0, bravo: 0, mini: 0 };
    for (const event of events) counts[Object.values(machines).find(machine => machine.id === event.data.machineId).name]++;
    return { counts, events };
  };

  // Six items: they spread over the two healthy machines and the overloaded mini gets none.
  await start(6);
  await eventually(async () => machines.alpha.ran.length + machines.bravo.ran.length === 6, { timeoutMs: 20000, message: 'six items did not start' });
  let { counts, events } = await leasedOn();
  assert.equal(counts.mini, 0, 'the overloaded machine is skipped');
  assert.ok(counts.alpha >= 2 && counts.bravo >= 2, `work spreads across machines: ${JSON.stringify(counts)}`);
  assert.ok(events.every(event => event.data.placement?.reasons?.[0]?.startsWith('least loaded')), 'each lease records why it went there');
  const fleet = await view();
  assert.equal(fleet.mini.placement.accepting, false);
  assert.equal(fleet.alpha.placement.held.agents + fleet.bravo.placement.held.agents, 6);

  // Finish that work, cordon bravo and let mini recover: new work goes to alpha and mini, never bravo.
  await request('PATCH', `/machines/${machines.bravo.id}`, { cordoned: true, idempotencyKey: 'cordon-bravo' });
  machines.mini.health = healthy();
  for (const release of gate.waiters.splice(0)) release();
  await eventually(async () => (await view()).mini.placement.status === 'online' && (await view()).alpha.placement.held.agents === 0, { timeoutMs: 20000 });
  const before = (await leasedOn()).counts;
  await start(6);
  await eventually(async () => machines.alpha.ran.length + machines.bravo.ran.length + machines.mini.ran.length === 12, { timeoutMs: 20000, message: 'the second batch did not start' });
  counts = (await leasedOn()).counts;
  assert.equal(counts.bravo - before.bravo, 0, 'a cordoned machine gets nothing');
  assert.ok(counts.mini - before.mini >= 2 && counts.alpha - before.alpha >= 2, `recovered mini shares the work: ${JSON.stringify(counts)}`);
  assert.equal((await view()).bravo.placement.status, 'cordoned');
  for (const release of gate.waiters.splice(0)) release();
});
