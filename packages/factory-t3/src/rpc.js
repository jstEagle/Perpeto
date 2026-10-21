/**
 * Minimal client for T3's Effect RPC over WebSocket (JSON serialization).
 *
 * Frames are one JSON message or an array of them:
 *   → {_tag:'Request', id, tag, payload, headers:[]}
 *   ← {_tag:'Exit', requestId, exit:{_tag:'Success', value} | {_tag:'Failure', cause:[…]}}
 *   ← {_tag:'Chunk', requestId, values:[…]}   (streams; each chunk must be acknowledged)
 *   → {_tag:'Ack', requestId} | {_tag:'Interrupt', requestId} | {_tag:'Ping'}
 * See vendor/t3code/apps/server/src/ws.ts and effect's RpcMessage/RpcServer.
 */
export class T3RpcError extends Error {
  /** @param {string} message @param {{ tag?: string, code?: string, cause?: unknown }} [details] */
  constructor(message, details = {}) {
    super(message);
    this.name = 'T3RpcError';
    this.tag = details.tag;
    this.code = details.code ?? 'RPC_FAILED';
    if (details.cause !== undefined) this.detail = details.cause;
  }
}

/** Summarise an Effect `Cause` without copying payloads into logs. */
export function causeError(cause) {
  const items = Array.isArray(cause) ? cause : [cause];
  const fail = items.find(item => item?._tag === 'Fail');
  if (fail) {
    const error = fail.error ?? {};
    const nested = typeof error.cause === 'object' && error.cause ? error.cause : null;
    const message = [error.message, nested?.message].filter(item => typeof item === 'string' && item).join(': ') || 'T3 request failed.';
    return new T3RpcError(message.slice(0, 1000), { tag: error._tag, code: 'RPC_FAILED', cause: { tag: error._tag, causeName: nested?.name } });
  }
  if (items.some(item => item?._tag === 'Interrupt')) return new T3RpcError('T3 request was interrupted.', { code: 'RPC_INTERRUPTED' });
  return new T3RpcError('T3 request failed unexpectedly.', { code: 'RPC_DEFECT' });
}

export class RpcConnection {
  #socket;
  #nextId = 0;
  #pending = new Map();
  #ping;
  #lastPong = Date.now();
  #closed = false;
  #closeListeners = new Set();
  closeReason = null;

