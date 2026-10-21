# Apple app handoff

Status: early implementation on branch `t3/2f00a902`, 21 October 2026. A native SwiftUI client in `apps/apple`, built on the contract in [the architecture](../architecture/README.md) including the agent-authored workflows and observing-runs addendum. It runs on demo fixtures. It has not been run against a live hub.

## What exists

- **PerpetoKit:** Codable models for every contract entity, `Workflow.authoredBy`, `rationale` and `parentVersion`, and `NodeMetrics`, `EdgeMetrics`, `RunMetrics` and `Bottleneck`. Unknown enum values decode to `unknown` rather than failing a response. Workflow graph v1 with local validation and a version diff. An async Hub API v1 client covering every route in the contract table plus messaging, with server-sent events and reconnect from the last `seq`. The owner token lives in the Keychain; the hub URL in UserDefaults.
- **Demo fixtures:** the `perpeto` project runs its Build workflow on two machines. The single reviewer is saturated (utilization 1.00, queue 3 → 7), the review loop shows rework (four items on iteration 3 of 3, one failed at the limit), builders sit at 67%, and a reviewer agent has proposed draft version 4 that adds a UI reviewer. Builder-to-planner messages appear as unplanned interactions.
- **Screens:** sidebar per contract with project vitals in the toolbar; overview with top bottleneck and velocity; prompt-first workflows with architect progress, proposal rationale, a diff against the active version, Activate, Ask for changes and Edit by hand, and version history; a hand editor with draggable nodes, typed ports, three edge kinds, inspector and validation; a run live map with per-node load, queue, wait, throughput and utilization, work-item markers, edge traffic counts, unplanned interactions, bottleneck reasons and evidence, velocity, where-work-is-running and a selection-filtered interaction feed; work, messages, merge queue, machines, accounts and usage (Swift Charts).
- **Brand:** Workshop tokens only, system font with monospace for identifiers and logs, 6 and 12 pt radii, ruled surfaces, explicit status labels, no uppercase microcopy, kickers or gradients. The only motion is the Flywheel Spindle loader while the architect works, plus a 0.18 s map transition; both are off under Reduce Motion. Light appearance is forced because dark mode is undefined in brand/README.md.

## Verification

| Check | Result |
| --- | --- |
| `swift build` | Passed, no warnings |
| `swift test` | 40 tests in 9 suites passed: decoding, metrics, envelopes, client paths and headers, idempotency keys, error mapping, SSE parsing, validation, diff, demo story, Keychain round trip |
| `xcodebuild -scheme PerpetoUI -destination 'generic/platform=iOS Simulator'` | Passed. No iOS app target exists and nothing was run on iOS |
| `scripts/build-app.sh` | Produced an ad-hoc signed `Perpeto.app` |
| `scripts/snapshots.sh` | 15 window captures plus the icon in `apps/apple/screenshots/`, reviewed against the brand boards |

Not verified: dragging nodes, connecting ports, deleting with the keyboard, menus and shortcuts were built but not exercised by automation or by hand. Screenshots show rendering only. The hub data source has only stubbed-transport tests.

## Assumptions to confirm with the hub owner

The contract leaves these shapes open. The client is tolerant where it can be.

- Lists may be a bare array or an object holding one array (`items`, `data` or the resource name).
- `idempotencyKey` is sent in the JSON body, as messaging does.
- `GET /overview` keys: `activeAgents`, `queuedWork`, `tokensToday`, `machinesOnline`.
- `GET /usage` rows: `{ key, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd? }`; day keys are `yyyy-MM-dd`.
- Metrics routes return `{ window, nodes, edges, run, bottlenecks }` (`summary` accepted for `run`). An unplanned `EdgeMetrics.edgeId` of the form `fromNode>toNode` is drawn between those nodes.
- Interaction event `data` carries `fromNode`, `toNode`, `nodeId`, `edgeId`, `fromRole`, `toRole`, `state`, `result`, `unplanned` and `summary`.
- `POST /workflows/:id/validate` returns `{ valid, issues }` (`errors` accepted); drafts return `{ assignment }` or `{ assignmentId }`; decisions send `{ decision: 'pass'|'fail' }`; inputs send `{ items: [{ title }] }`.
- Messaging is served at `/api/v1/messaging/projects/:id/channels…`, mirroring the existing `/api/perpeto` routes.
- The diff view is computed locally from `GET /workflows/:id/versions`; `GET /workflows/:id/diff` is not used yet.

## Gaps and recommendations

- **No project run list in the contract.** The hub data source finds runs through the event log, which misses runs whose events have aged out. Recommend `GET /projects/:id/runs`.
- Live events are appended to the feed, but metrics and work items refresh only on ⌘R or after an action. The metrics window picker does not refetch yet.
- The editor has no undo, no pinch zoom and no auto-layout. Removed nodes are drawn as ghosts only in the diff view.
- **App icon mismatch.** My brief said Spindle on paper; `packages/design-tokens` ships an ink tile with a paper Spindle. `build-app.sh` uses the shared icon when that package is present and falls back to the paper icon drawn in code (`screenshots/app-icon.png`). Justus should pick one.
- `PerpetoEditor.nodeWidth` in the shared tokens is 240 pt; the app uses 168 pt so a build workflow fits at 100% beside the inspector. Align the token or the app.
- Distribution signing, notarization, sandboxing and an iOS app target are not set up.
