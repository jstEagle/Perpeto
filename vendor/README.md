# Upstream foundation

`vendor/t3code` preserves the pinned T3 Code source and supporting workspace. `config/upstream.json` records its source revision and import exclusions. `config/upstream-files.json` is the original file-hash manifest and must not be rewritten to hide local changes.

Intentional Perpeto integrations are recorded in `config/upstream-patches.json`. Each entry identifies the original hash (or null for an added file), current hash, and reason. `npm run verify:upstream` checks both the preserved source and declared changes.

New factory services live under the root `packages/` directory. Small integration seams inside T3's HTTP server and client connect those services to the inherited auth and environment lifecycle. Preserve the original MIT license and dependency notices.
