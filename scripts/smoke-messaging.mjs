import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(root, 'vendor/t3code/apps/server/dist/bin.mjs');
const home = await mkdtemp(join(tmpdir(), 'perpeto-messaging-smoke-'));
const socket = createServer();
socket.listen(0, '127.0.0.1');
await once(socket, 'listening');
const port = socket.address().port;
await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
const origin = `http://127.0.0.1:${port}`;
let processHandle;

function issue(scopes) {
  const result = spawnSync(process.execPath, [entry, 'auth', 'session', 'issue',
    '--base-dir', home, '--ttl', '10m', '--token-only',
    ...scopes.flatMap(scope => ['--scope', scope])], {cwd:root, encoding:'utf8', timeout:30000});
  if (result.status !== 0) throw new Error('Unable to issue temporary environment credential.');
  return result.stdout.trim();
}

async function start() {
  processHandle = spawn(process.execPath, [entry, 'serve', '--base-dir', home,
    '--host', '127.0.0.1', '--port', String(port), '--no-browser'], {cwd:root, stdio:'ignore'});
  let spawnError;
  processHandle.on('error', error => { spawnError = error; });
  for (let attempt = 0; attempt < 150; attempt++) {
    if (spawnError || processHandle.exitCode !== null) throw new Error('Temporary runtime exited during startup.');
    try {
      const response = await fetch(`${origin}/.well-known/t3/environment`, {signal:AbortSignal.timeout(1000)});
      if (response.ok) return;
    } catch { /* Wait for the real runtime to bind. */ }
    await delay(200);
  }
  throw new Error('Temporary runtime did not become ready.');
}

async function stop() {
  if (!processHandle || processHandle.exitCode !== null) return;
  const closed = once(processHandle, 'exit');
  processHandle.kill('SIGTERM');
  const timer = setTimeout(() => processHandle.kill('SIGKILL'), 8000);
  try { await closed; } finally { clearTimeout(timer); }
}

async function request(path, {token, method='GET', body, status=200} = {}) {
  let response;
  try { response = await fetch(origin+path, {
    method,
    headers:{...(token ? {Authorization:`Bearer ${token}`} : {}), ...(body ? {'Content-Type':'application/json'} : {})},
    ...(body ? {body:JSON.stringify(body)} : {}),
    signal:AbortSignal.timeout(10000),
  }); } catch { throw new Error(`Runtime connection failed during ${method} ${path}; exit=${processHandle.exitCode}, signal=${processHandle.signalCode}.`); }
  // Deliberately exclude response bodies/headers from assertion errors: credentials
  // and user content should never be copied into smoke-test logs.
  assert.equal(response.status, status, `${method} ${path} returned an unexpected status`);
  return response.status === 204 ? null : response.json();
}

