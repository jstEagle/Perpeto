# Factory core

Initial local persistence for factory communication. This package supplies project-scoped channels, append-only messages, stable sender and recipient role identifiers, retry deduplication, and cursor reads using Node's built-in SQLite. It makes no inference calls and does not replace the upstream harness integrations.

Requires Node 24 or newer. No external dependencies or environment variables.

```js
import { MessagingStore } from '@perpeto/factory-core';

// The caller creates the parent directory and owns the database location.
const store = new MessagingStore('/absolute/path/factory.sqlite');
store.createProject({ id: 'perpeto', name: 'Perpeto' });
store.createChannel({ projectId: 'perpeto', id: 'implementation', name: 'Implementation' });
const result = store.send({
  projectId: 'perpeto', channelId: 'implementation',
  senderRoleId: 'backend-lead', recipientRoleId: 'reviewer',
  body: 'Revision abc123 is ready for review.',
  idempotencyKey: 'review-request-abc123',
});
const page = store.readMessages({
  projectId: 'perpeto', channelId: 'implementation', limit: 50,
});
const following = store.readMessages({
  projectId: 'perpeto', channelId: 'implementation', after: page.nextCursor,
});
store.close();
```

`send` returns `{ message, duplicate }`. Idempotency keys are scoped to a project. Retrying an identical payload returns the original message; changing channel, sender, recipient, or body under the same key throws `MessagingError` with code `IDEMPOTENCY_CONFLICT`. Project and channel registration also reject names that conflict with an existing identity.

`readMessages` returns `{ messages, nextCursor, hasMore }` in insertion order. Retain `nextCursor` even when `hasMore` is false to poll for future arrivals; an empty page preserves the previous cursor. Page size defaults to 100 and is limited to 500. An optional `recipientRoleId` selects only messages explicitly addressed to that role; unfiltered channel reads include all messages and broadcasts. Cursors bind the project, channel, and recipient filter. Role identifiers are durable caller-assigned values, independent of process or harness session identity.

SQLite uses foreign keys, WAL journaling, full synchronization, a five-second busy timeout, and a transactional schema migration. The optional constructor setting `busyTimeoutMs` accepts 0–60000. Keep the database and its WAL files on the owning machine's local disk; this is not a shared-network-filesystem database.

This is a storage component, not yet a Slack-like application or cross-device transport. It has no authentication, role membership enforcement, network delivery, wake-ups, acknowledgments, attachments, threads, editing, or UI. The eventual server must authorize callers before using this API. A recipient is routing metadata, not a confidentiality boundary: authorized channel reads expose all channel messages. Cursors are opaque pagination markers, not signed credentials or proof of delivery. Message persistence does not assign executable work or verify its results.

Run the actual temporary-database tests:

```sh
cd packages/factory-core
node --test
```
