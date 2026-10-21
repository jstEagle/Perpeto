import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RunnerQueue } from '../src/queue.js';

const worker = fileURLToPath(new URL('../src/worker.js', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (check()) return; await delay(25); }
  throw new Error('Timed out waiting for watch condition.');
}

async function fixture(t, { pollIntervalMs = 100, retryIntervalMs = 200, rejectClaims = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'perpeto-watch-'));
  const source = join(directory, 'source'); mkdirSync(source);
  const git = args => execFileSync('git', ['-c', 'user.name=Runner Test', '-c', 'user.email=runner@example.invalid', ...args], { cwd: source, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git(['init']); writeFileSync(join(source, 'value.txt'), 'pinned');
  git(['add', '.']); git(['commit', '-m', 'watch fixture']); const revision = git(['rev-parse', 'HEAD']);
  const queue = new RunnerQueue(join(directory, 'runner.sqlite'));
  const token = 'watch-test-secret';
  const credential = join(directory, 'runner.secret'); writeFileSync(credential, token, { mode: 0o600 });
  let claims = 0; let completions = 0;
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end('{}'); return; }
      let text = ''; for await (const chunk of request) text += chunk;
      const body = JSON.parse(text); let result;
      const parts = request.url.split('/');
      if (request.url.endsWith('/claim')) {
        claims++;
        if (rejectClaims) { response.writeHead(503).end(JSON.stringify({ error: token })); return; }
        result = queue.claim(body);
      } else if (request.url.endsWith('/heartbeat')) result = queue.heartbeat({ ...body, id: parts.at(-2) });
      else if (request.url.endsWith('/complete')) { completions++; result = queue.complete({ ...body, id: parts.at(-2) }); }
      else { response.writeHead(404).end('{}'); return; }
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result));
    } catch { response.writeHead(409).end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const configFile = join(directory, 'runner.json');
  writeFileSync(configFile, JSON.stringify({
    baseUrl: `http://127.0.0.1:${server.address().port}`, credentialFile: credential,
    runnerId: 'watch-machine', labels: [], repositories: { app: source }, executables: { node: process.execPath },
    workDirectory: join(directory, 'work'), toolPath: process.env.PATH, timeoutMs: 10000,
    maxOutputBytes: 1000, leaseMs: 3000, artifactPaths: [], pollIntervalMs, retryIntervalMs,
  }));
  const children = [];
  const start = (mode = 'watch') => {
    const child = spawn(process.execPath, [worker, mode, '--config', configFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    const state = { child, stdout: '', stderr: '', exited: false };
    child.stdout.on('data', data => { state.stdout += data; });
    child.stderr.on('data', data => { state.stderr += data; });
    state.closed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => { state.exited = true; resolve({ code, signal }); }); });
    children.push(state); return state;
  };
  t.after(async () => {
    for (const child of children) if (!child.exited) child.child.kill('SIGKILL');
    await Promise.all(children.map(child => child.closed));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    queue.close(); rmSync(directory, { recursive: true, force: true });
  });
  const submit = command => queue.submit({ projectId: 'factory', repositoryId: 'app', revision, command, idempotencyKey: 'watch-job' }).job;
  return { directory, queue, start, submit, token, get claims() { return claims; }, get completions() { return completions; } };
}

test('watch claims a job arriving after idle polling and completes its pinned checkout', async t => {
  const f = await fixture(t);
  const process = f.start();
  await until(() => f.claims >= 2 || process.exited);
  assert.equal(process.exited, false, process.stderr);
  const job = f.submit(['node', '-e', "if(require('node:fs').readFileSync('value.txt','utf8')!=='pinned')process.exit(2);console.log('watch verified')"]);
  await until(() => f.queue.get(job.id).status === 'succeeded');
  assert.equal(f.completions, 1);
  assert.match(f.queue.get(job.id).result.log, /watch verified/);
  process.child.kill('SIGTERM');
  const exit = await process.closed;
  assert.equal(exit.code, 0, process.stderr);
  assert.ok(!`${process.stdout}${process.stderr}`.includes(f.token));
});

test('watch SIGTERM interrupts a long idle wait promptly with clean exit', async t => {
  const f = await fixture(t, { pollIntervalMs: 60000 });
  const process = f.start();
  await until(() => f.claims >= 1 || process.exited);
  assert.equal(process.exited, false, process.stderr);
  await delay(50);
  const started = Date.now(); process.child.kill('SIGTERM');
  const exit = await process.closed;
  assert.equal(exit.code, 0, process.stderr);
  assert.ok(Date.now() - started < 1000, 'idle shutdown must not wait for poll interval');
});

for (const mode of ['watch', 'once']) test(`${mode} SIGTERM kills active descendants, withholds completion, and leaves explicit lost/retry state`, async t => {
  const f = await fixture(t);
  const pidFile = join(f.directory, 'job-pids.json');
  const script = `const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`;
  const job = f.submit(['node', '-e', script]);
  const process = f.start(mode);
  await until(() => { try { return JSON.parse(readFileSync(pidFile, 'utf8')).length === 2; } catch { return false; } });
  const pids = JSON.parse(readFileSync(pidFile, 'utf8'));
  const started = Date.now(); process.child.kill('SIGTERM');
  const exit = await process.closed;
  assert.equal(exit.code, 0, process.stderr);
  assert.ok(Date.now() - started < 1500, 'active shutdown must stop promptly');
  const alive = pid => { try { globalThis.process.kill(pid, 0); return true; } catch { return false; } };
  t.after(() => { for (const pid of pids) if (alive(pid)) try { globalThis.process.kill(pid, 'SIGKILL'); } catch {} });
  await until(() => pids.every(pid => !alive(pid)), 2000);
  assert.equal(f.completions, 0);
  await until(() => f.queue.get(job.id).status === 'lost', 4000);
  assert.equal(f.queue.retry(job.id).status, 'queued');
});

test('watch connection errors use configured backoff and do not disclose server error bodies', async t => {
  const f = await fixture(t, { retryIntervalMs: 300, rejectClaims: true });
  const process = f.start();
  await until(() => f.claims >= 1 || process.exited);
  assert.equal(process.exited, false, process.stderr);
  await delay(650);
  assert.ok(f.claims <= 3, 'failed claims must not form a tight retry loop');
  process.child.kill('SIGINT');
  assert.equal((await process.closed).code, 0, process.stderr);
  assert.ok(!`${process.stdout}${process.stderr}`.includes(f.token));
});
