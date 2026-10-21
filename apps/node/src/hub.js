import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const jitter = cap => Math.floor(Math.random() * (cap + 1));
export const sleep = (ms, signal) => delay(ms, undefined, { signal });
export class HubError extends Error {
  constructor(status, code = 'HUB_UNAVAILABLE') {
    super(code.toLowerCase() === 'machine_revoked' ? 'Machine revoked; re-enroll with a new enrollment code.' : `Hub request failed (${status || 'network'}, ${/^[A-Za-z_]+$/.test(code) ? code : 'UNKNOWN'}).`);
    this.status = status;
    this.code = code.toLowerCase();
    this.retryable = !status || status === 408 || status === 429 || status >= 500;
  }
}

export class HubClient {
  #token;
  #gate = Promise.resolve();
  #active = 0;
  #idle;
  constructor(config, token, { onUnauthorized } = {}) { this.config = config; this.#token = token; this.onUnauthorized = onUnauthorized; }
  async #access(fn) {
    while (true) {
      const gate = this.#gate;
      await gate;
      if (gate !== this.#gate) continue;
      this.#active++;
      try { return await fn(); }
      finally { if (--this.#active === 0) { this.#idle?.(); this.#idle = undefined; } }
    }
  }
  withTokenRotation(fn) {
    const previous = this.#gate;
    let release;
    this.#gate = new Promise(resolve => { release = resolve; });
    return (async () => {
      await previous;
      if (this.#active) await new Promise(resolve => { this.#idle = resolve; });
      return fn({ post: (...args) => this.#post(...args), retry: (...args) => this.#retry(...args) });
    })().finally(release);
  }
  setToken(token) { this.#token = token; }
  post(...args) { return this.#access(() => this.#post(...args)); }
  retry(...args) { return this.#access(() => this.#retry(...args)); }
  async #post(path, body, { signal, key = randomUUID() } = {}) {
    signal?.throwIfAborted();
    let response;
    try {
      response = await fetch(`${this.config.hubUrl}/api/v1${path}`, {
        method: 'POST', redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(this.config.timing.requestMs), ...(signal ? [signal] : [])]),
        headers: { 'Content-Type': 'application/json', ...(this.#token ? { Authorization: `Bearer ${this.#token}` } : {}) },
        body: JSON.stringify({ ...body, idempotencyKey: key }),
      });
    } catch {
      signal?.throwIfAborted();
      throw new HubError(0);
    }
    let data;
    try { data = await response.json(); } catch { if (response.status !== 401) throw new HubError(response.ok ? 502 : response.status); }
    if (response.status === 401 && this.#token && path !== '/nodes/enroll') {
      const error = new HubError(401, 'MACHINE_REVOKED');
      this.onUnauthorized?.(error);
      throw error;
    }
    if (!response.ok) throw new HubError(response.status, data?.error?.code);
    return data;
  }
  async #retry(path, body, { signal, key = randomUUID() } = {}) {
    let wait = this.config.timing.backoffMinMs;
    while (true) {
      signal?.throwIfAborted();
      try { return await this.#post(path, body, { signal, key }); }
      catch (error) {
        if (!error.retryable) throw error;
        await sleep(jitter(wait), signal);
        wait = Math.min(wait * 2, this.config.timing.backoffMaxMs);
      }
    }
  }
}
