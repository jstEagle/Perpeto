import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createT3Executor, T3Client } from '../src/index.js';
import { startFakeT3, build } from './fake-t3.js';
// The e2e harness: a real hub with the workflow engine and a real node daemon on temporary state.
import { bareRepository, eventually, startFactory } from '../../../tests/e2e/test/support.js';

const cli = fileURLToPath(import.meta.resolve('@perpeto/sdk/cli'));
const agentCli = (config, ...args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [cli, '--config', config, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`perpeto-messages ${args[0]} exited ${code}: ${stderr}`)));
});

const node = (id, extra = {}) => ({ id, type: 'agent', label: id, position: { x: 0, y: 0 },
  config: { harness: { provider: 'codex', model: 'gpt-test' }, prompt: `Act as ${id}.`, concurrency: 1, policy: { maxSubagents: 0, allowedSubagentProviders: [] }, ...extra } });
const graph = { schema: 'perpeto.workflow/1', nodes: [
  { id: 'input', type: 'input', label: 'input', position: { x: 0, y: 0 }, config: { source: 'manual', docs: [] } },
  node('builder'), node('reviewer'), { id: 'output', type: 'output', label: 'output', position: { x: 0, y: 0 }, config: {} },
], edges: [
  { id: 'in', kind: 'flow', from: { node: 'input' }, to: { node: 'builder' } },
  { id: 'build-review', kind: 'flow', from: { node: 'builder' }, to: { node: 'reviewer' } },
  { id: 'out', kind: 'flow', from: { node: 'reviewer' }, to: { node: 'output' } },
  { id: 'talk', kind: 'messages', from: { node: 'builder' }, to: { node: 'reviewer' } },
] };

