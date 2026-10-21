# Messaging transport

Perpeto's messaging routes run inside the inherited T3 environment server. `vendor/t3code/apps/server/src/perpeto/Messaging.ts` imports the single SQLite implementation in `packages/messaging/src/messaging-store.js`, typed by its adjacent `.d.ts`; there is no separate datastore or inference client.

The server opens `perpeto-messaging.sqlite` under its configured `stateDir` and closes it with the server route layer. The launcher supplies a separate Perpeto data directory. WAL files stay on the environment owner's local disk.

Every request authenticates using T3 `EnvironmentAuth.authenticateHttpRequest`, including its existing bearer, browser session, DPoP, expiration and revocation behavior. GET requires `orchestration:read`; PUT and POST require `orchestration:operate`. Missing/invalid/revoked credentials return 401; insufficient scope returns 403.

| Method | Path | JSON input | JSON output |
|---|---|---|---|
| PUT | `/api/perpeto/projects/:projectId` | `{name}` | `{id,name}` |
| GET | `/api/perpeto/projects/:projectId/channels` | — | `{channels:[{projectId,id,name}]}` |
| POST | `/api/perpeto/projects/:projectId/channels` | `{id,name}` | `{projectId,id,name}` |
| GET | `/api/perpeto/projects/:projectId/channels/:channelId/messages` | Query: `after`, `limit`, `recipientRoleId` | `{messages,nextCursor,hasMore}` |
| POST | `/api/perpeto/projects/:projectId/channels/:channelId/messages` | `{senderRoleId,recipientRoleId?,body,idempotencyKey}` | `{message,duplicate}` |

Project and channel registration are idempotent when names match. A duplicate send with identical content returns the original message. Identity/name conflicts or reuse of a message key with different content return 409. Invalid input/cursors return 400; an unknown project/channel returns 404. Errors use `{error:{code,message}}`. Successful operations return 200. Request bodies are capped at 512 KiB at the reader, including chunked requests; excessive bodies return 413 and unreadable bodies return 400. Unknown-length oversized streams are drained without retaining their excess bytes so the server can deliver the JSON 413 response; known oversized content lengths are rejected before reading.

Authorization applies to the execution environment, consistent with the inherited orchestration scopes. These project IDs namespace messaging state; they do not enforce separate project membership. An environment operator may choose sender/recipient role identifiers. Roles are routing metadata rather than verified agent identity, and recipients do not create private messages. Read access can see all messages in a channel. Do not expose this as a project-tenant ACL or confidential direct-message service.

This increment supplies authenticated network reads/writes and persistent storage. It does not implement live push, wake-ups, guaranteed consumer delivery, role membership, threads, attachments, or task execution. Two physical machines and native/mobile interfaces have not been verified.

The real-HTTP integration test is `vendor/t3code/apps/server/src/perpeto/http.test.ts`. It builds the actual authentication/session layer, issues bearer sessions, exercises scoped requests, revokes a session, checks deduplication and persisted state through an independent connection, and checks malformed/oversized chunked bodies.
