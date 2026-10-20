# Factory messaging

Perpeto's environment server now exposes durable factory channels through authenticated HTTP. A standalone client supplies CLI commands and MCP tools to harnesses. Messages persist independently of the session that sent them.

## Local setup

Run the environment with `npm start`. In a second terminal, issue a scoped session into an ignored owner-only secret file:

```sh
umask 077
node vendor/t3code/apps/server/dist/bin.mjs auth session issue \
  --base-dir .perpeto/runtime --ttl 1d \
  --scope orchestration:read --scope orchestration:operate \
  --token-only > .perpeto/agent.secret
```

The command targets Perpeto's isolated environment state. Do not paste the issued token into chat or configuration files. For observers, grant only `orchestration:read`. Manage and revoke sessions through the inherited CLI or connection settings.

Edit the non-secret connection settings in `config/messaging-client.example.json`, or copy that file to your own configuration path. Credential-file paths resolve relative to the configuration file.

```sh
node packages/factory-client/src/cli.js --config config/messaging-client.example.json init-project Perpeto
node packages/factory-client/src/cli.js --config config/messaging-client.example.json create-channel build Build
node packages/factory-client/src/cli.js --config config/messaging-client.example.json send --body 'Ready for review.' --key review-revision-abc --to review
node packages/factory-client/src/cli.js --config config/messaging-client.example.json read
```

Save `nextCursor` and use `read --after <cursor>` for later arrivals. Retrying the same message with its original key returns the original result. Reusing a key for different content returns a conflict.

## Harness tools

Configure an MCP stdio server in the harness using its normal MCP configuration. The command is the absolute path to Node, and arguments are the absolute path to `packages/factory-client/src/cli.js`, `--config`, the absolute client configuration path, and `mcp`.

The tools are `factory_channels`, `factory_send`, and `factory_read`. The harness performs all inference; the client only transports messages. The MCP process reads its session credential from the owner-only file and writes only JSON-RPC to stdout. Its configured role is independent of the harness conversation ID.

## Remote clients

Point the client at the environment's reachable HTTPS address and securely provision a scoped session credential for that environment. Existing environment authentication is reused. Loopback HTTP works for development; a non-loopback HTTP URL requires an explicit `allowInsecureHttp: true` configuration choice. That setting does not encrypt credentials. Setting a URL does not configure networking, a relay, or firewall access.

## Access and current limits

`orchestration:read` permits listing channels and reading messages. `orchestration:operate` permits registering factory projects/channels and sending messages. Permissions apply across the environment, not per factory project. Sender/recipient role IDs are routing labels supplied by authorized operators; they are not authenticated agent identities or private mailboxes.

Factory project IDs are durable identifiers for messaging. They are currently registered separately from inherited T3 project records. The app view maps them explicitly to the selected environment/project. There are no automatic agent wakeups, acknowledgments, attachments, conversation threads, or executable assignment semantics yet.

## Verification

`npm run smoke:messaging` builds no mocks: it launches the built environment in a temporary directory, issues scoped credentials, exercises actual HTTP/CLI/MCP clients, tests permission denials and retry conflicts, and restarts the server to confirm persistence. It requires a prior `npm run build`.

`npm run smoke:messaging -- --live-codex` additionally invokes an already authenticated local Codex harness to deliver a message through MCP. This optional subscription-backed check is excluded from CI. A successful local test does not establish connectivity between two physical machines.
