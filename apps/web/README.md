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
```

Brand values come only from `src/styles/tokens.css`. See [the handoff](../../docs/handoffs/web-app.md) for scope, verification and contract assumptions.
