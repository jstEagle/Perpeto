# Contributing

Perpeto is in early implementation. Read the [vision](docs/product/vision.md), [build brief](docs/product/brief.md), and [current status](docs/product/status.md) before changing direction.

Keep proposals, implemented behavior, and verified outcomes distinct. Include a real workflow or failure case when proposing a change. New factory code lives outside `vendor/t3code`: deployable surfaces in `apps/`, libraries in `packages/`, cross-package suites in `tests/`, each with its own README and `test` script. Import other workspaces by package name, not relative path. Deliberate changes to the imported foundation must include provenance and verification updates.

Use Node 24.13.1 or newer within Node 24 and pnpm 11.10.0. Install dependencies once, then run the contributor checks from the repository root:

```sh
npm run setup
npm run check
```

`npm run check` runs all Perpeto Node tests (including cross-package end-to-end suites), upstream provenance verification, web typecheck/tests/production build, vendored server typecheck, focused upstream tests (including AgentPolicy), the vendored runtime build, and the authenticated messaging HTTP/CLI/MCP smoke test. It stops on the first failure and does not install dependencies or invoke live model providers. On macOS it also runs `swift build` and `swift test` in `apps/apple`; install full Xcode and select its developer directory first. Other platforms explicitly skip Apple checks, which are covered by the macOS CI job.

For a targeted iteration, use `npm test` for Perpeto code, `npm run typecheck -w @perpeto/web` and `npm test -w @perpeto/web` for the web client, or `npm run typecheck:upstream` and `npm run test:upstream` for the inherited runtime. Use `npm run verify:upstream` to check the original source import; update recorded hashes only when an upstream change is intentional and explained. CI uses one root `npm ci` per Node job for all npm workspaces; the upstream job additionally installs its separate, frozen pnpm workspace.

Use configuration files for all non-secret settings. Environment variables and secret stores are reserved for credentials and private values. Never commit runtime state, pairing links, secrets, or private project data.

Code is licensed under MIT. Preserve upstream and third-party attribution.
