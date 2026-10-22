import { execFile } from 'node:child_process';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * The only scope the observer asks T3 for. `orchestration:read` covers `server.getConfig`, the shell and thread
 * subscriptions and the WebSocket ticket; it grants no command, settings, provider, terminal or filesystem access
 * (vendor/t3code/apps/server/src/auth/RpcAuthorization.ts).
 */
export const OBSERVER_SCOPES = Object.freeze(['orchestration:read']);
export const OBSERVER_LABEL = 'perpeto-observer';

export class ObserverCredentialError extends Error {
  constructor(message, code = 'T3_CREDENTIAL') { super(message); this.name = 'ObserverCredentialError'; this.code = code; }
}

/** T3's home (the `--base-dir` its CLI takes) for a runtime directory such as `~/.t3/userdata`. */
export function t3Home(baseDir) { return basename(baseDir) === 'userdata' ? dirname(baseDir) : baseDir; }
/** The desktop app's own CLI wrapper, which runs the bundled server build matching the running app. */
export function defaultCli(baseDir) { return resolve(t3Home(baseDir), 'bin', 't3'); }

const UNITS = { m: 60000, h: 3600000, d: 86400000 };
export function ttlMs(ttl) {
  const match = /^(\d{1,4})([mhd])$/.exec(String(ttl));
  if (!match || Number(match[1]) < 1) throw new ObserverCredentialError('tokenTtl must look like 30d, 12h or 90m.', 'INVALID_CONFIG');
  return Number(match[1]) * UNITS[match[2]];
}

/**
 * One session token from an owner-only regular file. The file is either a bare token (an operator-provided
 * credentialFile) or the JSON the observer writes. Returns null when the file does not exist.
 */
export async function readTokenFile(path) {
  let stat;
  try { stat = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new ObserverCredentialError('The T3 session file must be an owner-only regular file (mode 600).');
  }
  const text = (await readFile(path, 'utf8')).trim();
  let value;
  if (text.startsWith('{')) { try { value = JSON.parse(text); } catch { value = null; } } else value = { token: text };
  if (!value || typeof value.token !== 'string' || !value.token || /\s/.test(value.token)) throw new ObserverCredentialError('The T3 session file holds no valid token.');
  return { token: value.token, ...(typeof value.expiresAt === 'string' ? { expiresAt: value.expiresAt } : {}) };
}

/** Atomically replace an owner-only (0600) file in an owner-only directory. */
export async function writeTokenFile(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  try { await rename(temp, path); } finally { await unlink(temp).catch(() => {}); }
}

/**
 * Mint a read-only session with T3's own CLI (`t3 auth session issue`). This is T3's supported headless auth path: it
 * adds one session row to the runtime's auth store and changes nothing else. The token is returned, never logged.
 */
export function mintSession({ cli, home, ttl = '30d', label = OBSERVER_LABEL, timeoutMs = 60000, execFileImpl = execFile }) {
  return new Promise((resolvePromise, reject) => {
    execFileImpl(cli, ['auth', 'session', 'issue', '--base-dir', home, '--ttl', ttl, '--label', label, '--token-only',
      ...OBSERVER_SCOPES.flatMap(scope => ['--scope', scope])],
    { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024, env: { ...process.env, NO_COLOR: '1' } },
    (error, stdout) => {
      const token = typeof stdout === 'string' ? stdout.trim() : '';
      if (error || !token || /\s/.test(token)) reject(new ObserverCredentialError('T3 did not issue a session. Check that T3 Code is installed and has been opened once.', 'MINT_FAILED'));
      else resolvePromise(token);
    });
  });
}
