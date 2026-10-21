import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MessagingStore } from '../src/messaging-store.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'perpeto-threads-'));
  const filename = join(directory, 'messages.sqlite');
  const connections = [];
  const open = () => { const store = new MessagingStore(filename); connections.push(store); return store; };
  t.after(() => {
    for (const store of connections) { try { store.close(); } catch { /* Already closed. */ } }
    rmSync(directory, { recursive: true, force: true });
  });
  const store = open();
  store.createProject({ id: 'factory', name: 'Factory' });
  store.createChannel({ projectId: 'factory', id: 'run-1', name: 'Run 1' });
  return { store, open, filename };
}
const scope = { projectId: 'factory', channelId: 'run-1' };
const send = (store, overrides = {}) => store.send({ ...scope, senderRoleId: 'builder', recipientRoleId: 'reviewer',
  body: 'Ready for review', idempotencyKey: `k-${Math.random()}`, ...overrides }).message;
const code = expected => error => error.code === expected;

test('replies join the root thread, default to the parent sender, and read as one thread', t => {
  const { store } = fixture(t);
  const root = send(store);
  assert.equal(root.threadId, root.id);
  assert.equal(root.parentId, null);
  const reply = send(store, { senderRoleId: 'reviewer', recipientRoleId: undefined, parentId: root.id, body: 'Looking now' });
  assert.equal(reply.threadId, root.id);
  assert.equal(reply.parentId, root.id);
  assert.equal(reply.recipientRoleId, 'builder', 'a reply without a recipient answers the parent sender');
  const nested = send(store, { senderRoleId: 'builder', recipientRoleId: undefined, parentId: reply.id, body: 'Thanks' });
  assert.equal(nested.threadId, root.id);
  assert.equal(nested.recipientRoleId, 'reviewer');
  const own = send(store, { senderRoleId: 'builder', recipientRoleId: undefined, parentId: nested.id, body: 'Also this' });
  assert.equal(own.recipientRoleId, 'reviewer', 'replying to yourself keeps the original recipient');
  send(store, { body: 'Unrelated' });
  const thread = store.readMessages({ ...scope, threadId: root.id });
  assert.deepEqual(thread.messages.map(message => message.id), [root.id, reply.id, nested.id, own.id]);
  const page = store.readMessages({ ...scope, threadId: root.id, limit: 2 });
  assert.equal(page.hasMore, true);
  assert.deepEqual(store.readMessages({ ...scope, threadId: root.id, after: page.nextCursor }).messages.map(message => message.id), [nested.id, own.id]);
  assert.throws(() => store.readMessages({ ...scope, after: page.nextCursor }), code('INVALID_CURSOR'));
  assert.throws(() => send(store, { parentId: 'missing' }), code('NOT_FOUND'));
  store.createChannel({ projectId: 'factory', id: 'other', name: 'Other' });
  assert.throws(() => send(store, { channelId: 'other', parentId: root.id }), code('NOT_FOUND'), 'parents never cross channels');
  assert.equal(store.getMessage({ ...scope, messageId: reply.id }).body, 'Looking now');
});

test('idempotent replies compare the parent and a derived recipient', t => {
  const { store } = fixture(t);
  const root = send(store);
  const first = store.send({ ...scope, senderRoleId: 'reviewer', parentId: root.id, body: 'Done', idempotencyKey: 'reply-1' });
  const again = store.send({ ...scope, senderRoleId: 'reviewer', parentId: root.id, body: 'Done', idempotencyKey: 'reply-1' });
  assert.equal(again.duplicate, true);
  assert.equal(again.message.id, first.message.id);
  const other = send(store, { body: 'Other root' });
  assert.throws(() => store.send({ ...scope, senderRoleId: 'reviewer', parentId: other.id, body: 'Done', idempotencyKey: 'reply-1' }), code('IDEMPOTENCY_CONFLICT'));
});

