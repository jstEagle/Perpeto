import test from 'node:test';
import assert from 'node:assert/strict';
import { HubClient } from '../src/hub.js';
import { fakeHub, nodeConfig } from './helpers.js';

test('L8: transient retries use jitter while preserving the idempotency key', async t => {
  let calls = 0;
  const hub = await fakeHub(t, { heartbeat: () => ++calls === 1 ? { statusCode: 503, body: { error: { code: 'UNAVAILABLE' } } } : {} });
  const { config } = await nodeConfig(t, hub);
  const random = t.mock.method(Math, 'random', () => 0.5);
  const client = new HubClient(config, 'private-machine-token');
  await client.retry('/nodes/heartbeat', {}, { key: 'retry-stable' });
  assert.ok(random.mock.callCount() >= 1);
  assert.deepEqual(hub.requests.map(r => r.body.idempotencyKey), ['retry-stable', 'retry-stable']);
});

test('credential activation waits for a logical retry so it cannot replay a mutation under a different token scope', async t => {
  const hub = await fakeHub(t);
  const { config } = await nodeConfig(t, hub);
  const client = new HubClient(config, 'private-machine-token');
  assert.equal(typeof client.withTokenRotation, 'function');
  hub.assignments.push({ id: 'asg_retry', attempt: 1 });
  hub.dropLease = true;
  const leased = client.retry('/nodes/lease', { kinds: ['assignment'], max: 1 }, { key: 'logical-lease' });
  await new Promise(resolve => setTimeout(resolve, 1));
  const rotated = client.withTokenRotation(async transport => {
    const next = await transport.retry('/nodes/token', {}, { key: 'rotation' });
    client.setToken(next.token);
  });
  const heartbeat = client.post('/nodes/heartbeat', {});
  const [result] = await Promise.all([leased, rotated, heartbeat]);
  assert.equal(result.assignments[0].id, 'asg_retry');
  const leaseRequests = hub.requests.filter(r => r.path.endsWith('/lease'));
  assert.equal(leaseRequests.length, 2);
  assert.ok(leaseRequests.every(r => r.auth === 'Bearer private-machine-token' && r.body.idempotencyKey === 'logical-lease'));
  const rotationIndex = hub.requests.findIndex(r => r.path.endsWith('/token'));
  assert.ok(hub.requests.indexOf(leaseRequests[1]) < rotationIndex);
  assert.equal(hub.requests.at(-1).auth, 'Bearer private-machine-token_1');
});
