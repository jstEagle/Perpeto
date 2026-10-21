import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir, lstat, readlink, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { createT3Executor, T3Client } from '../src/index.js';
import { DEFAULT_GIT_IDENTITY, claudeSourceHome, factoryInstance, gitEnvironment, prepareCodexHome, resolveIsolation } from '../src/isolation.js';
import { startFakeT3, build } from './fake-t3.js';

// Live acceptance run 1, finding 2: factory agents loaded the operator's personal instructions
// and committed under the operator's Git identity.

async function temp(t, prefix) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
const envOf = mutation => Object.fromEntries(mutation.instance.environment.map(variable => [variable.name, variable.value]));

// Synthetic credentials only. Tests never read a real login or the macOS keychain.
const OAUTH = { accessToken: 'fixture-claude-access', refreshToken: 'fixture-claude-refresh', expiresAt: 1, scopes: ['user:inference', 'user:profile'] };
function fakeKeychain(items = {}) {
  const reads = [];
  return { reads, moved: new Set(), has(home) { return this.moved.has(home); }, async read(configDir) { reads.push(configDir); return items[configDir ?? 'default'] ?? null; } };
}
async function claudeSource(dir, data = { claudeAiOauth: OAUTH }) {
  const source = join(dir, 'operator-claude');
  await mkdir(source, { mode: 0o700 });
  for (const [name, text] of [['CLAUDE.md', 'Use the messaging skill.'], ['settings.json', '{"hooks":{}}'], ['.credentials.json', JSON.stringify(data)]]) {
    await writeFile(join(source, name), text, { mode: 0o600 });
  }
  return source;
}
const claudeIsolation = (dir, extra = {}) => ({ ...resolveIsolation({ agentHomesDir: join(dir, 'homes'), ...extra }), claudeKeychain: extra.keychain ?? fakeKeychain() });

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

test('a Claude factory instance loads project settings only, in its own config directory', async t => {
  const dir = await temp(t, 'iso-claude-');
  const source = await claudeSource(dir);
  const isolation = claudeIsolation(dir, { claudeLogin: 'copy-once' });
  const { instanceId, mutation, dropped, claudeHome } = await factoryInstance({
    instanceId: 'claudeAgent', driver: 'claudeAgent',
    config: { homePath: source, launchArgs: '--chrome --setting-sources user,project' },
    environment: [{ name: 'HTTPS_PROXY', value: 'http://proxy:3128', sensitive: false }, { name: 'API_TOKEN', value: '', sensitive: true, valueRedacted: true },
      { name: 'GIT_AUTHOR_NAME', value: 'Operator', sensitive: false }],
  }, isolation);
  assert.match(instanceId, /^perpeto_claudeAgent_[0-9a-f]{12}$/);
  assert.ok(claudeHome.startsWith(join(dir, 'homes', 'claude-')));
  assert.deepEqual(mutation.instance.config, { homePath: claudeHome, launchArgs: '--chrome --setting-sources=project,local' });
  assert.equal(mutation.instance.driver, 'claudeAgent');
  const env = envOf(mutation);
  assert.equal(env.HTTPS_PROXY, 'http://proxy:3128');
  assert.equal(env.GIT_AUTHOR_NAME, 'Perpeto Agent');
  assert.equal(env.GIT_COMMITTER_EMAIL, 'agents@perpeto.local');
  assert.equal(env.API_TOKEN, undefined);
  assert.deepEqual(dropped, ['API_TOKEN']);
  // Another identity is another instance, so concurrent projects never share one.
  const other = await factoryInstance({ instanceId: 'claudeAgent', driver: 'claudeAgent', config: { homePath: source } }, isolation, { identity: { name: 'Shop Bot', email: 'bot@shop.test' } });
  assert.notEqual(other.instanceId, instanceId);
  assert.equal(other.claudeHome, claudeHome, 'one login copy per source home');
});

test('a Claude factory instance turns off claude.ai connectors and auto memory, whatever the base set', async t => {
  const dir = await temp(t, 'iso-claude-env-');
  const { mutation } = await factoryInstance({
    instanceId: 'claudeAgent', driver: 'claudeAgent', config: { homePath: await claudeSource(dir) },
    environment: [{ name: 'ENABLE_CLAUDEAI_MCP_SERVERS', value: 'true', sensitive: false }],
  }, claudeIsolation(dir, { claudeLogin: 'copy-once' }));
  const env = envOf(mutation);
  assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
  assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  assert.equal(mutation.instance.environment.filter(variable => variable.name === 'ENABLE_CLAUDEAI_MCP_SERVERS').length, 1);
  const codex = await factoryInstance({ instanceId: 'codex', driver: 'codex' }, resolveIsolation({ agentHomesDir: '/tmp/unused-homes', codexHome: '/tmp/unused-codex' }), { pooled: true });
  assert.equal(envOf(codex.mutation).CLAUDE_CODE_DISABLE_AUTO_MEMORY, undefined);
});

