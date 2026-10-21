import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHub } from '../src/index.js';
import { createStubEngine } from '../src/engine/stub-engine.js';

const hmac = (owner, value) => createHmac('sha256', owner).update(value).digest('base64url');
const sha = value => createHash('sha256').update(value).digest('hex');
const heartbeat = { status: 'online', capacity: { maxAgents: 1, maxJobs: 1 }, running: { agents: 0, jobs: 0 }, providers: [] };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'perpeto-hub-credentials-'));
  const configPath = join(directory, 'hub.json');
  await writeFile(configPath, JSON.stringify({ port: 0, longPollMs: 0, maintenanceIntervalMs: 60000 }));
  let handle = await createHub({ configPath, engine: createStubEngine() }); let url = await handle.listen();
  t.after(async () => { await handle?.close(); await rm(directory, { recursive: true, force: true }); });
  const owner = (await readFile(join(directory, 'owner.secret'), 'utf8')).trim();
  const request = async (method, path, body, token = owner) => {
    const response = await fetch(`${url}/api/v1${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  return {
    directory, configPath, owner, request,
    async stop() { await handle.close(); handle = null; },
    async restart() { if (handle) await handle.close(); handle = await createHub({ configPath, engine: createStubEngine() }); url = await handle.listen(); },
  };
}

test('machine tokens and enrollment codes are random: the owner secret cannot mint them, and replays return the issued token', async t => {
  const f = await fixture(t);
  const created = await f.request('POST', '/machines/enrollment-codes', { idempotencyKey: 'code-1' });
  assert.notEqual(created.body.code, hmac(f.owner, `enrollment:${created.body.id}`), 'enrollment codes are not derived from the owner secret');
  assert.deepEqual((await f.request('POST', '/machines/enrollment-codes', { idempotencyKey: 'code-1' })).body, created.body);
  const enroll = { idempotencyKey: 'enroll-1', code: created.body.code, name: 'm', os: 'linux', arch: 'x64', version: 't' };
  const enrolled = (await f.request('POST', '/nodes/enroll', enroll, null)).body;
  const minted = hmac(f.owner, `node:${enrolled.machineId}`);
  assert.notEqual(enrolled.token, minted);
  assert.equal((await f.request('POST', '/nodes/heartbeat', heartbeat, minted)).status, 401, 'a token minted from the owner secret is refused');
  assert.equal((await f.request('POST', '/nodes/heartbeat', heartbeat, enrolled.token)).status, 200);
  await f.restart();
  assert.deepEqual((await f.request('POST', '/nodes/enroll', enroll, null)).body, enrolled, 'enrollment replay returns the issued token');
  const rotated = (await f.request('POST', '/nodes/token', { idempotencyKey: 'rotate-1' }, enrolled.token)).body;
  assert.notEqual(rotated.token, hmac(f.owner, `node:${enrolled.machineId}:1`));
  assert.equal((await f.request('POST', '/nodes/heartbeat', heartbeat, hmac(f.owner, `node:${enrolled.machineId}:1`))).status, 401);
  await f.restart();
  assert.deepEqual((await f.request('POST', '/nodes/token', { idempotencyKey: 'rotate-1' }, enrolled.token)).body, rotated, 'rotation replay returns the issued token');
  assert.equal((await f.request('POST', '/nodes/heartbeat', heartbeat, rotated.token)).status, 200);
  assert.equal((await f.request('POST', '/nodes/heartbeat', heartbeat, enrolled.token)).status, 401, 'first use retires the old token');
  // Plaintext never lands on disk; replays are sealed under a separate owner-only key.
  for (const suffix of ['', '-wal']) {
    const bytes = await readFile(join(f.directory, `hub.sqlite${suffix}`)).catch(() => Buffer.alloc(0));
    for (const secret of [enrolled.token, rotated.token, created.body.code]) assert.equal(bytes.includes(Buffer.from(secret)), false);
  }
  const key = join(f.directory, 'credentials.key');
  assert.equal((await stat(key)).mode & 0o777, 0o600);
  assert.notEqual((await readFile(key, 'utf8')).trim(), f.owner);
});

test('the hub refuses to start without the credential key once it has issued sealed credentials', async t => {
  const f = await fixture(t);
  await f.request('POST', '/machines/enrollment-codes', { idempotencyKey: 'code-1' });
  await f.stop();
  await rename(join(f.directory, 'credentials.key'), join(f.directory, 'moved.key'));
  await assert.rejects(createHub({ configPath: f.configPath, engine: createStubEngine() }), { code: 'CREDENTIAL_KEY_MISSING' });
  await writeFile(join(f.directory, 'credentials.key'), `${'A'.repeat(43)}\n`, { mode: 0o600 });
  await assert.rejects(createHub({ configPath: f.configPath, engine: createStubEngine() }), { code: 'CREDENTIAL_KEY_MISMATCH' });
  await rename(join(f.directory, 'moved.key'), join(f.directory, 'credentials.key'));
  await f.restart();
  assert.equal((await f.request('POST', '/machines/enrollment-codes', { idempotencyKey: 'code-1' })).status, 201);
});

test('machines enrolled with owner-derived tokens before the upgrade keep working and rotate onto random tokens', async t => {
  const f = await fixture(t);
  const code = (await f.request('POST', '/machines/enrollment-codes', {})).body.code;
  const machine = (await f.request('POST', '/nodes/enroll', { code, name: 'legacy', os: 'linux', arch: 'x64', version: 't' }, null)).body;
  await f.stop();
  // Rewrite the machine's credential as an older hub issued it: an HMAC of the owner secret, without a generation.
  const legacy = hmac(f.owner, `node:${machine.machineId}`);
  const db = new DatabaseSync(join(f.directory, 'hub.sqlite'));
  db.prepare("DELETE FROM tokens WHERE kind='node'").run();
  db.prepare("INSERT INTO tokens(hash,kind,machine_id) VALUES(?,'node',?)").run(sha(legacy), machine.machineId);
  db.close();
  await f.restart();
  assert.equal((await f.request('POST', '/nodes/heartbeat', heartbeat, legacy)).status, 200);
  const rotated = (await f.request('POST', '/nodes/token', {}, legacy)).body;
  assert.notEqual(rotated.token, hmac(f.owner, `node:${machine.machineId}:1`));
  assert.equal((await f.request('POST', '/nodes/heartbeat', heartbeat, legacy)).status, 200, 'the old token works until the new one is used');
  assert.equal((await f.request('POST', '/nodes/heartbeat', heartbeat, rotated.token)).status, 200);
  assert.equal((await f.request('POST', '/nodes/heartbeat', heartbeat, legacy)).status, 401);
});
