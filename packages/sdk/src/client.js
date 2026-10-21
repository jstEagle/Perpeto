import { readFileSync, lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export class ClientError extends Error {
  constructor(message) { super(message); this.name = 'ClientError'; }
}
function nonblank(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new ClientError(`Invalid ${label}.`);
  return value;
}

export function loadConfig(filename) {
  let config;
  try { config = JSON.parse(readFileSync(filename, 'utf8')); }
  catch { throw new ClientError('Cannot read client configuration JSON.'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new ClientError('Invalid client configuration.');
  const allowed = new Set(['baseUrl', 'projectId', 'roleId', 'channelId', 'credentialFile', 'timeoutMs', 'allowInsecureHttp', 'messagingPrefix']);
  if (Object.keys(config).some(key => !allowed.has(key))) throw new ClientError('Unknown configuration field. Credentials must stay in the credential file.');
  for (const key of ['baseUrl', 'projectId', 'roleId', 'channelId', 'credentialFile']) nonblank(config[key], key);
  let url;
  try { url = new URL(config.baseUrl); } catch { throw new ClientError('Invalid baseUrl.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ClientError('baseUrl must be an HTTP(S) URL without credentials, query, or fragment.');
  if (config.allowInsecureHttp !== undefined && typeof config.allowInsecureHttp !== 'boolean') throw new ClientError('allowInsecureHttp must be a boolean.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && config.allowInsecureHttp !== true) throw new ClientError('Remote HTTP requires HTTPS or explicit allowInsecureHttp: true in the client config.');
  if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 300000)) throw new ClientError('timeoutMs must be between 100 and 300000.');
  const messagingPrefix = config.messagingPrefix ?? '/api/v1/messaging';
  if (!['/api/v1/messaging', '/api/perpeto'].includes(messagingPrefix)) throw new ClientError('messagingPrefix must be /api/v1/messaging or /api/perpeto.');
  return { ...config, messagingPrefix, baseUrl: config.baseUrl.replace(/\/+$/, ''), credentialFile: resolve(dirname(resolve(filename)), config.credentialFile) };
}

export class FactoryClient {
  #token;
  #config;
  constructor(config) {
    this.#config = config;
    try {
      const stat = lstatSync(config.credentialFile);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error();
      this.#token = readFileSync(config.credentialFile, 'utf8').trim();
      if (!this.#token || /[\r\n]/.test(this.#token)) throw new Error();
    } catch { throw new ClientError('Credential file must be a readable owner-only regular file containing one session token.'); }
  }

  async #request(method, path, body, query = {}) {
    const url = new URL(`${this.#config.baseUrl}${this.#config.messagingPrefix ?? '/api/v1/messaging'}${path}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    for (let attempt = 0; attempt < 2; attempt++) {
      let response;
      try {
        response = await fetch(url, {
          method, redirect: 'error', signal: AbortSignal.timeout(this.#config.timeoutMs ?? 30000),
          headers: { Authorization: `Bearer ${this.#token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        if (attempt === 0) continue;
        throw new ClientError('Factory request failed or timed out.');
      }
      if ([429, 502, 503, 504].includes(response.status) && attempt === 0) {
        await response.body?.cancel();
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ClientError(`Factory request rejected (HTTP ${response.status}).`);
      }
      try { return await response.json(); }
      catch { throw new ClientError('Factory returned an invalid JSON response.'); }
    }
  }

  #project() { return `/projects/${encodeURIComponent(this.#config.projectId)}`; }
  #channel(channelId = this.#config.channelId) { return `${this.#project()}/channels/${encodeURIComponent(nonblank(channelId, 'channelId'))}`; }
  initProject(name) { return this.#request('PUT', this.#project(), { name: nonblank(name, 'name') }); }
  createChannel(id, name) { return this.#request('POST', `${this.#project()}/channels`, { id: nonblank(id, 'id'), name: nonblank(name, 'name') }); }
  channels() { return this.#request('GET', `${this.#project()}/channels`); }
  send({ body, idempotencyKey, recipientRoleId, channelId } = {}) {
    nonblank(body, 'body'); nonblank(idempotencyKey, 'idempotencyKey');
    if (recipientRoleId !== undefined && recipientRoleId !== null) nonblank(recipientRoleId, 'recipientRoleId');
    return this.#request('POST', `${this.#channel(channelId)}/messages`, {
      senderRoleId: this.#config.roleId, body, idempotencyKey, ...(recipientRoleId === undefined ? {} : { recipientRoleId }),
    });
  }
  read({ after, before, latest, limit, recipientRoleId, channelId } = {}) {
    if (after !== undefined) nonblank(after, 'after');
    if (before !== undefined) nonblank(before, 'before');
    if (latest !== undefined && typeof latest !== 'boolean') throw new ClientError('latest must be a boolean.');
    if (Number(after !== undefined) + Number(before !== undefined) + Number(latest === true) > 1) throw new ClientError('after, before and latest are mutually exclusive.');
    if (recipientRoleId !== undefined) nonblank(recipientRoleId, 'recipientRoleId');
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)) throw new ClientError('limit must be between 1 and 500.');
    return this.#request('GET', `${this.#channel(channelId)}/messages`, undefined, { after, before, latest, limit, recipientRoleId });
  }
}
