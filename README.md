# Perpeto

**The open-source software factory for coordinated agents.**

Perpeto is being built for sustained software development with many agents across machines. Project intent, documentation, execution, communication, and verification should remain understandable as individual agent sessions change.

## Current implementation

The repository contains a pinned T3 Code foundation with its orchestrator, all nine provider drivers, supporting runtime, and clients. It also includes Perpeto's persistent messaging service: project channels, role addressing, retry-safe messages, cursor reads, authenticated HTTP, and CLI/MCP clients.

This is an early foundation. The inherited web interface still uses T3 branding. Messaging has a working browser view and harness tools. Versioned factory definitions and an initial user-owned CI queue/worker are implemented. Networking between physical machines, visual factory editing, graph execution and durable factory scheduling remain unfinished. Imported provider support has not been validated against every live harness.

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
npm run smoke:messaging
npm run smoke:factory
```

`npm test` runs Perpeto storage, client, factory definition, runner process and launcher tests. Upstream checks cover selected orchestration, provider registry, and machine-grouping behavior. `npm run runtime:help` shows the inherited CLI reference after a build. See [current verification and next work](docs/status.md).

The optional `npm run smoke:harness` check uses an existing local Codex subscription to run one tool-free turn through the imported adapter in isolated state. It is excluded from CI. Settings and timeouts are in [config/smoke-harness.json](config/smoke-harness.json); see [the verified path and prerequisites](docs/handoffs/factory-execution-seams.md#optional-actual-imported-codex-proof).

Use the [messaging guide](docs/messaging.md) to connect CLI or harness clients, and the [runner guide](packages/factory-runner/README.md) to execute revision-pinned CI on an owned machine. See the [architecture](docs/architecture.md) for current boundaries.

## Product and brand

- [Living vision and decisions](docs/vision.md)
- [Build brief](docs/brief.md) and [definition of done](docs/definition-of-done.md)
- [Brand direction](brand.md) and [visual explorations](brand/preview.html)
- [T3 source study](docs/research/t3-code.md) and [implementation decisions](docs/decisions.md)
- [Documentation map](docs/README.md)

The visual explorations remain proposals, with [brand/tokens.css](brand/tokens.css) as the source for the proposed Workshop system.

## License and contributing

MIT. T3 Code's original license and attribution are retained; see [third-party notices](THIRD_PARTY_NOTICES.md) and [the source pin](config/upstream.json). Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing the implementation.
