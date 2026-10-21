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

# Against a real hub (see apps/hub/README.md; allow http://localhost:5180 in corsOrigins)
node apps/web/scripts/seed-web-demo-hub.mjs http://127.0.0.1:4320 path/to/owner.secret --hold
node apps/web/scripts/hub-screenshots.mjs http://127.0.0.1:4320 path/to/owner.secret
```

Connect in Settings with the hub URL and owner token. The app asks the hub for an HttpOnly session cookie; until the hub serves that route, the token stays in this tab's session storage only.

Brand values come only from `src/styles/tokens.css`. See [the handoff](../../docs/handoffs/web-app.md) for scope, verification and contract assumptions.
