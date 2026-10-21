import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { repoRoot, readJson, decodeJoinCode } from '../src/config.js';
import { stop as stopDaemon } from '../src/process.js';

const exec = promisify(execFile);
const bin = resolve(repoRoot, 'apps/cli/bin/perpeto.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function temporary(t) {
  const dir = await mkdtemp(resolve(tmpdir(), 'pcli-remote-'));
  t.after(async () => { for (const role of ['node', 'hub']) await stopDaemon(dir, role).catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  return dir;
}
/** Run the CLI; resolves `{ code, stdout, stderr }` instead of throwing on a failed command. */
async function cli(dir, args, env = {}) {
  try { const { stdout, stderr } = await exec(process.execPath, [bin, ...args, '--dir', dir], { timeout: 30000, env: { ...process.env, ...env } }); return { code: 0, stdout: stdout.trim(), stderr }; }
  catch (error) { if (error.code === undefined || typeof error.code === 'string') throw error; return { code: error.code, stdout: error.stdout.trim(), stderr: error.stderr }; }
}
async function ok(dir, args, env) {
  const result = await cli(dir, args, env);
  assert.equal(result.code, 0, `perpeto ${args.join(' ')}: ${result.stderr}`);
  assert.doesNotMatch(result.stderr, /Bearer|token/i);
  return result.stdout;
}
const encode = value => `pj1_${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
async function until(check, message) {
  for (let index = 0; index < 200; index++) { const value = await check(); if (value) return value; await sleep(50); }
  assert.fail(message);
}

test('a TLS hub on loopback: the join command pins its certificate, a wrong pin is refused, and a rotation re-pins nodes', { timeout: 120000 }, async t => {
  const hubDir = await temporary(t); const nodeDir = await temporary(t); const wrongDir = await temporary(t);
  assert.match((await cli(hubDir, ['hub', 'init', '--host', '0.0.0.0', '--port', '0'])).stderr, /needs HTTPS: add --tls/);
  const initialized = await ok(hubDir, ['hub', 'init', '--tls', '--port', '0']);
  const fingerprint = /Certificate fingerprint \(SHA-256\): ([a-f0-9]{64})/.exec(initialized)[1];
  const started = JSON.parse(await ok(hubDir, ['hub', 'start']));
  assert.match(started.url, /^https:\/\/127\.0\.0\.1:\d+$/);
  const enrollment = await ok(hubDir, ['hub', 'enroll-code']);
  const joinCode = /^perpeto node join (pj1_\S+)$/m.exec(enrollment)[1];
  assert.deepEqual(decodeJoinCode(joinCode), { url: started.url, fingerprint, code: decodeJoinCode(joinCode).code });

  // A join code whose fingerprint does not match the hub never sends the enrollment, so the code stays usable.
  const wrong = await cli(wrongDir, ['node', 'join', encode({ ...decodeJoinCode(joinCode), fingerprint: 'f'.repeat(64) })]);
  assert.notEqual(wrong.code, 0); assert.match(wrong.stderr, /certificate \([a-f0-9]{64}\) does not match the pinned fingerprint/);
  const joined = await ok(nodeDir, ['node', 'join', joinCode, '--name', 'pinned']);
  assert.match(joined, new RegExp(`pinned to certificate ${fingerprint}`));
  const node = await readJson(resolve(nodeDir, 'node.json'));
  assert.equal(node.hubUrl, started.url); assert.equal(node.hubFingerprint, fingerprint);
  assert.equal(JSON.parse(await ok(nodeDir, ['node', 'start'])).state, 'running');
  await until(async () => /Machines online: 1/.test(await ok(hubDir, ['status'])), 'node came online over pinned HTTPS');

  // Rotate: the next certificate is announced to the running node, then served; the node follows it.
  const pinsPath = resolve(nodeDir, 'node', 'hub-pins.json');
  const rotated = JSON.parse(await ok(hubDir, ['hub', 'tls', 'rotate']));
  assert.equal(rotated.fingerprint, fingerprint);
  await until(async () => (await readFile(pinsPath, 'utf8').catch(() => '')) === JSON.stringify([fingerprint, rotated.next]), 'node pinned the next certificate');
  const activated = JSON.parse(await ok(hubDir, ['hub', 'tls', 'activate']));
  assert.equal(activated.fingerprint, rotated.next); assert.equal(activated.previous, fingerprint);
  await until(async () => (await readFile(pinsPath, 'utf8').catch(() => '')) === JSON.stringify([rotated.next]), 'node dropped the old pin');
  assert.match(await ok(hubDir, ['status']), /Machines online: 1/, 'the owner CLI pins the new certificate too');

  // A node that missed the rotation still pins the old certificate: it cannot start until it is re-pinned.
  assert.equal(JSON.parse(await ok(nodeDir, ['node', 'stop'])).state, 'stopped');
  await writeFile(pinsPath, JSON.stringify([fingerprint]), { mode: 0o600 });
  assert.notEqual((await cli(nodeDir, ['node', 'start'])).code, 0);
  assert.match(await readFile(resolve(nodeDir, 'node.log'), 'utf8'), /not pinned/);
  assert.match(await ok(nodeDir, ['node', 'repin', rotated.next]), new RegExp(`Pinned hub certificate ${rotated.next}`));
  assert.equal(JSON.parse(await ok(nodeDir, ['node', 'start'])).state, 'running');
  await ok(nodeDir, ['node', 'stop']); await ok(hubDir, ['hub', 'stop']);
});

test('hub expose --tailscale serves a loopback hub on the tailnet, and join codes then carry that URL unpinned', { timeout: 60000 }, async t => {
  const hubDir = await temporary(t);
  const stub = resolve(hubDir, 'stub'); await mkdir(stub); const log = resolve(stub, 'calls.log');
  await writeFile(resolve(stub, 'tailscale'), `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
if [ -f ${JSON.stringify(resolve(stub, 'logged-out'))} ]; then echo "Logged out. tskey-auth-secret" >&2; exit 1; fi
case "$1" in
  status) printf '{"Self":{"DNSName":"factory.example-tailnet.ts.net.","TailscaleIPs":["100.101.102.103"]}}' ;;
  serve) ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
  const env = { PATH: `${stub}:${process.env.PATH}` };
  await ok(hubDir, ['hub', 'init', '--port', '0']);
  const port = new URL(JSON.parse(await ok(hubDir, ['hub', 'start'])).url).port;
  const exposed = await ok(hubDir, ['hub', 'expose', '--tailscale'], env);
  assert.match(exposed, /Hub on your tailnet: https:\/\/factory\.example-tailnet\.ts\.net$/m);
  assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), ['status --json', `serve --bg --https=443 http://127.0.0.1:${port}`]);
  assert.equal((await readJson(resolve(hubDir, 'hub.json'))).publicUrl, 'https://factory.example-tailnet.ts.net');
  const joinCode = /perpeto node join (pj1_\S+)/.exec(await ok(hubDir, ['hub', 'enroll-code']))[1];
  const decoded = decodeJoinCode(joinCode);
  assert.equal(decoded.url, 'https://factory.example-tailnet.ts.net'); assert.equal(decoded.fingerprint, undefined, 'tailscale presents a CA certificate');
  await ok(hubDir, ['hub', 'expose', '--tailscale', '--off'], env);
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').at(-1), 'serve --https=443 off');
  assert.equal(Object.hasOwn(await readJson(resolve(hubDir, 'hub.json')), 'publicUrl'), false);
  // Tailscale's own errors are classified, never echoed: they can carry auth keys.
  await writeFile(resolve(stub, 'logged-out'), '');
  const failed = await cli(hubDir, ['hub', 'expose', '--tailscale'], env);
  assert.notEqual(failed.code, 0); assert.match(failed.stderr, /not logged in/); assert.doesNotMatch(failed.stderr + failed.stdout, /tskey/);
  await ok(hubDir, ['hub', 'stop']);
});
