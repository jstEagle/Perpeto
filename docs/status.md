# Build status

Updated 21 October 2026. Phase: working messaging and initial CI execution; complete factory runtime unfinished.

## Implemented

- Pinned T3 Code runtime with all nine provider drivers, source provenance and preserved licenses. Existing T3 client branding remains in the inherited shell.
- Authenticated persistent project channels, role addressing, retry deduplication, cursor history and standalone CLI/MCP clients.
- Browser messages view using selected environment authentication. Newest history first, bounded rendering, explicit older-history browsing and bounded forward polling.
- Durable versioned factory definitions: agent/context/check/merge-queue nodes, typed edges, graph validation, immutable revisions and optimistic editing. Definitions are configuration, not executed workflows. A visual editor is in progress.
- User-owned CI queue and one-shot/continuous macOS/Linux worker: exact revision checkout, executable/repository mapping, atomic claims, fenced leases, timeout/cancellation, bounded logs, persisted results and artifact summaries. Expired work requires explicit retry.
- Agent CLI/MCP tools can submit CI, inspect status and explicitly retry jobs within the configured project. They can also list, read and author factory definitions with explicit IDs and version checks; writes do not automatically replay.

## Verified

- Brand and docs pushed as `c12899d`; foundation `d64c781`; messaging service `ce6f1ef`; messages UI `26dd12b`; bounded history `32be691`.
- Hosted CI passed through runner cleanup milestone `69e01fc`, including root tests, source integrity, focused inherited tests, full build and both packaged runtime smoke checks: [CI run](https://github.com/jstEagle/Perpeto/actions/runs/39571037186). Newer increments must be checked separately.
- Latest local root suite: 45 tests passed across messaging storage/client/CLI/MCP, factory definitions, CI runner processes and launcher settings.
- Latest focused inherited suite: 215 tests passed, including real HTTP/session scope/revocation, body limits, factory version conflicts, runner fencing and selected-environment auth behavior.
- Complete web/server production build passed. The packaged runtime starts with isolated state and passes actual client/server restart checks.
- The actual imported T3 Codex adapter completed a tool-free turn with an exact assistant response, persisted it across runtime restart and left the source auth file unchanged. The isolated optional `npm run smoke:harness` check is excluded from CI. See [execution seams and evidence](handoffs/factory-execution-seams.md).
- A real Codex harness delivered a message through Perpeto MCP. The optional live check uses a temporary credential and explicitly approved messaging tools; it is excluded from CI.
- Real browser create/send/reload and inbound API polling passed on desktop and mobile layouts. Bounded-history browser checks used 1,800 synthetic messages: newest page, older navigation, paused historical polling, live catch-up and a capped DOM.
- Packaged factory smoke passed: authenticated versioned definition save/update, stale edit rejection, actual MCP factory create/update/list/historical read and CI submission, real runner subprocess, pinned revision despite a dirty source tree, CLI status and persisted results after restart.
- Continuous runner subprocess checks passed: jobs arriving after idle, bounded error retry delay, prompt idle shutdown and active watch/once shutdown without orphaned descendants or false completion.
- Runner review regressions passed: normal-exit descendant cleanup, stalled heartbeat termination before confirmed lease expiry, and completion of control-heavy logs within the request budget.

These tests use one physical machine with independent runtime/client/worker processes. Two-physical-host networking, production relay use, real remote DPoP sessions and the other live provider adapters remain unverified.

## Next work

Complete the visual definition editor, then connect persistent roles/assignments and replaceable orchestrator sessions to the inherited harness runtime. Add retained artifact delivery and runnable graph transitions. Provision and test a second real execution environment and owned runner. Verify full define/build/review/test/merge journeys before calling Perpeto a complete software factory.

## Ownership and handoffs

Lead owns integration, provenance, verification and pushes. Worker handoffs cover [transport](handoffs/messaging-transport.md), [client tools](handoffs/ci-agent-tools.md), [messages UI](handoffs/messaging-ui.md), [history UI](handoffs/messaging-history-ui.md), [factory definitions](handoffs/factory-definitions.md), and [CI runner](handoffs/ci-runner.md), and [continuous runner](handoffs/ci-worker-watch.md), and [factory agent tools](handoffs/factory-agent-tools.md).

Hosted identity, relay deployment, app signing and release distribution are not configured. See [prerequisites](prerequisites.md) and [definition of done](definition-of-done.md).
