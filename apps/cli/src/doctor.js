import { access, readdir, readFile, readlink } from 'node:fs/promises';
import { resolve, relative, isAbsolute, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { loadConfig as loadNodeConfig } from '@perpeto/node';
import { repoRoot, configPath, readJson, readSecret, hubUrl, hubConfig, nodeConfig } from './config.js';
import { control } from './process.js';

export function supportedNode(version) {
  const [major, minor, patch] = version.replace(/^v/, '').split('.').map(Number);
  return major === 24 && (minor > 13 || minor === 13 && patch >= 1);
}
export async function doctor(dir, { version = process.version, run = spawnSync, fetchImpl = fetch, root = repoRoot, home = homedir(), binPath } = {}) {
  const checks = [{ name: 'Node', status: supportedNode(version) ? 'ok' : 'fail', detail: `${version}; requires >=24.13.1 <25` }];
  for (const command of ['git', 'claude', 'codex']) {
    const result = run(command, ['--version'], { stdio: 'ignore', timeout: 5000 });
    checks.push({ name: command, status: result.status === 0 && !result.error ? 'ok' : 'fail', detail: 'Executable check only; authentication is separate.' });
  }
  let runtime;
  try {
    const config = await readJson(resolve(root, 'config/perpeto.json'));
    runtime = resolve(root, config.runtime.directory, 'apps/server/dist/bin.mjs');
    await access(runtime);
    checks.push({ name: 'T3 build', status: 'ok', detail: runtime });
  } catch { checks.push({ name: 'T3 build', status: 'fail', detail: 'Run npm run setup and npm run build in the installation directory.' }); }
  const secrets = new Set(); let url;
  for (const role of ['hub', 'node']) {
    try {
      const config = await readJson(configPath(dir, role));
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error();
      checks.push(...await configurationChecks(dir, role, config));
      warnLegacy(checks, JSON.stringify(config), `${role}.json`);
      if (role === 'node') {
        url ??= config.hubUrl;
        secrets.add(resolve(dir, config.credentialFile ?? `${config.dataDir ?? './node'}/machine.json`));
        if (config.enrollmentCodeFile) secrets.add(resolve(dir, config.enrollmentCodeFile));
        if (config.jobs?.redactionFile) secrets.add(resolve(dir, config.jobs.redactionFile));
      } else {
        secrets.add(resolve(dir, config.ownerTokenPath ?? './owner.secret'));
        const state = await control(dir, 'hub').catch(() => null);
        const host = ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host ?? '127.0.0.1';
        url = state?.url ?? `http://${host.includes(':') ? `[${host}]` : host}:${config.port ?? 4320}`;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') checks.push({ name: `${role} config`, status: 'fail', detail: 'Invalid configuration.' });
    }
  }
  for (const file of await readdir(dir).catch(() => [])) if (file.endsWith('.secret')) secrets.add(resolve(dir, file));
  for (const path of secrets) {
    try { await readSecret(path); checks.push({ name: 'Secret permissions', status: 'ok', detail: path }); }
    catch { checks.push({ name: 'Secret permissions', status: 'fail', detail: `${path}: missing, unsafe type, owner or permissions` }); }
  }
  if (!secrets.size) checks.push({ name: 'Secret permissions', status: 'warn', detail: 'No configured secret files.' });
  if (url) {
    try {
      const target = hubUrl(url);
      const response = await fetchImpl(`${target}/health`, { redirect: 'error', signal: AbortSignal.timeout(3000) });
      const body = await response.json();
      if (!response.ok || body.status !== 'ok') throw new Error();
      checks.push({ name: 'Hub', status: 'ok', detail: target });
    } catch { checks.push({ name: 'Hub', status: 'fail', detail: 'Hub is unreachable or returned an invalid health response.' }); }
  } else checks.push({ name: 'Hub', status: 'warn', detail: 'No configured hub. Run perpeto hub init or node join.' });
  for (const role of ['hub', 'node']) {
    for (const file of [resolve(home, `Library/LaunchAgents/com.perpeto.${role}.plist`), resolve(home, `.config/systemd/user/perpeto-${role}.service`)]) {
      const contents = await readFile(file, 'utf8').catch(() => '');
      warnLegacy(checks, contents, `${role} service`, 'Stop the service, then run perpeto service uninstall and reinstall from the current checkout.');
    }
  }
  const bin = binPath ?? (await Promise.all((process.env.PATH ?? '').split(delimiter).map(async path => {
    const candidate = resolve(path, 'perpeto');
    try { await access(candidate); return candidate; } catch { return null; }
  }))).find(Boolean);
  if (bin) warnLegacy(checks, await readlink(bin).catch(() => ''), 'perpeto bin', 'Rerun install/install.sh with the original --dir and --bin-dir to reinstall the apps/cli link.');
  warnLegacy(checks, await readFile(resolve(root, 'config/perpeto.json'), 'utf8').catch(() => ''), 'runtime config');
  return checks;
}

const legacyNames = {
  'factory-t3': 't3-executor', 'factory-hub': 'hub', 'factory-node': 'node',
  'factory-workflow': 'workflow', 'factory-delivery': 'delivery', 'factory-accounts': 'accounts',
  'perpeto-cli': 'cli', 'factory-e2e': 'e2e',
};
function warnLegacy(checks, value, source, fix) {
  for (const [old, current] of Object.entries(legacyNames)) {
    if (!value.includes(`@perpeto/${old}`) && !value.includes(`packages/${old}`)) continue;
    const location = ['hub', 'node', 'cli'].includes(current) ? `apps/${current}` : current === 'e2e' ? 'tests/e2e' : `packages/${current}`;
    checks.push({ name: 'Legacy reference', status: 'warn', detail: `${source}: replace @perpeto/${old} with @perpeto/${current} and packages/${old} with ${location}. ${fix ?? 'Edit the stopped installation configuration, then restart.'}` });
  }
}
async function configurationChecks(dir, role, config) {
  const checks = []; const problems = [];
  const defaults = role === 'hub' ? hubConfig(dir) : nodeConfig(dir, 'https://hub.example');
  const missing = [];
  function findMissing(current, expected, prefix = '') {
    for (const [key, value] of Object.entries(expected)) {
      const path = `${prefix}${key}`;
      if (current?.[key] === undefined) missing.push(`${path}=${JSON.stringify(value)}`);
      else if (value && typeof value === 'object' && !Array.isArray(value)) findMissing(current[key], value, `${path}.`);
    }
  }
  findMissing(config, defaults);
  if (missing.length) checks.push({ name: `${role} defaults`, status: 'warn', detail: `Add explicit settings in ${role}.json: ${missing.join(', ')}. Existing configs are preserved by init/join.` });
  if (role === 'node') {
    try { await loadNodeConfig(configPath(dir, role)); } catch { problems.push('Invalid node settings; check capacity, timing, jobs and paths against apps/node/README.md.'); }
  } else {
    if (Object.keys(config).some(key => !Object.hasOwn(defaults, key))) problems.push('Unknown hub settings; compare with config/hub.example.json.');
    const bounds = { port: [0, 65535], requestMaxBytes: [128, 16777216], longPollMs: [0, 25000],
      deliveryMaxStepFailures: [1, 1000], deliveryRetryBackoffMs: [1, 3600000] };
    for (const key of ['heartbeatIntervalMs', 'leaseDurationMs', 'deliveryLeaseDurationMs', 'maintenanceIntervalMs', 'enrollmentTtlMs']) bounds[key] = [1, 86400000];
    for (const [key, [min, max]] of Object.entries(bounds)) if (config[key] !== undefined && (!Number.isSafeInteger(config[key]) || config[key] < min || config[key] > max)) problems.push(`Set ${key} to an integer from ${min} through ${max}.`);
    if (config.host !== undefined && (typeof config.host !== 'string' || !config.host.trim())) problems.push('Set host to a non-empty address.');
    if (config.architectHarness !== undefined && (!config.architectHarness || ['provider', 'model'].some(key => typeof config.architectHarness[key] !== 'string' || !config.architectHarness[key].trim()))) problems.push('Set architectHarness.provider and architectHarness.model.');
    if (config.corsOrigins !== undefined && (!Array.isArray(config.corsOrigins) || config.corsOrigins.some(origin => {
      try { const url = new URL(origin); return !['http:', 'https:'].includes(url.protocol) || url.origin !== origin; } catch { return true; }
    }))) problems.push('Set corsOrigins to exact HTTP(S) origins.');
  }
  const paths = role === 'hub' ? ['databasePath', 'messagingDatabasePath', 'deliveryDatabasePath', 'workflowDatabasePath', 'deliveryRepositoriesPath', 'ownerTokenPath'] : ['dataDir', 'credentialFile'];
  const files = [];
  for (const key of paths) {
    const value = config[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) { problems.push(`Set ${key} to a non-empty path.`); continue; }
    const path = resolve(dir, value); files.push(path);
    const offset = relative(dir, path);
    if (offset === '..' || offset.startsWith('../') || isAbsolute(offset)) checks.push({ name: `${role} data path`, status: 'warn', detail: `${key} is outside the CLI data directory. Stop the ${role}, back up and move its data, then set ${key}=${JSON.stringify(defaults[key])} in ${role}.json.` });
  }
  if (role === 'hub' && new Set(files).size !== files.length) problems.push('Use distinct hub data and secret paths.');
  checks.unshift({ name: `${role} config`, status: problems.length ? 'fail' : 'ok', detail: problems.length ? problems.join(' ') : 'Current configured settings are valid.' });
  return checks;
}
