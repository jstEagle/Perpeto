/**
 * Hub scale load test (not part of `npm test`; it runs for over a minute).
 *
 *   node apps/hub/test/load.js [--duration 60] [--machines 100] [--queued 1000] [--hub path/to/perpeto-hub.js]
 *
 * A real hub runs in a child process with the real workflow engine, so the simulated machines do not share its event
 * loop. One run queues `--queued` assignments that require the label `gpu`. Half of the machines have that label and
 * capacity for two agents; the other half cannot run the queued work, so their assignment polls wait, as a mixed fleet's
 * would. Every machine heartbeats every 10 s (staggered) and, like the node daemon, keeps an assignment long-poll open
 * while it has free capacity and a job long-poll open always. Leased work renews every 10 s and completes after
 * 15–30 s (renewals every 10 s are twice the node's default rate). Failed requests back off like the node daemon.
 * Machines start over the first 5 s and, like the node, heartbeat once before polling. Every POST carries a fresh idempotency key, as the node sends. The report gives p50/p99/max latency per
 * request type and the hub process's CPU time over the measured window.
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Agent, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const option = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index === -1 ? fallback : Number(process.argv[index + 1]); };
const durationMs = option('duration', 60) * 1000; const machineCount = option('machines', 100); const queued = option('queued', 1000);
// --hub runs another checkout's hub binary, for before/after comparisons.
const hubBin = process.argv.includes('--hub') ? process.argv[process.argv.indexOf('--hub') + 1] : new URL('../bin/perpeto-hub.js', import.meta.url).pathname;

const root = await mkdtemp(join(tmpdir(), 'perpeto-hub-load-'));
const configPath = join(root, 'hub.json');
await writeFile(configPath, JSON.stringify({ port: 0, heartbeatIntervalMs: 10000, leaseDurationMs: 60000, longPollMs: 25000, maintenanceIntervalMs: 1000 }));
const hub = spawn(process.execPath, [hubBin, '--config', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
const exited = new Promise(resolve => hub.once('exit', resolve));
const url = await new Promise((resolve, reject) => {
  let output = ''; hub.stdout.on('data', data => { output += data; const match = /listening at (http:\/\/\S+)/.exec(output); if (match) resolve(match[1]); });
  hub.once('exit', code => reject(new Error(`Hub exited ${code}`)));
});
const owner = (await readFile(join(root, 'owner.secret'), 'utf8')).trim();
const cpuSeconds = () => execFileSync('ps', ['-o', 'time=', '-p', String(hub.pid)], { encoding: 'utf8' }).trim().split(':').reverse()
  .reduce((total, part, index) => total + Number(part.replace(',', '.')) * 60 ** index, 0);

// node:http with keep-alive; undici's fetch crashed under this many concurrent long-polls on Node 24.22. Idle sockets
// close before the server's 5 s keep-alive timeout, so a request never races the server closing its socket.
const agent = new Agent({ keepAlive: true, maxSockets: Infinity, timeout: 4000 });
function call(method, path, body, token = owner, signal, viaAgent = agent) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const outgoing = request(`${url}/api/v1${path}`, { method, agent: viaAgent, signal, headers: { Authorization: `Bearer ${token}`, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
      response.on('end', () => { try { resolve({ status: response.statusCode, body: JSON.parse(text) }); } catch (error) { reject(error); } });
      response.on('error', reject);
    });
    outgoing.on('error', reject); outgoing.end(payload);
  });
}
async function owned(method, path, body) {
  const result = await call(method, path, body, owner, undefined, false);
  if (result.status >= 300) throw new Error(`${method} ${path} -> ${result.status} ${JSON.stringify(result.body)}`);
  return result.body;
}

// Queue the work: one run whose builder needs a gpu machine, fed 100 items per input event.
const node = (id, type, config = {}) => ({ id, type, label: id, position: { x: 0, y: 0 }, config });
const flow = (from, to) => ({ id: `${from}-${to}`, kind: 'flow', from: { node: from }, to: { node: to } });
const project = await owned('POST', '/projects', { name: 'Load', repo: { url: '/tmp/load.git', defaultBranch: 'main' } });
const workflow = await owned('POST', `/projects/${project.id}/workflows`, { name: 'Load', graph: { schema: 'perpeto.workflow/1', nodes: [
  node('ideas', 'input', { source: 'manual' }),
  node('builder', 'agent', { harness: { provider: 'codex', model: 'load' }, prompt: 'Build it.', concurrency: 1000, requirements: { labels: ['gpu'] } }),
  node('done', 'output'),
], edges: [flow('ideas', 'builder'), flow('builder', 'done')] } });
await owned('POST', `/workflows/${workflow.id}/activate`, { version: 1 });
const items = count => Array.from({ length: count }, (_, index) => ({ title: `Item ${index}`, body: 'x'.repeat(2048) }));
const run = await owned('POST', `/workflows/${workflow.id}/runs`, { input: { items: items(Math.min(100, queued)) } });
for (let added = 100; added < queued; added += 100) await owned('POST', `/runs/${run.id}/inputs`, { items: items(Math.min(100, queued - added)) });
const waiting = (await owned('GET', `/runs/${run.id}/assignments`)).assignments.filter(value => value.status === 'queued').length;

const machines = [];
for (let index = 0; index < machineCount; index++) {
  const { code } = await owned('POST', '/machines/enrollment-codes', {});
  const gpu = index % 2 === 0;
  const enrolled = await owned('POST', '/nodes/enroll', { code, name: `load-${index}`, os: 'linux', arch: 'x64', providers: ['codex'], labels: gpu ? ['ci', 'gpu'] : ['ci'], version: 'load' });
  machines.push({ ...enrolled, gpu, active: new Map() });
}

const samples = { heartbeat: [], 'lease (returned work)': [], 'lease (long-poll, empty)': [], renew: [], complete: [] };
const errors = {}; const counts = { leased: 0, completed: 0 };
const stop = new AbortController(); let measuring = true;
const record = (kind, started) => { if (measuring) samples[kind].push(performance.now() - started); };
const failed = (kind, status) => { const key = `${kind} ${status}`; errors[key] = (errors[key] ?? 0) + 1; };
async function timed(kind, method, path, body, token, classify) {
  const started = performance.now();
  try {
    const result = await call(method, path, { ...body, idempotencyKey: randomUUID() }, token, stop.signal);
    if (result.status >= 300) failed(kind, result.status);
    else record(classify ? classify(result.body) : kind, started);
    return result;
  } catch (error) { if (!stop.signal.aborted) failed(kind, error.code ?? error.name); return null; }
}
const pause = ms => sleep(ms, undefined, { signal: stop.signal }).catch(() => {});
/** The node daemon's retry backoff: 250 ms doubling to 10 s, with full jitter. */
const backoff = failures => pause(Math.random() * Math.min(10000, 250 * 2 ** failures));

