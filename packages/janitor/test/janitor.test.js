import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, utimes, lstat, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createJanitor, mergePolicy, summarize, workspaceName, planCleanup } from '../src/index.js';
import { temp, file, git, repository, fakeExec, fakeDisk } from './helpers.js';

const HOUR = 3_600_000;
const exists = path => lstat(path).then(() => true, () => false);

/**
 * One machine in a temp dir: node data with assignment workspaces, Perpeto's managed worktrees, a "foreign" T3 worktree
 * root and CI temp folders. The clock runs 100 h ahead, so everything is idle unless touched in the future.
 */
async function machine(t, policyOverrides = {}) {
  const dir = await temp(t);
  const { main } = await repository(dir);
  const roots = { dataDir: join(dir, 'node'), assignments: join(dir, 'node', 'assignments'), ciTemp: join(dir, 'tmp'),
    perpetoWorktrees: [join(dir, 'runtime', 'worktrees')], foreignWorktrees: [join(dir, 't3', 'worktrees')], diskPath: dir };
  for (const path of [roots.assignments, roots.ciTemp, ...roots.perpetoWorktrees, ...roots.foreignWorktrees]) await mkdir(path, { recursive: true });
  const worktree = (root, name, branch = name) => { const path = join(root, 'demo', name); git(main, 'worktree', 'add', '--quiet', '-b', branch, path); return path; };

  // Perpeto worktrees: merged and clean; with an unpushed commit (and ignored node_modules); one an active work item uses.
  const merged = worktree(roots.perpetoWorktrees[0], 'merged');
  await file(join(merged, 'node_modules', 'pkg', 'index.js'), 'x'.repeat(5000));
  const unpushed = worktree(roots.perpetoWorktrees[0], 'unpushed');
  await file(join(unpushed, 'feature.txt'), 'work'); git(unpushed, 'add', '.'); git(unpushed, 'commit', '--quiet', '-m', 'local work');
  await file(join(unpushed, 'node_modules', 'big', 'blob.bin'), 'y'.repeat(20000));
  await file(join(unpushed, 'dist', 'out.js'), 'z');
  const active = worktree(roots.perpetoWorktrees[0], 'active', 'wi-active');
  await file(join(active, 'node_modules', 'a.js'), 'a');
  // A foreign (operator's T3) worktree that is merged and clean.
  const foreign = worktree(roots.foreignWorktrees[0], 'foreign');
  await file(join(foreign, 'node_modules', 'f.js'), 'f'.repeat(3000));

  // Assignment workspaces: a leftover, one with an uncommitted change in its clone, and a running one.
  const leftover = join(roots.assignments, workspaceName('asg_old', 1, 'abcd1234'));
  await file(join(leftover, 'notes.txt'), 'old');
  const dirty = join(roots.assignments, workspaceName('asg_dirty', 2, 'abcd5678'));
  git(dir, 'clone', '--quiet', join(dir, 'origin.git'), join(dirty, 'repo'));
  await file(join(dirty, 'repo', 'README.md'), 'changed\n');
  const running = join(roots.assignments, workspaceName('asg_running', 0, 'ffff0000'));
  await file(join(running, 'x.txt'));

  roots.ciCache = join(dir, 'ci-cache');
  await file(join(roots.ciCache, 'npm-abc', 'pkg.tgz'), 'c'.repeat(2000));
  const ci = join(roots.ciTemp, 'perpeto-ci-abc123');
  await file(join(ci, 'source', 'file.txt'));
  await file(join(roots.ciTemp, 'someone-else', 'keep.txt'));

  const now = Date.now() + 100 * HOUR;
  const exec = fakeExec((command) => command === 'ps' ? { code: 0, stdout: '' } : { code: 1, stdout: '' });
  const janitor = createJanitor({ fs: fakeDisk(), exec, home: join(dir, 'home'), platform: 'linux', clock: () => now });
  const low = () => createJanitor({ fs: fakeDisk(10), exec, home: join(dir, 'home'), platform: 'linux', clock: () => now });
  const policy = mergePolicy({ foreignWorktreeRoots: [], globalCaches: false, foreignWorktreeIdleHours: 24 }, policyOverrides);
  const activeWork = { workspaces: [{ path: running, assignmentId: 'asg_running', runId: 'run_1' }], branches: [{ branch: 'wi-active', runId: 'run_1', workItemId: 'wi_1' }] };
  return { dir, main, roots, janitor, low, policy, activeWork, paths: { merged, unpushed, active, foreign, leftover, dirty, running, ci }, now };
}

