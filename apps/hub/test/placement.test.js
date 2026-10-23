import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../src/index.js';
import { createStubEngine } from '../src/engine/stub-engine.js';
import { assess, normalizeHealth, PLACEMENT_DEFAULTS, placementFields, repoKey, score } from '../src/placement.js';
import { loadConfig } from '../src/config.js';

const graph = { schema: 'perpeto.workflow/1', nodes: [], edges: [] };
const GB = 1024 ** 3;
const healthy = { cpus: 10, load: [1, 1, 1], memory: { totalBytes: 32 * GB, freeBytes: 8 * GB, pressure: 'normal' }, processes: 600, disk: { totalBytes: 500 * GB, freeBytes: 200 * GB }, runtime: { reachable: true } };
const overloaded = { ...healthy, load: [130, 120, 90], processes: 2700 };

async function fixture(t, config = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'perpeto-placement-'));
  const configPath = join(directory, 'hub.json');
  await writeFile(configPath, JSON.stringify({ port: 0, databasePath: './hub.sqlite', messagingDatabasePath: './messaging.sqlite', ownerTokenPath: './owner.secret', longPollMs: 0, maintenanceIntervalMs: 10, ...config }));
  const hub = await createHub({ configPath, engine: createStubEngine() }); const baseUrl = await hub.listen();
  const owner = (await readFile(join(directory, 'owner.secret'), 'utf8')).trim();
  t.after(async () => { await hub.close(); await rm(directory, { recursive: true, force: true }); });
  const f = {
    hub,
    async request(method, path, body, token = owner) {
      const response = await fetch(`${baseUrl}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    },
    async machine(name, { capacity = { maxAgents: 4, maxJobs: 1 }, health, providers = ['codex'] } = {}) {
      const created = await f.request('POST', '/machines/enrollment-codes', {});
      const enrolled = (await f.request('POST', '/nodes/enroll', { code: created.body.code, name, os: 'darwin', arch: 'arm64', providers, labels: [], version: 'test' }, null)).body;
      const machine = { ...enrolled, name, beat: async (extra = {}) => {
        const result = await f.request('POST', '/nodes/heartbeat', { status: 'online', capacity, running: { agents: 0, jobs: 0 }, providers, ...(health ? { health } : {}), ...extra }, enrolled.token);
        assert.equal(result.status, 200); return result.body;
      } };
      await machine.beat();
      return machine;
    },
    lease: (machine, max = 10) => f.request('POST', '/nodes/lease', { kinds: ['assignment'], max }, machine.token).then(result => result.body.assignments),
    async seed(count, extra = {}) {
      if (!f.runId) {
        const project = await f.request('POST', '/projects', { name: 'Fleet', repo: { url: '/tmp/fleet.git', defaultBranch: 'main' } });
        const workflow = await f.request('POST', `/projects/${project.body.id}/workflows`, { name: 'Build', purpose: 'build', graph });
        await f.request('POST', `/workflows/${workflow.body.id}/activate`, { version: workflow.body.version });
        f.runId = (await f.request('POST', `/workflows/${workflow.body.id}/runs`, {})).body.id; f.seeded = 0;
      }
      const assignments = Array.from({ length: count }, () => { const index = f.seeded++; return { id: `asg_${index}`, workItemId: `wi_${index}`, nodeId: 'builder', role: 'builder', prompt: 'Build',
        harness: { provider: 'codex', model: 'm' }, policy: { maxSubagents: 0, allowedSubagentProviders: [], canMessage: [] }, requirements: {}, ...extra }; });
      assert.equal((await f.request('POST', `/runs/${f.runId}/inputs`, { assignments })).status, 202);
    },
    machines: async () => Object.fromEntries((await f.request('GET', '/machines')).body.machines.map(machine => [machine.name, machine])),
  };
  return f;
}

const base = { id: 'mch_a', capacity: { maxAgents: 4, maxJobs: 2 }, providers: ['codex'], status: 'online', lastHeartbeatAt: new Date(0).toISOString() };
const view = (machine, held) => assess({ ...base, ...machine }, { config: { placement: PLACEMENT_DEFAULTS }, now: 1000, held, heartbeatMs: 10000 });
const at = new Date(0).toISOString();

test('effective capacity follows load, processes, memory, disk, battery, thermal state and the owner schedule', () => {
  assert.deepEqual(view({}).reasons.map(reason => reason.code), ['no-telemetry']);
  const fine = view({ health: { ...normalizeHealth(healthy, at) } });
  assert.equal(fine.status, 'online'); assert.deepEqual(fine.effective, { agents: 4, jobs: 2 }); assert.equal(fine.loadPerCore, 0.1); assert.equal(fine.accepting, true);
  const mini = view({ health: normalizeHealth(overloaded, at) });
  assert.equal(mini.status, 'overloaded'); assert.deepEqual(mini.effective, { agents: 0, jobs: 0 }); assert.equal(mini.accepting, false);
  assert.deepEqual(mini.reasons.map(reason => reason.message), ['Load 13.0 per core (limit 1.5)', '2,700 processes (limit 2,000)']);
  const busy = view({ health: normalizeHealth({ ...healthy, load: [11.5, 10, 9] }, at) });
  assert.equal(busy.status, 'limited'); assert.deepEqual(busy.effective, { agents: 2, jobs: 1 }); assert.equal(busy.reasons[0].code, 'busy');
  assert.equal(view({ health: normalizeHealth({ ...healthy, memory: { ...healthy.memory, pressure: 'critical' } }, at) }).reasons[0].code, 'memory-pressure');
  assert.equal(view({ health: normalizeHealth({ ...healthy, disk: { totalBytes: 500 * GB, freeBytes: 4 * GB } }, at) }).reasons[0].message, '4.0 GB free on the workspace disk (needs 10.0 GB)');
  assert.equal(view({ health: normalizeHealth({ ...healthy, storage: { state: 'critical' } }, at) }).status, 'overloaded');
  const battery = normalizeHealth({ ...healthy, power: { source: 'battery', percent: 42 } }, at);
  assert.equal(view({ health: battery }).reasons[0].message, 'On battery (42%); battery work is off');
  assert.equal(view({ health: battery, schedule: { allowOnBattery: true } }).status, 'online');
  assert.equal(view({ health: normalizeHealth({ ...healthy, thermal: 'serious' }, at) }).effective.agents, 2);
  const noRuntime = view({ health: normalizeHealth({ ...healthy, runtime: { reachable: false } }, at) });
  assert.deepEqual(noRuntime.effective, { agents: 0, jobs: 2 }); assert.equal(noRuntime.status, 'limited');
  assert.equal(view({ providers: [] }).reasons.find(reason => reason.code === 'no-provider').effect, 'blocks-agents');
  assert.equal(view({ schedule: { cordoned: true } }).status, 'cordoned');
  assert.equal(view({ schedule: { drain: true } }, { agents: 2, jobs: 0 }).reasons.find(reason => reason.code === 'draining').message, 'Draining: 2 agents finishing');
  assert.equal(view({ schedule: { drain: true } }).status, 'drained');
  const capped = view({ schedule: { maxAgents: 8, maxJobs: 1 } });
  assert.deepEqual(capped.configured, { agents: 4, jobs: 1 }); assert.ok(capped.reasons.some(reason => reason.code === 'capped-by-node'));
  assert.equal(view({}, { agents: 4, jobs: 2 }).reasons.find(reason => reason.code === 'full').message, 'All 4 agent slots in use; all 2 job slots in use');
  assert.equal(view({ lastHeartbeatAt: new Date(-60000).toISOString() }).status, 'offline');
  assert.equal(view({ health: { ...normalizeHealth(overloaded, at), reportedAt: new Date(-500000).toISOString() } }).status, 'online', 'stale telemetry is not trusted');
});

test('telemetry is sanitized field by field and placement settings validate', () => {
  assert.deepEqual(normalizeHealth({ cpus: -1, load: [1, 'x', 2], memory: { totalBytes: 10, freeBytes: 20, pressure: 'odd' }, thermal: 'lava', nodeVersion: 'rm -rf', storage: { state: 'low' }, secret: 'token' }, at),
    { reportedAt: at, memory: { totalBytes: 10, freeBytes: 10 }, storage: { state: 'low' } });
  assert.equal(normalizeHealth('nope', at), undefined);
  assert.throws(() => placementFields({ ...PLACEMENT_DEFAULTS, loadHardPerCore: 0.5 }));
  assert.throws(() => placementFields({ ...PLACEMENT_DEFAULTS, surprise: 1 }));
});

test('scores prefer free, cool machines, then affinity and weight', () => {
  const machine = { ...base, workspaces: { repos: [repoKey('/repo.git')] } };
  const cool = view({ health: normalizeHealth(healthy, at) });
  const plain = score(machine, cool, 'assignment', { config: { placement: PLACEMENT_DEFAULTS } });
  assert.deepEqual(plain.reasons, ['least loaded: 0 of 4 agents in use', 'load 0.1 per core']);
  const warm = score(machine, cool, 'assignment', { previous: 'mch_a', repo: repoKey('/repo.git'), config: { placement: PLACEMENT_DEFAULTS } });
  assert.equal(warm.score, plain.score + 40); assert.ok(warm.reasons.includes('warm workspace') && warm.reasons.includes('previous attempt ran here'));
  assert.ok(Math.abs(score(machine, { ...cool, weight: 2 }, 'assignment', { config: { placement: PLACEMENT_DEFAULTS } }).score - plain.score * 2) < 0.2);
});

test('PATCH /machines/:id cordons, drains, weights and overrides idempotently with events and reasons', async t => {
  const f = await fixture(t); const mini = await f.machine('mini', { health: healthy });
  assert.equal((await f.request('GET', '/machines')).body.machines[0].placement.status, 'online');
  const cordoned = await f.request('PATCH', `/machines/${mini.machineId}`, { cordoned: true, idempotencyKey: 'c1' });
  assert.equal(cordoned.status, 200); assert.equal(cordoned.body.placement.status, 'cordoned'); assert.equal(cordoned.body.schedule.cordoned, true);
  assert.deepEqual((await f.request('PATCH', `/machines/${mini.machineId}`, { cordoned: true, idempotencyKey: 'c1' })).body.schedule, cordoned.body.schedule);
  await f.request('PATCH', `/machines/${mini.machineId}`, { cordoned: true });
  await f.seed(2); assert.equal((await f.lease(mini)).length, 0, 'a cordoned machine gets nothing');
  const set = (await f.request('PATCH', `/machines/${mini.machineId}`, { cordoned: false, maxAgents: 1, labels: ['gpu'], weight: 2 })).body;
  assert.deepEqual(set.placement.configured, { agents: 1, jobs: 1 }); assert.deepEqual(set.labels, ['gpu']); assert.equal(set.placement.weight, 2);
  await mini.beat({ labels: ['reported'] });
  assert.deepEqual((await f.machines()).mini.labels, ['gpu'], 'owner labels win over heartbeat labels'); assert.deepEqual((await f.machines()).mini.reportedLabels, ['reported']);
  const leased = await f.lease(mini); assert.equal(leased.length, 1, 'capped by the override');
  assert.equal(leased[0].placement.machineId, mini.machineId); assert.ok(leased[0].placement.reasons[0].startsWith('least loaded'));
  const draining = (await f.request('PATCH', `/machines/${mini.machineId}`, { drain: true })).body;
  assert.equal(draining.placement.status, 'draining'); assert.equal(draining.status, 'online', 'the node keeps running: drain is placement-only');
  assert.equal((await f.request('PATCH', `/machines/${mini.machineId}`, { labels: null, maxAgents: null })).body.labels[0], 'reported');
  for (const body of [{}, { weight: 11 }, { cordoned: 'yes' }, { maxAgents: -1 }, { surprise: true }]) assert.equal((await f.request('PATCH', `/machines/${mini.machineId}`, body)).status, 400);
  assert.equal((await f.request('PATCH', '/machines/mch_missing', { cordoned: true })).status, 404);
  assert.equal((await f.request('PATCH', `/machines/${mini.machineId}`, { cordoned: true }, mini.token)).status, 403);
  const types = (await f.request('GET', '/events?limit=1000')).body.events.map(event => event.type);
  assert.equal(types.filter(type => type === 'machine.cordoned').length, 1); assert.equal(types.filter(type => type === 'machine.uncordoned').length, 1);
  assert.equal(types.filter(type => type === 'machine.draining').length, 1); assert.ok(types.includes('machine.updated'));
});

test('an overloaded machine gets no work and records why; recovery is a placement-changed transition', async t => {
  const f = await fixture(t); const mini = await f.machine('mini', { health: overloaded });
  await f.seed(3);
  assert.equal((await f.lease(mini)).length, 0);
  const { placement } = (await f.machines()).mini;
  assert.equal(placement.status, 'overloaded'); assert.deepEqual(placement.reasons.map(reason => reason.code), ['overloaded', 'too-many-processes']);
  await mini.beat({ health: healthy });
  assert.equal((await f.lease(mini)).length, 3);
  const changed = (await f.request('GET', '/events?types=machine.placement-changed')).body.events;
  assert.deepEqual(changed.map(event => [event.data.from, event.data.to]), [['overloaded', 'online']]);
});

test('a fresh item waits for a clearly better machine that is polling, then falls back after deferMs', async t => {
  const f = await fixture(t, { longPollMs: 2000, placement: { deferMs: 300 } });
  const mbp = await f.machine('mbp', { health: healthy }); const mini = await f.machine('mini', { health: { ...healthy, load: [9, 9, 9] } });
  // mbp long-polls; mini (busier) asks first and is skipped in favour of mbp, which is woken and takes it.
  const polling = f.lease(mbp);
  await new Promise(resolve => setTimeout(resolve, 50));
  await f.seed(1);
  const [fromMini, fromMbp] = await Promise.all([f.lease(mini), polling]);
  assert.equal(fromMini.length, 0); assert.equal(fromMbp.length, 1);
  // With nobody better polling, mini takes work right away.
  await f.seed(1); assert.equal((await f.lease(mini)).length, 1);
});
