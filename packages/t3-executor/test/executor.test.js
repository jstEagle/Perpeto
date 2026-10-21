import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { createT3Executor, chooseInstance, T3Client, buildPrompt, readCredentialFile } from '../src/index.js';
import { startFakeT3, build } from './fake-t3.js';

const policy = { maxSubagents: 1, allowedSubagentProviders: ['codex'], canMessage: [] };
function assignment(extra = {}) {
  return {
    id: `asg_${Math.random().toString(36).slice(2)}`, runId: 'run_1', workItemId: 'wi_1', role: 'implementer', attempt: 0,
    prompt: 'Implement the feature.', harness: { provider: 'codex', model: 'gpt-test', options: { reasoningEffort: 'high', runtimeMode: 'auto' } },
    policy, context: { project: { name: 'Demo', goals: ['Ship it'], docs: [{ id: 'd1', title: 'Spec', path: 'docs/spec.md', kind: 'spec' }] }, workItem: { id: 'wi_1', title: 'Add login', body: 'Users can log in.' } },
    ...extra,
  };
}

async function harness(t, options = {}) {
  const fake = await startFakeT3(options);
  const workspace = await mkdtemp(join(tmpdir(), 't3-executor-ws-'));
  const executor = createT3Executor({ config: { url: fake.url, settleMs: 30, pollMs: 10, interruptGraceMs: 500, ...options.config }, createClient: settings => new T3Client({ baseUrl: settings.url, token: 'test-token', pingMs: 0 }) });
  const events = [];
  const controller = new AbortController();
  const ctx = { signal: controller.signal, workspace, report: async event => { events.push(event); } };
  t.after(async () => { await executor.close(); await fake.close(); await rm(workspace, { recursive: true, force: true }); });
  const progress = name => events.filter(event => event.type === 'progress' && event.data.interaction === name).map(event => event.data);
  return { fake, executor, ctx, events, controller, progress, workspace };
}

/** A typical single successful turn. */
function completeTurn(fake, threadId, { text = 'Done. Opened https://github.com/acme/app/pull/42', ordinal = 1 } = {}) {
  fake.emit(threadId, 'run.updated', build.run(threadId, ordinal, 'running'));
  fake.emit(threadId, 'turn-item.updated', build.assistant(threadId, ordinal, text));
  fake.emit(threadId, 'provider-turn.updated', build.usage(threadId, ordinal, { inputTokens: 1000, cachedInputTokens: 600, cacheCreationTokens: 100, outputTokens: 50, reasoningTokens: 10 }));
  fake.emit(threadId, 'run.updated', build.run(threadId, ordinal, 'completed'));
}

test('runs a turn: policy first, launch with model options, usage, timing and result', async t => {
  const { fake, executor, ctx, events, progress, workspace } = await harness(t);
  fake.state.onLaunch = launch => completeTurn(fake, launch.threadId);
  const result = await executor.run(assignment(), ctx);

  assert.equal(result.outcome, 'success');
  assert.equal(result.summary, 'Done. Opened https://github.com/acme/app/pull/42');
  assert.equal(result.prUrl, 'https://github.com/acme/app/pull/42');
  assert.match(result.threadRef, /^t3-thread:\/\/v1\/perpeto-thr-/);

  const order = fake.state.requests.map(item => `${item.method} ${item.path.split('/').slice(0, 4).join('/')}`);
  assert.ok(order.indexOf('PUT /api/perpeto/agent-policies') >= 0, 'policy attached');
  const launch = fake.state.commands.find(item => item.tag === 'orchestration.launchThread').payload;
  assert.ok(fake.state.requests.findIndex(item => item.method === 'PUT') < fake.state.requests.findIndex(item => item.path === '/api/orchestration/threads/' + launch.threadId), 'policy precedes thread reads');
  assert.deepEqual(fake.policies.getPolicy(launch.threadId), { ...fake.policies.getPolicy(launch.threadId), maxSubagents: 1, allowedSubagentProviders: ['codex'] });
  assert.deepEqual(launch.modelSelection, { instanceId: 'codex', model: 'gpt-test', options: [{ id: 'reasoningEffort', value: 'high' }] });
  assert.equal(launch.runtimeMode, 'auto');
  assert.deepEqual(launch.workspaceStrategy, { type: 'root' });
  assert.equal(fake.state.projects[0].workspaceRoot, await realpath(workspace));
  assert.match(launch.initialMessage.text, /^Implement the feature\./);
  assert.match(launch.initialMessage.text, /Ship it/);
  assert.match(launch.initialMessage.text, /Spec \(spec\): docs\/spec\.md/);
  assert.match(launch.initialMessage.text, /at most 1, using only these providers: codex/);

  const usage = events.filter(event => event.type === 'usage').map(event => event.data);
  assert.equal(usage.length, 1);
  assert.deepEqual({ ...usage[0], threadRef: undefined, providerTurnId: undefined, at: undefined }, {
    provider: 'codex', model: 'gpt-test', inputTokens: 300, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: 100,
    reasoningTokens: 10, usageStatus: 'complete', hasSubagents: false, threadRef: undefined, providerTurnId: undefined, at: undefined,
  });
  assert.equal(progress('turn.started').length, 1);
  assert.deepEqual(progress('turn.finished').map(item => [item.status, item.durationMs]), [['completed', 5000]]);
  assert.ok(fake.state.acks > 0, 'stream chunks are acknowledged');
});

