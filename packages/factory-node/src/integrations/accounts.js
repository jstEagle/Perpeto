import { isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AccountPoolError, createAccountPool } from '../../../factory-accounts/src/index.js';

const UNAVAILABLE = new Set(['NO_ELIGIBLE_ACCOUNT', 'UNSUPPORTED_PROVIDER']);

/**
 * Node AccountProvider over `@perpeto/factory-accounts`. The pool is bound to the machine ID, which the node only
 * knows after enrollment, so it opens on `bind`. Until then `list()` reports no accounts.
 *
 * Reservations are attempt-qualified (`<assignmentId>-<attempt>`): a re-leased attempt never reuses or releases the
 * reservation of an older one. Only `snapshot()` metadata leaves this module; bindings stay on the machine.
 *
 * @param {{ config?: { nodeDataDir?: string, selection?: 'lru'|'headroom', defaultCooldownMs?: number, maxConcurrentPerAccount?: number, busyRetries?: number },
 *   configRoot?: string, dataDir?: string }} options
 */
export function createAccountProvider({ config = {}, configRoot = process.cwd(), dataDir } = {}) {
  const { nodeDataDir, busyRetries = 5, ...options } = config;
  const root = nodeDataDir ? resolve(configRoot, nodeDataDir) : dataDir;
  if (!root || !isAbsolute(root)) throw new Error('Account pool needs the node data directory.');
  let pool; let machineId;
  const open = () => {
    if (!pool) throw new Error('Account pool is not bound to an enrolled machine.');
    return pool;
  };
  // The pool serialises mutations with a cross-process lock and fails fast when it is held; retry briefly.
  async function locked(fn) {
    for (let attempt = 0; ; attempt++) {
      try { return fn(open()); } catch (error) {
        if (!(error instanceof AccountPoolError) || error.code !== 'ACCOUNT_POOL_BUSY' || attempt >= busyRetries) throw error;
        await delay(10 * 2 ** attempt);
      }
    }
  }
  const reservation = ({ assignmentId, attempt = 1 }) => `${assignmentId}-${attempt}`;
  return {
    kind: 'factory-accounts',
    bind({ machineId: id }) {
      if (machineId && machineId !== id) throw new Error('Account pool is already bound to another machine.');
      machineId = id;
      pool ??= createAccountPool({ ...options, nodeDataDir: root, machineId });
    },
    /** Public Account[] for heartbeats. */
    async list() { return pool ? locked(value => value.snapshot()) : []; },
    /**
     * Reserve an account for one assignment attempt. Returns `{ account, binding }`, or null when this provider has no
     * pool support or no eligible account, so the executor can fall back to the provider's default login.
     */
    async acquire({ provider, assignmentId, attempt = 1 }) {
      const id = reservation({ assignmentId, attempt });
      try { return await locked(value => value.select({ provider, assignmentId: id, idempotencyKey: `select:${id}` })); }
      catch (error) { if (error instanceof AccountPoolError && UNAVAILABLE.has(error.code)) return null; throw error; }
    },
    async release(_selection, { assignmentId, attempt = 1 }) {
      const id = reservation({ assignmentId, attempt });
      return locked(value => value.release({ assignmentId: id, idempotencyKey: `release:${id}` }));
    },
    /** Feed a provider error or usage update so limits cool the account and auth failures mark it invalid. */
    async observe({ accountId, message, idempotencyKey }) { return locked(value => value.observe({ accountId, message, idempotencyKey })); },
    /** Recheck eligibility immediately before launching a thread with this account. Local only. */
    async bindingFor(accountId) { return locked(value => value.bindingFor(accountId)); },
    get pool() { return pool; },
    async close() {},
  };
}
