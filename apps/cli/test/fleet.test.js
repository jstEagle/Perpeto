import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createNet } from 'node:net';
import { createServer } from 'node:https';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHub } from '@perpeto/hub';
import { generateCertificate } from '@perpeto/hub/tls';
import { parseArgs } from '../src/args.js';
import { main } from '../src/cli.js';
import { hubConfig, decodeJoinCode } from '../src/config.js';
import { findMachine, formatMachines, setBody } from '../src/fleet.js';
import { candidateUrls, inviteLines } from '../src/invite.js';
import { probeHub } from '../src/reach.js';
import { join as joinHub } from '../src/api.js';

async function temporary(t, prefix = 'pcli-fleet-') {
  const dir = await mkdtemp(resolve(tmpdir(), prefix)); t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}

test('machines grammar: names or ids, set flags and json listing', () => {
  for (const words of [['machines'], ['machines', '--json'], ['machines', 'cordon', 'justus-mbp.local'], ['machines', 'uncordon', 'mch_x'], ['machines', 'drain', 'studio-mini'],
    ['machines', 'set', 'mini', '--max-agents', '2', '--labels', 'gpu,mac'], ['hub', 'invite', '--ttl', '30m']]) assert.equal(parseArgs(words).help, undefined, words.join(' '));
  for (const words of [['machines', 'cordon'], ['machines', 'cordon', '../x'], ['machines', 'cordon', 'a', 'b'], ['machines', 'drain', 'x', '--json'], ['machines', 'list'], ['hub', 'invite', 'extra']]) assert.throws(() => parseArgs(words), words.join(' '));
  assert.deepEqual(setBody({ 'max-agents': '2', 'max-jobs': 'default', labels: 'gpu, mac', weight: '1.5', battery: 'allow' }), { maxAgents: 2, maxJobs: null, labels: ['gpu', 'mac'], weight: 1.5, allowOnBattery: true });
  for (const flags of [{}, { 'max-agents': '-1' }, { weight: '11' }, { battery: 'maybe' }]) assert.throws(() => setBody(flags));
  const machines = [{ id: 'mch_1', name: 'mini' }, { id: 'mch_2', name: 'twin' }, { id: 'mch_3', name: 'twin' }];
  assert.equal(findMachine(machines, 'mini').id, 'mch_1'); assert.equal(findMachine(machines, 'mch_3').id, 'mch_3');
  assert.throws(() => findMachine(machines, 'twin'), /mch_2, mch_3/); assert.throws(() => findMachine(machines, 'nope'), /No machine/);
});

test('the machine list says what each machine takes and why not', () => {
  const lines = formatMachines([
    { name: 'studio-mini', status: 'online', capacity: { maxAgents: 4, maxJobs: 1 }, running: { agents: 0, jobs: 0 }, health: { memory: { freeBytes: 2 * 1024 ** 3 } },
      placement: { status: 'overloaded', configured: { agents: 4, jobs: 1 }, effective: { agents: 0, jobs: 0 }, held: { agents: 0, jobs: 0 }, loadPerCore: 13,
        reasons: [{ code: 'overloaded', message: 'Load 13.0 per core (limit 1.5)', effect: 'blocks' }, { code: 'no-telemetry', message: 'x', effect: 'info' }] } },
    { name: 'mbp', status: 'online', capacity: { maxAgents: 2, maxJobs: 0 }, running: { agents: 1, jobs: 0 } },
  ]);
  assert.deepEqual(lines, ['studio-mini  overloaded  agents 0/0 (of 4), jobs 0/0, load 13/core, mem 2 GB free', '             Load 13.0 per core (limit 1.5)', 'mbp          online      agents 1/2, jobs 0/0']);
});

test('invite candidates: tailnet first, then LAN; loopback and plain HTTP hubs explain what to change', () => {
  const interfaces = { lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }], en0: [{ family: 'IPv4', internal: false, address: '192.168.0.123' }, { family: 'IPv6', internal: false, address: 'fe80::1' }],
    utun4: [{ family: 'IPv4', internal: false, address: '100.101.102.103' }] };
  const base = { tlsEnabled: true, host: '0.0.0.0', publicUrl: null };
  assert.deepEqual(candidateUrls({ config: base, port: 4340, interfaces, tailnet: { name: 'mini.tail1.ts.net', ips: ['100.101.102.103'] } }).urls.map(item => [item.url, item.via]),
    [['https://mini.tail1.ts.net:4340', 'Tailscale name'], ['https://100.101.102.103:4340', 'Tailscale'], ['https://192.168.0.123:4340', 'LAN (en0)']]);
  assert.deepEqual(candidateUrls({ config: base, port: 4340, interfaces, tailnet: null }).urls.map(item => item.url), ['https://100.101.102.103:4340', 'https://192.168.0.123:4340']);
  assert.deepEqual(candidateUrls({ config: { ...base, publicUrl: 'https://mini.tail1.ts.net' }, port: 4340, interfaces }), { urls: [{ url: 'https://mini.tail1.ts.net', via: 'Tailscale serve' }], pin: false });
  assert.match(candidateUrls({ config: { ...base, host: '127.0.0.1' }, port: 4340, interfaces }).problem, /only listens on 127\.0\.0\.1/);
  assert.match(candidateUrls({ config: { ...base, tlsEnabled: false, host: '127.0.0.1' }, port: 4340, interfaces }).problem, /plain HTTP/);
  const lines = inviteLines({ joinCode: 'pj1_x', expiresAt: new Date(600000).toISOString(), urls: [{ url: 'https://a:1', via: 'LAN (en0)' }, { url: 'https://bb:1', via: 'Tailscale' }], fingerprint: 'f'.repeat(64) }, 0);
  assert.equal(lines[0], `Run this on the machine to join (one-time, expires ${new Date(600000).toISOString()}, in 10 min):`);
  assert.ok(lines.includes('  https://a:1   LAN (en0)'));
});

