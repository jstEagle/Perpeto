import { createServer, createConnection } from 'node:net';
import { open, chmod, unlink, mkdir, rmdir, readFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { configPath, privateDir, readJson, repoRoot, writeNew } from './config.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const socketPath = (dir, role) => resolve(dir, `${role}.sock`);
const exec = promisify(execFile);
async function processIdentity(pid) {
  const { stdout } = await exec('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
    env: { ...process.env, LC_ALL: 'C' }, timeout: 5000,
  });
  if (!stdout.trim()) throw new Error('Cannot determine process start identity.');
  return stdout.trim();
}
export async function acquireLock(dir, role, { recover = true } = {}) {
  const path = resolve(dir, `${role}.lock`);
  const value = JSON.stringify({ pid: process.pid, startIdentity: await processIdentity(process.pid), id: randomUUID() });
  const create = () => writeNew(path, value);
  try { await create(); } catch (error) {
    if (error.code !== 'EEXIST' || !recover) throw error;
    const recovery = `${path}.recovery`;
    await mkdir(recovery, { mode: 0o700 });
    try {
      const previous = await readJson(path);
      if (!Number.isInteger(previous.pid) || previous.pid < 1) throw new Error('Invalid process lock. Inspect it manually.');
      let alive = true;
      try { process.kill(previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive && typeof previous.startIdentity === 'string' && previous.startIdentity) {
        // Failure to inspect a live PID remains conservative; never signal it.
        const identity = await processIdentity(previous.pid).catch(() => null);
        if (identity && identity !== previous.startIdentity) alive = false;
      }
      if (alive) throw new Error('Process is already running or starting.');
      await unlink(path);
      await create();
    } finally { await rmdir(recovery); }
  }
  return async () => { if (await readFile(path, 'utf8').catch(() => '') === value) await unlink(path); };
}
export function control(dir, role, action = 'status', timeout = 1500) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath(dir, role)); let data = '';
    const done = (error, value) => { socket.destroy(); error ? reject(error) : resolve(value); };
    socket.setTimeout(timeout, () => done(new Error('Local daemon did not respond.')));
    socket.on('error', error => done(error));
    socket.once('connect', () => socket.write(`${action}\n`));
    socket.on('data', chunk => {
      data += chunk;
      if (data.length > 16384) return done(new Error('Invalid daemon response.'));
      if (data.includes('\n')) {
        try { done(null, JSON.parse(data)); } catch { done(new Error('Invalid daemon response.')); }
      }
    });
    socket.on('end', () => { if (!data.includes('\n')) done(new Error('Daemon disconnected.')); });
  });
}
export async function daemon(dir, role) {
  await privateDir(dir);
  const release = await acquireLock(dir, role);
  let runtime; let server; let stopping; let url; let ready = false; let initialized;
  const initialization = new Promise(resolve => { initialized = resolve; });
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const stop = () => stopping ??= (async () => {
    try {
      ready = false;
      // Node startup can retry the network indefinitely. Abort it before waiting.
      const nodeStopping = role === 'node' && runtime ? runtime.stop() : null;
      await initialization;
      await (role === 'hub' ? runtime?.close() : nodeStopping ?? runtime?.stop());
      if (server?.listening) await new Promise(resolve => server.close(resolve));
    } finally {
      await unlink(socketPath(dir, role)).catch(() => {});
      await release(); finish();
    }
  })();
  const signal = () => { stop().catch(() => { process.exitCode = 1; }); };
  process.on('SIGINT', signal); process.on('SIGTERM', signal);
  try {
    if (role === 'hub') {
      const { createHub } = await import('@perpeto/hub');
      runtime = await createHub({ configPath: configPath(dir, role) });
    } else {
      const { createNode } = await import('@perpeto/node');
      runtime = await createNode({ configPath: configPath(dir, role), onStatus(status) {
        if (status.state === 'error') { process.exitCode = 1; signal(); }
      } });
    }
    await unlink(socketPath(dir, role)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    server = createServer(socket => {
      socket.setTimeout(1500, () => socket.destroy());
      let buffer = '';
      socket.on('error', () => {});
      socket.on('data', chunk => {
        buffer += chunk;
        if (buffer.length > 64) return socket.destroy();
        if (!buffer.includes('\n')) return;
        const action = buffer.trim();
        if (action === 'drain' && role === 'node') runtime.drain();
        socket.end(`${JSON.stringify({ ...(role === 'hub' ? { url } : runtime.status), role,
          state: stopping ? 'stopping' : !ready ? 'starting' : role === 'hub' ? 'running' : runtime.status.state })}\n`);
        if (action === 'stop') socket.once('close', signal);
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath(dir, role), resolve); });
    await chmod(socketPath(dir, role), 0o600);
    if (!stopping) {
      if (role === 'hub') url = await runtime.listen(); else await runtime.start();
      ready = !stopping;
    }
    initialized();
    await finished;
  } catch {
    initialized();
    await stop();
    throw new Error(`${role} daemon failed. Check configuration, credentials, package integration and port availability.`);
  } finally { process.off('SIGINT', signal); process.off('SIGTERM', signal); }
}
export async function start(dir, role) {
  await privateDir(dir);
  await readJson(configPath(dir, role));
  const existing = await control(dir, role).catch(() => null);
  if (existing && existing.state !== 'starting') return existing;
  const logPath = resolve(dir, `${role}.log`);
  const log = await open(logPath, 'a', 0o600);
  let child;
  try {
    let failed = false;
    if (!existing) {
      child = spawn(process.execPath, [resolve(repoRoot, 'apps/cli/bin/perpeto.js'), role, 'run', '--dir', dir], {
        detached: true, stdio: ['ignore', log.fd, log.fd], cwd: repoRoot,
      });
      child.once('error', () => { failed = true; }); child.once('exit', () => { failed = true; }); child.unref();
    }
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !failed) {
      const status = await control(dir, role).catch(() => null);
      if (status?.state === 'running' || status?.state === 'draining') return status;
      await sleep(100);
    }
    throw new Error(`${role} did not become ready within 10 seconds. Inspect ${role}.log and ${role} status; startup may still be running.`);
  } finally { await log.close(); }
}
export async function stop(dir, role) {
  const status = await control(dir, role, 'stop').catch(error => {
    if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) return { role, state: 'stopped' };
    throw error;
  });
  if (status.state === 'stopped') return status;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { await readFile(resolve(dir, `${role}.lock`)); }
    catch (error) { if (error.code === 'ENOENT') return { role, state: 'stopped' }; throw error; }
    await sleep(100);
  }
  return { role, state: 'stopping', message: 'Active work is draining. Check status for completion.' };
}
