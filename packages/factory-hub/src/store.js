import { DatabaseSync } from 'node:sqlite';
import { fail } from './errors.js';

/** Hub-owned data, including engine snapshots. Messaging has its own MessagingStore DB. */
export class HubStore {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) { this.db.close(); fail(500, 'SCHEMA_VERSION', 'Unsupported hub database version.'); }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id)) STRICT;
      CREATE INDEX IF NOT EXISTS entities_queue ON entities(kind, json_extract(data,'$.status'));
      CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, machine_id TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS enrollment_codes (hash TEXT PRIMARY KEY, id TEXT NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0) STRICT;
      CREATE TABLE IF NOT EXISTS idempotency (scope TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(scope,key)) STRICT;
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, type TEXT NOT NULL, project_id TEXT, run_id TEXT, subject TEXT NOT NULL, data TEXT NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS events_project ON events(project_id,seq);
      PRAGMA user_version=1;
    `);
  }
  get(kind, id) {
    const row = this.db.prepare('SELECT data FROM entities WHERE kind=? AND id=?').get(kind, id);
    return row ? JSON.parse(row.data) : null;
  }
  need(kind, id) { const value = this.get(kind, id); if (!value) fail(404, 'NOT_FOUND', `${kind} not found.`); return value; }
  put(kind, value) {
    this.db.prepare('INSERT INTO entities VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind, value.id, JSON.stringify(value));
    return value;
  }
  list(kind, predicate = () => true) {
    return this.db.prepare('SELECT data FROM entities WHERE kind=? ORDER BY rowid').all(kind).map(row => JSON.parse(row.data)).filter(predicate);
  }
  remove(kind, id) { this.db.prepare('DELETE FROM entities WHERE kind=? AND id=?').run(kind, id); }
  event(type, subject, data = {}, context = {}) {
    const at = new Date().toISOString();
    const result = this.db.prepare('INSERT INTO events(at,type,project_id,run_id,subject,data) VALUES(?,?,?,?,?,?)')
      .run(at, type, context.projectId ?? null, context.runId ?? null, JSON.stringify(subject), JSON.stringify(data));
    return { seq: Number(result.lastInsertRowid), at, type, ...context, subject, data };
  }
  events(after = 0, limit = 100) {
    return this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(after, limit).map(row => ({
      seq: row.seq, at: row.at, type: row.type, ...(row.project_id ? { projectId: row.project_id } : {}),
      ...(row.run_id ? { runId: row.run_id } : {}), subject: JSON.parse(row.subject), data: JSON.parse(row.data),
    }));
  }
  async transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = await fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
