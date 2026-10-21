import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHub } from '../src/index.js';
import { createStubEngine } from '../src/engine/stub-engine.js';

const graph = { schema: 'perpeto.workflow/1', nodes: [], edges: [] };
async function fixture(t, config = {}, engine = createStubEngine()) {
  const directory = await mkdtemp(join(tmpdir(), 'perpeto-hub-'));
  const configPath = join(directory, 'hub.json');
  await writeFile(configPath, JSON.stringify({ port: 0, databasePath: './hub.sqlite', messagingDatabasePath: './messaging.sqlite', ownerTokenPath: './owner.secret', longPollMs: 0, maintenanceIntervalMs: 10, ...config }));
  let hub = await createHub({ configPath, engine }); let baseUrl = await hub.listen();
  const owner = (await readFile(join(directory, 'owner.secret'), 'utf8')).trim();
  t.after(async () => { await hub.close(); await rm(directory, { recursive: true, force: true }); });
  const fixture = {
    directory, configPath, owner, get baseUrl() { return baseUrl; },
    async restart() { await hub.close(); hub = await createHub({ configPath, engine }); baseUrl = await hub.listen(); },
    async request(method, path, body, token = owner, headers = {}) {
      const response = await fetch(`${baseUrl}/api/v1${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: response.status === 204 ? null : await response.json(), headers: response.headers };
    },
    async enroll(index = 0, metadata = {}) {
      const created = await fixture.request('POST', '/machines/enrollment-codes', {}); assert.equal(created.status, 201);
      const enrolled = await fixture.request('POST', '/nodes/enroll', { code: created.body.code, name: `machine-${index}`, os: 'linux', arch: 'x64', providers: ['codex'], labels: ['ci'], version: 'test', ...metadata }, null); assert.equal(enrolled.status, 201);
      return enrolled.body;
    },
    async run() {
      const project = await fixture.request('POST', '/projects', { name: 'Test', repo: { url: '/tmp/repo.git', defaultBranch: 'main' } }); assert.equal(project.status, 201);
      const workflow = await fixture.request('POST', `/projects/${project.body.id}/workflows`, { name: 'Build', purpose: 'build', graph }); assert.equal(workflow.status, 201);
      const run = await fixture.request('POST', `/workflows/${workflow.body.id}/runs`, {}); assert.equal(run.status, 201);
      return { project: project.body, workflow: workflow.body, run: run.body };
    },
    async seed(runId, count = 1, extra = {}) {
      const assignments = Array.from({ length: count }, (_, index) => ({ id: `asg_${index}`, workItemId: `wi_${index}`, nodeId: 'builder', role: 'builder', prompt: 'Build', harness: { provider: 'codex', model: 'test-model' }, policy: { maxSubagents: 0, allowedSubagentProviders: [], canMessage: [] }, requirements: {}, ...extra }));
      const result = await fixture.request('POST', `/runs/${runId}/inputs`, { assignments }); assert.equal(result.status, 202); return assignments;
    },
  };
  return fixture;
}
const heartbeat = { capacity: { maxAgents: 1, maxJobs: 1 }, running: { agents: 0, jobs: 0 }, providers: ['codex'], accounts: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(fn) {
  for (let attempt = 0; attempt < 100; attempt++) { const value = await fn(); if (value) return value; await sleep(10); }
  assert.fail('Condition did not become true.');
}

test('HTTP authentication boundaries, CORS, input caps and sanitized errors', async t => {
  const f = await fixture(t, { requestMaxBytes: 1024, corsOrigins: ['http://localhost:4321'] });
  assert.equal((await fetch(`${f.baseUrl}/health`)).status, 200);
  assert.equal((await f.request('GET', '/projects', undefined, null)).status, 401);
  const node = await f.enroll();
  assert.equal((await f.request('GET', '/projects', undefined, node.token)).status, 403);
  assert.equal((await f.request('GET', '/events', undefined, node.token)).status, 403);
  assert.equal((await f.request('POST', '/nodes/heartbeat', heartbeat)).status, 403);
  const cors = await f.request('GET', '/overview', undefined, f.owner, { Origin: 'http://localhost:4321' });
  assert.equal(cors.headers.get('access-control-allow-origin'), 'http://localhost:4321');
  assert.equal((await f.request('GET', '/overview', undefined, f.owner, { Origin: 'https://evil.example' })).status, 403);
  const oversized = await f.request('POST', '/projects', { name: 'x'.repeat(2000) }); assert.equal(oversized.status, 413);
  const invalid = await f.request('POST', '/projects', { name: 'test' }); assert.equal(invalid.status, 400); assert.equal(invalid.body.error.code, 'INVALID_INPUT');
  const malformed = await fetch(`${f.baseUrl}/api/v1/projects`, { method: 'POST', headers: { Authorization: `Bearer ${f.owner}`, 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400); assert.equal((await malformed.json()).error.code, 'INVALID_JSON');
  assert.equal((await stat(join(f.directory, 'owner.secret'))).mode & 0o777, 0o600);
});

test('idempotent mutations survive restart and conflicting bodies are rejected', async t => {
  const f = await fixture(t); const input = { name: 'One', repo: { url: '/repo', defaultBranch: 'main' }, idempotencyKey: 'create' };
  const first = await f.request('POST', '/projects', input); assert.equal(first.status, 201);
  const again = await f.request('POST', '/projects', { ...input, repo: { defaultBranch: 'main', url: '/repo' } }); assert.deepEqual(again.body, first.body);
  assert.equal((await f.request('POST', '/projects', { ...input, name: 'Two' })).status, 409);
  await f.restart(); assert.deepEqual((await f.request('POST', '/projects', input)).body, first.body);
  assert.equal((await f.request('GET', '/projects')).body.projects.length, 1);
  const events = (await f.request('GET', '/events')).body.events;
  assert.equal(events.filter(value => value.type === 'project.created').length, 1);
});

test('one-time expiring enrollment, retry credentials and account snapshots', async t => {
  const f = await fixture(t);
  const input = { idempotencyKey: 'code' };
  const code = await f.request('POST', '/machines/enrollment-codes', input);
  assert.deepEqual((await f.request('POST', '/machines/enrollment-codes', input)).body, code.body);
  const body = { idempotencyKey: 'enroll', code: code.body.code, name: 'machine', os: 'linux', arch: 'x64', providers: ['codex'], version: '1' };
  const node = await f.request('POST', '/nodes/enroll', body, null); assert.equal(node.status, 201);
  assert.deepEqual((await f.request('POST', '/nodes/enroll', body, null)).body, node.body);
  assert.equal((await f.request('POST', '/nodes/enroll', { ...body, idempotencyKey: 'other' }, null)).status, 401);
  const short = await f.request('POST', '/machines/enrollment-codes', { ttlMs: 1 }); await sleep(5);
  assert.equal((await f.request('POST', '/nodes/enroll', { ...body, code: short.body.code }, null)).status, 401);
  const account = { id: 'acct_one', provider: 'codex', label: 'Local', status: 'active', credentials: 'must-not-persist' };
  assert.equal((await f.request('POST', '/nodes/heartbeat', { ...heartbeat, accounts: [account] }, node.body.token)).status, 200);
  const accounts = (await f.request('GET', '/accounts')).body.accounts;
  assert.equal(accounts[0].machineId, node.body.machineId); assert.equal(accounts[0].credentials, undefined);
  const other = await f.enroll(2);
  assert.equal((await f.request('POST', '/nodes/heartbeat', { ...heartbeat, accounts: [account] }, other.token)).status, 409);
  await f.restart();
  assert.deepEqual((await f.request('POST', '/nodes/enroll', body, null)).body, node.body);
  assert.equal((await f.request('POST', '/nodes/heartbeat', heartbeat, node.body.token)).status, 200);
  assert.equal((await f.request('GET', '/accounts')).body.accounts.length, 0);
  for (const suffix of ['', '-wal']) {
    const bytes = await readFile(join(f.directory, `hub.sqlite${suffix}`)).catch(() => Buffer.alloc(0));
    assert.equal(bytes.includes(Buffer.from(node.body.token)), false); assert.equal(bytes.includes(Buffer.from(code.body.code)), false);
    assert.equal(bytes.includes(Buffer.from('must-not-persist')), false);
  }
});

test('leases enforce requirements, actual capacity, ownership and renewal', async t => {
  const f = await fixture(t); const { run } = await f.run();
  await f.seed(run.id, 2, { requirements: { os: 'linux', labels: ['ci'], providers: ['codex'] } });
  const wrong = await f.enroll(0, { os: 'darwin' });
  assert.deepEqual((await f.request('POST', '/nodes/lease', { max: 2 }, wrong.token)).body.assignments, []);
  const node = await f.enroll(1); const other = await f.enroll(2);
  const leased = await f.request('POST', '/nodes/lease', { max: 100 }, node.token); assert.equal(leased.body.assignments.length, 1);
  const work = leased.body.assignments[0]; assert.equal(work.attempt, 1);
  assert.equal((await f.request('POST', '/nodes/lease', { max: 1 }, node.token)).body.assignments.length, 0);
  assert.equal((await f.request('POST', `/assignments/${work.id}/renew`, { leaseId: work.leaseId }, other.token)).status, 409);
  assert.equal((await f.request('POST', `/assignments/${work.id}/events`, { type: 'started', leaseId: work.leaseId }, other.token)).status, 409);
  assert.equal((await f.request('GET', `/assignments/${work.id}`, undefined, other.token)).status, 409);
  assert.equal((await f.request('POST', `/assignments/${work.id}/renew`, {}, node.token)).body.error.code, 'LEASE_LOST');
  const renewal = await f.request('POST', `/assignments/${work.id}/renew`, { leaseId: work.leaseId }, node.token); assert.equal(renewal.status, 200);
  assert.ok(renewal.body.leaseExpiresAt >= work.leaseExpiresAt);
  assert.equal((await f.request('POST', `/assignments/${work.id}/events`, { leaseId: work.leaseId, type: 'started' }, node.token)).status, 200);
  assert.equal((await f.request('POST', `/assignments/${work.id}/events`, { leaseId: work.leaseId, type: 'completed', data: { outcome: 'success', summary: 'Done' } }, node.token)).status, 200);
  assert.equal((await f.request('POST', `/assignments/${work.id}/renew`, { leaseId: work.leaseId }, node.token)).status, 409);
});

test('lease expiry requeues with incremented attempt, including same-machine fencing', async t => {
  const f = await fixture(t, { leaseDurationMs: 60 }); const { run } = await f.run(); await f.seed(run.id);
  const node = await f.enroll();
  const first = (await f.request('POST', '/nodes/lease', {}, node.token)).body.assignments[0];
  await eventually(async () => (await f.request('GET', `/runs/${run.id}/assignments`)).body.assignments[0].status === 'queued');
  const second = (await f.request('POST', '/nodes/lease', {}, node.token)).body.assignments[0];
  assert.equal(second.attempt, 2); assert.notEqual(second.leaseId, first.leaseId);
  const stale = await f.request('POST', `/assignments/${first.id}/events`, { leaseId: first.leaseId, type: 'completed', data: { outcome: 'success', summary: 'Old' } }, node.token);
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'LEASE_LOST');
  assert.equal((await f.request('POST', `/assignments/${first.id}/renew`, { attempt: 1 }, node.token)).status, 409);
  assert.equal((await f.request('POST', `/assignments/${first.id}/renew`, { attempt: 2 }, node.token)).status, 200);
});

test('three missed heartbeats mark offline, heartbeat recovers and draining persists', async t => {
  const f = await fixture(t, { heartbeatIntervalMs: 30 }); const node = await f.enroll();
  await eventually(async () => (await f.request('GET', '/machines')).body.machines[0].status === 'offline');
  assert.equal((await f.request('GET', '/overview')).body.machinesOnline, 0);
  await f.request('POST', '/nodes/heartbeat', heartbeat, node.token);
  assert.equal((await f.request('GET', '/machines')).body.machines[0].status, 'online');
  await f.request('POST', `/machines/${node.machineId}/drain`, {});
  await f.request('POST', '/nodes/heartbeat', heartbeat, node.token);
  assert.equal((await f.request('GET', '/machines')).body.machines[0].status, 'draining');
});

test('usage ingestion is idempotent, grouped and filterable, overview counts real work', async t => {
  const f = await fixture(t); const { project, run } = await f.run(); await f.seed(run.id, 2); const node = await f.enroll();
  const work = (await f.request('POST', '/nodes/lease', {}, node.token)).body.assignments[0];
  const data = { provider: 'codex', model: 'test', inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 3, costUsd: 0.25 };
  const event = { idempotencyKey: 'usage-one', leaseId: work.leaseId, type: 'usage', data };
  assert.equal((await f.request('POST', `/assignments/${work.id}/events`, event, node.token)).status, 200);
  await f.request('POST', `/assignments/${work.id}/events`, event, node.token);
  for (const groupBy of ['provider', 'model', 'machine', 'day']) {
    const result = await f.request('GET', `/usage?groupBy=${groupBy}&projectId=${project.id}&runId=${run.id}`);
    assert.equal(result.body.groups.length, 1); assert.equal(result.body.totals.inputTokens, 100); assert.equal(result.body.totals.records, 1); assert.equal(result.body.totals.costUsd, 0.25);
  }
  assert.equal((await f.request('GET', '/usage?projectId=unknown')).body.groups.length, 0);
  assert.equal((await f.request('GET', '/usage?from=2999-01-01')).body.groups.length, 0);
  const overview = (await f.request('GET', '/overview')).body; assert.equal(overview.activeAgents, 1); assert.equal(overview.queuedWork, 1); assert.equal(overview.tokensToday, 133);
  assert.equal((await f.request('POST', `/assignments/${work.id}/events`, { leaseId: work.leaseId, type: 'usage', data: { ...data, inputTokens: -1 } }, node.token)).status, 400);
  await f.restart(); assert.equal((await f.request('GET', '/usage')).body.totals.inputTokens, 100);
});

test('job results bind revision and config; logs, merge queue and run snapshots persist', async t => {
  const f = await fixture(t); const { project, workflow, run } = await f.run(); const node = await f.enroll();
  const revision = 'a'.repeat(40);
  await f.request('POST', `/runs/${run.id}/inputs`, { jobs: [{ id: 'job_test', projectId: project.id, revision, configHash: 'config-v1', repo: { url: '/tmp/repo', defaultBranch: 'main' }, steps: [{ name: 'Test', run: 'true' }], requirements: { labels: ['ci'] } }] });
  const work = (await f.request('POST', '/nodes/lease', { kinds: ['job'] }, node.token)).body.jobs[0];
  await f.request('POST', '/jobs/job_test/events', { leaseId: work.leaseId, type: 'log', data: { chunk: 'hello' } }, node.token);
  assert.equal((await f.request('GET', '/jobs/job_test/log')).body.chunks[0].chunk, 'hello');
  const body = { leaseId: work.leaseId, type: 'completed', data: { revision: 'b'.repeat(40), status: 'passed' } };
  assert.equal((await f.request('POST', '/jobs/job_test/events', body, node.token)).status, 400);
  body.data.revision = revision; body.data.configHash = 'wrong';
  assert.equal((await f.request('POST', '/jobs/job_test/events', body, node.token)).status, 400);
  body.data.configHash = 'config-v1'; assert.equal((await f.request('POST', '/jobs/job_test/events', body, node.token)).status, 200);
  assert.equal((await f.request('GET', '/jobs')).body.jobs[0].status, 'passed');
  assert.deepEqual((await f.request('GET', `/projects/${project.id}/merge-queue`)).body.entries, []);
  const update = await f.request('PUT', `/workflows/${workflow.id}`, { graph, name: 'Build v2' }); assert.equal(update.body.version, 2);
  assert.equal((await f.request('GET', `/runs/${run.id}`)).body.workflowVersion, 1);
  await f.restart(); assert.equal((await f.request('GET', '/jobs/job_test')).body.revision, revision);
});

test('all owner workflow routes, graph validation, pause/resume/stop and human decision', async t => {
  const base = createStubEngine(); const seen = [];
  const engine = { ...base, applyEvent(input) { seen.push(input); return base.applyEvent(input); } };
  const f = await fixture(t, {}, engine); const { project, workflow, run } = await f.run();
  assert.equal((await f.request('PATCH', `/projects/${project.id}`, { goals: ['Build well'] })).body.goals[0], 'Build well');
  assert.equal((await f.request('GET', `/projects/${project.id}`)).status, 200);
  assert.equal((await f.request('GET', `/projects/${project.id}/workflows`)).body.workflows.length, 1);
  assert.equal((await f.request('GET', `/workflows/${workflow.id}`)).status, 200);
  assert.equal((await f.request('POST', `/workflows/${workflow.id}/validate`, { graph: {} })).body.valid, false);
  assert.equal((await f.request('PUT', `/workflows/${workflow.id}`, { graph: {} })).status, 400);
  await f.request('POST', `/runs/${run.id}/inputs`, { workItems: [{ id: 'wi_human', status: 'blocked', nodeId: 'human', title: 'Approve', body: '' }] });
  assert.equal((await f.request('GET', `/runs/${run.id}/work-items`)).body.workItems.length, 1);
  assert.equal((await f.request('POST', '/work-items/wi_human/decision', { decision: 'pass' })).status, 200);
  assert.equal(seen.at(-1).event.type, 'human.decision');
  await f.seed(run.id); const node = await f.enroll();
  assert.equal((await f.request('POST', `/runs/${run.id}/pause`, {})).body.status, 'paused');
  assert.equal((await f.request('POST', '/nodes/lease', {}, node.token)).body.assignments.length, 0);
  assert.equal((await f.request('POST', `/runs/${run.id}/inputs`, {})).status, 409);
  assert.equal((await f.request('POST', `/runs/${run.id}/resume`, {})).body.status, 'running');
  const leased = (await f.request('POST', '/nodes/lease', {}, node.token)).body.assignments[0];
  assert.equal((await f.request('POST', `/runs/${run.id}/stop`, {})).body.status, 'stopped');
  assert.equal((await f.request('GET', `/runs/${run.id}/assignments`)).body.assignments[0].status, 'cancelled');
  assert.equal((await f.request('POST', `/assignments/${leased.id}/renew`, { leaseId: leased.leaseId }, node.token)).status, 409);
});

test('messaging preserves project/channel scope, role cursors and idempotent sends', async t => {
  const f = await fixture(t); const { project, run } = await f.run(); const root = `/messaging/projects/${project.id}`;
  const channels = await f.request('GET', `${root}/channels`); assert.equal(channels.body.channels[0].id, `run-${run.id}`);
  assert.equal((await f.request('PUT', '/messaging/projects/other', { name: 'Other' })).status, 200);
  await f.request('POST', `${root}/channels`, { id: 'build', name: 'Build' });
  const path = `${root}/channels/build/messages`; const body = { senderRoleId: 'builder', recipientRoleId: 'review', body: 'Ready', idempotencyKey: 'msg-1' };
  const sent = await f.request('POST', path, body); assert.equal(sent.status, 200);
  assert.deepEqual((await f.request('POST', path, body)).body, sent.body);
  assert.equal((await f.request('POST', path, { ...body, body: 'Changed' })).status, 409);
  const page = await f.request('GET', `${path}?recipientRoleId=review`); assert.equal(page.body.messages.length, 1);
  assert.equal((await f.request('GET', `${path}?recipientRoleId=review&after=${page.body.nextCursor}`)).body.messages.length, 0);
  assert.equal((await f.request('GET', `/messaging/projects/other/channels/build/messages?after=${page.body.nextCursor}`)).status, 404);
  await f.restart(); assert.equal((await f.request('GET', path)).body.messages.length, 1);
});

test('event paging and SSE resume replay history and deliver a live committed event', async t => {
  const f = await fixture(t); await f.run();
  const page = await f.request('GET', '/events?after=0&limit=1'); assert.equal(page.body.events.length, 1);
  const all = await f.request('GET', `/events?after=${page.body.nextCursor}`); assert.ok(all.body.events.every(event => event.seq > page.body.nextCursor));
  const abort = new AbortController(); t.after(() => abort.abort());
  const response = await fetch(`${f.baseUrl}/api/v1/events`, { headers: { Authorization: `Bearer ${f.owner}`, Accept: 'text/event-stream', 'Last-Event-ID': String(page.body.nextCursor) }, signal: abort.signal });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = response.body.getReader(); let buffer = '';
  const readUntil = async predicate => {
    const deadline = AbortSignal.timeout(2000);
    while (!predicate(buffer)) {
      const next = await Promise.race([reader.read(), new Promise((_, reject) => deadline.addEventListener('abort', () => reject(new Error('SSE timeout')), { once: true }))]);
      assert.equal(next.done, false); buffer += new TextDecoder().decode(next.value);
    }
  };
  await readUntil(value => value.includes(`id: ${all.body.events.at(-1).seq}\n`));
  assert.equal(buffer.includes(`id: ${page.body.nextCursor}\n`), false);
  const created = await f.request('POST', '/projects', { name: 'Live event', repo: { url: '/repo', defaultBranch: 'main' } });
  await readUntil(value => value.includes(created.body.id));
  abort.abort(); await reader.cancel().catch(() => {});
  await f.restart();
  const after = await f.request('GET', '/events?after=0'); const ids = after.body.events.map(value => value.seq);
  assert.ok(ids.every((seq, index) => index === 0 || seq > ids[index - 1]));
});

test('long polling wakes on newly queued work and closes cleanly', async t => {
  const f = await fixture(t, { longPollMs: 1000 }); const { run } = await f.run(); const node = await f.enroll();
  const start = performance.now(); const pending = f.request('POST', '/nodes/lease', { idempotencyKey: 'waiting' }, node.token);
  await sleep(30); await f.seed(run.id); const result = await pending;
  assert.equal(result.body.assignments.length, 1); assert.ok(performance.now() - start < 1000);
  assert.deepEqual((await f.request('POST', '/nodes/lease', { idempotencyKey: 'waiting' }, node.token)).body, result.body);
});

test('missing real workflow adapter fails closed; missing owner secret is not silently replaced', async t => {
  const f = await fixture(t, {}, undefined);
  // fixture default is an explicit stub; create a separate production-default hub.
  const path = join(f.directory, 'production.json');
  await writeFile(path, JSON.stringify({ port: 0, databasePath: './prod.sqlite', messagingDatabasePath: './prod-messaging.sqlite', ownerTokenPath: './prod.secret' }));
  const hub = await createHub({ configPath: path }); const url = await hub.listen(); t.after(() => hub.close());
  const token = (await readFile(join(f.directory, 'prod.secret'), 'utf8')).trim();
  const project = await fetch(`${url}/api/v1/projects`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Test', repo: { url: '/repo', defaultBranch: 'main' } }) }).then(response => response.json());
  const workflow = await fetch(`${url}/api/v1/projects/${project.id}/workflows`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Test', graph }) });
  assert.equal(workflow.status, 503); assert.equal((await workflow.json()).error.code, 'ENGINE_UNAVAILABLE');
  await hub.close(); await rm(join(f.directory, 'prod.secret'));
  await assert.rejects(createHub({ configPath: path }), { code: 'OWNER_TOKEN_MISSING' });
  await chmod(join(f.directory, 'owner.secret'), 0o644);
  await assert.rejects(createHub({ configPath: f.configPath, engine: createStubEngine() }), /owner-only/);
  await chmod(join(f.directory, 'owner.secret'), 0o600);
});

test('load: 100 simulated machines concurrently lease and renew over real HTTP', async t => {
  const f = await fixture(t, { heartbeatIntervalMs: 60000, leaseDurationMs: 60000, maintenanceIntervalMs: 1000 });
  const { run } = await f.run(); await f.seed(run.id, 100);
  const machines = await Promise.all(Array.from({ length: 100 }, (_, index) => f.enroll(index)));
  const start = performance.now();
  const leases = await Promise.all(machines.map(node => f.request('POST', '/nodes/lease', { kinds: ['assignment'], max: 1 }, node.token)));
  const leasedAt = performance.now();
  assert.ok(leases.every(result => result.status === 200 && result.body.assignments.length === 1));
  const assignmentIds = leases.map(result => result.body.assignments[0].id); assert.equal(new Set(assignmentIds).size, 100);
  const renewals = await Promise.all(machines.map((node, index) => {
    const assignment = leases[index].body.assignments[0];
    return f.request('POST', `/assignments/${assignment.id}/renew`, { leaseId: assignment.leaseId }, node.token);
  }));
  const endedAt = performance.now(); assert.ok(renewals.every(result => result.status === 200));
  assert.equal((await f.request('GET', '/overview')).body.activeAgents, 100);
  t.diagnostic(JSON.stringify({ machines: 100, leases: 100, renewals: 100, leaseMs: +(leasedAt - start).toFixed(1), renewMs: +(endedAt - leasedAt).toFixed(1), requestsPerSecond: +(200000 / (endedAt - start)).toFixed(1) }));
});