test('addressed messages carry a receipt that moves stored, delivered, acked exactly once', t => {
  const { store, open } = fixture(t);
  const message = send(store, { senderKind: 'agent', senderAssignmentId: 'asg_1' });
  assert.equal(message.senderKind, 'agent');
  assert.equal(message.senderAssignmentId, 'asg_1');
  assert.deepEqual(message.receipt, { state: 'stored', deliveredAt: null, deliveredVia: null, deliveredTo: null, ackedAt: null, ackNote: null });
  assert.equal(send(store, { recipientRoleId: null }).receipt, null, 'broadcasts have no receipt');
  const delivered = store.markDelivered({ ...scope, roleId: 'reviewer', messageIds: [message.id], via: 'steer', assignmentId: 'asg_2' });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].receipt.state, 'delivered');
  assert.equal(delivered[0].receipt.deliveredVia, 'steer');
  assert.equal(delivered[0].receipt.deliveredTo, 'asg_2');
  assert.deepEqual(store.markDelivered({ ...scope, roleId: 'reviewer', messageIds: [message.id], via: 'prompt', assignmentId: 'asg_3' }), [], 'redelivery does not rewrite the receipt');
  assert.deepEqual(store.markDelivered({ ...scope, roleId: 'builder', messageIds: [message.id], via: 'steer' }), [], 'only the recipient role can take delivery');
  assert.throws(() => store.ack({ ...scope, messageId: message.id, roleId: 'builder' }), code('NOT_RECIPIENT'));
  const acked = store.ack({ ...scope, messageId: message.id, roleId: 'reviewer', note: 'Reviewing' });
  assert.equal(acked.changed, true);
  assert.equal(acked.message.receipt.state, 'acked');
  assert.equal(acked.message.receipt.ackNote, 'Reviewing');
  const repeat = store.ack({ ...scope, messageId: message.id, roleId: 'reviewer', note: 'Reviewing' });
  assert.equal(repeat.changed, false);
  assert.deepEqual(repeat.message, acked.message);
  store.close();
  const reopened = open();
  assert.equal(reopened.getMessage({ ...scope, messageId: message.id }).receipt.state, 'acked');
  // Acknowledging something never offered (read through a tool) records delivery by read.
  const direct = send(reopened);
  const readAck = reopened.ack({ ...scope, messageId: direct.id, roleId: 'reviewer' });
  assert.equal(readAck.message.receipt.deliveredVia, 'read');
  assert.ok(readAck.message.receipt.deliveredAt);
  assert.throws(() => reopened.ack({ ...scope, messageId: 'missing', roleId: 'reviewer' }), code('NOT_FOUND'));
  assert.throws(() => reopened.markDelivered({ ...scope, roleId: 'reviewer', messageIds: [direct.id], via: 'carrier-pigeon' }), code('INVALID_INPUT'));
});

test('the durable inbox claims pending messages for one live assignment at a time', t => {
  const { store } = fixture(t);
  const first = send(store, { body: 'One' });
  const second = send(store, { body: 'Two' });
  send(store, { recipientRoleId: 'other', body: 'Not mine' });
  const claim = (assignmentId, active) => store.claimPending({ ...scope, roleId: 'reviewer', assignmentId, activeAssignmentIds: active });
  assert.deepEqual(claim('asg_a', ['asg_a', 'asg_b']).map(message => message.id), [first.id, second.id]);
  assert.deepEqual(claim('asg_b', ['asg_a', 'asg_b']), [], 'a live claim is not offered twice');
  assert.deepEqual(claim('asg_a', ['asg_a', 'asg_b']).map(message => message.id), [first.id, second.id], 'the claimant sees its claim again until delivery');
  store.markDelivered({ ...scope, roleId: 'reviewer', messageIds: [first.id], via: 'steer', assignmentId: 'asg_a' });
  assert.deepEqual(claim('asg_b', ['asg_b']).map(message => message.id), [second.id], 'a finished claimant releases undelivered messages');
  // A reply addressed back to a live sender assignment waits for that assignment.
  const targeted = send(store, { senderRoleId: 'builder', body: 'For asg_c only', targetAssignmentId: 'asg_c' });
  assert.ok(!claim('asg_b', ['asg_b', 'asg_c']).some(message => message.id === targeted.id));
  assert.ok(claim('asg_c', ['asg_b', 'asg_c']).some(message => message.id === targeted.id));
  const loose = send(store, { senderRoleId: 'builder', body: 'Target gone', targetAssignmentId: 'asg_gone' });
  assert.ok(claim('asg_b', ['asg_b']).some(message => message.id === loose.id), 'a finished target no longer holds its message');
});

