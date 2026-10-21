import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHub } from '../src/index.js';
import { createStubEngine } from '../src/engine/stub-engine.js';

const roles = ['builder', 'reviewer', 'qa'];
const graph = { schema: 'perpeto.workflow/1', nodes: roles.map(id => ({ id, type: 'agent', label: id, position: { x: 0, y: 0 }, config: {} })),
  edges: [{ id: 'talk', from: { node: 'builder' }, to: { node: 'reviewer' }, kind: 'messages' }] };
const heartbeat = { status: 'online', capacity: { maxAgents: 4, maxJobs: 0 }, running: { agents: 0, jobs: 0 }, providers: ['codex'], accounts: [] };
const policy = canMessage => ({ maxSubagents: 0, allowedSubagentProviders: [], canMessage });

async function fixture(t, { workflow = {}, config = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'perpeto-hub-messaging-'));
  const configPath = join(directory, 'hub.json');
  await writeFile(configPath, JSON.stringify({ port: 0, databasePath: './hub.sqlite', messagingDatabasePath: './messaging.sqlite', ownerTokenPath: './owner.secret', longPollMs: 0, maintenanceIntervalMs: 10, ...config }));
  let hub = await createHub({ configPath, engine: createStubEngine() }); let baseUrl = await hub.listen();
  const owner = (await readFile(join(directory, 'owner.secret'), 'utf8')).trim();
  t.after(async () => { await hub.close(); await rm(directory, { recursive: true, force: true }); });
  const request = async (method, path, body, token = owner) => {
    const response = await fetch(`${baseUrl}/api/v1${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const project = (await request('POST', '/projects', { name: 'Test', repo: { url: '/tmp/repo.git', defaultBranch: 'main' } })).body;
  const created = await request('POST', `/projects/${project.id}/workflows`, { name: 'Build', graph, ...workflow });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  await request('POST', `/workflows/${created.body.id}/activate`, { version: created.body.version });
  const run = (await request('POST', `/workflows/${created.body.id}/runs`, {})).body;
  const code = (await request('POST', '/machines/enrollment-codes', {})).body.code;
  const node = (await request('POST', '/nodes/enroll', { code, name: 'm', os: 'linux', arch: 'x64', providers: ['codex'], labels: [], version: 'test' }, null)).body;
  assert.equal((await request('POST', '/nodes/heartbeat', heartbeat, node.token)).status, 200);
  const channel = `/messaging/projects/${project.id}/channels/run-${run.id}`;
  let seeded = 0;
  const f = {
    hub: () => hub, project, run, node, channel, request, workflow: created.body,
    async restart() { await hub.close(); hub = await createHub({ configPath, engine: createStubEngine() }); baseUrl = await hub.listen(); },
    /** Queue and lease one assignment for a role; returns the leased payload with its messaging credential and inbox. */
    async start(role, canMessage = []) {
      const id = `asg_${role}_${++seeded}`;
      await request('POST', `/runs/${run.id}/inputs`, { assignments: [{ id, workItemId: `wi_${seeded}`, nodeId: role, role, prompt: 'Work', harness: { provider: 'codex', model: 'm' }, policy: policy(canMessage), requirements: {} }] });
      const leased = await request('POST', '/nodes/lease', { kinds: ['assignment'], max: 1 }, node.token);
      const assignment = leased.body.assignments.find(item => item.id === id);
      assert.ok(assignment, `lease returned ${id}`);
      return assignment;
    },
    send(token, body) { return request('POST', `${channel}/messages`, { idempotencyKey: `key-${Math.random()}`, ...body }, token); },
    async events(type) { return (await request('GET', `/events?runId=${run.id}&limit=1000`)).body.events.filter(event => event.type === type); },
  };
  return f;
}

test('leased assignments carry a run-scoped agent credential the hub binds to their role', async t => {
  const f = await fixture(t);
  const builder = await f.start('builder', ['reviewer']);
  assert.deepEqual(Object.keys(builder.messaging).sort(), ['channelId', 'projectId', 'roleId', 'token']);
  assert.equal(builder.messaging.channelId, `run-${f.run.id}`);
  assert.equal(builder.messaging.roleId, 'builder');
  const { token } = builder.messaging;
  const sent = await f.send(token, { recipientRoleId: 'reviewer', body: 'Ready' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.message.senderRoleId, 'builder', 'the hub derives the sender');
  assert.equal(sent.body.message.senderKind, 'agent');
  assert.equal(sent.body.message.senderAssignmentId, builder.id);
  assert.equal((await f.send(token, { senderRoleId: 'reviewer', recipientRoleId: 'builder', body: 'Impersonation' })).status, 403);
  assert.equal((await f.request('GET', `${f.channel}/messages`, undefined, token)).body.messages.length, 1);
  // The credential reaches only its run's channel.
  assert.equal((await f.request('GET', `/messaging/projects/${f.project.id}/channels`, undefined, token)).status, 403);
  assert.equal((await f.request('POST', `/messaging/projects/${f.project.id}/channels`, { id: 'side', name: 'Side' })).status, 200);
  assert.equal((await f.request('GET', `/messaging/projects/${f.project.id}/channels/side/messages`, undefined, token)).status, 403);
  assert.equal((await f.request('GET', '/projects', undefined, token)).status, 403);
  assert.equal((await f.request('POST', `/assignments/${builder.id}/events`, { attempt: builder.attempt, type: 'started', data: {} }, token)).status, 403);
  // Lease replays never persist the credential in the clear, and re-derive the same one.
  const db = new DatabaseSync(join(f.hub().config.databasePath)); t.after(() => db.close());
  assert.ok(!db.prepare('SELECT response FROM idempotency').all().some(row => row.response.includes(token)));
  // Finishing the assignment ends the credential.
  assert.equal((await f.request('POST', `/assignments/${builder.id}/events`, { attempt: builder.attempt, type: 'completed', data: { outcome: 'success', summary: 'Done' } }, f.node.token)).status, 200);
  assert.equal((await f.send(token, { recipientRoleId: 'reviewer', body: 'Late' })).status, 401);
  assert.equal((await f.request('GET', `${f.channel}/messages`, undefined, `${token.slice(0, -2)}AA`)).status, 401);
});

test('unplanned agent sends are flagged by default and rejected under enforce; owners message anyone', async t => {
  const flag = await fixture(t);
  const builder = await flag.start('builder', ['reviewer']);
  const planned = await flag.send(builder.messaging.token, { recipientRoleId: 'reviewer', body: 'Planned' });
  assert.equal(planned.body.message.unplanned, false);
  const offEdge = await flag.send(builder.messaging.token, { recipientRoleId: 'qa', body: 'Off the graph' });
  assert.equal(offEdge.status, 200);
  assert.equal(offEdge.body.message.unplanned, true);
  const broadcast = await flag.send(builder.messaging.token, { body: 'Everyone' });
  assert.equal(broadcast.body.message.unplanned, true);
  assert.equal((await flag.send(builder.messaging.token, { recipientRoleId: 'owner', body: 'Question for you' })).body.message.unplanned, false, 'agents can always reach the owner');
  const messaged = await flag.events('agent.messaged');
  assert.deepEqual(messaged.map(event => event.data.flagged ?? false), [false, true, true, false]);
  assert.equal(messaged[3].data.human, true, 'the owner is not a graph node, so clients see a human end');
  assert.ok(messaged.every(event => event.data.senderKind === 'agent'));
  // The existing node event path follows the same policy.
  const viaNode = await flag.request('POST', `/assignments/${builder.id}/events`, { attempt: builder.attempt, type: 'message', data: { recipientRoleId: 'qa', body: 'Via node' }, idempotencyKey: 'node-msg' }, flag.node.token);
  assert.equal(viaNode.status, 200);
  assert.equal(viaNode.body.message.unplanned, true);

  const enforce = await fixture(t, { workflow: { messagingPolicy: 'enforce' } });
  assert.equal(enforce.workflow.messagingPolicy, 'enforce');
  const strict = await enforce.start('builder', ['reviewer']);
  assert.equal((await enforce.send(strict.messaging.token, { recipientRoleId: 'reviewer', body: 'Planned' })).status, 200);
  const rejected = await enforce.send(strict.messaging.token, { recipientRoleId: 'qa', body: 'Off the graph' });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.body.error.code, 'MESSAGE_NOT_ALLOWED');
  assert.equal((await enforce.send(strict.messaging.token, { body: 'Everyone' })).status, 403);
  assert.equal((await enforce.request('POST', `/assignments/${strict.id}/events`, { attempt: strict.attempt, type: 'message', data: { recipientRoleId: 'qa', body: 'Via node' } }, enforce.node.token)).status, 403);
  const human = await enforce.send(undefined, { senderRoleId: 'owner', recipientRoleId: 'qa', body: 'From the owner' });
  assert.equal(human.status, 200);
  assert.equal(human.body.message.senderKind, 'owner');
  assert.equal(human.body.message.unplanned, false);
  // Replying to the owner is always planned, even without an edge.
  const qa = await enforce.start('qa', []);
  const reply = await enforce.send(qa.messaging.token, { parentId: human.body.message.id, body: 'On it' });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.message.recipientRoleId, 'owner');
  assert.equal(reply.body.message.threadId, human.body.message.id);
  assert.equal((await enforce.request('PUT', `/workflows/${enforce.workflow.id}`, { messagingPolicy: 'sometimes' })).status, 400);
});

test('per-role rate limits reject bursts without limiting the owner', async t => {
  const f = await fixture(t, { workflow: { messageRateLimits: { builder: 2 } }, config: { messageRatePerMinute: 100 } });
  const builder = await f.start('builder', ['reviewer']);
  for (let index = 0; index < 2; index++) assert.equal((await f.send(builder.messaging.token, { recipientRoleId: 'reviewer', body: `M${index}` })).status, 200);
  const limited = await f.send(builder.messaging.token, { recipientRoleId: 'reviewer', body: 'Too many' });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'RATE_LIMITED');
  for (let index = 0; index < 3; index++) assert.equal((await f.send(undefined, { senderRoleId: 'owner', recipientRoleId: 'builder', body: `O${index}` })).status, 200);
  assert.equal((await f.request('PUT', `/workflows/${f.workflow.id}`, { messageRateLimits: { builder: 0 } })).status, 400);
});

test('the durable inbox reaches the next assignment, live turns via renew, and records delivery and acks', async t => {
  const f = await fixture(t);
  const waiting = await f.send(undefined, { senderRoleId: 'owner', recipientRoleId: 'reviewer', body: 'Please check the API' });
  assert.equal(waiting.body.message.receipt.state, 'stored');
  const reviewer = await f.start('reviewer', ['builder']);
  assert.deepEqual(reviewer.inbox.map(message => message.id), [waiting.body.message.id], 'waiting messages ride along with the lease');
  const token = reviewer.messaging.token;
  const delivered = await f.request('POST', `/assignments/${reviewer.id}/events`, { attempt: reviewer.attempt, type: 'delivered', data: { messageIds: [waiting.body.message.id], via: 'prompt' } }, f.node.token);
  assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
  assert.deepEqual(delivered.body.delivered, [waiting.body.message.id]);
  // A message that arrives mid-turn comes back with the next renewal until it is delivered.
  const builder = await f.start('builder', ['reviewer']);
  const live = await f.send(builder.messaging.token, { recipientRoleId: 'reviewer', body: 'New revision pushed' });
  const renewed = await f.request('POST', `/assignments/${reviewer.id}/renew`, { attempt: reviewer.attempt }, f.node.token);
  assert.deepEqual(renewed.body.inbox.map(message => message.id), [live.body.message.id]);
  assert.deepEqual((await f.request('POST', `/assignments/${builder.id}/renew`, { attempt: builder.attempt }, f.node.token)).body.inbox, []);
  await f.request('POST', `/assignments/${reviewer.id}/events`, { attempt: reviewer.attempt, type: 'delivered', data: { messageIds: [live.body.message.id], via: 'steer' } }, f.node.token);
  assert.deepEqual((await f.request('POST', `/assignments/${reviewer.id}/renew`, { attempt: reviewer.attempt }, f.node.token)).body.inbox, []);
  const forged = await f.request('POST', `/assignments/${builder.id}/events`, { attempt: builder.attempt, type: 'delivered', data: { messageIds: [live.body.message.id], via: 'steer' } }, f.node.token);
  assert.deepEqual(forged.body.delivered, [], 'only the recipient role takes delivery');
  // The recipient acknowledges; the sender sees it on the message and in the thread.
  const ack = await f.request('POST', `${f.channel}/messages/${live.body.message.id}/ack`, { note: 'Re-reviewing' }, token);
  assert.equal(ack.status, 200, JSON.stringify(ack.body));
  assert.equal(ack.body.message.receipt.state, 'acked');
  assert.equal((await f.request('POST', `${f.channel}/messages/${live.body.message.id}/ack`, {}, builder.messaging.token)).status, 403);
  const reply = await f.send(token, { parentId: live.body.message.id, body: 'Looks good now' });
  assert.equal(reply.body.message.recipientRoleId, 'builder');
  const seen = await f.request('GET', `${f.channel}/messages/${live.body.message.id}`, undefined, builder.messaging.token);
  assert.equal(seen.body.receipt.state, 'acked');
  assert.equal(seen.body.receipt.deliveredVia, 'steer');
  const thread = await f.request('GET', `${f.channel}/messages?threadId=${live.body.message.id}`, undefined, builder.messaging.token);
  assert.deepEqual(thread.body.messages.map(message => message.id), [live.body.message.id, reply.body.message.id]);
  // The reply targets the builder's live assignment.
  assert.deepEqual((await f.request('POST', `/assignments/${builder.id}/renew`, { attempt: builder.attempt }, f.node.token)).body.inbox.map(message => message.id), [reply.body.message.id]);
  assert.deepEqual((await f.events('message.delivered')).map(event => [event.data.messageId, event.data.via]), [[waiting.body.message.id, 'prompt'], [live.body.message.id, 'steer']]);
  const acked = await f.events('message.acked');
  assert.equal(acked.length, 1);
  assert.equal(acked[0].data.note, 'Re-reviewing');
  assert.equal(acked[0].data.recipientRoleId, 'reviewer');
});

test('unread cursors are per role; agents read only their own', async t => {
  const f = await fixture(t);
  const reviewer = await f.start('reviewer', ['builder']);
  const first = await f.send(undefined, { senderRoleId: 'owner', recipientRoleId: 'reviewer', body: 'One' });
  await f.send(undefined, { senderRoleId: 'owner', recipientRoleId: 'reviewer', body: 'Two' });
  await f.send(undefined, { senderRoleId: 'owner', recipientRoleId: 'builder', body: 'Not yours' });
  const unread = await f.request('GET', `${f.channel}/unread`, undefined, reviewer.messaging.token);
  assert.equal(unread.status, 200, JSON.stringify(unread.body));
  assert.equal(unread.body.unreadCount, 2);
  assert.equal((await f.request('GET', `${f.channel}/unread?roleId=builder`, undefined, reviewer.messaging.token)).status, 403);
  const marked = await f.request('POST', `${f.channel}/read-cursor`, { messageId: first.body.message.id }, reviewer.messaging.token);
  assert.deepEqual(marked.body, { roleId: 'reviewer', lastReadMessageId: first.body.message.id, unreadCount: 1 });
  assert.equal((await f.request('GET', `${f.channel}/unread?roleId=builder`)).body.unreadCount, 1, 'the owner can read any role');
  assert.equal((await f.request('GET', `${f.channel}/unread`)).status, 400, 'the owner names the role');
});
