import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { createT3Executor, T3Client, parseRoleResult, outputKind } from '../src/index.js';
import { startFakeT3, build } from './fake-t3.js';
import { createAccountProvider } from '../../factory-node/src/index.js';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();

async function setup(t, { accountProvider, fakeOptions } = {}) {
  const fake = await startFakeT3(fakeOptions);
  const root = await mkdtemp(join(tmpdir(), 'factory-t3-int-'));
  const executor = createT3Executor({ accountProvider, config: { url: fake.url, settleMs: 30, pollMs: 10, interruptGraceMs: 300, accountReadyTimeoutMs: 500 },
    createClient: settings => new T3Client({ baseUrl: settings.url, token: 'test-token', pingMs: 0 }) });
  const events = [];
  let workspaces = 0;
  const ctx = async () => { const workspace = join(root, `ws-${++workspaces}`); execFileSync('mkdir', ['-p', workspace]); return { signal: new AbortController().signal, workspace, report: async event => { events.push(event); } }; };
  t.after(async () => { await executor.close(); await fake.close(); await rm(root, { recursive: true, force: true }); });
  return { fake, executor, ctx, events, root };
}
const base = extra => ({ id: `asg_${Math.random().toString(36).slice(2)}`, runId: 'run_1', workItemId: 'wi_7', role: 'builder', nodeType: 'agent', attempt: 1,
  prompt: 'Do the work.', harness: { provider: 'codex', model: 'gpt-test' }, policy: { maxSubagents: 0, allowedSubagentProviders: [], canMessage: [] }, ...extra });
function reply(fake, text, before) {
  fake.state.onLaunch = launch => {
    const root = launch.threadId;
    fake.emit(root, 'run.updated', build.run(root, 1, 'running'));
    before?.(launch);
    fake.emit(root, 'turn-item.updated', build.assistant(root, 1, text));
    fake.emit(root, 'run.updated', build.run(root, 1, 'completed'));
  };
}

test('reviews return a verdict from a fenced json block, with feedback as summary', async t => {
  const { fake, executor, ctx } = await setup(t);
  reply(fake, 'Looked at it.\n```json\n{"verdict": "fail", "summary": "Add tests for the login path."}\n```');
  const result = await executor.run(base({ nodeType: 'review', role: 'reviewer' }), await ctx());
  assert.equal(result.outcome, 'success');
  assert.equal(result.verdict, 'fail');
  assert.equal(result.summary, 'Add tests for the login path.');
  const prompt = fake.state.commands.find(item => item.tag === 'orchestration.launchThread').payload.initialMessage.text;
  assert.match(prompt, /"verdict": "pass" \| "fail"/);
  // No verdict leaves the result without one, which the engine retries as an error.
  reply(fake, 'I could not decide.');
  const undecided = await executor.run(base({ nodeType: 'review' }), await ctx());
  assert.equal(undecided.outcome, 'success');
  assert.equal(undecided.verdict, undefined);
});

test('planners return items, and a missing items block fails the attempt', async t => {
  const { fake, executor, ctx } = await setup(t);
  reply(fake, 'Plan:\n```json\n{"items": [{"title": "Login form", "body": "Email and password."}, {"title": "Session"}]}\n```');
  const result = await executor.run(base({ nodeType: 'planner', role: 'planner' }), await ctx());
  assert.deepEqual(result.items, [{ title: 'Login form', body: 'Email and password.' }, { title: 'Session' }]);
  reply(fake, 'Here are some ideas: login, sessions.');
  const missing = await executor.run(base({ nodeType: 'planner' }), await ctx());
  assert.equal(missing.outcome, 'failure');
  assert.match(missing.summary, /no fenced json block with an items list/);
});

test('the workflow architect returns graph and rationale', async t => {
  const { fake, executor, ctx } = await setup(t);
  const graph = { schema: 'perpeto.workflow/1', nodes: [], edges: [] };
  reply(fake, `\`\`\`json\n${JSON.stringify({ rationale: 'Small team, one review loop.', graph })}\n\`\`\``);
  const architect = { id: 'asg_arch', projectId: 'prj_1', nodeId: 'workflow-architect', role: 'workflow-architect', architectRequestId: 'wfd_1', attempt: 1,
    prompt: 'Design the workflow.', harness: { provider: 'codex', model: 'gpt-test' }, policy: { maxSubagents: 0, allowedSubagentProviders: [], canMessage: [] } };
  const result = await executor.run(architect, await ctx());
  assert.deepEqual(result.graph, graph);
  assert.equal(result.rationale, 'Small team, one review loop.');
  assert.equal(outputKind(architect), 'architect');
  // Unparseable replies pass through whole so the hub can return its parse errors to the architect.
  const long = `Prose ${'x'.repeat(9000)}`;
  assert.equal(parseRoleResult('architect', long).summary, long);
});