const byPath = (report, suffix) => report.items.find(item => item.path.endsWith(suffix));

test('inventory classifies Perpeto, foreign and CI storage under the retention policy', async t => {
  const m = await machine(t);
  const { report, locations } = await m.janitor.scan({ roots: m.roots, policy: m.policy, active: m.activeWork });
  assert.equal(report.state, 'ok');
  assert.ok(report.disk.totalBytes > 0);

  const merged = byPath(report, '/runtime/worktrees/demo/merged');
  assert.equal(merged.kind, 'perpeto-worktree');
  assert.equal(merged.reclaimable, true);
  assert.equal(merged.action, 'delete');
  assert.deepEqual(merged.gitState, { branch: 'merged', dirty: false, unpushedCommits: 0, merged: true });
  assert.ok(merged.bytes >= 5000);
  // Artifacts inside a folder that will be deleted are not listed separately.
  assert.ok(!report.items.some(item => item.parentId === merged.id));

  const unpushed = byPath(report, '/demo/unpushed');
  assert.equal(unpushed.reclaimable, false);
  assert.equal(unpushed.attention, true);
  assert.match(unpushed.reason, /1 unpushed commit/);
  const strips = report.items.filter(item => item.parentId === unpushed.id);
  assert.deepEqual(strips.map(item => item.name).sort(), ['dist', 'node_modules']);
  assert.ok(strips.every(item => item.reclaimable && item.action === 'strip' && item.kind === 'build-artifact'));

  const active = byPath(report, '/demo/active');
  assert.equal(active.reclaimable, false);
  assert.deepEqual(active.owner, { runId: 'run_1', workItemId: 'wi_1' });
  assert.ok(report.items.filter(item => item.parentId === active.id).every(item => !item.reclaimable));

  const foreign = byPath(report, '/t3/worktrees/demo/foreign');
  assert.equal(foreign.kind, 't3-worktree');
  assert.equal(foreign.reclaimable, false);
  assert.match(foreign.reason, /cleanupForeignWorktrees is off/);
  assert.ok(report.items.filter(item => item.parentId === foreign.id).every(item => !item.reclaimable));

  const leftover = byPath(report, '/asg_old--a1--abcd1234');
  assert.equal(leftover.kind, 'perpeto-workspace');
  assert.deepEqual(leftover.owner, { assignmentId: 'asg_old' });
  assert.equal(leftover.reclaimable, true);
  const dirty = byPath(report, '/asg_dirty--a2--abcd5678');
  assert.equal(dirty.attention, true);
  assert.equal(dirty.gitState.dirty, true);
  const running = byPath(report, '/asg_running--a0--ffff0000');
  assert.equal(running.reclaimable, false);
  assert.deepEqual(running.owner, { assignmentId: 'asg_running', runId: 'run_1' });

  const ci = report.items.find(item => item.kind === 'ci-workspace');
  assert.equal(ci.path, '$TMPDIR/perpeto-ci-abc123');
  assert.equal(ci.reclaimable, true);
  assert.ok(!report.items.some(item => item.path.includes('someone-else')));
  const cache = report.items.find(entry => entry.kind === 'ci-cache');
  assert.equal(cache.name, 'npm-abc');
  assert.equal(cache.reclaimable, true);

  // Real paths stay on the machine; the report only has display paths and ids.
  assert.equal(locations.get(merged.id).path, m.paths.merged);
  const summary = summarize(report);
  assert.equal(summary.attentionCount, 2);
  assert.ok(summary.reclaimableByKind['perpeto-worktree'] >= 5000);
  assert.ok(summary.reclaimableByKind['build-artifact'] >= 20000);
  assert.equal(summary.reclaimableBytes, Object.values(summary.reclaimableByKind).reduce((a, b) => a + b, 0));
  assert.ok(summary.top.length <= 5);
});

