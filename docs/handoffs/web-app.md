# Perpeto web app

Implemented `apps/web`: a self-contained Vite + React + TypeScript app with TanStack Router (code-based routes) and `@xyflow/react` for workflow graphs. It has its own lockfile and `dev`, `build`, `test`, `typecheck`, `screenshots` scripts. Node 24. Default dev port 5180.

It follows `docs/architecture/README.md` as of the "Agent-authored workflows" and "Observing runs" addendum on `main`. It talks only to the hub; it was not run against a real hub because none existed in this worktree. Every screen was exercised with the built-in demo adapter.

## What exists

| Area | Implemented |
| --- | --- |
| Hub client | `src/api/client.ts`: typed method for every Hub API v1 owner route, including drafts, versions, diff, activate and run/project metrics. Bearer token header, `idempotencyKey` on every write, contract error bodies surfaced as `HubError`. Events stream over `fetch` + SSE parser (EventSource cannot send `Authorization`), with resume from last `seq`, backoff, and a polling fallback if the hub answers JSON. |
| Settings | Base URL and owner token stored in `localStorage` (`perpeto.hub.v1`). Remote plain HTTP is refused. "Test connection" calls `/health` then `/overview`. Disconnect returns to demo data. |
| Demo adapter | `src/api/demo.ts` + `fixtures.ts`: deterministic factory used when no hub is configured; a dashed "Demo data" chip in the top bar says so. Story: perpeto's Build run has a saturated reviewer (utilization 1.00, 7 queued, p90 wait 48 min), a rework loop (1.9 iterations per item), an unplanned Reviewer → Planner messaging interaction, and two machines (studio-mac, build-linux). An agent-proposed v4 adds Fast checks and raises reviewer concurrency. A ticker replays small interactions every 9 s. State resets on reload. |
| Workflows | Prompt-first: "Describe how this project should be built" with examples. The architect's progress is followed through `assignment.state` events, then the proposal opens with rationale, the prompt, validation status, and a diff against the active version drawn on the graph (added green, changed amber with changed keys, removed red dashed) plus a list. Actions: Activate version N, Ask for changes (another prompt with `baseWorkflowId`), Edit by hand. Version history shows authoredBy. Manual start from Build/Improve/Blank templates is a secondary link. |
| Editor | Palette (click or drag), typed ports (flow in/out; `pass`/`fail` on gates; round role ports for delegates/messages, kind chosen in the toolbar), visually distinct edge kinds, inspector for every node type (harness, model, prompt, concurrency, agent policy, CI steps and machine requirements, merge strategy, loop limits), keyboard-accessible "Add connection" form, live validation that blocks save, server validation merged in when connected, unsaved-changes guard. Save is `PUT` and opens the new draft version. |
| Run live map | Same graph with per-node active/queued, utilization of concurrency, wait, throughput, work item markers, bottleneck flags with evidence; edge traffic counts per kind; unplanned interactions drawn in warning dash-dot. Clicking a node or edge filters the interaction feed and shows its metrics and assignments (machine, harness, model, status). Panels: bottlenecks, velocity (items/day trend, cycle time, WIP, tokens per item), where work is running (machines → agents → nodes), and a node metrics table. Pause, resume, stop (confirmed), add input. Tabs for work items, assignments and timeline. |
| Other screens | Projects (create), project overview (repo, goals editor, docs, agents, tokens today/7 d, top bottleneck, velocity, runs, merge queue health), runs, work board (human gate approve/return), messages (project and run channels, older pages, recipient role), merge queue, machines (enrollment code shown once, drain), accounts, usage (day chart, provider/model/machine tables), 404. Project agent and token counts stay visible in the project sidebar. |

## Brand

All colour, type, spacing and radius values come from `src/styles/tokens.css`, which imports `brand/tokens.css` and defines the `--text-*`, `--space-*` and `--leading-*` scales plus tints mixed from canonical tokens. To adopt `packages/design-tokens`, repoint that one import and delete the stopgap scale. A grep finds no colour literals elsewhere; the only hex in `src` is the logo recolour regex. Logos are unchanged copies of `brand/identity/*.svg` in `src/brand/`, rendered with `currentColor`; the loader is the Relay motion from `brand/motion`, static under reduced motion. No favicon is set because brand/README.md says not to ship an untested symbol as one.

## Verification

- `npm run typecheck` and `npm run build` pass. Build warns that the single JS chunk is 680 kB (210 kB gzip); route-level code splitting is not done.
- `npm test`: 17 Vitest tests pass (validation incl. unbounded cycles and policy conflicts, every demo version valid, v3→v4 diff, SSE frame parsing, client headers/envelopes/errors/run-list fallback, demo architect draft → activate, invalid save, stopped run).
- `node scripts/smoke.mjs` against the dev server passed in headless Chromium with no page or console errors: architect draft → proposal → activate; proposal diff; keyboard-added node shows validation and blocks save; inspector edit saves v5 with diff; node selection filters feed; pause/resume; skip link first and visible focus ring; remote HTTP refused.
- `node scripts/screenshots.mjs`: 17 screens at 1440 and 390 wide, captured with reduced motion, no browser errors. Inspected against the favorite boards and iterated (two-row graph layout, full-width map, narrow-screen viewport, nav state, table alignment). Files are in [apps/web/screenshots](../../apps/web/screenshots/), for example `run-live-map-desktop.png`, `workflow-proposal-desktop.png`, `editor-desktop.png`, `architect-progress-desktop.png`, `run-node-selected-desktop.png`, and `*-mobile.png`.

Not verified: any real hub, real SSE stream, real messaging routes under `/api/v1/messaging`, screen readers, Safari or Firefox, touch dragging in the editor.

## Contract gaps and assumptions for the lead

These are isolated in `src/api/client.ts` and `src/api/types.ts`:

1. **No project run list.** The client tries `GET /projects/:id/runs`, then rebuilds the list from `run` events. Recommend adding the route.
2. **No owner route for one assignment.** Architect progress is read from `assignment.state` events (`data.state`, `summary`, `provider`, `model`, `machineId`). On success the client uses `data.workflowId`/`data.version` if present, else finds the workflow whose `authoredBy.assignmentId` matches.
3. **Unspecified envelopes:** `/overview` (`activeAgents`, `queuedWork`, `tokensToday`, `machinesOnline`), `/usage` rows (`key` + token sums), `/validate` (`{ valid, issues[] }`), `/diff` (`{ nodes, edges }` × `added/removed/changed`), metrics (`{ window, nodes, edges, run, bottlenecks }`; unplanned edges carry `from`/`to`). List routes accept bare arrays or `{ <name>: [] }`.
4. **Interaction event data** is assumed to carry `fromNode`, `toNode`, `nodeId`, `edgeId`, `unplanned`, `result`, `summary`.
5. **Ports:** the default flow port is omitted; gates (`review`, `ci`, `human`) use `pass`/`fail`; `loop` has one output, and cycles must pass through a loop node. Please align with `factory-workflow`.
6. `Workflow.createdAt` is used for history if present. `GET /workflows/:id` is assumed to return the latest version.
7. Messages are sent as role `owner` and assume messaging project IDs equal hub project IDs.

## Risks and follow-ups

- The owner token in `localStorage` is readable by any script on the app's origin. Serve the app only from a trusted origin, or move to a session cookie later.
- `src/config/providers.json` lists suggested provider/model pairs; model names are illustrative.
- The demo architect is a keyword stand-in, not an agent.
- The editor sits inside the project frame, so the canvas is narrower than it could be.
