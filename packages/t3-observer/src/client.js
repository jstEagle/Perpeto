import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RpcConnection } from '@perpeto/t3-executor/rpc';

/**
 * Every RPC the observer may send. All need only `orchestration:read`; none dispatches a command, changes settings,
 * probes providers or touches files. Anything else is refused before it reaches the socket.
 */
export const READ_ONLY_RPCS = Object.freeze(['server.getConfig', 'orchestration.subscribeShell', 'orchestration.subscribeThread']);
export const ORCHESTRATION_PROTOCOL = '2';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export class T3ReadError extends Error {
  constructor(message, code = 'T3_UNAVAILABLE', status = 0) { super(message); this.name = 'T3ReadError'; this.code = code; this.status = status; }
}

/** A loopback http(s) origin with nothing else in it. */
export function loopbackOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new T3ReadError('Invalid T3 URL.', 'INVALID_CONFIG'); }
  if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK.has(url.hostname) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new T3ReadError('The observed T3 server must be a loopback http(s) origin.', 'INVALID_CONFIG');
  }
  return url.origin;
}

/** Where the running T3 desktop server listens, from its `server-runtime.json`. Re-read on every reconnect. */
export async function readRuntime(t3BaseDir) {
  let value;
  try { value = JSON.parse(await readFile(resolve(t3BaseDir, 'server-runtime.json'), 'utf8')); }
  catch { throw new T3ReadError('T3 Code is not running (no readable server-runtime.json).', 'T3_NOT_RUNNING'); }
  const origin = typeof value?.origin === 'string' ? value.origin : value?.host && value?.port ? `http://${value.host}:${value.port}` : null;
  if (!origin) throw new T3ReadError('server-runtime.json names no server origin.', 'T3_NOT_RUNNING');
  return { url: loopbackOrigin(origin), ...(typeof value.serverVersion === 'string' ? { serverVersion: value.serverVersion.slice(0, 100) } : {}) };
}

/**
 * Read-only client for one T3 environment server: the WebSocket ticket over HTTP, then three read RPCs over
 * T3's Effect RPC framing (shared with the executor). It has no method that could change T3 state.
 */
export class ReadOnlyT3Client {
  #token; #connection = null;
  constructor({ baseUrl, token, fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, timeoutMs = 30000, pingMs = 10000 }) {
    this.baseUrl = loopbackOrigin(baseUrl);
    if (typeof token !== 'string' || !token || /\s/.test(token)) throw new T3ReadError('A T3 session token is required.', 'INVALID_CONFIG');
    this.#token = token; this.fetch = fetchImpl; this.WebSocketImpl = WebSocketImpl; this.timeoutMs = timeoutMs; this.pingMs = pingMs;
  }
  get connected() { return Boolean(this.#connection && !this.#connection.closed); }
  /** Open the RPC socket with a short-lived ticket (`POST /api/auth/websocket-ticket`, protocol 2). */
  async connect({ signal } = {}) {
    if (this.connected) return this.#connection;
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}/api/auth/websocket-ticket`, { method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${this.#token}` }, signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]) });
    } catch { signal?.throwIfAborted(); throw new T3ReadError('T3 server is unreachable.', 'T3_UNREACHABLE'); }
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (response.status === 401 || response.status === 403) throw new T3ReadError('T3 rejected the observer session.', 'UNAUTHORIZED', response.status);
    if (!response.ok || typeof body?.ticket !== 'string') throw new T3ReadError(`T3 returned no WebSocket ticket (HTTP ${response.status}).`, 'T3_UNAVAILABLE', response.status);
    const ws = new URL(this.baseUrl);
    ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:'; ws.pathname = '/ws';
    ws.search = new URLSearchParams({ orchestrationProtocol: ORCHESTRATION_PROTOCOL, wsTicket: body.ticket }).toString();
    try { this.#connection = await RpcConnection.open(ws.href, { WebSocketImpl: this.WebSocketImpl, timeoutMs: this.timeoutMs, pingMs: this.pingMs, signal }); }
    catch (error) { signal?.throwIfAborted(); throw new T3ReadError('T3 WebSocket did not open.', error?.code ?? 'T3_UNREACHABLE'); }
    return this.#connection;
  }
  onClose(listener) { return this.#connection?.onClose(listener) ?? (() => {}); }
  #allowed(tag) { if (!READ_ONLY_RPCS.includes(tag)) throw new T3ReadError(`Refusing ${tag}: the observer only reads.`, 'NOT_READ_ONLY'); }
  async request(tag, payload = {}, options = {}) {
    this.#allowed(tag);
    return (await this.connect(options)).request(tag, payload, { timeoutMs: this.timeoutMs, ...options });
  }
  async stream(tag, payload, onChunk, options = {}) {
    this.#allowed(tag);
    return (await this.connect(options)).stream(tag, payload, onChunk);
  }
  close() { this.#connection?.close(); this.#connection = null; }
}
