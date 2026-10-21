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
