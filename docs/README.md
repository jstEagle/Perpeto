# Documentation

Start with the [quick start](../README.md#run-locally), [build status](product/status.md) and [acceptance checklist](product/definition-of-done.md). Status below is as of 21 October 2026, local main `0508551`. A contract or proposal is not proof of implementation; historical handoffs describe their own revisions and may contain superseded gaps.

## Product, architecture and guides

| Document | Purpose and status |
| --- | --- |
| [Vision](product/vision.md) | Living discussion, requested capabilities and explicit decisions; requests are not all implemented. |
| [Direction](product/direction.md) | Original product hypothesis; proposed. |
| [Discussion](product/discussion.md) | Historical question list; some questions now have decisions in Vision. |
| [Build brief](product/brief.md) | Mission and initial sequence; foundation-first sequencing is historical. |
| [Definition of done](product/definition-of-done.md) | Evidence-backed checklist; local acceptance partial, cross-machine acceptance open. |
| [Build status](product/status.md) | Current apps/packages, recorded verification and remaining limits. |
| [Factory architecture](architecture/README.md) | Shared implementation contract; some platform/verification wording predates later handoffs. |
| [Implementation decisions](architecture/decisions.md) | Recorded T3, state and configuration decisions. |
| [Design system](architecture/design-system.md) | Selected Perpeto Mono specification; restyle progress wording predates the Apple handoff. |
| [Messaging transport](architecture/messaging.md) | Implemented T3-hosted HTTP/auth contract; hub transport is covered in the hub handoffs. |
| [Install](guides/install.md) | Current CLI setup, lifecycle, enrollment, credentials and service instructions; real service loading unverified. |
| [Remote machines](guides/remote-machines.md) | Implemented Tailscale/pinned-HTTPS join and rotation commands; real LAN/tailnet acceptance pending. |
| [Messaging](guides/messaging.md) | Runtime-hosted CLI/MCP setup and recorded local live Codex smoke. |
| [Prerequisites](guides/prerequisites.md) | Foundation-era setup inventory; harness and push-access claims are historical. Use Build status for current evidence. |
| [T3 Code study](research/t3-code.md) | Source research at a pinned revision; proposals, not runtime acceptance. |
| [Brand](../brand/README.md) | Mono UI selected; other brand choices remain provisional. Restyle wording predates the Apple update. |

## Implementation handoffs

All Markdown handoffs are listed here. Later addenda and commits supersede earlier counts, branch status and integration gaps; see [build status](product/status.md) for the reconciled result.

| Document | Scope and evidence status |
| --- | --- |
| [Initial foundation](handoffs/initial-foundation.md) | Import, build/start/restart and initial hosted Linux CI; historical milestone. |
| [Foundation review](handoffs/foundation-review.md) | Initial independent review; launcher/build findings subsequently addressed. |
| [Messaging core](handoffs/messaging-core.md) | Durable SQLite store; local tests, initial transport gaps superseded. |
| [Messaging client](handoffs/messaging-client.md) | CLI/MCP, reviews and bounded-history increment; local automated checks. |
| [Messaging transport](handoffs/messaging-transport.md) | T3 auth/HTTP integration; real-network loopback tests. |
| [Messaging UI](handoffs/messaging-ui.md) | Inherited T3 messaging page; local paired browser checks. Unbounded-history limit superseded. |
| [Messaging history UI](handoffs/messaging-history-ui.md) | Bounded requests/DOM, older-history browsing; local browser verification. |
| [Hub](handoffs/factory-hub.md) | Control plane, original burst load and later credentials/retention/bundle updates; original unwired-engine limits superseded. |
| [Workflow](handoffs/factory-workflow.md) | Engine, templates, architect, metrics and acceptance fixes; automated tests, later live integration. |
| [Node](handoffs/factory-node.md) | Daemon, CI and hub-source bundles; automated tests, later live integration. |
| [Delivery](handoffs/factory-delivery.md) | CI evidence and local/GitHub queues; real local Git, stubbed GitHub. |
| [Accounts](handoffs/factory-accounts.md) | Pool and T3 binding; synthetic credentials. Reservation gaps updated in review/executor follow-ups. |
| [T3 executor](handoffs/factory-t3.md) | T3 turns, policy, account leases and isolation; live Codex and earlier Claude checks, Claude isolation pending. Workspace-resolution gap superseded. |
| [Integration](handoffs/integration.md) | Initial hub/engine/node/delivery e2e with fake agents; several listed gaps closed later. |
| [Hub wiring and recovery](handoffs/hub-wiring.md) | Repo propagation, SDK, fake-forge publication, SIGKILL recovery and hub bundles; local process tests. |
| [Wave 3 review](handoffs/review-wave3.md) | Independent findings, fix annotations and 60-second simulated-fleet benchmark; remaining findings retained. |
| [CLI](handoffs/perpeto-cli.md) | Installer/lifecycle and review fixes; real local hub, service managers stubbed. |
| [Web app](handoffs/web-app.md) | Client, maps, storage, Chromium checks and seeded real-hub screens; cookie/event requests subsequently implemented. |
| [Apple app](handoffs/apple-app.md) | Mono macOS/iOS/iPadOS client; tests, local-hub round trip, Mac captures and simulator builds/captures. Physical devices pending. |
| [Design tokens](handoffs/design-tokens.md) | Selected Mono generator, contrast tests and specimen captures; original client-restyle follow-ups are historical. |
| [Live acceptance run 1](handoffs/live-acceptance-1.md) | Real Codex workflow merged sample code locally; failures, fixes, screens and isolation follow-up. Its “not merged” branch notes are historical on this main. |

App/package READMEs are linked from the [repository layout](../README.md#repository-layout) and [build status](product/status.md). Keep requested direction, approved decisions, implemented behavior and verified outcomes explicit when adding documentation.
