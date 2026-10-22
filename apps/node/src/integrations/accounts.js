import { randomUUID } from 'node:crypto';
import { readSecret } from '../config.js';
import { isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AccountPoolError, createAccountPool } from '@perpeto/accounts';

const UNAVAILABLE = new Set(['NO_ELIGIBLE_ACCOUNT', 'UNSUPPORTED_PROVIDER']);

/**
 * Node AccountProvider over `@perpeto/accounts`. The pool is bound to the machine ID, which the node only
 * knows after enrollment, so it opens on `bind`. Until then `list()` reports no accounts.
 *
 * Reservations are attempt-qualified (`<assignmentId>-<attempt>`): a re-leased attempt never reuses or releases the
 * reservation of an older one. Only `snapshot()` metadata leaves this module; bindings stay on the machine.
 *
 * @param {{ config?: { nodeDataDir?: string, selection?: 'lru'|'headroom'|'paced', defaultCooldownMs?: number, maxConcurrentPerAccount?: number, busyRetries?: number },
 *   configRoot?: string, dataDir?: string }} options
 */
export function createAccountProvider({ config = {}, configRoot = process.cwd(), dataDir } = {}) {
  // Paced by default: the hub's plan picks accounts; without a plan selection falls back to headroom, then LRU.
  const { nodeDataDir, busyRetries = 5, selection = 'paced', ...rest } = config;
  const options = { ...rest, selection };
  const root = nodeDataDir ? resolve(configRoot, nodeDataDir) : dataDir;
  if (!root || !isAbsolute(root)) throw new Error('Account pool needs the node data directory.');
  let pool; let machineId;
  const ownedReservations = new Map();
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
  const adapter = {
    kind: 'factory-accounts',
    bind({ machineId: id }) {
      if (machineId && machineId !== id) throw new Error('Account pool is already bound to another machine.');
      machineId = id;
      pool ??= createAccountPool({ ...options, nodeDataDir: root, machineId });
    },
    /** Called only by the daemon while its exclusive data-directory lock is held. */
    async prepare({ machineId: id, reEnroll = false, settledReservations = {} }) {
      let previousId = id;
      if (reEnroll) {
        try {
          previousId = JSON.parse(await readSecret(resolve(root, 'accounts', 'registry.json'))).machineId;
          if (typeof previousId !== 'string') throw new Error('Invalid local account identity.');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      adapter.bind({ machineId: previousId });
      const held = await locked(value => value.reservations());
      // The acceptance journal alone does not prove a crashed harness stopped.
      // Only exact tokens durably recorded after executor settlement can be freed.
      // Bulk complement-based reconciliation can delete a token created after this snapshot.
      // Fenced releases affect only the exact stopped tokens we can prove are ours.
      const reconciliationKey = `startup:${randomUUID()}`;
      for (const heldReservation of held) {
        if (!Object.hasOwn(settledReservations, heldReservation.assignmentId) || settledReservations[heldReservation.assignmentId] !== heldReservation.id) continue;
        try {
          await locked(value => value.release({ assignmentId: heldReservation.assignmentId,
            reservationId: heldReservation.id, idempotencyKey: `${reconciliationKey}:${heldReservation.id}` }));
        } catch (error) {
          if (!(error instanceof AccountPoolError) || error.code !== 'RESERVATION_ENDED') throw error;
        }
      }
      if (previousId !== id) {
        const rebindKey = `rebind:${randomUUID()}`;
        await locked(value => value.rebindMachine({ machineId: id, idempotencyKey: rebindKey }));
        machineId = id;
      }
    },
    /** After executor settlement, report only a still-held token acquired by this handle. */
    async settledReservation({ assignmentId, attempt = 1 }) {
      const id = reservation({ assignmentId, attempt });
      const token = ownedReservations.get(id);
      if (!token) return undefined;
      return locked(value => value.reservations().some(held => held.assignmentId === id && held.id === token) ? token : undefined);
    },
    /** Public Account[] for heartbeats. */
    async list() { return pool ? locked(value => value.snapshot()) : []; },
    /**
     * Reserve an account for one assignment attempt. Returns `{ account, binding, reservation }`, or null only when this provider has no
     * enrolled accounts/pool support. ACCOUNT_POOL_EXHAUSTED propagates; never fall back on exhaustion.
     */
    async acquire({ provider, assignmentId, attempt = 1 }) {
      const id = reservation({ assignmentId, attempt });
      try {
        const selected = await locked(value => value.select({ provider, assignmentId: id, idempotencyKey: `select:${id}` }));
        ownedReservations.set(id, selected.reservation.id);
        return selected;
      }
      catch (error) { if (error instanceof AccountPoolError && UNAVAILABLE.has(error.code)) return null; throw error; }
    },
    async renewReservation({ assignmentId, attempt = 1, reservationId, idempotencyKey }) {
      const id = reservation({ assignmentId, attempt });
      if (typeof idempotencyKey !== 'string' || !idempotencyKey) throw new Error('Reservation renewal requires a fresh idempotency key.');
      return locked(value => value.renewReservation({ assignmentId: id, reservationId, idempotencyKey }));
    },
    async release(selection, { assignmentId, attempt = 1, reservationId = selection?.reservation?.id, result }) {
      const id = reservation({ assignmentId, attempt });
      const released = await locked(value => value.release({ assignmentId: id,
        ...(reservationId ? { reservationId } : {}), ...(result !== undefined ? { result } : {}),
        idempotencyKey: `release:${id}${reservationId ? `:${reservationId}` : ''}` }));
      if (ownedReservations.get(id) === reservationId) ownedReservations.delete(id);
      return released;
    },
    /** Feed a provider error or usage update so limits cool the account and auth failures mark it invalid. */
    async observe({ accountId, message, plan, reservationId, idempotencyKey }) {
      return locked(value => value.observe({ accountId, message, ...(plan !== undefined ? { plan } : {}), ...(reservationId ? { reservationId } : {}), idempotencyKey }));
    },
    /** Hub pacing allowances, `{ [localAccountId]: targetAgents }`, or null when the hub publishes no plan. */
    setPacing(allowances) { pool?.setPacing(allowances); },
    /** Operator label/plan changes the hub relays; the key makes a repeated relay a no-op. */
    async updateAccount({ accountId, label, plan, idempotencyKey }) {
      return locked(value => value.update({ accountId, ...(label !== undefined ? { label } : {}), ...(plan !== undefined ? { plan } : {}), idempotencyKey }));
    },
    /** Recheck eligibility immediately before launching a thread with this account. Local only. */
    async bindingFor(accountId, options) { return locked(value => value.bindingFor(accountId, options)); },
    get pool() { return pool; },
    async close() {},
  };
  return adapter;
}
