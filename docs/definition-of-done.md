# Definition of done

The user authorized beginning implementation on 20 October 2026. These criteria translate the discussed vision into a working build plan; detailed release acceptance remains subject to refinement.

## Initial foundation

- Brand explorations and product decisions committed and pushed. Verified: commit `c12899d` on `origin/main`.
- T3 orchestrator and every built-in provider integration imported at a recorded revision with license and supporting dependencies retained. Verified locally; see [build status](status.md).
- File-based Perpeto configuration starts an isolated local runtime without using the user's normal T3 state. Verified locally; see [build status](status.md).
- Runtime build and focused orchestration/provider tests pass. Verified locally; see [build status](status.md).
- Durable project-scoped messaging supports session-independent sender/recipient identities, retry-safe writes, cursor reads and restart recovery. Verified locally; see [build status](status.md).
- Repository CI runs factory tests and focused upstream checks. Configured; hosted execution not yet verified.

## Complete factory experience

All items below remain unverified and incomplete:

- Connect two execution machines, authenticate them, reconnect after interruption, and coordinate project work across them.
- Run real authenticated harness sessions and preserve their approvals, questions, outputs and failures. Imported adapters alone do not establish compatibility.
- Agents and users communicate across machines through durable project channels and threads, with clear delivery and wake-up behavior.
- Configure a factory visually: harnesses/models/context, delegation authority, spawning limits, build, test, QA, review and merge workflows.
- Replace an orchestrator session and continue from durable project and execution state without losing assignments or duplicating work.
- Submit CI work to a user-owned machine; associate logs, artifacts and results with the exact revision tested; recover from runner interruption.
- Complete a fresh-user installation and a full define/build/review/test/merge journey, with evidence linked to the requested outcome.
- Verify supported CLI, web, desktop and mobile experiences, including failures and recovery, before claiming those platforms are supported by Perpeto.

Passing unit tests or starting the inherited UI does not satisfy the complete factory experience.