test('foreign worktrees are cleaned only when opted in, merged, clean and idle', async t => {
  const m = await machine(t, { cleanupForeignWorktrees: true, stripForeignArtifacts: true });
  let { report } = await m.janitor.scan({ roots: m.roots, policy: m.policy, active: m.activeWork });
  assert.equal(byPath(report, '/t3/worktrees/demo/foreign').reclaimable, true);
  // A change makes it unsafe; its ignored artifacts may still be stripped once opted in.
  await writeFile(join(m.paths.foreign, 'README.md'), 'edited\n');
  ({ report } = await m.janitor.scan({ roots: m.roots, policy: m.policy, active: m.activeWork }));
  const foreign = byPath(report, '/t3/worktrees/demo/foreign');
  assert.equal(foreign.reclaimable, false);
  assert.equal(foreign.attention, undefined);
  assert.equal(report.items.find(item => item.parentId === foreign.id).reclaimable, true);
});

test('recent activity keeps workspaces until the retention period passes; low disk shortens it', async t => {
  const m = await machine(t, { finishedWorkspaceTtlHours: 24 });
  const recent = new Date(m.now - 3 * HOUR);
  await utimes(join(m.paths.leftover, 'notes.txt'), recent, recent);
  let { report } = await m.janitor.scan({ roots: m.roots, policy: m.policy, active: m.activeWork });
  assert.equal(byPath(report, '/asg_old--a1--abcd1234').reclaimable, false);
  assert.match(byPath(report, '/asg_old--a1--abcd1234').reason, /kept 24 h/);
  // The disk is 10% free: aggressive retention (2 h) applies.
  ({ report } = await m.low().scan({ roots: m.roots, policy: m.policy, active: m.activeWork }));
  assert.equal(report.state, 'low');
  assert.equal(report.aggressive, true);
  assert.equal(byPath(report, '/asg_old--a1--abcd1234').reclaimable, true);
});

