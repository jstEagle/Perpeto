import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startFakeT3, build } from '../../t3-executor/test/fake-t3.js';
import { createT3Observer, READ_ONLY_RPCS, ReadOnlyT3Client, OBSERVER_SCOPES, usageOf, providerSnapshots } from '../src/index.js';

async function eventually(check, timeout = 5000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = await check(); if (value) return value; await sleep(10); }
  throw new Error('Condition did not become true.');
}

/** A temp T3 home with server-runtime.json pointing at the fake, and a stand-in for T3's own CLI. */
async function setup(t, { providers } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'perpeto-t3-home-'));
  const baseDir = join(home, 'userdata');
  const dataDir = join(home, 'node');
  const fake = await startFakeT3({ providers });
  const argsFile = join(home, 'cli-args');
  const cli = join(home, 't3');
  await writeFile(cli, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${argsFile}"\necho test-token\n`); await chmod(cli, 0o700);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(baseDir, { recursive: true });
  const runtime = url => writeFile(join(baseDir, 'server-runtime.json'), JSON.stringify({ version: 1, pid: 1, host: '127.0.0.1', port: Number(new URL(url).port), origin: url, serverVersion: '0.1.1-test', ownerId: 'x' }));
  await runtime(fake.url);
  const observers = [];
  const f = { fake, home, baseDir, dataDir, cli, argsFile, runtime,
    observer(options = {}) {
      const observer = createT3Observer({ t3BaseDir: baseDir, dataDir, cli, pollMs: 20, reconnectMinMs: 10, reconnectMaxMs: 50, pingMs: 0, ...options });
      observers.push(observer); return observer.start();
    } };
  t.after(async () => { for (const observer of observers) await observer.stop(); await f.fake.close(); await rm(home, { recursive: true, force: true }); });
  return f;
}

const usageTurn = (threadId, ordinal, usage, extra = {}) => ({ ...build.usage(threadId, ordinal, usage), runAttemptId: `att:${threadId}:${ordinal}`, ...extra });
function seedThread(fake, threadId, turns) {
  const value = fake.thread(threadId);
  for (const [ordinal, usage, model] of turns) {
    value.runs.set(`run:${threadId}:${ordinal}`, build.run(threadId, ordinal, 'completed', { providerInstanceId: 'claudeAgent', modelSelection: { instanceId: 'claudeAgent', model } }));
    value.attempts.set(`att:${threadId}:${ordinal}`, { id: `att:${threadId}:${ordinal}`, runId: `run:${threadId}:${ordinal}` });
    value.providerTurns.set(`turn:${threadId}:${ordinal}`, usageTurn(threadId, ordinal, usage));
    value.turnItems.set(`msg:${ordinal}`, { id: `msg:${ordinal}`, type: 'assistant_message', text: 'SECRET MESSAGE CONTENT' });
  }
}

