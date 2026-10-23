import { mkdir, lstat, readFile, writeFile, open, rename, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { homedir, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readConfiguration } from '../../../scripts/runtime.mjs';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const defaultDir = () => resolve(homedir(), '.perpeto');
export const configPath = (dir, role) => resolve(dir, `${role}.json`);
export async function privateDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dir);
  if (!stat.isDirectory() || (stat.mode & 0o077) || stat.uid !== process.getuid()) {
    throw new Error('Data directory must be an owner-only directory (mode 700).');
  }
}
export async function readSecret(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.uid !== process.getuid()) {
    throw new Error('Secret must be an owner-only regular file (mode 600).');
  }
  return readFile(path, 'utf8');
}
export async function writeNew(path, value, mode = 0o600) {
  await writeFile(path, value, { flag: 'wx', mode });
}
export async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }
export const isLoopback = host => ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(host) || /^127\.\d+\.\d+\.\d+$/.test(host);
export function hubConfig(dir, { host = '127.0.0.1', port = 4320, tls = false } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be 0–65535.');
  if (!tls && !isLoopback(host)) throw new Error('A hub reachable beyond this machine needs HTTPS: add --tls, or keep it on loopback and run perpeto hub expose --tailscale.');
  return { host, port, ownerName: null, tlsEnabled: Boolean(tls), tlsCertPath: './hub/tls/cert.pem', tlsKeyPath: './hub/tls/key.pem', allowInsecureRemote: false, publicUrl: null, databasePath: './hub/hub.sqlite', messagingDatabasePath: './hub/messaging.sqlite',
    deliveryDatabasePath: './hub/delivery.sqlite', workflowDatabasePath: './hub/workflow.sqlite',
    deliveryRepositoriesPath: './hub/repositories', deliveryLeaseDurationMs: 60000,
    deliveryMaxStepFailures: 5, deliveryRetryBackoffMs: 2000, ownerTokenPath: './hub/owner.secret', credentialKeyPath: './hub/credentials.key',
    corsOrigins: [], requestMaxBytes: 1048576, heartbeatIntervalMs: 10000, leaseDurationMs: 60000,
    longPollMs: 25000, maintenanceIntervalMs: 1000, enrollmentTtlMs: 600000,
    finishedWorkRetentionMs: 604800000, eventRetentionMs: 2592000000, usageRetentionMs: 2592000000,
    idempotencyRetentionMs: 86400000, archiveFinished: true, retentionSweepIntervalMs: 60000, sessionTtlMs: 43200000, messageRatePerMinute: 30,
    architectHarness: { provider: 'codex', model: 'gpt-6.1-sol' },
    // Subscription pacing (apps/hub/src/config.js); burn-rate priors are uncalibrated percent-per-agent-hour starting points.
    pacing: { enabled: true, strategy: 'rotation', targetUsePercent: 95, minAgents: 0, maxAgents: null, handoverMins: 15, sprintMins: 90, horizonMins: 600,
      recomputeMs: 15000, nudgeIntervalMs: 1800000,
      priors: { default: { session: 20, weekly: 2.5, monthly: 0.6, other: 20 }, claudeAgent: { session: 20, weekly: 2.5 }, codex: { session: 15, weekly: 2 } } },
    // CI pipeline runs (apps/hub/src/ci/config.js): bounded logs, artifact storage and retention.
    ci: { logMaxBytesPerJob: 5242880, logRetentionMs: 1209600000, artifactsPath: './hub/ci-artifacts', artifactMaxBytesPerJob: 209715200, artifactRetentionMs: 604800000,
      runRetentionMs: 2592000000, redactPatterns: [], scheduleTriggers: true, pullRequestTriggers: true } };
}
export function hubUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid hub URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Hub URL must be an HTTP(S) origin without credentials.');
  }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Remote hubs require HTTPS. Configure a secure endpoint first.');
  }
  return url.origin;
}
/** A join code from perpeto hub enroll-code: `pj1_` and base64url JSON of the hub URL, optional pinned fingerprint and code. */
export function decodeJoinCode(text) {
  let value;
  try { value = /^pj1_[A-Za-z0-9_-]+$/.test(text) ? JSON.parse(Buffer.from(text.slice(4), 'base64url').toString('utf8')) : null; } catch { value = null; }
  if (!value || typeof value.code !== 'string' || !value.code || typeof value.url !== 'string' ||
    (value.fingerprint !== undefined && !/^[a-f0-9]{64}$/.test(value.fingerprint))) throw new Error('Invalid join code. Copy the whole command from perpeto hub enroll-code.');
  return { url: hubUrl(value.url), code: value.code, ...(value.fingerprint ? { fingerprint: value.fingerprint } : {}) };
}
/**
 * Observe-only: no agent or CI slots, no managed runtime and no executor; the node only watches the operator's own
 * running T3 Code, read-only, and reports sessions, usage and subscription windows to the hub.
 */
export function observeSettings({ t3Dir, titles = true } = {}) {
  return { enabled: true, t3BaseDir: t3Dir ? resolve(t3Dir) : resolve(homedir(), '.t3/userdata'), pollMs: 5000, includeTitles: titles };
}
export function nodeConfig(dir, url, { labels = [], name = hostname(), fingerprint, observe } = {}) {
  if (!Array.isArray(labels) || labels.some(label => typeof label !== 'string' || !label.trim())) throw new Error('Labels must be non-empty strings.');
  if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new Error('Invalid machine name.');
  const runtime = readConfiguration();
  const host = ['0.0.0.0', '::'].includes(runtime.host) ? '127.0.0.1' : runtime.host;
  if (fingerprint !== undefined && (!/^[a-f0-9]{64}$/.test(fingerprint) || !url.startsWith('https:'))) throw new Error('A pinned fingerprint needs an https hub URL.');
  return { hubUrl: hubUrl(url), ...(fingerprint ? { hubFingerprint: fingerprint } : {}), name, labels, dataDir: './node', credentialFile: './node/machine.json',
    capacity: observe ? { maxAgents: 0, maxJobs: 0 } : { maxAgents: 1, maxJobs: 1 }, allowInsecureHttp: false,
    executorPackages: observe ? [] : ['@perpeto/t3-executor'], ...(observe ? { observe } : {}),
    // CI runner: pools split maxJobs; the dependency cache is per machine and LRU-evicted above cacheMaxBytes.
    ...(observe ? {} : { runner: { labels: [], cacheDir: './node/ci-cache', cacheMaxBytes: 10737418240, artifactMaxBytes: 104857600 } }),
    timing: { heartbeatMs: 10000, renewMs: 20000, requestMs: 30000, pollIdleMs: 200, backoffMinMs: 250, backoffMaxMs: 10000 },
    jobs: { defaultTimeoutSec: 600, checkoutTimeoutSec: 120, maxLogChunkBytes: 8192, redactPatterns: [], protectedPaths: [] }, runtime: { enabled: false, repoRoot,
      url: `http://${host.includes(':') ? `[${host}]` : host}:${runtime.port}` } };
}
export async function initHub(dir, options) {
  await privateDir(dir);
  const path = configPath(dir, 'hub');
  try { await writeNew(path, `${JSON.stringify(hubConfig(dir, options), null, 2)}\n`); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const { createHub } = await import('@perpeto/hub');
  try {
    const hub = await createHub({ configPath: path });
    await hub.close();
  } catch { throw new Error('Hub initialization failed. Check JSON configuration and private data files.'); }
  return path;
}

// Write credentials completely before making a new token visible to the daemon.
export async function writePrivateJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally { await file.close(); }
  try { await rename(temp, path); } finally { await unlink(temp).catch(() => {}); }
}
