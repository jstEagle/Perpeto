import { readFile, lstat, open, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { storageConfig } from './storage.js';

export async function readSecret(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error('Secret file must be an owner-only regular file.');
  }
  return readFile(path, 'utf8');
}

export async function writePrivate(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally { await file.close(); }
  try {
    await rename(temp, path);
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await unlink(temp).catch(() => {}); }
}

export async function loadConfig(configPath) {
  const root = dirname(resolve(configPath));
  const raw = JSON.parse(await readFile(configPath, 'utf8'));
  const allowed = ['hubUrl', 'name', 'dataDir', 'credentialFile', 'enrollmentCodeFile', 'labels', 'capacity', 'providers',
    'timing', 'fake', 'executorPackages', 'accountProviderPackage', 'accounts', 'runtime', 'jobs', 'allowInsecureHttp', 'tokenRotationMs', 'hubFingerprint', 'observe', 'health', 'runner', 'storage'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !allowed.includes(key))) {
    throw new Error('Invalid node configuration; credentials belong in owner-only files.');
  }
  const url = new URL(raw.hubUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid hubUrl.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && raw.allowInsecureHttp !== true) throw new Error('Remote hubs require HTTPS.');
  // The SHA-256 fingerprint of a self-signed hub certificate, pinned instead of trusting a CA.
  if (raw.hubFingerprint !== undefined && (typeof raw.hubFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(raw.hubFingerprint) || url.protocol !== 'https:')) throw new Error('hubFingerprint must be a lowercase SHA-256 hex fingerprint for an https hubUrl.');
  if (raw.name !== undefined && (typeof raw.name !== 'string' || !raw.name.trim())) throw new Error('Invalid node name.');
  const jobs = raw.jobs ?? {};
  const jobKeys = ['defaultTimeoutSec', 'checkoutTimeoutSec', 'maxLogChunkBytes', 'redactionFile', 'redactPatterns', 'path', 'protectedPaths'];
  if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs) || Object.keys(jobs).some(key => !jobKeys.includes(key))) throw new Error('Invalid jobs configuration.');
  for (const key of ['defaultTimeoutSec', 'checkoutTimeoutSec']) {
    if (jobs[key] !== undefined && (!Number.isFinite(jobs[key]) || jobs[key] <= 0 || jobs[key] > 2147483)) throw new Error(`Invalid jobs.${key}.`);
  }
  if (jobs.maxLogChunkBytes !== undefined && (!Number.isSafeInteger(jobs.maxLogChunkBytes) || jobs.maxLogChunkBytes < 128 || jobs.maxLogChunkBytes > 65536)) throw new Error('Log chunks must be between 128 and 65536 bytes.');
  for (const key of ['path', 'protectedPaths']) {
    if (jobs[key] !== undefined && (!Array.isArray(jobs[key]) || jobs[key].some(value => typeof value !== 'string' || !value || value.includes('\0')))) throw new Error(`Invalid jobs.${key}.`);
  }
  const path = value => resolve(root, value);
  for (const key of ['path', 'protectedPaths']) if (jobs[key]) jobs[key] = jobs[key].map(path);
  const dataDir = path(raw.dataDir ?? '../.perpeto/node');
  const runner = runnerConfig(raw.runner, root, dataDir);
  // Runner pools split CI capacity; without an explicit capacity their sum is this machine's job slots.
  const capacity = raw.capacity ?? { maxAgents: 1, maxJobs: runner.pools ? runner.pools.reduce((sum, pool) => sum + pool.maxJobs, 0) : 1 };
  for (const key of ['maxAgents', 'maxJobs']) {
    if (!Number.isSafeInteger(capacity[key]) || capacity[key] < 0) throw new Error(`Invalid capacity.${key}.`);
  }
  const observe = observeConfig(raw.observe, root);
  // Machine telemetry for health-aware placement: on by default; probes that spawn a process are cached for slowProbeMs.
  if (raw.health !== undefined) {
    const health = raw.health;
    if (!health || typeof health !== 'object' || Array.isArray(health) || Object.keys(health).some(key => !['enabled', 'slowProbeMs', 'warmRepoMs'].includes(key))) throw new Error('Invalid health configuration.');
    if (health.enabled !== undefined && typeof health.enabled !== 'boolean') throw new Error('health.enabled must be a boolean.');
    for (const [key, min, max] of [['slowProbeMs', 1000, 3600000], ['warmRepoMs', 0, 604800000]]) {
      if (health[key] !== undefined && (!Number.isSafeInteger(health[key]) || health[key] < min || health[key] > max)) throw new Error(`Invalid health.${key}.`);
    }
  }
  // The storage janitor runs when the config has a `storage` section (installed nodes get one by default).
  const storage = storageConfig(raw.storage, root);
  // An observe-only node runs no agents and no CI: it only watches the operator's own T3.
  if (!capacity.maxAgents && !capacity.maxJobs && !observe?.enabled) throw new Error('Node capacity must allow some work.');
  for (const key of ['labels', 'providers', 'executorPackages']) {
    if (raw[key] !== undefined && (!Array.isArray(raw[key]) || raw[key].some(value => typeof value !== 'string' || !value.trim()))) throw new Error(`Invalid ${key}.`);
  }
  const tokenRotationMs = raw.tokenRotationMs ?? 86400000;
  if (!Number.isSafeInteger(tokenRotationMs) || tokenRotationMs < 0 || tokenRotationMs > 2147483647) throw new Error('Invalid tokenRotationMs.');
  const timing = { heartbeatMs: 10000, renewMs: 20000, requestMs: 30000, pollIdleMs: 200,
    backoffMinMs: 250, backoffMaxMs: 10000, ...(raw.timing ?? {}) };
  for (const [key, value] of Object.entries(timing)) {
    if (!['heartbeatMs', 'renewMs', 'requestMs', 'pollIdleMs', 'backoffMinMs', 'backoffMaxMs'].includes(key) || !Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new Error('Invalid timing configuration.');
  }
  if (timing.backoffMaxMs < timing.backoffMinMs) throw new Error('Invalid backoff bounds.');
  return { ...raw, hubUrl: url.href.replace(/\/+$/, ''), dataDir, capacity, timing, tokenRotationMs, runner, ...(observe ? { observe } : {}), ...(storage ? { storage } : {}),
    credentialFile: raw.credentialFile ? path(raw.credentialFile) : resolve(dataDir, 'machine.json'),
    enrollmentCodeFile: raw.enrollmentCodeFile ? path(raw.enrollmentCodeFile) : undefined,
    labels: raw.labels ?? [], configRoot: root };
}

