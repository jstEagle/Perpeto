# Factory client

Node 24 CLI and MCP stdio client for Perpeto messaging, owned-runner CI, and saved factory definition APIs hosted by the T3 runtime. It uses no external dependencies and reuses the repository's factory definition validator. Agents use the same authenticated channels, job queue and graph definitions as people. All inference continues to run through their existing harnesses.

## Configure a device or harness role

Create a local JSON configuration file. All non-secret configuration belongs here:

```json
{
  "baseUrl": "http://127.0.0.1:3773",
  "projectId": "perpeto",
  "roleId": "backend-lead",
  "channelId": "build",
  "credentialFile": "./session.secret",
  "timeoutMs": 30000
}
```

Put an existing T3 session credential, as a single raw token, in `session.secret`. Use the runtime's authenticated session provisioning path; this client does not mint credentials. Make the file owner-only (`chmod 600 session.secret`). Relative credential paths resolve against the config file's directory. The client rejects symlinks, files owned by another user, and files readable by group or others. Never commit the secret file or put the token in config, CLI arguments, or a harness configuration.

Use an HTTPS endpoint for remote connections or forward the remote endpoint to loopback through a trusted tunnel. HTTP loopback is supported. Explicit `"allowInsecureHttp": true` in the JSON config permits remote HTTP when needed; that sends the bearer credential without TLS. Networking and remote pairing remain the T3 runtime's responsibility.

## CLI

Run from the repository root:

```sh
node packages/factory-client/src/cli.js --config /absolute/path/client.json init-project Perpeto
node packages/factory-client/src/cli.js --config /absolute/path/client.json create-channel build Build
node packages/factory-client/src/cli.js --config /absolute/path/client.json channels
node packages/factory-client/src/cli.js --config /absolute/path/client.json send --body 'Revision abc123 is ready' --key review-abc123 --to reviewer
node packages/factory-client/src/cli.js --config /absolute/path/client.json read --limit 50
node packages/factory-client/src/cli.js --config /absolute/path/client.json read --latest --limit 50
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
        "/absolute/path/Perpeto/packages/factory-client/src/cli.js",
        "--config", "/absolute/path/backend-lead.json", "mcp"
      ]
    }
  }
}
```

This illustrates the common MCP server configuration shape; confirm your harness's configuration location and syntax. Give each durable role its own config. Replacing a harness session can reuse that role config without changing message identity. The session bearer credential grants the runtime's access level; role IDs are labels, not separate permissions.

Tools:

- `factory_channels`: list the configured project's channels.
- `factory_send`: `{body, idempotencyKey, recipientRoleId?, channelId?}`; sender comes from the configured role.
- `factory_read`: `{after?, before?, latest?, limit?, recipientRoleId?, channelId?}`; returns the server's message page. Use only one direction.
- `factory_submit_ci`: `{repositoryId, revision, command, requiredLabels?, idempotencyKey}`; queue a revision-pinned job in the configured project.
- `factory_ci_status`: `{jobId}`; read the job and its available result in the configured project.
- `factory_retry_ci`: `{jobId}`; explicitly requeue a failed/lost job, or return an already queued job unchanged.
- `factory_list_definitions`: `{}`; list saved graph definitions in the configured project.
- `factory_read_definition`: `{id, version?}`; read current or immutable historical definition.
- `factory_create_definition`: `{id, definition}`; create with an explicit stable ID.
- `factory_update_definition`: `{id, expectedVersion, definition}`; append a revision only if the expected version is still current.

The stdio server implements newline-delimited MCP JSON-RPC initialization, ping, tool discovery, and tool calls. It advertises only tools, writes protocol JSON exclusively to stdout, handles notifications without responding, and returns tool failures using `isError`. It supports protocol versions 2024-11-05, 2025-03-26, 2025-06-18, and 2025-11-25. This initial implementation handles requests sequentially and does not offer subscriptions, cancellation, prompts, resources, or agent wake-ups.

## Submit work to an owned CI runner

Use the same client configuration and credential from any device that can reach the runtime. Submission requires `orchestration:operate`; status/list requires `orchestration:read`. The client retry command requires both scopes because it verifies the job's project before mutation. The client always takes project identity from its configuration. It does not need a worker's repository paths or execution configuration to submit a job.

Create a non-secret `job.json`:

