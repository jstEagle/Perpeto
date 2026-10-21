import { createHash } from 'node:crypto';
import { constants, lstat, mkdir, open, readFile, readdir, readlink, rename, rm, symlink, unlink, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { claudeOauth, hasClaudeKeychainLogin, readClaudeKeychainLogin } from '@perpeto/accounts';

/**
 * Factory agents run on their own T3 provider instance, so they never load the operator's personal
 * setup and never commit as the operator:
 * - Claude: `--setting-sources=project,local`, so ~/.claude settings, CLAUDE.md, hooks, skills and
 *   plugins stay out; the project's own CLAUDE.md and .claude settings still load. claude.ai connectors and
 *   auto memory are switched off by environment. Unpooled instances run in a dedicated config directory
 *   (CLAUDE_CONFIG_DIR) seeded only with a login, so transcripts and state stay out of ~/.claude.
 * - Codex: a factory CODEX_HOME holding only a minimal config.toml and a link to the source home's
 *   auth.json, so ~/.codex AGENTS.md, skills, memories, hooks, plugins and MCP servers stay out, and
 *   the config disables bundled skills and those in ~/.agents/skills; the repository's AGENTS.md and
 *   skills still load. Pooled accounts already have Perpeto-owned homes.
 * - Git: author and committer come from the factory identity, and commit or tag signing is off, so
 *   the operator's key never signs agent work.
 */
export const DEFAULT_GIT_IDENTITY = Object.freeze({ name: 'Perpeto Agent', email: 'agents@perpeto.local' });
export const ISOLATION_MODES = Object.freeze(['factory', 'inherit']);
export const CLAUDE_LOGIN_MODES = Object.freeze(['pool-only', 'copy-once']);

const CLAUDE_SETTING_SOURCES = '--setting-sources=project,local';
// Personal features Codex would otherwise enable from the account or home. Native multi-agent stays off
// because the executor can only observe it after the fact, as in T3's managed runtime.
const CODEX_FEATURES_OFF = ['memories', 'hooks', 'plugins', 'apps', 'multi_agent', 'multi_agent_v2'];
// Codex lists skills from ~/.agents/skills whatever CODEX_HOME is, so each one found there is disabled by path.
const PERSONAL_SKILL_DIRS = [join(homedir(), '.agents', 'skills')];

async function personalSkills(dirs) {
  const found = [];
  for (const dir of dirs) {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const file = join(dir, entry.name, 'SKILL.md');
      if ((entry.isDirectory() || entry.isSymbolicLink()) && await lstat(file).then(() => true, () => false)) found.push(file);
    }
  }
  return found.sort();
}

function codexConfig(disabledSkills) {
  return ['# Written by @perpeto/t3-executor. Factory agents use project instructions and skills only.',
    'cli_auth_credentials_store = "file"', '', '[skills.bundled]', 'enabled = false',
    ...disabledSkills.flatMap(path => ['', '[[skills.config]]', `path = ${JSON.stringify(path)}`, 'enabled = false']), ''].join('\n');
}

const IDENTITY_TEXT = /^[^\0\r\n<>]{1,200}$/;
const EMAIL = /^[^\s@<>]{1,200}@[^\s@<>]{1,200}$/;

/** Validate a `{ name, email }` Git identity; throws on anything Git would misread. */
export function gitIdentity(value, label = 'gitIdentity') {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || !IDENTITY_TEXT.test(value.name ?? '') || !EMAIL.test(value.email ?? '') || value.name.trim() !== value.name) {
    throw new Error(`${label} must be { name, email } with a single-line name and an email address.`);
  }
  return { name: value.name, email: value.email };
}

