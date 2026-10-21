import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { DeliveryError, requireValue, stableHash, stableJSON, string } from './common.js';
import { createQueueState, reduceQueue } from './machine.js';

/** SQLite snapshot + request receipts. One aggregate per repo/base queue, WAL/FULL durability. */
export class MergeQueueStore {
  #db;
  constructor(filename) {
    string(filename, 'filename');
    this.#db = new DatabaseSync(filename);
    this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    const version = this.#db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) { this.#db.close(); throw new DeliveryError('SCHEMA_VERSION', 'Unsupported delivery store version.'); }
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_queues (id TEXT PRIMARY KEY, config_hash TEXT NOT NULL, state TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS delivery_receipts (queue_id TEXT NOT NULL, key TEXT NOT NULL, body_hash TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(queue_id,key)) STRICT;
      CREATE TABLE IF NOT EXISTS delivery_locks (queue_id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL) STRICT;
      PRAGMA user_version=1;
    `);
  }
  close() { this.#db.close(); }
  #transaction(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.#db.exec('COMMIT'); return result; }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  initialize(queueId, config) {
    string(queueId, 'queueId');
    const state = createQueueState(config);
    return this.#transaction(() => {
      this.#db.prepare('INSERT INTO delivery_queues VALUES(?,?,?) ON CONFLICT(id) DO NOTHING')
        .run(queueId, stableHash(state.config), stableJSON(state));
      const row = this.#db.prepare('SELECT * FROM delivery_queues WHERE id=?').get(queueId);
      // Older delivery snapshots omitted the default publication strategy.
      if (row.config_hash !== stableHash(state.config)) {
        const saved = JSON.parse(row.state);
        if (saved.config.publication === undefined && stableHash(createQueueState(saved.config).config) === stableHash(state.config)) {
          saved.config = state.config;
          this.#db.prepare('UPDATE delivery_queues SET config_hash=?,state=? WHERE id=?')
            .run(stableHash(state.config), stableJSON(saved), queueId);
          row.config_hash = stableHash(state.config); row.state = stableJSON(saved);
        }
      }
      requireValue(row.config_hash === stableHash(state.config), 'Queue configuration differs from its persisted configuration.', 'CONFLICT');
      return JSON.parse(row.state);
    });
  }
  read(queueId) {
    const row = this.#db.prepare('SELECT state FROM delivery_queues WHERE id=?').get(queueId);
    requireValue(row, 'Queue not found.', 'NOT_FOUND');
    return JSON.parse(row.state);
  }
  receipt(queueId, key, body) {
    string(key, 'idempotencyKey');
    const row = this.#db.prepare('SELECT body_hash,result FROM delivery_receipts WHERE queue_id=? AND key=?').get(queueId, key);
    if (!row) return null;
    requireValue(row.body_hash === stableHash(body), 'Idempotency key identifies a different request.', 'IDEMPOTENCY_CONFLICT');
    return JSON.parse(row.result);
  }
  #remember(queueId, key, body, result) {
    this.#db.prepare('INSERT INTO delivery_receipts VALUES(?,?,?,?)').run(queueId, key, stableHash(body), stableJSON(result));
  }
  /** Synchronous reducer commands are transactional and retry-safe across connections. */
  dispatch(queueId, action, { idempotencyKey, token, stepKey } = {}) {
    return this.#transaction(() => {
      const original = this.receipt(queueId, idempotencyKey, action);
      if (original) return original;
      if (!['enqueue', 'result', 'withdraw'].includes(action.type)) this.assertLock(queueId, token);
      const result = reduceQueue(this.read(queueId), action);
      this.#db.prepare('UPDATE delivery_queues SET state=? WHERE id=?').run(stableJSON(result), queueId);
      this.#remember(queueId, idempotencyKey, action, result);
      // A process crash cannot separate a phase transition from its public tick receipt.
      if (stepKey) this.#remember(queueId, stepKey, { type: 'step' }, result);
      return result;
    });
  }
  acquire(queueId, leaseMs) {
    requireValue(Number.isSafeInteger(leaseMs) && leaseMs > 0, 'leaseMs must be a positive integer.');
    this.read(queueId);
    const token = randomUUID();
    const result = this.#db.prepare(`INSERT INTO delivery_locks VALUES(?,?,?)
      ON CONFLICT(queue_id) DO UPDATE SET token=excluded.token, expires_at=excluded.expires_at WHERE delivery_locks.expires_at<=?`)
      .run(queueId, token, Date.now() + leaseMs, Date.now());
    requireValue(result.changes === 1, 'Another queue worker holds the lease.', 'BUSY');
    return token;
  }
  assertLock(queueId, token) {
    const row = this.#db.prepare('SELECT token,expires_at FROM delivery_locks WHERE queue_id=?').get(queueId);
    requireValue(row && row.token === token && row.expires_at > Date.now(), 'Queue worker lease was lost.', 'LEASE_LOST');
  }
  renew(queueId, token, leaseMs) {
    this.assertLock(queueId, token);
    const result = this.#db.prepare('UPDATE delivery_locks SET expires_at=? WHERE queue_id=? AND token=?').run(Date.now() + leaseMs, queueId, token);
    requireValue(result.changes === 1, 'Queue worker lease was lost.', 'LEASE_LOST');
  }
  release(queueId, token) { this.#db.prepare('DELETE FROM delivery_locks WHERE queue_id=? AND token=?').run(queueId, token); }
  completeStep(queueId, key, result, token) {
    return this.#transaction(() => {
      this.assertLock(queueId, token);
      const original = this.receipt(queueId, key, { type: 'step' });
      if (original) return original;
      this.#remember(queueId, key, { type: 'step' }, result);
      return result;
    });
  }
}
