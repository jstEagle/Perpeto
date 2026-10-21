import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { jobEnvironment, jobSandbox } from './sandbox.js';
import { StringDecoder } from 'node:string_decoder';
import { readSecret } from './config.js';
import { runProcess } from './process.js';

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

export async function runJob(job, ctx, options = {}) {
  const { dataDir, maxLogChunkBytes = 8192, defaultTimeoutSec = 600, checkoutTimeoutSec = 120, redaction = {} } = options;
  const evidence = { revision: job.revision, configHash: job.configHash, steps: [], artifacts: [] };
  let workspace;
  try {
    if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(job.revision) || typeof job.configHash !== 'string' || !job.configHash ||
        !Array.isArray(job.steps) || job.steps.some(step => !step || typeof step.name !== 'string' || typeof step.run !== 'string' ||
          (step.timeoutSec !== undefined && (!Number.isFinite(step.timeoutSec) || step.timeoutSec <= 0)))) throw new Error('Invalid job.');
    const repo = typeof job.repo === 'string' ? job.repo : job.repo?.url ?? job.repo?.localPath;
    if (typeof repo !== 'string' || !repo || repo.startsWith('-') || repo.includes('\0')) throw new Error('Invalid job repository.');
    if (repo.includes('://')) {
      const url = new URL(repo);
      if (url.password || url.search || url.hash || (url.username && url.protocol !== 'ssh:')) throw new Error('Repository credentials must use local credential helpers.');
    }
    workspace = await mkdtemp(join(tmpdir(), 'perpeto-ci-'));
    const checkout = join(workspace, 'source');
    const sandbox = await jobSandbox(workspace, [dataDir, process.env.GIT_CONFIG_GLOBAL, ...(options.protectedPaths ?? [])]);
    const stepEnv = jobEnvironment(workspace, options.path);
    // Checkout is a trusted daemon operation. Preserve its configured remote rewrites,
    // but never expose the config path/content to untrusted shell steps.
    const gitEnv = { ...stepEnv, ...(process.env.GIT_CONFIG_GLOBAL ? { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL } : {}) };
    const git = async args => {
      const result = await runProcess('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd: workspace, env: gitEnv, signal: ctx.signal, timeoutMs: checkoutTimeoutSec * 1000,
      });
      if (result.code !== 0 || result.cancelled || result.timedOut) throw new Error('Git checkout failed.');
    };
    await git(['clone', '--no-checkout', '--no-hardlinks', '--', repo, checkout]);
    await git(['-C', checkout, 'checkout', '--detach', job.revision, '--']);
    await ctx.report({ type: 'started', data: { revision: job.revision, configHash: job.configHash } });
    for (const [index, step] of job.steps.entries()) {
      ctx.signal.throwIfAborted();
      const startedAt = new Date().toISOString();
      const logs = Object.fromEntries(['stdout', 'stderr'].map(stream => [stream,
        createLogStream({ ...redaction, report: ctx.report, step: index, stream, maxBytes: maxLogChunkBytes })]));
      let result;
      try {
        result = await runProcess(sandbox.command, [...sandbox.args, '-c', step.run], {
          cwd: checkout, env: stepEnv, signal: ctx.signal, timeoutMs: (step.timeoutSec ?? defaultTimeoutSec) * 1000,
          onOutput: (stream, chunk) => logs[stream].write(chunk),
        });
      } finally {
        await Promise.all(Object.values(logs).map(log => log.end()));
      }
      const status = result.cancelled ? 'cancelled' : result.timedOut ? 'error' : result.code === 0 ? 'passed' : 'failed';
      const item = { index, name: step.name, status, exitCode: result.code, timedOut: result.timedOut, startedAt, finishedAt: new Date().toISOString() };
      evidence.steps.push(item);
      await ctx.report({ type: 'step', data: { ...item, revision: job.revision, configHash: job.configHash } });
      if (status !== 'passed') return { ...evidence, status };
    }
    ctx.signal.throwIfAborted();
    return { ...evidence, status: 'passed' };
  } catch (error) {
    if (error?.code === 'lease_lost' || ctx.signal.reason?.code === 'lease_lost') throw error;
    return { ...evidence, status: ctx.signal.aborted ? 'cancelled' : 'error', reason: ctx.signal.aborted ? 'cancelled' : 'job_execution_error' };
  } finally {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  }
}
