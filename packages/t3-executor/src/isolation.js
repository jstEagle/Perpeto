import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readlink, symlink, unlink, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Factory agents run on their own T3 provider instance, so they never load the operator's personal
 * setup and never commit as the operator:
 * - Claude: `--setting-sources=project,local`, so ~/.claude settings, CLAUDE.md, hooks, skills and
 *   plugins stay out; the project's own CLAUDE.md and .claude settings still load. The login is kept.
 * - Codex: a factory CODEX_HOME holding only a minimal config.toml and a link to the source home's
 *   auth.json, so ~/.codex AGENTS.md, skills, memories, hooks, plugins and MCP servers stay out; the
 *   repository's AGENTS.md still loads. Pooled accounts already have Perpeto-owned homes.
 * - Git: author and committer come from the factory identity, and commit or tag signing is off, so
 *   the operator's key never signs agent work.
 */
export const DEFAULT_GIT_IDENTITY = Object.freeze({ name: 'Perpeto Agent', email: 'agents@perpeto.local' });
export const ISOLATION_MODES = Object.freeze(['factory', 'inherit']);

const CLAUDE_SETTING_SOURCES = '--setting-sources=project,local';
// Personal features Codex would otherwise enable from the account or home. Native multi-agent stays off
// because the executor can only observe it after the fact, as in T3's managed runtime.
const CODEX_FEATURES_OFF = ['memories', 'hooks', 'plugins', 'apps', 'multi_agent'];
const CODEX_CONFIG = '# Written by @perpeto/t3-executor. Factory agents use project instructions only.\ncli_auth_credentials_store = "file"\n';

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
  return { mode, identity, homesDir, codexHome };
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

const MANAGED_ENV = new Set(Object.keys(gitEnvironment(DEFAULT_GIT_IDENTITY)));

function withEnvironment(base, identity) {
  const kept = [];
  const dropped = [];
  for (const variable of Array.isArray(base) ? base : []) {
    if (!variable || typeof variable.name !== 'string' || MANAGED_ENV.has(variable.name)) continue;
    // Clients only see redacted secrets; copying them would blank the value.
    if (variable.sensitive || variable.valueRedacted) { dropped.push(variable.name); continue; }
    kept.push({ name: variable.name, value: String(variable.value ?? ''), sensitive: false });
  }
  const managed = Object.entries(gitEnvironment(identity)).map(([name, value]) => ({ name, value, sensitive: false }));
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
export async function prepareCodexHome(home, sourceHome) {
  if (resolve(home) === resolve(sourceHome)) throw new Error('The factory Codex home must differ from the source home.');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  const configPath = join(home, 'config.toml');
  if (await readFile(configPath, 'utf8').catch(() => null) !== CODEX_CONFIG) await writeFile(configPath, CODEX_CONFIG, { mode: 0o600 });
  const link = join(home, 'auth.json');
  const target = join(sourceHome, 'auth.json');
  const existing = await lstat(link).catch(() => null);
  if (existing?.isSymbolicLink() && await readlink(link) === target) return { home, auth: 'linked' };
  if (existing && !existing.isSymbolicLink()) {
    // Codex replaced the link with its own file; that copy would drift from the operator's login.
    throw Object.assign(new Error(`The factory Codex home ${home} holds its own auth.json; remove it so the factory uses ${target}.`), { code: 'ISOLATION_AUTH_DIVERGED' });
  }
  if (existing) await unlink(link);
  await symlink(target, link);
  return { home, auth: 'linked' };
}

const slug = value => String(value).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 24);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);

/**
 * The provider-instance mutation for a factory agent derived from a base instance.
 * `base` is `{ instanceId, driver, config?, environment?, displayName? }`; `pooled` marks an account-pool
 * binding, whose home is already Perpeto-owned and whose instance id stays as the pool chose it.
 * @returns {Promise<{ instanceId: string, mutation: object, dropped: string[], codexHome?: string }>}
 */
export async function factoryInstance(base, isolation, { pooled = false, identity = isolation.identity } = {}) {
  const driver = base.driver;
  let config = { ...(base.config ?? {}) };
  const { environment, dropped } = withEnvironment(base.environment, identity);
  let codexHome;
  if (driver === 'claudeAgent') config = claudeConfig(config);
  if (driver === 'codex') {
    config.launchArgs = codexArgs(config.launchArgs);
    if (!pooled) {
      const sourceHome = codexSourceHome(config, isolation);
      codexHome = join(isolation.homesDir, `codex-${digest(sourceHome)}`);
      await prepareCodexHome(codexHome, sourceHome);
      config = { ...config, homePath: codexHome, shadowHomePath: '' };
    }
  }
  const instanceId = pooled ? base.instanceId : `perpeto_${slug(base.instanceId)}_${digest({ base: base.instanceId, identity })}`;
  const instance = {
    driver, enabled: true,
    displayName: pooled ? base.displayName ?? base.instanceId : `Perpeto agents (${base.displayName ?? base.instanceId})`,
    environment, config,
  };
  return { instanceId, mutation: { operation: 'upsert', instanceId, instance }, dropped, ...(codexHome ? { codexHome } : {}) };
}
