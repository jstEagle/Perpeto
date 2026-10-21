import path from 'node:path';
import * as fs from 'node:fs';
import { assertPrivate, privatePath, readJson, readPrivate, writePrivate, fail } from './private-files.js';

export const providers = new Set(['claudeAgent', 'codex']);
export const credentialName = provider => provider === 'codex' ? 'auth.json' : '.credentials.json';

function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('INVALID_SOURCE');
  return path.resolve(value);
}

function credentials(text, provider) {
  let data;
  try { data = JSON.parse(text); } catch { fail('INVALID_CREDENTIAL_FILE'); }
  const token = provider === 'codex' ? data?.tokens?.access_token ?? data?.OPENAI_API_KEY
    : data?.claudeAiOauth?.accessToken;
  if (typeof token !== 'string' || !token.trim()) fail('INVALID_CREDENTIAL_FILE');
  return text;
}

/** Explicit same-machine sources only. Never discover real homes or invoke ccswap. */
export function readImport(provider, source) {
  if (!providers.has(provider)) fail('UNSUPPORTED_PROVIDER');
  if (!source || typeof source !== 'object') fail('INVALID_SOURCE');
  let text, metadata, disabled = false;
  if (source.kind === 'provider-home') {
    const home = absolute(source.homePath);
    assertPrivate(home, true);
    text = readPrivate(path.join(home, credentialName(provider)));
    if (provider === 'claudeAgent' && source.accountConfigPath !== undefined) {
      metadata = readJson(absolute(source.accountConfigPath));
    }
  } else if (source.kind === 'ccswap') {
    const root = absolute(source.storePath);
    assertPrivate(root, true);
    if (!/^[1-9]\d*$/.test(String(source.slot))) fail('INVALID_SOURCE');
    const base = provider === 'codex' ? path.join(root, 'codex') : root;
    privatePath(root, base);
    const sequence = readJson(path.join(base, 'sequence.json'));
    const record = sequence?.accounts?.[String(source.slot)];
    if (!record) fail('SOURCE_ACCOUNT_NOT_FOUND');
    disabled = record.disabled === true;
    privatePath(root, path.join(base, 'credentials'));
    if (provider === 'codex') {
      text = readPrivate(path.join(base, 'credentials', `account-${source.slot}.json`));
    } else {
      // ccswap's .enc backups are base64, not encrypted. Keychain-only backups
      // intentionally have no fallback here: no Keychain access in this package.
      if (typeof record.email !== 'string' || !/^[A-Za-z0-9@._+-]+$/.test(record.email)) fail('INVALID_SOURCE');
      const encoded = readPrivate(path.join(base, 'credentials', `.creds-${source.slot}-${record.email}.enc`)).trim();
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) fail('INVALID_CREDENTIAL_FILE');
      text = Buffer.from(encoded, 'base64').toString('utf8');
      privatePath(root, path.join(base, 'configs'));
      metadata = readJson(path.join(base, 'configs', `.claude-config-${source.slot}-${record.email}.json`));
    }
  } else fail('INVALID_SOURCE');
  credentials(text, provider);
  // Copy only identity/onboarding fields, never tools, hooks or user settings.
  const accountConfig = metadata ? {
    ...(metadata.oauthAccount ? { oauthAccount: metadata.oauthAccount } : {}),
    ...(typeof metadata.hasCompletedOnboarding === 'boolean'
      ? { hasCompletedOnboarding: metadata.hasCompletedOnboarding } : {}),
  } : undefined;
  return { text, accountConfig, disabled };
}

export function writeHome(home, provider, imported) {
  fs.mkdirSync(home, { mode: 0o700 });
  fs.chmodSync(home, 0o700);
  writePrivate(path.join(home, credentialName(provider)), imported.text);
  if (provider === 'codex') {
    writePrivate(path.join(home, 'config.toml'), 'cli_auth_credentials_store = "file"\n');
  } else if (imported.accountConfig) {
    writePrivate(path.join(home, '.claude.json'), `${JSON.stringify(imported.accountConfig)}\n`);
  }
}

export function checkHome(root, home, provider) {
  privatePath(root, home);
  credentials(readPrivate(path.join(home, credentialName(provider))), provider);
  if (provider === 'codex') assertPrivate(path.join(home, 'config.toml'));
  if (provider === 'claudeAgent' && fs.existsSync(path.join(home, '.claude.json'))) {
    assertPrivate(path.join(home, '.claude.json'));
  }
}
