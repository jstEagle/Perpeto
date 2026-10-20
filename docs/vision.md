# Perpeto vision

Status: living discussion notes. Started 17 October 2026. Product choices remain open unless explicitly recorded as decisions.

## Starting point

The existing [direction](direction.md) proposes an open-source software factory that coordinates agents across machines, with a durable record of intent, work, verification, and feedback. This is a hypothesis to examine with Justus, not an approved specification.

## Confirmed discussion goals

- Develop the product vision through discussion before implementation.
- Maintain written documentation as the discussion develops.
- Distinguish aspirations, proposals, decisions, and implemented capabilities.

## Audience and desired outcome

Justus's own sustained multi-agent development workflow is the concrete reference user. The broader audience remains open.

The desired outcome is to ship large, ambitious software projects quickly through opinionated orchestration of many agents across machines, grounded in extensive project documentation.

## Motivation and current workflow

As described by Justus:

- Uses T3 Code with multiple subscriptions managed through CCswap across a couple of machines.
- Builds extensive documentation describing what he wants to build.
- Runs one main orchestrator with roughly 20 agents at a time, working for days.
- Likes T3 Code, but encounters rough edges and finds traditional chat interfaces poorly suited to this sustained, large-scale workflow.

Perpeto should be designed around this operating pattern. Specific T3 failure cases and the responsibilities Justus currently handles manually still need to be identified. These are user-reported workflow details, not independently tested claims about T3 or CCswap.

## Core user journey

The reference journey begins with extensive project intent and specifications, followed by a main orchestrator coordinating many agents over days across available machines. How planning, assignment, integration, verification, and human intervention should work remains open.

## Working interpretation to validate

Justus confirmed the project-centered interpretation: the project and its progress should be the primary organizing structure, with individual agent conversations accessible as supporting detail. Exact interface design remains open.

Concurrency is a means to ship coherent software, not itself the success criterion. Investigate whether the current bottleneck is coordination, context, integration, verification, subscription availability, or visibility before selecting an orchestration hierarchy.

## Proposed separation of responsibilities

Justus supplied a diagram with this flow:

```text
User input
    ↓
User agent
    ↓
Context / vision / docs
    ↓
Orchestrator
    ↓
Multiple downstream units (not yet labeled)
```

Justus identifies degradation in a central orchestrator running for a long time as a motivation for this design. The diagram separates the user-facing agent from execution orchestration, with project context between them. The downstream boxes' roles and the orchestrator's lifecycle remain unspecified.

Agreed direction, 18 October 2026: orchestration is a durable responsibility fulfilled by replaceable agent sessions, rather than depending on one agent conversation surviving for days. Durable project and execution state should let fresh sessions continue coordination. Exact session boundaries and wake-up triggers remain open.

The diagram is a rough conceptual outline, not a complete architecture. Missing arrows and unlabeled downstream units should not be interpreted as deliberate restrictions or decisions.

Supporting proposals still to discuss:

- Make orchestrator sessions replaceable, with durable assignments, dependencies, decisions, and verification evidence outside conversation history.
- Keep project intent distinct from execution state; prose documentation alone need not carry the entire coordination model.
- Add a return path for results, blockers, and questions to inform the user agent and project context.
- Make changes to requirements explicit so active work can detect when its instructions have changed.

The supporting mechanisms are not yet approved architecture. Separating the user agent helps isolate responsibilities but does not alone solve degradation in a long-running execution orchestrator.

## Scope and non-goals

Desired capabilities now include shared cross-device messaging, a visual factory builder, and user-owned CI runners. Release scope and implementation details remain open.

## User-owned CI runners

Justus wants Perpeto to address the operational gaps an individual encounters when shipping large volumes of agent-produced software.

Users must be able to supply machines they own as CI runners. Agents should be able to submit CI workflows, including testing and verification jobs, to those machines as part of factory execution. This is an intended product capability, not an implemented integration.

The CI job submission and execution mechanism remains open. GitHub Actions compatibility, other CI integrations, and a Perpeto-native job runner have not been selected. User-owned execution does not imply that Git is unnecessary for transferring source code.

Supporting proposals to discuss:

- Register runner capabilities so jobs reach machines with the required operating system, toolchains, and available resources.
- Queue and track jobs independently of the agent session that submitted them, returning status, logs, and artifacts to the factory.
- Tie every result to the exact source revision and workflow configuration tested, so later changes cannot accidentally inherit a passing result.
- Keep concurrent jobs' workspaces separate and expose runner availability and capacity in the factory interface.

Runner setup, offline behavior, scheduling, and the relationship between CI runners and agent execution machines remain open.

## Shared messaging

Requested 20 October 2026, following further experience with software factories:

- Agents must be able to communicate information across devices without using Git as the message transport.
- The experience should resemble Slack, with users able to see and participate in communication.
- This is a shared communication capability within Perpeto; an integration with Slack itself has not been requested.

Channels, threads, direct messages, addressing, retention, delivery guarantees, and agent wake-up behavior remain to be defined. A durable inbox addressed to an agent role rather than a transient session is an assistant proposal that would support session replacement and disconnected devices.

## Visual factory builder

Requested 20 October 2026:

- Provide a node-based view resembling a flowgraph or factory-building game.
- Let users compose factories using harnesses such as Claude and Codex, models, and context.
- Let users specify which agents control others, whether agents can spawn subagents, and how many they may spawn.
- Support project-specific systems for building, testing, QA, code review, and custom merge queues.
- Let users build the system that builds their software, adapting it to each project's needs.

Models remain accessed through harnesses, consistent with the inference boundary already agreed. The request does not establish that every harness, model, or context must be a separate node type.

Open design questions: whether the graph describes fixed execution steps, persistent roles and authority, or both; how agents can adapt the graph; and whether live runs appear as nodes or as detail within configured roles.

Assistant proposals to discuss:

- Separate communication relationships, authority to delegate, context access, and work dependencies so an edge has an unambiguous meaning.
- Represent persistent roles or worker pools in the authored graph, with temporary sessions and assignments visible within them.
- Give messages and executable assignments distinct semantics: a conversation message alone should not imply task ownership or a verified result.
- Keep conversational judgment about user intent with agents; configurable execution rules do not require the previously rejected proposal/approval workflow.

## Decisions

Justus's stated direction: all inference should come through existing agent harnesses such as Claude Code, Codex, and Grok. Perpeto orchestrates those harnesses.

Decided 20 October 2026: reuse T3 Code's orchestrator code and all of its provider integrations as Perpeto's implementation foundation. Bring over the supporting contracts, runtime services, and dependencies needed for those components to work, rather than rebuilding equivalent integrations. Build Perpeto's factory-specific behavior on that foundation. Preserve upstream license and attribution notices when importing code.

Implementation began on 20 October 2026. The pinned T3 source is now imported under `vendor/t3code`, preserving its runtime and provider dependency graph. See [implementation decisions](decisions.md) and [current verification](status.md). The inherited clients are a development surface; this does not establish Perpeto's final application or interface stack.

On 18 October 2026, Justus clarified that deciding when discussion becomes actionable work should happen dynamically between the user and agents. Do not build a dedicated proposal/approval workflow or intent-classification system for this distinction. Agents should use conversational judgment and clarify with the user when needed. This decision does not remove the agreed need for durable project and execution state.

## Areas to work through

- Multiple devices, networking, and seamless connections between environments.
- Harness integration across execution devices, with inference supplied by the harnesses.
- Native, web, mobile, and CLI interfaces; platform coverage and release order remain open.
- Machine and development-box setup.
- An opinionated logical layout and building/design workflow suited to a software factory.
- Shared messaging for agents and users across devices.
- A visual factory builder with configurable delegation, concurrency, and delivery workflows.
- User-owned CI runners for agent-submitted testing and verification workflows.

T3 Code is the chosen source for the orchestrator and all provider integrations, and a reference for connections across environments. See the [source study](research/t3-code.md). Whether to extract those components or maintain a broader fork remains open.

## Open questions

- What does the ideal experience look like from initial intent through useful outcome?
- What is hardest in the current workflow, and what should Perpeto take responsibility for?
- Who should benefit first, and how much human involvement should remain?

## Next discussion

Clarify what the factory graph defines and how much agents may adapt it during execution. Define whether messages wake recipients automatically or are read at coordination checkpoints. Use a build, review, and merge example to make those choices concrete.
