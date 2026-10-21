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
      await fixture.request('POST', `/workflows/${workflow.body.id}/activate`, { version: workflow.body.version });
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
const heartbeat = { status: 'online', capacity: { maxAgents: 1, maxJobs: 1 }, running: { agents: 0, jobs: 0 }, providers: ['codex'], accounts: [] };
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
  assert.equal((await f.request('POST', `/assignments/${work.id}/renew`, { attempt: work.attempt }, other.token)).status, 409);
  assert.equal((await f.request('POST', `/assignments/${work.id}/events`, { type: 'started', attempt: work.attempt }, other.token)).status, 409);
  assert.equal((await f.request('GET', `/assignments/${work.id}`, undefined, other.token)).status, 409);
  assert.equal((await f.request('POST', `/assignments/${work.id}/renew`, {}, node.token)).body.error.code, 'lease_lost');
  const renewal = await f.request('POST', `/assignments/${work.id}/renew`, { attempt: work.attempt }, node.token); assert.equal(renewal.status, 200);
  assert.ok(renewal.body.leaseExpiresAt >= work.leaseExpiresAt);
  assert.equal((await f.request('POST', `/assignments/${work.id}/events`, { attempt: work.attempt, type: 'started' }, node.token)).status, 200);
  assert.equal((await f.request('POST', `/assignments/${work.id}/events`, { attempt: work.attempt, type: 'completed', data: { outcome: 'success', summary: 'Done' } }, node.token)).status, 200);
  assert.equal((await f.request('POST', `/assignments/${work.id}/renew`, { attempt: work.attempt }, node.token)).status, 409);
});

test('lease expiry requeues with incremented attempt, including same-machine fencing', async t => {
  const f = await fixture(t, { leaseDurationMs: 60 }); const { run } = await f.run(); await f.seed(run.id);
  const node = await f.enroll();
  const first = (await f.request('POST', '/nodes/lease', {}, node.token)).body.assignments[0];
  await eventually(async () => (await f.request('GET', `/runs/${run.id}/assignments`)).body.assignments[0].status === 'queued');
  const second = (await f.request('POST', '/nodes/lease', {}, node.token)).body.assignments[0];
  assert.equal(second.attempt, 2); assert.notEqual(second.attempt, first.attempt);
  const stale = await f.request('POST', `/assignments/${first.id}/events`, { attempt: first.attempt, type: 'completed', data: { outcome: 'success', summary: 'Old' } }, node.token);
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'lease_lost');
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
  const event = { idempotencyKey: 'usage-one', attempt: work.attempt, type: 'usage', data };
  assert.equal((await f.request('POST', `/assignments/${work.id}/events`, event, node.token)).status, 200);
  await f.request('POST', `/assignments/${work.id}/events`, event, node.token);
  for (const groupBy of ['provider', 'model', 'machine', 'day']) {
    const result = await f.request('GET', `/usage?groupBy=${groupBy}&projectId=${project.id}&runId=${run.id}`);
    assert.equal(result.body.groups.length, 1); assert.equal(result.body.totals.inputTokens, 100); assert.equal(result.body.totals.records, 1); assert.equal(result.body.totals.costUsd, 0.25);
  }
  assert.equal((await f.request('GET', '/usage?projectId=unknown')).body.groups.length, 0);
  assert.equal((await f.request('GET', '/usage?from=2999-01-01')).body.groups.length, 0);
  const overview = (await f.request('GET', '/overview')).body; assert.equal(overview.activeAgents, 1); assert.equal(overview.queuedWork, 1); assert.equal(overview.tokensToday, 133);
  assert.equal((await f.request('POST', `/assignments/${work.id}/events`, { attempt: work.attempt, type: 'usage', data: { ...data, inputTokens: -1 } }, node.token)).status, 400);
  await f.restart(); assert.equal((await f.request('GET', '/usage')).body.totals.inputTokens, 100);
});

