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
      if (version > 2) fail('SCHEMA_VERSION', `Unsupported messaging schema version ${version}.`);
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
      `);
      // Version 2: threads, sender provenance, per-recipient delivery receipts and read cursors. Earlier messages
      // become their own thread roots, and their addressed copies wait in the recipient's inbox like new ones.
      if (version < 2) this.#db.exec(`
        ALTER TABLE messages ADD COLUMN thread_id TEXT;
        ALTER TABLE messages ADD COLUMN parent_id TEXT;
        ALTER TABLE messages ADD COLUMN sender_kind TEXT;
        ALTER TABLE messages ADD COLUMN sender_assignment_id TEXT;
        ALTER TABLE messages ADD COLUMN unplanned INTEGER NOT NULL DEFAULT 0;
        UPDATE messages SET thread_id = id;
        CREATE INDEX messages_thread ON messages(project_id, channel_id, thread_id, sequence);
        CREATE INDEX messages_sender ON messages(project_id, channel_id, sender_role_id, created_at);
        CREATE TABLE receipts (
          message_id TEXT PRIMARY KEY REFERENCES messages(id),
          project_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          recipient_role_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('stored', 'delivered', 'acked')),
          target_assignment_id TEXT,
          claimed_by TEXT,
          delivered_at TEXT, delivered_via TEXT, delivered_to TEXT,
          acked_at TEXT, ack_note TEXT
        ) STRICT;
        CREATE INDEX receipts_inbox ON receipts(project_id, channel_id, recipient_role_id, state, sequence);
        INSERT INTO receipts(message_id, project_id, channel_id, recipient_role_id, sequence, state)
          SELECT id, project_id, channel_id, recipient_role_id, sequence, 'stored' FROM messages WHERE recipient_role_id IS NOT NULL;
        CREATE TABLE read_cursors (
          project_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          role_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          message_id TEXT NOT NULL,
          PRIMARY KEY (project_id, channel_id, role_id)
        ) STRICT;
        PRAGMA user_version = 2;
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

  #transaction(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.#db.exec('COMMIT'); return result; }
    catch (error) { try { this.#db.exec('ROLLBACK'); } catch { /* Already rolled back. */ } throw error; }
  }

  #message(projectId, channelId, messageId) {
    string(messageId, 'messageId');
    const row = this.#db.prepare(`${SELECT} WHERE m.project_id = ? AND m.channel_id = ? AND m.id = ?`).get(projectId, channelId, messageId);
    if (!row) fail('NOT_FOUND', 'Message not found in channel.');
    return row;
  }

  getMessage({ projectId, channelId, messageId }) {
    this.#channel(projectId, channelId);
    return publicMessage(this.#message(projectId, channelId, messageId));
  }

  /**
   * Append a message. A reply names its `parentId` and joins the parent's thread; without an explicit recipient it
   * answers the parent's sender (or, replying to yourself, the parent's recipient). `null` addresses the channel.
   * The host supplies provenance: `senderKind`, `senderAssignmentId`, `targetAssignmentId` (the live assignment a
   * reply should reach first) and `unplanned` (a send outside the run's messages edges).
   */
  send({ projectId, channelId, senderRoleId, recipientRoleId, body, idempotencyKey, parentId = null,
    senderKind = null, senderAssignmentId = null, targetAssignmentId = null, unplanned = false }) {
    this.#channel(projectId, channelId);
    string(senderRoleId, 'senderRoleId');
    if (recipientRoleId !== undefined && recipientRoleId !== null) string(recipientRoleId, 'recipientRoleId');
    string(body, 'body', 65536); string(idempotencyKey, 'idempotencyKey');
    if (senderKind !== null && !['owner', 'agent'].includes(senderKind)) fail('INVALID_INPUT', 'senderKind must be owner or agent.');
    for (const [label, value] of [['senderAssignmentId', senderAssignmentId], ['targetAssignmentId', targetAssignmentId]]) if (value !== null) string(value, label);
    if (typeof unplanned !== 'boolean') fail('INVALID_INPUT', 'unplanned must be a boolean.');
    let threadId = null;
    if (parentId !== null) {
      const parent = this.#message(projectId, channelId, parentId);
      threadId = parent.thread_id ?? parent.id;
      if (recipientRoleId === undefined) recipientRoleId = parent.sender_role_id === senderRoleId ? parent.recipient_role_id : parent.sender_role_id;
    }
    recipientRoleId ??= null;
    return this.#transaction(() => {
      // The unique constraint arbitrates retries from independent connections/processes.
      const id = randomUUID();
      const result = this.#db.prepare(`INSERT INTO messages
        (id, project_id, channel_id, sender_role_id, recipient_role_id, body, idempotency_key, created_at,
         thread_id, parent_id, sender_kind, sender_assignment_id, unplanned)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, idempotency_key) DO NOTHING`).run(
        id, projectId, channelId, senderRoleId, recipientRoleId, body, idempotencyKey, new Date().toISOString(),
        threadId ?? id, parentId, senderKind, senderAssignmentId, unplanned ? 1 : 0,
      );
      if (result.changes === 1 && recipientRoleId !== null) {
        this.#db.prepare(`INSERT INTO receipts(message_id, project_id, channel_id, recipient_role_id, sequence, state, target_assignment_id)
          VALUES (?, ?, ?, ?, ?, 'stored', ?)`).run(id, projectId, channelId, recipientRoleId, result.lastInsertRowid, targetAssignmentId);
      }
      const row = this.#db.prepare(`${SELECT} WHERE m.project_id = ? AND m.idempotency_key = ?`).get(projectId, idempotencyKey);
      if (row.channel_id !== channelId || row.sender_role_id !== senderRoleId ||
          row.recipient_role_id !== recipientRoleId || row.body !== body || row.parent_id !== parentId) {
        fail('IDEMPOTENCY_CONFLICT', 'Idempotency key already identifies a different message in this project.');
      }
      return { message: publicMessage(row), duplicate: result.changes === 0 };
    });
  }

  readMessages({ projectId, channelId, recipientRoleId = null, threadId = null, after = null, before = null, latest = false, limit = 100 }) {
    this.#channel(projectId, channelId);
    if (recipientRoleId !== null) string(recipientRoleId, 'recipientRoleId');
    if (threadId !== null) string(threadId, 'threadId');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail('INVALID_INPUT', 'limit must be an integer between 1 and 500.');
    if (typeof latest !== 'boolean') fail('INVALID_INPUT', 'latest must be a boolean.');
    if (Number(after !== null) + Number(before !== null) + Number(latest) > 1) fail('INVALID_INPUT', 'after, before and latest are mutually exclusive.');
    // Version 1 cursors stay valid for unthreaded streams; a thread read binds its thread too.
    const scope = threadId === null ? [projectId, channelId, recipientRoleId] : [projectId, channelId, recipientRoleId, { threadId }];
    const backwards = latest || before !== null;
    const marker = after ?? before;
    let sequence = 0;
    if (marker !== null) {
      string(marker, before !== null ? 'before' : 'after', 4096);
      let cursor;
      try { cursor = JSON.parse(Buffer.from(marker, 'base64url').toString('utf8')); }
      catch { fail('INVALID_CURSOR', 'Malformed message cursor.'); }
      if (cursor?.version !== 1 || JSON.stringify(cursor.scope) !== JSON.stringify(scope) ||
          !Number.isSafeInteger(cursor.sequence) || cursor.sequence < 1) {
        fail('INVALID_CURSOR', 'Cursor does not match this message stream.');
      }
      sequence = cursor.sequence;
    }
    const boundary = latest ? '' : ` AND m.sequence ${backwards ? '<' : '>'} ?`;
    const args = [projectId, channelId];
    if (!latest) args.push(sequence);
    let filter = '';
    if (recipientRoleId !== null) { filter += ' AND m.recipient_role_id = ?'; args.push(recipientRoleId); }
    if (threadId !== null) { filter += ' AND m.thread_id = ?'; args.push(threadId); }
    args.push(limit + 1);
    const rows = this.#db.prepare(`${SELECT}
      WHERE m.project_id = ? AND m.channel_id = ?${boundary}${filter}
      ORDER BY m.sequence ${backwards ? 'DESC' : 'ASC'} LIMIT ?`).all(...args);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    if (backwards) page.reverse();
    const encode = sequence => Buffer.from(JSON.stringify({ version: 1, scope, sequence })).toString('base64url');
    const previousCursor = page.length ? encode(page[0].sequence) : marker;
    const nextCursor = page.length ? encode(page.at(-1).sequence) : marker;
    return { messages: page.map(publicMessage), previousCursor, nextCursor, hasMore };
  }

  /**
   * The role's durable inbox: addressed messages not yet delivered. Claims them for `assignmentId` so two live
   * assignments of one role are not both offered the same message. A claim or reply target held by an assignment that
   * is no longer in `activeAssignmentIds` is released, so undelivered messages reach the role's next assignment.
   */
  claimPending({ projectId, channelId, roleId, assignmentId, activeAssignmentIds = [], limit = 50 }) {
    this.#channel(projectId, channelId); string(roleId, 'roleId'); string(assignmentId, 'assignmentId');
    if (!Array.isArray(activeAssignmentIds)) fail('INVALID_INPUT', 'activeAssignmentIds must be an array.');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail('INVALID_INPUT', 'limit must be an integer between 1 and 500.');
    const active = new Set(activeAssignmentIds);
    const held = owner => owner && owner !== assignmentId && active.has(owner);
    return this.#transaction(() => {
      const rows = this.#db.prepare(`${SELECT} WHERE r.project_id = ? AND r.channel_id = ? AND r.recipient_role_id = ? AND r.state = 'stored'
        ORDER BY r.sequence ASC`).all(projectId, channelId, roleId).filter(row => !held(row.r_target) && !held(row.r_claimed_by)).slice(0, limit);
      const claim = this.#db.prepare('UPDATE receipts SET claimed_by = ? WHERE message_id = ?');
      for (const row of rows) claim.run(assignmentId, row.id);
      return rows.map(publicMessage);
    });
  }

  /** Record that addressed messages reached the recipient role. Only the first delivery is recorded; returns those. */
  markDelivered({ projectId, channelId, roleId, messageIds, via, assignmentId = null }) {
    this.#channel(projectId, channelId); string(roleId, 'roleId');
    if (!DELIVERY.includes(via)) fail('INVALID_INPUT', `via must be one of ${DELIVERY.join(', ')}.`);
    if (!Array.isArray(messageIds) || messageIds.length > 500) fail('INVALID_INPUT', 'messageIds must be an array of at most 500 ids.');
    if (assignmentId !== null) string(assignmentId, 'assignmentId');
    return this.#transaction(() => {
      const at = new Date().toISOString();
      const update = this.#db.prepare(`UPDATE receipts SET state = 'delivered', delivered_at = ?, delivered_via = ?, delivered_to = ?, claimed_by = NULL
        WHERE message_id = ? AND project_id = ? AND channel_id = ? AND recipient_role_id = ? AND state = 'stored'`);
      const changed = [];
      for (const messageId of messageIds) {
        string(messageId, 'messageId');
        if (update.run(at, via, assignmentId, messageId, projectId, channelId, roleId).changes) changed.push(messageId);
      }
      return changed.map(messageId => publicMessage(this.#message(projectId, channelId, messageId)));
    });
  }

  /** The recipient role reports it received and handled a message. Idempotent; the first acknowledgement stands. */
  ack({ projectId, channelId, messageId, roleId, note = null }) {
    this.#channel(projectId, channelId); string(roleId, 'roleId');
    if (note !== null) string(note, 'note', 2000);
    return this.#transaction(() => {
      const row = this.#message(projectId, channelId, messageId);
      if (row.recipient_role_id !== roleId || row.r_state === null) fail('NOT_RECIPIENT', 'Only the addressed role can acknowledge a message.');
      if (row.r_state === 'acked') return { message: publicMessage(row), changed: false };
      const at = new Date().toISOString();
      this.#db.prepare(`UPDATE receipts SET state = 'acked', acked_at = ?, ack_note = ?, claimed_by = NULL,
        delivered_at = COALESCE(delivered_at, ?), delivered_via = COALESCE(delivered_via, 'read') WHERE message_id = ?`).run(at, note, at, messageId);
      return { message: publicMessage(this.#message(projectId, channelId, messageId)), changed: true };
    });
  }

  #cursor(projectId, channelId, roleId) {
    return this.#db.prepare('SELECT sequence, message_id FROM read_cursors WHERE project_id = ? AND channel_id = ? AND role_id = ?').get(projectId, channelId, roleId);
  }
  #unreadCount(projectId, channelId, roleId, sequence) {
    return this.#db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE project_id = ? AND channel_id = ? AND sequence > ?
      AND sender_role_id <> ? AND (recipient_role_id = ? OR recipient_role_id IS NULL)`).get(projectId, channelId, sequence, roleId, roleId).count;
  }

  /** Messages for a role (addressed to it or to the channel, not its own) after its read cursor, oldest first. */
  unread({ projectId, channelId, roleId, limit = 100 }) {
    this.#channel(projectId, channelId); string(roleId, 'roleId');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail('INVALID_INPUT', 'limit must be an integer between 1 and 500.');
    const cursor = this.#cursor(projectId, channelId, roleId);
    const sequence = cursor?.sequence ?? 0;
    const rows = this.#db.prepare(`${SELECT} WHERE m.project_id = ? AND m.channel_id = ? AND m.sequence > ?
      AND m.sender_role_id <> ? AND (m.recipient_role_id = ? OR m.recipient_role_id IS NULL) ORDER BY m.sequence ASC LIMIT ?`)
      .all(projectId, channelId, sequence, roleId, roleId, limit);
    return { roleId, messages: rows.map(publicMessage), unreadCount: this.#unreadCount(projectId, channelId, roleId, sequence), lastReadMessageId: cursor?.message_id ?? null };
  }

  /** Advance a role's read cursor to a message. Cursors only move forward. */
  markRead({ projectId, channelId, roleId, messageId }) {
    this.#channel(projectId, channelId); string(roleId, 'roleId');
    return this.#transaction(() => {
      const row = this.#message(projectId, channelId, messageId);
      this.#db.prepare(`INSERT INTO read_cursors(project_id, channel_id, role_id, sequence, message_id) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(project_id, channel_id, role_id) DO UPDATE SET sequence = excluded.sequence, message_id = excluded.message_id
        WHERE excluded.sequence > read_cursors.sequence`).run(projectId, channelId, roleId, row.sequence, row.id);
      const cursor = this.#cursor(projectId, channelId, roleId);
      return { roleId, lastReadMessageId: cursor.message_id, unreadCount: this.#unreadCount(projectId, channelId, roleId, cursor.sequence) };
    });
  }

  /** Messages a role sent in a channel since an ISO time, for rate limits. */
  countSentSince({ projectId, channelId, senderRoleId, since }) {
    this.#channel(projectId, channelId); string(senderRoleId, 'senderRoleId'); string(since, 'since');
    return this.#db.prepare('SELECT COUNT(*) AS count FROM messages WHERE project_id = ? AND channel_id = ? AND sender_role_id = ? AND created_at >= ?')
      .get(projectId, channelId, senderRoleId, since).count;
  }
}

const DELIVERY = ['prompt', 'steer', 'read'];
const SELECT = `SELECT m.*, r.state AS r_state, r.target_assignment_id AS r_target, r.claimed_by AS r_claimed_by,
  r.delivered_at AS r_delivered_at, r.delivered_via AS r_delivered_via, r.delivered_to AS r_delivered_to,
  r.acked_at AS r_acked_at, r.ack_note AS r_ack_note
  FROM messages m LEFT JOIN receipts r ON r.message_id = m.id`;

function publicMessage(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    channelId: row.channel_id,
    senderRoleId: row.sender_role_id,
    recipientRoleId: row.recipient_role_id,
    body: row.body,
    createdAt: row.created_at,
    threadId: row.thread_id ?? row.id,
    parentId: row.parent_id ?? null,
    senderKind: row.sender_kind ?? null,
    senderAssignmentId: row.sender_assignment_id ?? null,
    unplanned: row.unplanned === 1,
    receipt: row.r_state ? {
      state: row.r_state, deliveredAt: row.r_delivered_at, deliveredVia: row.r_delivered_via, deliveredTo: row.r_delivered_to,
      ackedAt: row.r_acked_at, ackNote: row.r_ack_note,
    } : null,
  };
}
