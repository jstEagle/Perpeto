# Apple app handoff

Status: early implementation, 21 October 2026. A native SwiftUI client in `apps/apple` for macOS, iPhone and iPad, built on the contract in [the architecture](../architecture/README.md). It reads a live local hub (`apps/hub`) and falls back to demo fixtures. **The visual style is provisional:** Justus has asked for a new minimal, monochrome design system, and a restyle will follow. This round covered function only.

## What changed in this round

- **Live map routing.** Layout moved into PerpetoKit as a tested router (`Graph/GraphLayout.swift`). Flow edges keep the rows and the gaps between them. Delegates, messages and unplanned interactions leave cards from their outer edge, run in channels above and below the drawing, and change rows through side gutters. Lanes are allocated shortest span first, so routes never share a lane, and lines are drawn with a paper halo so crossings read as bridges. Count labels are placed along their own route so none overlaps another label or a card. The legend toggles role edges between all roles and the selected node. Rows spread horizontally when stored positions are too close for the cards (the hub's build template needed this). Applies to the live map, the proposal diff (removed edges are routed too) and the editor.
- **Hub shapes.** Every assumption from the previous handoff was checked against `apps/hub` routes and tests and corrected; see below. The run list uses `GET /projects/:id/runs`; the architect is followed with `GET /assignments/:id`, including retries after invalid drafts. Live events trigger a debounced (750 ms) refetch of the affected run, project or factory; lease renewals and heartbeats are ignored because they made up most of the log. The window picker refetches run and project metrics.
- **Human decisions** send the work item's `decisionId`. A `409 STALE_DECISION` (or `CONFLICT`) explains that the item now waits for another decision and reloads the project.
- **Local validation** now matches `packages/workflow` on merge-queue `pass`/`fail` ports, delegate-only agents, escalation targets and required config (`source`, `prompt`, `strategy`, `method`, `until`). Before this, a draft the hub accepted showed as invalid. The proposal panel uses the hub's validation when connected.
- **iPhone and iPad app** (`apps/apple/iOS`), sharing PerpetoKit and PerpetoUI: adaptive navigation (split view on iPad, stack on iPhone), overview, runs list, run live map with pan, pinch zoom and tap to inspect (a sheet on iPhone), workflow proposal with Activate and Ask for changes, machines and usage. Hub settings are shared with the Mac; the token stays in the Keychain.
- **Editor undo and redo** through `GraphHistory` in PerpetoKit: every edit undoes the same way, typing in one node's fields coalesces, and ⌘Z / ⇧⌘Z go through the Edit menu.

## Hub shapes, as implemented

| Previous assumption | Hub |
| --- | --- |
| Lists bare or wrapped in `items`/`data` | Always `{<resource>: [...]}`, for example `{runs}`, `{entries}`, `{groups, totals}`, `{events, nextCursor}` |
| `POST /workflows/:id/validate` → `{valid, issues}` | `{valid, errors, warnings}`; issues carry no `severity` |
| Drafts return `{assignment}` or `{assignmentId}` | HTTP 202 with the bare architect Assignment (no `runId`) |
| Decisions and inputs return entities | `{accepted: true}`; decisions also take `decisionId` |
| Metrics `{window, …}`, unplanned edge `from>to` | No `window`; unplanned `edgeId` is `unplanned:<kind>:<from>-><to>` with `from`/`to` fields; node `concurrency`, `utilization`, `failureRate` and percentiles may be null |
| Interaction data `fromNode`, `toNode`, `fromRole`, `toRole`, `summary` | `sourceNodeId`, `targetNodeId`, `role`, `senderRoleId`/`recipientRoleId`, `messageId`; no summary |
| `PUT /workflows/:id` takes a whole workflow | Merges `{name, graph, purpose, rationale}` over the head |
| Job log is text | `{jobId, chunks: [{chunk, at}]}` |
| `GET /health` → `{ok}` | `{status: "ok", version}` |

## Verification

| Check | Result |
| --- | --- |
| `swift build`, `swift test` | Passed, no warnings; 62 tests in 15 suites, including routing (no shared lanes, no card crossings, no label overlaps, on demo graphs and the hub's build template), history, decisions and the event debounce |
| Live hub tests (`PERPETO_HUB_URL`, `PERPETO_HUB_TOKEN_FILE`) | Passed against the branch's hub and against `main`'s hub (temporary detached worktree): every read route decodes strictly, and a human decision with its `decisionId` is accepted while a repeat is refused |
| `xcodebuild` macOS (`-scheme Perpeto`), PerpetoUI and the iOS app for the iOS Simulator | Passed |
| Live refresh | An input added through the API appeared in the app without a manual refresh (`screenshots/hub/hub-10…`, `hub-11…`) |
| Screenshots | macOS demo (`screenshots/`), macOS live hub (`screenshots/hub/`), iPhone 17 Pro and iPad Pro 13-inch simulators on a seeded hub (`screenshots/ios/`). Window or device captures only. They show the provisional style |

Not verified: undo and redo were not exercised in the running app. Synthetic mouse events did not drive SwiftUI's drag gesture and this machine denies UI scripting, so only `GraphHistory` and the build are tested. Pinch zoom and tap-to-inspect were checked by launch arguments and captures, not by touch. Nothing ran on a physical device. Distribution signing, notarization and sandboxing are not set up.

## Findings for the hub owner

- `GET /events` only pages forward from `after`. To show recent activity the client walks the whole log. A `before` cursor or `latest=true`, plus type and project filters, would fix this.
- Lease renewals and heartbeats are written to the event log every few seconds per lease. On the seeded hub they were 786 of the last 1,000 events.
- `agent.messaged` defaults `targetNodeId` to `recipientRoleId`, a role rather than a node, so an observed message without an explicit target can be counted against the wrong edge.
- The build template's positions are 160 pt apart, narrower than either client's cards. The app spreads them; storing wider positions would be simpler.

## Gaps

- Restyle to the new design system (pending a brief).
- The app icon mismatch and the 168 vs 240 pt node width from the previous handoff are still open.
- No auto-layout in the editor, and the iOS app has no editor.
- `GET /workflows/:id/diff` is still unused; the diff is computed locally.
