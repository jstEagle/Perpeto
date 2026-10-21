import { readFileSync, lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Agent, request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { connect } from 'node:tls';

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
  const allowed = new Set(['baseUrl', 'projectId', 'roleId', 'channelId', 'credentialFile', 'timeoutMs', 'allowInsecureHttp', 'messagingPrefix', 'tlsFingerprints']);
  if (Object.keys(config).some(key => !allowed.has(key))) throw new ClientError('Unknown configuration field. Credentials must stay in the credential file.');
  for (const key of ['baseUrl', 'projectId', 'roleId', 'channelId', 'credentialFile']) nonblank(config[key], key);
  let url;
  try { url = new URL(config.baseUrl); } catch { throw new ClientError('Invalid baseUrl.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ClientError('baseUrl must be an HTTP(S) URL without credentials, query, or fragment.');
  if (config.allowInsecureHttp !== undefined && typeof config.allowInsecureHttp !== 'boolean') throw new ClientError('allowInsecureHttp must be a boolean.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && config.allowInsecureHttp !== true) throw new ClientError('Remote HTTP requires HTTPS or explicit allowInsecureHttp: true in the client config.');
  if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 300000)) throw new ClientError('timeoutMs must be between 100 and 300000.');
  if (config.tlsFingerprints !== undefined && (url.protocol !== 'https:' || !Array.isArray(config.tlsFingerprints) || !config.tlsFingerprints.length ||
    config.tlsFingerprints.length > 4 || !config.tlsFingerprints.every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)))) {
    throw new ClientError('tlsFingerprints must be 1 to 4 lowercase SHA-256 hex certificate fingerprints for an https baseUrl.');
  }
  const messagingPrefix = config.messagingPrefix ?? '/api/v1/messaging';
  if (!['/api/v1/messaging', '/api/perpeto'].includes(messagingPrefix)) throw new ClientError('messagingPrefix must be /api/v1/messaging or /api/perpeto.');
  return { ...config, messagingPrefix, baseUrl: config.baseUrl.replace(/\/+$/, ''), credentialFile: resolve(dirname(resolve(filename)), config.credentialFile) };
}

export class FactoryClient {
  #token;
  #config;
  #pinned = null;
  constructor(config) {
    this.#config = config;
    if (config.tlsFingerprints) this.#pinned = pinnedRequester(config.tlsFingerprints, config.timeoutMs ?? 30000);
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
        response = this.#pinned ? await this.#pinned(url, method, body, this.#token) : await fetch(url, {
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
  /** Reply in a message's thread. Without `recipientRoleId` the hub answers the parent's sender. */
  reply({ messageId, body, idempotencyKey, recipientRoleId, channelId } = {}) {
    nonblank(messageId, 'messageId'); nonblank(body, 'body'); nonblank(idempotencyKey, 'idempotencyKey');
    if (recipientRoleId !== undefined && recipientRoleId !== null) nonblank(recipientRoleId, 'recipientRoleId');
    return this.#request('POST', `${this.#channel(channelId)}/messages`, {
      senderRoleId: this.#config.roleId, parentId: messageId, body, idempotencyKey, ...(recipientRoleId === undefined ? {} : { recipientRoleId }),
    });
  }
  /** A thread's messages, oldest first; `after` takes the previous page's nextCursor. */
  thread({ threadId, after, limit, channelId } = {}) {
    nonblank(threadId, 'threadId');
    if (after !== undefined) nonblank(after, 'after');
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)) throw new ClientError('limit must be between 1 and 500.');
    return this.#request('GET', `${this.#channel(channelId)}/messages`, undefined, { threadId, after, limit });
  }
  message({ messageId, channelId } = {}) {
    return this.#request('GET', `${this.#channel(channelId)}/messages/${encodeURIComponent(nonblank(messageId, 'messageId'))}`);
  }
  /** Report that a message addressed to the configured role was received and handled. Idempotent. */
  ack({ messageId, note, channelId } = {}) {
    nonblank(messageId, 'messageId');
    if (note !== undefined) nonblank(note, 'note');
    return this.#request('POST', `${this.#channel(channelId)}/messages/${encodeURIComponent(messageId)}/ack`, { roleId: this.#config.roleId, ...(note === undefined ? {} : { note }) });
  }
  /** Messages for the configured role after its read cursor; `markRead` then advances the cursor past them. */
  async unread({ limit, markRead = false, channelId } = {}) {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)) throw new ClientError('limit must be between 1 and 500.');
    if (typeof markRead !== 'boolean') throw new ClientError('markRead must be a boolean.');
    const page = await this.#request('GET', `${this.#channel(channelId)}/unread`, undefined, { roleId: this.#config.roleId, limit });
    const last = markRead && Array.isArray(page?.messages) ? page.messages.at(-1)?.id : undefined;
    if (!last) return page;
    const cursor = await this.markRead({ messageId: last, channelId });
    return { ...page, unreadCount: cursor.unreadCount, lastReadMessageId: cursor.lastReadMessageId };
  }
  markRead({ messageId, channelId } = {}) {
    return this.#request('POST', `${this.#channel(channelId)}/read-cursor`, { roleId: this.#config.roleId, messageId: nonblank(messageId, 'messageId') });
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

/**
 * Requests over HTTPS that trust exactly the pinned certificate fingerprints, as the node does for a hub with its own
 * self-signed certificate. The handshake is checked before any request byte, so the credential never reaches another
 * server. Returns a fetch-like response.
 */
function pinnedRequester(pins, timeoutMs) {
  class PinnedAgent extends Agent {
    createConnection(options, callback) {
      const socket = connect({ host: options.host, port: options.port, rejectUnauthorized: false,
        ...(options.servername && !isIP(options.servername) ? { servername: options.servername } : {}) });
      const failed = error => { socket.destroy(); callback(error); };
      socket.once('error', failed);
      socket.once('secureConnect', () => {
        const fingerprint = createHash('sha256').update(socket.getPeerCertificate(true).raw).digest('hex');
        if (!pins.includes(fingerprint)) { failed(new Error('The server presented an unpinned certificate.')); return; }
        socket.off('error', failed);
        callback(null, socket);
      });
    }
  }
  const agent = new PinnedAgent({ keepAlive: false });
  return (url, method, body, token) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const outgoing = httpsRequest(url, { method, agent, signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${token}`, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300,
        body: { cancel: async () => {} }, json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    outgoing.once('error', reject);
    outgoing.end(payload);
  });
}