  /**
   * @param {string} url ws:// URL including orchestrationProtocol and wsTicket
   * @param {{ WebSocketImpl?: typeof WebSocket, timeoutMs?: number, pingMs?: number, signal?: AbortSignal }} [options]
   */
  static open(url, { WebSocketImpl = globalThis.WebSocket, timeoutMs = 15000, pingMs = 5000, signal } = {}) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocketImpl(url);
      const timer = setTimeout(() => { fail(new T3RpcError('Timed out connecting to the T3 runtime.', { code: 'CONNECT_TIMEOUT' })); }, timeoutMs);
      const abort = () => fail(signal.reason ?? new T3RpcError('Connection aborted.', { code: 'ABORTED' }));
      signal?.addEventListener('abort', abort, { once: true });
      function cleanup() { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
      function fail(error) { cleanup(); try { socket.close(); } catch { /* Already closed. */ } reject(error); }
      socket.addEventListener('open', () => { cleanup(); resolve(new RpcConnection(socket, { pingMs, timeoutMs })); }, { once: true });
      socket.addEventListener('error', () => fail(new T3RpcError('Unable to connect to the T3 runtime.', { code: 'CONNECT_FAILED' })), { once: true });
    });
  }

  constructor(socket, { pingMs = 5000, timeoutMs = 15000 } = {}) {
    this.#socket = socket;
    socket.addEventListener('message', event => this.#receive(event.data));
    socket.addEventListener('close', () => this.#shutdown(new T3RpcError('T3 runtime connection closed.', { code: 'CONNECTION_CLOSED' })));
    socket.addEventListener('error', () => this.#shutdown(new T3RpcError('T3 runtime connection failed.', { code: 'CONNECTION_CLOSED' })));
    if (pingMs > 0) {
      this.#ping = setInterval(() => {
        if (Date.now() - this.#lastPong > Math.max(timeoutMs, pingMs * 3)) {
          this.#shutdown(new T3RpcError('T3 runtime stopped answering.', { code: 'CONNECTION_STALE' }));
          return;
        }
        this.#send({ _tag: 'Ping' });
      }, pingMs);
      this.#ping.unref?.();
    }
  }

  get closed() { return this.#closed; }

  onClose(listener) {
    if (this.#closed) { queueMicrotask(() => listener(this.closeReason)); return () => {}; }
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  #send(message) {
    if (this.#closed) return false;
    try { this.#socket.send(JSON.stringify(message)); return true; }
    catch { this.#shutdown(new T3RpcError('T3 runtime connection failed.', { code: 'CONNECTION_CLOSED' })); return false; }
  }

  #receive(data) {
    let messages;
    try { messages = [].concat(JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'))); }
    catch { return; }
    for (const message of messages) {
      if (message?._tag === 'Pong') { this.#lastPong = Date.now(); continue; }
      this.#lastPong = Date.now();
      const pending = this.#pending.get(message?.requestId);
      if (!pending) continue;
      if (message._tag === 'Chunk') {
        const values = Array.isArray(message.values) ? message.values : [];
        // Acknowledge after the consumer has processed the chunk so the server
        // applies backpressure instead of buffering unbounded events.
        Promise.resolve()
          .then(() => pending.onChunk?.(values))
          .catch(error => pending.onError?.(error))
          .finally(() => { if (this.#pending.has(message.requestId)) this.#send({ _tag: 'Ack', requestId: message.requestId }); });
      } else if (message._tag === 'Exit') {
        this.#pending.delete(message.requestId);
        if (message.exit?._tag === 'Success') pending.resolve(message.exit.value);
        else pending.reject(causeError(message.exit?.cause));
      } else if (message._tag === 'Defect') {
        this.#pending.delete(message.requestId);
        pending.reject(new T3RpcError('T3 runtime reported a protocol defect.', { code: 'RPC_DEFECT' }));
      }
    }
  }

  #shutdown(error) {
    if (this.#closed) return;
    this.#closed = true;
    this.closeReason = error;
    clearInterval(this.#ping);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    try { this.#socket.close(); } catch { /* Already closed. */ }
    for (const listener of this.#closeListeners) listener(error);
    this.#closeListeners.clear();
  }

  /** @returns {Promise<any>} */
  request(tag, payload, { timeoutMs = 60000, signal } = {}) {
    return new Promise((resolve, reject) => {
      if (this.#closed) { reject(this.closeReason); return; }
      const id = String(++this.#nextId);
      const timer = timeoutMs > 0 ? setTimeout(() => { this.#pending.delete(id); this.#send({ _tag: 'Interrupt', requestId: id }); reject(new T3RpcError(`T3 request ${tag} timed out.`, { code: 'REQUEST_TIMEOUT' })); }, timeoutMs) : null;
      const abort = () => { clearTimeout(timer); this.#pending.delete(id); this.#send({ _tag: 'Interrupt', requestId: id }); reject(signal.reason); };
      if (signal?.aborted) { clearTimeout(timer); reject(signal.reason); return; }
      signal?.addEventListener('abort', abort, { once: true });
      const settle = fn => value => { clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value); };
      this.#pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      this.#send({ _tag: 'Request', id, tag, payload, headers: [] });
    });
  }

  /**
   * Start a server stream. `onChunk(values)` may be async; the chunk is
   * acknowledged once it settles. `done` resolves when the server ends the
   * stream and rejects on failure or connection loss.
   */
  stream(tag, payload, onChunk) {
    const id = String(++this.#nextId);
    let resolveDone, rejectDone;
    const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    if (this.#closed) { rejectDone(this.closeReason); return { done, cancel() {} }; }
    this.#pending.set(id, { resolve: resolveDone, reject: rejectDone, onChunk, onError: error => { this.#pending.delete(id); this.#send({ _tag: 'Interrupt', requestId: id }); rejectDone(error); } });
    this.#send({ _tag: 'Request', id, tag, payload, headers: [] });
    return {
      done,
      cancel: () => {
        if (!this.#pending.delete(id)) return;
        this.#send({ _tag: 'Interrupt', requestId: id });
        resolveDone(undefined);
      },
    };
  }

  close() { this.#shutdown(new T3RpcError('T3 runtime connection closed by client.', { code: 'CONNECTION_CLOSED' })); }
}
