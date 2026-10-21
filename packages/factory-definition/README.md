# Factory definitions

This package stores the configuration for a project factory. It does not execute a graph, invoke a model, read a context reference, launch a command, merge code, or enforce native harness subagent limits. Those require a later factory runtime.

`src/storage.js` uses Node 24's SQLite API. No dependencies or environment configuration are required. `DEFAULT_LIMITS` supplies bounds; the store constructor accepts file-based configuration through its `limits` option.

```js
import { FactoryStore } from './src/storage.js';
const store = new FactoryStore('/state/perpeto-factories.sqlite');
const factory = store.create({
  projectId: 'my-project', id: 'delivery', name: 'Delivery',
  nodes: [{
    id: 'lead', type: 'agent', label: 'Coordinator', harness: 'codex',
    allowSubagents: true, maxSubagents: 8, maxConcurrent: 8,
    position: { x: 100, y: 100 },
  }],
  edges: [],
});
store.update({
  projectId: factory.projectId, id: factory.id,
  expectedVersion: factory.version,
  name: 'Updated delivery', nodes: factory.nodes, edges: factory.edges,
});
store.close();
```

## Definition schema

Every node has `id`, `type`, `label`, and optional `position: {x,y}`. Node identifiers are unique within the factory. Positions preserve authored layout and do not imply scheduling.

| Type | Required configuration |
| --- | --- |
| `agent` | `harness`, `allowSubagents` boolean, `maxSubagents` nonnegative integer, `maxConcurrent` positive integer; optional `model` string |
| `context` | `references`: nonempty list of strings pointing to project documents or other context |
| `check` | `command`: nonempty argv array, with an executable as its first item |
| `merge-queue` | `requireChecks`, `requireReview` booleans; `maxConcurrent: 1` |

Harness identifiers match the pinned built-in drivers: `codex`, `claudeAgent`, `cursor`, `grok`, `opencode`, `antigravity`, `pi`, `muse`, `acpRegistry`. Model selection is a string passed through the selected harness in a future runtime; saving does not verify model availability. A disabled subagent policy requires `maxSubagents: 0`.

Context references are stored verbatim without fetching or reading their destinations. Check commands are argv data, never evaluated by this package. Merge queue configuration is inert and defaults should use both requirements enabled; the graph editor may expose requirements explicitly. A saved queue does not authorize merging.

Every edge has `id`, `type`, `source`, and `target`. Edge identifiers are unique and both endpoints must exist.

- `delegates-to`: authority from one agent to another; cycles are rejected.
- `workflow`: work transitions; rework cycles are valid.
- `context`: a context node provides information to a non-context node.

Unknown node, edge, definition fields and invalid numeric limits are rejected rather than silently dropped. Limits protect node counts, edge counts, serialized size and per-project factory counts.

## Persistence and editing

`create`, `read`, `list`, and `update` scope every operation to `projectId`. They do not depend on the separate messaging project registry. A caller needs the inherited environment's authorization; project identifiers are organizational scopes rather than independent security principals.

Updates require the last observed `expectedVersion`. SQLite serializes writes, checks the observed version, and appends a revision in one transaction. A stale write returns `CONFLICT`; the client must reload before saving, keeping its unsaved edits available for reconciliation. Immutable prior definitions remain readable through `read({projectId,id,version})`.

Definitions are local to the hosting environment. Cross-machine state replication is not implemented.

## HTTP integration

The inherited authenticated server module is `vendor/t3code/apps/server/src/perpeto/factories.ts`. It exports the router `layer` and persistent `storageLayer`; the host mounts both. The SQLite file is `perpeto-factories.sqlite` under the host's configured `stateDir`.

| Method and route | Request or response |
| --- | --- |
| `GET /api/perpeto/factories/projects/:projectId` | `{factories: Factory[]}` |
| `POST /api/perpeto/factories/projects/:projectId` | `{id,name,nodes,edges}`; returns created factory, HTTP 201 |
| `GET /api/perpeto/factories/projects/:projectId/:id` | Current factory; optional `?version=1` reads a saved revision |
| `PUT /api/perpeto/factories/projects/:projectId/:id` | `{expectedVersion,name,nodes,edges}`; returns updated factory |

A factory response includes `{projectId,id,name,nodes,edges,version,createdAt,updatedAt}`. Errors use `{error:{code,message}}`: 400 invalid definition, 401 invalid/revoked session, 403 insufficient scope, 404 missing factory/revision, 409 conflicting creation/update, 413 excessive request body. Reads require `orchestration:read`; writes require `orchestration:operate`. Requests are capped at 512 KiB, including chunked uploads.

Run storage validation with `node --test packages/factory-definition/test/storage.test.js`. HTTP integration tests live beside the server module and use its actual session service and Node HTTP listener.
