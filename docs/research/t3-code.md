# T3 Code reference study

Reviewed 17 October 2026. Source: [pingdotgg/t3code](https://github.com/pingdotgg/t3code), commit `89b42bfeb4f79408af72fc7bb7a4482e22bb9493`.

Method: read upstream documentation and selected implementation files in a temporary checkout. No application launch, network pairing, or live harness execution was tested. Findings describe the inspected source, not verified runtime behavior. Perpeto recommendations below are proposals.

## Harness integration

T3 places provider-specific protocols behind adapters and exposes normalized commands, events, and capabilities to orchestration and clients. Codex uses its app-server protocol; Claude uses the Claude Agent SDK; Grok uses ACP infrastructure. These are integrations with existing harnesses, rather than a new coding-agent reasoning loop.

The shared contract covers session and turn lifecycle, messages, tool activity, subagents, plans, approvals, questions, and failures. Drivers represent integrations; instances represent configured accounts and their lifecycles. Provider capabilities determine which operations are available, including native resume, fork, rollback, and steering. A consistent interface does not mean identical provider behavior.

T3 also has harness-backed utility generation: the inspected Codex text-generation implementation launches `codex exec`. This is relevant to Perpeto's requirement that inference go through harnesses, including orchestration-related text generation.

Sources: [provider guidance](https://github.com/pingdotgg/t3code/blob/89b42bfeb4f79408af72fc7bb7a4482e22bb9493/docs/internals/providers.md), [adding providers](https://github.com/pingdotgg/t3code/blob/89b42bfeb4f79408af72fc7bb7a4482e22bb9493/docs/internals/adding-a-provider.md), [adapter contract](https://github.com/pingdotgg/t3code/blob/89b42bfeb4f79408af72fc7bb7a4482e22bb9493/packages/provider-core/src/server/ProviderAdapter.ts), [Codex utility generation](https://github.com/pingdotgg/t3code/blob/89b42bfeb4f79408af72fc7bb7a4482e22bb9493/apps/server/src/textGeneration/CodexTextGeneration.ts).

## Execution and interface ownership

An environment server owns its workspace, Git operations, terminals, providers, and durable state. Web, Electron desktop, and mobile clients control environments through authenticated RPC. A shared client runtime owns connections and synchronized state; platform clients supply storage, credentials, lifecycle signals, and UI.

Orchestration persists intent, events, projections, command receipts, and pending effects transactionally. A separate worker performs side effects. An accepted command therefore does not mean the agent completed the work. Provider completion is also separate from checkpoint and finalization work.

Perpeto could adopt these ownership boundaries without adopting T3's stack. Factory acceptance would need an additional distinction: completed agent work versus evidence that the project requirement was satisfied.

Sources: [architecture](https://github.com/pingdotgg/t3code/blob/89b42bfeb4f79408af72fc7bb7a4482e22bb9493/docs/internals/overview.md), [event sink](https://github.com/pingdotgg/t3code/blob/89b42bfeb4f79408af72fc7bb7a4482e22bb9493/apps/server/src/orchestration-v2/EventSink.ts), [connection runtime](https://github.com/pingdotgg/t3code/blob/89b42bfeb4f79408af72fc7bb7a4482e22bb9493/docs/internals/connection-runtime.md).

## Machines, routes, and reconnection

An environment has a stable identity independent of its address. Clients can keep several routes to it: direct LAN, VPN/Tailscale, SSH, and T3 Connect. The shared runtime selects a working route and can return to a preferred route. Authentication and environment identity matter independently of reachability. Cached data remains readable while offline, with freshness distinct from connection health.

SSH can launch a remote server and forward a port. Cleanup distinguishes servers started by that launcher from existing servers it merely discovered. T3 Connect adds cloud identity and managed tunnels; its relay brokers access, while ordinary application traffic travels through the environment's tunnel. Connecting clients does not relocate execution away from the workspace's host.

Sources: [remote architecture](https://github.com/pingdotgg/t3code/blob/89b42bfeb4f79408af72fc7bb7a4482e22bb9493/docs/internals/remote.md), [T3 Connect](https://github.com/pingdotgg/t3code/blob/89b42bfeb4f79408af72fc7bb7a4482e22bb9493/docs/internals/t3-connect.md).

## Cross-machine work: an important boundary

T3 can group project checkouts across environments. Optional load balancing on web and desktop chooses an environment for a new thread using resource availability and machine preferences. The inspected selector scores eligible candidates using CPU capacity, utilization, available-memory fraction, and weight, rejecting stale or exhausted candidates.

Existing threads remain on their original machine. Mobile selection is manual. Project grouping does not merge environment permissions or establish a shared cross-machine project authority. This is useful placement of new work, but should not be treated as evidence of a durable distributed factory scheduler with dependencies, recovery, and shared acceptance criteria.

Sources: [remote access and load balancing](https://github.com/pingdotgg/t3code/blob/89b42bfeb4f79408af72fc7bb7a4482e22bb9493/docs/user/remote-access.md), [selector implementation](https://github.com/pingdotgg/t3code/blob/89b42bfeb4f79408af72fc7bb7a4482e22bb9493/packages/client-runtime/src/load-balancing.ts).

## Context portability and setup

Switching harnesses does not transfer native reasoning or live tool state. Portable context is a bounded representation of saved conversation material. Upstream internal and user handoff documentation disagree on the exact selection algorithm in this snapshot; do not adopt those details without tracing the current implementation.

The repository includes background-service, remote setup, provider installation/authentication, and maintenance workflows. Its documented dev container is for developing T3 itself; it is not sufficient evidence of a general-purpose dev-box provisioning product.

Sources: [portable handoffs](https://github.com/pingdotgg/t3code/blob/89b42bfeb4f79408af72fc7bb7a4482e22bb9493/docs/user/portable-handoffs.md), [internal handoff notes](https://github.com/pingdotgg/t3code/blob/89b42bfeb4f79408af72fc7bb7a4482e22bb9493/docs/internals/context-handoffs.md), [maintainer dev container](https://github.com/pingdotgg/t3code/blob/89b42bfeb4f79408af72fc7bb7a4482e22bb9493/docs/internals/devcontainer.md).

## Implications to discuss for Perpeto

- Reuse the conceptual split between clients, execution environments, and harness adapters.
- Keep all inference in harnesses, while making deterministic coordination ordinary application logic. Decide whether planning agents themselves are harness sessions controlled by Perpeto.
- Distinguish seamless access, new-task placement, deliberate handoff, and automatic failover. They carry different guarantees and complexity.
- Prefer capability-aware adapters over promising uniform behavior across every harness.
- Consider a project-wide authority for goals, dependencies, ownership, and evidence if Perpeto must coordinate work across environments. Its location and availability requirements are undecided.
- Treat the factory layout as a product question: what should the user oversee beyond individual conversations?

## Next questions

Does one Perpeto project span machines with coordinated assignments, or does each machine own independent projects that can be viewed together? What should continue when the laptop sleeps? What concrete factory workflow should replace today's manual movement between agent chats?