test('reports app-owned delegation, refused attempts and follows child usage before finishing', async t => {
  const { fake, executor, ctx, events, progress } = await harness(t);
  fake.state.onLaunch = launch => {
    const root = launch.threadId;
    fake.emit(root, 'run.updated', build.run(root, 1, 'running'));
    // What the patched T3 server records when the agent calls delegate_task.
    assert.equal(fake.policies.authorize({ requestKey: 'k1', callerThreadId: root, kind: 'delegated_task', providerInstanceId: 'codex', driver: 'codex', model: 'gpt-test' }).allowed, true);
    fake.policies.recordCreated({ requestKey: 'k1', callerThreadId: root, childThreadId: 'child-1', childRef: 'node:task-1' });
    assert.equal(fake.policies.authorize({ requestKey: 'k2', callerThreadId: root, kind: 'delegated_task', providerInstanceId: 'claudeAgent', driver: 'claudeAgent', model: 'claude-test' }).allowed, false);
    // As live T3 does, the task appears before its child thread exists.
    fake.emit(root, 'subagent.updated', { id: 'node:task-1', origin: 'app_owned', driver: 'codex', providerInstanceId: 'codex', model: 'gpt-test', childThreadId: null, status: 'pending' });
    fake.emit(root, 'subagent.updated', { id: 'node:task-1', origin: 'app_owned', driver: 'codex', providerInstanceId: 'codex', model: 'gpt-test', childThreadId: 'child-1', status: 'running' });
    fake.emit(root, 'run.updated', build.run(root, 1, 'completed'));
    setTimeout(() => {
      fake.emit('child-1', 'run.updated', build.run('child-1', 1, 'running'));
      fake.emit('child-1', 'provider-turn.updated', build.usage('child-1', 1, { inputTokens: 20, outputTokens: 5 }));
      fake.emit('child-1', 'run.updated', build.run('child-1', 1, 'completed'));
      fake.emit(root, 'subagent.updated', { id: 'node:task-1', origin: 'app_owned', driver: 'codex', providerInstanceId: 'codex', model: 'gpt-test', childThreadId: 'child-1', status: 'completed' });
      fake.emit(root, 'run.updated', build.run(root, 2, 'running'));
      fake.emit(root, 'turn-item.updated', build.assistant(root, 2, 'Merged the helper result.'));
      fake.emit(root, 'run.updated', build.run(root, 2, 'completed'));
    }, 100);
  };
  const result = await executor.run(assignment(), ctx);
  assert.equal(result.outcome, 'success');
  assert.equal(result.summary, 'Merged the helper result.');
  const delegations = progress('agent.delegated');
  assert.deepEqual(delegations.map(item => [item.kind, item.allowed, item.target.provider]).sort(), [['delegated_task', false, 'claudeAgent'], ['delegated_task', true, 'codex']]);
  assert.equal(delegations.find(item => item.allowed).target.threadRef, 't3-thread://v1/child-1');
  assert.match(delegations.find(item => !item.allowed).reason, /not in this agent's allowed subagent providers/);
  const childUsage = events.filter(event => event.type === 'usage' && event.data.threadRef === 't3-thread://v1/child-1');
  assert.equal(childUsage.length, 1);
  assert.equal(progress('turn.finished').length, 2);
});

test('interrupts the run when a provider-native subagent exceeds the policy', async t => {
  const { fake, executor, ctx, progress } = await harness(t);
  fake.state.onLaunch = launch => {
    const root = launch.threadId;
    fake.emit(root, 'run.updated', build.run(root, 1, 'running'));
    fake.emit(root, 'subagent.updated', { id: 'native-1', origin: 'provider_native', driver: 'codex', providerInstanceId: 'codex', model: 'gpt-test', childThreadId: null, status: 'running' });
    fake.emit(root, 'subagent.updated', { id: 'native-2', origin: 'provider_native', driver: 'codex', providerInstanceId: 'codex', model: 'gpt-test', childThreadId: null, status: 'running' });
  };
  fake.state.onCommand = command => {
    if (command.type !== 'run.interrupt') return;
    for (const id of ['native-1', 'native-2']) fake.emit(command.threadId, 'subagent.updated', { id, origin: 'provider_native', driver: 'codex', status: 'interrupted' });
    fake.emit(command.threadId, 'run.updated', build.run(command.threadId, 1, 'interrupted'));
  };
  const result = await executor.run(assignment(), ctx);
  assert.equal(result.outcome, 'failure');
  assert.match(result.summary, /provider-native subagent its policy does not allow/);
  assert.deepEqual(progress('agent.delegated').map(item => [item.kind, item.allowed]), [['provider_native', true], ['provider_native', false]]);
  assert.equal(fake.commandsOf('run.interrupt').length, 1);
});

test('blocks and interrupts on an approval request', async t => {
  const { fake, executor, ctx, progress } = await harness(t);
  fake.state.onLaunch = launch => {
    const root = launch.threadId;
    fake.emit(root, 'run.updated', build.run(root, 1, 'waiting'));
    fake.emit(root, 'runtime-request.updated', { id: 'req-1', kind: 'user_input', status: 'pending' });
    fake.emit(root, 'turn-item.updated', { id: 'item-q', runId: build.run(root, 1).id, type: 'user_input_request', status: 'waiting', requestId: 'req-1', questions: [{ id: 'q1', header: 'DB', question: 'Which database should I use?' }] });
  };
  fake.state.onCommand = command => {
    if (command.type !== 'run.interrupt') return;
    fake.emit(command.threadId, 'runtime-request.updated', { id: 'req-1', kind: 'user_input', status: 'cancelled' });
    fake.emit(command.threadId, 'turn-item.updated', { id: 'item-q', type: 'user_input_request', status: 'cancelled', requestId: 'req-1' });
    fake.emit(command.threadId, 'run.updated', build.run(command.threadId, 1, 'interrupted'));
  };
  const result = await executor.run(assignment(), ctx);
  assert.equal(result.outcome, 'blocked');
  assert.match(result.summary, /Which database should I use\?/);
  assert.deepEqual(progress('runtime.request').map(item => [item.kind, item.questions[0].id]), [['user_input', 'q1']]);
});

test('cancellation interrupts the active run and rejects', async t => {
  const { fake, executor, ctx, controller } = await harness(t);
  fake.state.onLaunch = launch => {
    fake.emit(launch.threadId, 'run.updated', build.run(launch.threadId, 1, 'running'));
    setTimeout(() => controller.abort(new Error('lease lost')), 50);
  };
  fake.state.onCommand = command => {
    if (command.type === 'run.interrupt') fake.emit(command.threadId, 'run.updated', build.run(command.threadId, 1, 'interrupted'));
  };
  await assert.rejects(executor.run(assignment(), ctx), /lease lost/);
  assert.equal(fake.commandsOf('run.interrupt').length, 1);
  assert.equal(fake.commandsOf('run.interrupt')[0].payload.holdQueue, true);
});

test('reports provider failures such as usage limits', async t => {
  const { fake, executor, ctx, progress } = await harness(t);
  fake.state.onLaunch = launch => {
    const root = launch.threadId;
    fake.emit(root, 'run.updated', build.run(root, 1, 'running'));
    fake.emit(root, 'turn-item.updated', { id: 'err-1', runId: build.run(root, 1).id, type: 'error', status: 'failed', failure: { class: 'usage_limit', message: 'Usage limit reached', code: 'api_error_429', retryable: true, resetAt: '2026-10-21T05:00:00.000Z' } });
    fake.emit(root, 'run.updated', build.run(root, 1, 'failed'));
  };
  const result = await executor.run(assignment(), ctx);
  assert.equal(result.outcome, 'failure');
  assert.match(result.summary, /^usage_limit: Usage limit reached/);
  assert.deepEqual(progress('provider.failure').map(item => [item.class, item.resetAt]), [['usage_limit', '2026-10-21T05:00:00.000Z']]);
});

test('resubscribes after a dropped connection using the last sequence', async t => {
  const { fake, executor, ctx } = await harness(t);
  fake.state.onLaunch = launch => {
    const root = launch.threadId;
    fake.emit(root, 'run.updated', build.run(root, 1, 'running'));
    setTimeout(() => {
      fake.dropSockets();
      // Emitted while disconnected; T3 replays them after `afterSequence`.
      fake.emit(root, 'turn-item.updated', build.assistant(root, 1, 'Recovered.'));
      fake.emit(root, 'run.updated', build.run(root, 1, 'completed'));
    }, 50);
  };
  const result = await executor.run(assignment(), ctx);
  assert.equal(result.outcome, 'success');
  assert.equal(result.summary, 'Recovered.');
  assert.ok(fake.state.subscriptions.some(item => Number.isSafeInteger(item.afterSequence)), 'resumed from a sequence');
  assert.ok(fake.state.tickets >= 2, 'a fresh WebSocket ticket was used');
});

test('falls back to observation when the runtime has no policy routes', async t => {
  const { fake, executor, ctx, progress } = await harness(t, { policyRoutes: false });
  fake.state.onLaunch = launch => completeTurn(fake, launch.threadId, { text: 'ok' });
  const result = await executor.run(assignment(), ctx);
  assert.equal(result.outcome, 'success');
  assert.equal(progress('policy.unenforced').length, 1);
});

test('blocks when no ready provider instance exists, and canRun filters providers', async t => {
  const { executor, ctx, fake } = await harness(t);
  const result = await executor.run(assignment({ harness: { provider: 'cursor', model: 'x' } }), ctx);
  assert.equal(result.outcome, 'blocked');
  assert.equal(fake.state.commands.length, 0);
  assert.equal(executor.canRun(assignment(), { providers: ['codex'] }), true);
  assert.equal(executor.canRun(assignment(), { providers: ['claudeAgent'] }), false);
  assert.equal(executor.canRun(assignment({ harness: { provider: 'fake', model: 'x' } }), {}), false);
  assert.equal(chooseInstance([{ instanceId: 'work', driver: 'codex', status: 'ready' }, { instanceId: 'codex', driver: 'codex', status: 'ready' }], 'codex', 'work').instanceId, 'work');
});

test('works in a T3 worktree for a local checkout and reports its branch and head', async t => {
  const { fake, executor, ctx, workspace } = await harness(t);
  const repo = join(workspace, 'source');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  fake.state.onLaunch = launch => {
    // Simulate T3 provisioning the worktree for the requested branch.
    const worktree = join(workspace, 'wt');
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', launch.workspaceStrategy.branch, worktree, 'main']);
    fake.thread(launch.threadId).thread.worktreePath = worktree;
    completeTurn(fake, launch.threadId, { text: 'Done.' });
  };
  const result = await executor.run(assignment({ repo: { localPath: repo, defaultBranch: 'main' } }), ctx);
  const launch = fake.state.commands.find(item => item.tag === 'orchestration.launchThread').payload;
  assert.deepEqual(launch.workspaceStrategy, { type: 'worktree', baseRef: 'main', branch: 'perpeto/wi_1', startFromOrigin: false });
  assert.equal(result.branch, 'perpeto/wi_1');
  assert.equal(result.headSha, head);
  // A rework assignment for the same item reuses the existing worktree.
  fake.state.onLaunch = launch => completeTurn(fake, launch.threadId, { text: 'Again.' });
  await executor.run(assignment({ repo: { localPath: repo, defaultBranch: 'main' } }), ctx);
  const second = fake.state.commands.filter(item => item.tag === 'orchestration.launchThread')[1].payload;
  assert.equal(second.workspaceStrategy.type, 'existing_worktree');
  assert.equal(second.workspaceStrategy.branch, 'perpeto/wi_1');
});

test('prompt requires text and credential files must be owner-only', async t => {
  assert.throws(() => buildPrompt({ prompt: '  ' }), /prompt is required/);
  assert.match(buildPrompt({ prompt: 'x', policy: { maxSubagents: 0, allowedSubagentProviders: [] } }), /do not create subagents/);
  const directory = await mkdtemp(join(tmpdir(), 't3-executor-cred-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'session.secret');
  await writeFile(file, 'abc\n', { mode: 0o644 });
  await assert.rejects(readCredentialFile(file), /owner-only/);
  await chmod(file, 0o600);
  assert.equal(await readCredentialFile(file), 'abc');
});