test('job results bind revision and config; logs, merge queue and run snapshots persist', async t => {
  const f = await fixture(t); const { project, workflow, run } = await f.run(); const node = await f.enroll();
  const revision = 'a'.repeat(40);
  await f.request('POST', `/runs/${run.id}/inputs`, { jobs: [{ id: 'job_test', projectId: project.id, revision, configHash: 'config-v1', repo: { url: '/tmp/repo', defaultBranch: 'main' }, steps: [{ name: 'Test', run: 'true' }], requirements: { labels: ['ci'] } }] });
  const work = (await f.request('POST', '/nodes/lease', { kinds: ['job'] }, node.token)).body.jobs[0];
  await f.request('POST', '/jobs/job_test/events', { attempt: work.attempt, type: 'log', data: { chunk: 'hello' } }, node.token);
  assert.equal((await f.request('GET', '/jobs/job_test/log')).body.chunks[0].chunk, 'hello');
  const body = { attempt: work.attempt, type: 'completed', data: { revision: 'b'.repeat(40), status: 'passed' } };
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
  assert.equal((await f.request('POST', `/assignments/${leased.id}/renew`, { attempt: leased.attempt }, node.token)).status, 409);
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

test('production default validates with the real workflow engine; missing owner secret is not silently replaced', async t => {
  const f = await fixture(t, {}, undefined);
  // fixture default is an explicit stub; create a separate production-default hub.
  const path = join(f.directory, 'production.json');
  await writeFile(path, JSON.stringify({ port: 0, databasePath: './prod.sqlite', messagingDatabasePath: './prod-messaging.sqlite', ownerTokenPath: './prod.secret' }));
  const hub = await createHub({ configPath: path }); const url = await hub.listen(); t.after(() => hub.close());
  const token = (await readFile(join(f.directory, 'prod.secret'), 'utf8')).trim();
  const project = await fetch(`${url}/api/v1/projects`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Test', repo: { url: '/repo', defaultBranch: 'main' } }) }).then(response => response.json());
  const workflow = await fetch(`${url}/api/v1/projects/${project.id}/workflows`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Test', graph }) });
  assert.equal(workflow.status, 400); assert.equal((await workflow.json()).error.code, 'INVALID_WORKFLOW');
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
    return f.request('POST', `/assignments/${assignment.id}/renew`, { attempt: assignment.attempt }, node.token);
  }));
  const endedAt = performance.now(); assert.ok(renewals.every(result => result.status === 200));
  assert.equal((await f.request('GET', '/overview')).body.activeAgents, 100);
  t.diagnostic(JSON.stringify({ machines: 100, leases: 100, renewals: 100, leaseMs: +(leasedAt - start).toFixed(1), renewMs: +(endedAt - leasedAt).toFixed(1), requestsPerSecond: +(200000 / (endedAt - start)).toFixed(1) }));
});

test('workflow versions are immutable, activation selects new runs and diff calls the engine', async t => {
  const diffs = []; const engine = { ...createStubEngine(), diffGraphs(from, to) { diffs.push({ from, to }); return { added: ['new-node'] }; } };
  const f = await fixture(t, {}, engine); const { project, workflow, run } = await f.run();
  const versionsBefore = (await f.request('GET', `/workflows/${workflow.id}/versions`)).body.versions;
  const changed = { ...graph, nodes: [{ id: 'new-node', type: 'output', label: 'Done', position: { x: 0, y: 0 }, config: {} }] };
  const draft = await f.request('PUT', `/workflows/${workflow.id}`, { name: 'Changed', graph: changed, rationale: 'Add an output.' });
  assert.equal(draft.body.version, 2); assert.equal(draft.body.status, 'draft'); assert.equal(draft.body.activeVersion, 1); assert.equal(draft.body.parentVersion, 1); assert.equal(draft.body.authoredBy.kind, 'user');
  const stillOld = await f.request('POST', `/workflows/${workflow.id}/runs`, {}); assert.equal(stillOld.body.workflowVersion, 1);
  const diff = await f.request('GET', `/workflows/${workflow.id}/diff?from=1&to=2`); assert.deepEqual(diff.body, { added: ['new-node'] }); assert.deepEqual(diffs[0], { from: graph, to: changed });
  assert.equal((await f.request('POST', `/workflows/${workflow.id}/activate`, { version: 2 })).status, 200);
  const newer = await f.request('POST', `/workflows/${workflow.id}/runs`, {}); assert.equal(newer.body.workflowVersion, 2);
  assert.equal((await f.request('GET', `/runs/${run.id}`)).body.workflowVersion, 1);
  const history = (await f.request('GET', `/workflows/${workflow.id}/versions`)).body.versions;
  assert.deepEqual(history[0], versionsBefore[0]); assert.equal(history[1].status, 'draft');
  await f.request('POST', `/workflows/${workflow.id}/activate`, { version: 1 });
  assert.equal((await f.request('PUT', `/workflows/${workflow.id}`, { graph: changed })).body.version, 3);
  assert.equal((await f.request('GET', `/workflows/${workflow.id}/diff?from=99&to=1`)).status, 404);
  const other = await f.request('POST', '/projects', { name: 'Other', repo: { url: '/other', defaultBranch: 'main' } });
  assert.equal((await f.request('POST', `/projects/${other.body.id}/workflows/drafts`, { prompt: 'Improve', baseWorkflowId: workflow.id })).status, 400);
  const fresh = await f.request('POST', `/projects/${project.id}/workflows`, { name: 'Inactive', graph });
  assert.equal((await f.request('POST', `/workflows/${fresh.body.id}/runs`, {})).body.error.code, 'WORKFLOW_NOT_ACTIVE');
  await f.restart(); assert.deepEqual((await f.request('GET', `/workflows/${workflow.id}/versions`)).body.versions[0], versionsBefore[0]);
});

test('architect assignments retry invalid graphs and save valid inactive agent-authored versions', async t => {
  const prompts = []; const base = createStubEngine(); const engine = { ...base, buildArchitectPrompt(context) { prompts.push(context); return base.buildArchitectPrompt(context); } };
  const f = await fixture(t, {}, engine); const { project, workflow, run } = await f.run(); const node = await f.enroll();
  const requested = await f.request('POST', `/projects/${project.id}/workflows/drafts`, { prompt: 'Add a review gate.', baseWorkflowId: workflow.id, idempotencyKey: 'architect' });
  assert.equal(requested.status, 202); assert.equal(requested.body.role, 'workflow-architect');
  assert.deepEqual((await f.request('POST', `/projects/${project.id}/workflows/drafts`, { prompt: 'Add a review gate.', baseWorkflowId: workflow.id, idempotencyKey: 'architect' })).body, requested.body);
  let assignment = (await f.request('POST', '/nodes/lease', {}, node.token)).body.assignments[0];
  assert.equal(assignment.id, requested.body.id); assert.equal(assignment.architectAttempt, 1);
  const invalid = { attempt: assignment.attempt, type: 'completed', data: { outcome: 'success', summary: 'Proposed', graph: {}, rationale: 'Review first.' } };
  assert.equal((await f.request('POST', `/assignments/${assignment.id}/events`, invalid, node.token)).status, 200);
  assert.equal(prompts.length, 2); assert.ok(prompts[1].validationErrors.length); assert.equal(prompts[0].project.id, project.id); assert.deepEqual(prompts[0].baseGraph, graph);
  const first = await f.request('GET', `/assignments/${assignment.id}`); assert.ok(first.body.retryAssignmentId); assert.equal(first.body.status, 'failed');
  assignment = (await f.request('POST', '/nodes/lease', {}, node.token)).body.assignments[0]; assert.equal(assignment.architectAttempt, 2);
  const valid = { attempt: assignment.attempt, type: 'completed', data: { outcome: 'success', summary: 'Valid proposal', graph, rationale: 'Keep the graph simple.' } };
  assert.equal((await f.request('POST', `/assignments/${assignment.id}/events`, valid, node.token)).status, 200);
  const versions = (await f.request('GET', `/workflows/${workflow.id}/versions`)).body.versions;
  assert.equal(versions.length, 2); assert.equal(versions[1].authoredBy.assignmentId, assignment.id); assert.equal(versions[1].authoredBy.prompt, 'Add a review gate.'); assert.equal(versions[1].parentVersion, 1); assert.equal(versions[1].rationale, 'Keep the graph simple.');
  assert.equal(versions[1].status, 'draft');
  const next = await f.request('POST', `/workflows/${workflow.id}/runs`, {}); assert.equal(next.body.workflowVersion, 1);
  assert.equal((await f.request('GET', `/runs/${run.id}`)).body.workflowVersion, 1);
  await f.restart(); assert.equal((await f.request('GET', `/assignments/${assignment.id}`)).body.draftVersion, 2);
});

test('architect validation stops after three attempts and never activates an invalid workflow', async t => {
  const f = await fixture(t); const { project } = await f.run(); const node = await f.enroll();
  const draft = await f.request('POST', `/projects/${project.id}/workflows/drafts`, { prompt: 'New factory' });
  assert.equal(draft.status, 202);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const assignment = (await f.request('POST', '/nodes/lease', {}, node.token)).body.assignments[0]; assert.equal(assignment.architectAttempt, attempt);
    assert.equal((await f.request('POST', `/assignments/${assignment.id}/events`, { attempt: assignment.attempt, type: 'completed', data: { outcome: 'success', summary: 'Invalid', graph: {}, rationale: 'Try again' } }, node.token)).status, 200);
    if (attempt === 3) assert.equal((await f.request('GET', `/assignments/${assignment.id}`)).body.retryAssignmentId, undefined);
  }
  assert.equal((await f.request('POST', '/nodes/lease', {}, node.token)).body.assignments.length, 0);
  assert.equal((await f.request('GET', `/projects/${project.id}/workflows`)).body.workflows.length, 1);
});

