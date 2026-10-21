import { mkdir, lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { homedir, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
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
export function hubConfig(dir, { host = '127.0.0.1', port = 4320 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be 0–65535.');
  return { host, port, databasePath: './hub/hub.sqlite', messagingDatabasePath: './hub/messaging.sqlite',
    ownerTokenPath: './hub/owner.secret' };
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
export function nodeConfig(dir, url, { labels = [], name = hostname() } = {}) {
  if (!Array.isArray(labels) || labels.some(label => typeof label !== 'string' || !label.trim())) throw new Error('Labels must be non-empty strings.');
  if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new Error('Invalid machine name.');
  const runtime = readConfiguration();
  const host = ['0.0.0.0', '::'].includes(runtime.host) ? '127.0.0.1' : runtime.host;
  return { hubUrl: hubUrl(url), name, labels, dataDir: './node', credentialFile: './node/machine.json',
    capacity: { maxAgents: 1, maxJobs: 1 }, runtime: { enabled: false, repoRoot,
      url: `http://${host.includes(':') ? `[${host}]` : host}:${runtime.port}` } };
}
export async function initHub(dir, options) {
  await privateDir(dir);
  const path = configPath(dir, 'hub');
  try { await writeNew(path, `${JSON.stringify(hubConfig(dir, options), null, 2)}\n`); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const { createHub } = await import('../../factory-hub/src/index.js');
  try {
    const hub = await createHub({ configPath: path });
    await hub.close();
  } catch { throw new Error('Hub initialization failed. Check JSON configuration and private data files.'); }
  return path;
}
