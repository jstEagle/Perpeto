# Messaging

Perpeto messaging has two hosts over one store, `packages/messaging/src/messaging-store.js` (schema v2):

| Host | Routes | Controls |
|---|---|---|
| Hub | `/api/v1/messaging/…` | Owner tokens, run-scoped agent credentials, `messages`-edge policy, rate limits, durable role inboxes, delivery into running turns, receipts and acks |
| T3 environment server | `/api/perpeto/…` | T3 session scopes only. Channels, sends and reads; no threads, receipts or agent identity |

Factory runs use the hub. The T3-hosted routes are unchanged and stay a plain authenticated channel store.

## Model

Each run has a channel `run-<runId>`. Messages are addressed to a durable role id, never a session, so a replaced or later assignment of the role still receives them. `owner` is the role people use in clients.

```ts
Message { id, projectId, channelId, senderRoleId, recipientRoleId: string|null, body, createdAt,
          threadId /* root id; a root is its own thread */, parentId: string|null,
          senderKind: 'owner'|'agent'|null, senderAssignmentId: string|null,
          unplanned: boolean /* agent send outside the run's messages edges, under the flag policy */,
          receipt: Receipt|null /* addressed messages only */ }
Receipt { state: 'stored'|'delivered'|'acked', deliveredAt, deliveredVia: 'prompt'|'steer'|'read'|null,
          deliveredTo /* assignment id */, ackedAt, ackNote }
```

A reply names `parentId` and joins the parent's thread. Without a `recipientRoleId` it answers the parent's sender (or, replying to your own message, its recipient); `null` addresses the whole channel.

Receipt states only move forward and each is recorded once:

| State | Evidence |
|---|---|
| `stored` | The hub committed the message and its inbox entry |
| `delivered` | The executor put it in front of the agent: in the first prompt (`prompt`) or dispatched into the running T3 thread (`steer`). An ack of a never-offered message records `read` |
| `acked` | The recipient role called ack (agent credential, or the owner acting for a role) |

None of these proves a model understood or complied. A message never assigns work or verifies a result; assignments and jobs carry those.

## Control

Every leased run assignment carries `messaging: { token, projectId, channelId, roleId }`. The token is derived from the hub credential key (`pa1_…`), never stored, re-derived on lease replays, and valid only while that attempt holds an unexpired lease. It reaches only its run channel's messaging routes and always sends as the assignment's role; a different `senderRoleId` is `403`.

An agent send is planned when its recipient is in the assignment's `policy.canMessage` (derived from `messages` edges), is `owner`, or answers a message an owner sent. Otherwise the workflow decides:

| `Workflow.messagingPolicy` | Unplanned agent send |
|---|---|
| `flag` (default) | Stored with `unplanned: true`; the `agent.messaged` event carries `flagged: true` |
| `enforce` | `403 MESSAGE_NOT_ALLOWED`, nothing stored |

Channel-wide sends by agents are unplanned. Agent sends are limited per role per channel to `Workflow.messageRateLimits[role]`, else `messageRateLimits['*']`, else hub config `messageRatePerMinute` (30) in any 60 s; excess is `429 RATE_LIMITED` under either policy. Owner sends are never limited or flagged. The node event path `POST /assignments/:id/events {type:'message'}` applies the same rules.

Owner tokens may still post with any `senderRoleId` (as earlier SDK role configs do); those messages are `senderKind: 'owner'`. Give agents their run credential, not the owner token.

## Delivery and wake-ups

```text
owner/agent ──send──▶ hub: message + receipt(stored) in the recipient role's inbox
                         │
        no live assignment of the role         live assignment, mid-turn
                         │                                │
  next lease: assignment.inbox[]           next renewal: { leaseExpiresAt, inbox[] }
                         │                                │
  executor: "Messages waiting for you"      node → ctx.inbox → executor dispatches
  section in the first prompt               message.dispatch (deliveryIntent 'auto') into the root thread
                         │                                │
           POST /assignments/:id/events { type:'delivered', data:{ messageIds, via:'prompt'|'steer' } }
                         ▼
              receipt delivered → agent acks with its credential → receipt acked
```

The hub claims inbox messages for one live assignment of the role at a time. A reply to a message whose sending assignment is still live is offered to that assignment first. Claims and targets held by an assignment that is no longer live are released, so undelivered messages reach the role's next assignment.

