# Product direction

Status: a starting hypothesis for discussion, not an approved mission or specification.

Implementation decision, 20 October 2026: reuse T3 Code's orchestrator code and all provider integrations as the foundation for Perpeto. See [the living vision and decisions](vision.md#decisions). This decision is approved; the code import has not yet been implemented.

## The problem

As more agents work on a software project, the difficult part shifts from asking one agent to write code to keeping the whole effort coherent. Intent gets scattered across prompts. Workers lose context. Parallel changes conflict. Logs show activity without making it clear whether requirements have been met.

Perpeto should give the project a durable home and coordinate the work around it.

## The proposed product

An open-source software factory that turns project intent into organized agent work across machines and connects the results back to verification and feedback.

The initial audience hypothesis is technical builders and small teams already using coding agents who need longer-running, coordinated execution. We should validate that audience before optimizing for enterprise operations or nontechnical users.

## A conceptual loop

**Define → plan → assign → execute → verify → learn**

1. A person describes the desired outcome, requirements, constraints, and available context.
2. The factory proposes work with clear ownership and dependencies.
3. Workers take on bounded assignments across available machines.
4. Execution produces changes, artifacts, events, and logs.
5. Checks and review establish whether the requested outcome was achieved.
6. Feedback updates the project and informs subsequent work.

This is a conceptual workflow. It does not decide how planning, scheduling, transport, storage, or approval will be implemented.

## Vocabulary to test

| Term | Proposed meaning |
| --- | --- |
| Project | The durable home for intent, context, work, and outcomes |
| Goal | An outcome the project is trying to achieve |
| Requirement | A constraint or behavior with an assessable acceptance condition |
| Context | Relevant documents, data references, decisions, and source material |
| Work item | A bounded assignment tied to a goal or requirement |
| Agent | A software actor that can reason about or perform work |
| Worker | An execution host or runtime that can run agents |
| Run | A recorded attempt to perform an assignment |
| Artifact | An output such as a change, build, report, or design |
| Event | A meaningful occurrence in the project's history |
| Log | Detailed diagnostic output from execution |
| Evidence | Check or review results used to assess an outcome |
| Feedback | New information that may change intent, priorities, or work |

These distinctions are discussion aids, not a database schema. In particular, context and data may be referenced rather than copied into the factory.

## Principles worth keeping

- **The project outlives the run.** Goals and decisions must remain understandable when an agent or machine changes.
- **Coordination needs ownership.** Parallel activity should have clear responsibilities and explicit handoffs.
- **Autonomy needs boundaries.** People should be able to understand and control the scope of delegated work.
- **Progress needs evidence.** Activity, completed execution, and verified outcomes are different states.
- **Feedback belongs in the system.** Corrections should inform future work rather than disappear into a conversation.
- **Openness should be practical.** Installation, extension, and interoperability matter alongside source availability.

## Suggested first proof

After the requirements discussion, consider one narrowly scoped demonstration: take a requirement in an existing repository, coordinate two workers on separate machines, produce a reviewable change, run meaningful checks, and show the evidence against the requirement. Interrupt one worker to examine recovery and ownership behavior.

This would test the central orchestration claim. It is a candidate milestone, not a committed implementation plan.

## Keep out of the first definition

Avoid assuming an agent marketplace, a new model-training platform, a complete replacement for Git hosting, or universal business automation. Each would dilute the initial question: can Perpeto coordinate software work reliably enough that a person can understand and direct it?