test('copy-once seeds a private Claude home with the login only, once', async t => {
  const dir = await temp(t, 'iso-claude-copy-');
  const source = await claudeSource(dir, { claudeAiOauth: OAUTH, mcpOAuth: { server: { accessToken: 'fixture-mcp-token' } } });
  const before = await readFile(join(source, '.credentials.json'), 'utf8');
  const keychain = fakeKeychain();
  const isolation = claudeIsolation(dir, { claudeLogin: 'copy-once', keychain });
  const base = { instanceId: 'claudeAgent', driver: 'claudeAgent', config: { homePath: source } };
  const first = await factoryInstance(base, isolation);
  const home = first.claudeHome;
  assert.equal(first.claudeLogin, 'copied');
  assert.deepEqual((await readdir(home)).sort(), ['.credentials.json', 'perpeto-login.json']);
  assert.equal((await lstat(home)).mode & 0o777, 0o700);
  for (const name of ['.credentials.json', 'perpeto-login.json']) assert.equal((await lstat(join(home, name))).mode & 0o777, 0o600, name);
  assert.deepEqual(JSON.parse(await readFile(join(home, '.credentials.json'), 'utf8')), { claudeAiOauth: OAUTH });
  const record = await readFile(join(home, 'perpeto-login.json'), 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(record)).sort(), ['at', 'from', 'seeded']);
  assert.doesNotMatch(record, /fixture/);
  assert.equal(await readFile(join(source, '.credentials.json'), 'utf8'), before, 'the source is never written');
  assert.deepEqual(keychain.reads, [], 'a file login needs no keychain read');

  // Later runs use the copy, also after Claude moved it into its keychain item for this home.
  await writeFile(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { ...OAUTH, accessToken: 'fixture-refreshed' } }), { mode: 0o600 });
  assert.equal((await factoryInstance(base, isolation)).claudeLogin, 'existing');
  assert.match(await readFile(join(home, '.credentials.json'), 'utf8'), /fixture-refreshed/);
  await rm(join(home, '.credentials.json'));
  keychain.moved.add(home);
  assert.equal((await factoryInstance(base, isolation)).claudeLogin, 'existing');
  // A copy that later lost its login is reported, never silently copied again.
  keychain.moved.delete(home);
  await assert.rejects(factoryInstance(base, isolation), error => error.code === 'ISOLATION_LOGIN_MISSING' && /delete the home/.test(error.message) && !/fixture/.test(error.message));
  await assert.rejects(lstat(join(home, '.credentials.json')));
});

test('without a pool account or opt-in, factory Claude work never falls back to the operator login', async t => {
  const dir = await temp(t, 'iso-claude-none-');
  const source = await claudeSource(dir);
  const keychain = fakeKeychain({ default: OAUTH });
  await assert.rejects(factoryInstance({ instanceId: 'claudeAgent', driver: 'claudeAgent', config: { homePath: source } }, claudeIsolation(dir, { keychain })),
    error => error.code === 'ISOLATION_LOGIN_MISSING' && /claudeLogin/.test(error.message));
  assert.deepEqual(keychain.reads, []);
  const [home] = await readdir(join(dir, 'homes'));
  assert.deepEqual(await readdir(join(dir, 'homes', home)), []);
  assert.throws(() => resolveIsolation({ agentHomesDir: '/h', claudeLogin: 'always' }), /claudeLogin/);
  assert.throws(() => resolveIsolation({ agentHomesDir: '/h', claudeHome: 'rel' }), /claudeHome/);
});

test('copy-once reads the keychain item Claude uses for the source when it has no file', async t => {
  const dir = await temp(t, 'iso-claude-kc-');
  const source = join(dir, 'operator-claude');
  await mkdir(source, { mode: 0o700 });
  const keychain = fakeKeychain({ [source]: OAUTH });
  const { claudeHome, claudeLogin } = await factoryInstance({ instanceId: 'claudeAgent', driver: 'claudeAgent', config: { homePath: source } },
    claudeIsolation(dir, { claudeLogin: 'copy-once', keychain }));
  assert.equal(claudeLogin, 'copied');
  assert.deepEqual(keychain.reads, [source]);
  assert.equal(JSON.parse(await readFile(join(claudeHome, 'perpeto-login.json'), 'utf8')).from, 'keychain');
  // T3 sets CLAUDE_CONFIG_DIR only for a configured home, so the default login uses the unsuffixed item.
  assert.deepEqual(claudeSourceHome({}, { claudeHome: null }, {}), { home: join(process.env.HOME, '.claude'), configDir: null });
  assert.deepEqual(claudeSourceHome({}, { claudeHome: null }, { CLAUDE_CONFIG_DIR: '/x/claude' }), { home: '/x/claude', configDir: '/x/claude' });
  assert.deepEqual(claudeSourceHome({}, { claudeHome: '/y/claude' }, {}), { home: '/y/claude', configDir: '/y/claude' });
});