test('run interaction events include roles and planned edges; controlled run messages emit once', async t => {
  const f = await fixture(t); const { workflow, run } = await f.run();
  const richer = { schema: graph.schema, nodes: ['builder', 'reviewer'].map(nodeId => ({ id: nodeId, type: 'agent', label: nodeId, position: { x: 0, y: 0 }, config: {} })),
    edges: [{ id: 'msg_edge', from: { node: 'builder' }, to: { node: 'reviewer' }, kind: 'messages' }, { id: 'flow_edge', from: { node: 'builder' }, to: { node: 'reviewer' }, kind: 'flow' }] };
  await f.request('PUT', `/workflows/${workflow.id}`, { graph: richer }); await f.request('POST', `/workflows/${workflow.id}/activate`, { version: 2 });
  const nextRun = (await f.request('POST', `/workflows/${workflow.id}/runs`, {})).body;
  await f.seed(nextRun.id, 1, { policy: { maxSubagents: 0, allowedSubagentProviders: [], canMessage: ['reviewer'] } }); const node = await f.enroll();
  const assignment = (await f.request('POST', '/nodes/lease', {}, node.token)).body.assignments[0];
  for (const [type, data] of [['workitem.moved', { sourceNodeId: 'builder', targetNodeId: 'reviewer' }], ['agent.delegated', { sourceNodeId: 'builder', targetNodeId: 'surprise' }], ['gate.result', { result: 'pass', nodeId: 'builder' }]]) {
    assert.equal((await f.request('POST', `/assignments/${assignment.id}/events`, { attempt: assignment.attempt, type, data }, node.token)).status, 200);
  }
  const send = { attempt: assignment.attempt, type: 'message', data: { body: 'Review this.', recipientRoleId: 'reviewer' }, idempotencyKey: 'run-message' };
  assert.equal((await f.request('POST', `/assignments/${assignment.id}/events`, send, node.token)).status, 200);
  await f.request('POST', `/assignments/${assignment.id}/events`, send, node.token);
  assert.equal((await f.request('POST', `/assignments/${assignment.id}/events`, { ...send, idempotencyKey: 'bad-message', data: { ...send.data, recipientRoleId: 'forbidden' } }, node.token)).status, 403);
  const path = `/messaging/projects/${nextRun.projectId}/channels/run-${nextRun.id}/messages`;
  const message = { senderRoleId: 'builder', recipientRoleId: 'reviewer', body: 'Owner message', idempotencyKey: 'owner-message' };
  await f.request('POST', path, message); await f.request('POST', path, message);
  assert.equal((await f.request('GET', path)).body.messages.length, 2);
  const events = (await f.request('GET', '/events?limit=1000')).body.events.filter(event => event.runId === nextRun.id);
  const moved = events.find(event => event.type === 'workitem.moved'); assert.equal(moved.data.edgeId, 'flow_edge'); assert.equal(moved.data.unplanned, false); assert.equal(moved.data.role, 'builder');
  const delegated = events.find(event => event.type === 'agent.delegated'); assert.equal(delegated.data.unplanned, true);
  const messages = events.filter(event => event.type === 'agent.messaged'); assert.equal(messages.length, 2); assert.ok(messages.every(event => event.data.edgeId === 'msg_edge' && !event.data.unplanned));
  assert.ok(events.some(event => event.type === 'assignment.state' && event.data.state === 'leased' && event.data.machineId === node.machineId));
  assert.ok(events.some(event => event.type === 'gate.result'));
  assert.equal((await f.request('GET', `/runs/${run.id}/metrics`, undefined, node.token)).status, 403);
});

