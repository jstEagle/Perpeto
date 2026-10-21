# Perpeto

**The open-source software factory for coordinated agents.**

Perpeto is being built for sustained software development with many agents across machines. Project intent, documentation, execution, communication, and verification should remain understandable as individual agent sessions change.

## Current implementation

As of 21 October 2026, Perpeto has a hub, machine daemon, CLI, web app and native macOS/iPhone/iPad client, backed by workflow, delivery, accounts and messaging packages. The pinned T3 Code runtime supplies orchestration and all nine provider drivers. The hub coordinates durable workflows, agent assignments, revision-bound CI and merge queues; T3 runs the harness turns.

[Live acceptance run 1](docs/handoffs/live-acceptance-1.md) used real Codex turns on one Mac to draft a workflow, plan, build, reject and rework a change, test it on the node and merge working code into a local bare repository. Web and Mac clients have also been checked against a real local hub; iPhone/iPad builds and simulator captures exist. Real second-machine/LAN/tailnet operation, physical iOS devices, Safari/Firefox, Claude isolation and current hosted CI remain unverified. See [build status](docs/product/status.md) for evidence and open findings.

## Run locally

Requires Git, Node **>=24.13.1 <25** and pnpm **11.10.0**. Real agent work also needs an authenticated harness available to T3. These commands run from this checkout; installation and services are in the [install guide](docs/guides/install.md).

### Build and start T3

```sh
npm run setup
npm run build
npm start
```

Keep this terminal open. T3 listens on `127.0.0.1:4310` and stores its isolated state in `.perpeto/runtime`, controlled by [config/perpeto.json](config/perpeto.json). Its printed pairing link authorizes the inherited T3 client; treat it as a credential. Confirm the intended harness is ready there. This is the execution runtime, separate from the Perpeto hub and web app.

### Initialize the hub and join this machine

In another terminal:

```sh
node apps/cli/bin/perpeto.js hub init
```

Before starting, edit `~/.perpeto/hub.json`: set `corsOrigins` to `["http://localhost:5180"]` and choose an available `architectHarness` provider/model (the generated default is Codex `gpt-6.1-sol`). Then:

```sh
node apps/cli/bin/perpeto.js hub start
node apps/cli/bin/perpeto.js hub enroll-code
# Paste the printed enrollment file path in place of the example:
node apps/cli/bin/perpeto.js node join http://127.0.0.1:4320 --code-file /absolute/path/to/enrollment.secret
```

The generated `~/.perpeto/node.json` points at this checkout's T3 on port 4310; the executor derives its credential-state path from `config/perpeto.json`. Keep `runtime.enabled: false` while T3 runs in the first terminal. If using a different T3 instance, edit `runtime.url` and `runtime.t3.baseDir` (an absolute path) before starting the node. Non-secret settings stay in these JSON files.

```sh
node apps/cli/bin/perpeto.js node start
node apps/cli/bin/perpeto.js doctor
node apps/cli/bin/perpeto.js status
```

CLI hub/node state defaults to private `~/.perpeto`; use a consistent `--dir /absolute/private/directory` before every subcommand for another installation. Enrollment codes expire and are secrets. Joining a node alone does not configure or authenticate T3. For another machine, use the [LAN/tailnet guide](docs/guides/remote-machines.md); real network acceptance is still pending.

### Open the Perpeto web app

```sh
npm run dev:web
```

Open [localhost:5180](http://localhost:5180/). In Settings connect to `http://localhost:4320` with the owner token from `~/.perpeto/hub/owner.secret`, entered locally. Use **localhost for both app and hub** so the hub's SameSite session cookie works. Without a working session the app can show demo data; confirm your actual project/machine appears.

Create a project pointing at a repository the node can access, ask for a workflow draft, review and activate it, then start a run with an input. Use a throwaway repository for the first run: a configured merge queue can publish to its base branch. The [acceptance record](docs/handoffs/live-acceptance-1.md#setup) shows the tested local-bare-repository setup and API sequence; the [web README](apps/web/README.md) covers client checks.

### Open the Apple app

On macOS 15+ with Xcode 27 / Swift 6:

```sh
apps/apple/scripts/build-app.sh
open apps/apple/build/Perpeto.app
```

In Settings (⌘,), enter `http://localhost:4320` and the same owner token; the app stores it in Keychain. For the iPhone/iPad simulator, build/open `apps/apple/iOS/Perpeto.xcodeproj` using the [Apple guide](apps/apple/README.md). Physical-device signing/distribution is not configured.

Stop CLI daemons with `node apps/cli/bin/perpeto.js node stop` and `node apps/cli/bin/perpeto.js hub stop`; stop foreground T3/web servers with Ctrl-C. No public relay is configured.

## Repository layout

```text
apps/                 deployable surfaces
  web/                @perpeto/web            web client
  apple/              Swift package, macOS and iOS apps
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

## Check the implementation

```sh
npm run check
```

`npm run check` runs Node, provenance, web, upstream, runtime build and messaging smoke checks, plus Swift build/tests on macOS. `npm test` runs the Node suites for the hub, node, CLI, libraries, end-to-end tests and launcher; each workspace also has its own `npm test -w <package>`. The clients have their own checks: `npm test -w @perpeto/web` and `npm run build:web` for the web app, `npm run build:apple` and `swift test --package-path apps/apple` for the Apple app. Upstream checks cover selected orchestration, provider registry, and machine-grouping behavior. `npm run runtime:help` shows the inherited CLI reference after a build. See [current verification and next work](docs/product/status.md).

Use the [messaging guide](docs/guides/messaging.md) to connect CLI or harness clients.

## Product and brand

- [Living vision and decisions](docs/product/vision.md)
- [Build brief](docs/product/brief.md) and [definition of done](docs/product/definition-of-done.md)
- [Brand direction](brand/README.md) and [visual explorations](brand/preview.html)
- [T3 source study](docs/research/t3-code.md) and [implementation decisions](docs/architecture/decisions.md)
- [Documentation map](docs/README.md)

The product UI follows Perpeto Mono, selected by Justus on 21 October 2026: minimal, spacious, monochrome and rounded. [brand/tokens.css](brand/tokens.css) is its source of truth; other brand explorations remain proposals.

## License and contributing

MIT. T3 Code's original license and attribution are retained; see [third-party notices](THIRD_PARTY_NOTICES.md) and [the source pin](config/upstream.json). Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing the implementation.
