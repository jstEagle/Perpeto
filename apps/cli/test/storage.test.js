import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHub } from '@perpeto/hub';
import { main } from '../src/cli.js';
import { parseArgs } from '../src/args.js';
import { hubConfig, nodeConfig, readSecret } from '../src/config.js';
import { request } from '../src/api.js';
import { bytes } from '../src/storage.js';

const GB = 1024 ** 3;
const ITEM = `sti_${'a'.repeat(20)}`;

test('storage command grammar', () => {
  for (const words of [['storage'], ['storage', '--machine', 'mch_1'], ['storage', 'clean'], ['storage', 'clean', '--dry-run', '--machine', 'mch_1', '--items', `${ITEM},${ITEM}`]]) assert.equal(parseArgs(words).help, undefined);
  for (const words of [['storage', 'clean', 'extra'], ['storage', '--dry-run'], ['storage', 'clean', '--items', '../x'], ['storage', '--machine', '../x'], ['storage', 'purge']]) assert.throws(() => parseArgs(words));
  assert.equal(bytes(31.2 * GB), '31.2 GB');
  assert.equal(bytes(512), '512 B');
  // Joined nodes run the janitor with the hub's policy by default.
  assert.deepEqual(nodeConfig('/tmp/x', 'http://127.0.0.1:4320').storage, {});
});

test('perpeto storage shows the fleet and a machine; storage clean waits for the machine result', async t => {
  const dir = await mkdtemp(resolve(tmpdir(), 'pcli-storage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = { ...hubConfig(dir, { port: 0 }), longPollMs: 0 };
  await writeFile(resolve(dir, 'hub.json'), JSON.stringify(config));
  const hub = await createHub({ configPath: resolve(dir, 'hub.json') });
  t.after(() => hub.close());
  const url = await hub.listen();
  config.port = Number(new URL(url).port);
  await writeFile(resolve(dir, 'hub.json'), JSON.stringify(config));
  const token = (await readSecret(resolve(dir, 'hub/owner.secret'))).trim();
  const code = (await request(url, '/machines/enrollment-codes', { token, body: {} })).code;
  const machine = await request(url, '/nodes/enroll', { body: { code, name: 'Mac mini', os: 'darwin', arch: 'arm64', providers: [], labels: [], version: 'test' } });
  const node = (path, body) => request(url, path, { token: machine.token, body });
  const summary = { scannedAt: '2026-10-23T08:00:00.000Z', state: 'critical', disk: { totalBytes: 1000 * GB, freeBytes: 40 * GB }, truncated: false, reclaimableBytes: 29 * GB,
    reclaimableByKind: { 't3-worktree': 29 * GB }, advisoryBytes: 55 * GB, attentionCount: 1, staleProcesses: 1, items: 2, top: [] };
  const heartbeat = () => node('/nodes/heartbeat', { status: 'online', capacity: { maxAgents: 1, maxJobs: 0 }, running: { agents: 0, jobs: 0 }, providers: [], storage: summary });
  await heartbeat();
  await node('/nodes/storage', { inventory: { scannedAt: summary.scannedAt, state: 'critical', items: [
    { id: ITEM, kind: 't3-worktree', path: '~/.t3/worktrees/perpeto/old', bytes: 29 * GB, owner: {}, gitState: { branch: 'old', dirty: false, unpushedCommits: 0, merged: true }, reclaimable: true, action: 'delete', reason: 'Merged, clean and idle 300 h.' },
    { id: `sti_${'b'.repeat(20)}`, kind: 'perpeto-worktree', path: '~/.perpeto/runtime/worktrees/p/wip', bytes: GB, owner: {}, reclaimable: false, attention: true, reason: 'Has 2 unpushed commits; review before deleting.' },
    { id: `sti_${'c'.repeat(20)}`, kind: 'global-cache', path: '~/Library/Developer/CoreSimulator/Devices', name: '12 unavailable simulators', bytes: 55 * GB, owner: {}, reclaimable: false, advisory: true, hint: 'xcrun simctl delete unavailable', reason: 'Old runtimes.' },
  ], processes: [{ kind: 'dev-server', name: 'vite', pid: 4242, reason: 'Its working directory no longer exists; it is likely orphaned.', hint: 'kill 4242' }] } });

  let output = [];
  const run = async (...words) => { output = []; assert.equal(await main([...words, '--dir', dir], { print: line => output.push(line) }), 0); return output.join('\n'); };
  const fleet = await run('storage');
  assert.match(fleet, /Mac mini \(mch_[a-z0-9]+\): critical, 4\.0% free \(40\.0 GB of 1000 GB\), 29\.0 GB reclaimable, 1 need attention/);
  assert.match(fleet, /CRITICAL Mac mini: 4% free; new agent work is paused/);
  assert.match(fleet, /Reclaimable across the fleet: 29\.0 GB \(T3 worktrees 29\.0 GB\)/);
  const detail = await run('storage', '--machine', machine.machineId);
  assert.match(detail, /Needs attention\n {2}sti_b+ +1\.0 GB {2}~\/\.perpeto\/runtime\/worktrees\/p\/wip/);
  assert.match(detail, /Reclaimable\n {2}sti_a+ +29\.0 GB {2}~\/\.t3\/worktrees\/perpeto\/old \[old\]/);
  assert.match(detail, /12 unavailable simulators: xcrun simctl delete unavailable/);
  assert.match(detail, /vite \(pid 4242\).*Run: kill 4242/);
  assert.ok(!detail.includes(token) && !detail.includes(machine.token));

  // A stand-in node answers the relayed cleanup on its next heartbeat.
  let stop = false;
  const responder = (async () => {
    while (!stop) {
      const directive = (await heartbeat()).storage;
      for (const cleanup of directive?.cleanups ?? []) {
        await node('/nodes/storage', { cleanups: [{ id: cleanup.id, mode: cleanup.mode, dryRun: cleanup.mode === 'dry-run', freedBytes: 29 * GB,
          actions: [{ itemId: ITEM, kind: 't3-worktree', path: '~/.t3/worktrees/perpeto/old', action: 'delete', bytes: 29 * GB, status: cleanup.mode === 'dry-run' ? 'would-delete' : 'deleted' }] }] });
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  })();
  t.after(async () => { stop = true; await responder; });
  output = [];
  assert.equal(await main(['storage', 'clean', '--dry-run', '--machine', machine.machineId, '--items', ITEM, '--dir', dir], { print: line => output.push(line) }), 0);
  assert.match(output.join('\n'), /would free 29\.0 GB \(1 item\)\n {2}would-delete +29\.0 GB {2}~\/\.t3\/worktrees\/perpeto\/old/);
  const view = await request(url, `/machines/${machine.machineId}/storage`, { token });
  assert.deepEqual(view.cleanups.map(cleanup => [cleanup.mode, cleanup.status, cleanup.itemIds]), [['dry-run', 'completed', [ITEM]]]);
  stop = true; await responder;
});