test('metrics call the engine with windowed state and overlay current lease locations', async t => {
  const calls = []; const base = createStubEngine(); const engine = { ...base, computeRunMetrics(input) { calls.push(input); return { ...base.computeRunMetrics(input), bottlenecks: [{ nodeId: 'builder', reason: 'no-capacity', evidence: 'Test engine evidence', severity: 'warning' }] }; } };
  const f = await fixture(t, {}, engine); const { project, run } = await f.run(); await f.seed(run.id, 2); const node = await f.enroll();
  await f.request('POST', '/nodes/lease', {}, node.token);
  const metrics = await f.request('GET', `/runs/${run.id}/metrics?window=1h`); assert.equal(metrics.status, 200); assert.equal(metrics.body.run.activeAgents, 1);
  assert.deepEqual(metrics.body.run.machines, [{ machineId: node.machineId, activeAgents: 1, nodes: ['builder'] }]);
  assert.equal(metrics.body.bottlenecks[0].reason, 'no-capacity'); assert.equal(calls[0].windowMs, 3600000); assert.equal(calls[0].runId, run.id); assert.ok(calls[0].events.length > 0);
  const aggregate = await f.request('GET', `/projects/${project.id}/metrics?window=7d`); assert.equal(aggregate.body.run.activeAgents, 1); assert.equal(calls.at(-1).projectId, project.id); assert.equal(calls.at(-1).windowMs, 604800000);
  assert.equal((await f.request('GET', `/runs/${run.id}/metrics?window=bad`)).status, 400);
  assert.equal((await f.request('GET', '/runs/missing/metrics')).status, 404);
  await f.request('POST', `/runs/${run.id}/stop`, {});
  assert.equal((await f.request('GET', `/runs/${run.id}/metrics`)).body.run.machines.length, 0);
});

