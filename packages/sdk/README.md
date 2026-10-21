# Messaging SDK

Dependency-free Node 24 CLI and MCP stdio client for the Perpeto messaging HTTP API hosted by the hub. T3-hosted messaging remains available through configuration. Agents use the same authenticated channels as people. All inference continues to run through their existing harnesses.

## Configure a device or harness role

Create a local JSON configuration file. All non-secret configuration belongs here:

```json
{
  "baseUrl": "http://127.0.0.1:4320",
  "messagingPrefix": "/api/v1/messaging",
  "projectId": "perpeto",
  "roleId": "backend-lead",
  "channelId": "build",
  "credentialFile": "./session.secret",
  "timeoutMs": 30000
}
```

Put the hub owner bearer token, as a single raw token, in `session.secret`. The client does not mint credentials. For a T3-hosted endpoint, set `messagingPrefix` to `/api/perpeto`, use that runtime's base URL and existing session credential. Omitting `messagingPrefix` selects `/api/v1/messaging`. Make the file owner-only (`chmod 600 session.secret`). Relative credential paths resolve against the config file's directory. The client rejects symlinks, files owned by another user, and files readable by group or others. Never commit the secret file or put the token in config, CLI arguments, or a harness configuration.

Use an HTTPS endpoint for remote connections or forward the remote endpoint to loopback through a trusted tunnel. HTTP loopback is supported. Explicit `"allowInsecureHttp": true` in the JSON config permits remote HTTP when needed; that sends the bearer credential without TLS. The host owns networking and remote authentication setup.

## CLI

Run from the repository root:

```sh
node packages/sdk/src/cli.js --config /absolute/path/client.json init-project Perpeto
node packages/sdk/src/cli.js --config /absolute/path/client.json create-channel build Build
node packages/sdk/src/cli.js --config /absolute/path/client.json channels
node packages/sdk/src/cli.js --config /absolute/path/client.json send --body 'Revision abc123 is ready' --key review-abc123 --to reviewer
node packages/sdk/src/cli.js --config /absolute/path/client.json read --limit 50
node packages/sdk/src/cli.js --config /absolute/path/client.json read --latest --limit 50
```

All successful CLI responses are JSON. Use `--channel ID` on send/read to override the configured channel. `read --to ROLE` filters to explicitly addressed messages, while unfiltered reads include all channel messages. Save the returned `nextCursor` and pass it to `read --after CURSOR` for subsequent arrivals. Use `read --latest` for a bounded newest page, then `read --before PREVIOUS_CURSOR` to fetch older history. Directions `--latest`, `--before`, and `--after` are mutually exclusive. Results are always ascending. `hasMore` refers to older history for latest/before and newer messages for default/after; `previousCursor` and `nextCursor` mark the oldest and newest message returned.

Every send requires an explicit `--key`. Reuse the key for retries of exactly the same payload. A changed body, recipient, sender, or channel with the same project/key conflicts. The transport retries network failures and HTTP 429/502/503/504 once using the identical request and key. It never retries authentication failures or conflicts. A final timeout can still mean the server persisted a message; retry with the same key. Client errors omit server response bodies and credentials.

## Agent MCP tools

Configure an MCP stdio server in a harness that supports one, using absolute paths:

```json
{
  "mcpServers": {
    "perpeto-messages": {
      "command": "node",
      "args": [
        "/absolute/path/Perpeto/packages/sdk/src/cli.js",
        "--config", "/absolute/path/backend-lead.json", "mcp"
      ]
    }
  }
}
```

This illustrates the common MCP server configuration shape; confirm your harness's configuration location and syntax. Give each durable role its own config. Replacing a harness session can reuse that role config without changing message identity. The bearer credential grants the host's access level; role IDs are labels, not separate permissions.

Tools:

- `factory_channels`: list the configured project's channels.
- `factory_send`: `{body, idempotencyKey, recipientRoleId?, channelId?}`; sender comes from the configured role.
- `factory_read`: `{after?, before?, latest?, limit?, recipientRoleId?, channelId?}`; returns the server's message page. Use only one direction.

The stdio server implements newline-delimited MCP JSON-RPC initialization, ping, tool discovery, and tool calls. It advertises only tools, writes protocol JSON exclusively to stdout, handles notifications without responding, and returns tool failures using `isError`. It supports protocol versions 2024-11-05, 2025-03-26, 2025-06-18, and 2025-11-25. This initial implementation handles requests sequentially and does not offer subscriptions, cancellation, prompts, resources, or agent wake-ups.

## Validation

```sh
npm test -w @perpeto/sdk
```

Tests exercise authenticated HTTP request shapes, cursor encoding, retry idempotency, rejected credentials and HTTP errors, CLI child processes, and actual MCP stdio child-process exchanges. Client tests use a local HTTP fixture. `node --test tests/e2e/test/hub-wiring.test.js` from the repository root additionally exercises real MCP stdio sends through the hub and their idempotent `agent.messaged` events. Deployed routing, pairing and real harness loading remain unverified.
