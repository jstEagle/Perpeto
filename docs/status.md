# Build status

Updated 20 October 2026. Phase: initial foundation implemented locally; full factory product incomplete.

## Delivered in this milestone

- Brand assets and product documentation committed and pushed as `c12899d`.
- T3 Code source imported at `89b42bfeb4f79408af72fc7bb7a4482e22bb9493`: orchestrator, all nine provider drivers, shared packages, clients, tests, lockfile, patches and licenses. Source boundaries and hashes live under `config/`.
- Root setup/build/start commands with file-based settings and isolated Perpeto runtime data.
- Durable SQLite messaging store with project-scoped channels, stable role addressing, idempotent writes and cursor pagination.
- GitHub workflow configured for Perpeto tests, upstream source integrity, focused upstream tests and runtime build. Hosted execution not yet verified.

## Local verification

- `npm test`: 9 tests passed, including on-disk SQLite restart/retry/isolation/cursor cases and launcher validation.
- Focused upstream suite: 170 tests passed across runtime-layer hydration, provider registry, and machine/project grouping.
- Runtime web/server build passed after including the upstream scripts workspace in setup.
- `npm start`: real server started on localhost:4310 with separate `.perpeto/runtime` state; public environment descriptor returned protocol 2 and inherited HTML loaded. Server restarted successfully with the same data directory.
- Source comparison: all 6,350 imported files match the pinned checkout byte-for-byte.
- Independent foundation review found an ignored browser-opening setting. Launcher now chooses the correct upstream command and explicitly disables automatic cwd project creation.

HTTP responses establish local startup only. No authenticated browser journey, real harness turn, remote pairing, cross-machine delivery, or CI runner execution is claimed.

## Owners and next work

- Lead: root agent; owns import, launcher, integration, repository CI and documentation.
- Messaging worker: initial storage implementation complete; see its handoff.
- Review worker: initial source-boundary and foundation review complete; see its handoff.

Next: integrate messaging with the inherited authenticated server and agent tool surface, then verify communication between two real environments. Define durable factory roles/assignments and graph execution around the existing harness adapters. Add user-owned runner registration, job lifecycle and revision-bound evidence. Build UI only against working services, preserving the proposed brand status until a direction is selected.

## Remaining prerequisites and limits

Local harness executables were detected; their authentication and execution were not tested. A second machine and user-owned CI runner have not been enrolled. Hosted identity, relay, app signing and release distribution are not configured. See [prerequisites](prerequisites.md) and [definition of done](definition-of-done.md).

Setup was also verified to restore the host repository's Git hook configuration after upstream prepare, which otherwise installs a hook targeting the nested upstream workspace.
