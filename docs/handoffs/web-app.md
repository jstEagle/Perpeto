# Perpeto web app

Implemented `apps/web`: a Vite + React + TypeScript app with TanStack Router (code-based, lazily loaded routes) and `@xyflow/react` for workflow graphs. It is an npm workspace (`@perpeto/web`) with `dev`, `build`, `test`, `typecheck` and `screenshots` scripts. Node 24. Default dev port 5180.

It talks only to the hub. This round connected it to the real `apps/hub` and checked every main screen against a locally running hub seeded over HTTP. Demo mode still works without a hub.

## What exists

| Area | Implemented |
| --- | --- |
| Hub client | `src/api/client.ts` matches `apps/hub` response shapes (see [Contract](#contract-as-implemented)). Bearer header or session cookie, `idempotencyKey` on every write, hub error bodies surfaced as `HubError`. Events stream over `fetch` + SSE, starting from the newest event and resuming from the last `seq`, with backoff and a polling fallback. |
| Owner token | Never written to `localStorage`. The client asks the hub for an HttpOnly session cookie behind a feature check. Until the hub serves that route, the token lives in `sessionStorage` for the tab only, with a visible warning in Settings. Tokens left in the old `perpeto.hub.v1` key are moved out on first load. See [Token storage](#token-storage). |
| Live refresh | `useResource` refetches on matching events with a debounce and a ceiling (`maxWaitMs`), keeping data on screen. Run metrics refresh on any event for the run (1 s debounce, at most every 4 s); project metrics, usage and merge queue refresh on their events too. |
| Graph routing | `src/workflow/router.ts` routes every edge for the whole graph at once. Flow runs straight along the main line, and through the gap between rows when it wraps or returns. Delegates and messages leave node tops and bottoms into their own lanes, never on the main line. Edges between the same two nodes are bundled into one cable with one label. Every horizontal run gets its own lane. Labels are placed only where they touch no node, label or other edge; one that cannot fit becomes a tooltip. |
| Layout | `src/workflow/layout.ts`. Hub templates and architect drafts are positioned for smaller nodes, so view and live screens re-lay graphs whose nodes would overlap. The main line wraps into balanced rows of up to five. Side roles sit under the node that delegates or escalates to them. Gaps widen until the lanes fit. Graphs that already fit keep their positions. |
| Live map | Shows delegates and messages for the selected node only by default, with an "All" toggle in the canvas toolbar. Unplanned interactions always show. Zoom controls live in the same strip, so they never cover nodes. |
| Brand | Nodes, ports, edges, grid and status labels now follow [design-system.md](../architecture/design-system.md). Nodes are 240 wide with a 40 px header (16 px glyph, 14 medium name, mono step kind). Status is an inline label, and nodes are never filled with a status colour. Ports are 8 px squares. Edges have no arrowheads; unreached live paths are dashed `control-border`. Selection is `accent`, and the grid uses 16/64 px `grid-minor`/`grid-major` lines. Status labels everywhere use the 16 px shapes: open, half-filled, bar, cross, check, plus a triangle for approval. |
| Architect | Follows `GET /assignments/:id`, refreshed on its events and polled every 5 s as a fallback. It follows `retryAssignmentId` through invalid attempts, shows `architectErrors`, and opens `draftWorkflowId`/`draftVersion` when the draft is saved. |
| Proposal | Validity comes from the hub's `POST /workflows/:id/validate`; the local check covers the moment before it answers. Diffs come from the hub's engine. |
| Code splitting | Every screen loads on first visit, with intent preloading and a Spindle pending state after 400 ms. Main chunk 241 kB (77 kB gzip), down from 680 kB. `@xyflow/react` (192 kB) arrives only with graph screens. |

Other screens are as before: projects, overview, runs, work board, messages, merge queue, machines, accounts, usage and settings.

## Verification

Run on this Mac with Node 24.22:

- `npm run typecheck -w @perpeto/web` passes. `npm test -w @perpeto/web` runs 27 Vitest tests, all passing. New tests cover the router (separate lanes, label clearance, bundling, straight main line, layout of the hub build template) and client conversions (envelopes, validation, diff, usage, job log, version status, run input, decisions, event paging, cookie and fallback session).
- `npm run build -w @perpeto/web` passes with no chunk-size warning.
- `node apps/web/scripts/smoke.mjs` passes 12 browser steps in headless Chromium with no console errors. New steps measure rendered edge labels on the live map (both toggle states), proposal and editor and fail on any overlap with another label or a node. They also check the delegates and messages toggle and that no token is left in `localStorage`.
- **Real hub.** I started `apps/hub` from a temporary config (loopback 4320, CORS for `http://localhost:5180`) and seeded it with `node apps/web/scripts/seed-web-demo-hub.mjs <hubUrl> <owner.secret> --hold`. The script acts as the owner and two simulated machines over HTTP. It creates a project. It answers the architect, first with an invalid graph so the hub retries, then valid; that version is activated, and a v2 proposal follows. It starts a run, and the machines play planner, builder, reviewer and CI. `node apps/web/scripts/hub-screenshots.mjs <hubUrl> <owner.secret>` connects through the Settings form and checks that the token is absent from `localStorage`. It captures `hub-*` screenshots at 1440 and 390 with no browser errors. They show real hub data: 24 work items, builder and reviewer saturation, a high reviewer failure rate, hub diffs and validation.
- `node apps/web/scripts/screenshots.mjs` regenerated the 17 demo screens at both widths. I inspected the live map, proposal, editor, overview and the mobile live map against the brand rules.

Not verified: a real node daemon or harness, real Git or merge delivery (seeded items stop before merge), the session-cookie path against a hub (it needs the route below), Safari or Firefox, screen readers, touch editing.

## Token storage

**Choice:** prefer an HttpOnly cookie set by the hub, with `sessionStorage` as the fallback until the hub has the route. An HttpOnly cookie is the only option that keeps the owner credential away from scripts on the app's origin. `sessionStorage` is still readable by those scripts, but it is limited to one tab and gone when the tab closes, which is strictly better than `localStorage`. Settings says so plainly whenever the fallback is in use.

**Client flow (implemented):** on connect, `GET /api/v1/session` with the bearer token and no credentials. A 404 or 405 means the hub has no route, so the client uses the fallback. Otherwise it sends `POST /api/v1/session` with `credentials: 'include'`, then makes every request with the cookie and no `Authorization` header. Only `{ baseUrl, auth: 'cookie' }` is stored. On load, cookie mode checks `GET /session` and asks for the token again on 401. Disconnect sends `DELETE /api/v1/session`.

**Hub contract request** (for the hub owner; not implemented in `apps/hub`):

| Route | Auth | Response |
| --- | --- | --- |
| `GET /api/v1/session` | bearer or cookie | `200 { kind: 'owner', expiresAt }` when valid, `401` otherwise |
| `POST /api/v1/session` | owner bearer, idempotency key allowed | `201 { expiresAt }` plus `Set-Cookie: perpeto_session=<opaque>; HttpOnly; SameSite=Strict; Path=/api/v1; Max-Age=<ttl>`, and `Secure` for any non-loopback origin |
| `DELETE /api/v1/session` | cookie | `204`, clears the cookie and revokes the session server-side |

Session IDs should be random and stored as hashes, like node tokens, with a configurable TTL (suggested 12 h, sliding). The cookie must authenticate exactly like the owner bearer on every owner route and SSE. CORS must answer `Access-Control-Allow-Credentials: true` for the configured exact origins only, add `DELETE` to the allowed methods and never use `*`. Mutations that use the cookie should require a non-simple header (the client already sends `Content-Type: application/json`, which forces a preflight). The hub should also reject requests whose `Origin` is not allowed. `SameSite=Strict` needs the app and hub on the same site (`localhost:5180` with `localhost:4320` works; `localhost` with `127.0.0.1` does not), or the hub could serve the built app itself.

## Contract as implemented

All gaps listed in the previous handoff are closed against `apps/hub`:

1. Runs: `GET /projects/:id/runs` (`{runs}`); the event-rebuild fallback is gone.
2. Assignments: `GET /assignments/:id`. Architect assignments have no `runId`/`workItemId`.
3. Envelopes: lists are read by name (`projects`, `workflows`, `runs`, `versions`, `machines`, `accounts`, `jobs`, `workItems`, `assignments`, `entries`, `events`, `channels`, `groups`), and a missing name is an error. Health is `{status, version}`. Overview is as assumed. Validation `{valid, errors, warnings}` becomes one issue list with severities. The `@perpeto/workflow` diff (objects, `layoutOnly`) becomes id lists, ignoring layout-only changes. Usage `groups` become rows. Job logs `{chunks}` are joined. Metrics carry `windowSec` and nullable `concurrency`, `utilization`, `failureRate`, stats and `tokensPerItem`; the screens show "—".
4. Interaction data: `sourceNodeId`, `targetNodeId`, `edgeId`, `kind`, `unplanned`, `nodeId`, `role`, `machineId`, `workItemId`; gate `result`/`source`/`decision`. The feed writes sentences from node, item and machine names, because hub events carry no summary.
5. Version status: version records always say `draft`, so the client marks the head's `activeVersion` as active, older versions as previous and newer ones as proposals.
6. Run input is sent as `{ items: [{ title, body? }] }`, and returns 202 with no work item. Human decisions are sent as `pass` (approve) or `fail` (return).
7. Messages are still sent as role `owner` to `/api/v1/messaging`, assuming messaging project IDs equal hub project IDs (true for hub-created projects).

## Found in the hub and workflow engine (for their owners)

- **Unplanned edges have no endpoints.** `computeRunMetrics` reads `event.data.from`/`to`, but the hub records interactions with `sourceNodeId`/`targetNodeId`. Every unplanned interaction is therefore reported as `unplanned:messages:?->?` with `from: null, to: null`, and the map cannot draw it. The feed still shows these interactions, flagged unplanned.
- **No latest or per-run event query.** `/events` only pages forward from a cursor. The client reads forward once and keeps the newest 5,000 events in memory, which gets slow on a long-lived hub. Suggested: `GET /events?runId=&before=&limit=` or `latest=true`.
- **Version records have no timestamp**, so version history shows no dates against a real hub.
- **CORS has no `DELETE`**, which the session route will need.

## Risks and follow-ups

- Until the session route exists, a script injected into the app's origin can read the token while the tab is open. Serve the app only from a trusted origin.
- The architect harness and providers come from hub config; `src/config/providers.json` still lists illustrative models for the editor.
- The router minimises crossings but does not eliminate them: return edges from a gate's `fail` port cross the main line next to that gate. Labels never overlap.
- The editor keeps author positions (no automatic re-layout) and still sits inside the project frame, so large graphs open small.
- `DemoHub` and its fixtures are still in the main chunk.
