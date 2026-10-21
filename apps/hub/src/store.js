import { DatabaseSync } from 'node:sqlite';
import { fail } from './errors.js';

const SCHEMA_VERSION = 2;
const TERMINAL = { assignment: ['succeeded', 'failed', 'cancelled'], job: ['passed', 'failed', 'cancelled', 'error'] };
const USAGE_KEYS = ['run_id', 'assignment_id', 'machine_id', 'account_id', 'provider', 'model'];
const TOKENS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'];
const camel = { project_id: 'projectId', run_id: 'runId', assignment_id: 'assignmentId', machine_id: 'machineId', account_id: 'accountId',
  provider: 'provider', model: 'model', input_tokens: 'inputTokens', output_tokens: 'outputTokens', cache_read_tokens: 'cacheReadTokens', cache_write_tokens: 'cacheWriteTokens' };
const json = field => `json_extract(data,'$.${field}')`;
const hour = value => `${value.slice(0, 13)}:00:00.000Z`;
const marks = values => values.map(() => '?').join(',');

/**
 * Hub-owned data. Entities are JSON rows; hot reads go through expression indexes on status, machine, run, project,
 * lease expiry and finish time, so they touch open work rather than everything ever written. Usage and job logs have
 * their own tables. Finished work, events and usage past their retention move to archive tables and hourly rollups.
 * Messaging and the workflow run store have their own databases.
 */
