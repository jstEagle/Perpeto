import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHub } from '../src/index.js';

const harness = { provider: 'codex', model: 'test' };
const node = (id, type, config = {}) => ({ id, type, label: id, position: { x: 0, y: 0 }, config });
const flow = (from, to) => ({ id: `${from}-${to}`, kind: 'flow', from: { node: from }, to: { node: to } });
const graph = { schema: 'perpeto.workflow/1', nodes: [
  node('ideas', 'input', { source: 'manual' }), node('builder', 'agent', { harness, prompt: 'Build.' }), node('reviewer', 'agent', { harness, prompt: 'Review.' }), node('done', 'output'),
], edges: [flow('ideas', 'builder'), flow('builder', 'reviewer'), flow('reviewer', 'done')] };
const app = 'http://localhost:5180';
const remote = 'https://factory.example';

async function fixture(t, config = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'perpeto-hub-web-'));
  const configPath = join(directory, 'hub.json');
  await writeFile(configPath, JSON.stringify({ port: 0, longPollMs: 0, maintenanceIntervalMs: 60000, corsOrigins: [app, remote], ...config }));
  const handle = await createHub({ configPath }); const url = await handle.listen();
  t.after(async () => { await handle.close(); await rm(directory, { recursive: true, force: true }); });
  const owner = (await readFile(join(directory, 'owner.secret'), 'utf8')).trim();
  /** `auth` is a bearer token, `{ cookie }`, or null. */
  const request = async (method, path, { body, auth = owner, headers = {} } = {}) => {
    const response = await fetch(`${url}/api/v1${path}`, { method, headers: {
      ...(typeof auth === 'string' ? { Authorization: `Bearer ${auth}` } : auth?.cookie ? { Cookie: auth.cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  };
  return { directory, url, owner, request, hub: handle.hub };
}
async function start(f) {
  const project = (await f.request('POST', '/projects', { body: { name: 'Web', repo: { url: '/tmp/web.git', defaultBranch: 'main' } } })).body;
  const workflow = (await f.request('POST', `/projects/${project.id}/workflows`, { body: { name: 'Web', graph } })).body;
  await f.request('POST', `/workflows/${workflow.id}/activate`, { body: { version: 1 } });
  return (await f.request('POST', `/workflows/${workflow.id}/runs`, { body: { input: { items: [{ title: 'Feature' }] } } })).body;
}

test('unplanned interactions reach metrics with their endpoints, including events recorded before the fix', async t => {
  const f = await fixture(t); const run = await start(f);
  const code = (await f.request('POST', '/machines/enrollment-codes', { body: {} })).body.code;
  const machine = (await f.request('POST', '/nodes/enroll', { auth: null, body: { code, name: 'm', os: 'linux', arch: 'x64', providers: ['codex'], version: 't' } })).body;
  await f.request('POST', '/nodes/heartbeat', { auth: machine.token, body: { status: 'online', capacity: { maxAgents: 1, maxJobs: 0 }, running: { agents: 0, jobs: 0 }, providers: ['codex'] } });
  const build = (await f.request('POST', '/nodes/lease', { auth: machine.token, body: { kinds: ['assignment'] } })).body.assignments[0];
  assert.equal((await f.request('POST', `/assignments/${build.id}/events`, { auth: machine.token, body: { attempt: build.attempt, type: 'agent.delegated', data: { sourceNodeId: 'builder', targetNodeId: 'reviewer' } } })).status, 200);
  const path = `/messaging/projects/${run.projectId}/channels/run-${run.id}/messages`;
  assert.equal((await f.request('POST', path, { body: { senderRoleId: 'builder', recipientRoleId: 'reviewer', body: 'Ready?', idempotencyKey: 'm1' } })).status, 200);
  const recorded = (await f.request('GET', `/events?runId=${run.id}&limit=1000`)).body.events.filter(event => ['agent.delegated', 'agent.messaged'].includes(event.type));
  assert.equal(recorded.length, 2);
  for (const event of recorded) { assert.equal(event.data.from, 'builder'); assert.equal(event.data.to, 'reviewer'); assert.equal(event.data.sourceNodeId, 'builder'); assert.equal(event.data.unplanned, true); }
  // An interaction recorded before the hub wrote from/to still gets its endpoints.
  const db = new DatabaseSync(join(f.directory, 'hub.sqlite'));
  db.prepare('INSERT INTO events(at,type,project_id,run_id,subject,data) VALUES(?,?,?,?,?,?)').run(new Date().toISOString(), 'agent.messaged', run.projectId, run.id,
    JSON.stringify({ kind: 'assignment', id: 'msg_old' }), JSON.stringify({ sourceNodeId: 'reviewer', targetNodeId: 'builder', unplanned: true }));
  db.close();
  const edges = (await f.request('GET', `/runs/${run.id}/metrics?window=1h`)).body.edges.filter(edge => edge.unplanned);
  assert.deepEqual(edges.map(edge => [edge.edgeId, edge.from, edge.to, edge.count]).sort(), [
    ['unplanned:delegates:builder->reviewer', 'builder', 'reviewer', 1],
    ['unplanned:messages:builder->reviewer', 'builder', 'reviewer', 1],
    ['unplanned:messages:reviewer->builder', 'reviewer', 'builder', 1],
  ]);
});

test('events filter by run and page from the newest, oldest first within each page, like messaging', async t => {
  const f = await fixture(t);
  const first = await start(f); const second = await start(f);
  for (const run of [first, second]) for (const reason of ['a', 'b']) await f.request('POST', `/runs/${run.id}/pause`, { body: { reason } }).then(() => f.request('POST', `/runs/${run.id}/resume`, { body: {} }));
  const all = (await f.request('GET', '/events?limit=1000')).body.events;
  const mine = all.filter(event => event.runId === first.id);
  const filtered = (await f.request('GET', `/events?runId=${first.id}&limit=1000`)).body;
  assert.deepEqual(filtered.events.map(event => event.seq), mine.map(event => event.seq));
  assert.equal(filtered.hasMore, false);
  const latest = (await f.request('GET', '/events?latest=true&limit=3')).body;
  assert.deepEqual(latest.events.map(event => event.seq), all.slice(-3).map(event => event.seq), 'newest page, oldest first');
  assert.equal(latest.previousCursor, all.at(-3).seq); assert.equal(latest.nextCursor, all.at(-1).seq); assert.equal(latest.hasMore, true);
  const older = (await f.request('GET', `/events?before=${latest.previousCursor}&limit=3`)).body;
  assert.deepEqual(older.events.map(event => event.seq), all.slice(-6, -3).map(event => event.seq));
  const runLatest = (await f.request('GET', `/events?runId=${first.id}&latest=true&limit=2`)).body;
  assert.deepEqual(runLatest.events.map(event => event.seq), mine.slice(-2).map(event => event.seq));
  assert.equal((await f.request('GET', `/events?after=${all.at(-2).seq}`)).body.events.length, 1, 'forward paging is unchanged');
  for (const query of ['latest=true&after=1', 'before=5&after=1', 'latest=yes', 'before=0']) assert.equal((await f.request('GET', `/events?${query}`)).status, 400, query);
  const empty = (await f.request('GET', '/events?runId=run_none&latest=true')).body;
  assert.deepEqual(empty, { events: [], previousCursor: 0, nextCursor: 0, hasMore: false });
  // The event stream honours runId too.
  const abort = new AbortController(); t.after(() => abort.abort());
  const response = await fetch(`${f.url}/api/v1/events?runId=${second.id}&after=${all.at(-1).seq}`, { headers: { Authorization: `Bearer ${f.owner}`, Accept: 'text/event-stream' }, signal: abort.signal });
  await f.request('POST', `/runs/${first.id}/pause`, { body: {} }); await f.request('POST', `/runs/${second.id}/pause`, { body: {} });
  const reader = response.body.getReader(); let text = '';
  while (!text.includes('run.pause')) text += new TextDecoder().decode((await reader.read()).value);
  const streamed = text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  assert.ok(streamed.length >= 1); assert.ok(streamed.every(event => event.runId === second.id));
  abort.abort();
});

const cookieOf = response => response.headers.get('set-cookie');
const session = response => ({ cookie: cookieOf(response).split(';')[0] });

test('an owner session cookie is HttpOnly, SameSite=Strict, scoped to /api/v1, expires and logs out; bearer tokens keep working', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.request('GET', '/session')).body, { kind: 'owner', expiresAt: null, owner: { name: null, initials: null } });
  assert.equal((await f.request('GET', '/session', { auth: null })).status, 401);
  const created = await f.request('POST', '/session', { body: { idempotencyKey: 'login-1' }, headers: { Origin: app } });
  assert.equal(created.status, 201); assert.ok(Date.parse(created.body.expiresAt) > Date.now());
  const header = cookieOf(created);
  assert.match(header, /^perpeto_session=[A-Za-z0-9_-]{32,}; /);
  for (const part of ['HttpOnly', 'SameSite=Strict', 'Path=/api/v1', 'Max-Age=43200']) assert.ok(header.split('; ').includes(part), `${part} in ${header}`);
  assert.ok(!header.includes('Secure'), 'no Secure flag for a loopback http origin');
  assert.equal(created.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(created.headers.get('access-control-allow-origin'), app);
  // An idempotent retry returns the same cookie.
  assert.equal(cookieOf(await f.request('POST', '/session', { body: { idempotencyKey: 'login-1' }, headers: { Origin: app } })).split(';')[0], header.split(';')[0]);
  const auth = session(created);
  const status = await f.request('GET', '/session', { auth });
  assert.equal(status.body.kind, 'owner'); assert.equal(status.body.expiresAt, created.body.expiresAt);
  assert.equal((await f.request('GET', '/projects', { auth })).status, 200, 'the cookie works on owner routes');
  const stream = await fetch(`${f.url}/api/v1/events`, { headers: { Cookie: auth.cookie, Accept: 'text/event-stream' }, signal: AbortSignal.timeout(2000) });
  assert.equal(stream.headers.get('content-type'), 'text/event-stream'); await stream.body.cancel();
  assert.equal((await f.request('GET', '/projects')).status, 200, 'bearer tokens keep working');
  // Remote HTTPS origins get Secure.
  assert.ok(cookieOf(await f.request('POST', '/session', { body: {}, headers: { Origin: remote } })).split('; ').includes('Secure'));
  // Only the owner token creates sessions.
  assert.equal((await f.request('POST', '/session', { auth, body: {}, headers: { Origin: app } })).status, 403);
  // Logout revokes server-side and clears the cookie.
  const ended = await f.request('DELETE', '/session', { auth, headers: { Origin: app } });
  assert.equal(ended.status, 204); assert.match(cookieOf(ended), /^perpeto_session=; .*Max-Age=0/);
  assert.equal((await f.request('GET', '/session', { auth })).status, 401);
  assert.equal((await f.request('GET', '/projects', { auth })).status, 401);
  // Session tokens are stored only as hashes.
  for (const suffix of ['', '-wal']) {
    const bytes = await readFile(join(f.directory, `hub.sqlite${suffix}`)).catch(() => Buffer.alloc(0));
    assert.equal(bytes.includes(Buffer.from(auth.cookie.split('=')[1])), false);
  }
  // CORS preflights allow credentials and DELETE for configured origins only.
  const preflight = await fetch(`${f.url}/api/v1/session`, { method: 'OPTIONS', headers: { Origin: app, 'Access-Control-Request-Method': 'DELETE' } });
  assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true'); assert.match(preflight.headers.get('access-control-allow-methods'), /DELETE/);
  assert.equal((await fetch(`${f.url}/api/v1/session`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })).status, 403);
});

test('cookie-authenticated mutations require an allowed Origin and a JSON body or non-simple method', async t => {
  const f = await fixture(t);
  const auth = session(await f.request('POST', '/session', { body: {}, headers: { Origin: app } }));
  const project = { name: 'Cookie', repo: { url: '/tmp/c.git', defaultBranch: 'main' } };
  const noOrigin = await f.request('POST', '/projects', { auth, body: project });
  assert.equal(noOrigin.status, 403); assert.equal(noOrigin.body.error.code, 'CSRF_REJECTED');
  assert.equal((await f.request('POST', '/projects', { auth, body: project, headers: { Origin: 'https://evil.example' } })).status, 403);
  const simple = await fetch(`${f.url}/api/v1/runs/run_x/stop`, { method: 'POST', headers: { Cookie: auth.cookie, Origin: app, 'Content-Type': 'text/plain' } });
  assert.equal(simple.status, 403, 'a simple cross-site form post is refused');
  assert.equal((await f.request('POST', '/projects', { auth, body: project, headers: { Origin: app } })).status, 201);
  assert.equal((await f.request('POST', '/projects', { body: project })).status, 201, 'bearer mutations need no Origin');
});

test('sessions slide while used and expire when idle', async t => {
  const f = await fixture(t, { sessionTtlMs: 1500 });
  const created = await f.request('POST', '/session', { body: {}, headers: { Origin: app } });
  assert.match(cookieOf(created), /Max-Age=2(;|$)/);
  const auth = session(created);
  for (let index = 0; index < 8; index++) { await new Promise(resolve => setTimeout(resolve, 300)); assert.equal((await f.request('GET', '/projects', { auth })).status, 200, `request ${index}`); }
  const refreshed = await f.request('GET', '/session', { auth });
  assert.ok(Date.parse(refreshed.body.expiresAt) > Date.parse(created.body.expiresAt), 'activity extended the session');
  await new Promise(resolve => setTimeout(resolve, 1700));
  assert.equal((await f.request('GET', '/session', { auth })).status, 401);
});

test('machine liveness stays out of the event log: no heartbeat, renewal or log-line events, only online/offline transitions', async t => {
  const f = await fixture(t, { heartbeatIntervalMs: 200, maintenanceIntervalMs: 50 });
  const run = await start(f);
  const code = (await f.request('POST', '/machines/enrollment-codes', { body: {} })).body.code;
  const machine = (await f.request('POST', '/nodes/enroll', { auth: null, body: { code, name: 'm', os: 'linux', arch: 'x64', providers: ['codex'], version: 't' } })).body;
  const beat = () => f.request('POST', '/nodes/heartbeat', { auth: machine.token, body: { status: 'online', capacity: { maxAgents: 1, maxJobs: 1 }, running: { agents: 0, jobs: 0 }, providers: ['codex'] } });
  const work = (await (await beat(), f.request('POST', '/nodes/lease', { auth: machine.token, body: { kinds: ['assignment'] } }))).body.assignments[0];
  const before = (await f.request('GET', '/events?latest=true&limit=1')).body.nextCursor;
  for (let index = 0; index < 5; index++) {
    assert.equal((await beat()).status, 200);
    assert.equal((await f.request('POST', `/assignments/${work.id}/renew`, { auth: machine.token, body: { attempt: work.attempt } })).status, 200);
  }
  assert.deepEqual((await f.request('GET', `/events?after=${before}&exclude=`)).body.events.map(event => event.type), [], 'heartbeats and renewals write nothing');
  const listed = (await f.request('GET', '/machines')).body.machines[0];
  assert.equal(listed.status, 'online'); assert.ok(Date.now() - Date.parse(listed.lastHeartbeatAt) < 1000, 'liveness is in machine state');
  // Missing heartbeats marks the machine offline; the next heartbeat brings it back. Each transition is one event.
  const offline = Date.now() + 5000;
  while ((await f.request('GET', '/machines')).body.machines[0].status !== 'offline' && Date.now() < offline) await new Promise(resolve => setTimeout(resolve, 50));
  await beat(); await beat();
  const transitions = (await f.request('GET', `/events?after=${before}&exclude=`)).body.events.filter(event => event.type.startsWith('machine.'));
  assert.deepEqual(transitions.map(event => event.type), ['machine.offline', 'machine.online']);
  // CI output is kept with its job, not in the global log.
  await f.request('POST', `/runs/${run.id}/stop`, { body: {} });
  const sha = 'a'.repeat(40);
  const hub = f.hub; const jobRun = await start(f);
  await hub.store.transaction(async () => hub.applyEffects(hub.store.need('run', jobRun.id), { seq: 999, effects: [{ type: 'job', value: { id: 'job_logs', revision: sha, steps: [], configHash: 'h', repo: '/tmp/web.git' } }] }));
  await beat();
  const job = (await f.request('POST', '/nodes/lease', { auth: machine.token, body: { kinds: ['job'] } })).body.jobs[0];
  const mark = (await f.request('GET', '/events?latest=true&limit=1')).body.nextCursor;
  for (const chunk of ['one\n', 'two\n', 'three\n']) await f.request('POST', `/jobs/${job.id}/events`, { auth: machine.token, body: { attempt: job.attempt, type: 'log', data: { chunk } } });
  assert.equal((await f.request('POST', `/jobs/${job.id}/renew`, { auth: machine.token, body: { attempt: job.attempt } })).status, 200);
  assert.deepEqual((await f.request('GET', `/events?after=${mark}&exclude=`)).body.events, []);
  assert.deepEqual((await f.request('GET', `/jobs/${job.id}/log`)).body.chunks.map(value => value.chunk), ['one\n', 'two\n', 'three\n']);
});

test('the event log hides legacy liveness noise by default, and filters by project, type or an explicit exclude list', async t => {
  const f = await fixture(t);
  const first = await start(f); const second = await start(f);
  // A hub upgraded from before the change still holds heartbeat and renewal events.
  const db = new DatabaseSync(join(f.directory, 'hub.sqlite'));
  const insert = db.prepare('INSERT INTO events(at,type,project_id,run_id,subject,data) VALUES(?,?,?,?,?,?)');
  for (let index = 0; index < 40; index++) for (const type of ['machine.heartbeat', 'assignment.renewed', 'job.renewed', 'job.log']) {
    insert.run(new Date().toISOString(), type, null, null, JSON.stringify({ kind: 'machine', id: 'mch_old' }), '{}');
  }
  db.close();
  const page = (await f.request('GET', '/events?latest=true&limit=10')).body.events;
  assert.equal(page.length, 10); assert.ok(page.every(event => !['machine.heartbeat', 'assignment.renewed', 'job.renewed', 'job.log'].includes(event.type)), 'real activity is not crowded out');
  assert.equal((await f.request('GET', '/events?limit=1000')).body.events.filter(event => event.type === 'machine.heartbeat').length, 0);
  assert.equal((await f.request('GET', '/events?limit=1000&exclude=')).body.events.filter(event => event.type === 'machine.heartbeat').length, 40, 'exclude= shows everything');
  const custom = (await f.request('GET', '/events?limit=1000&exclude=run.started')).body.events;
  assert.ok(custom.some(event => event.type === 'machine.heartbeat'), 'an explicit list replaces the default'); assert.ok(!custom.some(event => event.type === 'run.started'));
  const project = (await f.request('GET', `/events?limit=1000&projectId=${second.projectId}`)).body.events;
  assert.ok(project.length > 0); assert.ok(project.every(event => event.projectId === second.projectId));
  const types = (await f.request('GET', '/events?limit=1000&types=run.started,project.created')).body.events;
  assert.deepEqual([...new Set(types.map(event => event.type))].sort(), ['project.created', 'run.started']);
  assert.equal(types.filter(event => event.type === 'run.started').length, 2);
  assert.equal((await f.request('GET', `/events?types=${'x,'.repeat(100)}x`)).status, 400);
  assert.equal((await f.request('GET', `/runs/${first.id}/metrics?window=1h`)).status, 200);
});

test('agent.messaged resolves roles to nodes through the graph and records an unknown end explicitly, never as a role id', async t => {
  const f = await fixture(t);
  const project = (await f.request('POST', '/projects', { body: { name: 'Roles', repo: { url: '/tmp/roles.git', defaultBranch: 'main' } } })).body;
  const roles = { schema: 'perpeto.workflow/1', nodes: [
    node('ideas', 'input', { source: 'manual' }), node('builder', 'agent', { harness, prompt: 'Build.' }), node('reviewer', 'agent', { harness, prompt: 'Review.', role: 'qa' }), node('done', 'output'),
  ], edges: [flow('ideas', 'builder'), flow('builder', 'reviewer'), flow('reviewer', 'done')] };
  const workflow = (await f.request('POST', `/projects/${project.id}/workflows`, { body: { name: 'Roles', graph: roles } })).body;
  await f.request('POST', `/workflows/${workflow.id}/activate`, { body: { version: 1 } });
  const run = (await f.request('POST', `/workflows/${workflow.id}/runs`, { body: { input: { items: [{ title: 'Feature' }] } } })).body;
  const path = `/messaging/projects/${project.id}/channels/run-${run.id}/messages`;
  for (const [index, [senderRoleId, recipientRoleId]] of [['builder', 'qa'], ['builder', 'ghost'], ['owner', 'builder']].entries()) {
    assert.equal((await f.request('POST', path, { body: { senderRoleId, recipientRoleId, body: 'Hi', idempotencyKey: `m${index}` } })).status, 200);
  }
  const [toQa, toGhost, fromOwner] = (await f.request('GET', `/events?runId=${run.id}&types=agent.messaged`)).body.events.map(event => event.data);
  assert.equal(toQa.targetNodeId, 'reviewer', 'a role resolves to the node that holds it'); assert.equal(toQa.to, 'reviewer');
  assert.equal(toGhost.targetNodeId, null); assert.equal(toGhost.to, null); assert.equal(toGhost.targetUnknown, true);
  assert.equal(toGhost.recipientRoleId, 'ghost'); assert.equal(toGhost.unplanned, true);
  assert.equal(fromOwner.sourceNodeId, null); assert.equal(fromOwner.from, null); assert.equal(fromOwner.sourceUnknown, true); assert.equal(fromOwner.unplanned, true);
  // A node-reported message without a target node is resolved the same way.
  const code = (await f.request('POST', '/machines/enrollment-codes', { body: {} })).body.code;
  const machine = (await f.request('POST', '/nodes/enroll', { auth: null, body: { code, name: 'm', os: 'linux', arch: 'x64', providers: ['codex'], version: 't' } })).body;
  await f.request('POST', '/nodes/heartbeat', { auth: machine.token, body: { status: 'online', capacity: { maxAgents: 1, maxJobs: 0 }, running: { agents: 0, jobs: 0 }, providers: ['codex'] } });
  const build = (await f.request('POST', '/nodes/lease', { auth: machine.token, body: { kinds: ['assignment'] } })).body.assignments[0];
  await f.request('POST', `/assignments/${build.id}/events`, { auth: machine.token, body: { attempt: build.attempt, type: 'agent.messaged', data: { recipientRoleId: 'nobody' } } });
  const reported = (await f.request('GET', `/events?runId=${run.id}&types=agent.messaged&latest=true&limit=1`)).body.events[0].data;
  assert.equal(reported.sourceNodeId, 'builder'); assert.equal(reported.targetNodeId, null); assert.equal(reported.targetUnknown, true);
  const edges = (await f.request('GET', `/runs/${run.id}/metrics?window=1h`)).body.edges.filter(edge => edge.unplanned).map(edge => edge.edgeId).sort();
  assert.ok(edges.includes('unplanned:messages:builder->?')); assert.ok(edges.includes('unplanned:messages:?->builder'));
  assert.ok(!edges.some(edge => /ghost|nobody|owner|qa/.test(edge)), `no role id is counted as a node: ${edges}`);
});