test('reachability diagnoses refused ports, timeouts, pin mismatches and the wrong protocol', async t => {
  const closed = createNet(); await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve)); const port = closed.address().port; await new Promise(resolve => closed.close(resolve));
  assert.equal((await probeHub(`http://127.0.0.1:${port}`)).code, 'refused');
  // Accepts connections and never answers: what a firewall that drops packets or a wrong host looks like from here.
  const silent = createNet(socket => t.after(() => socket.destroy())); await new Promise(resolve => silent.listen(0, '127.0.0.1', resolve)); t.after(() => silent.close());
  const timeout = await probeHub(`http://127.0.0.1:${silent.address().port}`, { timeoutMs: 200 });
  assert.equal(timeout.code, 'timeout'); assert.match(timeout.message, /IP may be wrong/);
  const other = generateCertificate();
  const impostor = createServer({ key: other.key, cert: other.cert }, (request, response) => response.end('{"status":"ok"}'));
  await new Promise(resolve => impostor.listen(0, '127.0.0.1', resolve)); t.after(() => impostor.close());
  const mismatch = await probeHub(`https://127.0.0.1:${impostor.address().port}`, { pins: ['a'.repeat(64)] });
  assert.equal(mismatch.code, 'pin-mismatch'); assert.match(mismatch.message, /repin/); assert.ok(!mismatch.message.includes(other.fingerprint.slice(20)), 'only a short fingerprint prefix');
  assert.equal((await probeHub(`https://127.0.0.1:${impostor.address().port}`, { pins: [other.fingerprint] })).ok, true);
  assert.equal((await probeHub(`http://127.0.0.1:${impostor.address().port}`, { timeoutMs: 1000 })).code, 'protocol');
});

test('perpeto machines cordons, drains and sets a real hub; invite codes carry alternatives a joining node tries in order', async t => {
  const dir = await temporary(t); const nodeDir = await temporary(t, 'pcli-fleet-node-');
  const config = { ...hubConfig(dir, { port: 0, host: '0.0.0.0', tls: true }), longPollMs: 0 };
  await writeFile(resolve(dir, 'hub.json'), JSON.stringify(config));
  const hub = await createHub({ configPath: resolve(dir, 'hub.json') }); t.after(() => hub.close());
  config.port = Number(new URL(await hub.listen()).port); const url = `https://127.0.0.1:${config.port}`;
  await writeFile(resolve(dir, 'hub.json'), JSON.stringify(config));
  const owner = (await readFile(join(dir, 'hub/owner.secret'), 'utf8')).trim();
  let output = [];
  const run = async (...words) => { output = []; assert.equal(await main([...words, '--dir', dir], { print: line => output.push(line) }), 0); assert.ok(!output.join('\n').includes(owner)); return output; };

  // An invite: loopback first (reachable in this test), then an address nobody answers on.
  const { invite } = await import('../src/invite.js');
  const created = await invite(dir, { ttl: '5m', tailnet: { name: 'unreachable.invalid', ips: [] }, interfaces: { lo: [{ family: 'IPv4', internal: false, address: '10.255.255.1' }] } });
  const decoded = decodeJoinCode(created.joinCode);
  assert.equal(decoded.url, `https://unreachable.invalid:${config.port}`); assert.deepEqual(decoded.alts, [`https://10.255.255.1:${config.port}`]); assert.ok(decoded.fingerprint);
  assert.ok(Date.parse(created.expiresAt) - Date.now() <= 5 * 60000);
  // Joining tries each address; this one rewrites the candidates to loopback so one answers.
  const probed = [];
  const result = await joinHub(nodeDir, undefined, { joinCode: `pj1_${Buffer.from(JSON.stringify({ ...decoded, alts: [url] })).toString('base64url')}`, name: 'laptop',
    probe: async (candidate, options) => { probed.push(candidate); return candidate === url ? probeHub(candidate, options) : { ok: false, message: 'No answer' }; } });
  assert.deepEqual(probed, [decoded.url, url]); assert.equal(result.hubUrl, url);
  const failing = `pj1_${Buffer.from(JSON.stringify({ ...decoded, alts: ['https://10.255.255.1:1'] })).toString('base64url')}`;
  await assert.rejects(joinHub(await temporary(t, 'pcli-fleet-x-'), undefined, { joinCode: failing, probe: async () => ({ ok: false, message: 'Nothing is listening' }) }), /No hub address in this invite answered/);

  await run('machines');
  assert.match(output[0], /^laptop\s+limited\s+agents 0\/0 \(of 1\), jobs 0\/1/); assert.match(output[1], /No harness providers detected/);
  await run('machines', 'cordon', 'laptop'); assert.match(output[0], /cordoned/);
  await run('machines', 'set', 'laptop', '--max-agents', '0', '--labels', 'gpu', '--weight', '2');
  const listed = JSON.parse((await run('machines', '--json'))[0]).machines[0];
  assert.deepEqual([listed.schedule.cordoned, listed.schedule.maxAgents, listed.labels, listed.schedule.weight], [true, 0, ['gpu'], 2]);
  await run('machines', 'drain', 'laptop'); await run('machines', 'uncordon', 'laptop');
  const after = JSON.parse((await run('machines', '--json'))[0]).machines[0];
  assert.deepEqual([after.schedule.cordoned, after.schedule.drain], [false, false]);
  await assert.rejects(main(['machines', 'cordon', 'nobody', '--dir', dir], { print() {} }), /No machine is named nobody/);
});