try {
  await start();
  const writer = issue(['orchestration:read', 'orchestration:operate']);
  const reader = issue(['orchestration:read']);
  const credentialFile = join(home, 'writer.secret');
  const clientConfig = join(home, 'client.json');
  await writeFile(credentialFile, writer+'\n', {mode:0o600});
  await writeFile(clientConfig, JSON.stringify({baseUrl:origin,projectId:'smoke-project',roleId:'implementation',channelId:'build',credentialFile}));
  function cli(args, input) {
    const result = spawnSync(process.execPath, [resolve(root, 'packages/sdk/src/cli.js'), '--config', clientConfig, ...args], {cwd:root, input, encoding:'utf8', timeout:15000});
    if (result.status !== 0) throw new Error('Factory client subprocess failed.');
    assert.equal(result.stdout.includes(writer), false, 'Client must not output its credential.');
    return result.stdout;
  }
  const project = '/api/perpeto/projects/smoke-project';
  await request(project, {token:writer,method:'PUT',body:{name:'Smoke project'}});
  await request(`${project}/channels`, {token:writer,method:'POST',body:{id:'build',name:'Build'}});
  const path = `${project}/channels/build/messages`;
  const content = {senderRoleId:'implementation',recipientRoleId:'review',body:'Ready for review.',idempotencyKey:'smoke-revision'};
  const sent = JSON.parse(cli(['send','--body',content.body,'--key',content.idempotencyKey,'--to',content.recipientRoleId]));
  const repeated = await request(path, {token:writer,method:'POST',body:content});
  assert.equal(sent.duplicate,false); assert.equal(repeated.duplicate,true);
  assert.equal(sent.message.id,repeated.message.id);
  const read = await request(path, {token:reader});
  const cliPage = JSON.parse(cli(['read']));
  assert.equal(cliPage.messages[0].id,sent.message.id);
  const protocol = cli(['mcp'], [
    {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'perpeto-smoke',version:'1'}}},
    {jsonrpc:'2.0',method:'notifications/initialized'},
    {jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'factory_read',arguments:{}}},
  ].map(value=>JSON.stringify(value)).join('\n')+'\n').trim().split('\n').map(value=>JSON.parse(value));
  assert.equal(protocol[0].result.serverInfo.name,'perpeto-factory-messages');
  const toolPage = JSON.parse(protocol.find(value=>value.id===2).result.content[0].text);
  assert.equal(toolPage.messages[0].id,sent.message.id);
  assert.equal(read.messages.length,1); assert.equal(read.messages[0].body,content.body);
  await request(path, {token:reader,method:'POST',body:{...content,idempotencyKey:'denied'},status:403});
  await request(path, {status:401});
  await request(path, {token:writer,method:'POST',body:{...content,body:'Changed'},status:409});
  await request('/api/perpeto/projects/other/channels/build/messages', {token:reader,status:404});
  const liveHarness = process.argv.includes('--live-codex');
  if (liveHarness) {
    console.log('Starting optional live Codex harness check.');
    const mcp = `{perpeto={command=${JSON.stringify(process.execPath)},args=${JSON.stringify([resolve(root, 'packages/sdk/src/cli.js'),'--config',clientConfig,'mcp'])},required=true,tools={factory_read={approval_mode="approve"},factory_send={approval_mode="approve"},factory_channels={approval_mode="approve"}}}}`;
    let harnessFailure;
    const invocation = promisify(execFile)('codex', ['exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','--sandbox','read-only','--json','--cd',home,
      '-c',`mcp_servers=${mcp}`,
      'This is an integration test against a temporary Perpeto factory. Use only the perpeto MCP tools. Read the build channel, then send exactly one message with body "Live harness delivery verified.", idempotencyKey "live-harness-proof", recipientRoleId "review". Do not use shell tools or inspect files. Report completion briefly.'],
      {cwd:root,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
    invocation.child.stdin.end();
    const result = await invocation.then(() => true, error => { harnessFailure = {code:error.code,signal:error.signal,killed:error.killed}; return false; });
    if (!result) throw new Error(`Live Codex harness check failed (${JSON.stringify(harnessFailure)}). The optional check requires a working authenticated local harness.`);
    const delivered = await request(path,{token:reader});
    assert.ok(delivered.messages.some(message=>message.body==='Live harness delivery verified.' && message.recipientRoleId==='review'));
    console.log('Live Codex harness delivered a message through the Perpeto MCP client.');
  }
  await stop();
  await start();
  const restored = await request(path, {token:reader});
  assert.equal(restored.messages.length,liveHarness ? 2 : 1); assert.equal(restored.messages[0].id,sent.message.id);
  const next = await request(`${path}?after=${encodeURIComponent(read.nextCursor)}`, {token:reader});
  assert.equal(next.messages.length,liveHarness ? 1 : 0);
  console.log('Messaging smoke passed: HTTP/CLI/MCP clients, scopes, retry deduplication, project isolation, and runtime restart.');
} finally {
  await stop();
  await rm(home, {recursive:true,force:true});
}
