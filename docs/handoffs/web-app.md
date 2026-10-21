# Perpeto web app

Implemented `apps/web`: a Vite + React + TypeScript app with TanStack Router (code-based, lazily loaded routes) and `@xyflow/react` for workflow graphs. It is an npm workspace (`@perpeto/web`) with `dev`, `build`, `test`, `typecheck` and `screenshots` scripts. Node 24. Default dev port 5180.

It talks only to the hub. This round connected it to the real `apps/hub` and checked every main screen against a locally running hub seeded over HTTP. Demo mode still works without a hub.

## What exists

| Area | Implemented |
| --- | --- |
| Hub client | `src/api/client.ts` matches `apps/hub` response shapes (see [Contract](#contract-as-implemented)). Session cookie (bearer only for hubs without `/session`), `idempotencyKey` on every write, hub error bodies surfaced as `HubError`. Events stream over `fetch` + SSE from the newest `seq` (`GET /events?latest=true&limit=1`), resuming from the last `seq`, with backoff and a polling fallback. The run feed reads `latest=true&runId=` 200 at a time, newest first, and "Show older events" pages back with `before=`. The architect panel reads the project's newest page. Nothing is cached client-side any more. |
| Owner token | Never stored by a hub that has `/session`: the client exchanges it for the hub's HttpOnly cookie and keeps only `{ baseUrl, auth: 'cookie' }`. Only a hub without the route (404/405) gets the old fallback, the token in `sessionStorage` for this tab with a warning in Settings. Tokens left in the old `perpeto.hub.v1` key are moved out on first load. See [Token storage](#token-storage). |
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

- **Session and events round** (main at 1986ea7): 32 Vitest tests (new: cookie proven without the token, `COOKIE_BLOCKED` with no fallback, `latest`/`before`/`runId` paging). Against a real hub (`localhost:4329`, `corsOrigins` `http://localhost:5181`, `longPollMs` 1000) in Chromium, `hub-screenshots.mjs` now checks that connecting leaves `auth: 'cookie'` and no token in local or session storage, that `document.cookie` cannot see `perpeto_session`, that the cookie authenticates, that a reload keeps it and that Disconnect makes the hub answer `401`. A separate probe confirmed `127.0.0.1` from a `localhost` app fails with the fix and stores nothing, cookie-authenticated Pause and Resume pass the CSRF check (200), the feed requests `latest=true&limit=200&runId=` and lists newest first, and "Show older events" pages from 202 to 396 rows.

Not verified: a real node daemon or harness, real Git or merge delivery (seeded items stop before merge), the bearer fallback against a real pre-session hub (unit tests only), cookie expiry after the 12 h TTL, Safari or Firefox, screen readers, touch editing.

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

**Choice:** the hub's HttpOnly session cookie, the only option that keeps the owner credential away from scripts on the app's origin. `sessionStorage` remains only for hubs without `/session`; Settings says so whenever it is in use.

**Client flow (implemented, checked against `apps/hub` on main):**

1. `GET /api/v1/session` with the bearer token and no credentials. A 404 or 405 means the hub predates sessions: keep the token for this tab only.
2. Otherwise `POST /api/v1/session` with the bearer and `credentials: 'include'`; the hub answers `201` and sets `perpeto_session` (HttpOnly, SameSite=Strict, `Path=/api/v1`).
3. A credentialed `GET /session` with no token proves the browser kept the cookie. If it gets `401`, connecting fails with the fix, and nothing is stored. `SameSite=Strict` drops the cookie when the app and hub are on different sites; on one machine that means mixing `localhost` and `127.0.0.1`, so the message names the URL to use. Settings now defaults to the app's own loopback name (`http://localhost:4320` when the app is on `localhost`).
4. Every request then uses the cookie with no `Authorization` header. POSTs carry a JSON body, which the hub's CSRF check requires along with an allowed `Origin`. On load, cookie mode checks `GET /session` and asks for the token again on `401`. Disconnect sends `DELETE /session`, which ends the session on the hub.

## Contract as implemented

All gaps listed in the previous handoff are closed against `apps/hub`:

1. Runs: `GET /projects/:id/runs` (`{runs}`); the event-rebuild fallback is gone.
2. Assignments: `GET /assignments/:id`. Architect assignments have no `runId`/`workItemId`.
3. Envelopes: lists are read by name (`projects`, `workflows`, `runs`, `versions`, `machines`, `accounts`, `jobs`, `workItems`, `assignments`, `entries`, `events`, `channels`, `groups`), and a missing name is an error. Health is `{status, version}`. Overview is as assumed. Validation `{valid, errors, warnings}` becomes one issue list with severities. The `@perpeto/workflow` diff (objects, `layoutOnly`) becomes id lists, ignoring layout-only changes. Usage `groups` become rows. Job logs `{chunks}` are joined. Metrics carry `windowSec` and nullable `concurrency`, `utilization`, `failureRate`, stats and `tokensPerItem`; the screens show "—".
4. Interaction data: `sourceNodeId`, `targetNodeId`, `edgeId`, `kind`, `unplanned`, `nodeId`, `role`, `machineId`, `workItemId`; gate `result`/`source`/`decision`. The feed writes sentences from node, item and machine names, because hub events carry no summary.
5. Version status: version records always say `draft`, so the client marks the head's `activeVersion` as active, older versions as previous and newer ones as proposals.
6. Run input is sent as `{ items: [{ title, body? }] }`, and returns 202 with no work item. Human decisions are sent as `pass` (approve) or `fail` (return).
7. Events: `latest=true` and `before=` pages come back oldest first with `previousCursor` (exclusive); the client reverses them. `before=` cursors are contiguous with no overlap, checked against the hub.
8. Messages are still sent as role `owner` to `/api/v1/messaging`, assuming messaging project IDs equal hub project IDs (true for hub-created projects).

## Found in the hub and workflow engine (for their owners)

- **Version records have no timestamp**, so version history shows no dates against a real hub.
- **`/nodes/lease` always long-polls.** With the example config (`longPollMs` 25 s), a lease call that finds nothing waits 25 s, so a single-threaded simulator such as `seed-web-demo-hub.mjs` lets its other leases expire. The seed now drops lost leases and continues, but a test hub needs `longPollMs` around 1000. A per-request opt-out (`wait: 0`) would help simulators and tests.

Closed since the last handoff: unplanned edges now carry endpoints, `/events` has `latest`, `before` and `runId`, and CORS allows `DELETE` with credentials.

## Risks and follow-ups

- Against a hub without `/session`, a script injected into the app's origin can read the token while the tab is open. Serve the app only from a trusted origin.
- The app and hub must share a site for the cookie. A remote hub on another domain needs the hub to serve the app (or a shared parent site); until then connecting fails with an explanation rather than falling back.
- The architect harness and providers come from hub config; `src/config/providers.json` still lists illustrative models for the editor.
- The router minimises crossings but does not eliminate them: a return arc from a gate's `fail` port crosses that gate's own `pass` edge right beside it, and delegate or message lanes below the main line can cross a return from the side lane. Labels never overlap.
- **Width.** One column per step makes long main lines wide: the nine-step build template fits a 1440 px live map at about 40 % zoom, which is hard to read without zooming in. Wrapping rows was the old answer and caused the doubling back. The coming restyle should decide how the live map frames long graphs (taller canvas, a readable minimum zoom like the editor's, or compact nodes for small graphs too).
- "Saved positions" means positions that do not overlap at the web's node size; there is no explicit marker in the graph schema. A hand arrangement that happens to overlap is re-laid out in view and live screens (the editor keeps it).
- Compact nodes and the Tidy layout button use existing styles only, pending the restyle.
- `DemoHub` and its fixtures are still in the main chunk.
