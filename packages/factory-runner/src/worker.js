import { readFileSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, realpathSync } from 'node:fs';
import { resolve, dirname, isAbsolute, relative, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import configuration from '../config/limits.json' with { type: 'json' };

const limits = configuration.worker;
const queueLimits = configuration.queue;

function invalid(message) { throw new Error(message); }
export function loadRunnerConfig(filename) {
  const raw = JSON.parse(readFileSync(filename, 'utf8'));
  const allowed = ['baseUrl','credentialFile','runnerId','labels','repositories','executables','workDirectory','timeoutMs','maxOutputBytes','leaseMs','artifactPaths','toolPath','allowInsecureHttp'];
  if (!raw || typeof raw !== 'object' || Object.keys(raw).some(key => !allowed.includes(key))) invalid('Invalid runner configuration fields.');
  for (const field of ['baseUrl','credentialFile','runnerId','workDirectory','toolPath']) if (typeof raw[field] !== 'string' || !raw[field].trim()) invalid(`Invalid ${field}.`);
  const url = new URL(raw.baseUrl);
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.protocol === 'http:' && !['127.0.0.1','localhost','[::1]'].includes(url.hostname) && raw.allowInsecureHttp !== true)) invalid('Runner requires HTTPS, loopback HTTP, or explicit allowInsecureHttp.');
  if (!Array.isArray(raw.labels) || raw.labels.length > queueLimits.maxLabels || raw.labels.some(value => typeof value !== 'string' || !value.trim())) invalid('Invalid capability labels.');
  for (const field of ['repositories','executables']) {
    if (!raw[field] || typeof raw[field] !== 'object' || Array.isArray(raw[field]) || !Object.keys(raw[field]).length) invalid(`Invalid ${field}.`);
    for (const [name,path] of Object.entries(raw[field])) if (!/^[a-zA-Z0-9_.-]+$/.test(name) || typeof path !== 'string' || !isAbsolute(path)) invalid(`${field} must map names to absolute local paths.`);
  }
  for (const [field,[min,max]] of Object.entries(limits.validationRanges)) if (!Number.isSafeInteger(raw[field]) || raw[field] < min || raw[field] > max) invalid(`Invalid ${field}.`);
  const artifactPaths = raw.artifactPaths ?? [];
  if (!Array.isArray(artifactPaths) || artifactPaths.length > queueLimits.maxArtifacts || artifactPaths.some(path => typeof path !== 'string' || !path || path.length > queueLimits.maxArtifactPathCharacters || isAbsolute(path) || path.split(/[\\/]/).includes('..'))) invalid('artifactPaths must stay within the checkout.');
  return { ...raw, baseUrl: raw.baseUrl.replace(/\/+$/, ''), artifactPaths, credentialFile: resolve(dirname(resolve(filename)), raw.credentialFile), workDirectory: resolve(dirname(resolve(filename)), raw.workDirectory) };
}
export function createRunnerClient(config) {
  const stat = lstatSync(config.credentialFile);
  if (!stat.isFile() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) invalid('Runner credential must be an owner-only regular file.');
  const token = readFileSync(config.credentialFile, 'utf8').trim();
  if (!token || /[\r\n]/.test(token)) invalid('Runner credential must contain one token.');
  return async (path, body, method = 'POST', timeoutMs = limits.requestTimeoutMs) => {
    const response = await fetch(`${config.baseUrl}/api/perpeto/runner${path}`, { method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(Math.max(1,Math.floor(Math.min(limits.requestTimeoutMs,timeoutMs)))), ...(body === undefined ? {} : {body:JSON.stringify(body)}) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Runner request rejected (HTTP ${response.status}).`); }
    return response.json();
  };
}
export async function executeJob(config, job, signal) {
  if (process.platform === 'win32') invalid('This initial runner supports macOS and Linux process-group cleanup.');
  const source = config.repositories[job.repositoryId];
  const executable = config.executables[job.command[0]];
  if (!source || !executable) invalid('Job repository or executable is not allowed by this runner.');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(job.revision)) invalid('Job revision is not a full commit SHA.');
  mkdirSync(config.workDirectory, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(config.workDirectory, 'job-'));
  const checkout = join(directory, 'checkout');
  const home = join(directory, 'home'), temporary = join(directory, 'tmp');
  mkdirSync(home); mkdirSync(temporary);
  // Deliberately omit the parent's environment and credentials from CI commands.
  const env = { PATH: config.toolPath, HOME: home, TMPDIR: temporary, ...limits.environment };
  const chunks = []; let outputSize = 0, logsTruncated = false, timedOut = false;
  const deadline = Date.now() + config.timeoutMs;
  const run = (command, args, cwd, capture = false) => new Promise((resolveRun, reject) => {
    if (signal?.aborted) return reject(new Error('Runner lease is no longer confirmed.'));
    const remaining = deadline - Date.now();
    if (remaining <= 0) { timedOut = true; return resolveRun({ exitCode:null, output:'' }); }
    let child;
    try { child = spawn(command, args, { cwd, env, shell:false, detached:true, stdio:['ignore','pipe','pipe'] }); }
    catch (error) { return reject(error); }
    const captured = []; let capturedSize = 0;
    const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
    const timer = setTimeout(() => { timedOut = true; stop(); }, remaining);
    signal?.addEventListener('abort', stop, { once:true });
    const collect = data => {
      if (capture && capturedSize < limits.revisionCaptureBytes) { captured.push(data.subarray(0,limits.revisionCaptureBytes-capturedSize)); capturedSize += data.length; }
      const keep = Math.max(0, config.maxOutputBytes - outputSize);
      if (data.length > keep) logsTruncated = true;
      if (keep) { const chunk = data.subarray(0,keep); chunks.push(chunk); outputSize += chunk.length; }
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', error => { clearTimeout(timer); signal?.removeEventListener('abort',stop); reject(error); });
    child.once('close', code => { stop(); clearTimeout(timer); signal?.removeEventListener('abort',stop); resolveRun({exitCode:code,output:Buffer.concat(captured).toString('utf8')}); });
  });
  try {
    const git = (args, cwd = directory, capture = false) => run(limits.gitExecutable, ['-c',`core.hooksPath=${limits.gitHooksPath}`,...args], cwd, capture);
    const cloned = await git(['clone','--no-hardlinks','--no-checkout','--',source,checkout]);
    let result = cloned;
    if (result.exitCode === 0) result = await git(['checkout','--detach',job.revision], checkout);
    if (result.exitCode === 0) {
      result = await git(['rev-parse','HEAD'], checkout, true);
      if (result.output.trim() !== job.revision) invalid('Checked-out revision differs from the submitted commit.');
    }
    if (result.exitCode === 0) result = await run(executable, job.command.slice(1), checkout);
    const artifacts = [];
    if (result.exitCode === 0) for (const artifact of config.artifactPaths) {
      try {
        const path = realpathSync(join(checkout,artifact));
        const location = relative(realpathSync(checkout),path);
        if (location === '..' || location.startsWith('../') || isAbsolute(location)) continue;
        const file = statSync(path);
        if (file.isFile()) artifacts.push({path:artifact,size:file.size});
      } catch { /* Missing artifacts are omitted. */ }
    }
    return { exitCode:result.exitCode, timedOut, logsTruncated, log:Buffer.concat(chunks).toString('utf8'), artifacts };
  } finally { rmSync(directory, {recursive:true,force:true}); }
}
/** Reserve headroom under the 512 KiB HTTP envelope even for escaped control output. */
export function boundResult(result) {
  const cap = limits.maxCompletionBytes;
  if (Buffer.byteLength(JSON.stringify(result)) <= cap) return result;
  const original = result.log;
  result = {...result,log:'',logsTruncated:true};
  let low = 0, high = original.length;
  while (low < high) {
    const mid = Math.ceil((low+high)/2);
    if (Buffer.byteLength(JSON.stringify({...result,log:original.slice(0,mid)})) <= cap) low = mid;
    else high = mid-1;
  }
  return {...result,log:original.slice(0,low)};
}
export async function runOnce(config) {
  const request = createRunnerClient(config);
  const claimStarted = performance.now();
  const claimed = await request('/claim', { runnerId:config.runnerId, labels:config.labels, repositoryIds:Object.keys(config.repositories), leaseMs:config.leaseMs });
  if (!claimed) return { claimed:false };
  const controller = new AbortController();
  let confirmedDeadline = claimStarted + config.leaseMs;
  let watchdog;
  const armWatchdog = () => {
    clearTimeout(watchdog);
    const remaining = confirmedDeadline-performance.now()-limits.leaseSafetyMarginMs;
    if (remaining <= 0) controller.abort();
    else watchdog = setTimeout(()=>controller.abort(),remaining);
  };
  armWatchdog();
  let heartbeatInFlight;
  const timer = setInterval(() => {
    if (heartbeatInFlight || controller.signal.aborted) return;
    const started = performance.now();
    const remaining = confirmedDeadline-started-limits.leaseSafetyMarginMs;
    if (remaining <= 0) { controller.abort(); return; }
    heartbeatInFlight = (async()=>{
      try {
        await request(`/jobs/${claimed.job.id}/heartbeat`, {runnerId:config.runnerId,leaseToken:claimed.leaseToken,leaseMs:config.leaseMs},'POST',Math.min(config.leaseMs/limits.heartbeatDivisor,remaining));
        if (!controller.signal.aborted) {confirmedDeadline=started+config.leaseMs;armWatchdog();}
      } catch { controller.abort(); }
      finally {heartbeatInFlight=undefined;}
    })();
  }, Math.floor(config.leaseMs / limits.heartbeatDivisor));
  try {
    let result;
    try { result = await executeJob(config, claimed.job, controller.signal); }
    catch (error) { result = {exitCode:null,timedOut:false,logsTruncated:false,log:error.message,artifacts:[]}; }
    clearInterval(timer);
    if (heartbeatInFlight) await heartbeatInFlight;
    if (controller.signal.aborted || performance.now() >= confirmedDeadline-limits.leaseSafetyMarginMs) throw new Error('Lease confirmation failed; command stopped. Completion withheld; explicit retry may be needed.');
    const job = await request(`/jobs/${claimed.job.id}/complete`, {runnerId:config.runnerId,leaseToken:claimed.leaseToken,result:boundResult(result)},'POST',confirmedDeadline-performance.now()-limits.leaseSafetyMarginMs);
    return { claimed:true, job };
  } finally {clearInterval(timer);clearTimeout(watchdog);}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configIndex = process.argv.indexOf('--config');
  try {
    if (!['once','submit','get','retry'].includes(process.argv[2]) || configIndex < 0 || !process.argv[configIndex+1]) invalid('Usage: node worker.js once|submit|get|retry --config runner.json [--job job.json|--id JOB_ID]');
    const config = loadRunnerConfig(process.argv[configIndex+1]);
    const request = createRunnerClient(config);
    let outcome;
    if (process.argv[2] === 'once') outcome = await runOnce(config);
    else if (process.argv[2] === 'submit') {
      const jobIndex = process.argv.indexOf('--job');
      if (jobIndex < 0 || !process.argv[jobIndex+1]) invalid('submit requires --job job.json');
      outcome = await request('/jobs',JSON.parse(readFileSync(process.argv[jobIndex+1],'utf8')));
    } else {
      const idIndex = process.argv.indexOf('--id');
      if (idIndex < 0 || !/^[a-f0-9-]+$/.test(process.argv[idIndex+1] ?? '')) invalid('get/retry require --id JOB_ID');
      const route = `/jobs/${process.argv[idIndex+1]}`;
      outcome = process.argv[2] === 'get' ? await request(route,undefined,'GET') : await request(`${route}/retry`,{});
    }
    process.stdout.write(JSON.stringify(outcome)+'\n');
    if (outcome.claimed && outcome.job.status !== 'succeeded') process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