test('node wire format uses mandatory attempts, exact renew and heartbeat cancellation responses', async t => {
  const f = await fixture(t); const { run } = await f.run(); await f.seed(run.id, 1); const node = await f.enroll(); const stranger = await f.enroll(2);
  const revision = 'c'.repeat(40);
  await f.request('POST', `/runs/${run.id}/inputs`, { jobs: [{ id: 'job_cancel', revision, configHash: 'test', repo: '/tmp/repo', steps: [] }] });
  const leased = (await f.request('POST', '/nodes/lease', { kinds: ['assignment', 'job'], max: 2 }, node.token)).body;
  assert.deepEqual(Object.keys(leased).sort(), ['assignments', 'jobs']); assert.equal(leased.assignments.length, 1); assert.equal(leased.jobs.length, 1);
  const assignment = leased.assignments[0]; const job = leased.jobs[0];
  assert.equal(assignment.leaseId, undefined); assert.ok(assignment.leaseExpiresAt); assert.ok(Number.isSafeInteger(assignment.attempt));
  const renewed = await f.request('POST', `/assignments/${assignment.id}/renew`, { attempt: assignment.attempt }, node.token);
  assert.deepEqual(Object.keys(renewed.body), ['leaseExpiresAt']);
  assert.equal((await f.request('POST', `/assignments/${assignment.id}/renew`, { attempt: String(assignment.attempt) }, node.token)).status, 409);
  const draining = await f.request('POST', '/nodes/heartbeat', { ...heartbeat, status: 'draining' }, node.token);
  assert.deepEqual(draining.body, { status: 'draining', cancel: { assignments: [], jobs: [] } });
  await f.request('POST', '/nodes/heartbeat', heartbeat, node.token);
  await f.request('POST', `/runs/${run.id}/stop`, {});
  const cancelled = await f.request('POST', '/nodes/heartbeat', heartbeat, node.token);
  assert.deepEqual(cancelled.body, { status: 'online', cancel: { assignments: [assignment.id], jobs: [job.id] } });
  assert.equal((await f.request('POST', `/assignments/${assignment.id}/renew`, { attempt: assignment.attempt }, node.token)).body.error.code, 'lease_lost');
  assert.equal((await f.request('POST', `/assignments/${assignment.id}/events`, { attempt: assignment.attempt, type: 'failed', data: { outcome: 'blocked', summary: 'Cancelled' } }, stranger.token)).status, 409);
  await f.restart(); assert.equal((await f.request('POST', '/nodes/heartbeat', heartbeat, node.token)).body.cancel.jobs.length, 1);
  assert.equal((await f.request('POST', `/assignments/${assignment.id}/events`, { attempt: assignment.attempt, type: 'failed', data: { outcome: 'blocked', summary: 'Cancelled' } }, node.token)).status, 200);
  assert.equal((await f.request('POST', `/jobs/${job.id}/events`, { attempt: job.attempt, type: 'completed', data: { status: 'cancelled', revision } }, node.token)).status, 200);
  assert.deepEqual((await f.request('POST', '/nodes/heartbeat', heartbeat, node.token)).body.cancel, { assignments: [], jobs: [] });
  assert.equal((await f.request('GET', `/runs/${run.id}/assignments`)).body.assignments[0].status, 'cancelled');
});

