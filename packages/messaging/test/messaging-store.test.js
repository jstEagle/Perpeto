import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MessagingStore } from '../src/messaging-store.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'perpeto-messaging-'));
  const filename = join(directory, 'messages.sqlite');
  const connections = [];
  const open = () => {
    const store = new MessagingStore(filename);
    connections.push(store);
    return store;
  };
  t.after(() => {
    for (const store of connections) { try { store.close(); } catch { /* Already closed. */ } }
    rmSync(directory, { recursive: true, force: true });
  });
  const store = open();
  store.createProject({ id: 'factory', name: 'Factory' });
  store.createChannel({ projectId: 'factory', id: 'build', name: 'Build' });
  return { store, open };
}
const send = (store, overrides = {}) => store.send({
  projectId: 'factory', channelId: 'build', senderRoleId: 'backend-lead',
  recipientRoleId: 'reviewer', body: 'Ready for review', idempotencyKey: 'result-1', ...overrides,
});
const read = (store, overrides = {}) => store.readMessages({ projectId: 'factory', channelId: 'build', ...overrides });
const code = expected => error => error.code === expected;

test('persists role-addressed messages and idempotent retry across store restart', t => {
  const { store, open } = fixture(t);
  const initial = send(store);
  assert.equal(initial.duplicate, false);
  store.close();
  const resumed = open();
  assert.deepEqual(read(resumed).messages, [initial.message]);
  assert.deepEqual(send(resumed), { message: initial.message, duplicate: true });
  assert.equal(initial.message.senderRoleId, 'backend-lead');
  assert.equal(initial.message.recipientRoleId, 'reviewer');
  assert.ok(!('sessionId' in initial.message));
});

test('key collisions reject changed payloads and work across independent connections', t => {
  const { store, open } = fixture(t);
  const initial = send(store);
  const peer = open();
  assert.equal(send(peer).message.id, initial.message.id);
  for (const changes of [
    { body: 'Changed' }, { senderRoleId: 'other' }, { recipientRoleId: null },
  ]) assert.throws(() => send(peer, changes), code('IDEMPOTENCY_CONFLICT'));
  store.createChannel({ projectId: 'factory', id: 'qa', name: 'QA' });
  assert.throws(() => send(peer, { channelId: 'qa' }), code('IDEMPOTENCY_CONFLICT'));
  assert.equal(read(store).messages.length, 1);
  assert.deepEqual(read(peer, { channelId: 'qa' }).messages, []);
});

test('cursor pagination resumes after restart and can tail new messages without repeats', t => {
  const { store, open } = fixture(t);
  const sent = Array.from({ length: 5 }, (_, i) => send(store, { body: `Message ${i}`, idempotencyKey: `m${i}` }).message);
  const first = read(store, { limit: 2 });
  assert.deepEqual(first.messages, sent.slice(0, 2));
  assert.equal(first.hasMore, true);
  store.close();
  const resumed = open();
  const second = read(resumed, { limit: 2, after: first.nextCursor });
  const third = read(resumed, { limit: 2, after: second.nextCursor });
  assert.deepEqual([...first.messages, ...second.messages, ...third.messages], sent);
  assert.equal(third.hasMore, false);
  const empty = read(resumed, { after: third.nextCursor });
  assert.equal(empty.nextCursor, third.nextCursor);
  assert.deepEqual(empty.messages, []);
  const added = send(resumed, { body: 'New result', idempotencyKey: 'new' }).message;
  assert.deepEqual(read(resumed, { after: empty.nextCursor }).messages, [added]);
});

test('identical role/channel/key identities remain isolated by project', t => {
  const { store } = fixture(t);
  store.createProject({ id: 'private', name: 'Private' });
  store.createChannel({ projectId: 'private', id: 'build', name: 'Build' });
  store.createChannel({ projectId: 'private', id: 'private-only', name: 'Private only' });
  const a = send(store).message;
  const b = send(store, { projectId: 'private', body: 'Secret project result' }).message;
  assert.notEqual(a.id, b.id);
  assert.deepEqual(read(store).messages, [a]);
  assert.deepEqual(read(store, { projectId: 'private' }).messages, [b]);
  assert.throws(() => read(store, { channelId: 'private-only' }), code('NOT_FOUND'));
  assert.throws(() => send(store, { channelId: 'private-only' }), code('NOT_FOUND'));
  assert.throws(() => read(store, { projectId: 'private', after: read(store).nextCursor }), code('INVALID_CURSOR'));
});

test('recipient filtering and cursor scope cannot mix streams', t => {
  const { store } = fixture(t);
  const addressed = send(store).message;
  send(store, { idempotencyKey: 'broadcast', recipientRoleId: null });
  send(store, { idempotencyKey: 'other-role', recipientRoleId: 'qa' });
  const inbox = read(store, { recipientRoleId: 'reviewer' });
  assert.deepEqual(inbox.messages, [addressed]);
  assert.equal(read(store).messages.length, 3);
  assert.throws(() => read(store, { after: inbox.nextCursor }), code('INVALID_CURSOR'));
  assert.throws(() => read(store, { after: 'not a cursor' }), code('INVALID_CURSOR'));
  assert.throws(() => read(store, { after: Buffer.from('null').toString('base64url') }), code('INVALID_CURSOR'));
});

