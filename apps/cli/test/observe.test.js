import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { repoRoot, readJson } from '../src/config.js';
import { stop as stopDaemon } from '../src/process.js';
import { parseArgs } from '../src/args.js';
import { startFakeT3, build } from '../../../packages/t3-executor/test/fake-t3.js';

const exec = promisify(execFile);
const bin = resolve(repoRoot, 'apps/cli/bin/perpeto.js');
const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
async function temporary(t, prefix = 'pcli-observe-') {
  const dir = await mkdtemp(resolve(tmpdir(), prefix));
  t.after(async () => { for (const role of ['node', 'hub']) await stopDaemon(dir, role).catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  return dir;
}
async function ok(dir, args) {
  const { stdout, stderr } = await exec(process.execPath, [bin, ...args, '--dir', dir], { timeout: 30000 });
  assert.doesNotMatch(stderr, /Bearer|test-token/i);
  return stdout.trim();
}

test('observe-only setup: TLS hub, pinned join with --observe, the node watches T3 read-only and the hub reports it', { timeout: 120000 }, async t => {
  const fake = await startFakeT3();
  t.after(() => fake.close());
  fake.state.shell.threads.set('t1', build.shellThread('t1', { status: 'running', activeRunId: 'r1', createdAt: new Date().toISOString() }));
  const t3 = await temporary(t, 'pcli-t3-');
  await mkdir(resolve(t3, 'userdata')); await mkdir(resolve(t3, 'bin'));
  await writeFile(resolve(t3, 'userdata/server-runtime.json'), JSON.stringify({ origin: fake.url, serverVersion: 'cli-test' }));
  await writeFile(resolve(t3, 'bin/t3'), '#!/bin/sh\necho test-token\n'); await chmod(resolve(t3, 'bin/t3'), 0o700);

  const dir = await temporary(t);
  await ok(dir, ['hub', 'init', '--tls', '--port', '0']);
  await ok(dir, ['hub', 'start']);
  const joinCode = /^perpeto node join (pj1_\S+)$/m.exec(await ok(dir, ['hub', 'enroll-code']))[1];
  assert.match(await ok(dir, ['node', 'join', joinCode, '--observe', '--t3-dir', resolve(t3, 'userdata'), '--name', 'studio']), /pinned to certificate [a-f0-9]{64} \(observe-only\)/);
  const config = await readJson(resolve(dir, 'node.json'));
  assert.deepEqual([config.capacity, config.executorPackages, config.runtime.enabled, config.observe],
    [{ maxAgents: 0, maxJobs: 0 }, [], false, { enabled: true, t3BaseDir: resolve(t3, 'userdata'), pollMs: 5000, includeTitles: true }]);
  assert.match(await ok(dir, ['doctor']).catch(error => error.stdout), /OK T3 Code: Running at http:\/\/127\.0\.0\.1:\d+ \(cli-test\)[\s\S]*OK T3 CLI/);

  assert.equal(JSON.parse(await ok(dir, ['node', 'start'])).state, 'running');
  let summary = '';
  for (let index = 0; index < 200 && !/studio: observing; 1 running/.test(summary); index++) { await sleep(100); summary = await ok(dir, ['sessions']); }
  assert.match(summary, /studio: observing; 1 running, 0 waiting/);
  const status = JSON.parse(await ok(dir, ['node', 'status']));
  assert.equal(status.observe.connected, true);
  assert.equal((await stat(resolve(dir, 'node/t3-observer-session.json'))).mode & 0o777, 0o600);
  assert.ok(fake.state.rpcs.every(tag => ['server.getConfig', 'orchestration.subscribeShell', 'orchestration.subscribeThread'].includes(tag)));
  assert.equal(fake.state.commands.length, 0);

  // User LaunchAgents for both, logging into the data directory.
  const plists = await ok(dir, ['service', 'install', '--dry-run']);
  assert.match(plists, /com\.perpeto\.hub\.plist[\s\S]*<string>hub<\/string><string>run<\/string>/);
  assert.match(plists, /com\.perpeto\.node\.plist[\s\S]*<string>node<\/string><string>run<\/string>/);
  assert.ok(plists.includes(`<key>StandardOutPath</key><string>${resolve(dir, 'node.log')}</string>`));
});

test('--t3-dir and --no-titles only go with --observe', () => {
  assert.throws(() => parseArgs(['node', 'join', 'pj1_x', '--no-titles']), /need --observe/);
  assert.equal(parseArgs(['node', 'join', 'pj1_x', '--observe', '--no-titles']).flags['no-titles'], true);
  assert.equal(parseArgs(['sessions']).group, 'sessions');
});
