import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { FactoryClient, loadConfig } from '../src/client.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const token = 'test-private-session-token';
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'perpeto-client-'));
  const calls = [];
  let responder = () => ({ status: 200, body: { ok: true } });
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const call = { method: request.method, url: request.url, auth: request.headers.authorization, body: text ? JSON.parse(text) : undefined };
    calls.push(call);
    const result = responder(call);
    response.writeHead(result.status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(result.body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  writeFileSync(join(directory, 'session.secret'), token, { mode: 0o600 });
  const configPath = join(directory, 'client.json');
  writeFileSync(configPath, JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}`, projectId: 'project / one', channelId: 'build', roleId: 'backend-lead', credentialFile: './session.secret', timeoutMs: 1000 }));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, calls, configPath, config: loadConfig(configPath), respond: fn => { responder = fn; } };
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

test('sends scoped authenticated HTTP requests with stable configured sender identity', async t => {
  const f = await fixture(t);
  const client = new FactoryClient(f.config);
  await client.initProject('Factory');
  await client.createChannel('qa', 'QA');
  await client.channels();
  await client.send({ body: 'Ready', idempotencyKey: 'revision-1', recipientRoleId: 'reviewer', channelId: 'qa' });
  await client.read({ after: 'opaque+cursor=', limit: 25, recipientRoleId: 'reviewer', channelId: 'qa' });
  assert.deepEqual(f.calls.map(call => call.method), ['PUT', 'POST', 'GET', 'POST', 'GET']);
  assert.ok(f.calls.every(call => call.auth === `Bearer ${token}`));
  assert.equal(f.calls[0].url, '/api/perpeto/projects/project%20%2F%20one');
  assert.deepEqual(f.calls[0].body, { name: 'Factory' });
  assert.deepEqual(f.calls[1].body, { id: 'qa', name: 'QA' });
  assert.deepEqual(f.calls[3].body, { senderRoleId: 'backend-lead', body: 'Ready', idempotencyKey: 'revision-1', recipientRoleId: 'reviewer' });
  const query = new URL(f.calls[4].url, 'http://localhost').searchParams;
  assert.equal(query.get('after'), 'opaque+cursor=');
  assert.equal(query.get('limit'), '25');
  assert.equal(query.get('recipientRoleId'), 'reviewer');
});

test('retry reuses identical payload and key; conflict and auth failures are not retried', async t => {
  const f = await fixture(t);
  f.respond(() => f.calls.length === 1 ? { status: 503, body: { error: 'Busy' } } : { status: 200, body: { duplicate: true } });
  const client = new FactoryClient(f.config);
  assert.deepEqual(await client.send({ body: 'Ready', idempotencyKey: 'stable-key' }), { duplicate: true });
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0].body, f.calls[1].body);
  f.respond(() => ({ status: 409, body: { error: token } }));
  await assert.rejects(client.send({ body: 'Changed', idempotencyKey: 'stable-key' }), error => error.message === 'Factory request rejected (HTTP 409).' && !error.stack.includes(token));
  assert.equal(f.calls.length, 3);
  f.respond(() => ({ status: 401, body: { error: token } }));
  await assert.rejects(client.channels(), /HTTP 401/);
  assert.equal(f.calls.length, 4);
});

test('requires owner-only credential files and rejects credentials embedded in config', async t => {
  const f = await fixture(t);
  chmodSync(f.config.credentialFile, 0o644);
  assert.throws(() => new FactoryClient(f.config), /owner-only/);
  writeFileSync(f.configPath, JSON.stringify({ ...f.config, token }));
  assert.throws(() => loadConfig(f.configPath), /Unknown configuration field/);
});

test('remote credential transport requires TLS or explicit insecure HTTP opt-in', async t => {
  const f = await fixture(t);
  writeFileSync(f.configPath, JSON.stringify({ ...f.config, baseUrl: 'http://192.168.1.2:3773' }));
  assert.throws(() => loadConfig(f.configPath), /Remote HTTP requires/);
  writeFileSync(f.configPath, JSON.stringify({ ...f.config, baseUrl: 'http://192.168.1.2:3773', allowInsecureHttp: true }));
  assert.equal(loadConfig(f.configPath).allowInsecureHttp, true);
  writeFileSync(f.configPath, JSON.stringify({ ...f.config, baseUrl: 'https://factory.example.com' }));
  assert.equal(loadConfig(f.configPath).baseUrl, 'https://factory.example.com');
});

test('CLI sends and reads JSON and never prints token or raw server error bodies', async t => {
  const f = await fixture(t);
  const sent = await run(f.configPath, ['send', '--body', 'Ready', '--key', 'key-1', '--to', 'reviewer']);
  assert.equal(sent.code, 0);
  assert.deepEqual(JSON.parse(sent.stdout), { ok: true });
  const read = await run(f.configPath, ['read', '--limit', '20']);
  assert.equal(read.code, 0);
  assert.equal(new URL(f.calls[1].url, 'http://localhost').searchParams.get('limit'), '20');
  f.respond(() => ({ status: 403, body: { error: token } }));
  const failed = await run(f.configPath, ['channels']);
  assert.equal(failed.code, 1);
  assert.equal(failed.stdout, '');
  assert.match(failed.stderr, /HTTP 403/);
  for (const output of [sent, read, failed]) assert.ok(!`${output.stdout}${output.stderr}`.includes(token));
});

test('MCP stdio actual process negotiates, lists tools, calls HTTP and emits only JSON-RPC', async t => {
  const f = await fixture(t);
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'factory_send', arguments: { body: 'Ready', idempotencyKey: 'key-1' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'factory_read', arguments: { limit: 0 } } },
    { jsonrpc: '2.0', id: 5, method: 'ping' },
  ];
  const output = await run(f.configPath, ['mcp'], requests.map(value => JSON.stringify(value)).join('\n') + '\n');
  assert.equal(output.code, 0);
  assert.equal(output.stderr, '');
  const replies = output.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies.length, 5);
  assert.ok(replies.every(reply => reply.jsonrpc === '2.0'));
  assert.equal(replies[0].result.protocolVersion, '2025-06-18');
  assert.equal(replies[1].result.tools.length, 3);
  assert.deepEqual(JSON.parse(replies[2].result.content[0].text), { ok: true });
  assert.equal(replies[3].error.code, -32602);
  assert.deepEqual(replies[4].result, {});
  assert.equal(f.calls.length, 1);
  assert.ok(!output.stdout.includes(token));
});

test('MCP parse errors and failed tool operations do not disclose credentials', async t => {
  const f = await fixture(t);
  f.respond(() => ({ status: 500, body: { error: token } }));
  const requests = [
    '{bad json}',
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize' }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'factory_channels' } }),
  ];
  const output = await run(f.configPath, ['mcp'], requests.join('\n') + '\n');
  const replies = output.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies[0].error.code, -32700);
  assert.equal(replies[1].error.code, -32000);
  assert.equal(replies[3].result.isError, true);
  assert.ok(!`${output.stdout}${output.stderr}`.includes(token));
});
