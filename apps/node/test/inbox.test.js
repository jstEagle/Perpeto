import test from 'node:test';
import assert from 'node:assert/strict';
import { createNode, ExecutorRegistry, createFakeExecutor } from '../src/index.js';
import { fakeHub, assignment, nodeConfig, eventually, addCleanup } from './helpers.js';

const message = id => ({ id, body: `Body ${id}`, senderRoleId: 'builder', recipientRoleId: 'reviewer' });

test('messages from lease renewals reach the running executor through ctx.inbox', async t => {
  let renewals = 0;
  // The hub keeps offering a message until delivery is recorded; the second arrives on a later renewal.
  const hub = await fakeHub(t, { renew: () => ({ inbox: ++renewals < 2 ? [] : renewals < 4 ? [message('m1')] : [message('m1'), message('m2')] }) });
  const { configPath } = await nodeConfig(t, hub);
  let context; const seen = []; let wakes = 0;
  const registry = new ExecutorRegistry().register({ ...createFakeExecutor(), async run(item, ctx) {
    context = ctx;
    const unsubscribe = ctx.inbox.subscribe(() => { wakes++; });
    await eventually(() => { seen.push(...ctx.inbox.take()); return seen.some(value => value.id === 'm2'); }, 3000);
    unsubscribe();
    return { outcome: 'success', summary: 'done' };
  } });
  hub.assignments.push(assignment('asg_inbox', { inbox: [message('m0')], messaging: { token: 'pa1_x', projectId: 'p', channelId: 'run-r', roleId: 'reviewer' } }));
  const node = await createNode({ configPath, registry, accountProvider: { async list() { return []; } }, runtimeSupervisor: { async start() { return 'http://127.0.0.1:9999'; }, async stop() {} } });
  await node.start(); addCleanup(t, () => node.stop({ drain: false }));
  await eventually(() => hub.events.some(event => event.type === 'completed'));
  assert.ok(wakes > 0, 'arrivals wake the executor');
  assert.ok(seen.filter(value => value.id === 'm1').length >= 1);
  assert.ok(!seen.some(value => value.id === 'm0'), 'the leased inbox goes into the prompt, not the live queue');
  assert.deepEqual(context.messaging, { baseUrl: hub.url });
});
