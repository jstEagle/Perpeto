import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { createHub } from '@perpeto/hub';
import { createNode, ExecutorRegistry } from '@perpeto/node';

const run = promisify(execFile);

/** Absolute path of a workspace package's declared bin. */
export function packageBin(name, bin) {
  const manifest = fileURLToPath(import.meta.resolve(`${name}/package.json`));
  const { bin: bins } = JSON.parse(readFileSync(manifest, 'utf8'));
  return join(dirname(manifest), bins[bin]);
}

const identity = ['-c', 'user.name=Factory Agent', '-c', 'user.email=agent@perpeto.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];

export async function git(cwd, ...args) {
  const { stdout } = await run('git', [...identity, ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return stdout.trim();
}

/** A bare repository with one commit on main, standing in for the project's remote. */
export async function bareRepository(root) {
  const bare = join(root, 'project.git'); const seed = join(root, 'seed');
  await run('git', ['init', '--bare', '--initial-branch=main', bare]);
  await run('git', ['clone', bare, seed]);
  await writeFile(join(seed, 'README.md'), '# Fixture project\n');
  await git(seed, 'add', 'README.md'); await git(seed, 'commit', '-m', 'Initial commit'); await git(seed, 'push', 'origin', 'HEAD:main');
  return bare;
}

export async function eventually(check, { timeoutMs = 45000, intervalMs = 50, message = 'Condition did not become true.' } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { const value = await check(); if (value) return value; await sleep(intervalMs); }
  throw new Error(message);
}

/**
 * Start a real hub (ephemeral port, temporary SQLite and secrets) and enroll a real node daemon with `executor`.
 * `separateNode` gives the node its own temporary root, sharing no directory with the hub; `node` may then be a
 * function of `{ root }` (the hub's root) for settings that name hub paths.
 */
export async function startFactory(t, { executor, hub: hubConfig = {}, node: nodeConfig = {}, subprocess = false, separateNode = false, clock }) {
  const root = await mkdtemp(join(tmpdir(), 'perpeto-e2e-'));
  await chmod(root, 0o700);
  const cleanups = [];
  t.after(async () => { for (const fn of cleanups.reverse()) await fn().catch(() => {}); await rm(root, { recursive: true, force: true }); });

  const hubPath = join(root, 'hub.json');
  await writeFile(hubPath, JSON.stringify({ port: 0, databasePath: './hub/hub.sqlite', messagingDatabasePath: './hub/messaging.sqlite',
    deliveryDatabasePath: './hub/delivery.sqlite', ownerTokenPath: './hub/owner.secret', heartbeatIntervalMs: 1000, leaseDurationMs: 15000,
    longPollMs: 2000, maintenanceIntervalMs: 50, ...hubConfig }));
  const hub = subprocess ? await processHub(hubPath, subprocess) : await createHub({ configPath: hubPath, clock });
  const url = subprocess ? hub.url : await hub.listen();
  cleanups.push(() => hub.close());
  const owner = (await readFile(join(root, 'hub/owner.secret'), 'utf8')).trim();
  const request = async (method, path, body) => {
    const response = await fetch(`${url}/api/v1${path}`, { method, signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${owner}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(`${method} ${path} -> ${response.status} ${data?.error?.code}: ${data?.error?.message}`), { status: response.status, body: data });
    return data;
  };

  const enrollment = await request('POST', '/machines/enrollment-codes', {});
  const nodeRoot = separateNode ? await mkdtemp(join(tmpdir(), 'perpeto-e2e-node-')) : root;
  if (separateNode) { await chmod(nodeRoot, 0o700); t.after(() => rm(nodeRoot, { recursive: true, force: true })); }
  const nodeDir = join(nodeRoot, 'node'); await mkdir(nodeDir, { mode: 0o700 });
  if (typeof nodeConfig === 'function') nodeConfig = nodeConfig({ root });
  await writeFile(join(nodeDir, 'enrollment-code'), enrollment.code, { mode: 0o600 });
  const nodePath = join(nodeDir, 'node.json');
  await writeFile(nodePath, JSON.stringify({ hubUrl: url, name: 'e2e-machine', dataDir: './data', enrollmentCodeFile: './enrollment-code',
    labels: ['e2e'], capacity: { maxAgents: 2, maxJobs: 1 }, providers: [], fake: {}, executorPackages: [], accounts: {},
    // The host's real load must not shrink test capacity; fleet tests inject their own health.
    health: { enabled: false },
    timing: { heartbeatMs: 200, renewMs: 1000, requestMs: 5000, pollIdleMs: 20, backoffMinMs: 20, backoffMaxMs: 200 }, ...nodeConfig }));
  const node = await createNode({ configPath: nodePath, registry: new ExecutorRegistry().register(executor), clock });
  await node.start();
  cleanups.push(() => node.stop({ drain: false }));

  async function events() {
    const all = []; let after = 0;
    for (;;) {
      const page = await request('GET', `/events?after=${after}&limit=1000`);
      all.push(...page.events);
      if (page.events.length < 1000) return all;
      after = page.nextCursor;
    }
  }
  return { root, nodeRoot, url, owner, request, hub, node, events, nodeDataDir: join(nodeDir, 'data') };
}

/** Load the default build template and point every role at the `fake` provider the e2e executor serves. */
export async function buildTemplate(edit = graph => graph) {
  const graph = JSON.parse(await readFile(new URL(import.meta.resolve('@perpeto/workflow/templates/build.json')), 'utf8'));
  for (const node of graph.nodes) if (node.config.harness) node.config.harness = { provider: 'fake', model: `fake-${node.id}` };
  return edit(graph);
}

const titleOf = prompt => /^Work item: (.*)$/m.exec(prompt)?.[1] ?? 'work';
const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Test executor for the e2e run. It never calls a model. Planners return work items; builders make real commits on a
 * branch of the bare repository (crashing once for titles in `crashOnce`); reviewers reject each item once, then pass
 * it; the architect is supplied by the test.
 */
export function createFactoryExecutor({ architect, crashOnce = [], usage = { inputTokens: 120, outputTokens: 30 } }) {
  const reviews = new Map(); const calls = []; const crashed = new Set();
  return {
    kind: 'e2e-fake', calls,
    canRun: assignment => assignment.harness?.provider === 'fake',
    async run(assignment, ctx) {
      calls.push({ id: assignment.id, role: assignment.role, nodeType: assignment.nodeType, workItemId: assignment.workItemId, prompt: assignment.prompt, repo: assignment.repo });
      await ctx.report({ type: 'usage', data: { provider: 'fake', model: assignment.harness.model, ...usage } });
      if (assignment.role === 'workflow-architect') return architect(assignment, calls.filter(call => call.role === 'workflow-architect').length);
      if (assignment.nodeType === 'planner') {
        return { outcome: 'success', summary: 'Split the idea into two pull requests.',
          items: [{ title: 'Greeting', body: 'Add features/greeting.txt.' }, { title: 'Farewell', body: 'Add features/farewell.txt.' }] };
      }
      if (assignment.nodeType === 'review') {
        const count = (reviews.get(assignment.workItemId) ?? 0) + 1; reviews.set(assignment.workItemId, count);
        return count === 1
          ? { outcome: 'success', verdict: 'fail', summary: 'Mark the feature file as reviewed before it can merge.' }
          : { outcome: 'success', verdict: 'pass', summary: 'Ready to merge.' };
      }
      // Simulates a harness crash: the node reports it as a failed attempt and the engine's retry policy takes over.
      const title = titleOf(assignment.prompt);
      if (crashOnce.includes(title) && !crashed.has(title)) { crashed.add(title); throw new Error('Simulated harness crash.'); }
      const branch = `perpeto/${assignment.workItemId}`; const source = join(ctx.workspace, 'source');
      await git(ctx.workspace, 'clone', '--quiet', assignment.repo.localPath ?? assignment.repo.url, source);
      const existing = await git(source, 'ls-remote', '--heads', 'origin', branch);
      await git(source, 'checkout', '-B', branch, existing ? `origin/${branch}` : 'origin/main');
      const file = `features/${slug(titleOf(assignment.prompt))}.txt`;
      await mkdir(join(source, 'features'), { recursive: true });
      const addressed = assignment.prompt.includes('Feedback to address (review');
      await writeFile(join(source, file), `${titleOf(assignment.prompt)}\n${addressed ? 'reviewed: yes\n' : ''}`);
      await git(source, 'add', file); await git(source, 'commit', '-m', `${addressed ? 'Address review on' : 'Add'} ${file}`);
      await git(source, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
      return { outcome: 'success', summary: `Committed ${file}.`, branch, prUrl: `local:${branch}`, headSha: await git(source, 'rev-parse', 'HEAD') };
    },
  };
}

/** A real hub CLI process, restarted against the same port and durable files after SIGKILL. */
async function processHub(configPath, options) {
  let child, exited, url;
  const preload = `${configPath}.fault.mjs`;
  const imports = [];
  if (options.pauseBeforeMergedSync) {
    const { barrier, release } = options.pauseBeforeMergedSync;
    await writeFile(preload, `
      import { HubDelivery } from ${JSON.stringify(import.meta.resolve('@perpeto/hub/delivery'))};
      import { existsSync, writeFileSync } from 'node:fs';
      import { setTimeout as sleep } from 'node:timers/promises';
      let released = existsSync(${JSON.stringify(release)});
      const sync = HubDelivery.prototype.sync;
      HubDelivery.prototype.sync = async function (...args) {
        released ||= existsSync(${JSON.stringify(release)});
        if (!released && [...this.queues.values()].some(queue => queue.state.entries.some(entry => entry.status === 'merged')) && !existsSync(${JSON.stringify(release)})) {
          writeFileSync(${JSON.stringify(barrier)}, 'delivery committed before hub sync');
          while (!existsSync(${JSON.stringify(release)})) await sleep(20);
          released = true;
        }
        return sync.apply(this, args);
      };
    `);
    imports.push('--import', preload);
  }
  async function start() {
    child = spawn(process.execPath, [...imports, packageBin('@perpeto/hub', 'perpeto-hub'), '--config', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    exited = new Promise(resolve => child.once('exit', resolve));
    url = await new Promise((resolve, reject) => {
      let output = '', errors = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Hub startup timed out: ${errors}`)); }, 20000);
      child.stderr.on('data', data => { errors += data; });
      child.stdout.on('data', data => {
        output += data;
        const match = /listening at (http:\/\/[^\s]+)/.exec(output);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Hub exited ${code}: ${errors}`)); });
    });
  }
  await start();
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  await writeFile(configPath, JSON.stringify({ ...config, port: Number(new URL(url).port) }));
  return {
    get url() { return url; },
    async kill() { child.kill('SIGKILL'); await exited; },
    async restart() { await start(); },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      try { await exited; } finally { clearTimeout(timer); }
    },
  };
}
