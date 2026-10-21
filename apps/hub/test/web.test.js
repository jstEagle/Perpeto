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
  const recorded = (await f.request('GET', '/events?limit=1000')).body.events.filter(event => event.runId === run.id && ['agent.delegated', 'agent.messaged'].includes(event.type));
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