export class HubStore {
  #statements = new Map();
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > SCHEMA_VERSION) { this.db.close(); fail(500, 'SCHEMA_VERSION', 'Unsupported hub database version.'); }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id)) STRICT;
      CREATE INDEX IF NOT EXISTS entities_queue ON entities(kind, ${json('status')});
      CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, machine_id TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS enrollment_codes (hash TEXT PRIMARY KEY, id TEXT NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0) STRICT;
      CREATE TABLE IF NOT EXISTS idempotency (scope TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(scope,key)) STRICT;
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, type TEXT NOT NULL, project_id TEXT, run_id TEXT, subject TEXT NOT NULL, data TEXT NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS events_project ON events(project_id,seq);
    `);
    if (version < 2) this.#migrate();
  }
  #migrate() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const at = new Date().toISOString();
      this.db.exec(`
        CREATE INDEX entities_machine ON entities(kind, ${json('machineId')}, ${json('status')});
        CREATE INDEX entities_run ON entities(kind, ${json('runId')});
        CREATE INDEX entities_project ON entities(kind, ${json('projectId')});
        CREATE INDEX entities_expiry ON entities(kind, ${json('leaseExpiresAt')});
        CREATE INDEX entities_finished ON entities(kind, ${json('finishedAt')});
        CREATE INDEX events_run ON events(run_id, seq);
        CREATE INDEX events_at ON events(at);
        ALTER TABLE idempotency ADD COLUMN created_at TEXT NOT NULL DEFAULT '${at}';
        CREATE INDEX idempotency_created ON idempotency(created_at);
        CREATE TABLE usage (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, run_id TEXT, assignment_id TEXT, machine_id TEXT, account_id TEXT,
          provider TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL,
          cache_write_tokens INTEGER NOT NULL, cost_usd REAL, at TEXT NOT NULL) STRICT;
        CREATE INDEX usage_at ON usage(at);
        CREATE INDEX usage_project ON usage(project_id, at);
        CREATE INDEX usage_run ON usage(run_id, at);
        CREATE TABLE usage_rollups (hour TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL, assignment_id TEXT NOT NULL, machine_id TEXT NOT NULL,
          account_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
          cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, cost_usd REAL NOT NULL, records INTEGER NOT NULL,
          PRIMARY KEY(hour, project_id, run_id, assignment_id, machine_id, account_id, provider, model)) STRICT;
        CREATE INDEX usage_rollups_run ON usage_rollups(run_id, hour);
        CREATE TABLE job_logs (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, job_id TEXT NOT NULL, chunk TEXT NOT NULL, at TEXT NOT NULL) STRICT;
        CREATE INDEX job_logs_job ON job_logs(job_id, seq);
        CREATE TABLE message_interactions (message_id TEXT PRIMARY KEY, at TEXT NOT NULL) STRICT;
        CREATE INDEX message_interactions_at ON message_interactions(at);
        CREATE TABLE archived_entities (kind TEXT NOT NULL, id TEXT NOT NULL, run_id TEXT, project_id TEXT, data TEXT NOT NULL, archived_at TEXT NOT NULL, PRIMARY KEY(kind,id)) STRICT;
        CREATE INDEX archived_entities_run ON archived_entities(kind, run_id);
        CREATE TABLE archived_events (seq INTEGER PRIMARY KEY, at TEXT NOT NULL, type TEXT NOT NULL, project_id TEXT, run_id TEXT, subject TEXT NOT NULL, data TEXT NOT NULL) STRICT;
      `);
      // Schema 1 kept usage and job logs as entities, and never recorded when work finished.
      for (const row of this.db.prepare("SELECT data FROM entities WHERE kind='usage'").all()) this.usage(JSON.parse(row.data));
      for (const row of this.db.prepare("SELECT data FROM entities WHERE kind='job-log' ORDER BY rowid").all()) {
        const log = JSON.parse(row.data); this.log(log.jobId, log.chunk, log.at, log.id);
      }
      this.db.exec("DELETE FROM entities WHERE kind IN ('usage','job-log')");
      for (const [kind, statuses] of Object.entries(TERMINAL)) {
        for (const value of this.byStatus(kind, statuses)) if (!value.finishedAt) this.put(kind, { ...value, finishedAt: value.updatedAt ?? value.createdAt ?? at });
      }
      this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error; }
  }
  #sql(text) {
    let statement = this.#statements.get(text);
    if (!statement) { statement = this.db.prepare(text); this.#statements.set(text, statement); }
    return statement;
  }
  get(kind, id) {
    const row = this.#sql('SELECT data FROM entities WHERE kind=? AND id=?').get(kind, id);
    return row ? JSON.parse(row.data) : null;
  }
  /** An entity, or its archived copy once finished work has left the hot table. */
  find(kind, id) {
    const value = this.get(kind, id);
    if (value) return value;
    const row = this.#sql('SELECT data FROM archived_entities WHERE kind=? AND id=?').get(kind, id);
    return row ? JSON.parse(row.data) : null;
  }
  need(kind, id) { const value = this.get(kind, id); if (!value) fail(404, 'NOT_FOUND', `${kind} not found.`); return value; }
  put(kind, value) {
    // Retention counts from when work finished.
    if (TERMINAL[kind]?.includes(value.status) && !value.finishedAt) value.finishedAt = new Date().toISOString();
    this.#sql('INSERT INTO entities VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind, value.id, JSON.stringify(value));
    this.onPut?.(kind, value);
    return value;
  }
  /** Whole-kind scan. Only for kinds that stay small (machines, projects, cancellations, delivery queues). */
  list(kind, predicate = () => true) {
    return this.#sql('SELECT data FROM entities WHERE kind=? ORDER BY rowid').all(kind).map(row => JSON.parse(row.data)).filter(predicate);
  }
  /** Rows of a kind in the given statuses, through the status index. */
  byStatus(kind, statuses, predicate = () => true) {
    return this.#sql(`SELECT data FROM entities WHERE kind=? AND ${json('status')} IN (${marks(statuses)}) ORDER BY rowid`)
      .all(kind, ...statuses).map(row => JSON.parse(row.data)).filter(predicate);
  }
  /** One page of queued rows after `after` (a rowid), oldest first, so callers can stop as soon as they are served. */
  queuedPage(kind, after, limit) {
    return this.#sql(`SELECT rowid, data FROM entities WHERE kind=? AND ${json('status')}='queued' AND rowid>? ORDER BY rowid LIMIT ?`)
      .all(kind, after, limit).map(row => ({ rowid: row.rowid, value: JSON.parse(row.data) }));
  }
  /** Leases a machine holds, through the machine index. */
  held(kind, machineId) {
    return this.#sql(`SELECT data FROM entities WHERE kind=? AND ${json('machineId')}=? AND ${json('status')} IN ('leased','running')`)
      .all(kind, machineId).map(row => JSON.parse(row.data));
  }
  /** Active rows whose lease has passed `at`, through the expiry index. */
  expired(kind, at) {
    return this.#sql(`SELECT data FROM entities WHERE kind=? AND ${json('leaseExpiresAt')}<=? ORDER BY rowid`).all(kind, at)
      .map(row => JSON.parse(row.data)).filter(value => ['leased', 'running'].includes(value.status));
  }
  count(kind, statuses, projectId) {
    return projectId
      ? this.#sql(`SELECT COUNT(*) AS count FROM entities WHERE kind=? AND ${json('status')} IN (${marks(statuses)}) AND ${json('projectId')}=?`).get(kind, ...statuses, projectId).count
      : this.#sql(`SELECT COUNT(*) AS count FROM entities WHERE kind=? AND ${json('status')} IN (${marks(statuses)})`).get(kind, ...statuses).count;
  }
  /** Rows for one run or project, hot and archived, through the run and project indexes. */
  forRun(kind, runId, archived = true) {
    return [...this.#sql(`SELECT data FROM entities WHERE kind=? AND ${json('runId')}=? ORDER BY rowid`).all(kind, runId),
      ...(archived ? this.#sql('SELECT data FROM archived_entities WHERE kind=? AND run_id=? ORDER BY rowid').all(kind, runId) : [])].map(row => JSON.parse(row.data));
  }
  forProject(kind, projectId) {
    return this.#sql(`SELECT data FROM entities WHERE kind=? AND ${json('projectId')}=? ORDER BY rowid`).all(kind, projectId).map(row => JSON.parse(row.data));
  }
  remove(kind, id) { this.#sql('DELETE FROM entities WHERE kind=? AND id=?').run(kind, id); }
  event(type, subject, data = {}, context = {}) {
    const at = new Date().toISOString();
    const result = this.#sql('INSERT INTO events(at,type,project_id,run_id,subject,data) VALUES(?,?,?,?,?,?)')
      .run(at, type, context.projectId ?? null, context.runId ?? null, JSON.stringify(subject), JSON.stringify(data));
    this.onEvent?.();
    return { seq: Number(result.lastInsertRowid), at, type, ...context, subject, data };
  }
  #event(row) {
    return { seq: row.seq, at: row.at, type: row.type, ...(row.project_id ? { projectId: row.project_id } : {}),
      ...(row.run_id ? { runId: row.run_id } : {}), subject: JSON.parse(row.subject), data: JSON.parse(row.data) };
  }
  events(after = 0, limit = 100) { return this.#sql('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(after, limit).map(row => this.#event(row)); }
  /** Events since `from` for one run or project, in one indexed query. */
  eventsSince(from, { projectId, runId } = {}) {
    const rows = runId ? this.#sql('SELECT * FROM events WHERE run_id=? AND at>=? ORDER BY seq').all(runId, from)
      : projectId ? this.#sql('SELECT * FROM events WHERE project_id=? AND at>=? ORDER BY seq').all(projectId, from)
        : this.#sql('SELECT * FROM events WHERE at>=? ORDER BY seq').all(from);
    return rows.map(row => this.#event(row));
  }
  idempotent(scope, key) { return this.#sql('SELECT fingerprint,response FROM idempotency WHERE scope=? AND key=?').get(scope, key); }
  remember(scope, key, fingerprint, response) {
    this.#sql('INSERT INTO idempotency(scope,key,fingerprint,response,created_at) VALUES(?,?,?,?,?)').run(scope, key, fingerprint, response, new Date().toISOString());
  }
  /** Record an agent.messaged interaction once per message; returns false if it was already recorded. */
  messageOnce(messageId) {
    return this.#sql('INSERT INTO message_interactions VALUES(?,?) ON CONFLICT(message_id) DO NOTHING').run(messageId, new Date().toISOString()).changes === 1;
  }
  log(jobId, chunk, at, id) { this.#sql('INSERT INTO job_logs(id,job_id,chunk,at) VALUES(?,?,?,?)').run(id, jobId, chunk, at); }
  logs(jobId) { return this.#sql('SELECT id,job_id,chunk,at FROM job_logs WHERE job_id=? ORDER BY seq').all(jobId).map(row => ({ id: row.id, jobId: row.job_id, chunk: row.chunk, at: row.at })); }
  usage(record) {
    this.#sql(`INSERT INTO usage VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(record.id, record.projectId, record.runId ?? null, record.assignmentId ?? null,
      record.machineId ?? null, record.accountId ?? null, record.provider, record.model, record.inputTokens, record.outputTokens,
      record.cacheReadTokens, record.cacheWriteTokens, record.costUsd ?? null, record.at);
  }
  /**
   * Usage rows, raw and rolled up, matching `filters` (project, run, machine, account, provider, model) between `from`
   * and `to`. Rollups carry an hour instead of an exact time; one counts if its hour starts within [floor(from), to].
   */
  #usageSql(filters, from, to) {
    const where = []; const args = [];
    for (const key of ['project_id', ...USAGE_KEYS.filter(name => name !== 'assignment_id')]) {
      const value = filters[camel[key]];
      if (value !== undefined && value !== null) { where.push(`${key}=?`); args.push(value); }
    }
    const raw = [...where]; const rawArgs = [...args]; const rolled = [...where]; const rolledArgs = [...args];
    if (from) { raw.push('at>=?'); rawArgs.push(from); rolled.push('hour>=?'); rolledArgs.push(hour(from)); }
    if (to) { raw.push('at<=?'); rawArgs.push(to); rolled.push('hour<=?'); rolledArgs.push(to); }
    const clause = list => list.length ? `WHERE ${list.join(' AND ')}` : '';
    return {
      sql: `SELECT project_id, run_id, assignment_id, machine_id, account_id, provider, model, ${TOKENS.join(', ')}, COALESCE(cost_usd,0) AS cost_usd, 1 AS records, at, 0 AS rolled FROM usage ${clause(raw)}
        UNION ALL SELECT project_id, NULLIF(run_id,''), NULLIF(assignment_id,''), NULLIF(machine_id,''), NULLIF(account_id,''), provider, model, ${TOKENS.join(', ')}, cost_usd, records, hour AS at, 1 AS rolled FROM usage_rollups ${clause(rolled)}`,
      args: [...rawArgs, ...rolledArgs],
    };
  }
  /** Grouped usage totals over raw and rolled-up usage. `group` is provider, model, machine or day. */
  usageGroups(filters, { from, to, group }) {
    const { sql, args } = this.#usageSql(filters, from, to);
    const key = { provider: 'provider', model: 'model', machine: 'machine_id', day: 'substr(at,1,10)' }[group];
    return this.db.prepare(`SELECT ${key} AS key, ${TOKENS.map(name => `SUM(${name}) AS ${name}`).join(', ')}, SUM(cost_usd) AS cost_usd, SUM(records) AS records
      FROM (${sql}) GROUP BY ${key} ORDER BY ${key}`).all(...args).map(row => ({ key: row.key,
      inputTokens: row.input_tokens, outputTokens: row.output_tokens, cacheReadTokens: row.cache_read_tokens, cacheWriteTokens: row.cache_write_tokens,
      costUsd: row.cost_usd, records: row.records }));
  }
  /** Usage records for metrics; a rollup becomes one record per hour with its summed tokens. */
  usageRecords(filters, from, to) {
    const { sql, args } = this.#usageSql(filters, from, to);
    return this.db.prepare(sql).all(...args).map((row, index) => ({ ...(row.rolled ? { id: `rollup_${index}` } : {}),
      ...Object.fromEntries(['project_id', ...USAGE_KEYS, ...TOKENS].filter(name => row[name] !== null).map(name => [camel[name], row[name]])),
      ...(row.cost_usd ? { costUsd: row.cost_usd } : {}), at: row.at, ...(row.rolled ? { records: row.records } : {}) }));
  }
  tokensSince(from, projectId) {
    const { sql, args } = this.#usageSql({ projectId }, from);
    return this.db.prepare(`SELECT COALESCE(SUM(${TOKENS.join('+')}),0) AS total FROM (${sql})`).get(...args).total;
  }
  /**
   * Retention, in bounded batches so one sweep never holds the write lock for long. Finished assignments and jobs
   * and events older than their cutoffs move to archive tables (or are deleted when `archive` is false), raw usage
   * older than its cutoff folds into hourly rollups, and idempotency and message records expire. Returns counts.
   */
  sweep({ finishedBefore, eventsBefore, usageBefore, idempotencyBefore, archive, batch = 500 }) {
    const counts = { assignments: 0, jobs: 0, events: 0, usage: 0, idempotency: 0 };
    const archivedAt = new Date().toISOString();
    for (const kind of ['assignment', 'job']) {
      const rows = this.#sql(`SELECT id, data FROM entities WHERE kind=? AND ${json('finishedAt')}<? LIMIT ?`).all(kind, finishedBefore, batch);
      for (const row of rows) {
        const value = JSON.parse(row.data);
        if (!TERMINAL[kind].includes(value.status)) continue;
        if (archive) this.#sql('INSERT OR REPLACE INTO archived_entities VALUES(?,?,?,?,?,?)').run(kind, row.id, value.runId ?? null, value.projectId ?? null, row.data, archivedAt);
        else this.#sql('DELETE FROM job_logs WHERE job_id=?').run(row.id);
        this.remove(kind, row.id); counts[`${kind}s`]++;
      }
    }
    const last = this.#sql('SELECT MAX(seq) AS seq FROM (SELECT seq FROM events WHERE at<? ORDER BY seq LIMIT ?)').get(eventsBefore, batch * 10).seq;
    if (last) {
      if (archive) this.#sql('INSERT OR REPLACE INTO archived_events SELECT * FROM events WHERE seq<=?').run(last);
      counts.events = Number(this.#sql('DELETE FROM events WHERE seq<=?').run(last).changes);
    }
    const keys = ['project_id', ...USAGE_KEYS];
    this.#sql(`INSERT INTO usage_rollups SELECT substr(at,1,13)||':00:00.000Z', project_id, ${USAGE_KEYS.map(name => `COALESCE(${name},'')`).join(', ')},
      ${TOKENS.map(name => `SUM(${name})`).join(', ')}, SUM(COALESCE(cost_usd,0)), COUNT(*) FROM usage WHERE at<? GROUP BY substr(at,1,13), ${keys.join(', ')}
      ON CONFLICT(hour, project_id, run_id, assignment_id, machine_id, account_id, provider, model) DO UPDATE SET ${[...TOKENS, 'cost_usd', 'records'].map(name => `${name}=${name}+excluded.${name}`).join(', ')}`).run(usageBefore);
    counts.usage = Number(this.#sql('DELETE FROM usage WHERE at<?').run(usageBefore).changes);
    counts.idempotency = Number(this.#sql('DELETE FROM idempotency WHERE created_at<?').run(idempotencyBefore).changes);
    this.#sql('DELETE FROM message_interactions WHERE at<?').run(idempotencyBefore);
    return counts;
  }
  async transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = await fn(); this.db.exec('COMMIT'); this.onCommit?.(); return result; }
    catch (error) { this.db.exec('ROLLBACK'); this.onRollback?.(); throw error; }
  }
  close() { this.#statements.clear(); this.db.close(); }
}
