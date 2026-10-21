# Definition of done

Evidence through **21 October 2026**, local main `0508551`. Checked items mean the stated scope passed, not that the full product is released. Historical handoffs retain their original branch/test counts; [build status](status.md) reconciles later fixes.

## Foundation

- [x] Preserve T3's orchestrator, all provider integrations, dependencies, license and provenance; build/start an isolated local runtime. [Foundation](../handoffs/initial-foundation.md), [review](../handoffs/foundation-review.md).
- [x] Durable project messaging with retry-safe sends, cursor reads, restart persistence, authenticated HTTP and CLI/MCP access. [Transport](../handoffs/messaging-transport.md), [client](../handoffs/messaging-client.md), [bounded UI](../handoffs/messaging-history-ui.md).
- [x] Initial foundation hosted Linux CI passed for `d64c781`. [Evidence](../handoffs/initial-foundation.md).
- [ ] Current implementation passes hosted CI. Pushing is blocked; the initial run does not cover current code.

## Factory execution

- [x] Author, validate, version and activate workflows; run durable planner/build/review/CI/merge gates with bounded retries, escalation and human decisions. Automated engine/recovery tests and a local Codex journey passed. [Workflow](../handoffs/factory-workflow.md), [integration](../handoffs/integration.md), [live acceptance](../handoffs/live-acceptance-1.md).
- [x] Complete a real local define/build/review/rework/test/merge journey with outcome evidence. Run 2 merged `slugify` into a throwaway bare origin; fresh clone passed 6 tests. [Live acceptance](../handoffs/live-acceptance-1.md#run-2-merged).
- [x] Run revision/config-bound CI on a user-owned local node, including hub-supplied candidate bundles. [Live acceptance](../handoffs/live-acceptance-1.md), [bundle/recovery evidence](../handoffs/hub-wiring.md).
- [x] Recover tested hub crashes and fence stale leases without duplicate publication, using real processes and fake executors/forge. [Crash tests](../handoffs/hub-wiring.md#recovery-fixes).
- [x] Verify Codex role output, usage, app-owned subagent policy and factory context/Git isolation live. Earlier Claude policy turns also passed. [Executor](../handoffs/factory-t3.md).
- [ ] Verify Claude isolation live, provider-native subagent enforcement and every claimed provider integration. [Executor limits](../handoffs/factory-t3.md).
- [ ] Replace an orchestrator during live work and continue without lost/duplicate assignments; test cancellation and restart during real harness turns. Automated recovery is partial evidence only. [Live limits](../handoffs/live-acceptance-1.md#not-verified).
- [ ] Exercise real subscription pool enrollment, exhaustion, cooldown and retry placement. Synthetic account tests do not prove live swaps. [Accounts](../handoffs/factory-accounts.md), [executor follow-up](../handoffs/factory-t3.md).
- [ ] Accept cross-machine user/agent messaging with defined delivery/wake-up behavior; conversation threads and automatic recipient wake-ups remain unimplemented. [Messaging limits](../guides/messaging.md#access-and-current-limits).
- [ ] Accept protected GitHub publication/merge-queue behavior against a real forge. Tests use stubbed GitHub and local origins. [Delivery](../handoffs/factory-delivery.md).

## Machines and clients

- [x] Test capacity/fencing and load over local HTTP: 100 simulated machines, 1,000 queued assignments for 60 s. [Measured results](../handoffs/review-wave3.md#long-poll-fan-out-and-full-table-scans-collapse-the-hub-well-below-the-scale-target-h3).
- [ ] Enroll a real second machine over a real LAN/tailnet, reconnect after interruption, exchange durable messages and execute agents/CI across it. Loopback TLS/join tests and separated filesystem roots do not satisfy this. [Remote guide](../guides/remote-machines.md), [wiring](../handoffs/hub-wiring.md).
- [x] Web main flows in Chromium against a real local hub, including real Codex-run results. [Web checks](../handoffs/web-app.md), [acceptance screens](../handoffs/live-acceptance-1.md#web-app-against-the-live-hub).
- [x] Native Mac app reads a real local hub, refreshes and answers a bound human decision; Apple builds/tests and iPhone/iPad simulator captures pass. [Apple evidence](../handoffs/apple-app.md#verification).
- [ ] Verify Safari/Firefox, accessibility, touch editing, Mac editor gestures/undo in the running app, and physical iPhone/iPad behavior. [Web limits](../handoffs/web-app.md), [Apple limits](../handoffs/apple-app.md).
- [ ] Complete a fresh-user installation, real service loading, app signing/notarization/distribution and unattended multi-machine acceptance. [CLI limits](../handoffs/perpeto-cli.md), [Apple gaps](../handoffs/apple-app.md).

Passing tests, a simulated fleet or a local successful merge does not establish the complete cross-machine factory experience.