/** Executor isolation settings from node configuration (`runtime.t3`). */
export function resolveIsolation(settings) {
  const mode = settings.agentIsolation ?? 'factory';
  if (!ISOLATION_MODES.includes(mode)) throw new Error(`agentIsolation must be ${ISOLATION_MODES.join(' or ')}.`);
  const identity = gitIdentity(settings.gitIdentity) ?? DEFAULT_GIT_IDENTITY;
  const homesDir = settings.agentHomesDir ?? (settings.baseDir ? join(settings.baseDir, 'perpeto-agent-homes') : join(homedir(), '.perpeto', 'agent-homes'));
  if (!isAbsolute(homesDir)) throw new Error('agentHomesDir must be an absolute path.');
  const codexHome = settings.codexHome ?? null;
  if (codexHome !== null && !isAbsolute(codexHome)) throw new Error('codexHome must be an absolute path.');
  const personalSkillDirs = settings.personalSkillDirs ?? PERSONAL_SKILL_DIRS;
  if (!Array.isArray(personalSkillDirs) || !personalSkillDirs.every(dir => typeof dir === 'string' && isAbsolute(dir))) {
    throw new Error('personalSkillDirs must be a list of absolute paths.');
  }
  const claudeLogin = settings.claudeLogin ?? 'pool-only';
  if (!CLAUDE_LOGIN_MODES.includes(claudeLogin)) throw new Error(`claudeLogin must be ${CLAUDE_LOGIN_MODES.join(' or ')}.`);
  const claudeHome = settings.claudeHome ?? null;
  if (claudeHome !== null && !isAbsolute(claudeHome)) throw new Error('claudeHome must be an absolute path.');
  return { mode, identity, homesDir, codexHome, personalSkillDirs, claudeLogin, claudeHome, claudeKeychain: CLAUDE_KEYCHAIN };
}

/** Environment that makes Git use the factory identity and never sign with the operator's key. */
export function gitEnvironment(identity) {
  return {
    GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'tag.gpgsign', GIT_CONFIG_VALUE_1: 'false',
  };
}

// Claude features that come from the account rather than ~/.claude, so --setting-sources cannot hide them:
// claude.ai connectors (MCP servers with their own instructions) and auto memory, which also writes into ~/.claude/projects.
const CLAUDE_ENV = { ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };

const MANAGED_ENV = new Set([...Object.keys(gitEnvironment(DEFAULT_GIT_IDENTITY)), ...Object.keys(CLAUDE_ENV)]);

function withEnvironment(base, identity, extra = {}) {
  const kept = [];
  const dropped = [];
  for (const variable of Array.isArray(base) ? base : []) {
    if (!variable || typeof variable.name !== 'string' || MANAGED_ENV.has(variable.name)) continue;
    // Clients only see redacted secrets; copying them would blank the value.
    if (variable.sensitive || variable.valueRedacted) { dropped.push(variable.name); continue; }
    kept.push({ name: variable.name, value: String(variable.value ?? ''), sensitive: false });
  }
  const managed = Object.entries({ ...gitEnvironment(identity), ...extra }).map(([name, value]) => ({ name, value, sensitive: false }));
  return { environment: [...kept, ...managed], dropped };
}

const appendArgs = (current, extra) => [typeof current === 'string' ? current.trim() : '', ...extra.filter(arg => !String(current ?? '').includes(arg))]
  .filter(Boolean).join(' ');

function claudeConfig(config) {
  // A later --setting-sources would win; drop any the base instance set.
  const current = typeof config.launchArgs === 'string' ? config.launchArgs.replace(/--setting-sources(?:=|\s+)\S+/g, '').trim() : '';
  return { ...config, launchArgs: appendArgs(current, [CLAUDE_SETTING_SOURCES]) };
}

const codexArgs = launchArgs => appendArgs(launchArgs, CODEX_FEATURES_OFF.map(feature => `-c features.${feature}=false`));

const expandHome = value => value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;

/** Where the operator's Codex login lives for an unpooled instance. */
export function codexSourceHome(config, isolation, env = process.env) {
  const configured = [config.shadowHomePath, config.homePath].find(value => typeof value === 'string' && value.trim());
  return resolve(expandHome(configured?.trim() ?? isolation.codexHome ?? env.CODEX_HOME ?? join(homedir(), '.codex')));
}

