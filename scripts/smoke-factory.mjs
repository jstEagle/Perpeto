import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
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
const home = await mkdtemp(join(tmpdir(), 'perpeto-factory-smoke-'));
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
  const writer = issue(['orchestration:read','orchestration:operate']);
  const reader = issue(['orchestration:read']);
  const factories = '/api/perpeto/factories/projects/smoke-project';
  const definition = {id:'delivery',name:'Delivery',nodes:[{id:'lead',type:'agent',label:'Lead',harness:'codex',allowSubagents:true,maxSubagents:4,maxConcurrent:4}],edges:[]};
  const saved = await request(factories,{token:writer,method:'POST',body:definition,status:201});
  assert.equal(saved.version,1);
  const edited = await request(`${factories}/delivery`,{token:writer,method:'PUT',body:{expectedVersion:1,name:'Delivery revised',nodes:definition.nodes,edges:[]}});
  assert.equal(edited.version,2);
  await request(`${factories}/delivery`,{token:writer,method:'PUT',body:{expectedVersion:1,name:'Stale edit',nodes:definition.nodes,edges:[]},status:409});
  await request(factories,{token:reader,method:'POST',body:{...definition,id:'denied'},status:403});
  const source = join(home,'source');
  await mkdir(source);
  await writeFile(join(source,'value.txt'),'pinned');
  await writeFile(join(source,'verify.mjs'),`import {readFileSync,writeFileSync} from 'node:fs'; if(readFileSync('value.txt','utf8')!=='pinned')process.exit(2); writeFileSync('report.json',JSON.stringify({verified:true})); console.log('exact revision verified');`);
  function git(args) {
    const result = spawnSync('git',['-c','user.name=Perpeto smoke','-c','user.email=smoke@example.invalid',...args],{cwd:source,encoding:'utf8',timeout:15000});
    if(result.status!==0)throw new Error('Unable to prepare isolated runner fixture.');
    return result.stdout.trim();
  }
  git(['init']);git(['add','.']);git(['commit','-m','fixture']);
  const revision = git(['rev-parse','HEAD']);
  await writeFile(join(source,'value.txt'),'dirty source must stay untouched');
  const credentialFile = join(home,'runner.secret');
  await writeFile(credentialFile,writer+'\n',{mode:0o600});
  const configFile = join(home,'runner.json');
  await writeFile(configFile,JSON.stringify({baseUrl:origin,credentialFile,runnerId:'smoke-runner',labels:[process.platform],repositories:{fixture:source},executables:{node:process.execPath},workDirectory:join(home,'jobs'),toolPath:process.env.PATH,timeoutMs:10000,maxOutputBytes:65536,leaseMs:6000,artifactPaths:['report.json']}));
  const input = {projectId:'smoke-project',repositoryId:'fixture',revision,command:['node','verify.mjs'],requiredLabels:[process.platform],idempotencyKey:'pinned-build'};
  const clientConfig = join(home,'agent-client.json');
  await writeFile(clientConfig,JSON.stringify({baseUrl:origin,projectId:'smoke-project',roleId:'implementation',channelId:'ci',credentialFile}));
  const {projectId,...jobArguments}=input;
  const invocation = promisify(execFile)(process.execPath,[resolve(root,'packages/factory-client/src/cli.js'),'--config',clientConfig,'mcp'],{cwd:root,encoding:'utf8',timeout:15000});
  invocation.child.stdin.end([
    {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'ci-smoke',version:'1'}}},
    {jsonrpc:'2.0',method:'notifications/initialized'},
    {jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'factory_submit_ci',arguments:jobArguments}},
  ].map(value=>JSON.stringify(value)).join('\n')+'\n');
  const agentResult=await invocation;
  assert.equal(agentResult.stdout.includes(writer),false);
  const toolReply=agentResult.stdout.trim().split('\n').map(value=>JSON.parse(value)).find(value=>value.id===2);
  assert.notEqual(toolReply.result.isError,true);
  const submitted=JSON.parse(toolReply.result.content[0].text);
  assert.equal(submitted.job.status,'queued');
  const retry = await request('/api/perpeto/runner/jobs',{token:writer,method:'POST',body:input});
  assert.equal(retry.duplicate,true);
  await request('/api/perpeto/runner/claim',{token:reader,method:'POST',body:{runnerId:'denied',labels:[],repositoryIds:['fixture'],leaseMs:6000},status:403});
  const result = await promisify(execFile)(process.execPath,[resolve(root,'packages/factory-runner/src/worker.js'),'once','--config',configFile],{cwd:root,encoding:'utf8',timeout:30000});
  assert.equal(result.stdout.includes(writer),false);
  const executed = JSON.parse(result.stdout);
  assert.equal(executed.job.status,'succeeded');
  assert.equal(executed.job.revision,revision);
  const observed=await promisify(execFile)(process.execPath,[resolve(root,'packages/factory-client/src/cli.js'),'--config',clientConfig,'ci-status','--id',submitted.job.id],{cwd:root,encoding:'utf8',timeout:15000});
  assert.equal(JSON.parse(observed.stdout).status,'succeeded');
  assert.match(executed.job.result.log,/exact revision verified/);
  assert.deepEqual(executed.job.result.artifacts,[{path:'report.json',size:17}]);
  assert.equal(await readFile(join(source,'value.txt'),'utf8'),'dirty source must stay untouched');
  await stop();await start();
  assert.equal((await request(`${factories}/delivery`,{token:reader})).version,2);
  assert.equal((await request(`/api/perpeto/runner/jobs/${submitted.job.id}`,{token:reader})).status,'succeeded');
  console.log('Factory smoke passed: authenticated versioned definitions, stale-edit rejection, real runner subprocess, exact revision, retained results and restart.');
} finally { await stop();await rm(home,{recursive:true,force:true}); }
