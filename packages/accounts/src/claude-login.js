import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import path from 'node:path';

/**
 * Where Claude Code keeps a login for a config directory, so Perpeto can check or seed a private home.
 * Observed in Claude Code 2.1.304 (macOS build):
 * - Credentials live in the login keychain under service `Claude Code-credentials`, plus
 *   `-<first 8 hex of sha256(config dir)>` whenever CLAUDE_CONFIG_DIR is set, account `$USER`.
 * - `<config dir>/.credentials.json` is the plaintext fallback. On its first credential write (a token
 *   refresh, or recording the plan from the profile) Claude moves it into that keychain item and deletes the file.
 * Other platforms use the plaintext file only.
 * Nothing here prints, logs or returns more of a credential than its caller asked for.
 */
export const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const SECURITY = '/usr/bin/security';

/** Keychain service for a config dir; `null` is the default `~/.claude` with CLAUDE_CONFIG_DIR unset. */
export function claudeKeychainService(configDir) {
  if (configDir === null || configDir === undefined) return CLAUDE_KEYCHAIN_SERVICE;
  const digest = createHash('sha256').update(path.resolve(configDir).normalize('NFC')).digest('hex').slice(0, 8);
  return `${CLAUDE_KEYCHAIN_SERVICE}-${digest}`;
}

export function claudeKeychainAccount(env = process.env) {
  let name;
  try { name = env.USER || userInfo().username; } catch { name = ''; }
  return /^[a-zA-Z0-9._-]+$/.test(name) ? name : 'claude-code-user';
}

/**
 * Presence-only keychain probe: `security` without `-w` prints attributes, never the secret, and its output is
 * discarded. Always false off macOS.
 */
export function hasClaudeKeychainLogin(configDir, { platform = process.platform } = {}) {
  if (platform !== 'darwin') return false;
  try {
    execFileSync(SECURITY, ['find-generic-password', '-a', claudeKeychainAccount(), '-s', claudeKeychainService(configDir)],
      { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch { return false; }
}

/** Remove the keychain item Claude created for a config dir, for example when deleting a factory home. */
export function deleteClaudeKeychainLogin(configDir, { platform = process.platform } = {}) {
  if (platform !== 'darwin' || configDir === null || configDir === undefined) return false;
  try {
    execFileSync(SECURITY, ['delete-generic-password', '-a', claudeKeychainAccount(), '-s', claudeKeychainService(configDir)],
      { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch { return false; }
}

/**
 * Read a keychain login and return only its `claudeAiOauth` object, or null. The secret stays in memory;
 * errors carry no output. Other entries in the item, such as MCP server OAuth tokens, are dropped.
 */
export function readClaudeKeychainLogin(configDir, { platform = process.platform } = {}) {
  if (platform !== 'darwin') return Promise.resolve(null);
  return new Promise(resolve => {
    execFile(SECURITY, ['find-generic-password', '-a', claudeKeychainAccount(), '-w', '-s', claudeKeychainService(configDir)],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) return resolve(null);
        try { resolve(claudeOauth(JSON.parse(stdout.trim()))); } catch { resolve(null); }
      });
  });
}

/** The minimum Claude Code needs to authenticate: `claudeAiOauth` with an access token, or null. */
export function claudeOauth(data) {
  const oauth = data?.claudeAiOauth;
  return oauth && typeof oauth === 'object' && typeof oauth.accessToken === 'string' && oauth.accessToken.trim() ? oauth : null;
}