/**
 * Create or refresh a factory Codex home: a minimal config.toml and auth.json linked to the source home,
 * so token refreshes write through to the one login instead of forking a copy.
 */
export async function prepareCodexHome(home, sourceHome, { personalSkillDirs = PERSONAL_SKILL_DIRS } = {}) {
  if (resolve(home) === resolve(sourceHome)) throw new Error('The factory Codex home must differ from the source home.');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  const configPath = join(home, 'config.toml');
  const config = codexConfig(await personalSkills(personalSkillDirs));
  if (await readFile(configPath, 'utf8').catch(() => null) !== config) await writeFile(configPath, config, { mode: 0o600 });
  const link = join(home, 'auth.json');
  const target = join(sourceHome, 'auth.json');
  const existing = await lstat(link).catch(() => null);
  if (existing?.isSymbolicLink() && await readlink(link) === target) return { home, auth: 'linked' };
  if (existing && !existing.isSymbolicLink()) {
    // Codex replaced the link with its own file; that copy would drift from the operator's login.
    throw Object.assign(new Error(`The factory Codex home ${home} holds its own auth.json; remove it so the factory uses ${target}.`), { code: 'ISOLATION_AUTH_DIVERGED' });
  }
  if (existing) await unlink(link).catch(error => { if (error?.code !== 'ENOENT') throw error; });
  try { await symlink(target, link); } catch (error) {
    // Another assignment starting at the same moment linked it first; accept only the same target.
    if (error?.code !== 'EEXIST' || await readlink(link).catch(() => null) !== target) throw error;
  }
  return { home, auth: 'linked' };
}

/** Real keychain access; tests replace it so they never touch a login. */
const CLAUDE_KEYCHAIN = Object.freeze({ has: hasClaudeKeychainLogin, read: readClaudeKeychainLogin });
const CLAUDE_SEED_RECORD = 'perpeto-login.json';

const isolationError = (code, message) => Object.assign(new Error(message), { code });

/**
 * The operator's Claude login an unpooled instance would use, and the config dir Claude keys its keychain
 * item on: T3 sets CLAUDE_CONFIG_DIR only when the instance has a `homePath`.
 */
export function claudeSourceHome(config, isolation, env = process.env) {
  const configured = typeof config.homePath === 'string' && config.homePath.trim() ? config.homePath.trim() : null;
  const explicit = configured ?? isolation.claudeHome ?? (env.CLAUDE_CONFIG_DIR?.trim() || null);
  const home = resolve(expandHome(explicit ?? join(homedir(), '.claude')));
  return { home, configDir: explicit ? home : null };
}

async function privateFile(path) {
  const stat = await lstat(path).catch(() => null);
  if (!stat) return null;
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw isolationError('ISOLATION_HOME_UNSAFE', `${path} must be a private regular file (mode 600) owned by this user.`);
  }
  return stat;
}

/** The operator's current login, reduced to `claudeAiOauth`: the source's plaintext file, else its keychain item. */
async function currentClaudeLogin(source, keychain) {
  const file = join(source.home, '.credentials.json');
  if (await privateFile(file)) {
    let data = null;
    try { data = JSON.parse(await readFile(file, 'utf8')); } catch { /* reported below without content */ }
    const oauth = claudeOauth(data);
    if (oauth) return { oauth, from: 'file' };
  }
  const oauth = await keychain.read(source.configDir);
  return oauth ? { oauth, from: 'keychain' } : null;
}

async function writePrivate(path, text) {
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
}

/**
 * Create or check a dedicated Claude config directory for factory agents. It holds only a login:
 * - an existing login (a `.credentials.json`, or the keychain item Claude moves it into on macOS) is used as is;
 * - otherwise, with `claudeLogin: "copy-once"`, the operator's current `claudeAiOauth` is copied in once
 *   (mode 600) and the copy is recorded, so a later sign-out is reported instead of silently re-copied.
 * Nothing else from the source home is read. Claude then keeps its transcripts, memory and settings here.
 */