```json
{
  "repositoryId": "app",
  "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "command": ["node", "--test"],
  "requiredLabels": ["linux"],
  "idempotencyKey": "test-app-revision-a"
}
```

Replace the illustrative revision with the actual full lowercase 40- or 64-character commit SHA available to the runner. The command is an argv array; no shell is implicitly invoked. The runner must allowlist the repository and have matching labels. See the [runner setup](../factory-runner/README.md).

```sh
node packages/factory-client/src/cli.js --config /absolute/path/client.json ci-submit --job job.json
node packages/factory-client/src/cli.js --config /absolute/path/client.json ci-status --id JOB_ID
node packages/factory-client/src/cli.js --config /absolute/path/client.json ci-jobs --limit 25
node packages/factory-client/src/cli.js --config /absolute/path/client.json ci-retry --id JOB_ID
```

Submission returns `{job, duplicate}` and reuses its exact serialized payload on an automatic transport retry. Reusing a project/key for a different repository, revision, command or labels conflicts. Status returns the tested revision, command, status, runner, attempt, and available result with log/artifact metadata. The client rejects status/retry access to a job whose project differs from its configuration; the runtime credential itself remains environment-scoped.

Explicit retry first checks the job's project, then posts once. It deliberately does not automatically repeat the retry mutation after a timeout or transient response: a fast runner might already have claimed or finished the next attempt. Inspect status after an ambiguous retry before deciding whether to retry again. A retry does not change the pinned revision or command. Active/successful jobs reject retry.

## Author saved factory definitions

Agents can create and revise the same graph definitions users see in the factory builder. These operations store definitions only: they do not execute a graph, start agents, enforce delegation/concurrency settings, run checks, or merge changes. CI submission remains a separate operation.

Use a definition JSON file containing exactly `name`, `nodes` and `edges`. For example:

```json
{
  "name": "Project delivery",
  "nodes": [
    {
      "id": "lead",
      "type": "agent",
      "label": "Project lead",
      "harness": "codex",
      "allowSubagents": true,
      "maxSubagents": 4,
      "maxConcurrent": 2,
      "position": {"x": 0, "y": 0}
    }
  ],
  "edges": []
}
```

The shared [factory schema](../factory-definition/README.md) validates all agent, context, check and merge-queue node types, typed edges, limits and delegation cycles before sending. MCP advertises the same structural node variants and validates them before HTTP, followed by the shared semantic validator. Project identity comes exclusively from the client config; factory/project IDs must be single path-safe identifiers.

```sh
node packages/factory-client/src/cli.js --config /absolute/path/client.json factories
node packages/factory-client/src/cli.js --config /absolute/path/client.json factory-create --id delivery --definition factory.json
node packages/factory-client/src/cli.js --config /absolute/path/client.json factory-read --id delivery
node packages/factory-client/src/cli.js --config /absolute/path/client.json factory-update --id delivery --expected-version 1 --definition factory.json
node packages/factory-client/src/cli.js --config /absolute/path/client.json factory-read --id delivery --version 1
```

Create and update require `orchestration:operate`; list/read require `orchestration:read`. Create requires a caller-selected stable factory ID. Updates require the exact version you edited; HTTP 409 means the current definition changed and your draft must be reconciled against a fresh read. The client does not change the draft file, increase `expectedVersion`, or overwrite a newer revision automatically.

Both write operations make a single request, including after transport errors or transient responses. A timeout can mean the write was persisted. Read the explicit ID and inspect its version/definition before deliberately retrying. A repeated create can conflict even when the prior write was yours. A repeated stale update also conflicts. Immutable version reads support comparing the prior baseline with the latest graph.

Reusable client methods are `listFactories()`, `readFactory(id, {version?})`, `createFactory({id, definition})` and `updateFactory({id, expectedVersion, definition})`. The MCP server now exposes ten tools; its original messaging and CI tools remain available.

## Validation

```sh
cd packages/factory-client
node --test
```

Tests exercise authenticated HTTP request shapes, cursor encoding, retry idempotency, rejected credentials and HTTP errors, CI project scoping, saved-definition validation/CAS/nonreplay behavior, CLI child processes, and actual MCP stdio child-process exchanges. Tests use a local HTTP fixture; deployed routing, pairing, runner execution and real harness loading require separate end-to-end verification.
