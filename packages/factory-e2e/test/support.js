import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { createHub } from '../../factory-hub/src/index.js';
import { createNode, ExecutorRegistry } from '../../factory-node/src/index.js';

const run = promisify(execFile);
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

/** Start a real hub (ephemeral port, temporary SQLite and secrets) and enroll a real node daemon with `executor`. */
export async function startFactory(t, { executor, hub: hubConfig = {}, node: nodeConfig = {} }) {
  const root = await mkdtemp(join(tmpdir(), 'perpeto-e2e-'));
  await chmod(root, 0o700);
  const cleanups = [];
  t.after(async () => { for (const fn of cleanups.reverse()) await fn().catch(() => {}); await rm(root, { recursive: true, force: true }); });

  const hubPath = join(root, 'hub.json');
  await writeFile(hubPath, JSON.stringify({ port: 0, databasePath: './hub/hub.sqlite', messagingDatabasePath: './hub/messaging.sqlite',
    deliveryDatabasePath: './hub/delivery.sqlite', ownerTokenPath: './hub/owner.secret', heartbeatIntervalMs: 1000, leaseDurationMs: 15000,
    longPollMs: 2000, maintenanceIntervalMs: 50, ...hubConfig }));
  const hub = await createHub({ configPath: hubPath });
  const url = await hub.listen();
  cleanups.push(() => hub.close());
  const owner = (await readFile(join(root, 'hub/owner.secret'), 'utf8')).trim();
  const request = async (method, path, body) => {
    const response = await fetch(`${url}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${owner}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(`${method} ${path} -> ${response.status} ${data?.error?.code}: ${data?.error?.message}`), { status: response.status, body: data });
    return data;
  };

  const enrollment = await request('POST', '/machines/enrollment-codes', {});
  const nodeDir = join(root, 'node'); await mkdir(nodeDir, { mode: 0o700 });
  await writeFile(join(nodeDir, 'enrollment-code'), enrollment.code, { mode: 0o600 });
  const nodePath = join(nodeDir, 'node.json');
  await writeFile(nodePath, JSON.stringify({ hubUrl: url, name: 'e2e-machine', dataDir: './data', enrollmentCodeFile: './enrollment-code',
    labels: ['e2e'], capacity: { maxAgents: 2, maxJobs: 1 }, providers: [], fake: {}, executorPackages: [], accounts: {},
    timing: { heartbeatMs: 200, renewMs: 1000, requestMs: 5000, pollIdleMs: 20, backoffMinMs: 20, backoffMaxMs: 200 }, ...nodeConfig }));
  const node = await createNode({ configPath: nodePath, registry: new ExecutorRegistry().register(executor) });
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
  return { root, url, owner, request, hub, node, events, nodeDataDir: join(nodeDir, 'data') };
}

/** Load the default build template and point every role at the `fake` provider the e2e executor serves. */
export async function buildTemplate(edit = graph => graph) {
  const graph = JSON.parse(await readFile(new URL('../../factory-workflow/templates/build.json', import.meta.url), 'utf8'));
  for (const node of graph.nodes) if (node.config.harness) node.config.harness = { provider: 'fake', model: `fake-${node.id}` };
  return edit(graph);
}

const titleOf = prompt => /^Work item: (.*)$/m.exec(prompt)?.[1] ?? 'work';
const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Test executor for the e2e run. It never calls a model. Planners return work items; builders make real commits on a
 * branch of the bare repository; reviewers reject each item once, then pass it; the architect is supplied by the test.
 */
export function createFactoryExecutor({ repository, architect, usage = { inputTokens: 120, outputTokens: 30 } }) {
  const reviews = new Map(); const calls = [];
  return {
    kind: 'e2e-fake', calls,
    canRun: assignment => assignment.harness?.provider === 'fake',
    async run(assignment, ctx) {
      calls.push({ id: assignment.id, role: assignment.role, nodeType: assignment.nodeType, workItemId: assignment.workItemId, prompt: assignment.prompt });
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
      const branch = `perpeto/${assignment.workItemId}`; const source = join(ctx.workspace, 'source');
      await git(ctx.workspace, 'clone', '--quiet', repository, source);
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
