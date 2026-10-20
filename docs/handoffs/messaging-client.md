# Messaging client handoff

Added `packages/factory-client`: dependency-free Node 24 reusable `FactoryClient`, JSON CLI, and an agent-accessible MCP stdio server. Client requests use the existing runtime's bearer session credential, read only from an owner-only file. JSON config holds URL, project, durable role, default channel, credential file path, timeout and optional explicit insecure HTTP opt-in. No environment variables are required.

Entry: `node packages/factory-client/src/cli.js --config /absolute/path/client.json COMMAND`. Commands: `init-project NAME`, `create-channel ID NAME`, `channels`, `send --body TEXT --key KEY [--to ROLE] [--channel ID]`, `read [--after CURSOR] [--limit N] [--to ROLE] [--channel ID]`, `mcp`.

MCP tools: `factory_channels`, `factory_send` (body/idempotencyKey required, recipientRoleId/channelId optional), `factory_read` (after/limit/recipientRoleId/channelId optional). The configured role supplies senderRoleId. Stdio uses newline-delimited JSON-RPC and stdout contains protocol only. The package README provides configuration and harness setup examples.

Validation: seven tests pass with `node --test` in `packages/factory-client` on Node 24.15.0. Actual child processes verify CLI and MCP initialize/list/call/ping/error behavior. Local HTTP fixture verifies paths, bearer header, request bodies, cursor query encoding, exact-key retries and no retries for auth/conflict responses. Errors discard raw server bodies; tests verify no credential appears in errors or process output. Config tests reject token fields, unsafe credential permissions and remote HTTP unless explicitly enabled.

Remaining: lead-owned real-runtime integration checks and loading the tools in an actual provider harness. There is no claim that cross-machine networking, real session provisioning, or a harness customer journey was tested by this worker. MCP handles requests sequentially and offers no subscriptions or wake-ups. It supplies communications tools, not inference or executable assignment semantics.

## Transport review

Read-only review of the new T3 messaging routes and storage adapter confirmed that requests reuse `EnvironmentAuth.authenticateHttpRequest`, preserving existing credential verification, revocation, and cookie-origin checks. Read and mutation operations require the inherited orchestration scopes. Request bodies are capped before JSON parsing, and storage errors map to HTTP status codes without leaking SQLite internals. The new `listChannels` query is project-scoped and deterministically ordered; all eight core tests pass after that addition.

Reported to the integration owner: the inherited browser CORS allowlist initially allowed only GET/POST/OPTIONS while project creation uses PUT, so browser preflights need PUT support and coverage. Also reported that accepting `.` or `..` as project/channel IDs conflicts with URL dot-segment normalization; these values should be rejected at the route/client boundary. Follow-up fixes belong to the integration owner. Lifecycle acquisition closes the store on layer release; actual built-runtime shutdown remains lead-owned smoke coverage.