test('rejects invalid messages, unknown scopes and conflicting registration', t => {
  const { store } = fixture(t);
  for (const changes of [
    { senderRoleId: '' }, { recipientRoleId: 42 }, { body: '  ' }, { body: 'x'.repeat(65537) },
    { idempotencyKey: '' }, { body: 'invalid\0body' },
  ]) assert.throws(() => send(store, changes), code('INVALID_INPUT'));
  for (const limit of [0, 501, 1.5, '20']) assert.throws(() => read(store, { limit }), code('INVALID_INPUT'));
  assert.throws(() => send(store, { projectId: 'missing' }), code('NOT_FOUND'));
  assert.throws(() => store.createChannel({ projectId: 'missing', id: 'build', name: 'Build' }), code('NOT_FOUND'));
  assert.throws(() => store.createProject({ id: 'factory', name: 'Changed' }), code('CONFLICT'));
  assert.throws(() => store.createChannel({ projectId: 'factory', id: 'build', name: 'Changed' }), code('CONFLICT'));
  assert.deepEqual(read(store).messages, []);
});

test('refuses a future database schema without discarding its data', t => {
  const directory = mkdtempSync(join(tmpdir(), 'perpeto-future-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'future.sqlite');
  const db = new DatabaseSync(filename);
  db.exec("CREATE TABLE future_data(value TEXT); INSERT INTO future_data VALUES ('keep'); PRAGMA user_version = 3;");
  db.close();
  assert.throws(() => new MessagingStore(filename), code('SCHEMA_VERSION'));
  const check = new DatabaseSync(filename);
  try {
    assert.equal(check.prepare('PRAGMA user_version').get().user_version, 3);
    assert.equal(check.prepare('SELECT value FROM future_data').get().value, 'keep');
  } finally { check.close(); }
});


test('lists only the project channels in a stable order', t => {
  const { store } = fixture(t);
  store.createChannel({ projectId: 'factory', id: 'architecture', name: 'Architecture' });
  store.createProject({ id: 'other', name: 'Other' });
  store.createChannel({ projectId: 'other', id: 'private', name: 'Private' });
  assert.deepEqual(store.listChannels({ projectId: 'factory' }), [
    { projectId: 'factory', id: 'architecture', name: 'Architecture' },
    { projectId: 'factory', id: 'build', name: 'Build' },
  ]);
  assert.throws(() => store.listChannels({ projectId: 'missing' }), code('NOT_FOUND'));
});

test('latest and older history pages stay bounded and gap-free across restart', t => {
  const { store, open } = fixture(t);
  const sent = Array.from({ length: 11 }, (_, i) => send(store, { body: `Message ${i}`, idempotencyKey: `history-${i}` }).message);
  const newest = read(store, { latest: true, limit: 3 });
  assert.deepEqual(newest.messages, sent.slice(-3));
  assert.equal(newest.hasMore, true);
  store.close();
  const resumed = open();
  let marker = newest.previousCursor;
  let history = newest.messages;
  let page;
  do {
    page = read(resumed, { before: marker, limit: 3 });
    history = [...page.messages, ...history];
    marker = page.previousCursor;
  } while (page.hasMore);
  assert.deepEqual(history, sent);
  assert.equal(new Set(history.map(message => message.id)).size, 11);
  const empty = read(resumed, { before: marker, limit: 3 });
  assert.deepEqual(empty.messages, []);
  assert.equal(empty.previousCursor, marker);
  assert.equal(empty.hasMore, false);
  const added = send(resumed, { body: 'After latest', idempotencyKey: 'tail-from-latest' }).message;
  assert.deepEqual(read(resumed, { after: newest.nextCursor }).messages, [added]);
  assert.deepEqual(read(resumed, { before: newest.nextCursor, limit: 2 }).messages, sent.slice(-3, -1));
});

test('history direction and cursor scopes validate without leaking filtered streams', t => {
  const { store } = fixture(t);
  const empty = read(store, { latest: true });
  assert.deepEqual(empty, { messages: [], previousCursor: null, nextCursor: null, hasMore: false });
  send(store);
  send(store, { idempotencyKey: 'other-history', recipientRoleId: 'other' });
  const inbox = read(store, { latest: true, recipientRoleId: 'reviewer' });
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.hasMore, false);
  const cursor = inbox.previousCursor;
  assert.throws(() => read(store, { before: cursor }), code('INVALID_CURSOR'));
  assert.throws(() => read(store, { before: 'malformed' }), code('INVALID_CURSOR'));
  for (const options of [
    { latest: 'true' }, { latest: null }, { latest: true, after: cursor },
    { latest: true, before: cursor }, { before: cursor, after: cursor },
  ]) assert.throws(() => read(store, options), code('INVALID_INPUT'));
  assert.equal(read(store, { latest: false }).messages.length, 2);
});


test('rejects URL dot segments only for project and channel identities', t => {
  const { store } = fixture(t);
  for (const id of ['.', '..']) {
    assert.throws(() => store.createProject({ id, name: 'Invalid' }), code('INVALID_INPUT'));
    assert.throws(() => store.createChannel({ projectId: 'factory', id, name: 'Invalid' }), code('INVALID_INPUT'));
    assert.throws(() => read(store, { projectId: id }), code('INVALID_INPUT'));
    assert.throws(() => read(store, { channelId: id }), code('INVALID_INPUT'));
  }
  assert.equal(send(store, { senderRoleId: '.', recipientRoleId: '..', body: '.' }).message.body, '.');
});
