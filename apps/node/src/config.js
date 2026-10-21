import { readFile, lstat, open, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

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
  try { await rename(temp, path); } finally { await unlink(temp).catch(() => {}); }
}

export async function loadConfig(configPath) {
  const root = dirname(resolve(configPath));
  const raw = JSON.parse(await readFile(configPath, 'utf8'));
  const allowed = ['hubUrl', 'name', 'dataDir', 'credentialFile', 'enrollmentCodeFile', 'labels', 'capacity', 'providers',
    'timing', 'fake', 'executorPackages', 'accountProviderPackage', 'accounts', 'runtime', 'jobs', 'allowInsecureHttp'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !allowed.includes(key))) {
    throw new Error('Invalid node configuration; credentials belong in owner-only files.');
  }
  const url = new URL(raw.hubUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid hubUrl.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && raw.allowInsecureHttp !== true) throw new Error('Remote hubs require HTTPS.');
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
  const capacity = raw.capacity ?? { maxAgents: 1, maxJobs: 1 };
  for (const key of ['maxAgents', 'maxJobs']) {
    if (!Number.isSafeInteger(capacity[key]) || capacity[key] < 0) throw new Error(`Invalid capacity.${key}.`);
  }
  if (!capacity.maxAgents && !capacity.maxJobs) throw new Error('Node capacity must allow some work.');
  for (const key of ['labels', 'providers', 'executorPackages']) {
    if (raw[key] !== undefined && (!Array.isArray(raw[key]) || raw[key].some(value => typeof value !== 'string' || !value.trim()))) throw new Error(`Invalid ${key}.`);
  }
  const timing = { heartbeatMs: 10000, renewMs: 20000, requestMs: 30000, pollIdleMs: 200,
    backoffMinMs: 250, backoffMaxMs: 10000, ...(raw.timing ?? {}) };
  for (const [key, value] of Object.entries(timing)) {
    if (!['heartbeatMs', 'renewMs', 'requestMs', 'pollIdleMs', 'backoffMinMs', 'backoffMaxMs'].includes(key) || !Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new Error('Invalid timing configuration.');
  }
  if (timing.backoffMaxMs < timing.backoffMinMs) throw new Error('Invalid backoff bounds.');
  return { ...raw, hubUrl: url.href.replace(/\/+$/, ''), dataDir, capacity, timing,
    credentialFile: raw.credentialFile ? path(raw.credentialFile) : resolve(dataDir, 'machine.json'),
    enrollmentCodeFile: raw.enrollmentCodeFile ? path(raw.enrollmentCodeFile) : undefined,
    labels: raw.labels ?? [], configRoot: root };
}
