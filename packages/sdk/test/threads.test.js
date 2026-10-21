import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { FactoryClient, loadConfig } from '../src/client.js';
// Test-only: the hub's dependency-free self-signed certificate, to exercise pinning against a real TLS handshake.
import { generateCertificate } from '../../../apps/hub/src/tls.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const token = 'pa1_test-agent-token';

async function fixture(t, { tls } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'perpeto-sdk-threads-'));
  const calls = [];
  let responder = () => ({ status: 200, body: { ok: true } });
  const handler = async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const call = { method: request.method, url: request.url, auth: request.headers.authorization, body: text ? JSON.parse(text) : undefined };
    calls.push(call);
    const result = responder(call);
    response.writeHead(result.status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(result.body));
  };
  const server = tls ? createTlsServer({ cert: tls.cert, key: tls.key }, handler) : createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  writeFileSync(join(directory, 'session.secret'), token, { mode: 0o600 });
  const configPath = join(directory, 'client.json');
  const write = extra => writeFileSync(configPath, JSON.stringify({ baseUrl: `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`, projectId: 'prj_1',
    channelId: 'run-run_1', roleId: 'reviewer', credentialFile: './session.secret', timeoutMs: 2000, ...extra }));
  write({});
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  return { calls, configPath, write, config: () => loadConfig(configPath), respond: fn => { responder = fn; } };
}
function run(configPath, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, '--config', configPath, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
const path = url => new URL(url, 'http://localhost').pathname;
const query = url => Object.fromEntries(new URL(url, 'http://localhost').searchParams);

test('client replies, reads threads, acknowledges and tracks unread as the configured role', async t => {
  const f = await fixture(t);
  const client = new FactoryClient(f.config());
  await client.reply({ messageId: 'msg 1', body: 'On it', idempotencyKey: 'r1' });
  await client.reply({ messageId: 'msg_1', body: 'Also QA', idempotencyKey: 'r2', recipientRoleId: 'qa' });
  await client.thread({ threadId: 'msg_1', limit: 20 });
  await client.message({ messageId: 'msg_1' });
  await client.ack({ messageId: 'msg_1', note: 'Handled' });
  await client.unread({ limit: 5 });
  await client.markRead({ messageId: 'msg_2' });
  const channel = '/api/v1/messaging/projects/prj_1/channels/run-run_1';
  assert.deepEqual(f.calls.map(call => [call.method, path(call.url)]), [
    ['POST', `${channel}/messages`], ['POST', `${channel}/messages`], ['GET', `${channel}/messages`], ['GET', `${channel}/messages/msg_1`],
    ['POST', `${channel}/messages/msg_1/ack`], ['GET', `${channel}/unread`], ['POST', `${channel}/read-cursor`],
  ]);
  assert.deepEqual(f.calls[0].body, { senderRoleId: 'reviewer', parentId: 'msg 1', body: 'On it', idempotencyKey: 'r1' }, 'a reply leaves the recipient to the hub');
  assert.equal(f.calls[1].body.recipientRoleId, 'qa');
  assert.deepEqual(query(f.calls[2].url), { threadId: 'msg_1', limit: '20' });
  assert.deepEqual(f.calls[4].body, { roleId: 'reviewer', note: 'Handled' });
  assert.deepEqual(query(f.calls[5].url), { roleId: 'reviewer', limit: '5' });
  assert.deepEqual(f.calls[6].body, { roleId: 'reviewer', messageId: 'msg_2' });
  assert.throws(() => client.reply({ body: 'x', idempotencyKey: 'k' }), /messageId/);
  assert.throws(() => client.ack({ messageId: 'm', note: '' }), /note/);
});

test('unread with markRead advances the cursor to the last message returned', async t => {
  const f = await fixture(t);
  f.respond(call => path(call.url).endsWith('/unread')
    ? { status: 200, body: { roleId: 'reviewer', messages: [{ id: 'a' }, { id: 'b' }], unreadCount: 2, lastReadMessageId: null } }
    : { status: 200, body: { roleId: 'reviewer', lastReadMessageId: 'b', unreadCount: 0 } });
  const result = await new FactoryClient(f.config()).unread({ markRead: true });
  assert.deepEqual(result, { roleId: 'reviewer', messages: [{ id: 'a' }, { id: 'b' }], unreadCount: 0, lastReadMessageId: 'b' });
  assert.deepEqual(f.calls[1].body, { roleId: 'reviewer', messageId: 'b' });
  f.respond(() => ({ status: 200, body: { roleId: 'reviewer', messages: [], unreadCount: 0, lastReadMessageId: null } }));
  await new FactoryClient(f.config()).unread({ markRead: true });
  assert.equal(f.calls.length, 3, 'nothing to mark');
});

test('CLI reply, thread, ack, unread and message commands', async t => {
  const f = await fixture(t);
  for (const args of [
    ['reply', 'msg_1', '--body', 'Done', '--key', 'k1'], ['thread', 'msg_1', '--limit', '5'], ['ack', 'msg_1', '--note', 'Fixed'],
    ['unread', '--limit', '3'], ['message', 'msg_1'],
  ]) {
    const output = await run(f.configPath, args);
    assert.equal(output.code, 0, `${args[0]}: ${output.stderr}`);
    assert.deepEqual(JSON.parse(output.stdout), { ok: true });
    assert.ok(!output.stdout.includes(token));
  }
  assert.deepEqual(f.calls.map(call => call.method), ['POST', 'GET', 'POST', 'GET', 'GET']);
  assert.equal(f.calls[0].body.parentId, 'msg_1');
  assert.equal(f.calls[2].body.note, 'Fixed');
  assert.equal((await run(f.configPath, ['reply', '--body', 'No id', '--key', 'k'])).code, 1);
  assert.equal((await run(f.configPath, ['ack'])).code, 1);
});

test('MCP lists and calls the reply, thread, ack and unread tools', async t => {
  const f = await fixture(t);
  const calls = [
    ['factory_reply', { messageId: 'msg_1', body: 'On it', idempotencyKey: 'k1' }],
    ['factory_thread', { threadId: 'msg_1' }],
    ['factory_ack', { messageId: 'msg_1', note: 'Handled' }],
    ['factory_unread', { limit: 10 }],
  ];
  const requests = [{ jsonrpc: '2.0', id: 0, method: 'initialize' }, { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    ...calls.map(([name, args], index) => ({ jsonrpc: '2.0', id: index + 2, method: 'tools/call', params: { name, arguments: args } })),
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'factory_ack', arguments: {} } }];
  const output = await run(f.configPath, ['mcp'], requests.map(value => JSON.stringify(value)).join('\n') + '\n');
  const replies = output.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(replies[1].result.tools.map(tool => tool.name), ['factory_channels', 'factory_send', 'factory_read', 'factory_reply', 'factory_thread', 'factory_ack', 'factory_unread']);
  for (const reply of replies.slice(2, 6)) assert.deepEqual(JSON.parse(reply.result.content[0].text), { ok: true });
  assert.equal(replies[6].error.code, -32602, 'ack needs a message id');
  assert.deepEqual(f.calls.map(call => [call.method, path(call.url).split('/').slice(8).join('/')]),
    [['POST', 'messages'], ['GET', 'messages'], ['POST', 'messages/msg_1/ack'], ['GET', 'unread']]);
});

test('pinned TLS trusts only the configured certificate and sends nothing to another', async t => {
  const certificate = generateCertificate({ names: { names: ['localhost'], addresses: ['127.0.0.1'] } });
  const f = await fixture(t, { tls: certificate });
  f.write({ tlsFingerprints: [certificate.fingerprint] });
  assert.deepEqual(await new FactoryClient(f.config()).unread(), { ok: true });
  assert.equal(f.calls[0].auth, `Bearer ${token}`);
  f.write({ tlsFingerprints: ['0'.repeat(64)] });
  await assert.rejects(new FactoryClient(f.config()).unread(), /failed or timed out/);
  assert.equal(f.calls.length, 1, 'an unpinned server never receives the credential');
  f.write({ tlsFingerprints: ['not-a-fingerprint'] });
  assert.throws(() => f.config(), /tlsFingerprints/);
});
