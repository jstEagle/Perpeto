import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as nodeFs from 'node:fs/promises';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '@perpeto/hub';
import { createNode, ExecutorRegistry } from '@perpeto/node';
import { createJanitor, defaultExec, workspaceName } from '@perpeto/janitor';
import { eventually } from './support.js';

const HOUR = 3_600_000;
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const exists = path => lstat(path).then(() => true, () => false);

/**
 * A real hub and a real node daemon whose janitor scans only temporary folders: a repository with Perpeto worktrees,
 * a foreign (T3) worktree root, a leftover assignment workspace and a leftover CI folder. Processes and simulators are
 * answered by a fake; the disk is a fake whose free space the test controls. The clock runs 100 h ahead.
 */
test('a node reports storage, the owner previews and runs a cleanup, and low disk is raised', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'perpeto-e2e-storage-')));
  await chmod(root, 0o700);
  const cleanups = [];
  t.after(async () => { for (const fn of cleanups.reverse()) await fn().catch(() => {}); await rm(root, { recursive: true, force: true }); });

  // Repository and worktrees.
  git(root, 'init', '--bare', '--quiet', join(root, 'origin.git'));
  const main = join(root, 'main');
  git(root, 'clone', '--quiet', join(root, 'origin.git'), main);
  await writeFile(join(main, 'README.md'), 'hello\n'); await writeFile(join(main, '.gitignore'), 'node_modules/\n');
  git(main, 'add', '.'); git(main, 'commit', '--quiet', '-m', 'initial'); git(main, 'push', '--quiet', 'origin', 'HEAD:main'); git(main, 'remote', 'set-head', 'origin', 'main');
  const perpetoRoot = join(root, 'runtime', 'worktrees'); const foreignRoot = join(root, 't3', 'worktrees'); const ciTemp = join(root, 'tmp');
  for (const dir of [perpetoRoot, foreignRoot, ciTemp]) await mkdir(dir, { recursive: true });
  const merged = join(perpetoRoot, 'demo', 'merged'); git(main, 'worktree', 'add', '--quiet', '-b', 'merged', merged);
  await mkdir(join(merged, 'node_modules')); await writeFile(join(merged, 'node_modules', 'big.bin'), 'b'.repeat(40_000));
  const unpushed = join(perpetoRoot, 'demo', 'unpushed'); git(main, 'worktree', 'add', '--quiet', '-b', 'unpushed', unpushed);
  await writeFile(join(unpushed, 'work.txt'), 'local'); git(unpushed, 'add', '.'); git(unpushed, 'commit', '--quiet', '-m', 'local');
  const foreign = join(foreignRoot, 'demo', 'operator'); git(main, 'worktree', 'add', '--quiet', '-b', 'operator', foreign);
  const leftoverCi = join(ciTemp, 'perpeto-ci-left'); await mkdir(join(leftoverCi, 'source'), { recursive: true });

  // Hub with a fleet policy and a per-machine override.
  const hubPath = join(root, 'hub.json');
  await writeFile(hubPath, JSON.stringify({ port: 0, databasePath: './hub/hub.sqlite', messagingDatabasePath: './hub/messaging.sqlite', deliveryDatabasePath: './hub/delivery.sqlite',
    ownerTokenPath: './hub/owner.secret', heartbeatIntervalMs: 1000, longPollMs: 500, maintenanceIntervalMs: 50,
    storage: { policy: { autoClean: false, globalCaches: false, foreignWorktreeRoots: [foreignRoot], lowFreePercent: 15, criticalFreePercent: 5 },
      machines: { 'storage-machine': { finishedWorkspaceTtlHours: 1 } } } }));
  const hub = await createHub({ configPath: hubPath });
  const url = await hub.listen();
  cleanups.push(() => hub.close());
  const owner = (await readFile(join(root, 'hub/owner.secret'), 'utf8')).trim();
  const request = async (method, path, body) => {
    const response = await fetch(`${url}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${owner}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };

  // Node: storage section on, scanning only the temporary roots.
  const enrollment = (await request('POST', '/machines/enrollment-codes', {})).body;
  const nodeDir = join(root, 'node'); await mkdir(nodeDir, { mode: 0o700 });
  await writeFile(join(nodeDir, 'enrollment-code'), enrollment.code, { mode: 0o600 });
  const dataDir = join(nodeDir, 'data');
  const leftover = join(dataDir, 'assignments', workspaceName('asg_crashed', 1, 'deadbeef'));
  await mkdir(dataDir, { mode: 0o700 }); await mkdir(join(dataDir, 'assignments'), { mode: 0o700 });
  await mkdir(leftover); await writeFile(join(leftover, 'notes.txt'), 'left behind');
  const nodePath = join(nodeDir, 'node.json');
  await writeFile(nodePath, JSON.stringify({ hubUrl: url, name: 'storage-machine', dataDir: './data', enrollmentCodeFile: './enrollment-code', capacity: { maxAgents: 1, maxJobs: 0 },
    providers: [], fake: {}, executorPackages: [], accounts: {}, timing: { heartbeatMs: 100, renewMs: 1000, requestMs: 5000, pollIdleMs: 20, backoffMinMs: 20, backoffMaxMs: 200 },
    storage: { ciTempDir: ciTemp, initialScanDelayMs: 50, perpetoWorktreeRoots: [perpetoRoot] } }));
  let freePercent = 40;
  const statfs = async () => ({ blocks: 1_000_000, bsize: 4096, bavail: Math.round(10_000 * freePercent) });
  const exec = async (command, args, options) => command === 'git' ? defaultExec(command, args, { ...options, env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
    : command === 'ps' ? { code: 0, stdout: '' } : { code: 1, stdout: '' };
  const janitor = createJanitor({ fs: { ...nodeFs, statfs }, exec, home: join(root, 'home'), clock: () => Date.now() + 100 * HOUR });
  const node = await createNode({ configPath: nodePath, registry: new ExecutorRegistry(), storage: { janitor, statfs } });
  cleanups.push(() => node.stop({ drain: false }));
  await node.start();
  const machineId = node.status.machineId;

  // The first scan reaches the hub: inventory with owners, the machine's storage state and fleet totals.
  const view = await eventually(async () => { const value = (await request('GET', `/machines/${machineId}/storage`)).body; return value.inventory ? value : null; }, { timeoutMs: 20000 });
  assert.equal(view.policy.finishedWorkspaceTtlHours, 1, 'per-machine override applies');
  assert.equal(view.policy.autoClean, false);
  const item = suffix => view.inventory.items.find(entry => entry.path.endsWith(suffix));
  assert.equal(item('/demo/merged').reclaimable, true);
  assert.equal(item('/demo/unpushed').attention, true);
  assert.equal(item('/demo/operator').kind, 't3-worktree');
  assert.equal(item('/demo/operator').reclaimable, false);
  assert.deepEqual(item(workspaceName('asg_crashed', 1, 'deadbeef')).owner, { assignmentId: 'asg_crashed' });
  assert.ok(item('/perpeto-ci-left').reclaimable);
  assert.equal(item('/perpeto-ci-left').path, '$TMPDIR/perpeto-ci-left');
  const machines = (await request('GET', '/machines')).body.machines;
  assert.equal(machines[0].storage.state, 'ok');
  assert.ok(machines[0].storage.reclaimableBytes >= 40_000);
  const fleet = (await request('GET', '/storage')).body;
  assert.equal(fleet.machines.length, 1);
  assert.ok(fleet.totals.reclaimableByKind['perpeto-worktree'] >= 40_000);
  assert.deepEqual(fleet.alerts, []);

  // Dry run: the result lists what would go, and nothing is deleted.
  const dry = await request('POST', `/machines/${machineId}/storage/cleanup`, { mode: 'dry-run', idempotencyKey: 'dry-1' });
  assert.equal(dry.status, 202);
  const preview = await eventually(async () => { const value = (await request('GET', `/machines/${machineId}/storage/cleanups/${dry.body.cleanup.id}`)).body.cleanup; return value.status === 'completed' ? value : null; }, { timeoutMs: 20000 });
  assert.ok(preview.result.dryRun);
  assert.ok(preview.result.actions.some(action => action.path.endsWith('/demo/merged') && action.status === 'would-delete'));
  assert.ok(await exists(merged));

  // Execute only the merged worktree, idempotently.
  const body = { mode: 'execute', itemIds: [item('/demo/merged').id], idempotencyKey: 'clean-1' };
  const first = await request('POST', `/machines/${machineId}/storage/cleanup`, body);
  const replay = await request('POST', `/machines/${machineId}/storage/cleanup`, body);
  assert.equal(replay.body.cleanup.id, first.body.cleanup.id);
  const done = await eventually(async () => { const value = (await request('GET', `/machines/${machineId}/storage/cleanups/${first.body.cleanup.id}`)).body.cleanup; return value.status === 'completed' ? value : null; }, { timeoutMs: 20000 });
  assert.deepEqual(done.result.actions.map(action => action.status), ['deleted']);
  assert.equal(await exists(merged), false);
  for (const path of [unpushed, foreign, leftover, leftoverCi]) assert.ok(await exists(path), path);
  assert.ok(!git(main, 'worktree', 'list', '--porcelain').includes('/demo/merged'));

  // Disk nearly full: the machine turns critical, the hub raises it and the fleet view alerts.
  freePercent = 3;
  await eventually(async () => (await request('GET', '/machines')).body.machines[0].storage?.state === 'critical', { timeoutMs: 20000 });
  const alerts = (await request('GET', '/storage')).body.alerts;
  assert.equal(alerts[0].severity, 'critical');
  const events = (await request('GET', '/events?after=0&limit=500')).body.events.map(event => event.type);
  for (const type of ['storage.scanned', 'storage.cleaned', 'storage.low']) assert.ok(events.includes(type), type);
});
