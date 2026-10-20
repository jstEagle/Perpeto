import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function readConfiguration(filename = resolve(projectRoot, 'config/perpeto.json')) {
  const config = JSON.parse(readFileSync(filename, 'utf8'));
  const runtime = config.runtime;
  if (!runtime || typeof runtime.directory !== 'string' || !runtime.directory.trim() ||
      typeof runtime.dataDirectory !== 'string' || !runtime.dataDirectory.trim() ||
      typeof runtime.host !== 'string' || !runtime.host.trim() ||
      !Number.isInteger(runtime.port) || runtime.port < 1 || runtime.port > 65535 ||
      typeof runtime.openBrowser !== 'boolean') {
    throw new Error('Invalid runtime settings in config/perpeto.json');
  }
  return {
    directory: resolve(projectRoot, runtime.directory),
    dataDirectory: resolve(projectRoot, runtime.dataDirectory),
    host: runtime.host,
    port: runtime.port,
    openBrowser: runtime.openBrowser,
  };
}

export function runtimeArguments(config) {
  return [config.openBrowser ? 'start' : 'serve', '--base-dir', config.dataDirectory, '--host', config.host,
    '--port', String(config.port), '--auto-bootstrap-project-from-cwd=false',
    ...(config.openBrowser ? [] : ['--no-browser'])];
}

function main() {
  const action = process.argv[2];
  const config = readConfiguration();
  let command;
  let args;
  switch (action) {
    case 'setup':
      command = 'pnpm'; args = ['install', '--frozen-lockfile', '--filter', 't3...', '--filter', '@t3tools/scripts...']; break;
    case 'build':
      command = process.execPath; args = [resolve(config.directory, 'node_modules/vite-plus/bin/vp'), 'run', '--filter', 't3', 'build']; break;
    case 'test':
      command = process.execPath; args = [resolve(config.directory, 'node_modules/vite-plus/bin/vp'), 'test', 'run',
        'apps/server/src/orchestration-v2/runtimeLayer.test.ts',
        'apps/server/src/provider/ProviderRegistry.test.ts',
        'apps/server/src/perpeto/http.test.ts',
        'apps/server/src/http.test.ts',
        'apps/web/src/components/factory/messaging.test.ts',
        'packages/client-runtime/src/state/factoryMessagingHttp.test.ts',
        'packages/client-runtime/src/state/projectGrouping.test.ts']; break;
    case 'start':
    case 'help': {
      const entry = resolve(config.directory, 'apps/server/dist/bin.mjs');
      if (!existsSync(entry)) throw new Error('Runtime has not been built. Run npm run setup, then npm run build.');
      command = process.execPath;
      args = [entry, ...(action === 'help' ? ['--help'] : runtimeArguments(config))];
      break;
    }
    default:
      throw new Error('Usage: node scripts/runtime.mjs setup|build|start|help|test');
  }
  // Upstream prepare installs Git hooks for its own workspace. Keep the host
  // repository's hook configuration instead of pointing it at a nested project.
  const previousHooks = action === 'setup'
    ? spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], {cwd:projectRoot, encoding:'utf8'})
    : null;
  const child = spawn(command, args, { cwd: config.directory, stdio: 'inherit', shell: false });
  const signals = ['SIGINT', 'SIGTERM'];
  const handlers = signals.map(signal => {
    const handler = () => { if (!child.killed) child.kill(signal); };
    process.on(signal, handler);
    return handler;
  });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => {
    signals.forEach((item, i) => process.off(item, handlers[i]));
    if (previousHooks) {
      const value = previousHooks.stdout?.trim();
      const restore = value && value !== 'vendor/t3code/.vite-hooks/_'
        ? ['config', '--local', 'core.hooksPath', value]
        : ['config', '--local', '--unset-all', 'core.hooksPath'];
      const result = spawnSync('git', restore, {cwd:projectRoot, encoding:'utf8'});
      if (result.status !== 0 && result.status !== 5) {
        console.error('Unable to restore repository Git hook configuration.');
        process.exitCode = 1;
        return;
      }
    }
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