const RUNNER_KEYS = ['pools', 'labels', 'cacheDir', 'cacheMaxBytes', 'artifactMaxBytes'];
/**
 * `runner`: this machine's CI runner, separate from agent slots. `pools` name CI capacity with their own concurrency
 * (jobs choose one with runsOn.pool), `labels` are runner-only labels jobs can require, and `cacheDir` is the
 * per-machine dependency cache (default `<dataDir>/ci-cache`, LRU-evicted above `cacheMaxBytes`). Storage cleanup
 * tools find the cache through `ciCacheRoot(config)`.
 */
export function runnerConfig(value, root = process.cwd(), dataDir = resolve(root, '../.perpeto/node')) {
  const input = value ?? {};
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !RUNNER_KEYS.includes(key))) throw new Error('Invalid runner configuration.');
  const result = { labels: [], cacheDir: resolve(root, input.cacheDir ?? resolve(dataDir, 'ci-cache')), cacheMaxBytes: input.cacheMaxBytes ?? 10 * 1024 ** 3,
    artifactMaxBytes: input.artifactMaxBytes ?? 100 * 1024 ** 2 };
  if (input.pools !== undefined) {
    if (!Array.isArray(input.pools) || !input.pools.length || input.pools.length > 16 || input.pools.some(pool => !pool || typeof pool !== 'object' ||
        typeof pool.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(pool.name) || !Number.isSafeInteger(pool.maxJobs) || pool.maxJobs < 0 ||
        Object.keys(pool).some(key => !['name', 'maxJobs'].includes(key)))) throw new Error('runner.pools must list 1 to 16 { name, maxJobs } pools.');
    if (new Set(input.pools.map(pool => pool.name)).size !== input.pools.length) throw new Error('runner.pools names must be distinct.');
    result.pools = input.pools.map(pool => ({ name: pool.name, maxJobs: pool.maxJobs }));
  }
  if (input.labels !== undefined) {
    if (!Array.isArray(input.labels) || input.labels.length > 64 || input.labels.some(label => typeof label !== 'string' || !label.trim())) throw new Error('Invalid runner.labels.');
    result.labels = [...input.labels];
  }
  if (typeof input.cacheDir === 'string' && (!input.cacheDir.trim() || input.cacheDir.includes('\0'))) throw new Error('Invalid runner.cacheDir.');
  for (const key of ['cacheMaxBytes', 'artifactMaxBytes']) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 0) throw new Error(`Invalid runner.${key}.`);
  }
  return result;
}
/** The per-machine CI dependency cache directory ("ci-cache" storage kind). */
export const ciCacheRoot = config => config.runner?.cacheDir ?? resolve(config.dataDir, 'ci-cache');

