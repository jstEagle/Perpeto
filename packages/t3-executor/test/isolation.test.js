import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, lstat, readlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { createT3Executor, T3Client } from '../src/index.js';
import { DEFAULT_GIT_IDENTITY, factoryInstance, gitEnvironment, resolveIsolation } from '../src/isolation.js';
import { startFakeT3, build } from './fake-t3.js';

// Live acceptance run 1, finding 2: factory agents loaded the operator's personal instructions
// and committed under the operator's Git identity.

async function temp(t, prefix) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
const envOf = mutation => Object.fromEntries(mutation.instance.environment.map(variable => [variable.name, variable.value]));

test('the default factory identity is Perpeto Agent, configurable per node, and validated', () => {
  assert.deepEqual(DEFAULT_GIT_IDENTITY, { name: 'Perpeto Agent', email: 'agents@perpeto.local' });
  assert.equal(resolveIsolation({ agentHomesDir: '/h' }).mode, 'factory');
  assert.deepEqual(resolveIsolation({ agentHomesDir: '/h', gitIdentity: { name: 'Shop Bot', email: 'bot@shop.test' } }).identity, { name: 'Shop Bot', email: 'bot@shop.test' });
  assert.equal(resolveIsolation({ baseDir: '/t3' }).homesDir, '/t3/perpeto-agent-homes');
  for (const gitIdentity of [{ name: 'A\nB', email: 'a@b.c' }, { name: 'Bot', email: 'not-an-email' }, { name: 'Bot <x>', email: 'a@b.c' }, 'Bot']) {
    assert.throws(() => resolveIsolation({ agentHomesDir: '/h', gitIdentity }), /gitIdentity/);
  }
  assert.throws(() => resolveIsolation({ agentIsolation: 'none' }), /agentIsolation/);
  assert.throws(() => resolveIsolation({ agentHomesDir: 'relative' }), /absolute/);
  assert.throws(() => resolveIsolation({ agentHomesDir: '/h', personalSkillDirs: ['rel'] }), /personalSkillDirs/);
});

test('git commits with the factory environment use the factory identity and are never signed', async t => {
  const dir = await temp(t, 'iso-git-');
  // The operator's global config: a personal identity and signing with a key this machine lacks.
  const globalConfig = join(dir, 'operator.gitconfig');
  await writeFile(globalConfig, '[user]\n\tname = Operator Person\n\temail = operator@example.com\n\tsigningkey = DEADBEEF\n[commit]\n\tgpgsign = true\n');
  const repo = join(dir, 'repo');
  await mkdir(repo);
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' };
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env });
  await writeFile(join(repo, 'a.txt'), 'a');
  execFileSync('git', ['add', '.'], { cwd: repo, env });
  assert.throws(() => execFileSync('git', ['commit', '-qm', 'as operator'], { cwd: repo, env, stdio: 'pipe' }), 'the operator setup signs');
  execFileSync('git', ['commit', '-qm', 'as factory'], { cwd: repo, env: { ...env, ...gitEnvironment(DEFAULT_GIT_IDENTITY) } });
  const log = execFileSync('git', ['log', '-1', '--format=%an <%ae>|%cn <%ce>|%G?'], { cwd: repo, env, encoding: 'utf8' }).trim();
  assert.equal(log, 'Perpeto Agent <agents@perpeto.local>|Perpeto Agent <agents@perpeto.local>|N');
});

test('a Claude factory instance loads project settings only and keeps its login home', async () => {
  const isolation = resolveIsolation({ agentHomesDir: '/unused' });
  const { instanceId, mutation, dropped } = await factoryInstance({
    instanceId: 'claudeAgent', driver: 'claudeAgent',
    config: { homePath: '~/.claude-work', launchArgs: '--chrome --setting-sources user,project' },
    environment: [{ name: 'HTTPS_PROXY', value: 'http://proxy:3128', sensitive: false }, { name: 'API_TOKEN', value: '', sensitive: true, valueRedacted: true },
      { name: 'GIT_AUTHOR_NAME', value: 'Operator', sensitive: false }],
  }, isolation);
  assert.match(instanceId, /^perpeto_claudeAgent_[0-9a-f]{12}$/);
  assert.deepEqual(mutation.instance.config, { homePath: '~/.claude-work', launchArgs: '--chrome --setting-sources=project,local' });
  assert.equal(mutation.instance.driver, 'claudeAgent');
  const env = envOf(mutation);
  assert.equal(env.HTTPS_PROXY, 'http://proxy:3128');
  assert.equal(env.GIT_AUTHOR_NAME, 'Perpeto Agent');
  assert.equal(env.GIT_COMMITTER_EMAIL, 'agents@perpeto.local');
  assert.equal(env.API_TOKEN, undefined);
  assert.deepEqual(dropped, ['API_TOKEN']);
  // Another identity is another instance, so concurrent projects never share one.
  const other = await factoryInstance({ instanceId: 'claudeAgent', driver: 'claudeAgent' }, isolation, { identity: { name: 'Shop Bot', email: 'bot@shop.test' } });
  assert.notEqual(other.instanceId, instanceId);
});

