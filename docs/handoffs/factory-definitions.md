# Factory definitions handoff

Implemented persistent factory definitions outside the inherited runtime, in `packages/factory-definition`. The package provides graph validation, all nine pinned harness kinds, agent model/subagent/concurrency configuration, context references, argv checks, serialized merge queues, typed edges, layout positions, SQLite immutable revisions and optimistic version editing. Delegation cycles fail; workflow rework cycles remain valid. No inference or execution occurs.

Authenticated HTTP integration is in `vendor/t3code/apps/server/src/perpeto/factories.ts`. It exports `layer` (router) and `storageLayer` (SQLite service), to be mounted by the lead in `server.ts`. Route contract and examples live in the package README. State uses the configured environment `stateDir`; non-secret limits are exported configuration defaults, with constructor overrides.

Validation: four Node tests passed (real on-disk restart, two independent SQLite editors, stale-write rejection, immutable history, project isolation, graph validity, all harness kinds, limits and safe inert references). Two actual Node HTTP integration tests passed (sessions, scope refusal, revoked credentials, create/read/list/update, version conflict, historical read, malformed graph/JSON and oversized streamed bodies).

Full inherited server typecheck passed with exit code 0 after correcting the deterministic Effect service key. Targeted HTTP tests and root package tests are passing; lead should include the module in integrated build verification.

Limits: definitions describe configuration only. Native subagent spawning enforcement, scheduling, graph execution, merging, running checks and cross-machine replication remain unimplemented. Definition APIs currently operate within inherited environment authorization and are not per-project access-control boundaries.