test('owner can cancel an individual job and nodes receive only their cancellations', async t => {
  const f = await fixture(t); const { run } = await f.run(); const node = await f.enroll(); const other = await f.enroll(1);
  await f.request('POST', `/runs/${run.id}/inputs`, { jobs: [{ id: 'job_individual', revision: 'd'.repeat(64), configHash: 'hash', repo: '/tmp/repo', steps: [] }] });
  const job = (await f.request('POST', '/nodes/lease', { kinds: ['job'] }, node.token)).body.jobs[0]; assert.ok(job);
  assert.equal((await f.request('POST', `/jobs/${job.id}/cancel`, {}, node.token)).status, 403);
  assert.equal((await f.request('POST', `/jobs/${job.id}/cancel`, {})).body.status, 'cancelled');
  assert.deepEqual((await f.request('POST', '/nodes/heartbeat', heartbeat, other.token)).body.cancel.jobs, []);
  assert.deepEqual((await f.request('POST', '/nodes/heartbeat', heartbeat, node.token)).body.cancel.jobs, [job.id]);
});

test('chunked oversized requests return JSON 413 without tearing down the response', async t => {
  const f = await fixture(t, { requestMaxBytes: 128 });
  const response = await fetch(`${f.baseUrl}/api/v1/projects`, { method: 'POST', headers: { Authorization: `Bearer ${f.owner}`, 'Content-Type': 'application/json' }, duplex: 'half',
    body: (async function* () { yield '{"name":"'; yield 'x'.repeat(512); yield '"}'; })() });
  assert.equal(response.status, 413); assert.equal((await response.json()).error.code, 'REQUEST_TOO_LARGE');
  assert.equal((await f.request('GET', '/overview')).status, 200);
});

test('engine effect failure rolls back work and global events together', async t => {
  const engine = { ...createStubEngine(), applyEvent() { return { state: {}, effects: [{ type: 'assignment', value: { id: 'asg_rollback', requirements: {}, harness: { provider: 'codex' } } }, { type: 'unknown', value: {} }] }; } };
  const f = await fixture(t, {}, engine); const { run } = await f.run(); const before = (await f.request('GET', '/events?limit=1000')).body.nextCursor;
  assert.equal((await f.request('POST', `/runs/${run.id}/inputs`, {})).status, 400);
  assert.equal((await f.request('GET', `/runs/${run.id}/assignments`)).body.assignments.length, 0);
  assert.equal((await f.request('GET', `/events?after=${before}`)).body.events.length, 0);
});

