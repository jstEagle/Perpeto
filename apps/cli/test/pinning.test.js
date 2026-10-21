import test from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '@perpeto/hub';
import { createNode, createTransport, ExecutorRegistry, fingerprintOf } from '@perpeto/node';
import { generateCertificate } from '@perpeto/hub/tls';

async function eventually(check, { timeoutMs = 30000, message = 'Condition did not become true.' } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(message);
}

const executor = { kind: 'unused', canRun: () => false, run: async () => ({ outcome: 'success', summary: 'Done' }) };
const decodeJoin = code => JSON.parse(Buffer.from(code.slice('pj1_'.length), 'base64url').toString('utf8'));

/** A hub serving its own self-signed certificate on loopback, and an owner client pinned to it. */
async function secureHub(t) {
  // Tear down in reverse: nodes stop before the hub closes.
  const cleanups = []; t.after(async () => { for (const fn of cleanups.reverse()) await fn().catch(() => {}); });
  const root = await mkdtemp(join(tmpdir(), 'perpeto-tls-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'hub.json');
  await writeFile(configPath, JSON.stringify({ port: 0, tlsEnabled: true, heartbeatIntervalMs: 1000, longPollMs: 200, maintenanceIntervalMs: 50 }));
  const hub = await createHub({ configPath }); const url = await hub.listen(); cleanups.push(() => hub.close());
  const owner = (await readFile(join(root, 'owner.secret'), 'utf8')).trim();
  const fingerprint = () => fingerprintOf(new X509Certificate(hub.hub.tls.current.cert).raw);
  const client = createTransport(url, { pins: () => hub.hub.tls.fingerprints }); cleanups.push(async () => client.close());
  const request = async (method, path, body) => {
    const response = await client.request(path, { method, headers: { Authorization: `Bearer ${owner}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json(); assert.ok(response.ok, `${method} ${path} -> ${response.status} ${JSON.stringify(data)}`); return data;
  };
  return { root, url, hub, fingerprint, request, cleanups };
}
/** A node daemon in its own directory, joined with a code from the hub, pinned to `pin`. */
async function startNode(t, h, { pin, code, name = 'machine' }) {
  const dir = await mkdtemp(join(tmpdir(), 'perpeto-tls-node-')); h.cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'code'), code, { mode: 0o600 });
  await writeFile(join(dir, 'node.json'), JSON.stringify({ hubUrl: h.url, hubFingerprint: pin, name, dataDir: './data', enrollmentCodeFile: './code',
    labels: [], capacity: { maxAgents: 1, maxJobs: 1 }, providers: [], fake: {}, executorPackages: [], accounts: {},
    timing: { heartbeatMs: 100, renewMs: 1000, requestMs: 3000, pollIdleMs: 20, backoffMinMs: 20, backoffMaxMs: 100 } }));
  const node = await createNode({ configPath: join(dir, 'node.json'), registry: new ExecutorRegistry().register(executor) });
  h.cleanups.push(() => node.stop({ drain: false }));
  return { dir, node, pins: async () => JSON.parse(await readFile(join(dir, 'data', 'hub-pins.json'), 'utf8')) };
}

test('nodes pin the hub\'s self-signed certificate from the join code and refuse any other before sending a byte', async t => {
  const h = await secureHub(t);
  assert.match(h.url, /^https:\/\/127\.0\.0\.1:\d+$/);
  await assert.rejects(fetch(`${h.url}/api/v1/health`), 'no CA vouches for the hub; only pinning trusts it');
  const created = await h.request('POST', '/machines/enrollment-codes', {});
  const join = decodeJoin(created.joinCode);
  assert.deepEqual(join, { url: h.url, fingerprint: h.fingerprint(), code: created.code });
  const { node } = await startNode(t, h, { pin: join.fingerprint, code: join.code });
  await node.start();
  await eventually(async () => (await h.request('GET', '/machines')).machines.some(machine => machine.status === 'online'));

  // A server with another certificate at the hub's address sees no request at all: the token never leaves the node.
  const other = generateCertificate(); let requests = 0;
  const impostor = createServer({ key: other.key, cert: other.cert }, (request, response) => { requests++; response.end('{}'); });
  await new Promise(resolve => impostor.listen(0, '127.0.0.1', resolve)); h.cleanups.push(async () => impostor.close());
  const pinned = createTransport(`https://127.0.0.1:${impostor.address().port}`, { pins: () => [join.fingerprint] }); h.cleanups.push(async () => pinned.close());
  await assert.rejects(pinned.request('/nodes/heartbeat', { method: 'POST', headers: { Authorization: 'Bearer secret-token' }, body: '{}' }),
    error => error.code === 'HUB_CERTIFICATE_MISMATCH' && error.fingerprint === other.fingerprint);
  assert.equal(requests, 0);
});

test('a certificate rotation is announced to pinned machines first, so running nodes follow it; an offline node re-pins', async t => {
  const h = await secureHub(t);
  const first = h.fingerprint();
  const running = await startNode(t, h, { pin: first, code: decodeJoin((await h.request('POST', '/machines/enrollment-codes', {})).joinCode).code });
  const offlineCode = decodeJoin((await h.request('POST', '/machines/enrollment-codes', {})).joinCode).code;
  await running.node.start();
  await eventually(async () => (await h.request('GET', '/machines')).machines.length === 1);
  const rotated = await h.request('POST', '/tls/rotate', {});
  assert.equal(rotated.fingerprint, first); assert.match(rotated.next, /^[a-f0-9]{64}$/); assert.notEqual(rotated.next, first);
  await eventually(async () => JSON.stringify(await running.pins().catch(() => null)) === JSON.stringify([first, rotated.next]), { message: 'node pinned the next certificate' });
  const activated = await h.request('POST', '/tls/activate', {});
  assert.deepEqual({ fingerprint: activated.fingerprint, previous: activated.previous }, { fingerprint: rotated.next, previous: first });
  assert.equal(h.fingerprint(), rotated.next, 'the hub now serves the new certificate');
  await eventually(async () => JSON.stringify(await running.pins().catch(() => null)) === JSON.stringify([rotated.next]), { message: 'node dropped the old pin' });
  const before = (await h.request('GET', '/machines')).machines[0].lastHeartbeatAt;
  await eventually(async () => (await h.request('GET', '/machines')).machines[0].lastHeartbeatAt > before, { message: 'node still heartbeats' });
  assert.equal(running.node.error, undefined);

  // A machine that was offline still pins the old certificate and stops with a clear error, then re-pins.
  const offline = await startNode(t, h, { pin: first, code: offlineCode, name: 'offline' });
  await assert.rejects(offline.node.start(), error => /pinned|HUB_CERTIFICATE_MISMATCH/i.test(`${error.code} ${error.message}`));
  await mkdir(join(offline.dir, 'data'), { recursive: true });
  await writeFile(join(offline.dir, 'data', 'hub-pins.json'), JSON.stringify([rotated.next]), { mode: 0o600 });
  const repinned = await createNode({ configPath: join(offline.dir, 'node.json'), registry: new ExecutorRegistry().register(executor) });
  h.cleanups.push(() => repinned.stop({ drain: false }));
  await repinned.start();
  await eventually(async () => (await h.request('GET', '/machines')).machines.length === 2);
  await assert.rejects(h.request('POST', '/tls/activate', {}), /NO_PENDING_CERTIFICATE|409/);
});
