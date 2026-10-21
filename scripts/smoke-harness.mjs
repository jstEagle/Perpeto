// Optional real-subscription check. Never part of CI or the ordinary test suite.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, chmod, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(join(root,'config/smoke-harness.json'),'utf8'));
const entry = resolve(root,config.runtimeEntry);
const sourceAuth = isAbsolute(config.authSource) ? config.authSource : join(homedir(),config.authSource);
const fingerprint = data => createHash('sha256').update(data).digest('hex');
let sourceFingerprint;
try { sourceFingerprint=fingerprint(await readFile(sourceAuth)); }
catch { throw new Error('Optional live smoke requires an existing local Codex auth file. No login or user configuration was changed.'); }
const located = spawnSync('/usr/bin/which',[config.codexBinary],{encoding:'utf8'});
if(located.status!==0)throw new Error('Configured local Codex executable is unavailable.');
const binary=located.stdout.trim();
const base=await mkdtemp(join(tmpdir(),'perpeto-harness-smoke-'));
await chmod(base,0o700);
const codexHome=join(base,'codex'), workspace=join(base,'workspace'), state=join(base,'runtime');
let runtime, ws, token;const pending=new Map();
const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');
const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
const origin=`http://127.0.0.1:${port}`;
async function stop(){if(ws){ws.close();ws=undefined;}if(runtime&&runtime.exitCode===null){const ended=once(runtime,'exit');runtime.kill('SIGTERM');const timer=setTimeout(()=>runtime.kill('SIGKILL'),config.shutdownTimeoutMs);try{await ended;}finally{clearTimeout(timer);}}}
async function start(){
  runtime=spawn(process.execPath,[entry,'serve','--base-dir',state,'--host','127.0.0.1','--port',String(port),'--no-browser'],{cwd:workspace,stdio:'ignore'});
  let error;runtime.on('error',()=>{error=true;});
  const deadline=Date.now()+config.startupTimeoutMs;
  while(Date.now()<deadline){if(error||runtime.exitCode!==null)throw new Error('Isolated harness runtime exited during startup.');try{if((await fetch(`${origin}/.well-known/t3/environment`,{signal:AbortSignal.timeout(1000)})).ok)return;}catch{}await delay(config.pollIntervalMs);}
  throw new Error('Isolated runtime startup timed out.');
}
async function http(path,method='GET',body){
  const response=await fetch(origin+path,{method,headers:{authorization:`Bearer ${token}`,'x-t3-orchestration-protocol':'2',...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(config.requestTimeoutMs)});
  if(!response.ok)throw new Error(`Live harness HTTP request failed (${response.status}).`);
  return response.json();
}
async function connect(){
  const {ticket}=await http('/api/auth/websocket-ticket','POST');
  ws=new WebSocket(`${origin.replace('http:','ws:')}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket)}`);
  ws.addEventListener('message',event=>{
    let frames;try{const decoded=JSON.parse(event.data);frames=Array.isArray(decoded)?decoded:[decoded];}catch{return;}
    for(const frame of frames){
      if(frame._tag==='Ping'){ws.send(JSON.stringify({_tag:'Pong'}));continue;}
      const waiting=pending.get(String(frame.requestId));
      if(frame._tag==='Exit'&&waiting){pending.delete(String(frame.requestId));clearTimeout(waiting.timer);if(frame.exit?._tag==='Success')waiting.resolve(frame.exit.value);else waiting.reject(new Error('Imported runtime RPC rejected the request.'));}
    }
  });
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Harness RPC connection timed out.')),config.requestTimeoutMs);ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});ws.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('Harness RPC connection failed.'));},{once:true});});
}
function rpc(tag,payload){return new Promise((resolve,reject)=>{const id=randomUUID();const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Harness RPC ${tag} timed out.`));},config.requestTimeoutMs);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({_tag:'Request',id,tag,payload,headers:[]}));});}
try {
  await mkdir(codexHome,{mode:0o700});await mkdir(workspace);await mkdir(join(state,'userdata'),{recursive:true});
  await copyFile(sourceAuth,join(codexHome,'auth.json'));await chmod(join(codexHome,'auth.json'),0o600);
  await writeFile(join(codexHome,'config.toml'),config.codexConfig,{mode:0o600});
  const providerInstances=Object.fromEntries(config.providerDrivers.map(driver=>[driver,{driver,enabled:false}]));
  providerInstances.codex={driver:'codex',enabled:true,config:{setupMode:'existing',binaryPath:binary,homePath:codexHome,shadowHomePath:''}};
  await writeFile(join(state,'userdata/settings.json'),JSON.stringify({providerInstances}),{mode:0o600});
  const git=spawnSync('git',['init'],{cwd:workspace,stdio:'ignore'});if(git.status!==0)throw new Error('Unable to prepare isolated Git workspace.');
  await start();
  const issued=spawnSync(process.execPath,[entry,'auth','session','issue','--base-dir',state,'--ttl','10m','--token-only','--scope','orchestration:read','--scope','orchestration:operate','--scope','settings:write'],{cwd:root,encoding:'utf8',timeout:config.requestTimeoutMs});
  if(issued.status!==0)throw new Error('Unable to issue isolated runtime credential.');token=issued.stdout.trim();
  await connect();
  await rpc('server.refreshProviders',{instanceId:'codex',cwd:workspace,fresh:true});
  let provider;
  const providerDeadline=Date.now()+config.startupTimeoutMs;
  while(Date.now()<providerDeadline){
    const snapshot=await rpc('server.getConfig',{});
    provider=snapshot.providers.find(provider=>provider.instanceId==='codex');
    if(provider?.enabled&&provider?.installed&&provider.models?.length)break;
    await delay(config.pollIntervalMs);
  }
  if(!provider?.enabled||!provider?.installed||!provider.models?.length)throw new Error(`Isolated Codex provider unavailable (${JSON.stringify({enabled:provider?.enabled,installed:provider?.installed,status:provider?.status,models:provider?.models?.length})}).`);
  const model=config.model??provider.models.find(model=>model.isDefault)?.slug??provider.models.find(model=>!model.isLegacy)?.slug;
  if(!model)throw new Error('No Codex model was available in the imported runtime catalog.');
  const projectId=`smoke-${randomUUID()}`;
  await http('/api/projects/mutate','POST',{type:'project.create',commandId:randomUUID(),projectId,title:'Isolated live harness smoke',workspaceRoot:workspace});
  const nonce=`PERPETO_${randomUUID().replaceAll('-','')}`;
  const launched=await rpc('orchestration.launchThread',{commandId:randomUUID(),projectId,title:'Live adapter proof',generateTitle:false,modelSelection:{instanceId:'codex',model},runtimeMode:'approval-required',interactionMode:'default',workspaceStrategy:{type:'root'},initialMessage:{text:`Integration check. Reply with exactly ${nonce} and nothing else. Do not call tools, delegate, run commands, inspect files or modify anything.`,attachments:[]}});
  const path=`/api/orchestration/threads/${encodeURIComponent(launched.threadId)}`;
  let completed=false;
  const deadline=Date.now()+config.turnTimeoutMs;
  while(Date.now()<deadline){
    const {projection}=await http(path);
    if(projection.runtimeRequests?.some(request=>request.status==='pending'))throw new Error('Live smoke requested tool approval; no tool execution was approved.');
    const run=projection.runs?.at(-1);
    if(['failed','cancelled','interrupted'].includes(run?.status))throw new Error(`Imported Codex run ended ${run.status}.`);
    if(run?.status==='completed'&&projection.messages?.some(message=>message.role==='assistant'&&message.text?.trim()===nonce)){completed=true;break;}
    await delay(config.pollIntervalMs);
  }
  assert.ok(completed,'Live Codex adapter did not persist the expected completed assistant response.');
  await stop();await start();
  const persisted=await http(path);
  assert.ok(persisted.projection.messages.some(message=>message.role==='assistant'&&message.text.trim()===nonce),'Expected assistant output did not survive isolated runtime restart.');
  assert.equal(fingerprint(await readFile(sourceAuth)),sourceFingerprint,'Source Codex authentication file changed during isolated smoke.');
  console.log('Imported Codex harness smoke passed: real app-server turn, exact persisted assistant response, runtime restart, and unchanged source auth file.');
} catch(error){console.error(error.message);process.exitCode=1;}
finally {for(const waiting of pending.values())clearTimeout(waiting.timer);pending.clear();await stop();await rm(base,{recursive:true,force:true});}
