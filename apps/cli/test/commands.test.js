import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, access, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHub } from '@perpeto/hub';
import { main } from '../src/cli.js';
import { parseArgs } from '../src/args.js';
import { hubConfig, nodeConfig, readJson, readSecret } from '../src/config.js';
import { join, request } from '../src/api.js';
import { acquireLock } from '../src/process.js';

async function temporary(t) {
  const dir = await mkdtemp(resolve(tmpdir(), 'pcli-command-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('new command grammar rejects missing IDs, invalid verdicts and route injection', () => {
  for (const words of [['machines'], ['machines', 'revoke', 'mch_fixture'], ['node', 'rotate-token'], ['hub', 'decide', 'wi_fixture', 'pass', '--note', 'Ready']]) assert.equal(parseArgs(words).help, undefined);
  for (const words of [['machines', 'revoke'], ['machines', 'x'], ['machines', 'revoke', '../projects'], ['hub', 'decide', 'wi_x'], ['hub', 'decide', 'wi_x', 'maybe'], ['hub', 'decide', '..', 'pass']]) assert.throws(() => parseArgs(words));
});

test('commands use the real machine/token and decision routes without printing credentials', async t => {
  const dir = await temporary(t); const nodeDir = await temporary(t);
  const config = { ...hubConfig(dir, { port: 0 }), longPollMs: 0 };
  await writeFile(resolve(dir, 'hub.json'), JSON.stringify(config));
  const hub = await createHub({ configPath: resolve(dir, 'hub.json') });
  t.after(() => hub.close());
  const url = await hub.listen();
  config.port = Number(new URL(url).port);
  await writeFile(resolve(dir, 'hub.json'), JSON.stringify(config));
  const token = (await readSecret(resolve(dir, 'hub/owner.secret'))).trim();
  const api = (path, body) => request(url, path, { token, body });
  const code = (await api('/machines/enrollment-codes', {})).code;
  await join(nodeDir, url, { code });
  const before = await readJson(resolve(nodeDir, 'node/machine.json'));
  let output = [];
  const run = async (dataDir, ...words) => {
    output = []; assert.equal(await main([...words, '--dir', dataDir], { print: line => output.push(line) }), 0);
    assert.ok(!output.join('\n').includes(token)); assert.ok(!output.join('\n').includes(before.token));
    return output.join('\n');
  };
  assert.equal(JSON.parse(await run(dir, 'machines', '--json')).machines[0].id, before.machineId);
  const release = await acquireLock(nodeDir, 'node');
  await assert.rejects(run(nodeDir, 'node', 'rotate-token'), /running|Stop/); await release();
  await run(nodeDir, 'node', 'rotate-token');
  const after = await readJson(resolve(nodeDir, 'node/machine.json'));
  assert.notEqual(after.token, before.token); assert.ok(!output.join('').includes(after.token));
  assert.equal((await lstat(resolve(nodeDir, 'node/machine.json'))).mode & 0o777, 0o600);
  await request(url, '/nodes/lease', { token: after.token, body: { kinds: ['assignment'], max: 1 } });
  await assert.rejects(request(url, '/nodes/lease', { token: before.token, body: { kinds: ['assignment'], max: 1 } }), /401/);
  await run(dir, 'machines', 'revoke', before.machineId);
  await assert.rejects(request(url, '/nodes/token', { token: after.token, body: {} }), /401/);
  const project = await api('/projects', { name: 'CLI decisions', repo: { url: '/tmp/unused.git', defaultBranch: 'main' } });
  const graph = { schema: 'perpeto.workflow/1', nodes: ['input', 'first', 'second', 'output'].map((id, i) => ({ id, type: ['input', 'human', 'human', 'output'][i], label: id, position: { x: i, y: 0 }, config: i === 0 ? { source: 'manual' } : i === 3 ? {} : { prompt: 'Decide' } })), edges: [
    { id: 'one', from: { node: 'input' }, to: { node: 'first' }, kind: 'flow' },
    { id: 'two', from: { node: 'first', port: 'pass' }, to: { node: 'second' }, kind: 'flow' },
    { id: 'three', from: { node: 'second', port: 'pass' }, to: { node: 'output' }, kind: 'flow' },
    { id: 'reject-first', from: { node: 'first', port: 'fail' }, to: { node: 'output' }, kind: 'flow' },
    { id: 'reject-second', from: { node: 'second', port: 'fail' }, to: { node: 'output' }, kind: 'flow' },
  ] };
  const workflow = await api(`/projects/${project.id}/workflows`, { name: 'Two gates', graph });
  await api(`/workflows/${workflow.id}/activate`, { version: 1 });
  const running = await api(`/workflows/${workflow.id}/runs`, { input: { items: [{ title: 'Test decision' }] } });
  const [item] = (await api(`/runs/${running.id}/work-items`)).workItems;
  let posted;
  const fetchImpl = async (target, options) => {
    if (target.endsWith('/decision')) {
      posted = JSON.parse(options.body);
      // Another owner answers the fetched gate first. The CLI must not answer the next gate.
      await api(`/work-items/${item.id}/decision`, { decision: 'pass', decisionId: item.decisionId });
    }
    return fetch(target, options);
  };
  await assert.rejects(main(['hub', 'decide', item.id, 'pass', '--dir', dir], { print() {}, fetchImpl }), /409/);
  assert.equal(posted.decisionId, item.decisionId); assert.ok(posted.idempotencyKey);
  const [waiting] = (await api(`/runs/${running.id}/work-items`)).workItems;
  assert.equal(waiting.nodeId, 'second');
  await run(dir, 'hub', 'decide', item.id, 'pass', '--note', 'Reviewed');
  assert.equal((await api(`/runs/${running.id}`)).status, 'completed');
  await assert.rejects(run(dir, 'hub', 'decide', item.id, 'fail'), /not awaiting|not found/);
});

test('rotation recovers a lost response using the saved key and refuses a live direct daemon', async t => {
  const dir = await temporary(t); const config = nodeConfig(dir, 'https://hub.example');
  await mkdir(resolve(dir, 'node'), { mode: 0o700 });
  await writeFile(resolve(dir, 'node.json'), JSON.stringify(config));
  await writeFile(resolve(dir, 'node/machine.json'), JSON.stringify({ machineId: 'mch_fixture', token: 'old-private' }), { mode: 0o600 });
  const daemonRelease = await acquireLock(resolve(dir, 'node'), 'daemon');
  await assert.rejects(main(['node', 'rotate-token', '--dir', dir], { print() {} }), /running|Stop/);
  await daemonRelease();
  let original;
  await assert.rejects(main(['node', 'rotate-token', '--dir', dir], { print() {}, fetchImpl: async (_url, options) => {
    original = JSON.parse(options.body); throw new Error('lost response');
  } }), /request failed/);
  assert.equal((await readJson(resolve(dir, 'node/machine.json'))).token, 'old-private');
  await main(['node', 'rotate-token', '--dir', dir], { print(line) { assert.ok(!line.includes('private')); }, fetchImpl: async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), original); assert.equal(options.headers.Authorization, 'Bearer old-private');
    return { ok: true, json: async () => ({ machineId: 'mch_fixture', token: 'new-private', generation: 1 }) };
  } });
  assert.equal((await readJson(resolve(dir, 'node/machine.json'))).token, 'new-private');
  await assert.rejects(access(resolve(dir, 'rotate.secret')));
});

test('rotation resumes an already persisted response without calling the retired token', async t => {
  const dir = await temporary(t); const config = nodeConfig(dir, 'https://hub.example');
  await mkdir(resolve(dir, 'node'), { mode: 0o700 });
  await writeFile(resolve(dir, 'node.json'), JSON.stringify(config));
  const credential = { machineId: 'mch_fixture', token: 'old-private' };
  const result = { machineId: 'mch_fixture', token: 'new-private', generation: 1 };
  await writeFile(resolve(dir, 'node/machine.json'), JSON.stringify(result), { mode: 0o600 });
  await writeFile(resolve(dir, 'rotate.secret'), JSON.stringify({ hubUrl: config.hubUrl, credential, result, body: { idempotencyKey: 'saved-key' } }), { mode: 0o600 });
  await main(['node', 'rotate-token', '--dir', dir], { print() {}, fetchImpl() { assert.fail('saved response must avoid the network'); } });
  assert.deepEqual(await readJson(resolve(dir, 'node/machine.json')), result);
  await assert.rejects(access(resolve(dir, 'rotate.secret')));
});