test('a Claude factory instance turns off claude.ai connectors and auto memory, whatever the base set', async () => {
  const { mutation } = await factoryInstance({
    instanceId: 'claudeAgent', driver: 'claudeAgent',
    environment: [{ name: 'ENABLE_CLAUDEAI_MCP_SERVERS', value: 'true', sensitive: false }],
  }, resolveIsolation({ agentHomesDir: '/unused' }));
  const env = envOf(mutation);
  assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
  assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  assert.equal(mutation.instance.environment.filter(variable => variable.name === 'ENABLE_CLAUDEAI_MCP_SERVERS').length, 1);
  const codex = await factoryInstance({ instanceId: 'codex', driver: 'codex' }, resolveIsolation({ agentHomesDir: '/tmp/unused-homes', codexHome: '/tmp/unused-codex' }), { pooled: true });
  assert.equal(envOf(codex.mutation).CLAUDE_CODE_DISABLE_AUTO_MEMORY, undefined);
});

test('a Codex factory home holds only a minimal config and a link to the login', async t => {
  const dir = await temp(t, 'iso-codex-');
  const source = join(dir, 'operator-codex');
  await mkdir(source);
  for (const [name, text] of [['auth.json', '{"tokens":{}}'], ['AGENTS.md', 'Use the messaging skill.'], ['config.toml', '[mcp_servers.cooler]\ncommand = "cooler"\n'], ['hooks.json', '{}']]) {
    await writeFile(join(source, name), text);
  }
  // Codex also reads ~/.agents/skills whatever CODEX_HOME is; the live check found the messaging skill there.
  const shared = join(dir, 'agents-skills');
  await mkdir(join(shared, 'messaging'), { recursive: true });
  await writeFile(join(shared, 'messaging', 'SKILL.md'), '---\nname: messaging\n---\n');
  await mkdir(join(shared, 'not-a-skill'));
  const isolation = resolveIsolation({ agentHomesDir: join(dir, 'homes'), personalSkillDirs: [shared, join(dir, 'missing')] });
  const first = await factoryInstance({ instanceId: 'codex', driver: 'codex', config: { homePath: source } }, isolation);
  const home = first.codexHome;
  assert.ok(home.startsWith(join(dir, 'homes', 'codex-')));
  assert.deepEqual(first.mutation.instance.config, {
    homePath: home, shadowHomePath: '',
    launchArgs: '-c features.memories=false -c features.hooks=false -c features.plugins=false -c features.apps=false -c features.multi_agent=false -c features.multi_agent_v2=false',
  });
  assert.equal(await readlink(join(home, 'auth.json')), join(source, 'auth.json'));
  const config = await readFile(join(home, 'config.toml'), 'utf8');
  assert.match(config, /^# Written by @perpeto\/t3-executor[\s\S]*cli_auth_credentials_store = "file"\n/);
  assert.match(config, /\[skills\.bundled\]\nenabled = false\n/);
  assert.ok(config.includes(`[[skills.config]]\npath = ${JSON.stringify(join(shared, 'messaging', 'SKILL.md'))}\nenabled = false\n`), config);
  assert.doesNotMatch(config, /not-a-skill/);
  for (const personal of ['AGENTS.md', 'hooks.json', 'skills', 'memories']) await assert.rejects(lstat(join(home, personal)), personal);
  assert.equal((await lstat(home)).mode & 0o777, 0o700);
  // Idempotent, and a home whose auth.json Codex replaced with a copy is refused rather than trusted.
  assert.deepEqual((await factoryInstance({ instanceId: 'codex', driver: 'codex', config: { homePath: source } }, isolation)).mutation, first.mutation);
  await rm(join(home, 'auth.json'));
  await writeFile(join(home, 'auth.json'), '{}');
  await assert.rejects(factoryInstance({ instanceId: 'codex', driver: 'codex', config: { homePath: source } }, isolation), { code: 'ISOLATION_AUTH_DIVERGED' });
  // Pooled homes are already Perpeto-owned: only the environment and features change.
  const pooled = await factoryInstance({ instanceId: 'factory_acct_1', driver: 'codex', displayName: 'Build', config: { homePath: '/pool/acct_1', setupMode: 'existing', shadowHomePath: '' } }, isolation, { pooled: true });
  assert.equal(pooled.instanceId, 'factory_acct_1');
  assert.equal(pooled.mutation.instance.config.homePath, '/pool/acct_1');
  assert.equal(pooled.codexHome, undefined);
});

async function setup(t, config = {}) {
  const fake = await startFakeT3();
  const root = await temp(t, 'iso-int-');
  const source = join(root, 'operator-codex');
  await mkdir(source);
  await writeFile(join(source, 'auth.json'), '{}');
  fake.state.providerInstances = { codex: { driver: 'codex', config: { homePath: source } } };
  const executor = createT3Executor({ config: { url: fake.url, settleMs: 30, pollMs: 10, interruptGraceMs: 300, accountReadyTimeoutMs: 500, agentHomesDir: join(root, 'homes'), ...config },
    createClient: settings => new T3Client({ baseUrl: settings.url, token: 'test-token', pingMs: 0 }) });
  t.after(async () => { await executor.close(); await fake.close(); });
  fake.state.onLaunch = launch => {
    fake.emit(launch.threadId, 'run.updated', build.run(launch.threadId, 1, 'running'));
    fake.emit(launch.threadId, 'turn-item.updated', build.assistant(launch.threadId, 1, 'Done.'));
    fake.emit(launch.threadId, 'run.updated', build.run(launch.threadId, 1, 'completed'));
  };
  let n = 0;
  const ctx = async () => { const workspace = join(root, `ws-${++n}`); await mkdir(workspace); return { signal: new AbortController().signal, workspace, report: async () => {} }; };
  return { fake, executor, ctx, source, root };
}
const assignment = extra => ({ id: `asg_${Math.random().toString(36).slice(2)}`, runId: 'run_1', workItemId: 'wi_1', role: 'builder', nodeType: 'agent', attempt: 1,
  prompt: 'Do the work.', harness: { provider: 'codex', model: 'gpt-test' }, policy: { maxSubagents: 0, allowedSubagentProviders: [], canMessage: [] }, ...extra });
const launches = fake => fake.state.commands.filter(item => item.tag === 'orchestration.launchThread').map(item => item.payload);
const upserts = fake => fake.state.commands.filter(item => item.tag === 'server.updateSettings').map(item => item.payload.providerInstanceMutation);

test('assignments run on a factory instance registered once, with the factory identity', async t => {
  const { fake, executor, ctx, source } = await setup(t);
  await executor.run(assignment(), await ctx());
  await executor.run(assignment(), await ctx());
  const [mutation, ...again] = upserts(fake);
  assert.deepEqual(again, [], 'an unchanged factory instance is not re-registered');
  assert.match(mutation.instanceId, /^perpeto_codex_/);
  assert.equal(envOf(mutation).GIT_AUTHOR_EMAIL, 'agents@perpeto.local');
  assert.equal(await readlink(join(mutation.instance.config.homePath, 'auth.json')), join(source, 'auth.json'));
  for (const launch of launches(fake)) assert.equal(launch.modelSelection.instanceId, mutation.instanceId);

  await executor.run(assignment({ harness: { provider: 'claudeAgent', model: 'claude-test' } }), await ctx());
  const claude = upserts(fake).at(-1);
  assert.match(claude.instanceId, /^perpeto_claudeAgent_/);
  assert.match(claude.instance.config.launchArgs, /--setting-sources=project,local/);
  assert.equal(launches(fake).at(-1).modelSelection.instanceId, claude.instanceId);
});

test('a project identity on the assignment overrides the node identity', async t => {
  const { fake, executor, ctx } = await setup(t, { gitIdentity: { name: 'Node Bot', email: 'node@bot.test' } });
  await executor.run(assignment(), await ctx());
  await executor.run(assignment({ gitIdentity: { name: 'Shop Bot', email: 'bot@shop.test' } }), await ctx());
  const [node, project] = upserts(fake);
  assert.equal(envOf(node).GIT_AUTHOR_NAME, 'Node Bot');
  assert.equal(envOf(project).GIT_AUTHOR_NAME, 'Shop Bot');
  assert.notEqual(node.instanceId, project.instanceId);
  const invalid = await executor.run(assignment({ gitIdentity: { name: 'x', email: 'nope' } }), await ctx());
  assert.equal(invalid.outcome, 'blocked');
  assert.match(invalid.summary, /gitIdentity/);
});

test('agentIsolation inherit keeps the operator instance, for debugging only', async t => {
  const { fake, executor, ctx } = await setup(t, { agentIsolation: 'inherit' });
  await executor.run(assignment(), await ctx());
  assert.deepEqual(upserts(fake), []);
  assert.equal(launches(fake)[0].modelSelection.instanceId, 'codex');
});
