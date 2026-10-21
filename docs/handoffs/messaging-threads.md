# Controlled agent messaging handoff

Implemented 21 October 2026 on branch `t3/092e1fa7`. Contract: [messaging](../architecture/messaging.md).

## What changed

- **Store** (`packages/messaging`, schema v2): reply threads (`threadId`, `parentId`), sender provenance, per-recipient receipts `stored → delivered → acked`, a claimable durable inbox per role, forward-only unread cursors. v1 databases migrate in place.
- **Hub** (`apps/hub/src/messaging.js`): leased run assignments carry a derived `pa1_` credential bound to their role and run channel, valid only while the lease is. Agent sends are checked against `policy.canMessage`; `Workflow.messagingPolicy` `flag` (default) marks unplanned sends, `enforce` refuses them. Per-role rate limits (`messageRateLimits`, hub `messageRatePerMinute`). The owner can message any role, and agents can always message or answer `owner`. New routes: message by id, ack, unread, read-cursor, `threadId` reads. Leases and renewals carry the role's `inbox`; nodes report `delivered` events. Events `message.delivered`, `message.acked`.
- **Node** (`apps/node`): relays renewal inboxes to the executor as `ctx.inbox`, and passes the hub URL and certificate pins as `ctx.messaging`.
- **Executor** (`packages/t3-executor/src/inbox.js`): waiting messages go in the first prompt; mid-assignment messages are dispatched once into the root thread with T3 `deliveryIntent: 'auto'`; both are reported delivered. Writes the agent's messaging config outside the checkout and removes it afterwards.
- **SDK**: `reply`, `thread`, `message`, `ack`, `unread`, `markRead`; MCP `factory_reply`, `factory_thread`, `factory_ack`, `factory_unread`; `tlsFingerprints` pinning.

## Behaviour changes for existing callers

- `POST /assignments/:id/events {type:'message'}` to a role outside `canMessage` used to return `403`; under the default `flag` policy it now succeeds with `unplanned: true`. Use `messagingPolicy: 'enforce'` for the old behaviour.
- `POST /assignments/:id/renew` returns `{ leaseExpiresAt, inbox }` for run assignments.
- Messages gain `threadId`, `parentId`, `senderKind`, `senderAssignmentId`, `unplanned`, `receipt`.

## For clients (web, Apple)

Not changed here. To show threads and receipts: read `?threadId=` or group by `threadId`; send replies with `parentId`; show `receipt.state` (and `deliveredVia`) on addressed messages; ack messages addressed to `owner` with `POST …/messages/:id/ack`; badge with `GET …/unread?roleId=owner` and clear with `POST …/read-cursor`; follow `message.delivered` and `message.acked` on the event stream; show `flagged`/`human` on `agent.messaged`. The workflow editor can expose `messagingPolicy` and `messageRateLimits`.

## Verification

- `npm test` on Node 24.22.0: 485 passed, 0 failed (includes new store, hub, node, executor and SDK tests).
- Wake-up proof with the fake T3 server, `packages/t3-executor/test/wakeup.test.js`: real hub with the workflow engine under `enforce`, real node, real executor. An owner message is steered into the builder's running turn; the agent acks and replies with its own credential through the SDK CLI; a message for the not-yet-started reviewer arrives in its first prompt. Receipts and events are checked.
- `npm run verify:upstream`: passes; `vendor/` untouched. The vendor T3 messaging test was not run (vendor dependencies are not installed in this worktree); its route passes explicit fields and only gains extra message fields.
- No live Codex check: no built T3 runtime (`vendor/t3code/apps/server/dist`) was available, so steering a real provider turn, an agent running the commands in a real sandbox, and two-machine delivery remain unverified.

## Open

- `docs/product/status.md` still says messaging threads and wake-ups are not implemented; update it to "implemented, fake-T3 verified, live unverified".
- `docs/architecture/README.md` Hub API row for messaging could link the new routes.
- Delivery latency is one renewal (20 s default). A push channel from hub to node would shorten it.
- No loop guards beyond rate limits (causal depth, pending-ask caps), no escalation of unacknowledged messages to the owner.
