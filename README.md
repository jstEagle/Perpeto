# Perpeto

**The open-source software factory for coordinated agents.**

Perpeto is being built for sustained software development with many agents across machines. Project intent, documentation, execution, communication, and verification should remain understandable as individual agent sessions change.

## Current implementation

The repository contains a pinned T3 Code foundation with its orchestrator, all nine provider drivers, supporting runtime, and clients. It also includes Perpeto's persistent messaging service: project channels, role addressing, retry-safe messages, cursor reads, authenticated HTTP, and CLI/MCP clients.

This is an early foundation. The inherited web interface still uses T3 branding. The messaging service is integrated with environment authentication; networking between physical machines, the visual factory builder, durable factory scheduling, and user-owned CI execution remain unfinished. Imported provider support has not been validated against every live harness.

## Run locally

Requires Node 24.13.1 or newer within Node 24, and pnpm. The upstream workspace pins pnpm 11.10.0.

```sh
npm run setup
npm run build
npm start
```

The runtime listens on `127.0.0.1:4310` and prints a local pairing link. Open that link to authorize the inherited web client. Treat it as a credential. State lives in the ignored `.perpeto/runtime` directory, separate from a normal T3 installation.

Non-secret launch settings live in [config/perpeto.json](config/perpeto.json). Stop the server with Ctrl-C. No hosted relay or public endpoint is configured by these commands.

## Repository layout

```text
apps/                 deployable surfaces
  web/                @perpeto/web            web client
  apple/              Swift package and macOS app
  hub/                @perpeto/hub            factory control plane
  node/               @perpeto/node           machine daemon
  cli/                @perpeto/cli            perpeto command
packages/             libraries composed by the apps
  workflow/           @perpeto/workflow       graphs and run engine
  delivery/           @perpeto/delivery       CI evidence and merge queues
  accounts/           @perpeto/accounts       subscription account pool
  t3-executor/        @perpeto/t3-executor    runs assignments through T3
  messaging/          @perpeto/messaging      durable channel store
  sdk/                @perpeto/sdk            messaging client, CLI and MCP server
  design-tokens/      @perpeto/design-tokens  generated brand tokens and assets
tests/e2e/            @perpeto/e2e            cross-package end-to-end suites
brand/                brand direction, tokens source and explorations
docs/                 product, architecture, guides, research and handoffs
install/              installer and service templates
config/               non-secret configuration and upstream provenance
scripts/              runtime launcher, test runner and checks
vendor/t3code/        pinned T3 Code foundation
```

- `apps/` holds what you run or ship. Each app has its own README with commands.
- `packages/` holds libraries. Apps and tests import them by package name through npm workspaces. Only the vendored T3 server, a separate pnpm workspace, imports `packages/messaging` and `packages/t3-executor` by path.
- `tests/` holds suites that span several workspaces; unit tests stay next to their package.
- `brand/` is the source for identity and tokens; `packages/design-tokens` generates client outputs from it.
- `docs/` is mapped in [docs/README.md](docs/README.md).
- `install/`, `config/` and `scripts/` support setup, configuration and checks for the whole repository.
- `vendor/t3code/` is the imported upstream. Change it only deliberately and record each patch in `config/upstream-patches.json`.

## Check the foundation

```sh
npm test
npm run verify:upstream
npm run test:upstream
npm run smoke:messaging
```

`npm test` runs the Node suites for the hub, node, CLI, libraries, end-to-end tests and launcher; each workspace also has its own `npm test -w <package>`. The clients have their own checks: `npm test -w @perpeto/web` and `npm run build:web` for the web app, `npm run build:apple` and `swift test --package-path apps/apple` for the Apple app. Upstream checks cover selected orchestration, provider registry, and machine-grouping behavior. `npm run runtime:help` shows the inherited CLI reference after a build. See [current verification and next work](docs/product/status.md).

Use the [messaging guide](docs/guides/messaging.md) to connect CLI or harness clients.

## Product and brand

- [Living vision and decisions](docs/product/vision.md)
- [Build brief](docs/product/brief.md) and [definition of done](docs/product/definition-of-done.md)
- [Brand direction](brand/README.md) and [visual explorations](brand/preview.html)
- [T3 source study](docs/research/t3-code.md) and [implementation decisions](docs/architecture/decisions.md)
- [Documentation map](docs/README.md)

The visual explorations remain proposals, with [brand/tokens.css](brand/tokens.css) as the source for the proposed Workshop system.

## License and contributing

MIT. T3 Code's original license and attribution are retained; see [third-party notices](THIRD_PARTY_NOTICES.md) and [the source pin](config/upstream.json). Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing the implementation.
