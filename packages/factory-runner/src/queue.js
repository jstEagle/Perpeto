import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import configuration from '../config/limits.json' with { type: 'json' };

const limits = configuration.queue;

export class RunnerError extends Error {
  constructor(code, message) { super(message); this.code = code; this.name = 'RunnerError'; }
}
const fail = (code, message) => { throw new RunnerError(code, message); };
function text(value, name, max = limits.maxIdentityCharacters) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) fail('INVALID_INPUT', `Invalid ${name}.`);
  return value;
}
function strings(value, name, max = limits.maxLabels) {
  if (!Array.isArray(value) || value.length > max) fail('INVALID_INPUT', `Invalid ${name}.`);
  value.forEach(item => text(item, name));
  return [...new Set(value)].sort();
}
function leaseDuration(ms) {
  if (!Number.isSafeInteger(ms) || ms < limits.minLeaseMs || ms > limits.maxLeaseMs) fail('INVALID_INPUT', `leaseMs must be between ${limits.minLeaseMs} and ${limits.maxLeaseMs}.`);
}
export class RunnerQueue {
  #db;
  #now;
  constructor(filename, { now = Date.now } = {}) {
    this.#now = now;
    this.#db = new DatabaseSync(filename);
    this.#db.exec(`PRAGMA busy_timeout = ${limits.busyTimeoutMs}; PRAGMA journal_mode = ${limits.journalMode}; PRAGMA synchronous = ${limits.synchronous};`);
    this.#db.exec(`CREATE TABLE IF NOT EXISTS runner_jobs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, repository_id TEXT NOT NULL,
      revision TEXT NOT NULL, command_json TEXT NOT NULL, labels_json TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, status TEXT NOT NULL,
      runner_id TEXT, lease_token TEXT, lease_expires_at INTEGER,
      attempt INTEGER NOT NULL DEFAULT 0, result_json TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(project_id, idempotency_key)
    ) STRICT; CREATE INDEX IF NOT EXISTS runner_jobs_status ON runner_jobs(status, created_at);`);
  }
  close() { this.#db.close(); }
  #expire(now = this.#now()) {
    this.#db.prepare("UPDATE runner_jobs SET status = 'lost', updated_at = ? WHERE status = 'leased' AND lease_expires_at <= ?").run(now, now);
  }
  #row(id) {
    text(id, 'job id');
    const row = this.#db.prepare('SELECT * FROM runner_jobs WHERE id = ?').get(id);
    if (!row) fail('NOT_FOUND', 'Runner job not found.');
    return row;
  }
  submit({ projectId, repositoryId, revision, command, requiredLabels = [], idempotencyKey }) {
    text(projectId, 'projectId'); text(repositoryId, 'repositoryId'); text(idempotencyKey, 'idempotencyKey');
    if (typeof revision !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) fail('INVALID_INPUT', 'revision must be a full lowercase Git commit SHA.');
    if (!Array.isArray(command) || !command.length || command.length > limits.maxArguments || command.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > limits.maxArgumentCharacters)) fail('INVALID_INPUT', 'command must be an argv array.');
    text(command[0], 'executable');
    const labels = strings(requiredLabels, 'requiredLabels');
    const commandJson = JSON.stringify(command), labelsJson = JSON.stringify(labels), now = this.#now();
    const inserted = this.#db.prepare(`INSERT INTO runner_jobs
      (id,project_id,repository_id,revision,command_json,labels_json,idempotency_key,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'queued',?,?) ON CONFLICT(project_id,idempotency_key) DO NOTHING`).run(
      randomUUID(), projectId, repositoryId, revision, commandJson, labelsJson, idempotencyKey, now, now,
    );
    const row = this.#db.prepare('SELECT * FROM runner_jobs WHERE project_id=? AND idempotency_key=?').get(projectId, idempotencyKey);
    if (row.repository_id !== repositoryId || row.revision !== revision || row.command_json !== commandJson || row.labels_json !== labelsJson) fail('CONFLICT', 'Idempotency key identifies a different job.');
    return { job: publicJob(row), duplicate: inserted.changes === 0 };
  }
  get(id) { this.#expire(); return publicJob(this.#row(id)); }
  list({ projectId, limit = limits.defaultListLimit }) {
    text(projectId, 'projectId');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > limits.maxListLimit) fail('INVALID_INPUT', `limit must be 1–${limits.maxListLimit}.`);
    this.#expire();
    return this.#db.prepare('SELECT * FROM runner_jobs WHERE project_id=? ORDER BY created_at DESC,id LIMIT ?').all(projectId, limit).map(publicJob);
  }
  claim({ runnerId, labels = [], repositoryIds, leaseMs = limits.defaultLeaseMs }) {
    text(runnerId, 'runnerId'); leaseDuration(leaseMs);
    const available = strings(labels, 'labels'), repos = strings(repositoryIds, 'repositoryIds', limits.maxRepositoryIds);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const now = this.#now(); this.#expire(now);
      const row = this.#db.prepare("SELECT * FROM runner_jobs WHERE status='queued' ORDER BY created_at,id").iterate();
      let selected;
      for (const candidate of row) {
        if (repos.includes(candidate.repository_id) && JSON.parse(candidate.labels_json).every(label => available.includes(label))) { selected = candidate; break; }
      }
      if (!selected) { this.#db.exec('COMMIT'); return null; }
      const token = randomUUID();
      this.#db.prepare("UPDATE runner_jobs SET status='leased',runner_id=?,lease_token=?,lease_expires_at=?,attempt=attempt+1,updated_at=? WHERE id=?").run(runnerId, token, now + leaseMs, now, selected.id);
      const job = publicJob(this.#row(selected.id));
      this.#db.exec('COMMIT');
      return { job, leaseToken: token, leaseExpiresAt: now + leaseMs };
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  #mutateLease(id, runnerId, leaseToken, operation) {
    text(runnerId, 'runnerId'); text(leaseToken, 'leaseToken');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const now = this.#now();
      const row = this.#row(id);
      if (row.status !== 'leased' || row.runner_id !== runnerId || row.lease_token !== leaseToken || row.lease_expires_at <= now) fail('STALE_LEASE', 'Runner lease expired or was replaced.');
      operation(now);
      const job = publicJob(this.#row(id)); this.#db.exec('COMMIT'); return job;
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  heartbeat({ id, runnerId, leaseToken, leaseMs = limits.defaultLeaseMs }) {
    leaseDuration(leaseMs);
    return this.#mutateLease(id, runnerId, leaseToken, now => this.#db.prepare('UPDATE runner_jobs SET lease_expires_at=?,updated_at=? WHERE id=?').run(now + leaseMs, now, id));
  }
  complete({ id, runnerId, leaseToken, result }) {
    if (!result || typeof result !== 'object' || ![true,false].includes(result.timedOut) || ![true,false].includes(result.logsTruncated) || !(result.exitCode === null || (Number.isInteger(result.exitCode) && Math.abs(result.exitCode) < limits.maxExitCodeMagnitudeExclusive)) || typeof result.log !== 'string' || result.log.length > limits.maxLogCharacters || !Array.isArray(result.artifacts) || result.artifacts.length > limits.maxArtifacts) fail('INVALID_INPUT', 'Invalid runner result.');
    for (const artifact of result.artifacts) {
      if (!artifact || typeof artifact.path !== 'string' || artifact.path.length > limits.maxArtifactPathCharacters || !Number.isSafeInteger(artifact.size) || artifact.size < 0) fail('INVALID_INPUT', 'Invalid artifact summary.');
    }
    const safe = { exitCode: result.exitCode, timedOut: result.timedOut, logsTruncated: result.logsTruncated, log: result.log, artifacts: result.artifacts.map(({path,size}) => ({path,size})) };
    return this.#mutateLease(id, runnerId, leaseToken, now => this.#db.prepare('UPDATE runner_jobs SET status=?,result_json=?,updated_at=? WHERE id=?').run(safe.exitCode === 0 && !safe.timedOut ? 'succeeded' : 'failed', JSON.stringify(safe), now, id));
  }
  retry(id) {
    this.#expire();
    const row = this.#row(id);
    if (!['lost','failed','queued'].includes(row.status)) fail('CONFLICT', 'Only lost or failed jobs may be retried.');
    this.#db.prepare("UPDATE runner_jobs SET status='queued',runner_id=NULL,lease_token=NULL,lease_expires_at=NULL,result_json=NULL,updated_at=? WHERE id=? AND status IN ('lost','failed')").run(this.#now(), id);
    return this.get(id);
  }
}
function publicJob(row) {
  return { id: row.id, projectId: row.project_id, repositoryId: row.repository_id, revision: row.revision,
    command: JSON.parse(row.command_json), requiredLabels: JSON.parse(row.labels_json), status: row.status,
    runnerId: row.runner_id, leaseExpiresAt: row.lease_expires_at, attempt: row.attempt,
    result: row.result_json ? JSON.parse(row.result_json) : null, createdAt: row.created_at, updatedAt: row.updated_at };
}
