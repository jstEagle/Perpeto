import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { sleep } from './hub.js';

/** RuntimeSupervisor: { start(): Promise<string|undefined>, stop(): Promise<void> }. */
export function createRuntimeSupervisor(config = {}, { configRoot = process.cwd() } = {}) {
  let child;
  let exited;
  let readyUrl = config.url;
  return {
    async start({ signal } = {}) {
      signal?.throwIfAborted();
      if (!config.enabled) return readyUrl;
      if (!config.repoRoot || !config.url) throw new Error('Managed runtime requires repoRoot and url.');
      const repoRoot = resolve(configRoot, config.repoRoot);
      const url = new URL(config.url);
      if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('T3 runtime URL must use loopback without credentials.');
      const occupied = await new Promise(resolve => {
        const socket = createConnection({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) });
        const done = value => { socket.destroy(); resolve(value); };
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
        socket.setTimeout(500, () => done(true));
      });
      if (occupied) throw new Error('Managed runtime URL is already in use.');
      signal?.throwIfAborted();
      child = spawn(process.execPath, [resolve(repoRoot, 'scripts/runtime.mjs'), 'start'], {
        cwd: repoRoot, stdio: 'ignore', detached: process.platform !== 'win32',
      });
      let failed = false;
      exited = new Promise(resolve => {
        child.once('exit', () => { failed = true; resolve(); });
        child.once('error', () => { failed = true; resolve(); });
      });
      const deadline = Date.now() + (config.startTimeoutMs ?? 30000);
      while (Date.now() < deadline) {
        if (failed) throw new Error('Managed T3 runtime exited during startup.');
        try {
          const response = await fetch(config.url, { redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(1000), ...(signal ? [signal] : [])]) });
          await response.body?.cancel();
          if (response.ok) return readyUrl;
        } catch { /* Wait for the inherited launcher. */ }
        await sleep(100, signal);
      }
      throw new Error('Managed T3 runtime did not become ready.');
    },
    async stop() {
      if (!child) return;
      const kill = signal => {
        try { if (process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Already stopped. */ }
      };
      kill('SIGTERM');
      let timer;
      try { await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 2000); })]); }
      finally { clearTimeout(timer); }
      kill('SIGKILL');
      await exited;
      child = undefined;
    },
  };
}
