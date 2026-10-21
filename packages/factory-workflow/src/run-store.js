import { DatabaseSync } from 'node:sqlite';
import { step, replay } from './engine.js';
import { canonicalJson, fail, isPlainObject, isText } from './util.js';

const RUN_ID = /^run_[A-Za-z0-9_-]{1,100}$/;
const ENTITIES = [
  { key: 'workItems', table: 'work_items', columns: { node_id: 'nodeId', status: 'status', parent_id: 'parentId' } },
  { key: 'assignments', table: 'assignments', columns: { work_item_id: 'workItemId', node_id: 'nodeId', status: 'status' } },
  { key: 'jobs', table: 'jobs', columns: { work_item_id: 'workItemId', node_id: 'nodeId', status: 'status' } },
  { key: 'merges', table: 'merge_entries', columns: { work_item_id: 'workItemId', node_id: 'nodeId', status: 'status' } },
];
const entityTable = Object.fromEntries(ENTITIES.map(entity => [entity.key, entity.table]));

function runId(value) {
  if (typeof value !== 'string' || !RUN_ID.test(value)) fail('INVALID_INPUT', 'runId must look like run_<suffix>.');
  return value;
}
function limit(value, max = 500) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) fail('INVALID_INPUT', `limit must be an integer between 1 and ${max}.`);
  return value;
}
const optionalText = (value, label) => {
  if (value !== undefined && !isText(value, 200)) fail('INVALID_INPUT', `${label} must be a nonblank string.`);
  return value;
};

/**
 * Durable run state for the workflow engine. Each `apply` runs `step` inside one SQLite transaction, persists the
 * new state, entity rows and an effects outbox, and deduplicates by event id per run. Transport, authorization and
 * effect execution belong to the host.
 */
export class RunStore {
  #db;

