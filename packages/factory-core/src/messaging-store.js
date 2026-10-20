import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export class MessagingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MessagingError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new MessagingError(code, message); };
function string(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    fail('INVALID_INPUT', `${label} must be a nonblank string of at most ${max} characters without NUL.`);
  }
  return value;
}

function identity(value, label) {
  string(value, label);
  if (value === '.' || value === '..') fail('INVALID_INPUT', `${label} cannot be a URL dot segment.`);
  return value;
}

/** Durable local messaging state. Transport and caller authorization belong to the host. */
export class MessagingStore {
  #db;

  constructor(filename, { busyTimeoutMs = 5000 } = {}) {
    string(filename, 'filename', 4096);
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60000) {
      fail('INVALID_INPUT', 'busyTimeoutMs must be an integer between 0 and 60000.');
    }
    this.#db = new DatabaseSync(filename);
    try {
      this.#db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${busyTimeoutMs};`);
      this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      this.#db.exec('BEGIN IMMEDIATE');
      const version = this.#db.prepare('PRAGMA user_version').get().user_version;
      if (version > 1) fail('SCHEMA_VERSION', `Unsupported messaging schema version ${version}.`);
      if (version === 0) this.#db.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY, name TEXT NOT NULL
        ) STRICT;
        CREATE TABLE channels (
          project_id TEXT NOT NULL REFERENCES projects(id),
          id TEXT NOT NULL, name TEXT NOT NULL,
          PRIMARY KEY (project_id, id)
        ) STRICT;
        CREATE TABLE messages (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          project_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          sender_role_id TEXT NOT NULL,
          recipient_role_id TEXT,
          body TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (project_id, channel_id) REFERENCES channels(project_id, id),
          UNIQUE (project_id, idempotency_key)
        ) STRICT;
        CREATE INDEX messages_channel ON messages(project_id, channel_id, sequence);
        CREATE INDEX messages_recipient ON messages(project_id, channel_id, recipient_role_id, sequence);
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

  createProject({ id, name }) {
    identity(id, 'project id'); string(name, 'project name');
    this.#db.prepare('INSERT INTO projects(id, name) VALUES (?, ?) ON CONFLICT(id) DO NOTHING').run(id, name);
    const existing = this.#db.prepare('SELECT id, name FROM projects WHERE id = ?').get(id);
    if (existing.name !== name) fail('CONFLICT', 'Project id already has a different name.');
    return { ...existing };
  }

  createChannel({ projectId, id, name }) {
    identity(projectId, 'projectId'); identity(id, 'channel id'); string(name, 'channel name');
    if (!this.#db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) {
      fail('NOT_FOUND', 'Project not found.');
    }
    this.#db.prepare(`INSERT INTO channels(project_id, id, name) VALUES (?, ?, ?)
      ON CONFLICT(project_id, id) DO NOTHING`).run(projectId, id, name);
    const channel = this.#channel(projectId, id);
    if (channel.name !== name) fail('CONFLICT', 'Channel id already has a different name.');
    return { projectId, id, name };
  }

  listChannels({ projectId }) {
    identity(projectId, 'projectId');
    if (!this.#db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) {
      fail('NOT_FOUND', 'Project not found.');
    }
    return this.#db.prepare('SELECT id, name FROM channels WHERE project_id = ? ORDER BY id').all(projectId)
      .map(row => ({ projectId, id: row.id, name: row.name }));
  }

  #channel(projectId, channelId) {
    identity(projectId, 'projectId'); identity(channelId, 'channelId');
    const channel = this.#db.prepare('SELECT name FROM channels WHERE project_id = ? AND id = ?').get(projectId, channelId);
    if (!channel) fail('NOT_FOUND', 'Channel not found in project.');
    return channel;
  }

  send({ projectId, channelId, senderRoleId, recipientRoleId = null, body, idempotencyKey }) {
    this.#channel(projectId, channelId);
    string(senderRoleId, 'senderRoleId');
    if (recipientRoleId !== null) string(recipientRoleId, 'recipientRoleId');
    string(body, 'body', 65536); string(idempotencyKey, 'idempotencyKey');
    // The unique constraint arbitrates retries from independent connections/processes.
    const result = this.#db.prepare(`INSERT INTO messages
      (id, project_id, channel_id, sender_role_id, recipient_role_id, body, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, idempotency_key) DO NOTHING`).run(
      randomUUID(), projectId, channelId, senderRoleId, recipientRoleId, body, idempotencyKey, new Date().toISOString(),
    );
    const row = this.#db.prepare('SELECT * FROM messages WHERE project_id = ? AND idempotency_key = ?').get(projectId, idempotencyKey);
    if (row.channel_id !== channelId || row.sender_role_id !== senderRoleId ||
        row.recipient_role_id !== recipientRoleId || row.body !== body) {
      fail('IDEMPOTENCY_CONFLICT', 'Idempotency key already identifies a different message in this project.');
    }
    return { message: publicMessage(row), duplicate: result.changes === 0 };
  }

  readMessages({ projectId, channelId, recipientRoleId = null, after = null, limit = 100 }) {
    this.#channel(projectId, channelId);
    if (recipientRoleId !== null) string(recipientRoleId, 'recipientRoleId');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail('INVALID_INPUT', 'limit must be an integer between 1 and 500.');
    const scope = [projectId, channelId, recipientRoleId];
    let sequence = 0;
    if (after !== null) {
      string(after, 'after', 4096);
      let cursor;
      try { cursor = JSON.parse(Buffer.from(after, 'base64url').toString('utf8')); }
      catch { fail('INVALID_CURSOR', 'Malformed message cursor.'); }
      if (cursor?.version !== 1 || JSON.stringify(cursor.scope) !== JSON.stringify(scope) ||
          !Number.isSafeInteger(cursor.sequence) || cursor.sequence < 1) {
        fail('INVALID_CURSOR', 'Cursor does not match this message stream.');
      }
      sequence = cursor.sequence;
    }
    const filter = recipientRoleId === null ? '' : ' AND recipient_role_id = ?';
    const args = [projectId, channelId, sequence];
    if (recipientRoleId !== null) args.push(recipientRoleId);
    args.push(limit + 1);
    const rows = this.#db.prepare(`SELECT * FROM messages
      WHERE project_id = ? AND channel_id = ? AND sequence > ?${filter}
      ORDER BY sequence ASC LIMIT ?`).all(...args);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const nextCursor = page.length ? Buffer.from(JSON.stringify({
      version: 1, scope, sequence: page.at(-1).sequence,
    })).toString('base64url') : after;
    return { messages: page.map(publicMessage), nextCursor, hasMore };
  }
}

function publicMessage(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    channelId: row.channel_id,
    senderRoleId: row.sender_role_id,
    recipientRoleId: row.recipient_role_id,
    body: row.body,
    createdAt: row.created_at,
  };
}
