import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHub } from '../src/index.js';
import { HubStore } from '../src/store.js';
import { createStubEngine } from '../src/engine/stub-engine.js';

const graph = { schema: 'perpeto.workflow/1', nodes: [], edges: [] };
const heartbeat = { status: 'online', capacity: { maxAgents: 2, maxJobs: 1 }, running: { agents: 0, jobs: 0 }, providers: ['codex'], accounts: [] };
const day = 86400000;

async function fixture(t, config = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'perpeto-hub-scale-'));
  const configPath = join(directory, 'hub.json');
  await writeFile(configPath, JSON.stringify({ port: 0, longPollMs: 0, maintenanceIntervalMs: 60000, ...config }));
  const handle = await createHub({ configPath, engine: createStubEngine() }); const url = await handle.listen();
  t.after(async () => { await handle.close(); await rm(directory, { recursive: true, force: true }); });
  const owner = (await readFile(join(directory, 'owner.secret'), 'utf8')).trim();
  const request = async (method, path, body, token = owner) => {
    const response = await fetch(`${url}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const f = {
    directory, request, hub: handle.hub,
    async enroll(name, labels) {
      const code = (await request('POST', '/machines/enrollment-codes', {})).body.code;
      const node = (await request('POST', '/nodes/enroll', { code, name, os: 'linux', arch: 'x64', providers: ['codex'], labels, version: 'test' })).body;
      assert.equal((await request('POST', '/nodes/heartbeat', { ...heartbeat, labels }, node.token)).status, 200);
      return node;
    },
    async run() {
      const project = (await request('POST', '/projects', { name: 'Scale', repo: { url: '/tmp/repo.git', defaultBranch: 'main' } })).body;
      const workflow = (await request('POST', `/projects/${project.id}/workflows`, { name: 'Scale', graph })).body;
      await request('POST', `/workflows/${workflow.id}/activate`, { version: 1 });
      return { project, run: (await request('POST', `/workflows/${workflow.id}/runs`, {})).body };
    },
    async seed(runId, ids, requirements = {}) {
      const assignments = ids.map(id => ({ id, workItemId: `wi_${id}`, nodeId: 'builder', role: 'builder', prompt: 'Build', harness: { provider: 'codex', model: 'm' },
        policy: { maxSubagents: 0, allowedSubagentProviders: [], canMessage: [] }, requirements }));
      assert.equal((await request('POST', `/runs/${runId}/inputs`, { assignments })).status, 202);
    },
  };
  return f;
}

test('long-poll waiters wake only for work their machine could lease, not on every heartbeat or renewal (H3)', async t => {
  const f = await fixture(t, { longPollMs: 1500 });
  const { run } = await f.run();
  const cpu = await f.enroll('cpu', ['ci']); const gpu = await f.enroll('gpu', ['ci', 'gpu']); const worker = await f.enroll('worker', ['ci', 'gpu']);
  await f.seed(run.id, ['asg_held']);
  const held = (await f.request('POST', '/nodes/lease', { kinds: ['assignment'] }, worker.token)).body.assignments[0]; assert.ok(held);
  const before = f.hub.wakes;
  const waiting = f.request('POST', '/nodes/lease', { kinds: ['assignment'] }, cpu.token);
  await new Promise(resolve => setTimeout(resolve, 50));
  // Heartbeats, renewals and work the cpu machine cannot run used to wake every waiting poll.
  for (let index = 0; index < 5; index++) {
    assert.equal((await f.request('POST', '/nodes/heartbeat', { ...heartbeat, labels: ['ci', 'gpu'], running: { agents: 1, jobs: 0 } }, worker.token)).status, 200);
    assert.equal((await f.request('POST', `/assignments/${held.id}/renew`, { attempt: held.attempt }, worker.token)).status, 200);
  }
  await f.seed(run.id, ['asg_gpu'], { labels: ['gpu'] });
  assert.equal(f.hub.wakes, before, 'nothing woke the cpu machine');
  assert.equal((await f.request('POST', '/nodes/lease', { kinds: ['assignment'] }, worker.token)).body.assignments[0].id, 'asg_gpu');
  // A gpu machine's waiting poll is woken by matching work at once.
  const gpuPoll = f.request('POST', '/nodes/lease', { kinds: ['assignment'] }, gpu.token);
  const started = performance.now();
  await new Promise(resolve => setTimeout(resolve, 50));
  await f.seed(run.id, ['asg_gpu_2'], { labels: ['gpu'] });
  const leased = await gpuPoll;
  assert.ok(leased.body.assignments.length >= 1); assert.ok(performance.now() - started < 1000, 'woken before its deadline');
  assert.deepEqual((await waiting).body.assignments, [], 'the cpu poll ran to its deadline');
  const events = (await f.request('GET', '/events?limit=1000')).body.events;
  assert.equal(events.filter(event => ['machine.heartbeat', 'assignment.renewed'].includes(event.type)).length, 0, 'heartbeats and renewals write no events');
});

test('a slot freed on a full machine wakes only that machine', async t => {
  const f = await fixture(t, { longPollMs: 2000 });
  const { run } = await f.run(); const node = await f.enroll('full', ['ci']); const other = await f.enroll('other', ['ci']);
  await f.seed(run.id, ['asg_a', 'asg_b', 'asg_c']);
  const first = (await f.request('POST', '/nodes/lease', { kinds: ['assignment'], max: 2 }, node.token)).body.assignments;
  assert.equal(first.length, 2);
  const otherWork = (await f.request('POST', '/nodes/lease', { kinds: ['assignment'] }, other.token)).body.assignments[0]; assert.ok(otherWork);
  const poll = f.request('POST', '/nodes/lease', { kinds: ['assignment'] }, node.token);
  await new Promise(resolve => setTimeout(resolve, 50));
  await f.seed(run.id, ['asg_d']);
  // The machine is full, so new work alone does not wake it; finishing one of its leases does.
  const started = performance.now();
  assert.equal((await f.request('POST', `/assignments/${first[0].id}/events`, { attempt: first[0].attempt, type: 'completed', data: { outcome: 'success', summary: 'Done' } }, node.token)).status, 200);
  const next = await poll;
  assert.equal(next.body.assignments.length, 1); assert.ok(performance.now() - started < 1000);
});

test('retention archives finished work and events, rolls usage up hourly and keeps usage, listings and lookups correct (M14)', async t => {
  const f = await fixture(t);
  const { project, run } = await f.run(); const node = await f.enroll('worker', ['ci']);
  await f.seed(run.id, ['asg_done', 'asg_failed', 'asg_open']);
  const leased = (await f.request('POST', '/nodes/lease', { kinds: ['assignment'], max: 2 }, node.token)).body.assignments;
  for (const [index, assignment] of leased.entries()) {
    for (const [provider, input] of [['codex', 100], ['claudeAgent', 30]]) {
      assert.equal((await f.request('POST', `/assignments/${assignment.id}/events`, { attempt: assignment.attempt, type: 'usage',
        data: { provider, model: 'm', inputTokens: input, outputTokens: 10, cacheReadTokens: 1, cacheWriteTokens: 2, costUsd: 0.5 } }, node.token)).status, 200);
    }
    const outcome = index === 0 ? 'success' : 'failure';
    assert.equal((await f.request('POST', `/assignments/${assignment.id}/events`, { attempt: assignment.attempt, type: outcome === 'success' ? 'completed' : 'failed', data: { outcome, summary: 'Done' } }, node.token)).status, 200);
  }
  const usage = async query => (await f.request('GET', `/usage?${query}`)).body;
  const views = ['groupBy=provider', 'groupBy=day', 'groupBy=machine', `groupBy=model&projectId=${project.id}&runId=${run.id}`, 'groupBy=provider&provider=codex'];
  const before = await Promise.all(views.map(usage));
  const overview = (await f.request('GET', '/overview')).body;
  const eventsBefore = (await f.request('GET', '/events?limit=1000')).body.events.length;
  assert.ok(eventsBefore > 0); assert.equal(before[0].totals.records, 4); assert.equal(before[0].totals.inputTokens, 260);

  assert.equal((await f.request('POST', '/nodes/heartbeat', { ...heartbeat, labels: ['ci'], idempotencyKey: 'beat-1' }, node.token)).status, 200);
  // Sweep as if 40 days had passed: past every default retention.
  const counts = await f.hub.store.transaction(() => f.hub.sweep(Date.now() + 40 * day));
  assert.deepEqual({ ...counts, events: counts.events > 0 }, { assignments: 2, jobs: 0, events: true, usage: 4, idempotency: counts.idempotency });
  assert.ok(counts.idempotency > 0, 'idempotency records expire');
  const db = new DatabaseSync(join(f.directory, 'hub.sqlite'), { readOnly: true }); t.after(() => db.close());
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM entities WHERE kind='assignment'").get().count, 1, 'only open work stays hot');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM usage').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM events').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM archived_events').get().count, eventsBefore);
  assert.deepEqual(await Promise.all(views.map(usage)), before, 'rollups keep usage totals and groupings');
  assert.deepEqual((await f.request('GET', '/overview')).body, overview);
  assert.equal((await f.request('GET', '/assignments/asg_done')).body.status, 'succeeded', 'archived work is still found by id');
  assert.deepEqual((await f.request('GET', `/runs/${run.id}/assignments`)).body.assignments.map(value => value.id).sort(), ['asg_done', 'asg_failed', 'asg_open']);
  assert.equal((await f.request('GET', '/overview')).body.queuedWork, 1);
  // Archived usage keeps hour precision.
  const hour = new Date(Date.now() + 3600000).toISOString();
  assert.equal((await usage(`groupBy=provider&from=${hour}`)).totals.records, 0);
});

test('without archiving, finished work past retention is deleted; recent work and usage are untouched', async t => {
  const f = await fixture(t, { archiveFinished: false });
  const { run } = await f.run(); const node = await f.enroll('worker', ['ci']);
  await f.seed(run.id, ['asg_old']);
  const work = (await f.request('POST', '/nodes/lease', { kinds: ['assignment'] }, node.token)).body.assignments[0];
  await f.request('POST', `/assignments/${work.id}/events`, { attempt: work.attempt, type: 'completed', data: { outcome: 'success', summary: 'Done' } }, node.token);
  assert.deepEqual(await f.hub.store.transaction(() => f.hub.sweep(Date.now())), { assignments: 0, jobs: 0, events: 0, usage: 0, idempotency: 0 });
  await f.hub.store.transaction(() => f.hub.sweep(Date.now() + 8 * day));
  assert.equal((await f.request('GET', '/assignments/asg_old')).status, 404);
  const db = new DatabaseSync(join(f.directory, 'hub.sqlite'), { readOnly: true }); t.after(() => db.close());
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM archived_entities').get().count, 0);
});

test('retention configuration keeps events for the longest metrics window', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'perpeto-hub-scale-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'hub.json');
  await writeFile(configPath, JSON.stringify({ eventRetentionMs: day }));
  await assert.rejects(createHub({ configPath, engine: createStubEngine() }), /eventRetentionMs/);
});

test('schema 1 databases migrate usage, job logs and finish times into the indexed layout', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'perpeto-hub-scale-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'hub.sqlite');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE entities (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id)) STRICT;
    CREATE TABLE idempotency (scope TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(scope,key)) STRICT;
    PRAGMA user_version=1;`);
  const put = (kind, value) => old.prepare('INSERT INTO entities VALUES(?,?,?)').run(kind, value.id, JSON.stringify(value));
  put('usage', { id: 'use_1', projectId: 'prj_1', runId: 'run_1', assignmentId: 'asg_1', machineId: 'mch_1', provider: 'codex', model: 'm', inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, at: '2026-10-01T10:15:00.000Z' });
  put('job-log', { id: 'log_1', jobId: 'job_1', chunk: 'hello\n', at: '2026-10-01T10:16:00.000Z' });
  put('assignment', { id: 'asg_1', status: 'succeeded', runId: 'run_1', updatedAt: '2026-10-01T10:20:00.000Z' });
  old.prepare("INSERT INTO idempotency VALUES('scope','key','f','{}')").run();
  old.close();
  const store = new HubStore(file); t.after(() => store.close());
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.deepEqual(store.logs('job_1').map(value => value.chunk), ['hello\n']);
  assert.equal(store.usageGroups({}, { group: 'provider' })[0].inputTokens, 5);
  assert.equal(store.get('assignment', 'asg_1').finishedAt, '2026-10-01T10:20:00.000Z');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM entities WHERE kind IN ('usage','job-log')").get().count, 0);
  assert.ok(store.idempotent('scope', 'key'));
});
