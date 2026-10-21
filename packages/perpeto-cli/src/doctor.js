import { access, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoRoot, configPath, readJson, readSecret, hubUrl } from './config.js';
import { control } from './process.js';

export function supportedNode(version) {
  const [major, minor, patch] = version.replace(/^v/, '').split('.').map(Number);
  return major === 24 && (minor > 13 || minor === 13 && patch >= 1);
}
export async function doctor(dir, { version = process.version, run = spawnSync, fetchImpl = fetch, root = repoRoot } = {}) {
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
      if (role === 'node') {
        url ??= config.hubUrl;
        secrets.add(resolve(dir, config.credentialFile ?? `${config.dataDir}/machine.json`));
        if (config.enrollmentCodeFile) secrets.add(resolve(dir, config.enrollmentCodeFile));
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
  return checks;
}
