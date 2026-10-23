import { createHash } from 'node:crypto';
import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { fail, integer, nonblank, requireValue } from '../errors.js';

/**
 * CI logs and artifacts. Log chunks keep using the hub's `job_logs` table; this adds a per-job byte budget (later
 * output is dropped and the log marked truncated), hub-side redaction of common credential formats, cursor paging and
 * retention. Artifact files are written under `ci.artifactsPath`, one directory per job, at the offsets the node
 * sends, so a retried upload request rewrites the same bytes instead of appending them twice.
 */
const COMMON_SECRETS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:[Bb]earer|[Tt]oken)\s+[A-Za-z0-9._~+/-]{16,}=*/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/g,
];
const ARTIFACT_CHUNK = 512 * 1024;

export class CiStore {
  constructor(hub) {
    this.hub = hub; this.db = hub.store.db; this.config = hub.config.ci;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ci_log_state (job_id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, dropped INTEGER NOT NULL, at TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS ci_artifacts (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL,
        received INTEGER NOT NULL, sha256 TEXT NOT NULL, complete INTEGER NOT NULL, created_at TEXT NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS ci_artifacts_job ON ci_artifacts(job_id);
      CREATE INDEX IF NOT EXISTS ci_artifacts_created ON ci_artifacts(created_at);
      CREATE INDEX IF NOT EXISTS job_logs_at ON job_logs(at);
    `);
    this.patterns = [...COMMON_SECRETS, ...this.config.redactPatterns.map(pattern => new RegExp(pattern, 'g'))];
    mkdirSync(this.config.artifactsPath, { recursive: true, mode: 0o700 });
  }
  redact(text) {
    let value = text.split(this.hub.ownerToken).join('[REDACTED]');
    for (const pattern of this.patterns) value = value.replace(pattern, '[REDACTED]');
    return value;
  }
  /** Store one log chunk within the job's byte budget. Returns false once the budget is spent. */
  log(job, chunk, at, id) {
    const state = this.db.prepare('SELECT bytes, dropped FROM ci_log_state WHERE job_id=?').get(job.id) ?? { bytes: 0, dropped: 0 };
    const text = this.redact(chunk.replaceAll('\0', '�'));
    const size = Buffer.byteLength(text);
    const limit = this.config.logMaxBytesPerJob;
    let stored = true;
    if (state.dropped) { state.dropped += size; stored = false; }
    else if (state.bytes + size > limit) {
      // Keep what fits on whole lines' worth of characters, then one marker; later chunks only count as dropped.
      const room = Math.max(0, limit - state.bytes);
      const head = Buffer.from(text).subarray(0, room).toString('utf8').replace(/�$/, '');
      if (head) this.hub.store.log(job.id, head, at, id);
      this.hub.store.log(job.id, `\n[perpeto: log truncated at ${limit} bytes]\n`, at, `${id}_truncated`);
      state.bytes += Buffer.byteLength(head); state.dropped = size - Buffer.byteLength(head) || 1; stored = false;
    } else { this.hub.store.log(job.id, text, at, id); state.bytes += size; }
    this.db.prepare('INSERT INTO ci_log_state VALUES(?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET bytes=excluded.bytes, dropped=excluded.dropped, at=excluded.at')
      .run(job.id, state.bytes, state.dropped, at);
    job.logRef = `/api/v1/jobs/${job.id}/log`;
    return stored;
  }
  /** A page of a job's log after a cursor (job_logs seq). Without a limit the whole stored log is returned. */
  logPage(jobId, query) {
    const after = query.has('after') ? integer(Number(query.get('after')), 'after') : 0;
    const limit = query.has('limit') ? integer(Number(query.get('limit')), 'limit', 1, 5000) : null;
    const rows = this.db.prepare(`SELECT seq, id, job_id, chunk, at FROM job_logs WHERE job_id=? AND seq>? ORDER BY seq${limit ? ' LIMIT ?' : ''}`)
      .all(...[jobId, after, ...(limit ? [limit + 1] : [])]);
    const page = limit ? rows.slice(0, limit) : rows;
    const state = this.db.prepare('SELECT bytes, dropped FROM ci_log_state WHERE job_id=?').get(jobId);
    return { jobId, chunks: page.map(row => ({ seq: row.seq, id: row.id, jobId: row.job_id, chunk: row.chunk, at: row.at })),
      nextCursor: page.at(-1)?.seq ?? after, hasMore: Boolean(limit && rows.length > limit), truncated: Boolean(state?.dropped), bytes: state?.bytes ?? 0 };
  }
  artifactId(job, name, path) { return `art_${createHash('sha256').update(`${job.id}\0${job.attempt}\0${name}\0${path}`).digest('hex').slice(0, 32)}`; }
  /**
   * One chunk of an artifact file from the node holding the job's lease: `{ name, path, size, sha256, offset, data }`
   * with base64 `data`. The file completes when every byte arrived and its digest matches.
   */
  artifactChunk(job, data) {
    nonblank(data.name, 'artifact name', 100); requireValue(!/[/\\]/.test(data.name), 'Artifact names cannot contain slashes.');
    nonblank(data.path, 'artifact path', 1024);
    requireValue(!data.path.startsWith('/') && !data.path.split(/[\\/]/).includes('..') && !data.path.includes('\0'), 'Artifact paths are relative to the checkout.');
    const size = integer(data.size, 'artifact size', 0); const offset = integer(data.offset, 'artifact offset', 0);
    requireValue(typeof data.sha256 === 'string' && /^[a-f0-9]{64}$/.test(data.sha256), 'Artifact sha256 is required.');
    requireValue(typeof data.data === 'string' && data.data.length <= Math.ceil(ARTIFACT_CHUNK / 3) * 4 + 4, 'Invalid artifact chunk.');
    const bytes = Buffer.from(data.data, 'base64');
    requireValue(offset + bytes.length <= size, 'Artifact chunk is past the declared size.');
    const id = this.artifactId(job, data.name, data.path);
    let row = this.db.prepare('SELECT * FROM ci_artifacts WHERE id=?').get(id);
    if (!row) {
      const used = this.db.prepare('SELECT COALESCE(SUM(size),0) AS total FROM ci_artifacts WHERE job_id=?').get(job.id).total;
      if (used + size > this.config.artifactMaxBytesPerJob) fail(413, 'ARTIFACT_TOO_LARGE', `Artifacts for one job are capped at ${this.config.artifactMaxBytesPerJob} bytes.`);
      this.db.prepare('INSERT INTO ci_artifacts VALUES(?,?,?,?,?,?,?,?,?)').run(id, job.id, data.name, data.path, size, 0, data.sha256, 0, this.hub.now());
      row = this.db.prepare('SELECT * FROM ci_artifacts WHERE id=?').get(id);
    }
    requireValue(row.size === size && row.sha256 === data.sha256, 'Artifact identity changed between chunks.');
    if (row.complete) return this.artifactView(row);
    // Chunks arrive in order; a repeat of an earlier chunk is a harmless retry.
    if (offset > row.received) fail(409, 'ARTIFACT_GAP', 'Artifact chunks must arrive in order.');
    const file = this.artifactFile(job.id, id);
    mkdirSync(join(this.config.artifactsPath, job.id), { recursive: true, mode: 0o700 });
    const fd = openSync(file, existsSync(file) ? 'r+' : 'w+', 0o600);
    try {
      if (bytes.length) writeSync(fd, bytes, 0, bytes.length, offset);
      const received = Math.max(row.received, offset + bytes.length);
      let complete = 0;
      if (received === size) {
        ftruncateSync(fd, size);
        if (digest(fd, size) !== row.sha256) { closeSync(fd); rmSync(file, { force: true }); this.db.prepare('DELETE FROM ci_artifacts WHERE id=?').run(id); fail(400, 'ARTIFACT_CORRUPT', 'The artifact digest does not match its bytes.'); }
        complete = 1;
      }
      this.db.prepare('UPDATE ci_artifacts SET received=?, complete=? WHERE id=?').run(received, complete, id);
    } finally { try { closeSync(fd); } catch { /* Already closed after a digest mismatch. */ } }
    return this.artifactView(this.db.prepare('SELECT * FROM ci_artifacts WHERE id=?').get(id));
  }
  artifactFile(jobId, id) { return join(this.config.artifactsPath, jobId, id); }
  artifactView(row) { return { id: row.id, jobId: row.job_id, name: row.name, path: row.path, size: row.size, sha256: row.sha256, complete: Boolean(row.complete), createdAt: row.created_at }; }
  artifacts(jobId) { return this.db.prepare('SELECT * FROM ci_artifacts WHERE job_id=? ORDER BY name, path').all(jobId).map(row => this.artifactView(row)); }
  artifact(jobId, id) {
    const row = this.db.prepare('SELECT * FROM ci_artifacts WHERE id=? AND job_id=?').get(id, jobId);
    if (!row || !row.complete) fail(404, 'NOT_FOUND', 'Artifact not found.');
    return { path: this.artifactFile(jobId, id), name: row.path.split('/').at(-1), size: row.size };
  }
  /** Retention: old log chunks and artifact files, in bounded batches. */
  sweep(time) {
    const logsBefore = new Date(time - this.config.logRetentionMs).toISOString();
    const logs = Number(this.db.prepare('DELETE FROM job_logs WHERE seq IN (SELECT seq FROM job_logs WHERE at<? LIMIT 5000)').run(logsBefore).changes);
    this.db.prepare('DELETE FROM ci_log_state WHERE at<?').run(logsBefore);
    const artifactsBefore = new Date(time - this.config.artifactRetentionMs).toISOString();
    const rows = this.db.prepare('SELECT id, job_id FROM ci_artifacts WHERE created_at<? LIMIT 500').all(artifactsBefore);
    for (const row of rows) {
      rmSync(this.artifactFile(row.job_id, row.id), { force: true });
      this.db.prepare('DELETE FROM ci_artifacts WHERE id=?').run(row.id);
    }
    return { logs, artifacts: rows.length };
  }
}

function digest(fd, size) {
  const hash = createHash('sha256'); const buffer = Buffer.alloc(Math.min(size, 1024 * 1024) || 1);
  for (let position = 0; position < size;) {
    const read = readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
    if (!read) break;
    hash.update(buffer.subarray(0, read)); position += read;
  }
  return hash.digest('hex');
}

export const ARTIFACT_CHUNK_BYTES = ARTIFACT_CHUNK;

