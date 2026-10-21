# Messaging core handoff

Implemented the first reusable local communication store in `packages/messaging`. This is supporting factory state; inference and orchestration providers remain the T3 integration's responsibility.

The package exports `MessagingStore` and `MessagingError`, uses Node 24's built-in SQLite, and has no external dependencies. It persists project-scoped channels and messages, uses durable role IDs rather than harness session IDs, provides insertion-ordered cursor pagination and optional recipient filtering, and handles idempotent retries with explicit payload conflicts. Foreign keys prevent cross-project channel association; cursor scope checks prevent accidental stream mixing. WAL and full synchronization persist messages across connection restarts. Registration is also idempotent and rejects identity/name conflicts.

Validation: `node --test` from `packages/messaging` on Node v24.15.0 passes seven tests against temporary on-disk SQLite databases. Checks cover restart persistence, deduplication through separate connections, changed-payload conflicts, cursor resume and tail reads, project isolation, recipient filters, malformed/scope-mismatched cursors, invalid inputs, and refusal of future schema versions while preserving data.

The API and example are documented in the package README. No non-secret configuration is read from environment variables.

Remaining: network transport, authentication and authorization, role registration/membership, wake-up and delivery acknowledgments, UI, threads and attachments, and integration into actual harness workflows. This package does not yet demonstrate communication between devices. Recipients are routing metadata; channel access must be authorized by the host. No tests claim actual parallel process contention or distributed delivery.