  constructor(filename, { busyTimeoutMs = 5000 } = {}) {
    if (!isText(filename, 4096)) fail('INVALID_INPUT', 'filename must be a nonblank string.');
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60000) {
      fail('INVALID_INPUT', 'busyTimeoutMs must be an integer between 0 and 60000.');
    }
    this.#db = new DatabaseSync(filename);
    try {
      this.#db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
      this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      this.#db.exec('BEGIN IMMEDIATE');
      const version = this.#db.prepare('PRAGMA user_version').get().user_version;
      if (version > 1) fail('SCHEMA_VERSION', `Unsupported workflow run schema version ${version}.`);
      if (version === 0) this.#db.exec(`
        CREATE TABLE runs (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workflow_id TEXT NOT NULL, workflow_version INTEGER NOT NULL,
          status TEXT NOT NULL, started_at TEXT NOT NULL, stopped_at TEXT, updated_at TEXT NOT NULL,
          last_seq INTEGER NOT NULL, state TEXT NOT NULL
        ) STRICT;
        CREATE INDEX runs_project ON runs(project_id, status);
        CREATE TABLE run_events (
          run_id TEXT NOT NULL, seq INTEGER NOT NULL, event_id TEXT NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL,
          fingerprint TEXT NOT NULL, event TEXT NOT NULL, effects TEXT NOT NULL, ignored TEXT, applied_at TEXT NOT NULL,
          PRIMARY KEY (run_id, seq), UNIQUE (run_id, event_id)
        ) STRICT;
        CREATE TABLE work_items (
          id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL, status TEXT NOT NULL, parent_id TEXT, data TEXT NOT NULL
        ) STRICT;
        CREATE INDEX work_items_run ON work_items(run_id, status);
        CREATE TABLE assignments (
          id TEXT PRIMARY KEY, run_id TEXT NOT NULL, work_item_id TEXT NOT NULL, node_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL
        ) STRICT;
        CREATE INDEX assignments_run ON assignments(run_id, status);
        CREATE INDEX assignments_status ON assignments(status);
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY, run_id TEXT NOT NULL, work_item_id TEXT NOT NULL, node_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL
        ) STRICT;
        CREATE INDEX jobs_run ON jobs(run_id, status);
        CREATE TABLE merge_entries (
          id TEXT PRIMARY KEY, run_id TEXT NOT NULL, work_item_id TEXT NOT NULL, node_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL
        ) STRICT;
        CREATE INDEX merge_entries_run ON merge_entries(run_id, status);
        CREATE TABLE effects (
          id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, seq INTEGER NOT NULL, effect TEXT NOT NULL, acked_at TEXT
        ) STRICT;
        CREATE INDEX effects_pending ON effects(acked_at, id);
        PRAGMA user_version = 1;
      `);
      this.#db.exec('COMMIT');
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* No active transaction. */ }
      this.#db.close();
      throw error;
    }
  }

  close() { this.#db.close(); }

  /**
   * Apply an event to a run. A repeated event id with the same type and data returns the original effects with
   * `duplicate: true`, even if `at` differs; the same id with different content throws `IDEMPOTENCY_CONFLICT`.
   * @returns {{ runId: string, seq: number, duplicate: boolean, ignored?: string, effects: object[], state: object }}
   */
  apply(id, event) {
    runId(id);
    if (!isPlainObject(event) || !isText(event.id, 200)) fail('INVALID_EVENT', 'Event needs a nonblank string id.');
    const fingerprint = canonicalJson({ type: event.type, data: event.data ?? {} });
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.#apply(id, event, fingerprint);
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* Transaction already ended. */ }
      throw error;
    }
  }

  #apply(id, event, fingerprint) {
    const existing = this.#db.prepare('SELECT seq, fingerprint, effects, ignored FROM run_events WHERE run_id = ? AND event_id = ?').get(id, event.id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'Event id already identifies a different event in this run.');
      return {
        runId: id, seq: existing.seq, duplicate: true, ...(existing.ignored ? { ignored: existing.ignored } : {}),
        effects: JSON.parse(existing.effects), state: this.#state(id),
      };
    }
    const row = this.#db.prepare('SELECT state, last_seq FROM runs WHERE id = ?').get(id);
    if (event.type === 'run.started') {
      if (row) fail('RUN_EXISTS', 'Run has already started.');
      if (event.data?.runId !== id) fail('INVALID_EVENT', 'run.started data.runId must match the run being applied to.');
    } else if (!row) fail('RUN_NOT_FOUND', 'Run not found.');
    const previous = row ? JSON.parse(row.state) : null;
    const { state, effects, ignored } = step(previous, event);
    const seq = (row?.last_seq ?? 0) + 1;
    const appliedAt = new Date().toISOString();
    this.#db.prepare(`INSERT INTO run_events (run_id, seq, event_id, type, at, fingerprint, event, effects, ignored, applied_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, seq, event.id, event.type, event.at, fingerprint, canonicalJson(event), JSON.stringify(effects), ignored ?? null, appliedAt,
    );
    if (row) {
      this.#db.prepare(`UPDATE runs SET status = ?, stopped_at = ?, updated_at = ?, last_seq = ?, state = ? WHERE id = ?`)
        .run(state.status, state.stoppedAt ?? null, state.updatedAt, seq, JSON.stringify(state), id);
    } else {
      this.#db.prepare(`INSERT INTO runs (id, project_id, workflow_id, workflow_version, status, started_at, stopped_at, updated_at, last_seq, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, state.projectId, state.workflowId, state.workflowVersion, state.status, state.startedAt, state.stoppedAt ?? null,
        state.updatedAt, seq, JSON.stringify(state),
      );
    }
    if (!ignored) {
      this.#sync(id, previous, state);
      const insert = this.#db.prepare('INSERT INTO effects (run_id, seq, effect) VALUES (?, ?, ?)');
      for (const effect of effects) insert.run(id, seq, JSON.stringify(effect));
    }
    return { runId: id, seq, duplicate: false, ...(ignored ? { ignored } : {}), effects, state };
  }

  #sync(id, previous, state) {
    for (const { key, table, columns } of ENTITIES) {
      const names = Object.keys(columns);
      const upsert = this.#db.prepare(`INSERT INTO ${table} (id, run_id, ${names.join(', ')}, data)
        VALUES (?, ?, ${names.map(() => '?').join(', ')}, ?)
        ON CONFLICT(id) DO UPDATE SET ${names.map(name => `${name} = excluded.${name}`).join(', ')}, data = excluded.data`);
      for (const [entityId, entity] of Object.entries(state[key])) {
        const data = JSON.stringify(entity);
        if (previous?.[key]?.[entityId] && JSON.stringify(previous[key][entityId]) === data) continue;
        upsert.run(entityId, id, ...Object.values(columns).map(field => entity[field] ?? null), data);
      }
    }
  }

  #state(id) {
    const row = this.#db.prepare('SELECT state FROM runs WHERE id = ?').get(id);
    return row ? JSON.parse(row.state) : null;
  }

  /** Current engine state for a run, or null. */
  getState(id) { return this.#state(runId(id)); }

  getRun(id) {
    const row = this.#db.prepare('SELECT * FROM runs WHERE id = ?').get(runId(id));
    return row ? publicRun(row) : null;
  }

  listRuns({ projectId, status } = {}) {
    optionalText(projectId, 'projectId'); optionalText(status, 'status');
    return this.#db.prepare(`SELECT * FROM runs WHERE (?1 IS NULL OR project_id = ?1) AND (?2 IS NULL OR status = ?2) ORDER BY started_at, id`)
      .all(projectId ?? null, status ?? null).map(publicRun);
  }

  #list(key, id, { status, nodeId } = {}) {
    runId(id); optionalText(status, 'status'); optionalText(nodeId, 'nodeId');
    return this.#db.prepare(`SELECT data FROM ${entityTable[key]} WHERE run_id = ?1 AND (?2 IS NULL OR status = ?2) AND (?3 IS NULL OR node_id = ?3) ORDER BY rowid`)
      .all(id, status ?? null, nodeId ?? null).map(row => JSON.parse(row.data));
  }

  #get(key, id) {
    if (!isText(id, 200)) fail('INVALID_INPUT', 'id must be a nonblank string.');
    const row = this.#db.prepare(`SELECT data FROM ${entityTable[key]} WHERE id = ?`).get(id);
    return row ? JSON.parse(row.data) : null;
  }

  listWorkItems(id, filter) { return this.#list('workItems', id, filter); }
  listAssignments(id, filter) { return this.#list('assignments', id, filter); }
  listJobs(id, filter) { return this.#list('jobs', id, filter); }
  listMergeEntries(id, filter) { return this.#list('merges', id, filter); }
  getWorkItem(id) { return this.#get('workItems', id); }
  getAssignment(id) { return this.#get('assignments', id); }
  getJob(id) { return this.#get('jobs', id); }
  getMergeEntry(id) { return this.#get('merges', id); }

  /** Applied events in order, including ignored ones. */
  listEvents(id, { after = 0, limit: count = 100 } = {}) {
    runId(id); limit(count);
    if (!Number.isSafeInteger(after) || after < 0) fail('INVALID_INPUT', 'after must be a nonnegative integer.');
    return this.#db.prepare('SELECT seq, event, ignored FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(id, after, count).map(row => ({ seq: row.seq, event: JSON.parse(row.event), ...(row.ignored ? { ignored: row.ignored } : {}) }));
  }

  /** Effects not yet acknowledged by the host, oldest first. Survives restarts. */
  pendingEffects({ runId: filter, limit: count = 100 } = {}) {
    if (filter !== undefined) runId(filter);
    limit(count);
    return this.#db.prepare('SELECT id, run_id, seq, effect FROM effects WHERE acked_at IS NULL AND (?1 IS NULL OR run_id = ?1) ORDER BY id LIMIT ?2')
      .all(filter ?? null, count).map(row => ({ id: row.id, runId: row.run_id, seq: row.seq, effect: JSON.parse(row.effect) }));
  }

  /** Mark outbox effects as executed. Repeat acknowledgements are harmless. Returns the number newly acknowledged. */
  ackEffects(ids) {
    if (!Array.isArray(ids) || !ids.every(Number.isSafeInteger)) fail('INVALID_INPUT', 'ids must be an array of effect ids.');
    const ack = this.#db.prepare('UPDATE effects SET acked_at = ? WHERE id = ? AND acked_at IS NULL');
    const at = new Date().toISOString();
    let count = 0;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of ids) count += Number(ack.run(at, id).changes);
      this.#db.exec('COMMIT');
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* Transaction already ended. */ }
      throw error;
    }
    return count;
  }

  /** Rebuild a run from its stored events and compare with the persisted state. */
  verify(id) {
    runId(id);
    const events = this.#db.prepare('SELECT event FROM run_events WHERE run_id = ? AND ignored IS NULL ORDER BY seq').all(id)
      .map(row => JSON.parse(row.event));
    if (!events.length) fail('RUN_NOT_FOUND', 'Run not found.');
    const rebuilt = replay(events);
    return { ok: canonicalJson(rebuilt) === canonicalJson(this.#state(id)), events: events.length };
  }
}

function publicRun(row) {
  return {
    id: row.id, projectId: row.project_id, workflowId: row.workflow_id, workflowVersion: row.workflow_version,
    status: row.status, startedAt: row.started_at, ...(row.stopped_at ? { stoppedAt: row.stopped_at } : {}),
    updatedAt: row.updated_at, lastSeq: row.last_seq,
  };
}
