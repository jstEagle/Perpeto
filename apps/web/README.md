# Perpeto web app

```sh
source ~/.nvm/nvm.sh && nvm use 24
npm ci
npm run dev        # http://localhost:5180, demo data until a hub is set in Settings
npm test           # Vitest
npm run typecheck
npm run build
node scripts/screenshots.mjs   # with the dev server running; writes screenshots/
node scripts/smoke.mjs         # browser smoke test of the main flows
```

Brand values come only from `src/styles/tokens.css`. See [the handoff](../../docs/handoffs/web-app.md) for scope, verification and contract assumptions.
