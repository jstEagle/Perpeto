# T3 observer

Read-only observer of an operator's own running T3 Code desktop app. Dependency-free ESM for Node 24 with no hub coupling: it produces observation batches and the node daemon delivers them. See the [observe guide](../../docs/guides/observe.md) for setup and the [contract](../../docs/architecture/README.md#observe-only-mode) for the batch shape.

```js
import { createT3Observer } from '@perpeto/t3-observer';
const observer = createT3Observer({ t3BaseDir: '~/.t3/userdata' /* absolute */, dataDir, pollMs: 5000, includeTitles: true }).start();
const batch = observer.collect();          // null when nothing changed and no status ping is due
await deliver(batch);                      // e.g. POST /nodes/observations with batch.batchId as the idempotency key
observer.acknowledge(batch);               // only after delivery; unacknowledged content is offered again
await observer.stop();
```

| File | Role |
| --- | --- |
| `src/credentials.js` | Mints one `orchestration:read` session with T3's own CLI (`~/.t3/bin/t3 auth session issue`), stores it 0600, reads an operator-provided token file |
| `src/client.js` | `ReadOnlyT3Client`: WebSocket ticket over HTTP, then only `server.getConfig`, `orchestration.subscribeShell` and `orchestration.subscribeThread` (`READ_ONLY_RPCS`); anything else is refused. `readRuntime` finds the server in `server-runtime.json` |
| `src/model.js` | Pure mapping to sessions, per-turn usage (cache subtracted from input, as the executor does), plan labels and usage windows. Only allowlisted fields are kept |
| `src/observer.js` | Reconnecting loop with backoff, shell reducer, throttled usage reads for changed threads, batches with resync after start, persisted fetch keys |

Tests run against the executor's fake T3 server, which validates shell items against T3's real wire schema and records every RPC: `node --test packages/t3-observer/test/*.test.js`.