test('wake-up: a message reaches a running T3 turn, a waiting one the next prompt; the agent acks and replies with its own credential', async t => {
  const fake = await startFakeT3();
  t.after(() => fake.close());
  const executor = createT3Executor({ config: { url: fake.url, settleMs: 50, pollMs: 10, interruptGraceMs: 500, agentHomesDir: fake.homes },
    createClient: settings => new T3Client({ baseUrl: settings.url, token: 'test-token', pingMs: 0 }) });
  t.after(() => executor.close());
  const factory = await startFactory(t, { executor, node: { providers: ['codex'], fake: undefined,
    timing: { heartbeatMs: 200, renewMs: 100, requestMs: 5000, pollIdleMs: 20, backoffMinMs: 20, backoffMaxMs: 200 } } });
  const { request } = factory;
  const repo = await bareRepository(factory.root);

  const threads = {};
  const configOf = launch => join(dirname(fake.state.projects.find(project => project.id === launch.projectId).workspaceRoot), '.perpeto-messaging', 'client.json');
  fake.state.onLaunch = launch => {
    const role = /Role: (\w+)/.exec(launch.initialMessage.text)[1];
    threads[role] = { ...launch, config: configOf(launch) };
    fake.emit(launch.threadId, 'run.updated', build.run(launch.threadId, 1, 'running'));
    // The reviewer finishes at once; the builder keeps working until a message arrives.
    if (role === 'reviewer') {
      fake.emit(launch.threadId, 'turn-item.updated', build.assistant(launch.threadId, 1, 'Reviewed.'));
      fake.emit(launch.threadId, 'run.updated', build.run(launch.threadId, 1, 'completed'));
    }
  };
  const handled = [];
  fake.state.onCommand = async command => {
    if (command.type !== 'message.dispatch' || command.threadId !== threads.builder?.threadId) return;
    // What the steered agent does: acknowledge and reply with the commands its prompt names, then finish the turn.
    const messageId = /\[([0-9a-f-]{36})\] from owner/.exec(command.text)[1];
    try {
      handled.push(await agentCli(threads.builder.config, 'ack', messageId, '--note', 'Adding tests now'));
      handled.push(await agentCli(threads.builder.config, 'reply', messageId, '--body', 'Tests added.', '--key', 'builder-reply-1'));
    } catch (error) { handled.push(error); }
    fake.emit(command.threadId, 'turn-item.updated', build.assistant(command.threadId, 1, 'Done, with tests.'));
    fake.emit(command.threadId, 'run.updated', build.run(command.threadId, 1, 'completed'));
  };

  const project = await request('POST', '/projects', { name: 'Wake-up fixture', repo: { url: repo, defaultBranch: 'main' } });
  const workflow = await request('POST', `/projects/${project.id}/workflows`, { name: 'Talk', graph, messagingPolicy: 'enforce' });
  await request('POST', `/workflows/${workflow.id}/activate`, { version: 1 });
  const run = await request('POST', `/workflows/${workflow.id}/runs`, { input: { items: [{ title: 'Login' }] } });
  const channel = `/messaging/projects/${project.id}/channels/run-${run.id}`;

  // No reviewer is running yet: this waits in the reviewer role's durable inbox.
  const waiting = (await request('POST', `${channel}/messages`, { senderRoleId: 'owner', recipientRoleId: 'reviewer', body: 'Check the error copy too.', idempotencyKey: 'owner-1' })).message;
  await eventually(() => threads.builder, { timeoutMs: 20000 });
  assert.match(threads.builder.initialMessage.text, /You may message: reviewer, owner/);
  assert.doesNotMatch(threads.builder.initialMessage.text, /Check the error copy too/, 'a message for another role stays out of this prompt');
  // The builder is mid-turn: this one is steered into its running thread.
  const live = (await request('POST', `${channel}/messages`, { senderRoleId: 'owner', recipientRoleId: 'builder', body: 'Please add tests.', idempotencyKey: 'owner-2' })).message;

  const done = await eventually(async () => { const value = await request('GET', `/runs/${run.id}`); return value.status === 'completed' && value; }, { timeoutMs: 30000 });
  assert.equal(done.status, 'completed');
  assert.ok(handled.every(value => !(value instanceof Error)), String(handled.find(value => value instanceof Error)));

  const steered = fake.commandsOf('message.dispatch').map(item => item.payload);
  assert.equal(steered.length, 1, 'delivered into the running thread once');
  assert.equal(steered[0].threadId, threads.builder.threadId);
  assert.equal(steered[0].deliveryIntent, 'auto');
  // Live acceptance 3: T3's message.dispatch schema requires both creation fields; without them T3 rejected
  // every steer and the message waited for the next assignment's prompt.
  assert.equal(steered[0].createdBy, 'system');
  assert.equal(steered[0].creationSource, 'server');
  assert.match(steered[0].text, /Please add tests\./);
  assert.match(threads.reviewer.initialMessage.text, /Messages waiting for you[\s\S]*Check the error copy too\./);

  const liveNow = await request('GET', `${channel}/messages/${live.id}`);
  assert.equal(liveNow.receipt.state, 'acked');
  assert.equal(liveNow.receipt.deliveredVia, 'steer');
  assert.equal(liveNow.receipt.ackNote, 'Adding tests now');
  const waitingNow = await request('GET', `${channel}/messages/${waiting.id}`);
  assert.equal(waitingNow.receipt.state, 'delivered');
  assert.equal(waitingNow.receipt.deliveredVia, 'prompt');
  const thread = (await request('GET', `${channel}/messages?threadId=${live.id}`)).messages;
  assert.deepEqual(thread.map(message => [message.senderRoleId, message.senderKind, message.recipientRoleId]), [['owner', 'owner', 'builder'], ['builder', 'agent', 'owner']]);
  assert.equal(thread[1].unplanned, false, 'answering the owner is always allowed, even under enforce');
  const events = await factory.events();
  assert.deepEqual(events.filter(event => event.type === 'message.delivered').map(event => [event.data.messageId, event.data.via]).sort(),
    [[live.id, 'steer'], [waiting.id, 'prompt']].sort());
  assert.equal(events.filter(event => event.type === 'message.acked').length, 1);
});
