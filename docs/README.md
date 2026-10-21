# Documentation

This repository contains an evolving product vision, proposed identity, and initial implementation built on a pinned T3 Code import. See the [current build status](product/status.md) for verified behavior and remaining work.

## Product

| Document | Purpose | State |
| --- | --- | --- |
| [Vision](product/vision.md) | Capture the ongoing product discussion and explicit decisions | In discussion |
| [Direction](product/direction.md) | Describe the product hypothesis and boundaries | Proposed |
| [Discussion](product/discussion.md) | Frame the next decisions | Open |
| [Build brief](product/brief.md) | Mission, reference user and implementation sequence | Active |
| [Definition of done](product/definition-of-done.md) | Track foundation and full-product acceptance | Partial |
| [Build status](product/status.md) | Verification evidence, owners and next work | Active |
| [Brand](../brand/README.md) | Compare identities and define the recommended visual system | Proposed |

## Architecture

| Document | Purpose | State |
| --- | --- | --- |
| [Factory architecture](architecture/README.md) | Shared names, entities, APIs and package boundaries | Implementation contract |
| [Implementation decisions](architecture/decisions.md) | Record implementation choices and rationale | Active |
| [Design system](architecture/design-system.md) | Apply the Workshop direction to the web and Apple clients | Proposed |
| [Messaging transport](architecture/messaging.md) | Authenticated messaging routes inside the T3 environment server | Implemented |

## Guides

| Document | Purpose | State |
| --- | --- | --- |
| [Install](guides/install.md) | Install the CLI, start a hub and enroll machines | Active |
| [Messaging](guides/messaging.md) | Connect CLI or harness clients to factory channels | Active |
| [Prerequisites](guides/prerequisites.md) | Track tooling, accounts and machine setup | Active |

## Research and handoffs

- [T3 Code study](research/t3-code.md) examines harness integration and remote environments as a reference. Source reviewed; runtime untested.
- [Handoffs](handoffs/) record what each implementation worker built, verified and left open. They are history: their branch names and verification counts describe the work at the time, with paths updated to the current layout.

After those decisions, add a mission, initial requirements with acceptance criteria, and architecture decisions. Keep each decision's rationale and unresolved questions close to the relevant document. Do not turn exploratory notes into implied commitments.
