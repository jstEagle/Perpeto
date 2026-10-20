# Perpeto

**The open-source software factory for coordinated agents.**

Perpeto is being built for sustained software development with many agents across machines. Project intent, documentation, execution, communication, and verification should remain understandable as individual agent sessions change.

## Current implementation

The repository contains a pinned T3 Code foundation with its orchestrator, all nine provider drivers, supporting runtime, and clients. It also includes Perpeto's initial SQLite messaging store: project channels, stable role identities, retry-safe messages, and cursor reads that survive a restart.

This is an early foundation. The inherited web interface still uses T3 branding. Factory messaging is currently a storage API; cross-device messaging, the visual factory builder, durable factory scheduling, and user-owned CI execution are not yet integrated. Imported provider support has not been validated against every live harness.

## Run locally

Requires Node 24.13.1 or newer within Node 24, and pnpm. The upstream workspace pins pnpm 11.10.0.

```sh
npm run setup
npm run build
npm start
```

The runtime listens on `127.0.0.1:4310` and prints a local pairing link. Open that link to authorize the inherited web client. Treat it as a credential. State lives in the ignored `.perpeto/runtime` directory, separate from a normal T3 installation.

Non-secret launch settings live in [config/perpeto.json](config/perpeto.json). Stop the server with Ctrl-C. No hosted relay or public endpoint is configured by these commands.

## Check the foundation

```sh
npm test
npm run verify:upstream
npm run test:upstream
```

`npm test` runs Perpeto messaging and launcher tests. Upstream checks cover selected orchestration, provider registry, and machine-grouping behavior. `npm run runtime:help` shows the inherited CLI reference after a build. See [current verification and next work](docs/status.md).

## Product and brand

- [Living vision and decisions](docs/vision.md)
- [Build brief](docs/brief.md) and [definition of done](docs/definition-of-done.md)
- [Brand direction](brand.md) and [visual explorations](brand/preview.html)
- [T3 source study](docs/research/t3-code.md) and [implementation decisions](docs/decisions.md)
- [Documentation map](docs/README.md)

The visual explorations remain proposals, with [brand/tokens.css](brand/tokens.css) as the source for the proposed Workshop system.

## License and contributing

MIT. T3 Code's original license and attribution are retained; see [third-party notices](THIRD_PARTY_NOTICES.md) and [the source pin](config/upstream.json). Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing the implementation.