T3 chooses the safe point: with `deliveryIntent: 'auto'` it steers the active run when the provider supports active steering, queues the message as the next turn otherwise, and starts a turn when the thread is idle. The executor delivers each message id once, keeps following the thread until the resulting turn settles, and keeps a structured answer (review verdict, planner items) from an earlier turn when the message-induced turn does not repeat it. Message-induced turns count toward `policy.maxTurns`.

Latency is one lease renewal (`timing.renewMs`, 20 s by default). Messages that arrive after the assignment's final turn settled stay `stored` and go to the role's next assignment.

The executor writes the agent's SDK config and credential to `<assignment workspace>/.perpeto-messaging/` (owner-only, outside the checkout, removed when the assignment ends) and adds the commands to the prompt. The node supplies the hub URL and its pinned certificate fingerprints. The prompt marks messages as information, not instructions that override the assignment.

## Hub routes

Under `/api/v1/messaging/projects/:projectId`. Owner or agent credential unless noted; agents reach only `channels/run-<their run>/…`.

| Method | Path | Input | Output |
|---|---|---|---|
| PUT | `` (owner) | `{name}` | `{id,name}` |
| GET, POST | `/channels` (owner) | POST `{id,name}` | `{channels}` / channel |
| POST | `/channels/:c/messages` | `{body, idempotencyKey, recipientRoleId?, parentId?, senderRoleId?}` (`senderRoleId` required for owners) | `{message, duplicate}` |
| GET | `/channels/:c/messages` | `after`/`before`/`latest`, `limit`, `recipientRoleId`, `threadId` | `{messages, previousCursor, nextCursor, hasMore}` |
| GET | `/channels/:c/messages/:id` | | `Message` |
| POST | `/channels/:c/messages/:id/ack` | `{note?, roleId?}` (owner `roleId` defaults to `owner`) | `{message, changed}`; `403 NOT_RECIPIENT` if not addressed to that role |
| GET | `/channels/:c/unread` | `roleId` (owner: required), `limit` | `{roleId, messages, unreadCount, lastReadMessageId}` |
| POST | `/channels/:c/read-cursor` | `{messageId, roleId?}` | `{roleId, lastReadMessageId, unreadCount}`; cursors only move forward |

Unread means addressed to the role or the channel, not sent by it, after the role's read cursor. Node protocol additions: leased run assignments carry `messaging` and `inbox`; `POST /assignments/:id/renew` returns `inbox` for run assignments; assignment events accept `delivered`. Workflows accept `messagingPolicy` and `messageRateLimits` (POST, PUT; agent drafts keep the base workflow's values).

Events, subject `{kind:'message', id}`: `message.delivered {messageId, threadId, senderRoleId, recipientRoleId, via, assignmentId, threadRef?}` and `message.acked {…, note?, assignmentId | by:'owner'}`. `agent.messaged` gains `threadId`, `senderKind`, `parentId`, `flagged` and, when one end is `owner`, `human: true`; its `unplanned` keeps meaning "no graph edge".

## T3-hosted transport

`vendor/t3code/apps/server/src/perpeto/Messaging.ts` opens `perpeto-messaging.sqlite` under the server's `stateDir` and serves channels, sends and reads at `/api/perpeto/projects/…` with the routes above minus message-by-id, ack, unread, read-cursor and `threadId`/`parentId`. Requests authenticate with T3 `EnvironmentAuth`; GET needs `orchestration:read`, PUT/POST `orchestration:operate`. Bodies are capped at 512 KiB. Roles there are caller-chosen metadata, not verified identity. Its real-HTTP test is `vendor/t3code/apps/server/src/perpeto/http.test.ts`.

## Limits

- Not verified with a live provider: steering into a real Codex or Claude turn, a harness actually running the messaging commands, and delivery across two machines. The fake-T3 wake-up test (`packages/t3-executor/test/wakeup.test.js`) covers hub, node, executor and the agent CLI in one process tree.
- The agent's sandbox must allow running `node` and reaching the hub for replies and acks; under restrictive runtime modes it can still receive messages but not answer.
- Read access covers the whole run channel; recipients route, they do not make messages private. No attachments, edits or search.
