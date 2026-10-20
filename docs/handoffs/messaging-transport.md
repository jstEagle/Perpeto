# Authenticated messaging transport

Implemented 20 October 2026. Owner: T3 integration worker.

## Changes

- Added raw `/api/perpeto/*` JSON routes to the inherited environment server, reusing existing `EnvironmentAuth` sessions and orchestration read/operate scopes.
- Added an Effect-managed messaging service storing `perpeto-messaging.sqlite` in the configured environment `stateDir`, with lifecycle close.
- Linked the inherited runtime to root factory-core through `packages/factory-transport/src/storage.js` and declarations; no new auth or inference stack, package dependencies, or upstream lockfile edits.
- Added core `listChannels`, with stable order and project isolation, supporting the channel list endpoint. Rejected project/channel dot-segment IDs to keep their network routes addressable.
- Bounded retained request-body bytes at 512 KiB, including chunked bodies; stable JSON error envelope and appropriate 400/401/403/404/409/413 responses. Excess unknown-length chunks are drained without retention so the 413 response reaches clients instead of an upstream socket reset. Added PUT to the browser CORS allowlist and checked a real preflight.
- Added real network tests using actual T3 auth, SQLite session persistence, and bearer issuance/revocation. Documented transport contract in `packages/factory-transport/README.md`.

## Authorization boundary

Environment read/operate permissions apply to all messaging projects on that environment. Role identifiers are caller-selected routing metadata. The transport does not assert agent identity or implement project membership/privacy. Existing T3 bearer/browser/DPoP authentication behavior is reused. No two-physical-host verification was performed by this worker.

## Verification

- Core storage tests: 9 passed, including project-scoped channel listing and URL dot-segment validation.
- Authenticated HTTP tests plus inherited HTTP regression tests: 32 passed across 2 files, including genuine chunked-body limits and PUT CORS preflight.
- Full inherited server typecheck: no TypeScript errors; inherited Effect suggestions remain informational.
- Lead owns packaged runtime build, restart smoke and final provenance patch hashes.