test('restart requeues persisted expired leases with attempt incremented', async t => {
  const f = await fixture(t, { leaseDurationMs: 30, maintenanceIntervalMs: 60000 }); const { run } = await f.run(); await f.seed(run.id); const node = await f.enroll();
  const work = (await f.request('POST', '/nodes/lease', {}, node.token)).body.assignments[0];
  await sleep(40); await f.restart();
  const requeued = (await f.request('GET', `/runs/${run.id}/assignments`)).body.assignments[0]; assert.equal(requeued.status, 'queued'); assert.equal(requeued.attempt, work.attempt + 1);
});

test('header idempotency works for existing MessagingStore sends and all DB sidecars stay private', async t => {
  const f = await fixture(t); const { project, run } = await f.run();
  const path = `/messaging/projects/${project.id}/channels/run-${run.id}/messages`;
  const body = { senderRoleId: 'builder', recipientRoleId: 'review', body: 'Header retry' };
  const headers = { 'Idempotency-Key': 'header-message' };
  const first = await f.request('POST', path, body, f.owner, headers); assert.equal(first.status, 200);
  assert.deepEqual((await f.request('POST', path, body, f.owner, headers)).body, first.body);
  assert.equal((await f.request('GET', path)).body.messages.length, 1);
  for (const basename of ['hub.sqlite', 'messaging.sqlite']) for (const suffix of ['', '-wal', '-shm']) {
    assert.equal((await stat(join(f.directory, basename + suffix))).mode & 0o777, 0o600);
  }
});

test('CLI starts from JSON, serves liveness, shuts down, and never prints credentials', async t => {
  const { spawn } = await import('node:child_process');
  const f = await fixture(t); const configPath = join(f.directory, 'cli.json');
  await writeFile(configPath, JSON.stringify({ port: 0, databasePath: './cli.sqlite', messagingDatabasePath: './cli-messaging.sqlite', ownerTokenPath: './cli.secret' }));
  const process = spawn(globalThis.process.execPath, ['packages/factory-hub/bin/perpeto-hub.js', '--config', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errors = '';
  process.stdout.on('data', data => { output += data; }); process.stderr.on('data', data => { errors += data; });
  const exited = new Promise(resolve => process.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => { process.kill('SIGTERM'); await exited; });
  await eventually(() => /http:\/\/127\.0\.0\.1:\d+/.test(output));
  const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  assert.equal((await fetch(`${url}/health`)).status, 200);
  const token = (await readFile(join(f.directory, 'cli.secret'), 'utf8')).trim();
  process.kill('SIGTERM'); assert.equal((await exited).code, 0);
  assert.equal((output + errors).includes(token), false);
});

test('project runs are scoped, newest first, filterable by status, and durable', async t => {
  const f = await fixture(t);
  const { project, workflow, run: first } = await f.run();
  await sleep(2);
  const second = (await f.request('POST', `/workflows/${workflow.id}/runs`, {})).body;
  await f.request('POST', `/runs/${first.id}/pause`, {});
  await f.run(); // A different project's run never leaks into the list.
  await f.restart();
  const path = `/projects/${project.id}/runs`;
  assert.deepEqual((await f.request('GET', path)).body.runs.map(run => run.id), [second.id, first.id]);
  assert.deepEqual((await f.request('GET', `${path}?status=paused`)).body.runs.map(run => run.id), [first.id]);
  assert.deepEqual((await f.request('GET', `${path}?status=running`)).body.runs.map(run => run.id), [second.id]);
  assert.deepEqual((await f.request('GET', `${path}?status=completed`)).body.runs, []);
  assert.equal((await f.request('GET', `${path}?status=invalid`)).status, 400);
  assert.equal((await f.request('GET', '/projects/missing/runs')).status, 404);
  const node = await f.enroll();
  assert.equal((await f.request('GET', path, undefined, node.token)).status, 403);
});