test('mints one orchestration:read session with T3 CLI, keeps it 0600, and maps the shell to sessions', async t => {
  const f = await setup(t, { providers: [
    { instanceId: 'claudeAgent', driver: 'claudeAgent', displayName: 'Claude', enabled: true, status: 'ready',
      auth: { status: 'authenticated', type: 'Claude Max', label: 'Claude Max Subscription', email: 'operator@example.com' },
      usageLimits: { checkedAt: '2026-10-22T08:00:00.000Z', credentialFingerprint: 'fp-secret', windows: [
        { id: 'five_hour', kind: 'session', label: 'Session', usedPercent: 12, resetsAt: '2026-10-22T10:00:00.000Z', windowDurationMins: 300 },
        { id: 'seven_day', kind: 'weekly', label: 'Weekly', usedPercent: 40, resetsAt: '2026-10-25T00:00:00.000Z', windowDurationMins: 10080 }] } },
    { instanceId: 'codex', driver: 'codex', enabled: true, status: 'ready', auth: { status: 'authenticated', type: 'apiKey', label: 'sk-…' } },
    { instanceId: 'cursor', driver: 'cursor', enabled: false, status: 'disabled' }] });
  const { fake } = f;
  fake.state.shell.projects = [build.project('p1', { title: 'Perpeto', workspaceRoot: '/Users/operator/code/perpeto' })];
  const thread = (id, extra) => fake.state.shell.threads.set(id, build.shellThread(id, extra));
  thread('t-run', { status: 'running', activeRunId: 'r1', activityRunStatus: 'running', latestRunId: 'r1', latestRunStartedAt: '2026-10-22T08:10:00.000Z', branch: 'feature/x', worktreePath: '/Users/operator/.t3/worktrees/perpeto/feature-x',
    latestVisibleMessage: { id: 'm1', role: 'assistant', text: 'SECRET PREVIEW', updatedAt: '2026-10-22T08:11:00.000Z' } });
  thread('t-wait', { status: 'waiting', activeRunId: 'r2', pendingRuntimeRequest: { id: 'req1', kind: 'command', createdAt: '2026-10-22T08:12:00.000Z' } });
  thread('t-err', { status: 'failed', latestRunId: 'r3', latestRunCompletedAt: '2026-10-22T08:05:00.000Z' });
  thread('t-child', { status: 'completed', lineage: { parentThreadId: 't-run', relationshipToParent: 'subagent', rootThreadId: 't-run' }, providerInstanceId: 'codex', modelSelection: { instanceId: 'codex', model: 'gpt-test' } });
  thread('t-gone', { deletedAt: '2026-10-22T08:00:00.000Z' });

  const observer = f.observer();
  await observer.ready();
  const batch = observer.collect();
  assert.ok(batch.resync?.final, 'the first batch after start is a complete resync');
  const byId = Object.fromEntries(batch.sessions.map(session => [session.threadId, session]));
  assert.deepEqual(Object.keys(byId).sort(), ['t-child', 't-err', 't-run', 't-wait']);
  assert.deepEqual(byId['t-run'], { threadId: 't-run', title: 'Thread t-run', project: { name: 'Perpeto', path: 'perpeto' }, branch: 'feature/x', worktree: 'feature-x',
    provider: 'claudeAgent', providerInstanceId: 'claudeAgent', model: 'claude-test', status: 'running', createdAt: '2026-10-22T08:00:00.000Z', lastActivityAt: '2026-10-22T08:10:00.000Z', turns: 0 });
  assert.equal(byId['t-wait'].status, 'waiting');
  assert.equal(byId['t-err'].status, 'error');
  assert.equal(byId['t-child'].status, 'idle');
  assert.equal(byId['t-child'].parentThreadId, 't-run');
  assert.equal(byId['t-child'].provider, 'codex');
  // Providers: plan from the subscription auth label, windows without fingerprints; no emails, no API-key logins.
  assert.deepEqual(batch.providers, [{ instanceId: 'claudeAgent', driver: 'claudeAgent', displayName: 'Claude', plan: 'Claude Max Subscription', status: 'ready',
    usage: { checkedAt: '2026-10-22T08:00:00.000Z', windows: [
      { id: 'five_hour', kind: 'session', label: 'Session', usedPercent: 12, resetsAt: '2026-10-22T10:00:00.000Z', windowMins: 300 },
      { id: 'seven_day', kind: 'weekly', label: 'Weekly', usedPercent: 40, resetsAt: '2026-10-25T00:00:00.000Z', windowMins: 10080 }] } }]);
  const wire = JSON.stringify(batch);
  for (const secret of ['SECRET', 'operator@example.com', 'fp-secret', 'test-token']) assert.ok(!wire.includes(secret), `${secret} must not leave the machine`);

  // The session was minted with T3's own CLI, read-only scope only, and stored owner-only.
  const args = (await readFile(f.argsFile, 'utf8')).trim().split('\n');
  assert.deepEqual(args.filter((_, index) => args[index - 1] === '--scope'), ['orchestration:read']);
  assert.deepEqual(OBSERVER_SCOPES, ['orchestration:read']);
  assert.equal(args[args.indexOf('--base-dir') + 1], f.home);
  const file = join(f.dataDir, 't3-observer-session.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).token, 'test-token');

  // Titles are optional.
  const quiet = f.observer({ includeTitles: false, dataDir: join(f.home, 'quiet') });
  await quiet.ready();
  assert.ok(quiet.collect().sessions.every(session => session.title === undefined));
});

test('usage: per-turn records subtract cache, dedupe by provider turn, survive reconnects and only send unacknowledged turns', async t => {
  const f = await setup(t);
  const { fake } = f;
  fake.state.shell.projects = [build.project('p1')];
  fake.state.shell.threads.set('t1', build.shellThread('t1', { latestRunId: 'run:t1:1', latestRunCompletedAt: '2026-10-22T08:20:00.000Z', status: 'completed' }));
  fake.state.shell.threads.set('legacy', build.shellThread('legacy', { historyOrigin: 'v1_import', latestRunCompletedAt: '2026-10-22T08:20:00.000Z' }));
  seedThread(fake, 't1', [[1, { inputTokens: 1000, cachedInputTokens: 600, cacheCreationTokens: 100, outputTokens: 50, reasoningTokens: 10 }, 'claude-opus']]);
  const observer = f.observer({ backfillHours: 24 * 365 * 10 });
  await observer.ready();
  await eventually(() => observer.status.pendingUsage === 1);
  let batch = observer.collect();
  assert.deepEqual(batch.usage, [{ providerTurnId: 'turn:t1:1', threadId: 't1', providerInstanceId: 'claudeAgent', provider: 'claudeAgent', model: 'claude-opus',
    inputTokens: 300, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: 100, reasoningTokens: 10, usageStatus: 'complete', at: '2026-10-21T00:00:05.000Z' }]);
  assert.equal(batch.sessions.find(session => session.threadId === 't1').turns, 1);
  assert.ok(!fake.state.subscriptions.some(item => item.threadId === 'legacy'), 'imported v1 threads are never subscribed (T3 would hydrate them)');
  // Not acknowledged: offered again.
  batch = observer.collect();
  assert.equal(batch.usage.length, 1);
  assert.ok(observer.acknowledge(batch));
  assert.equal(observer.collect()?.usage, undefined);

  // A second turn finishes; the shell moves; only the new turn is sent.
  seedThread(fake, 't1', [[2, { inputTokens: 200, outputTokens: 20 }, 'claude-opus']]);
  fake.setShellThread(build.shellThread('t1', { latestRunId: 'run:t1:2', latestRunCompletedAt: '2026-10-22T08:30:00.000Z', status: 'completed' }));
  await eventually(() => observer.status.pendingUsage === 1);
  batch = observer.collect();
  assert.deepEqual(batch.usage.map(record => record.providerTurnId), ['turn:t1:2']);
  assert.deepEqual(batch.sessions.map(session => [session.threadId, session.turns, session.lastActivityAt]), [['t1', 2, '2026-10-22T08:30:00.000Z']]);
  observer.acknowledge(batch);

  // The socket drops; the observer reconnects on its own, and a thread removed meanwhile is reported removed.
  const subscriptionsBefore = fake.state.rpcs.filter(tag => tag === 'orchestration.subscribeShell').length;
  fake.state.shell.threads.delete('legacy');
  fake.dropSockets();
  await eventually(() => fake.state.rpcs.filter(tag => tag === 'orchestration.subscribeShell').length > subscriptionsBefore && observer.connected);
  batch = await eventually(() => { const value = observer.collect(); return value?.removedThreadIds ? value : null; });
  assert.deepEqual(batch.removedThreadIds, ['legacy']);
  assert.equal(batch.usage, undefined, 'acknowledged turns are not re-sent after a reconnect');

  // Read-only: only the ticket over HTTP and the three read RPCs, ever.
  assert.ok(fake.state.rpcs.length > 0);
  assert.ok(fake.state.rpcs.every(tag => READ_ONLY_RPCS.includes(tag)), fake.state.rpcs.join(','));
  assert.ok(fake.state.requests.every(request => request.method === 'POST' && request.path === '/api/auth/websocket-ticket'));
  assert.equal(fake.state.commands.length, 0);
});

test('tolerates a T3 restart on a new port and a revoked session (re-mints once), and refuses mutating RPCs', async t => {
  const f = await setup(t);
  f.fake.state.shell.threads.set('a', build.shellThread('a', { status: 'idle' }));
  const observer = f.observer({ mintIntervalMs: 0 });
  await observer.ready();
  assert.deepEqual(observer.collect().sessions.map(session => session.threadId), ['a']);

  // T3 restarts: the old server goes away, a new one listens elsewhere and rejects the old session.
  await f.fake.close();
  const restarted = await startFakeT3({ token: 'second-token' });
  f.fake = restarted;
  restarted.state.shell.threads.set('b', build.shellThread('b', { status: 'running', activeRunId: 'rb' }));
  await f.runtime(restarted.url);
  await writeFile(f.cli, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${f.argsFile}"\necho second-token\n`);
  await eventually(() => observer.connected && observer.status.sessions === 1 && observer.status.running === 1, 8000);
  const mints = (await readFile(f.argsFile, 'utf8')).split('\n').filter(line => line === 'issue').length;
  assert.equal(mints, 2, 'one mint at start, one after T3 rejected the old session');
  const batch = observer.collect();
  assert.deepEqual(batch.removedThreadIds, ['a']);
  assert.deepEqual(batch.sessions.map(session => [session.threadId, session.status]), [['b', 'running']]);
  assert.ok(restarted.state.rpcs.every(tag => READ_ONLY_RPCS.includes(tag)));

  // The client itself refuses anything that is not a read.
  const client = new ReadOnlyT3Client({ baseUrl: restarted.url, token: 'second-token', pingMs: 0 });
  t.after(() => client.close());
  for (const tag of ['orchestration.dispatchCommand', 'orchestration.launchThread', 'server.updateSettings', 'server.refreshProviders', 'projects.mutate']) {
    await assert.rejects(client.request(tag, {}), /only reads/);
  }
  assert.ok(!restarted.state.rpcs.some(tag => !READ_ONLY_RPCS.includes(tag)));
});

test('resync batches are chunked; status pings are sent when nothing changed', async t => {
  const f = await setup(t);
  for (let index = 0; index < 5; index++) f.fake.state.shell.threads.set(`t${index}`, build.shellThread(`t${index}`));
  const observer = f.observer({ maxBatchSessions: 2, statusEveryMs: 50 });
  await observer.ready();
  const seen = new Set(); let final = false; let resyncId;
  for (let round = 0; round < 3; round++) {
    const batch = observer.collect();
    resyncId ??= batch.resync.id;
    assert.equal(batch.resync.id, resyncId);
    batch.sessions.forEach(session => seen.add(session.threadId));
    final = batch.resync.final;
    observer.acknowledge(batch);
  }
  assert.ok(final); assert.equal(seen.size, 5);
  assert.equal(observer.collect(), null, 'nothing changed');
  await sleep(60);
  const ping = observer.collect();
  assert.deepEqual([ping.sessions.length, ping.source.connected], [0, true]);
});

test('pure mapping: usage without completed billing is skipped, API-key plans and emails never become plans', () => {
  const thread = { id: 't', providerInstanceId: 'codex', modelSelection: { model: 'gpt' }, createdAt: '2026-10-22T00:00:00.000Z' };
  const providers = new Map([['codex', { driver: 'codex' }]]);
  const { records, turns } = usageOf({ runs: [{ id: 'r', ordinal: 3 }], providerTurns: [
    { id: 'running', status: 'running', turnTokenUsage: { usageStatus: 'complete', inputTokens: 1, outputTokens: 1 } },
    { id: 'none', status: 'completed', turnTokenUsage: { usageStatus: 'unavailable' } },
    { id: 'ok', status: 'completed', completedAt: '2026-10-22T01:00:00.000Z', turnTokenUsage: { usageStatus: 'partial', inputTokens: 5, outputTokens: 2 } }] }, thread, providers);
  assert.deepEqual(records.map(record => [record.providerTurnId, record.provider, record.model, record.inputTokens]), [['ok', 'codex', 'gpt', 5]]);
  assert.equal(turns, 3);
  assert.deepEqual(providerSnapshots([{ instanceId: 'x', driver: 'codex', enabled: true, auth: { type: 'chatgpt', label: 'someone@example.com' } }]), []);
});