const OBSERVE_KEYS = ['enabled', 't3BaseDir', 'url', 'pollMs', 'includeTitles', 'cli', 'credentialFile', 'tokenTtl', 'backfillHours', 'fetchesPerPoll'];
/**
 * `observe`: watch the operator's own running T3 Code, read-only, and report sessions, usage and subscription windows.
 * Paths may start with `~/`. Secrets never live here: the T3 session is minted into the node data directory (0600).
 */
export function observeConfig(value, root = process.cwd()) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !OBSERVE_KEYS.includes(key))) throw new Error('Invalid observe configuration.');
  const path = item => item.startsWith('~/') ? resolve(homedir(), item.slice(2)) : isAbsolute(item) ? item : resolve(root, item);
  const result = { enabled: value.enabled === true, t3BaseDir: resolve(homedir(), '.t3/userdata'), pollMs: 5000, includeTitles: true };
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error('observe.enabled must be a boolean.');
  for (const key of ['t3BaseDir', 'cli', 'credentialFile']) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].includes('\0')) throw new Error(`Invalid observe.${key}.`);
    result[key] = path(value[key]);
  }
  if (value.url !== undefined) {
    let url; try { url = new URL(value.url); } catch { throw new Error('Invalid observe.url.'); }
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('observe.url must be a loopback T3 origin.');
    result.url = url.origin;
  }
  if (value.pollMs !== undefined && (!Number.isSafeInteger(value.pollMs) || value.pollMs < 500 || value.pollMs > 600000)) throw new Error('observe.pollMs must be 500 to 600000.');
  if (value.pollMs !== undefined) result.pollMs = value.pollMs;
  if (value.includeTitles !== undefined && typeof value.includeTitles !== 'boolean') throw new Error('observe.includeTitles must be a boolean.');
  if (value.includeTitles !== undefined) result.includeTitles = value.includeTitles;
  if (value.tokenTtl !== undefined && (typeof value.tokenTtl !== 'string' || !/^\d{1,4}[mhd]$/.test(value.tokenTtl))) throw new Error('observe.tokenTtl must look like 30d, 12h or 90m.');
  if (value.tokenTtl !== undefined) result.tokenTtl = value.tokenTtl;
  for (const [key, max] of [['backfillHours', 24 * 90], ['fetchesPerPoll', 50]]) {
    if (value[key] === undefined) continue;
    if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > max) throw new Error(`Invalid observe.${key}.`);
    result[key] = value[key];
  }
  return result;
}
