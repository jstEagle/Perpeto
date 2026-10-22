import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeT3, build } from '../../../packages/t3-executor/test/fake-t3.js';
import { READ_ONLY_RPCS } from '@perpeto/t3-observer';
import { eventually, startFactory } from './support.js';

/**
 * Observe-only: a real hub and node daemon with no agent or CI slots watch a fake T3 desktop server (real HTTP and
 * T3's RPC framing, contract-checked shell items) and the hub serves sessions, usage, observed accounts and advisory
 * pacing. The fake records every RPC, so the test proves the node never sent T3 anything but reads.
 */
test('observe-only node reports an operator T3 to the hub without changing it', async t => {
  const fake = await startFakeT3({ providers: [{ instanceId: 'claudeAgent', driver: 'claudeAgent', displayName: 'Claude', enabled: true, status: 'ready',
    auth: { status: 'authenticated', type: 'Claude Max', label: 'Claude Max Subscription', email: 'operator@example.com' },
    usageLimits: { checkedAt: new Date().toISOString(), windows: [
      { id: 'five_hour', kind: 'session', label: 'Session', usedPercent: 20, resetsAt: new Date(Date.now() + 3 * 3600000).toISOString(), windowDurationMins: 300 },
      { id: 'seven_day', kind: 'weekly', label: 'Weekly', usedPercent: 40, resetsAt: new Date(Date.now() + 4 * 86400000).toISOString(), windowDurationMins: 10080 }] } }] });
  t.after(() => fake.close());
  const home = await mkdtemp(join(tmpdir(), 'perpeto-e2e-t3-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const baseDir = join(home, 'userdata'); await mkdir(baseDir);
  await writeFile(join(baseDir, 'server-runtime.json'), JSON.stringify({ origin: fake.url, serverVersion: '0.1.1-e2e' }));
  const cli = join(home, 't3'); await writeFile(cli, '#!/bin/sh\necho test-token\n'); await chmod(cli, 0o700);

  const now = new Date().toISOString();
  fake.state.shell.projects = [build.project('p1', { title: 'Perpeto', workspaceRoot: '/Users/operator/code/perpeto' })];
  fake.state.shell.threads.set('root', build.shellThread('root', { status: 'running', activeRunId: 'r2', activityRunStatus: 'running', latestRunId: 'r2', latestRunStartedAt: now, createdAt: now, updatedAt: now }));
  fake.state.shell.threads.set('child', build.shellThread('child', { status: 'completed', latestRunId: 'run:child:1', latestRunCompletedAt: now, createdAt: now, updatedAt: now,
    lineage: { parentThreadId: 'root', relationshipToParent: 'subagent', rootThreadId: 'root' } }));
  const child = fake.thread('child');
  child.runs.set('run:child:1', build.run('child', 1, 'completed', { providerInstanceId: 'claudeAgent', modelSelection: { instanceId: 'claudeAgent', model: 'claude-sonnet' } }));
  child.attempts.set('att:1', { id: 'att:1', runId: 'run:child:1' });
  child.providerTurns.set('turn:child:1', { ...build.usage('child', 1, { inputTokens: 5000, cachedInputTokens: 4000, cacheCreationTokens: 500, outputTokens: 300 }), runAttemptId: 'att:1', completedAt: now });

  const factory = await startFactory(t, { executor: { kind: 'none', canRun: () => false, run: async () => ({ outcome: 'failure', summary: 'unused' }) },
    node: { capacity: { maxAgents: 0, maxJobs: 0 }, fake: undefined, accounts: undefined, observe: { enabled: true, t3BaseDir: baseDir, cli, pollMs: 500 } } });

  const sessions = await eventually(async () => {
    const page = await factory.request('GET', '/sessions');
    return page.sessions.length === 2 && page.sessions.some(item => item.tokens.output === 300) ? page.sessions : null;
  }, { message: 'sessions did not reach the hub' });
  const root = sessions.find(item => item.threadId === 'root');
  assert.deepEqual([root.status, root.childCount, root.machineName, root.project], ['running', 1, 'e2e-machine', { name: 'Perpeto', path: 'perpeto' }]);
  assert.deepEqual(sessions.find(item => item.threadId === 'child').tokens, { input: 500, output: 300, cacheRead: 4000, cacheWrite: 500, reasoning: 0 });

  const accounts = (await factory.request('GET', '/accounts')).accounts;
  assert.deepEqual(accounts.map(account => [account.source, account.provider, account.plan]), [['observed', 'claudeAgent', 'Claude Max Subscription']]);
  const pacing = await factory.request('GET', '/pacing');
  assert.equal(pacing.mode, 'advise');
  assert.equal(pacing.accounts[0].runningAgents, 1);
  assert.equal(typeof pacing.accounts[0].headroomAgents, 'number');
  const summary = await factory.request('GET', '/sessions/summary?window=24h');
  assert.deepEqual([summary.machines[0].observing, summary.totals.running], [true, 1]);
  assert.equal((await factory.request('GET', '/usage?source=observed')).totals.outputTokens, 300);
  assert.equal(factory.node.status.observe.connected, true);

  // T3 drops the connection; the node reconnects and keeps reporting.
  fake.dropSockets();
  fake.state.shell.threads.set('later', build.shellThread('later', { createdAt: new Date().toISOString() }));
  await eventually(async () => (await factory.request('GET', '/sessions')).sessions.some(item => item.threadId === 'later'), { message: 'reconnect did not resume observation' });

  // Nothing but reads ever reached T3, and the session file stays owner-only.
  assert.ok(fake.state.rpcs.length > 0 && fake.state.rpcs.every(tag => READ_ONLY_RPCS.includes(tag)), fake.state.rpcs.join(','));
  assert.ok(fake.state.requests.every(request => request.method === 'POST' && request.path === '/api/auth/websocket-ticket'));
  assert.equal(fake.state.commands.length, 0);
  assert.equal((await stat(join(factory.nodeDataDir, 't3-observer-session.json'))).mode & 0o777, 0o600);
  const wire = JSON.stringify(await factory.request('GET', '/sessions')) + JSON.stringify(accounts);
  assert.ok(!wire.includes('operator@example.com') && !wire.includes('test-token'));
  // With no slots the node never asks for work.
  assert.ok(!(await factory.events()).some(event => event.type.endsWith('.leased')));
});
