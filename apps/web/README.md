# Perpeto web app

```sh
source ~/.nvm/nvm.sh && nvm use 24
npm ci                              # at the repository root; the web app is an npm workspace
npm run dev:web                     # http://localhost:5180, demo data until a hub is set in Settings
npm test -w @perpeto/web            # Vitest
npm run typecheck -w @perpeto/web
npm run build:web
node apps/web/scripts/screenshots.mjs   # with the dev server running; writes apps/web/screenshots/
node apps/web/scripts/smoke.mjs         # browser smoke test of the main flows
node apps/web/scripts/perf.mjs http://localhost:5180 200   # live map frame rates and latencies, synthetic graph

# Against a real hub (see apps/hub/README.md). In its config: corsOrigins ["http://localhost:5180"],
# and longPollMs 1000 so the seed's simulated machines keep their leases.
node apps/web/scripts/seed-web-demo-hub.mjs http://127.0.0.1:4320 path/to/owner.secret --hold
node apps/web/scripts/hub-screenshots.mjs http://localhost:4320 path/to/owner.secret
```

Connect in Settings with the hub URL and owner token. The app exchanges the token for the hub's HttpOnly session cookie and stores no token. The cookie is SameSite=Strict, so use the same host name for the app and the hub (`localhost` for both, not `localhost` and `127.0.0.1`). Only a hub without the session route falls back to keeping the token in this tab's session storage.

Brand values come only from `src/styles/tokens.css`. See [the handoff](../../docs/handoffs/web-app.md) for scope, verification and contract assumptions.

## Third-party notices

The workflow map is drawn with [React Flow](https://reactflow.dev) (`@xyflow/react`), MIT License, Copyright (c) 2019-2025 webkid GmbH. The map hides the library's on-canvas attribution through its supported `proOptions.hideAttribution` option; this notice and the license text shipped in `node_modules/@xyflow/react/LICENSE` carry the attribution instead.
