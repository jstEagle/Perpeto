# Apple app handoff

Status: early implementation, 21 October 2026. A native SwiftUI client in `apps/apple` for macOS, iPhone and iPad, built on the contract in [the architecture](../architecture/README.md). It reads a live local hub (`apps/hub`) and falls back to demo fixtures, and follows the Perpeto Mono design system.

## Perpeto Mono restyle

- **Tokens.** `PerpetoTokens.swift` is the generated file from `packages/design-tokens`, copied verbatim; no deprecated alias is used. Components in `PerpetoUI/Components`: white cards with soft elevation, black pill primary and white secondary pills, 40 pt titles, status by icon, word and weight (orange only for the live dot, red only for failure), a pill segmented control, disclosures and trend bars.
- **Shell.** Mac and iPad: a split view with the canvas sidebar (lockup, project switcher, project navigation with counts and a live dot, Factory group, connection row) and an untitled toolbar. iPhone: Overview, Runs, Work, Messages and More tabs.
- **Screens** follow the overview and run mocks: one primary action per view, three numbers up front with "More metrics", "N more issue", "Node details", "Docs and requirements" and "Version history" disclosures, and lists instead of tables. Covered: overview, workflows (prompt-first composer, proposal with Activate and Ask for changes), hand editor, runs list, run live map, work, messages, merge queue, machines, accounts, usage, hub connection settings, empty and error states.
- **Map.** A dotted field with 208 pt rounded nodes (icon tile, name, meta, stat line, meter, live dot), thin grey edges without arrowheads, counts in pills ("12 returned" on returns). A return is any flow edge into a step with a smaller flow depth (inputs, flow edges and escalation links). All returns into one step share a single line over the top of the rows, climbing the right gutter from later rows, with one combined label ("16 returned"). Work moving to the next row enters the card from the top; work that skips rows goes down the left gutter. Tests check that flow lines never cross on the demo, the proposal and the hub's build template. Role edges are hidden by default and take no space; "Show all roles" in the legend brings them back. On iPhone the map is a list of steps.
- **Motion.** Hover and press use the fast standard curve, selection, disclosure and the segmented thumb the base ease-out; all are off under Reduce Motion.

Goals decode from the hub's objects `{id, title, status, workItemIds, done, total}` and from legacy strings, and show a count and progress meter. The sidebar footer shows the owner's name and initials from `/overview`.

**Messaging (controlled messaging, schema v2).** Messages decode `threadId`, `parentId`, `senderKind`, `unplanned` and `receipt`, and older messages still decode as roots. The Messages screen lists run and project channels with the owner's unread count (`GET …/unread?roleId=owner`), shows threads with replies indented under their root, receipt state as a quiet icon and words ("Waiting for you", "Delivered into the running turn", "Acknowledged"), and an Unplanned mark for flagged sends. The owner can acknowledge messages addressed to them, reply in a thread (to the parent's sender, a chosen role or everyone; an explicit `null` addresses the channel) and start a message to any role. Opening a channel moves the owner's read cursor forward. `message.delivered`, `message.acked` and `agent.messaged` events refresh the project. Verified against a seeded hub: an agent send delivered by steer, a question for the owner, an unplanned send and an owner message, with unread 1.

**Live map fitting.** When the full drawing would need shrinking below 85%, the run map switches to compact cards (168 pt, name and stat line) and fits them between 75% and 100%, as on the web; the card height follows the fitted drawing. Below 75% the map scrolls sideways and opens centred on the most urgent bottleneck. "Show on map" (on the run, or from the overview) pans to the step and selects it. Checked on the seeded hub's 12-step run: it opens at 75% on the saturated Reviewer, pans to Ideas and back (`screenshots/hub/hub-03…`, `hub-03a…`, `hub-03b…`).

**Continuous runs and budgets.** Runs decode `keepOpen`, `source`, `schedule`, `budget`, `intake`, `budgetUsage`, `completedAt` and `stoppedAt`. Mac and iPad: active workflows sit side by side as cards (status, run summary, today's budget); a new workflow starts from the architect prompt or one of `GET /workflow-templates`, and the architect's additional drafts appear under "Also suggested". Starting a run and its Settings open one sheet: keep running, where work comes from (goals, a schedule with frequency, day and UTC time pickers that write the hub's cron, or manual) and daily limits ("2M" style). Saving sends `PATCH /runs/:id`; an empty budget removes the limits. Budget use is a meter per limit on the run, the workflow card and the overview's live card. A run held by its budget reads "Running, intake paused", says which limit was reached and when intake resumes (00:00 UTC in local time, or when active items drop), and is listed under Needs attention. Runs show completed, stopped or failed times and duration. Usage adds By role. iPhone shows all of this read only. Bottleneck headlines are now sentences per reason ("No machine can run Builder", not "Builder is no machine can run this").

Known difference from the mocks: the Mac split view keeps the system divider between sidebar and content.

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
| `swift build`, `swift test` | Passed, no warnings; 75 tests in 19 suites, including run settings, intake and budget decoding, the start and PATCH bodies, templates, schedule rules round-tripping through cron, and a demo budget hold released by raising the limit; including routing (no shared lanes, no card crossings, no label overlaps, on demo graphs and the hub's build template), history, decisions and the event debounce |
| Live hub tests (`PERPETO_HUB_URL`, `PERPETO_HUB_TOKEN_FILE`) | Passed against the branch's hub and against `main`'s hub (temporary detached worktree): every read route decodes strictly, and a human decision with its `decisionId` is accepted while a repeat is refused |
| `xcodebuild` macOS (`-scheme Perpeto`), PerpetoUI and the iOS app for the iOS Simulator | Passed |
| Live refresh | An input added through the API appeared in the app without a manual refresh (`screenshots/hub/hub-10…`, `hub-11…`) |
| Screenshots | Perpeto Mono: macOS demo (`screenshots/`, including settings, empty and error states), macOS against a seeded hub (`screenshots/hub/`), iPhone 17 Pro and iPad Pro 13-inch simulators with demo data (`screenshots/ios/`). Window or device captures only, compared side by side with `packages/design-tokens/screenshots` |

Not verified: undo and redo were not exercised in the running app. Synthetic mouse events did not drive SwiftUI's drag gesture and this machine denies UI scripting, so only `GraphHistory` and the build are tested. Pinch zoom and tap-to-inspect were checked by launch arguments and captures, not by touch. Nothing ran on a physical device. Distribution signing, notarization and sandboxing are not set up.

## Findings for the hub owner

- `GET /events` only pages forward from `after`. To show recent activity the client walks the whole log. A `before` cursor or `latest=true`, plus type and project filters, would fix this.
- Lease renewals and heartbeats are written to the event log every few seconds per lease. On the seeded hub they were 786 of the last 1,000 events.
- `agent.messaged` defaults `targetNodeId` to `recipientRoleId`, a role rather than a node, so an observed message without an explicit target can be counted against the wrong edge.
- A run's `budgetUsage` and `intake` are only returned once intake has state, so a fresh run with a token budget reports no use even after agents reported tokens. The app shows the limit alone until then.
- Seeded leases were sometimes requeued right after leasing (`assignment.updated` back to `queued`), so the seed's later renewals failed with `lease_lost`. The seed now drops lost leases instead of crashing.
- The build template's positions are 160 pt apart, narrower than either client's cards. The app spreads them; storing wider positions would be simpler.

## Gaps

- The app icon mismatch and the 168 vs 240 pt node width from the previous handoff are still open.
- No auto-layout in the editor, and the iOS app has no editor.
- `GET /workflows/:id/diff` is still unused; the diff is computed locally.
