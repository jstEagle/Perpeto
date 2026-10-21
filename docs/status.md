# Build status

Updated 21 October 2026. Phase: working messaging, visual definitions and initial CI execution; complete factory runtime unfinished.

## Implemented

- Pinned T3 Code runtime with all nine provider drivers, source provenance and preserved licenses. Existing T3 client branding remains in the inherited shell.
- Authenticated persistent project channels, role addressing, retry deduplication, cursor history and standalone CLI/MCP clients.
- Browser messages view using selected environment authentication. Newest history first, bounded rendering, explicit older-history browsing and bounded forward polling.
- Durable versioned factory definitions: agent/context/check/merge-queue nodes, typed edges, graph validation, immutable revisions and optimistic editing. Definitions are configuration, not executed workflows. The browser editor supports node authoring, typed connections, harness/model and policy properties, movement, saved revisions and conflict recovery. Unsaved drafts survive sidebar/project changes within the browser session; reloads require saved revisions.
- User-owned CI queue and one-shot/continuous macOS/Linux worker: exact revision checkout, executable/repository mapping, atomic claims, fenced leases, timeout/cancellation, bounded logs, persisted results and artifact summaries. Expired work requires explicit retry.
- Agent CLI/MCP tools can submit CI, inspect status and explicitly retry jobs within the configured project. They can also list, read and author factory definitions with explicit IDs and version checks; writes do not automatically replay.

## Verified

- Brand and docs pushed as `c12899d`; foundation `d64c781`; messaging service `ce6f1ef`; messages UI `26dd12b`; bounded history `32be691`.
- Hosted CI passed through live harness proof milestone `1231608`, including root tests, source integrity, focused inherited tests, full build and both packaged runtime smoke checks: [CI run](https://github.com/jstEagle/Perpeto/actions/runs/39571836828). Newer increments must be checked separately.
- Latest local root suite: 45 tests passed across messaging storage/client/CLI/MCP, factory definitions, CI runner processes and launcher settings.
- Latest focused inherited suite: 220 tests passed, including real HTTP/session scope/revocation, body limits, factory version conflicts, runner fencing and selected-environment auth behavior.
- Complete web/server production build passed. The packaged runtime starts with isolated state and passes actual client/server restart checks.
- The actual imported T3 Codex adapter completed a tool-free turn with an exact assistant response, persisted it across runtime restart and left the source auth file unchanged. The isolated optional `npm run smoke:harness` check is excluded from CI. See [execution seams and evidence](handoffs/factory-execution-seams.md).
- A real Codex harness delivered a message through Perpeto MCP. The optional live check uses a temporary credential and explicitly approved messaging tools; it is excluded from CI.
- Packaged factory editor browser checks passed: five nodes and four typed edges, drag/keyboard positions, saved harness/model/subagent settings, reload persistence, external-save conflict with preserved edits, save-copy recovery, draft preservation across sidebar/project switches, and desktop/mobile layout checks.
- Real browser create/send/reload and inbound API polling passed on desktop and mobile layouts. Bounded-history browser checks used 1,800 synthetic messages: newest page, older navigation, paused historical polling, live catch-up and a capped DOM.
- Packaged factory smoke passed: authenticated versioned definition save/update, stale edit rejection, actual MCP factory create/update/list/historical read and CI submission, real runner subprocess, pinned revision despite a dirty source tree, CLI status and persisted results after restart.
- Continuous runner subprocess checks passed: jobs arriving after idle, bounded error retry delay, prompt idle shutdown and active watch/once shutdown without orphaned descendants or false completion.
- Runner review regressions passed: normal-exit descendant cleanup, stalled heartbeat termination before confirmed lease expiry, and completion of control-heavy logs within the request budget.

These tests use one physical machine with independent runtime/client/worker processes. Two-physical-host networking, production relay use, real remote DPoP sessions and the other live provider adapters remain unverified.

## Next work

Connect persistent roles/assignments and replaceable orchestrator sessions to the inherited harness runtime. Add retained artifact delivery and runnable graph transitions. Provision and test a second real execution environment and owned runner. Verify full define/build/review/test/merge journeys before calling Perpeto a complete software factory.

## Ownership and handoffs

Lead owns integration, provenance, verification and pushes. Implementation details and verification notes live in [the handoffs](handoffs/), including [factory agent tools](handoffs/factory-agent-tools.md) and [execution seams](handoffs/factory-execution-seams.md) and [the factory editor](handoffs/factory-editor.md).

Hosted identity, relay deployment, app signing and release distribution are not configured. See [prerequisites](prerequisites.md) and [definition of done](definition-of-done.md).