test('per-recipient unread cursors only move forward and skip own messages', t => {
  const { store, open } = fixture(t);
  const a = send(store, { body: 'A' });
  send(store, { senderRoleId: 'reviewer', recipientRoleId: 'builder', body: 'Mine' });
  const b = send(store, { recipientRoleId: null, body: 'Broadcast' });
  send(store, { recipientRoleId: 'other', body: 'Elsewhere' });
  const unread = store.unread({ ...scope, roleId: 'reviewer' });
  assert.deepEqual(unread.messages.map(message => message.id), [a.id, b.id]);
  assert.equal(unread.unreadCount, 2);
  assert.equal(unread.lastReadMessageId, null);
  assert.deepEqual(store.markRead({ ...scope, roleId: 'reviewer', messageId: a.id }), { roleId: 'reviewer', lastReadMessageId: a.id, unreadCount: 1 });
  store.close();
  const reopened = open();
  assert.deepEqual(reopened.unread({ ...scope, roleId: 'reviewer' }).messages.map(message => message.id), [b.id]);
  reopened.markRead({ ...scope, roleId: 'reviewer', messageId: b.id });
  assert.deepEqual(reopened.markRead({ ...scope, roleId: 'reviewer', messageId: a.id }), { roleId: 'reviewer', lastReadMessageId: b.id, unreadCount: 0 }, 'cursors never move back');
  assert.equal(reopened.unread({ ...scope, roleId: 'builder' }).unreadCount, 1, 'each recipient has its own cursor');
  const limited = reopened.unread({ ...scope, roleId: 'other', limit: 1 });
  assert.equal(limited.messages.length, 1);
  assert.equal(limited.unreadCount, 2);
  assert.throws(() => reopened.markRead({ ...scope, roleId: 'reviewer', messageId: 'missing' }), code('NOT_FOUND'));
});

test('counts recent sends per sender for rate limits', t => {
  const { store } = fixture(t);
  const before = new Date(Date.now() - 1000).toISOString();
  send(store); send(store); send(store, { senderRoleId: 'reviewer' });
  assert.equal(store.countSentSince({ ...scope, senderRoleId: 'builder', since: before }), 2);
  assert.equal(store.countSentSince({ ...scope, senderRoleId: 'builder', since: new Date(Date.now() + 1000).toISOString() }), 0);
});

test('migrates a version 1 database in place, keeping messages as their own threads', t => {
  const directory = mkdtempSync(join(tmpdir(), 'perpeto-v1-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'v1.sqlite');
  const db = new DatabaseSync(filename);
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL) STRICT;
    CREATE TABLE channels (project_id TEXT NOT NULL REFERENCES projects(id), id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (project_id, id)) STRICT;
    CREATE TABLE messages (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, channel_id TEXT NOT NULL,
      sender_role_id TEXT NOT NULL, recipient_role_id TEXT, body TEXT NOT NULL, idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY (project_id, channel_id) REFERENCES channels(project_id, id), UNIQUE (project_id, idempotency_key)) STRICT;
    INSERT INTO projects VALUES ('factory', 'Factory');
    INSERT INTO channels VALUES ('factory', 'run-1', 'Run 1');
    INSERT INTO messages(id, project_id, channel_id, sender_role_id, recipient_role_id, body, idempotency_key, created_at)
      VALUES ('old-1', 'factory', 'run-1', 'builder', 'reviewer', 'Old', 'old', '2026-10-20T00:00:00.000Z');
    PRAGMA user_version = 1;`);
  db.close();
  const store = new MessagingStore(filename);
  t.after(() => store.close());
  const [old] = store.readMessages(scope).messages;
  assert.equal(old.threadId, 'old-1');
  assert.equal(old.parentId, null);
  assert.equal(old.senderKind, null);
  assert.equal(old.receipt.state, 'stored', 'old addressed messages wait in the inbox like new ones');
  const reply = store.send({ ...scope, senderRoleId: 'reviewer', parentId: 'old-1', body: 'Late reply', idempotencyKey: 'late' }).message;
  assert.equal(reply.threadId, 'old-1');
});
