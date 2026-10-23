import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { requireValue, stableHash, stableJSON, string } from './common.js';
import { createQueueState, reduceQueue } from './machine.js';
import { inverseEdits, undoEdits } from './history.js';

/**
 * Actions that commit without the worker lease: submissions, and owner commands whose single transition is safe
 * against a concurrent step (the step's next dispatch revalidates its attempt and stops if it is gone).
 */
const LOCK_FREE = ['enqueue', 'result', 'freeze', 'unfreeze', 'eject', 'requeue-entry', 'prioritize'];

/** SQLite snapshot + request receipts. One aggregate per repo/base queue, WAL/FULL durability. */
export class MergeQueueStore {
  #db;
  constructor(filename, { maxReceipts = 10_000, receiptRetentionMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
    string(filename, 'filename');
    requireValue(Number.isSafeInteger(maxReceipts) && maxReceipts > 0, 'maxReceipts must be a positive integer.');
    requireValue(Number.isSafeInteger(receiptRetentionMs) && receiptRetentionMs > 0, 'receiptRetentionMs must be a positive integer.');
    this.maxReceipts = maxReceipts; this.receiptRetentionMs = receiptRetentionMs;
    this.#db = new DatabaseSync(filename);
    this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    try {
      this.#transaction(() => {
        const version = this.#db.prepare('PRAGMA user_version').get().user_version;
        requireValue(version <= 2, 'Unsupported delivery store version.', 'SCHEMA_VERSION');
        this.#db.exec(`
          CREATE TABLE IF NOT EXISTS delivery_queues (id TEXT PRIMARY KEY, config_hash TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0) STRICT;
          CREATE TABLE IF NOT EXISTS delivery_receipts (queue_id TEXT NOT NULL, key TEXT NOT NULL, body_hash TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(queue_id,key)) STRICT;
          CREATE TABLE IF NOT EXISTS delivery_locks (queue_id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS delivery_revisions (queue_id TEXT NOT NULL, revision INTEGER NOT NULL, undo TEXT NOT NULL, PRIMARY KEY(queue_id,revision)) STRICT;
        `);
        if (version === 1) {
          this.#db.exec('ALTER TABLE delivery_queues ADD COLUMN revision INTEGER NOT NULL DEFAULT 0; ALTER TABLE delivery_receipts ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;');
          this.#db.prepare('UPDATE delivery_receipts SET created_at=?').run(Date.now());
          for (const { id } of this.#db.prepare('SELECT id FROM delivery_queues').all()) this.#prune(id);
          // Preserve old retry responses without retaining whole legacy snapshots.
          for (const row of this.#db.prepare('SELECT rowid,queue_id,result FROM delivery_receipts').all()) {
            const original = JSON.parse(row.result);
            this.#db.prepare('UPDATE delivery_receipts SET result=? WHERE rowid=?')
              .run(stableJSON({ revision: 0, undo: inverseEdits(original, this.read(row.queue_id)) }), row.rowid);
          }
        }
        this.#db.exec('CREATE INDEX IF NOT EXISTS delivery_receipts_age ON delivery_receipts(queue_id,created_at); PRAGMA user_version=2;');
        for (const { id } of this.#db.prepare('SELECT id FROM delivery_queues').all()) this.#prune(id);
      });
    } catch (error) {
      this.#db.close(); throw error;
    }
  }
  close() { this.#db.close(); }
  #transaction(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.#db.exec('COMMIT'); return result; }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  initialize(queueId, config, { reconfigure = false, at } = {}) {
    string(queueId, 'queueId');
    const state = createQueueState(config);
    return this.#transaction(() => {
      this.#db.prepare('INSERT INTO delivery_queues(id,config_hash,state) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING')
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
      if (row.config_hash !== stableHash(state.config) && reconfigure) return this.#reconfigure(queueId, config, at);
      requireValue(row.config_hash === stableHash(state.config), 'Queue configuration differs from its persisted configuration.', 'CONFLICT');
      return JSON.parse(row.state);
    });
  }
  /** Adopt a changed configuration through the reducer, inside initialize's transaction, keeping undo history. */
  #reconfigure(queueId, config, at) {
    const before = this.read(queueId);
    const result = reduceQueue(before, { type: 'configure', config, ...(at !== undefined ? { at } : {}) });
    const undo = inverseEdits(before, result);
    const { revision } = this.#db.prepare('UPDATE delivery_queues SET state=?,config_hash=?,revision=revision+1 WHERE id=? RETURNING revision')
      .get(stableJSON(result), stableHash(result.config), queueId);
    if (undo.length) this.#db.prepare('INSERT INTO delivery_revisions VALUES(?,?,?)').run(queueId, revision, stableJSON(undo));
    return result;
  }
  read(queueId) {
    const row = this.#db.prepare('SELECT state FROM delivery_queues WHERE id=?').get(queueId);
    requireValue(row, 'Queue not found.', 'NOT_FOUND');
    return JSON.parse(row.state);
  }
  receipt(queueId, key, body) {
    string(key, 'idempotencyKey');
    // One SQLite read snapshot keeps the current state and its inverse history
    // consistent even if a different process commits while replay is reading.
    const row = this.#db.prepare(`SELECT r.body_hash,r.result,q.state,
      (SELECT json_group_array(json(undo)) FROM
        (SELECT undo FROM delivery_revisions WHERE queue_id=r.queue_id
          AND revision>json_extract(r.result,'$.revision') ORDER BY revision DESC)) AS history
      FROM delivery_receipts r JOIN delivery_queues q ON q.id=r.queue_id
      WHERE r.queue_id=? AND r.key=? AND r.created_at>?`).get(queueId, key, Date.now() - this.receiptRetentionMs);
    if (!row) return null;
    requireValue(row.body_hash === stableHash(body), 'Idempotency key identifies a different request.', 'IDEMPOTENCY_CONFLICT');
    const receipt = JSON.parse(row.result);
    let result = JSON.parse(row.state);
    for (const edits of JSON.parse(row.history)) result = undoEdits(result, edits);
    return receipt.undo ? undoEdits(result, receipt.undo) : result;
  }
  #remember(queueId, key, body, revision) {
    this.#db.prepare('INSERT INTO delivery_receipts VALUES(?,?,?,?,?)').run(queueId, key, stableHash(body), stableJSON({ revision }), Date.now());
  }
  #prune(queueId) {
    this.#db.prepare('DELETE FROM delivery_receipts WHERE queue_id=? AND created_at<=?').run(queueId, Date.now() - this.receiptRetentionMs);
    this.#db.prepare(`DELETE FROM delivery_receipts WHERE rowid IN
      (SELECT rowid FROM delivery_receipts WHERE queue_id=? ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET ?)`)
      .run(queueId, this.maxReceipts);
    // Only inverse edits newer than the oldest retained response are needed.
    this.#db.prepare(`DELETE FROM delivery_revisions WHERE queue_id=? AND revision<=COALESCE(
      (SELECT min(json_extract(result,'$.revision')) FROM delivery_receipts WHERE queue_id=?),
      (SELECT revision FROM delivery_queues WHERE id=?))`).run(queueId, queueId, queueId);
  }
  /** Synchronous reducer commands are transactional and retry-safe across connections. */
  dispatch(queueId, action, { idempotencyKey, token, stepKey, receiptBody = action } = {}) {
    return this.#transaction(() => {
      this.#prune(queueId);
      const original = stepKey ? this.receipt(queueId, stepKey, { type: 'step' }) : this.receipt(queueId, idempotencyKey, receiptBody);
      if (original) return original;
      if (!LOCK_FREE.includes(action.type)) this.assertLock(queueId, token);
      const before = this.read(queueId);
      const result = reduceQueue(before, action);
      const undo = inverseEdits(before, result);
      if (!undo.length) return result;
      const { revision } = this.#db.prepare('UPDATE delivery_queues SET state=?,config_hash=?,revision=revision+1 WHERE id=? RETURNING revision').get(stableJSON(result), stableHash(result.config), queueId);
      this.#db.prepare('INSERT INTO delivery_revisions VALUES(?,?,?)').run(queueId, revision, stableJSON(undo));
      // A process crash cannot separate a phase transition from its public tick receipt.
      if (stepKey) this.#remember(queueId, stepKey, { type: 'step' }, revision);
      else this.#remember(queueId, idempotencyKey, receiptBody, revision);
      this.#prune(queueId);
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
      // Transitions write their tick receipt in the same transaction. An idle
      // tick has no effect to deduplicate and must not add receipt/history rows.
      return result;
    });
  }
}
