import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs/promises';
import { mkdir, writeFile, lstat, readFile, realpath, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createJanitor } from '@perpeto/janitor';
import { createNode, ExecutorRegistry, loadConfig } from '../src/index.js';
import { pruneSeen, workspaceName } from '../src/storage.js';
import { fakeHub, assignment, nodeConfig, eventually, addCleanup } from './helpers.js';

const HOUR = 3_600_000;
const exists = path => lstat(path).then(() => true, () => false);
/** Janitor over the real filesystem with a fake disk and fake process/simulator commands; git is never needed here. */
function fakes(disk) {
  const statfs = async () => ({ blocks: 1_000_000, bsize: 4096, bavail: Math.round(10_000 * disk.freePercent) });
  const exec = async command => command === 'ps' ? { code: 0, stdout: '' } : { code: 1, stdout: '' };
  return { janitor: createJanitor({ fs: { ...nodeFs, statfs }, exec, home: '/nonexistent-home', clock: () => Date.now() + 100 * HOUR }), statfs };
}
async function tempDir(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'perpeto-node-storage-')));
  addCleanup(t, () => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('storage configuration is validated; nodes without it run no janitor', async t => {
  const hub = await fakeHub(t);
  for (const [storage, message] of [[{ nope: 1 }, /Unknown storage field/], [{ ciTempDir: '' }, /ciTempDir/], [{ initialScanDelayMs: -1 }, /initialScanDelayMs/], [[], /Invalid storage/]]) {
    const { configPath } = await nodeConfig(t, hub, { storage });
    await assert.rejects(loadConfig(configPath), message);
  }
  const { configPath } = await nodeConfig(t, hub);
  const node = await createNode({ configPath });
  await node.start();
  addCleanup(t, () => node.stop({ drain: false }));
  await eventually(() => hub.heartbeats.length >= 2);
  assert.ok(hub.heartbeats.every(body => body.storage === undefined));
});

test('the node scans, auto-cleans policy-safe leftovers, reports, runs relayed cleanups once and pauses agent leases on a critical disk', async t => {
  const ciTemp = await tempDir(t);
  const reports = [];
  let directive = {};
  const hub = await fakeHub(t, {
    heartbeat: () => ({ storage: directive }),
    onRequest: ({ path, body }) => { if (path === '/api/v1/nodes/storage') reports.push(body); },
  });
  const { configPath, config } = await nodeConfig(t, hub, { capacity: { maxAgents: 1, maxJobs: 0 },
    storage: { ciTempDir: ciTemp, initialScanDelayMs: 20, autoClean: true, foreignWorktreeRoots: [], globalCaches: false } });
  // A crashed assignment's workspace and a finished CI job's folder, both idle long past retention.
  const leftover = join(config.dataDir, 'assignments', workspaceName('asg_crashed', 3, 'cafe0000'));
  await mkdir(leftover, { recursive: true, mode: 0o700 }); await writeFile(join(leftover, 'notes.txt'), 'left');
  const ci = join(ciTemp, 'perpeto-ci-old'); await mkdir(join(ci, 'source'), { recursive: true });
  const unrelated = join(ciTemp, 'not-perpeto'); await mkdir(unrelated);
  const disk = { freePercent: 50 };
  const node = await createNode({ configPath, storage: fakes(disk) });
  await node.start();
  addCleanup(t, () => node.stop({ drain: false }));

  // First heartbeat announces the janitor; the first scan auto-cleans and reports the inventory and the cleanup.
  assert.deepEqual(hub.heartbeats[0].storage, { pending: true });
  await eventually(() => reports.some(body => body.cleanups?.some(cleanup => cleanup.source === 'auto')), 5000);
  assert.equal(await exists(leftover), false);
  assert.equal(await exists(ci), false);
  assert.ok(await exists(unrelated));
  const auto = reports.flatMap(body => body.cleanups ?? []).find(cleanup => cleanup.source === 'auto');
  assert.deepEqual(auto.actions.map(action => [basename(action.path), action.status]).sort(), [[workspaceName('asg_crashed', 3, 'cafe0000'), 'deleted'], ['perpeto-ci-old', 'deleted']]);
  const journal = (await readFile(join(config.dataDir, 'storage-journal.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(journal.some(entry => entry.phase === 'done' && entry.path.endsWith(basename(leftover))));
  await eventually(() => hub.heartbeats.at(-1).storage?.scannedAt);
  assert.equal(hub.heartbeats.at(-1).storage.state, 'ok');

  // A relayed dry run reports would-delete and deletes nothing; the same id is never run twice.
  const later = join(config.dataDir, 'assignments', workspaceName('asg_later', 1, 'beef0000'));
  await mkdir(later, { recursive: true }); await writeFile(join(later, 'x'), 'x');
  directive = { cleanups: [{ id: 'scl_dry', mode: 'dry-run' }] };
  await eventually(() => reports.some(body => body.cleanups?.some(cleanup => cleanup.id === 'scl_dry')), 5000);
  const dry = reports.flatMap(body => body.cleanups ?? []).find(cleanup => cleanup.id === 'scl_dry');
  assert.equal(dry.dryRun, true);
  assert.ok(dry.actions.some(action => action.path.endsWith(workspaceName('asg_later', 1, 'beef0000')) && action.status === 'would-delete'));
  assert.ok(await exists(later));
  const before = reports.length;
  await new Promise(resolve => setTimeout(resolve, 200));
  // While the hub keeps asking, the stored result is re-sent at most once a minute; the cleanup never re-runs.
  const resent = reports.slice(before).flatMap(body => body.cleanups ?? []).filter(cleanup => cleanup.id === 'scl_dry');
  assert.ok(resent.length <= 1);
  assert.ok(resent.every(cleanup => cleanup.startedAt === dry.startedAt));
  directive = {};

  // Critical disk: the summary says so and the node stops asking for agent work.
  disk.freePercent = 2;
  await eventually(() => hub.heartbeats.at(-1).storage?.state === 'critical', 5000);
  const leases = () => hub.requests.filter(request => request.path === '/api/v1/nodes/lease').length;
  const count = leases();
  hub.assignments.push(assignment('asg_blocked'));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.ok(leases() <= count + 1, 'no lease polling while critical');
  disk.freePercent = 50;
  await eventually(() => hub.events.some(event => event.path.includes('asg_blocked')), 5000);
});

test('assignment workspaces are named after the assignment and the lease journal stays bounded', async t => {
  const hub = await fakeHub(t);
  let seen;
  const registry = new ExecutorRegistry().register({ kind: 'fake', canRun: () => true, async run(item, ctx) { seen = ctx.workspace; return { outcome: 'success', summary: 'ok' }; } });
  const { configPath } = await nodeConfig(t, hub);
  hub.assignments.push(assignment('asg_named', { attempt: 4 }));
  const node = await createNode({ configPath, registry });
  await node.start();
  addCleanup(t, () => node.stop({ drain: false }));
  await eventually(() => seen);
  assert.match(basename(seen), /^asg_named--a4--[0-9a-f]{8}$/);
  await eventually(async () => !(await exists(seen)));

  const journal = {};
  for (let i = 0; i < 2500; i++) journal[`assignment:asg_${i}`] = 1;
  pruneSeen(journal);
  const keys = Object.keys(journal);
  assert.equal(keys.length, 2000);
  assert.equal(keys[0], 'assignment:asg_500');
});
