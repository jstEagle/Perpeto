import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { jobEnvironment, jobSandbox } from './sandbox.js';
import { StringDecoder } from 'node:string_decoder';
import { readSecret } from './config.js';
import { runProcess } from './process.js';
import { insideCheckout, resolveKey } from './ci-cache.js';
import { collectArtifacts } from './artifacts.js';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
// The runner owns these; pipeline env cannot redirect a step's PATH, HOME or temp directories.
const RESERVED_ENV = /^(?:PATH|HOME|TMPDIR|TMP|TEMP|LANG|LC_ALL|GIT_CONFIG_.*|GIT_TERMINAL_PROMPT|PERPETO_.*)$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Pipeline fields of a job (env, cache, collect, timeoutSec), validated before anything runs. */
function pipelineFields(job) {
  if (job.env !== undefined && (!plain(job.env) || Object.entries(job.env).some(([name, value]) => !ENV_NAME.test(name) || RESERVED_ENV.test(name) ||
      typeof value !== 'string' || value.includes('\0') || value.length > 4096))) return false;
  if (job.cache !== undefined && (!Array.isArray(job.cache) || job.cache.length > 4 || job.cache.some(item => !plain(item) || typeof item.key !== 'string' ||
      !Array.isArray(item.paths) || !item.paths.length || !item.paths.every(insideCheckout)))) return false;
  if (job.collect !== undefined && (!Array.isArray(job.collect) || job.collect.length > 8 || job.collect.some(item => !plain(item) || typeof item.name !== 'string' ||
      /[/\\]/.test(item.name) || !Array.isArray(item.paths) || !item.paths.length || !item.paths.every(insideCheckout)))) return false;
  return job.timeoutSec === undefined || (Number.isSafeInteger(job.timeoutSec) && job.timeoutSec > 0 && job.timeoutSec <= 86400);
}