test('builders clone repo.url, publish the work branch and rework from it', async t => {
  const { fake, executor, ctx, root, events } = await setup(t);
  const origin = join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const seed = join(root, 'seed');
  execFileSync('git', ['clone', '-q', origin, seed]);
  await writeFile(join(seed, 'README.md'), 'hello\n');
  git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', 'init'); git(seed, 'push', '-q', 'origin', 'HEAD:main');
  const repo = { url: origin, defaultBranch: 'main' };
  let checkout;
  reply(fake, 'Added feature.', launch => {
    checkout = fake.state.projects.find(project => project.id === launch.projectId).workspaceRoot;
    writeFileSync(join(checkout, 'feature.txt'), 'one\n');
    git(checkout, 'add', '.'); git(checkout, 'commit', '-q', '-m', 'feature');
  });
  const first = await executor.run(base({ repo }), await ctx());
  assert.equal(first.outcome, 'success');
  assert.equal(first.branch, 'perpeto/wi_7');
  assert.equal(git(origin, 'rev-parse', 'refs/heads/perpeto/wi_7'), first.headSha, 'branch head published to origin');
  assert.ok(events.some(event => event.data.interaction === 'branch.published' && event.data.published));
  const prompt = fake.state.commands.find(item => item.tag === 'orchestration.launchThread').payload.initialMessage.text;
  assert.match(prompt, /Work on branch perpeto\/wi_7 and commit your changes there/);

  // A rework attempt in a fresh workspace starts from the published branch.
  reply(fake, 'Addressed feedback.', launch => {
    checkout = fake.state.projects.find(project => project.id === launch.projectId).workspaceRoot;
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), first.headSha);
    writeFileSync(join(checkout, 'feature.txt'), 'two\n');
    git(checkout, 'commit', '-q', '-am', 'rework');
  });
  const second = await executor.run(base({ repo, attempt: 2 }), await ctx());
  assert.equal(second.outcome, 'success');
  assert.equal(git(origin, 'rev-parse', 'refs/heads/perpeto/wi_7'), second.headSha);
  assert.notEqual(second.headSha, first.headSha);

  // Nothing new committed: nothing is pushed.
  reply(fake, 'Nothing to change.');
  const pushes = events.filter(event => event.data.interaction === 'branch.published').length;
  await executor.run(base({ repo, attempt: 3 }), await ctx());
  assert.equal(events.filter(event => event.data.interaction === 'branch.published').length, pushes);
});

function fakeAccounts({ bindingError } = {}) {
  const calls = [];
  const binding = { accountId: 'acct_1', providerInstanceId: 'factory_acct_1', mutation: { operation: 'upsert', instanceId: 'factory_acct_1', instance: { driver: 'codex', displayName: 'Build', enabled: true, config: { homePath: '/x' } } } };
  return { calls, provider: {
    async acquire(input) { calls.push(['acquire', input]); return { account: { id: 'acct_1', provider: 'codex' }, binding }; },
    async bindingFor(id) { calls.push(['bindingFor', id]); if (bindingError && calls.filter(c => c[0] === 'bindingFor').length > 1) throw Object.assign(new Error('x'), { code: bindingError }); return binding; },
    async observe(input) { calls.push(['observe', input]); },
    async release(selection, input) { calls.push(['release', input]); },
    async list() { return []; },
  } };
}