test('dry run deletes nothing; execute deletes, journals and prunes worktree metadata', async t => {
  const m = await machine(t);
  const { report, locations } = await m.janitor.scan({ roots: m.roots, policy: m.policy, active: m.activeWork });
  const allowedRoots = [m.roots.assignments, m.roots.ciTemp, ...m.roots.perpetoWorktrees, ...m.roots.foreignWorktrees];
  const plan = planCleanup(report);
  const dry = await m.janitor.execute({ plan, locations, allowedRoots, policy: m.policy, dryRun: true, cleanupId: 'dry' });
  assert.ok(dry.actions.some(action => action.status === 'would-delete'));
  assert.ok(dry.freedBytes > 0);
  for (const path of Object.values(m.paths)) assert.ok(await exists(path), path);

  const journal = m.janitor.journal(join(m.roots.dataDir, 'storage-journal.jsonl'));
  const result = await m.janitor.execute({ plan, locations, allowedRoots, policy: m.policy, journal, cleanupId: 'real', isActive: path => path === m.paths.running });
  const statuses = Object.fromEntries(result.actions.map(action => [action.path.split('/').slice(-2).join('/'), action.status]));
  assert.equal(statuses['demo/merged'], 'deleted');
  assert.equal(statuses['unpushed/node_modules'], 'stripped');
  assert.equal(statuses['unpushed/dist'], 'stripped');
  assert.equal(await exists(m.paths.merged), false);
  assert.equal(await exists(m.paths.leftover), false);
  assert.equal(await exists(m.paths.ci), false);
  // Kept: work that exists nowhere else, running work, active work items, foreign worktrees, other temp folders.
  for (const path of [m.paths.unpushed, join(m.paths.unpushed, 'feature.txt'), m.paths.dirty, m.paths.running, m.paths.active, m.paths.foreign, join(m.roots.ciTemp, 'someone-else')]) assert.ok(await exists(path), path);
  assert.equal(await exists(join(m.paths.unpushed, 'node_modules')), false);
  // The deleted linked worktree is pruned from its repository.
  assert.ok(!git(m.main, 'worktree', 'list', '--porcelain').includes('/demo/merged'));
  const lines = (await readFile(join(m.roots.dataDir, 'storage-journal.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(lines.some(line => line.phase === 'intent' && line.path === m.paths.merged));
  assert.ok(lines.some(line => line.phase === 'done' && line.path === m.paths.merged));
  // Replaying the same cleanup is harmless: everything is already gone.
  const again = await m.janitor.execute({ plan, locations, allowedRoots, policy: m.policy, journal, cleanupId: 'real' });
  assert.ok(again.actions.filter(action => action.itemId === byPath(report, '/demo/merged').id).every(action => action.status === 'skipped'));
});

test('execution re-checks safety: symlink swaps, new changes and roots outside the allowed set are refused', async t => {
  const m = await machine(t);
  const outside = join(m.dir, 'precious');
  await file(join(outside, 'keep.txt'), 'keep');
  const { report, locations } = await m.janitor.scan({ roots: m.roots, policy: m.policy, active: m.activeWork });
  const plan = planCleanup(report);
  // After the scan: the leftover workspace becomes a symlink to precious data, and the merged worktree gets an edit.
  await (await import('node:fs/promises')).rm(m.paths.leftover, { recursive: true });
  await symlink(outside, m.paths.leftover);
  await writeFile(join(m.paths.merged, 'README.md'), 'late edit\n');
  const result = await m.janitor.execute({ plan, locations, allowedRoots: [m.roots.assignments, ...m.roots.perpetoWorktrees], policy: m.policy, cleanupId: 'safety' });
  const status = suffix => result.actions.find(action => action.path.endsWith(suffix))?.status;
  assert.equal(status('/asg_old--a1--abcd1234'), 'skipped');
  assert.equal(status('/demo/merged'), 'needs-attention');
  // CI temp is not an allowed root in this call.
  assert.equal(status('/perpeto-ci-abc123'), 'skipped');
  assert.ok(await exists(join(outside, 'keep.txt')));
  assert.ok(await exists(m.paths.merged));
  assert.ok(await exists(m.paths.ci));
  // Requests by id for items that are not reclaimable are skipped with their reason.
  const unpushed = byPath(report, '/demo/unpushed');
  const explicit = planCleanup(report, { itemIds: [unpushed.id, 'sti_unknown'] });
  assert.equal(explicit.actions.length, 0);
  assert.match(explicit.skipped[0].reason, /unpushed/);
  assert.match(explicit.skipped[1].reason, /latest inventory/);
});

test('sizing never follows symlinks and stops at its budget', async t => {
  const dir = await temp(t);
  const big = join(dir, 'big');
  for (let i = 0; i < 50; i++) await file(join(big, `f${i}.bin`), 'b'.repeat(1000));
  const scanned = join(dir, 'assignments', workspaceName('asg_link', 1, 'aaaa1111'));
  await mkdir(scanned, { recursive: true });
  await symlink(big, join(scanned, 'link'));
  const exec = fakeExec(() => ({ code: 0, stdout: '' }));
  const janitor = createJanitor({ fs: fakeDisk(), exec, home: join(dir, 'home'), platform: 'linux', clock: () => Date.now() + 100 * HOUR });
  const roots = { assignments: join(dir, 'assignments'), diskPath: dir };
  const { report } = await janitor.scan({ roots, policy: mergePolicy({ globalCaches: false, foreignWorktreeRoots: [] }) });
  assert.ok(report.items[0].bytes < 20000, 'symlink target is not counted');
  const bounded = createJanitor({ fs: fakeDisk(), exec, home: join(dir, 'home'), platform: 'linux' });
  const { report: partial } = await bounded.scan({ roots: { assignments: dir, diskPath: dir }, policy: mergePolicy({ globalCaches: false, foreignWorktreeRoots: [], maxEntries: 1000 }) });
  assert.equal(partial.truncated, false);
  const tiny = await createJanitor({ fs: fakeDisk(), exec, home: join(dir, 'home'), platform: 'linux' }).scan({ roots: { assignments: dir, diskPath: dir },
    policy: { ...mergePolicy({ globalCaches: false, foreignWorktreeRoots: [] }), maxEntries: 5 } });
  assert.equal(tiny.report.truncated, true);
  assert.ok(tiny.report.items.some(item => item.approximate));
  assert.ok((await readdir(big)).length === 50);
});

test('stale dev servers and booted simulators are reported, never signalled', async t => {
  const dir = await temp(t);
  const live = join(dir, 'worktrees', 'demo', 'live');
  await mkdir(live, { recursive: true });
  const exec = fakeExec((command, args) => {
    if (command === 'ps') return { code: 0, stdout: [
      '  101 3-02:00:00 node /x/node_modules/.bin/vite --port 5173',
      '  102 00:10 node /y/node_modules/vite/bin/vite.js',
      '  103 1-00:00:00 /usr/bin/ssh-agent',
      '  104 05:00 node node_modules/esbuild/bin/esbuild --service=0.25',
    ].join('\n') };
    if (command === 'lsof') return { code: 0, stdout: `p101\nfcwd\nn${join(dir, 'gone')}\np102\nfcwd\nn${live}\np104\nfcwd\nn${live}\n` };
    if (command === 'xcrun') return { code: 0, stdout: JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [{ name: 'iPhone 17', udid: 'UDID-1', state: 'Booted' }] } }) };
    return { code: 1, stdout: '' };
  });
  const janitor = createJanitor({ fs: fakeDisk(), exec, home: dir, platform: 'darwin' });
  const policy = mergePolicy({ globalCaches: false, foreignWorktreeRoots: [], staleProcessHours: 24 });
  const { report } = await janitor.scan({ roots: { perpetoWorktrees: [join(dir, 'worktrees')], diskPath: dir }, policy });
  assert.deepEqual(report.processes.map(item => [item.kind, item.pid ?? item.udid]), [['dev-server', 101], ['simulator', 'UDID-1']]);
  assert.equal(report.processes[0].cwdMissing, true);
  assert.equal(report.processes[0].cwd, '~/gone');
  assert.ok(!exec.calls.some(call => call[0] === 'kill'));
  // A worktree a dev server still runs in is never reclaimable.
  const item = report.items.find(entry => entry.path.endsWith('/demo/live'));
  assert.equal(item.reclaimable, false);
});

test('policy layers validate and merge; disk state follows the thresholds', () => {
  const merged = mergePolicy({ finishedWorkspaceTtlHours: 12, aggressive: { idleArtifactTtlHours: 6 } }, { finishedWorkspaceTtlHours: 6 });
  assert.equal(merged.finishedWorkspaceTtlHours, 6);
  assert.deepEqual(merged.aggressive, { finishedWorkspaceTtlHours: 2, idleArtifactTtlHours: 6 });
  assert.equal(merged.cleanupForeignWorktrees, false);
  assert.throws(() => mergePolicy({ nope: 1 }), /Unknown storage policy field/);
  assert.throws(() => mergePolicy({ artifactNames: ['../etc'] }), /folder names/);
  assert.throws(() => mergePolicy({ foreignWorktreeRoots: ['relative/path'] }), /absolute/);
  assert.throws(() => mergePolicy({ lowFreePercent: 5, criticalFreePercent: 10 }), /cannot exceed/);
});
