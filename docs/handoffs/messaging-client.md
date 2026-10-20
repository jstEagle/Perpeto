# Messaging client handoff

Added `packages/factory-client`: dependency-free Node 24 reusable `FactoryClient`, JSON CLI, and an agent-accessible MCP stdio server. Client requests use the existing runtime's bearer session credential, read only from an owner-only file. JSON config holds URL, project, durable role, default channel, credential file path, timeout and optional explicit insecure HTTP opt-in. No environment variables are required.

Entry: `node packages/factory-client/src/cli.js --config /absolute/path/client.json COMMAND`. Commands: `init-project NAME`, `create-channel ID NAME`, `channels`, `send --body TEXT --key KEY [--to ROLE] [--channel ID]`, `read [--after CURSOR] [--limit N] [--to ROLE] [--channel ID]`, `mcp`.

MCP tools: `factory_channels`, `factory_send` (body/idempotencyKey required, recipientRoleId/channelId optional), `factory_read` (after/limit/recipientRoleId/channelId optional). The configured role supplies senderRoleId. Stdio uses newline-delimited JSON-RPC and stdout contains protocol only. The package README provides configuration and harness setup examples.

Validation: seven tests pass with `node --test` in `packages/factory-client` on Node 24.15.0. Actual child processes verify CLI and MCP initialize/list/call/ping/error behavior. Local HTTP fixture verifies paths, bearer header, request bodies, cursor query encoding, exact-key retries and no retries for auth/conflict responses. Errors discard raw server bodies; tests verify no credential appears in errors or process output. Config tests reject token fields, unsafe credential permissions and remote HTTP unless explicitly enabled.

Remaining: lead-owned real-runtime integration checks and loading the tools in an actual provider harness. There is no claim that cross-machine networking, real session provisioning, or a harness customer journey was tested by this worker. MCP handles requests sequentially and offers no subscriptions or wake-ups. It supplies communications tools, not inference or executable assignment semantics.

## Transport review

Read-only review of the new T3 messaging routes and storage adapter confirmed that requests reuse `EnvironmentAuth.authenticateHttpRequest`, preserving existing credential verification, revocation, and cookie-origin checks. Read and mutation operations require the inherited orchestration scopes. Request bodies are capped before JSON parsing, and storage errors map to HTTP status codes without leaking SQLite internals. The new `listChannels` query is project-scoped and deterministically ordered; all eight core tests pass after that addition.

Reported to the integration owner: the inherited browser CORS allowlist initially allowed only GET/POST/OPTIONS while project creation uses PUT, and `.`/`..` project/channel IDs conflicted with URL dot-segment normalization. The integration owner subsequently fixed both, added preflight and identity regressions, and reported nine core and 32 network/HTTP tests passing. Lifecycle acquisition closes the store on layer release; actual built-runtime shutdown remains lead-owned smoke coverage.

## Interface review

Reviewed the factory messaging React page and client-runtime HTTP helper. Project/environment identity keys remount message state on project switching, abort guards discard stale polling responses, cursor pages append in server order, an ambiguous send retains its key for an unchanged retry, and read-only grants hide mutation controls. HTTP requests use the selected environment's cookie/bearer/renewable-DPoP authorization rather than a global endpoint or credential.

Reported two actionable issues to the interface owner: unconditionally re-registering a project before channel creation fails after a project rename because registration rejects name conflicts; a stale channel-list poll can overwrite a newly created channel and unmount its composer. Owner is correcting bootstrap-on-missing behavior and preserving locally created channels until confirmed by the server. Long histories currently load entirely into the DOM, which will need bounded rendering for sustained high-volume factories.

For optional live Codex MCP smoke, inspected CLI help without another inference call. The installed CLI supports `--ignore-user-config` while retaining authentication, which can isolate the synthetic Perpeto tool configuration from unrelated user MCP servers. Live-provider verification remains the lead's responsibility.

## Bounded history increment

Extended core SQLite reads, the existing authenticated HTTP messages route, and the standalone client/CLI/MCP with `latest` and `before` directions. `latest: true` returns the newest matching page; `before: previousCursor` fetches older history. Both use descending limited queries and reverse the page into ascending display order. Existing default/after semantics remain unchanged. Responses add `previousCursor` (oldest returned) alongside `nextCursor` (newest returned). `hasMore` follows the requested direction: older for latest/before and newer for default/after. Empty cursor reads retain the input marker. Mutually exclusive direction validation and strict HTTP boolean query validation reject ambiguous requests.

Core tests now cover eleven scenarios, including bounded newest/older pages without gaps or duplicates across restart, forward tailing from the newest page, filtered cursor scope, and conflicting directions. All eleven pass. Standalone client tests now cover eight scenarios including query encoding and actual CLI/MCP newest/older options; all eight pass. The interface owner is implementing newest-page initialization, explicit older-history loading, and a bounded displayed window on this contract.

The three authenticated server HTTP tests also pass, including real-network newest/older/forward reads and invalid boolean/direction queries. Server `tsc-rs --noEmit` exits successfully with existing Effect suggestions and no TypeScript errors.
