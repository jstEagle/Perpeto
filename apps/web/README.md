# Perpeto web app

```sh
source ~/.nvm/nvm.sh && nvm use 24
npm ci                              # at the repository root; the web app is an npm workspace
npm run dev:web                     # http://localhost:5180, demo data until a hub is set in Settings
npm test -w @perpeto/web            # Vitest
npm run typecheck -w @perpeto/web
npm run build:web
node apps/web/scripts/screenshots.mjs   # with the dev server running; writes apps/web/screenshots/
node apps/web/scripts/theme-screenshots.mjs  # light and dark captures in apps/web/screenshots/themes/
OUT=screenshots/pacing ONLY=accounts,pacing node apps/web/scripts/theme-screenshots.mjs  # just Accounts and Pacing
DEMO=observe node apps/web/scripts/theme-screenshots.mjs  # observe-only Home, Sessions, Accounts, Pacing, Usage in screenshots/observe/
node apps/web/scripts/smoke.mjs         # browser smoke test of the main flows
node apps/web/scripts/perf.mjs http://localhost:5180 200   # live map frame rates and latencies, synthetic graph

# Against a real hub (see apps/hub/README.md). In its config: corsOrigins ["http://localhost:5180"],
# and longPollMs 1000 so the seed's simulated machines keep their leases.
node apps/web/scripts/seed-web-demo-hub.mjs http://127.0.0.1:4320 path/to/owner.secret --hold
node apps/web/scripts/hub-screenshots.mjs http://localhost:4320 path/to/owner.secret
```

Connect in Settings with the hub URL and owner token. The app exchanges the token for the hub's HttpOnly session cookie and stores no token. The cookie is SameSite=Strict, so use the same host name for the app and the hub (`localhost` for both, not `localhost` and `127.0.0.1`). Only a hub without the session route falls back to keeping the token in this tab's session storage.

Settings › Appearance switches between System (the default, follows the device), Light (pure white) and Dark (graphite). The choice is saved in this browser under `perpeto.appearance` and applied before first paint through `data-theme` on `<html>`.

Accounts shows each Claude and Codex subscription with its plan, machine, session and weekly meters (with "resets in" and the hub's projection at reset), its pacing state, and an inline editor for label and plan (`PATCH /accounts/:id`). Pacing, under Factory, has the headline sentence, what limits each provider, the rotation timeline for the next ten hours and the settings (`GET /pacing`, `PUT /pacing/settings`, refreshed on `pacing.updated`). Decoding in `src/api/pacing.ts` is tolerant of the still-moving contract; a hub without `/pacing` gets an explanation instead of an error. The `perpeto` CLI has no command to enrol a login yet, and the "Add subscription" dialog says so.

## Observe-only mode

When the hub has no projects, the app is about the factory: `/` is Home (the pacing advice line, machines, sessions running now, subscriptions with their meters, tokens over 24 hours) and the project navigation (workflows, runs, work, messages, merge queue) is hidden. With projects, `/` is the project list as before and `/projects` always lists them. Sessions, first under Factory, lists every observed T3 Code session by machine with status filters and subagents folded under their parent (`GET /sessions`, `GET /sessions/summary`, refreshed on `session.*` events, debounced). Accounts and Pacing handle `source: 'observed'` subscriptions and `mode: 'advise'` pacing: no enforcement controls, advice and `headroomAgents` instead. Usage switches between factory runs and T3 sessions, and shows only sessions without projects. Decoding is in `src/api/sessions.ts` and tolerates missing fields and unknown statuses; a hub without the routes gets an explanation.

Without a hub, Settings › Demo data picks the full factory (default) or the observe-only demo (two Macs, 13 sessions, Claude Max and ChatGPT Pro). `?demo=observe` in the address does the same.

Brand values come only from `src/styles/tokens.css`. See [the handoff](../../docs/handoffs/web-app.md) for scope, verification and contract assumptions.

## Third-party notices

The workflow map is drawn with [React Flow](https://reactflow.dev) (`@xyflow/react`), MIT License, Copyright (c) 2019-2025 webkid GmbH. The map hides the library's on-canvas attribution through its supported `proOptions.hideAttribution` option; this notice and the license text shipped in `node_modules/@xyflow/react/LICENSE` carry the attribution instead.