export async function prepareClaudeHome(home, source, { claudeLogin = 'pool-only', claudeKeychain = CLAUDE_KEYCHAIN } = {}) {
  if (resolve(home) === source.home) throw new Error('The factory Claude home must differ from the source home.');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const stat = await lstat(home);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.()) {
    throw isolationError('ISOLATION_HOME_UNSAFE', `The factory Claude home ${home} must be a directory owned by this user.`);
  }
  await chmod(home, 0o700);
  if (await privateFile(join(home, '.credentials.json')) || await claudeKeychain.has(home)) return { home, login: 'existing' };
  const relogin = `CLAUDE_CONFIG_DIR=${JSON.stringify(home)} claude auth login`;
  if (await readFile(join(home, CLAUDE_SEED_RECORD), 'utf8').then(() => true, () => false)) {
    throw isolationError('ISOLATION_LOGIN_MISSING', `The factory Claude home ${home} was seeded once and is no longer signed in. Run ${relogin}, or delete the home to copy the current login again.`);
  }
  if (claudeLogin !== 'copy-once') {
    throw isolationError('ISOLATION_LOGIN_MISSING', `Factory Claude agents need their own login. Enroll a Claude account in the pool, run ${relogin}, or set runtime.t3.claudeLogin to "copy-once" to copy the current login into ${home} once.`);
  }
  const login = await currentClaudeLogin(source, claudeKeychain);
  if (!login) throw isolationError('ISOLATION_LOGIN_MISSING', `No Claude login found to copy for ${source.home}. Sign in to Claude Code first.`);
  await writePrivate(join(home, '.credentials.json'), `${JSON.stringify({ claudeAiOauth: login.oauth })}\n`);
  await writePrivate(join(home, CLAUDE_SEED_RECORD), `${JSON.stringify({ seeded: 'copy-once', from: login.from, at: new Date().toISOString() })}\n`);
  return { home, login: 'copied' };
}

const slug = value => String(value).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 24);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);

/**
 * The provider-instance mutation for a factory agent derived from a base instance.
 * `base` is `{ instanceId, driver, config?, environment?, displayName? }`; `pooled` marks an account-pool
 * binding, whose home is already Perpeto-owned and whose instance id stays as the pool chose it.
 * @returns {Promise<{ instanceId: string, mutation: object, dropped: string[], codexHome?: string, claudeHome?: string, claudeLogin?: string }>}
 */
export async function factoryInstance(base, isolation, { pooled = false, identity = isolation.identity } = {}) {
  const driver = base.driver;
  let config = { ...(base.config ?? {}) };
  const { environment, dropped } = withEnvironment(base.environment, identity, driver === 'claudeAgent' ? CLAUDE_ENV : {});
  let codexHome, claudeHome, claudeLogin;
  if (driver === 'claudeAgent') {
    config = claudeConfig(config);
    if (!pooled) {
      const source = claudeSourceHome(config, isolation);
      ({ home: claudeHome, login: claudeLogin } = await prepareClaudeHome(join(isolation.homesDir, `claude-${digest(source.home)}`), source, isolation));
      config = { ...config, homePath: claudeHome };
    }
  }
  if (driver === 'codex') {
    config.launchArgs = codexArgs(config.launchArgs);
    if (!pooled) {
      const sourceHome = codexSourceHome(config, isolation);
      codexHome = join(isolation.homesDir, `codex-${digest(sourceHome)}`);
      await prepareCodexHome(codexHome, sourceHome, isolation);
      config = { ...config, homePath: codexHome, shadowHomePath: '' };
    }
  }
  const instanceId = pooled ? base.instanceId : `perpeto_${slug(base.instanceId)}_${digest({ base: base.instanceId, identity })}`;
  const instance = {
    driver, enabled: true,
    displayName: pooled ? base.displayName ?? base.instanceId : `Perpeto agents (${base.displayName ?? base.instanceId})`,
    environment, config,
  };
  return { instanceId, mutation: { operation: 'upsert', instanceId, instance }, dropped, ...(codexHome ? { codexHome } : {}),
    ...(claudeHome ? { claudeHome, claudeLogin } : {}) };
}
