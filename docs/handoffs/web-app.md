# Perpeto web app

Implemented `apps/web`: a Vite + React + TypeScript app with TanStack Router (code-based, lazily loaded routes) and `@xyflow/react` for workflow graphs. It is an npm workspace (`@perpeto/web`) with `dev`, `build`, `test`, `typecheck` and `screenshots` scripts. Node 24. Default dev port 5180.

It talks only to the hub. This round connected it to the real `apps/hub` and checked every main screen against a locally running hub seeded over HTTP. Demo mode still works without a hub.

## What exists

| Area | Implemented |
| --- | --- |
| Hub client | `src/api/client.ts` matches `apps/hub` response shapes (see [Contract](#contract-as-implemented)). Bearer header or session cookie, `idempotencyKey` on every write, hub error bodies surfaced as `HubError`. Events stream over `fetch` + SSE, starting from the newest event and resuming from the last `seq`, with backoff and a polling fallback. |
| Owner token | Never written to `localStorage`. The client asks the hub for an HttpOnly session cookie behind a feature check. Until the hub serves that route, the token lives in `sessionStorage` for the tab only, with a visible warning in Settings. Tokens left in the old `perpeto.hub.v1` key are moved out on first load. See [Token storage](#token-storage). |
| Live refresh | `useResource` refetches on matching events with a debounce and a ceiling (`maxWaitMs`), keeping data on screen. Run metrics refresh on any event for the run (1 s debounce, at most every 4 s); project metrics, usage and merge queue refresh on their events too. |
| Graph routing | `src/workflow/router.ts` routes every edge for the whole graph at once. Flow runs straight along the main line. Returns along the top row run as nested arcs in one channel above it; returns from lower rows run below their row. An edge into another row takes one elbow through the column gap when it is clear. Delegates and messages leave node tops and bottoms into their own lanes below the main line. Edges between the same two nodes are bundled into one cable with one label. Every horizontal run gets its own lane. Labels are placed only where they touch no node, label or other edge (checked through a grid index); one that cannot fit becomes a tooltip. |
| Layout | `src/workflow/layout.ts`, hand-written layered layout, left to right. A DFS that follows `out`/`pass` first sets loop back edges aside; the main line (reachable from inputs along primary ports) is ranked by longest path into one column per step. Fail branches go in a lane below, one column after their gate; delegate helpers and escalation targets go below the node they serve. Barycenter sweeps order shared columns to cut crossings, keeping the main line on the top row. Gaps widen until the lanes fit. dagre would only supply the layering and elkjs adds about 1.4 MB and a worker for routing the router already owns, so neither earns a dependency. |
| Tidy layout | Stored positions are kept when they fit at the web's node size. Graphs with none (web templates, architect drafts, hub templates) get the automatic layout. The editor writes it into the graph on open without marking the draft changed, keeps moved nodes as dropped, and lays out again only on "Tidy layout" (an undoable change saved with the draft). View and live maps show a "Tidy layout" toggle when they are showing saved positions. The editor opens at 60 % zoom or more, at the start of the flow; the fit button still shows everything. |
| Human gates | `decideWorkItem` sends the item's `decisionId`. A `409 STALE_DECISION` (or `CONFLICT`, item no longer waiting) shows "Decision not recorded…" on the card and reloads the work items. |
| Large graphs | Over 60 nodes the map renders only what is in view, draws compact nodes (no live strip) below 45 % zoom, and applies late node measurements once a pan pauses. Unchanged nodes and edges keep their objects, so a selection re-renders the two nodes involved instead of all of them. |
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
- This round: `npm test -w @perpeto/web` runs 31 tests (new: layered layout of the hub and web build templates, crossing removal, returns nested above the main line, no flow edge through a node, position detection, 200-node layout and routing budget, `decisionId` and `STALE_DECISION`). Typecheck and build pass. Smoke passes 13 steps, adding drag-then-tidy in the editor. Screenshots were regenerated for demo and a freshly seeded local hub (port 4329) at 1440 and 390. The stale-decision message is covered by unit tests only: no seeded item reached the triage gate, so it was not exercised against the hub in a browser.
- `node apps/web/scripts/smoke.mjs` passes 12 browser steps in headless Chromium with no console errors. New steps measure rendered edge labels on the live map (both toggle states), proposal and editor and fail on any overlap with another label or a node. They also check the delegates and messages toggle and that no token is left in `localStorage`.
- **Real hub.** I started `apps/hub` from a temporary config (loopback 4320, CORS for `http://localhost:5180`) and seeded it with `node apps/web/scripts/seed-web-demo-hub.mjs <hubUrl> <owner.secret> --hold`. The script acts as the owner and two simulated machines over HTTP. It creates a project. It answers the architect, first with an invalid graph so the hub retries, then valid; that version is activated, and a v2 proposal follows. It starts a run, and the machines play planner, builder, reviewer and CI. `node apps/web/scripts/hub-screenshots.mjs <hubUrl> <owner.secret>` connects through the Settings form and checks that the token is absent from `localStorage`. It captures `hub-*` screenshots at 1440 and 390 with no browser errors. They show real hub data: 24 work items, builder and reviewer saturation, a high reviewer failure rate, hub diffs and validation.
- `node apps/web/scripts/screenshots.mjs` regenerated the 17 demo screens at both widths. I inspected the live map, proposal, editor, overview and the mobile live map against the brand rules.

Not verified: a real node daemon or harness, real Git or merge delivery (seeded items stop before merge), the session-cookie path against a hub (it needs the route below), Safari or Firefox, screen readers, touch editing.

## Live map at 200 nodes

`node apps/web/scripts/perf.mjs <devUrl> 200` drives the dev-only `/perf.html` page (not in the build): a synthetic 202-node, 316-edge live map (`src/workflow/synthetic.ts`, six parallel tracks of review loops with helpers, CI and a triage gate) at 1440 × 960 in headless Chromium on this Mac. Frame rates are capped at 60. Headless runs are noisy; the 4× rows vary by about ±40 ms between runs.

| CPU | Rendering | Pan at fit (fps, worst frame) | Pan at 107 % | Select node | Live update (median) | DOM nodes at fit |
| --- | --- | --- | --- | --- | --- | --- |
| 1× | Virtualised + compact | 60, 17 ms | 60, 17 ms | 27 ms | 32 ms | 82 |
| 1× | Everything rendered | 60, 17 ms | 60, 17 ms | 161 ms | 80 ms | 202 |
| 4× slower | Virtualised + compact | 38–43, 117–183 ms | 59–60, 17–33 ms | 85–155 ms | 61–108 ms | 82 |
| 4× slower | Everything rendered | 45–50, 33–50 ms | 41–49, 50–83 ms | 648–773 ms | 278–331 ms | 202 |

Layout of the same graph takes about 1 ms (two passes 30–40 ms cold, in Vitest), routing with labels 3.4 ms, down from 11.2 ms before the label index. On a slow CPU, the first pan across unseen parts of the graph at far-out zoom still drops frames while new nodes mount; everything else stays smooth.

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
- The router minimises crossings but does not eliminate them: a return arc from a gate's `fail` port crosses that gate's own `pass` edge right beside it, and delegate or message lanes below the main line can cross a return from the side lane. Labels never overlap.
- **Width.** One column per step makes long main lines wide: the nine-step build template fits a 1440 px live map at about 40 % zoom, which is hard to read without zooming in. Wrapping rows was the old answer and caused the doubling back. The coming restyle should decide how the live map frames long graphs (taller canvas, a readable minimum zoom like the editor's, or compact nodes for small graphs too).
- "Saved positions" means positions that do not overlap at the web's node size; there is no explicit marker in the graph schema. A hand arrangement that happens to overlap is re-laid out in view and live screens (the editor keeps it).
- Compact nodes and the Tidy layout button use existing styles only, pending the restyle.
- `DemoHub` and its fixtures are still in the main chunk.