test('an unsafe source login is refused without reading it', async t => {
  const dir = await temp(t, 'iso-claude-unsafe-');
  const source = await claudeSource(dir);
  await chmod(join(source, '.credentials.json'), 0o644);
  await assert.rejects(factoryInstance({ instanceId: 'claudeAgent', driver: 'claudeAgent', config: { homePath: source } }, claudeIsolation(dir, { claudeLogin: 'copy-once' })),
    error => error.code === 'ISOLATION_HOME_UNSAFE' && !/fixture/.test(error.message));
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
  const claude = await claudeSource(root);
  fake.state.providerInstances = { codex: { driver: 'codex', config: { homePath: source } }, claudeAgent: { driver: 'claudeAgent', config: { homePath: claude } } };
  const executor = createT3Executor({ config: { url: fake.url, settleMs: 30, pollMs: 10, interruptGraceMs: 300, accountReadyTimeoutMs: 500, agentHomesDir: join(root, 'homes'), ...config },
    createClient: settings => new T3Client({ baseUrl: settings.url, token: 'test-token', pingMs: 0 }), claudeKeychain: fakeKeychain() });
  t.after(async () => { await executor.close(); await fake.close(); });
  fake.state.onLaunch = launch => {
    fake.emit(launch.threadId, 'run.updated', build.run(launch.threadId, 1, 'running'));
    fake.emit(launch.threadId, 'turn-item.updated', build.assistant(launch.threadId, 1, 'Done.'));
    fake.emit(launch.threadId, 'run.updated', build.run(launch.threadId, 1, 'completed'));
  };
  let n = 0;
  const events = [];
  const ctx = async () => { const workspace = join(root, `ws-${++n}`); await mkdir(workspace); return { signal: new AbortController().signal, workspace, report: async event => { events.push(event); } }; };
  return { fake, executor, ctx, source, root, events };
}
const assignment = extra => ({ id: `asg_${Math.random().toString(36).slice(2)}`, runId: 'run_1', workItemId: 'wi_1', role: 'builder', nodeType: 'agent', attempt: 1,
  prompt: 'Do the work.', harness: { provider: 'codex', model: 'gpt-test' }, policy: { maxSubagents: 0, allowedSubagentProviders: [], canMessage: [] }, ...extra });
const launches = fake => fake.state.commands.filter(item => item.tag === 'orchestration.launchThread').map(item => item.payload);
const upserts = fake => fake.state.commands.filter(item => item.tag === 'server.updateSettings').map(item => item.payload.providerInstanceMutation);

test('assignments run on a factory instance registered once, with the factory identity', async t => {
  const { fake, executor, ctx, source, root, events } = await setup(t, { claudeLogin: 'copy-once' });
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
  assert.ok(claude.instance.config.homePath.startsWith(join(root, 'homes', 'claude-')));
  assert.equal(launches(fake).at(-1).modelSelection.instanceId, claude.instanceId);
  assert.equal(events.filter(event => event.data?.interaction === 'isolation.bound').at(-1).data.claudeLogin, 'copied');
  assert.doesNotMatch(JSON.stringify(events), /fixture|homes\/claude-/, 'no credential or home path reaches the hub');
});

test('unpooled Claude work without its own login is blocked, never run on the operator home', async t => {
  const { fake, executor, ctx } = await setup(t);
  const result = await executor.run(assignment({ harness: { provider: 'claudeAgent', model: 'claude-test' } }), await ctx());
  assert.equal(result.outcome, 'blocked');
  assert.match(result.summary, /claudeLogin/);
  assert.doesNotMatch(result.summary, /fixture/);
  assert.deepEqual(upserts(fake), []);
  assert.deepEqual(launches(fake), []);
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

// Live acceptance run 3: two assignments leased together on a fresh node both linked auth.json,
// and the second symlink failed with EEXIST, so its turn ended as "Executor failed.".
test('concurrent first uses of a factory Codex home both link the one login', async t => {
  const dir = await temp(t, 'iso-codex-race-');
  const source = join(dir, 'operator-codex');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'auth.json'), '{"fixture":true}');
  const home = join(dir, 'homes', 'codex-race');
  const results = await Promise.all(Array.from({ length: 4 }, () => prepareCodexHome(home, source, { personalSkillDirs: [] })));
  assert.deepEqual(results.map(result => result.auth), ['linked', 'linked', 'linked', 'linked']);
  assert.equal(await readlink(join(home, 'auth.json')), join(source, 'auth.json'));
});
