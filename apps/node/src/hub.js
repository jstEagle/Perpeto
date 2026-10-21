import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const jitter = cap => Math.floor(Math.random() * (cap + 1));
export const sleep = (ms, signal) => delay(ms, undefined, { signal });
export class HubError extends Error {
  constructor(status, code = 'HUB_UNAVAILABLE') {
    super(`Hub request failed (${status || 'network'}, ${/^[A-Za-z_]+$/.test(code) ? code : 'UNKNOWN'}).`);
    this.status = status;
    this.code = code.toLowerCase();
    this.retryable = !status || status === 408 || status === 429 || status >= 500;
  }
}

export class HubClient {
  #token;
  constructor(config, token) { this.config = config; this.#token = token; }
  setToken(token) { this.#token = token; }
  async post(path, body, { signal, key = randomUUID() } = {}) {
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
    try { data = await response.json(); } catch { throw new HubError(response.ok ? 502 : response.status); }
    if (!response.ok) throw new HubError(response.status, data?.error?.code);
    return data;
  }
  async retry(path, body, { signal, key = randomUUID() } = {}) {
    let wait = this.config.timing.backoffMinMs;
    while (true) {
      signal?.throwIfAborted();
      try { return await this.post(path, body, { signal, key }); }
      catch (error) {
        if (!error.retryable) throw error;
        await sleep(jitter(wait), signal);
        wait = Math.min(wait * 2, this.config.timing.backoffMaxMs);
      }
    }
  }
}
