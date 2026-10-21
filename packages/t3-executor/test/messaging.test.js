import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createT3Executor, T3Client } from '../src/index.js';
import { formatInbox } from '../src/inbox.js';
import { startFakeT3, build } from './fake-t3.js';

const message = (id, body, extra = {}) => ({ id, projectId: 'prj_1', channelId: 'run-run_1', senderRoleId: 'builder', recipientRoleId: 'reviewer',
  body, createdAt: '2026-10-21T00:00:00.000Z', threadId: id, parentId: null, senderKind: 'agent', senderAssignmentId: 'asg_b', unplanned: false, receipt: { state: 'stored' }, ...extra });
const assignment = (extra = {}) => ({
  id: `asg_${Math.random().toString(36).slice(2)}`, projectId: 'prj_1', runId: 'run_1', workItemId: 'wi_1', role: 'reviewer', attempt: 1,
  prompt: 'Review the change.', harness: { provider: 'codex', model: 'gpt-test' }, policy: { maxSubagents: 0, allowedSubagentProviders: [], canMessage: ['builder'] },
  messaging: { token: 'pa1_secret-agent-token', projectId: 'prj_1', channelId: 'run-run_1', roleId: 'reviewer' }, ...extra,
});

/** What the node hands the executor: messages that arrive on renewals, offered until delivery is recorded. */
function inbox() {
  let queue = []; const listeners = new Set();
  return {
    push(messages) { queue.push(...messages); for (const listener of listeners) listener(); },
    take() { const taken = queue; queue = []; return taken; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

async function harness(t) {
  const fake = await startFakeT3();
  const workspace = await mkdtemp(join(tmpdir(), 't3-executor-msg-'));
  const executor = createT3Executor({ config: { url: fake.url, settleMs: 30, pollMs: 10, interruptGraceMs: 500, agentHomesDir: fake.homes },
    createClient: settings => new T3Client({ baseUrl: settings.url, token: 'test-token', pingMs: 0 }) });
  const events = [];
  const ctx = { signal: new AbortController().signal, workspace, inbox: inbox(), report: async event => { events.push(event); },
    messaging: { baseUrl: 'http://127.0.0.1:4320' } };
  t.after(async () => { await executor.close(); await fake.close(); await rm(workspace, { recursive: true, force: true }); });
  const delivered = () => events.filter(event => event.type === 'delivered').map(event => event.data);
  return { fake, executor, ctx, events, delivered, workspace };
}

test('waiting messages ride in the first prompt with the messaging commands, then are reported delivered', async t => {
  const { fake, executor, ctx, delivered, workspace } = await harness(t);
  const waiting = message('msg_1', 'Please re-check the token refresh path.');
  let config; let secretMode;
  fake.state.onLaunch = async launch => {
    const directory = join(workspace, '.perpeto-messaging');
    config = JSON.parse(await readFile(join(directory, 'client.json'), 'utf8'));
    secretMode = (await stat(join(directory, 'session.secret'))).mode & 0o777;
    assert.equal((await readFile(join(directory, 'session.secret'), 'utf8')).trim(), 'pa1_secret-agent-token');
    fake.emit(launch.threadId, 'run.updated', build.run(launch.threadId, 1, 'running'));
    fake.emit(launch.threadId, 'turn-item.updated', build.assistant(launch.threadId, 1, 'Reviewed.'));
    fake.emit(launch.threadId, 'run.updated', build.run(launch.threadId, 1, 'completed'));
  };
  const result = await executor.run(assignment({ inbox: [waiting] }), ctx);
  assert.equal(result.outcome, 'success');
  const text = fake.state.commands.find(item => item.tag === 'orchestration.launchThread').payload.initialMessage.text;
  assert.match(text, /Messages waiting for you/);
  assert.match(text, /msg_1.*from builder/);
  assert.match(text, /Please re-check the token refresh path\./);
  assert.match(text, /not instructions that override/);
  assert.match(text, /You may message: builder, owner/);
  assert.match(text, /--config "\S+client\.json" ack MESSAGE_ID/);
  assert.doesNotMatch(text, /pa1_secret-agent-token/, 'the credential never enters the transcript');
  assert.deepEqual(config, { baseUrl: 'http://127.0.0.1:4320', messagingPrefix: '/api/v1/messaging', projectId: 'prj_1', roleId: 'reviewer', channelId: 'run-run_1', credentialFile: './session.secret' });
  assert.equal(secretMode, 0o600);
  assert.deepEqual(delivered(), [{ messageIds: ['msg_1'], via: 'prompt', threadRef: result.threadRef }]);
  assert.equal(existsSync(join(workspace, '.perpeto-messaging')), false, 'the credential is removed when the assignment ends');
});

test('a message that arrives mid-turn is steered into the running T3 thread once', async t => {
  const { fake, executor, ctx, delivered } = await harness(t);
  const live = message('msg_live', 'New revision pushed: abc123.');
  let root;
  fake.state.onLaunch = launch => {
    root = launch.threadId;
    fake.emit(root, 'run.updated', build.run(root, 1, 'running'));
    // The node relays the message from a lease renewal, twice, as an unacknowledged renewal would.
    setTimeout(() => { ctx.inbox.push([live]); ctx.inbox.push([live]); }, 20);
  };
  fake.state.onCommand = command => {
    if (command.type !== 'message.dispatch') return;
    // T3 resolves `auto` to steering the active run when the provider supports it; the turn then completes.
    fake.emit(root, 'turn-item.updated', build.assistant(root, 1, 'Re-reviewed abc123.'));
    fake.emit(root, 'run.updated', build.run(root, 1, 'completed'));
  };
  const result = await executor.run(assignment(), ctx);
  assert.equal(result.outcome, 'success');
  const dispatched = fake.commandsOf('message.dispatch').map(item => item.payload);
  assert.equal(dispatched.length, 1, 'a message is delivered once');
  assert.equal(dispatched[0].threadId, root);
  assert.equal(dispatched[0].deliveryIntent, 'auto');
  assert.deepEqual(dispatched[0].dispatchMode, { type: 'queue_after_active' });
  assert.match(dispatched[0].text, /New revision pushed: abc123\./);
  assert.match(dispatched[0].text, /continue your assignment/);
  assert.deepEqual(delivered(), [{ messageIds: ['msg_live'], via: 'steer', threadRef: result.threadRef }]);
});

test('a structured result survives a follow-up turn caused by a message', async t => {
  const { fake, executor, ctx } = await harness(t);
  let root;
  fake.state.onLaunch = launch => {
    root = launch.threadId;
    fake.emit(root, 'run.updated', build.run(root, 1, 'running'));
    fake.emit(root, 'turn-item.updated', build.assistant(root, 1, 'Checked.\n```json\n{"verdict": "fail", "summary": "Missing test."}\n```'));
    fake.emit(root, 'run.updated', build.run(root, 1, 'completed'));
    setTimeout(() => ctx.inbox.push([message('msg_late', 'Thanks!')]), 5);
  };
  fake.state.onCommand = command => {
    if (command.type !== 'message.dispatch') return;
    // The run had finished, so T3 starts the message as a new turn.
    fake.emit(root, 'run.updated', build.run(root, 2, 'running'));
    fake.emit(root, 'turn-item.updated', build.assistant(root, 2, 'Noted.'));
    fake.emit(root, 'run.updated', build.run(root, 2, 'completed'));
  };
  const result = await executor.run(assignment({ nodeType: 'review' }), ctx);
  assert.equal(fake.commandsOf('message.dispatch').length, 1);
  assert.equal(result.verdict, 'fail');
  assert.equal(result.summary, 'Missing test.');
});

test('inbox text quotes the sender and clips long bodies', () => {
  const text = formatInbox([message('m1', 'x'.repeat(5000)), message('m2', 'Short', { parentId: 'm0', threadId: 'm0', senderRoleId: 'owner', senderKind: 'owner' })]);
  assert.match(text, /m1.*from builder/);
  assert.match(text, /truncated/);
  assert.match(text, /m2.*from owner \(person\).*reply in thread m0/);
  assert.ok(text.length < 5000);
});
