import test from 'node:test';
import assert from 'node:assert/strict';
import { T3Client } from '../src/client.js';
import { startFakeT3 } from './fake-t3.js';

const envelope = { commandId: 'cmd-test', threadId: 'thread-test' };
const message = { ...envelope, type: 'message.dispatch', createdBy: 'system', creationSource: 'server',
  messageId: 'msg-test', text: 'Continue.', attachments: [], dispatchMode: { type: 'start_immediately' } };
const selection = { instanceId: 'codex', model: 'gpt-test' };
const fixtures = [
  ['orchestration.launchThread', { ...envelope, projectId: 'project-test', title: 'Build', modelSelection: selection,
    runtimeMode: 'auto', interactionMode: 'default', workspaceStrategy: { type: 'root' }, initialMessage: { text: 'Build.', attachments: [] } }, 'projectId'],
  ['orchestration.dispatchCommand', { ...envelope, type: 'thread.create', createdBy: 'system', creationSource: 'server',
    projectId: 'project-test', title: 'Build', modelSelection: selection, runtimeMode: 'auto', interactionMode: 'default', branch: null, worktreePath: null }, 'modelSelection'],
  ['orchestration.dispatchCommand', message, 'createdBy'],
  ['orchestration.dispatchCommand', { ...message, deliveryIntent: 'steer', dispatchMode: { type: 'steer_active', targetRunId: 'run-test' } }, 'creationSource'],
  ['orchestration.dispatchCommand', { ...envelope, type: 'run.interrupt', runId: 'run-test', holdQueue: true }, 'runId'],
  ['orchestration.dispatchCommand', { ...envelope, type: 'runtime-request.respond', requestId: 'request-test', decision: 'decline' }, 'requestId'],
  ['projects.mutate', { type: 'project.create', commandId: 'cmd-project', projectId: 'project-test', title: 'Project', workspaceRoot: '/tmp/project', createWorkspaceRootIfMissing: false }, 'workspaceRoot'],
];

test('fake T3 rejects missing required fields using real RPC contracts before side effects', async t => {
  const fake = await startFakeT3();
  const client = new T3Client({ baseUrl: fake.url, token: 'test-token', pingMs: 0 });
  t.after(async () => { client.close(); await fake.close(); });
  for (const [tag, payload, required] of fixtures) {
    await client.request(tag, payload);
    const before = [fake.state.commands.length, fake.state.projects.length, fake.state.threads.size];
    const invalid = { ...payload };
    delete invalid[required];
    await assert.rejects(client.request(tag, invalid), new RegExp(required), `${payload.type ?? tag}: ${required}`);
    assert.deepEqual([fake.state.commands.length, fake.state.projects.length, fake.state.threads.size], before);
  }
});

test('regression fixture: reverting the steer fix is rejected by the fake server', async t => {
  const fake = await startFakeT3();
  const client = new T3Client({ baseUrl: fake.url, token: 'test-token', pingMs: 0 });
  t.after(async () => { client.close(); await fake.close(); });
  const beforeSteerFix = { ...message, deliveryIntent: 'auto', dispatchMode: { type: 'queue_after_active' } };
  delete beforeSteerFix.createdBy;
  delete beforeSteerFix.creationSource;
  await assert.rejects(client.dispatch(beforeSteerFix), /createdBy|creationSource/);
  assert.equal(fake.commandsOf('message.dispatch').length, 0);
  await client.dispatch({ ...beforeSteerFix, createdBy: 'system', creationSource: 'server' });
  assert.equal(fake.commandsOf('message.dispatch').length, 1);
});