test('runs on a reserved account instance, reports limits to the pool and releases it', async t => {
  const accounts = fakeAccounts();
  const { fake, executor, ctx, events } = await setup(t, { accountProvider: accounts.provider });
  fake.state.onLaunch = launch => {
    const root = launch.threadId;
    fake.emit(root, 'run.updated', build.run(root, 1, 'running'));
    fake.emit(root, 'provider-turn.updated', build.usage(root, 1, { inputTokens: 10, outputTokens: 2 }));
    fake.emit(root, 'turn-item.updated', { id: 'err-9', runId: build.run(root, 1).id, type: 'error', status: 'failed', failure: { class: 'usage_limit', code: 'usageLimitExceeded', message: 'Codex usage limit reached', retryable: true } });
    fake.emit(root, 'run.updated', build.run(root, 1, 'failed'));
  };
  const result = await executor.run(base({ attempt: 2 }), await ctx());
  assert.equal(result.outcome, 'failure');
  const update = fake.state.commands.find(item => item.tag === 'server.updateSettings').payload;
  assert.deepEqual(update, { patch: {}, providerInstanceMutation: { operation: 'upsert', instanceId: 'factory_acct_1', instance: { driver: 'codex', displayName: 'Build', enabled: true, config: { homePath: '/x' } } } });
  const launch = fake.state.commands.find(item => item.tag === 'orchestration.launchThread').payload;
  assert.equal(launch.modelSelection.instanceId, 'factory_acct_1');
  assert.deepEqual(accounts.calls.map(call => call[0]), ['acquire', 'bindingFor', 'bindingFor', 'observe', 'release']);
  assert.equal(accounts.calls[0][1].provider, 'codex');
  assert.equal(accounts.calls[0][1].attempt, 2);
  const observed = accounts.calls.find(call => call[0] === 'observe')[1];
  assert.equal(observed.accountId, 'acct_1');
  assert.equal(observed.message.failure.class, 'usage_limit');
  assert.match(observed.idempotencyKey, /^observe-[0-9a-f]+$/);
  assert.equal(accounts.calls.at(-1)[1].attempt, 2);
  assert.equal(events.find(event => event.type === 'usage').data.accountId, 'acct_1');
});

test('blocks and releases when the account becomes ineligible or is not signed in', async t => {
  const accounts = fakeAccounts({ bindingError: 'ACCOUNT_UNAVAILABLE' });
  const { fake, executor, ctx } = await setup(t, { accountProvider: accounts.provider });
  const result = await executor.run(base(), await ctx());
  assert.equal(result.outcome, 'blocked');
  assert.match(result.summary, /no longer eligible \(ACCOUNT_UNAVAILABLE\)/);
  assert.equal(fake.commandsOf('run.interrupt').length, 0);
  assert.equal(fake.state.commands.filter(item => item.tag === 'orchestration.launchThread').length, 0);
  assert.equal(accounts.calls.at(-1)[0], 'release');

  const signedOut = fakeAccounts();
  const second = await setup(t, { accountProvider: signedOut.provider });
  second.fake.state.newInstanceStatus = 'error';
  second.fake.state.newInstanceAuth = 'unauthenticated';
  const blocked = await second.executor.run(base(), await second.ctx());
  assert.equal(blocked.outcome, 'blocked');
  assert.match(blocked.summary, /not signed in/);
  assert.deepEqual(signedOut.calls.find(call => call[0] === 'observe')[1].message, { failure: { code: 'auth_required', message: 'Not logged in' } });
  assert.equal(signedOut.calls.at(-1)[0], 'release');
});

test('with the real node account provider, a usage limit cools the reserved account', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'factory-t3-pool-'));
  const home = await mkdtemp(join(tmpdir(), 'factory-t3-codex-home-'));
  t.after(() => Promise.all([rm(dataDir, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  await chmod(dataDir, 0o700); await chmod(home, 0o700);
  // Synthetic fixture credential; no real account is read.
  await writeFile(join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'fixture-secret', refresh_token: 'fixture-refresh' } }), { mode: 0o600 });
  const accounts = createAccountProvider({ config: {}, dataDir });
  accounts.bind({ machineId: 'mch_test' });
  const account = accounts.pool.importAccount({ provider: 'codex', label: 'Fixture', source: { kind: 'provider-home', homePath: home }, idempotencyKey: 'import-fixture' });
  const { fake, executor, ctx } = await setup(t, { accountProvider: accounts });
  fake.state.onLaunch = launch => {
    const root = launch.threadId;
    fake.emit(root, 'run.updated', build.run(root, 1, 'running'));
    fake.emit(root, 'turn-item.updated', { id: 'err-1', runId: build.run(root, 1).id, type: 'error', status: 'failed', failure: { class: 'usage_limit', code: 'usageLimitExceeded', message: 'Codex usage limit reached', retryable: true, resetAt: new Date(Date.now() + 3600_000).toISOString() } });
    fake.emit(root, 'run.updated', build.run(root, 1, 'failed'));
  };
  const result = await executor.run(base(), await ctx());
  assert.equal(result.outcome, 'failure');
  const launch = fake.state.commands.find(item => item.tag === 'orchestration.launchThread').payload;
  assert.equal(launch.modelSelection.instanceId, `factory_${account.id}`);
  const [listed] = await accounts.list();
  assert.equal(listed.status, 'cooling');
  assert.ok(Date.parse(listed.cooldownUntil) > Date.now());
  // The reservation was released, so another attempt can take the account once it recovers.
  assert.equal(JSON.stringify(fake.state.commands).includes('fixture-secret'), false);
});