const beat = machine => timed('heartbeat', 'POST', '/nodes/heartbeat', { status: 'online', capacity: { maxAgents: 2, maxJobs: 1 },
  running: { agents: machine.active.size, jobs: 0 }, providers: ['codex'], accounts: [] }, machine.token);
async function heartbeats(machine) {
  // Like the node daemon: the first heartbeat precedes polling; later ones are staggered across the fleet.
  await pause(Math.random() * 10000);
  while (!stop.signal.aborted) { await beat(machine); await pause(10000); }
}
async function work(machine, assignment) {
  const until = performance.now() + 15000 + Math.random() * 15000;
  while (!stop.signal.aborted && performance.now() < until) {
    await pause(Math.min(10000, until - performance.now()));
    if (stop.signal.aborted) break;
    if (performance.now() < until) await timed('renew', 'POST', `/assignments/${assignment.id}/renew`, { attempt: assignment.attempt }, machine.token);
  }
  if (!stop.signal.aborted) {
    const result = await timed('complete', 'POST', `/assignments/${assignment.id}/events`, { attempt: assignment.attempt, type: 'completed', data: { outcome: 'success', summary: 'Done.' } }, machine.token);
    if (result?.status === 200) counts.completed++;
  }
  machine.active.delete(assignment.id);
}
async function assignmentPolls(machine) {
  let failures = 0;
  while (!stop.signal.aborted) {
    if (machine.active.size >= 2) { await pause(200); continue; }
    const result = await timed('lease', 'POST', '/nodes/lease', { kinds: ['assignment'], max: 2 - machine.active.size }, machine.token,
      body => body.assignments.length ? 'lease (returned work)' : 'lease (long-poll, empty)');
    for (const assignment of result?.body?.assignments ?? []) { counts.leased++; machine.active.set(assignment.id, work(machine, assignment)); }
    if (result?.status === 200) failures = 0; else await backoff(failures++);
  }
}
async function jobPolls(machine) {
  let failures = 0;
  while (!stop.signal.aborted) {
    const result = await timed('lease', 'POST', '/nodes/lease', { kinds: ['job'], max: 1 }, machine.token, () => 'lease (long-poll, empty)');
    if (result?.status === 200) failures = 0; else await backoff(failures++);
  }
}

const cpuBefore = cpuSeconds(); const started = performance.now();
// Machines start over 5 s, as a fleet reconnecting would; a simultaneous burst overflows macOS's default listen backlog (128).
const loops = machines.map(async (machine, index) => {
  await pause(index * 5000 / machines.length);
  await beat(machine);
  await Promise.all([heartbeats(machine), assignmentPolls(machine), jobPolls(machine)]);
});
await sleep(durationMs);
measuring = false; const elapsed = (performance.now() - started) / 1000; const cpuUsed = cpuSeconds() - cpuBefore;
stop.abort();
await Promise.allSettled([...loops, ...machines.flatMap(machine => [...machine.active.values()])]);
let remaining = null;
for (let attempt = 0; attempt < 20 && remaining === null; attempt++) {
  try { remaining = (await owned('GET', `/runs/${run.id}/assignments`)).assignments.filter(value => value.status === 'queued').length; }
  catch { await sleep(1000); }
}
agent.destroy(); hub.kill('SIGTERM'); await exited; await rm(root, { recursive: true, force: true });

const percentile = (values, p) => values.length ? values[Math.min(values.length - 1, Math.ceil(p / 100 * values.length) - 1)] : null;
const round = value => value === null ? null : Math.round(value * 10) / 10;
const report = Object.fromEntries(Object.entries(samples).map(([kind, values]) => {
  values.sort((a, b) => a - b);
  return [kind, { count: values.length, p50Ms: round(percentile(values, 50)), p99Ms: round(percentile(values, 99)), maxMs: round(values.at(-1) ?? null) }];
}));
console.log(JSON.stringify({ machines: machineCount, queuedAtStart: waiting, seconds: Math.round(elapsed), hubCpuSeconds: round(cpuUsed),
  leased: counts.leased, completed: counts.completed, queuedAtEnd: remaining, errors, latency: report }, null, 2));
