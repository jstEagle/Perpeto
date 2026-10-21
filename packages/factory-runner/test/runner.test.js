import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { RunnerQueue } from '../src/queue.js';
import { executeJob, loadRunnerConfig, runOnce, boundResult } from '../src/worker.js';

const worker = fileURLToPath(new URL('../src/worker.js',import.meta.url));
const revision = 'a'.repeat(40);
const input = {projectId:'factory',repositoryId:'app',revision,command:['node','test.js'],requiredLabels:['linux'],idempotencyKey:'first'};
const success = {exitCode:0,timedOut:false,logsTruncated:false,log:'pass',artifacts:[]};
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(),'perpeto-runner-'));
  const stores=[];
  t.after(()=>{for(const store of stores)try{store.close();}catch{} rmSync(directory,{recursive:true,force:true});});
  const open = options => {const q=new RunnerQueue(join(directory,'runner.sqlite'),options);stores.push(q);return q;};
  return {directory,open};
}
test('durable submit, deduplication and atomic exclusive claim across connections',t=>{
  const {open}=fixture(t);const q=open(),peer=open();
  const submitted=q.submit(input);assert.equal(peer.submit(input).duplicate,true);
  assert.throws(()=>q.submit({...input,command:['node','other.js']}),e=>e.code==='CONFLICT');
  assert.equal(q.claim({runnerId:'wrong',repositoryIds:['app'],labels:[]}),null);
  assert.equal(q.claim({runnerId:'wrong',repositoryIds:['other'],labels:['linux']}),null);
  const claim=q.claim({runnerId:'one',repositoryIds:['app'],labels:['linux']});
  assert.equal(claim.job.id,submitted.job.id);
  assert.equal(peer.claim({runnerId:'two',repositoryIds:['app'],labels:['linux']}),null);
  assert.ok(!('leaseToken' in peer.get(submitted.job.id)));
  q.close();assert.equal(open().get(submitted.job.id).status,'leased');
});
test('expired jobs become lost until explicit retry and stale completions are fenced',t=>{
  const {open}=fixture(t);let now=1000;const q=open({now:()=>now});
  const {job}=q.submit(input);
  const first=q.claim({runnerId:'one',repositoryIds:['app'],labels:['linux'],leaseMs:1000});
  now=1900;q.heartbeat({id:job.id,runnerId:'one',leaseToken:first.leaseToken,leaseMs:1000});
  now=2800;assert.equal(q.get(job.id).status,'leased');
  now=2900;assert.equal(q.get(job.id).status,'lost');
  assert.equal(q.claim({runnerId:'two',repositoryIds:['app'],labels:['linux']}),null);
  q.retry(job.id);const second=q.claim({runnerId:'two',repositoryIds:['app'],labels:['linux']});
  assert.notEqual(first.leaseToken,second.leaseToken);assert.equal(second.job.attempt,2);
  assert.throws(()=>q.complete({id:job.id,runnerId:'one',leaseToken:first.leaseToken,result:success}),e=>e.code==='STALE_LEASE');
  assert.throws(()=>q.heartbeat({id:job.id,runnerId:'one',leaseToken:first.leaseToken}),e=>e.code==='STALE_LEASE');
  assert.equal(q.complete({id:job.id,runnerId:'two',leaseToken:second.leaseToken,result:success}).status,'succeeded');
  assert.throws(()=>q.retry(job.id),e=>e.code==='CONFLICT');
});
function repository(directory) {
  const source=join(directory,'source');mkdirSync(source);
  const git=args=>execFileSync('git',['-c','user.name=Runner Test','-c','user.email=runner@example.invalid',...args],{cwd:source,stdio:['ignore','pipe','pipe']}).toString().trim();
  git(['init']);writeFileSync(join(source,'value.txt'),'pinned');
  writeFileSync(join(source,'test.js'), `const fs=require('node:fs');if(fs.readFileSync('value.txt','utf8')!=='pinned')process.exit(2);if(process.env.PERPETO_RUNNER_TEST_SECRET)process.exit(3);fs.writeFileSync('value.txt','changed in checkout');fs.writeFileSync('report.txt','ok');console.log('verified pinned checkout');process.stdout.write('\\0'.repeat(262144));setTimeout(()=>console.log('heartbeat completed'),1200);`);
  git(['add','.']);git(['commit','-m','fixture']);const sha=git(['rev-parse','HEAD']);
  writeFileSync(join(source,'value.txt'),'dirty source stays unchanged');
  return {source,sha};
}
test('one-shot runner subprocess claims over HTTP and executes only isolated pinned checkout',async t=>{
  const {directory,open}=fixture(t),queue=open();const {source,sha}=repository(directory);
  const {job}=queue.submit({...input,revision:sha,requiredLabels:[]});
  const token='temporary-test-token';const credential=join(directory,'credential');writeFileSync(credential,token,{mode:0o600});
  let heartbeats=0;
  const server=createServer(async(req,res)=>{
    try {
      if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(401).end();return;}
      let text='';for await(const chunk of req)text+=chunk;
      if(Buffer.byteLength(text)>512*1024){res.writeHead(413).end();return;}
      const body=JSON.parse(text);let response;
      if(req.url.endsWith('/claim'))response=queue.claim(body);
      else if(req.url.endsWith('/heartbeat')){heartbeats++;response=queue.heartbeat({...body,id:job.id});}
      else response=queue.complete({...body,id:job.id});
      res.setHeader('content-type','application/json');res.end(JSON.stringify(response));
    }catch(error){res.writeHead(409).end(JSON.stringify({error:{message:error.message}}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const configFile=join(directory,'runner.json');
  writeFileSync(configFile,JSON.stringify({baseUrl:`http://127.0.0.1:${server.address().port}`,credentialFile:credential,runnerId:'owner-machine',labels:[],repositories:{app:source},executables:{node:process.execPath},workDirectory:join(directory,'work'),timeoutMs:10000,maxOutputBytes:262144,leaseMs:3000,artifactPaths:['report.txt'],toolPath:process.env.PATH}));
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[worker,'once','--config',configFile],{env:{...process.env,PERPETO_RUNNER_TEST_SECRET:'must-not-reach-test'},stdio:['ignore','pipe','pipe']});
    let output='',error='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>error+=data);child.on('error',reject);child.on('close',code=>resolve({code,output,error}));
  });
  assert.equal(result.code,0,result.error);const completed=queue.get(job.id);
  assert.equal(completed.status,'succeeded');assert.equal(completed.revision,sha);assert.ok(heartbeats>=1);
  assert.match(completed.result.log,/verified pinned checkout/);assert.deepEqual(completed.result.artifacts,[{path:'report.txt',size:2}]);
  assert.equal(readFileSync(join(source,'value.txt'),'utf8'),'dirty source stays unchanged');
  queue.close();assert.equal(open().get(job.id).status,'succeeded');
});
test('runner timeout and output limit are enforced and configuration rejects inline tokens',async t=>{
  const {directory}=fixture(t);const {source,sha}=repository(directory);
  const config={repositories:{app:source},executables:{node:process.execPath},workDirectory:join(directory,'work'),toolPath:process.env.PATH,timeoutMs:2000,maxOutputBytes:1000,artifactPaths:[]};
  const noisy=await executeJob(config,{...input,revision:sha,command:['node','-e',"console.log('x'.repeat(10000))"]});
  assert.equal(noisy.exitCode,0);assert.equal(noisy.logsTruncated,true);assert.ok(Buffer.byteLength(noisy.log)<=1000);
  const timeout=await executeJob({...config,timeoutMs:300},{...input,revision:sha,command:['node','-e','setInterval(()=>{},100)']});
  assert.equal(timeout.timedOut,true);assert.notEqual(timeout.exitCode,0);
  const file=join(directory,'bad.json');writeFileSync(file,JSON.stringify({token:'secret'}));assert.throws(()=>loadRunnerConfig(file),/configuration fields/);
  await assert.rejects(()=>executeJob(config,{...input,revision:sha,command:['sh','-c','echo unsafe']}),/not allowed/);
});

test('simultaneous independent worker processes cannot both claim one queued job',async t=>{
  const {directory,open}=fixture(t);const q=open();q.submit({...input,requiredLabels:[]});
  const moduleUrl=new URL('../src/queue.js',import.meta.url).href;
  const script=`import {RunnerQueue} from ${JSON.stringify(moduleUrl)};const q=new RunnerQueue(process.argv[1]);const result=q.claim({runnerId:process.argv[2],repositoryIds:['app'],labels:[]});console.log(JSON.stringify(result));q.close();`;
  const claim=runner=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',script,join(directory,'runner.sqlite'),runner]);let out='',err='';child.stdout.on('data',data=>out+=data);child.stderr.on('data',data=>err+=data);child.on('error',reject);child.on('close',code=>code===0?resolve(JSON.parse(out)):reject(new Error(err)));});
  const claims=await Promise.all([claim('one'),claim('two')]);assert.equal(claims.filter(Boolean).length,1);
});

for (const childStdio of ['ignore','inherit']) test(`normal command completion kills ${childStdio}-stdio descendants before cleanup`,async t=>{
  const {directory}=fixture(t),{source,sha}=repository(directory);
  const pidFile=join(directory,'grandchild.pid');
  const script=`const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:${JSON.stringify(childStdio)}});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));child.unref();`;
  const result=await executeJob({repositories:{app:source},executables:{node:process.execPath},workDirectory:join(directory,'work'),toolPath:process.env.PATH,timeoutMs:3000,maxOutputBytes:1000,artifactPaths:[]},{...input,revision:sha,command:['node','-e',script]});
  assert.equal(result.exitCode,0);
  assert.equal(result.timedOut,false,'inherited descendant pipes must not defer completion until timeout');
  const pid=Number(readFileSync(pidFile,'utf8'));
  let alive=true;
  for(let i=0;i<20;i++){try{process.kill(pid,0);}catch{alive=false;break;}await new Promise(resolve=>setTimeout(resolve,25));}
  if(alive)try{process.kill(pid,'SIGKILL');}catch{}
  assert.equal(alive,false,'descendant should be terminated after parent exits');
});

test('stalled heartbeat stops execution before its confirmed lease expires',async t=>{
  const {directory,open}=fixture(t),queue=open(),{source,sha}=repository(directory);
  const marker=join(directory,'should-not-exist');
  queue.submit({...input,revision:sha,requiredLabels:[],command:['node','-e',`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'too late'),3500)`]});
  const token='temporary-token',credential=join(directory,'token');writeFileSync(credential,token,{mode:0o600});
  const sockets=new Set();let claimedAt;
  const server=createServer(async(req,res)=>{
    let data='';for await(const chunk of req)data+=chunk;
    const body=JSON.parse(data);
    if(req.url.endsWith('/claim')){claimedAt=Date.now();res.end(JSON.stringify(queue.claim(body)));}
    else if(req.url.endsWith('/heartbeat')){/* Deliberately never confirm the lease. */}
    else {res.writeHead(500).end();}
  });
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{for(const socket of sockets)socket.destroy();server.close();});
  const config={baseUrl:`http://127.0.0.1:${server.address().port}`,credentialFile:credential,runnerId:'owner',labels:[],repositories:{app:source},executables:{node:process.execPath},workDirectory:join(directory,'work'),toolPath:process.env.PATH,timeoutMs:10000,maxOutputBytes:1000,leaseMs:3000,artifactPaths:[]};
  await assert.rejects(()=>runOnce(config),/Lease confirmation failed/);
  assert.ok(Date.now()-claimedAt<3000,'worker must stop before server lease expiry');
  await new Promise(resolve=>setTimeout(resolve,1800));
  assert.throws(()=>readFileSync(marker));
});
