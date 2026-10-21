import { RpcConnection, T3RpcError } from './rpc.js';

export const ORCHESTRATION_PROTOCOL = '2';

export class T3HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'T3HttpError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Client for one local T3 environment server. HTTP covers project listing,
 * thread snapshots and the Perpeto agent-policy routes; the WebSocket RPC
 * covers commands and live thread events (T3 has no HTTP dispatch route).
 */
export class T3Client {
  #token;
  #connection = null;
  #connecting = null;

  /**
   * @param {{ baseUrl: string, token: string, fetchImpl?: typeof fetch, WebSocketImpl?: typeof WebSocket,
   *           timeoutMs?: number, pingMs?: number }} options
   */
  constructor({ baseUrl, token, fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, timeoutMs = 30000, pingMs = 5000 }) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new TypeError('T3 baseUrl must be an HTTP(S) URL without credentials, query or fragment.');
    }
    if (typeof token !== 'string' || !token || /[\s]/.test(token)) throw new TypeError('A T3 session token is required.');
    this.baseUrl = url.href.replace(/\/+$/, '');
    this.#token = token;
    this.fetch = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.timeoutMs = timeoutMs;
    this.pingMs = pingMs;
  }

  async http(method, path, { body, orchestration = false, signal, allow = [] } = {}) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          ...(orchestration ? { 'x-t3-orchestration-protocol': ORCHESTRATION_PROTOCOL } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new T3HttpError(0, 'UNREACHABLE', `T3 runtime request ${method} ${path.split('?')[0]} failed.`);
    }
    let payload = null;
    try { payload = response.status === 204 ? null : await response.json(); } catch { payload = null; }
    if (!response.ok && !allow.includes(response.status)) {
      const code = typeof payload?.error?.code === 'string' ? payload.error.code : `HTTP_${response.status}`;
      const message = typeof payload?.error?.message === 'string' ? payload.error.message : `T3 runtime rejected ${method} ${path.split('?')[0]} (HTTP ${response.status}).`;
      throw new T3HttpError(response.status, code, message.slice(0, 500));
    }
    return { status: response.status, body: payload };
  }

  /** Open (or reuse) the RPC connection with a short-lived WebSocket ticket. */
  async rpc({ signal } = {}) {
    if (this.#connection && !this.#connection.closed) return this.#connection;
    this.#connecting ??= (async () => {
      const { body } = await this.http('POST', '/api/auth/websocket-ticket', { signal });
      if (typeof body?.ticket !== 'string') throw new T3HttpError(500, 'INVALID_TICKET', 'T3 runtime returned no WebSocket ticket.');
      const ws = new URL(this.baseUrl);
      ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:';
      ws.pathname = `${ws.pathname.replace(/\/+$/, '')}/ws`;
      ws.search = new URLSearchParams({ orchestrationProtocol: ORCHESTRATION_PROTOCOL, wsTicket: body.ticket }).toString();
      this.#connection = await RpcConnection.open(ws.href, { WebSocketImpl: this.WebSocketImpl, timeoutMs: this.timeoutMs, pingMs: this.pingMs, signal });
      return this.#connection;
    })().finally(() => { this.#connecting = null; });
    return this.#connecting;
  }

  async request(tag, payload, options = {}) {
    const connection = await this.rpc(options);
    return connection.request(tag, payload, { timeoutMs: this.timeoutMs, ...options });
  }

  close() { this.#connection?.close(); this.#connection = null; }

  async getConfig(options) { return this.request('server.getConfig', {}, options); }

  async listProjects(options) {
    const { body } = await this.http('GET', '/api/projects', options);
    return Array.isArray(body?.projects) ? body.projects.filter(project => project.deletedAt == null) : [];
  }

  /** Find the project registered for a workspace root, or create it. T3 allows one project per root. */
  async ensureProject({ workspaceRoot, title, projectId, commandId }, options) {
    const existing = (await this.listProjects(options)).find(project => project.workspaceRoot === workspaceRoot);
    if (existing) return existing;
    try {
      return await this.request('projects.mutate', {
        type: 'project.create', commandId, projectId, title, workspaceRoot, createWorkspaceRootIfMissing: false,
      }, options);
    } catch (error) {
      // A concurrent assignment may have registered the same root first.
      const raced = (await this.listProjects(options)).find(project => project.workspaceRoot === workspaceRoot);
      if (raced) return raced;
      throw error;
    }
  }

  async launchThread(input, options) { return this.request('orchestration.launchThread', input, options); }
  async dispatch(command, options) { return this.request('orchestration.dispatchCommand', command, options); }

  /** Live thread items: `{kind:'snapshot'|'synchronized'|'event', …}`. Resume with `afterSequence`. */
  async subscribeThread({ threadId, afterSequence }, onItems, options) {
    const connection = await this.rpc(options);
    return connection.stream('orchestration.subscribeThread', {
      threadId, requestCompletionMarker: true, ...(afterSequence === undefined ? {} : { afterSequence }),
    }, onItems);
  }

  async getThread(threadId, options) {
    const { body } = await this.http('GET', `/api/orchestration/threads/${encodeURIComponent(threadId)}`, { orchestration: true, ...options });
    return body;
  }

  async setPolicy(threadId, policy, options) {
    const { body } = await this.http('PUT', `/api/perpeto/agent-policies/${encodeURIComponent(threadId)}`, { body: policy, ...options });
    return body;
  }

  async policyDecisions(threadId, after = 0, options) {
    const { body } = await this.http('GET', `/api/perpeto/agent-policies/${encodeURIComponent(threadId)}/decisions?after=${after}`, options);
    return body;
  }

  async reportNativeSubagent(threadId, input, options) {
    const { body } = await this.http('POST', `/api/perpeto/agent-policies/${encodeURIComponent(threadId)}/native-subagents`, { body: input, ...options });
    return body;
  }
}

export { T3RpcError };
