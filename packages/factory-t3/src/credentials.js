import { lstat, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';

// providers:manage lets the executor register per-account provider instances (server.updateSettings).
export const EXECUTOR_SCOPES = Object.freeze(['orchestration:read', 'orchestration:operate', 'providers:manage']);

export class CredentialError extends Error {
  constructor(message) { super(message); this.name = 'CredentialError'; }
}

/** Read one session token from an owner-only regular file (mode 600). */
export async function readCredentialFile(filename) {
  try {
    const stat = await lstat(filename);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error();
    const token = (await readFile(filename, 'utf8')).trim();
    if (!token || /\s/.test(token)) throw new Error();
    return token;
  } catch {
    throw new CredentialError('T3 credential file must be an owner-only regular file containing one session token.');
  }
}

/**
 * Mint a short-lived session with T3's own CLI. It writes the session to the
 * runtime's local state, so this only works as the OS user that owns the
 * runtime's base directory. The token is returned in memory and never logged.
 */
export function issueSessionToken({ serverEntry, baseDir, ttl = '12h', scopes = EXECUTOR_SCOPES, label = 'perpeto-factory-t3', nodePath = process.execPath, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    execFile(nodePath, [serverEntry, 'auth', 'session', 'issue', '--base-dir', baseDir, '--ttl', ttl,
      '--label', label, '--token-only', ...scopes.flatMap(scope => ['--scope', scope])],
    { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024, env: { ...process.env, NO_COLOR: '1' } },
    (error, stdout) => {
      const token = typeof stdout === 'string' ? stdout.trim() : '';
      if (error || !token || /\s/.test(token)) reject(new CredentialError('Unable to issue a T3 session with the runtime CLI.'));
      else resolve(token);
    });
  });
}