/** Lines are held until redaction is safe. Oversized lines are masked in full. */
export function createLogStream({ report, step, stream, literals = [], patterns = [], maxBytes = 8192, flushMs = 100 }) {
  const decoder = new StringDecoder('utf8');
  const regexes = patterns.map(pattern => new RegExp(pattern, 'g'));
  let pending = '';
  let dropping = false;
  let batch = '';
  let batchBytes = 0;
  let timer;
  let delivery = Promise.resolve();
  let failure;
  async function flush() {
    clearTimeout(timer); timer = undefined;
    if (!batch) { await delivery; if (failure) throw failure; return; }
    const chunk = batch;
    batch = ''; batchBytes = 0;
    const sending = delivery.then(() => {
      if (failure) throw failure;
      return report({ type: 'log', data: { step, stream, chunk } });
    });
    // Keep timer-triggered rejections observed, then propagate on the next write/end.
    delivery = sending.catch(error => { failure ??= error; });
    await sending;
  }
  async function emit(text) {
    for (const secret of literals.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
    for (const regex of regexes) text = text.replace(regex, '[REDACTED]');
    // Pack redacted lines into requests without splitting UTF-8 code points.
    for (const char of text) {
      const size = Buffer.byteLength(char);
      if (batchBytes + size > maxBytes) await flush();
      batch += char; batchBytes += size;
      timer ??= setTimeout(() => { void flush().catch(() => {}); }, flushMs);
    }
  }
  async function consume(text) {
    // Input is bounded by the child's pipe high-water mark, retained state by maxBytes.
    for (const part of text.split(/(?<=\n)/)) {
      if (!part) continue;
      const end = part.endsWith('\n');
      if (!dropping) {
        if (Buffer.byteLength(pending) + Buffer.byteLength(part) > maxBytes) {
          pending = ''; dropping = true;
          await emit('[REDACTED oversized log line]\n');
        } else pending += part;
      }
      if (end) {
        if (!dropping) await emit(pending);
        pending = ''; dropping = false;
      }
    }
  }
  return {
    async write(chunk) { await delivery; if (failure) throw failure; await consume(decoder.write(chunk)); },
    async end() {
      try {
        await delivery; if (failure) throw failure;
        await consume(decoder.end()); if (pending && !dropping) await emit(pending); pending = '';
        await flush();
      } finally { clearTimeout(timer); }
    },
  };
}

export async function loadRedaction(config) {
  const patterns = config.jobs?.redactPatterns ?? [];
  let literals = [];
  if (config.jobs?.redactionFile) {
    const secret = JSON.parse(await readSecret(resolve(config.configRoot, config.jobs.redactionFile)));
    literals = secret.literals ?? [];
  }
  if (!Array.isArray(literals) || literals.some(item => typeof item !== 'string' || item.includes('\n') || item.includes('\r')) ||
      !Array.isArray(patterns) || patterns.some(item => typeof item !== 'string')) throw new Error('Invalid log redaction settings.');
  // Fail on invalid expressions before a job starts emitting output.
  patterns.forEach(pattern => new RegExp(pattern, 'g'));
  return { literals, patterns };
}

/** CI workspaces of jobs running in this process; the storage janitor never touches them. */
export const activeJobWorkspaces = new Set();

export async function runJob(job, ctx, options = {}) {
  const { dataDir, maxLogChunkBytes = 8192, defaultTimeoutSec = 600, checkoutTimeoutSec = 120, redaction = {}, cache, artifactMaxBytes } = options;
  const evidence = { revision: job.revision, configHash: job.configHash, steps: [], artifacts: [] };
  const deadline = job.timeoutSec ? Date.now() + job.timeoutSec * 1000 : Infinity;
  let workspace;
  try {
    if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(job.revision) || typeof job.configHash !== 'string' || !job.configHash ||
        !Array.isArray(job.steps) || job.steps.some(step => !step || typeof step.name !== 'string' || typeof step.run !== 'string' ||
          (step.timeoutSec !== undefined && (!Number.isFinite(step.timeoutSec) || step.timeoutSec <= 0))) || !pipelineFields(job)) throw new Error('Invalid job.');
    // A hub source names the job's own authenticated route; otherwise the job names a repository to clone.
    const source = job.source;
    if (source !== undefined && !(source?.kind === 'hub-bundle' && typeof source.path === 'string' && /^\/jobs\/[A-Za-z0-9_-]+\/bundle$/.test(source.path) && ctx.fetchSource)) throw new Error('Invalid job source.');
    const repo = source ? null : typeof job.repo === 'string' ? job.repo : job.repo?.url ?? job.repo?.localPath;
    if (!source && (typeof repo !== 'string' || !repo || repo.startsWith('-') || repo.includes('\0'))) throw new Error('Invalid job repository.');
    if (repo?.includes('://')) {
      const url = new URL(repo);
      if (url.password || url.search || url.hash || (url.username && url.protocol !== 'ssh:')) throw new Error('Repository credentials must use local credential helpers.');
    }
    workspace = await mkdtemp(join(tmpdir(), 'perpeto-ci-'));
    activeJobWorkspaces.add(workspace);
    const checkout = join(workspace, 'source');
    const sandbox = await jobSandbox(workspace, [dataDir, process.env.GIT_CONFIG_GLOBAL, ...(options.protectedPaths ?? [])]);
    // Pipeline env (non-secret, from the repository's ci.json) and runner-set CI variables come after the sandbox
    // defaults, which pipeline env cannot override.
    const stepEnv = { CI: 'true', ...(job.env ?? {}), ...jobEnvironment(workspace, options.path), PERPETO_CI: '1', PERPETO_JOB_ID: job.id ?? '', PERPETO_REVISION: job.revision,
      ...(job.pipelineJob ? { PERPETO_PIPELINE_JOB: job.pipelineJob } : {}) };
    // Checkout is a trusted daemon operation. Preserve its configured remote rewrites,
    // but never expose the config path/content to untrusted shell steps.
    const gitEnv = { ...stepEnv, ...(process.env.GIT_CONFIG_GLOBAL ? { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL } : {}) };
    const git = async args => {
      let output = '';
      const result = await runProcess('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd: workspace, env: gitEnv, signal: ctx.signal, timeoutMs: checkoutTimeoutSec * 1000,
        onOutput: (stream, chunk) => { if (stream === 'stdout') output += chunk; },
      });
      if (result.code !== 0 || result.cancelled || result.timedOut) throw new Error('Git checkout failed.');
      return output.trim();
    };
    if (source) {
      // Fetch the hub's bundle into this job's workspace only; no hub path is ever addressed.
      const bundle = join(workspace, 'source.bundle');
      await ctx.fetchSource(source.path, bundle);
      await git(['init', '--quiet', checkout]);
      await git(['-C', checkout, 'fetch', '--quiet', '--no-tags', bundle, '+refs/*:refs/hub/*']);
      await rm(bundle, { force: true });
    } else await git(['clone', '--no-checkout', '--no-hardlinks', '--', repo, checkout]);
    await git(['-C', checkout, 'checkout', '--quiet', '--detach', job.revision, '--']);
    // Object ids are content hashes, so checking out the exact SHA and reading it back proves the tree is the job's.
    if (await git(['-C', checkout, 'rev-parse', 'HEAD']) !== job.revision.toLowerCase()) throw new Error('Checked-out revision does not match the job.');
    await ctx.report({ type: 'started', data: { revision: job.revision, configHash: job.configHash } });
    const note = text => ctx.report({ type: 'log', data: { step: -1, stream: 'runner', chunk: `[perpeto] ${text}\n` } });
    // Dependency caches: restored before the steps, saved after a passing run that missed. Keys are per project.
    const caches = [];
    for (const item of job.cache ?? []) {
      if (!cache) { await note(`cache ${item.key}: this machine has no CI cache`); continue; }
      let key;
      try { key = await resolveKey(item.key, checkout); } catch (error) { await note(`cache ${item.key}: ${error.message}`); continue; }
      const hit = await cache.restore(job.projectId ?? 'default', key, item.paths, checkout);
      caches.push({ key, hit, paths: item.paths });
      await note(`cache ${hit ? 'hit' : 'miss'}: ${key}`);
    }
    evidence.cache = caches.map(({ key, hit }) => ({ key, hit }));
    let status = 'passed';
    for (const [index, step] of job.steps.entries()) {
      ctx.signal.throwIfAborted();
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) { await note(`job timed out after ${job.timeoutSec}s`); status = 'error'; evidence.reason = 'job_timeout'; break; }
      const startedAt = new Date().toISOString();
      const logs = Object.fromEntries(['stdout', 'stderr'].map(stream => [stream,
        createLogStream({ ...redaction, report: ctx.report, step: index, stream, maxBytes: maxLogChunkBytes })]));
      let result;
      try {
        result = await runProcess(sandbox.command, [...sandbox.args, '-c', step.run], {
          cwd: checkout, env: stepEnv, signal: ctx.signal, timeoutMs: Math.min((step.timeoutSec ?? defaultTimeoutSec) * 1000, remainingMs),
          onOutput: (stream, chunk) => logs[stream].write(chunk),
        });
      } finally {
        await Promise.all(Object.values(logs).map(log => log.end()));
      }
      const stepStatus = result.cancelled ? 'cancelled' : result.timedOut ? 'error' : result.code === 0 ? 'passed' : 'failed';
      const item = { index, name: step.name, status: stepStatus, exitCode: result.code, timedOut: result.timedOut, startedAt, finishedAt: new Date().toISOString() };
      evidence.steps.push(item);
      await ctx.report({ type: 'step', data: { ...item, revision: job.revision, configHash: job.configHash } });
      if (item.status !== 'passed') { status = item.status; break; }
    }
    ctx.signal.throwIfAborted();
    if (status !== 'cancelled' && job.collect?.length) {
      const { uploaded, notes } = await collectArtifacts(job.collect, { checkout, status, report: ctx.report, maxBytes: artifactMaxBytes, signal: ctx.signal });
      evidence.artifacts = uploaded;
      for (const text of notes) await note(text);
    }
    if (status === 'passed') for (const item of caches.filter(entry => !entry.hit)) {
      const saved = await cache.save(job.projectId ?? 'default', item.key, item.paths, checkout).catch(error => ({ saved: false, reason: error.code ?? 'error' }));
      await note(saved.saved ? `cache saved: ${item.key} (${saved.sizeBytes} bytes)` : `cache not saved: ${item.key} (${saved.reason})`);
    }
    ctx.signal.throwIfAborted();
    return { ...evidence, status };
  } catch (error) {
    if (error?.code === 'lease_lost' || ctx.signal.reason?.code === 'lease_lost') throw error;
    return { ...evidence, status: ctx.signal.aborted ? 'cancelled' : 'error', reason: ctx.signal.aborted ? 'cancelled' : 'job_execution_error' };
  } finally {
    if (workspace) { await rm(workspace, { recursive: true, force: true }); activeJobWorkspaces.delete(workspace); }
  }
}
