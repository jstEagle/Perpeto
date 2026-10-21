# Implementation decisions

## Preserve T3 Code as a pinned foundation — 20 October 2026

User decision: reuse T3's orchestrator and all provider integrations. The first import retains the upstream workspace under `vendor/t3code`, because orchestration depends on persistence, contracts, provider lifecycle, filesystem/Git services and other workspace packages. Preserve internal package names and upstream licenses to avoid breaking that dependency graph.

The source pin and exclusions are in `config/upstream.json`. Excluded reference repositories and agent instructions are not runtime integrations. Upstream clients are retained as a development surface; their presence is not a Perpeto platform release. No upstream cloud deployment or package publication is enabled.

A surgical extraction of adapters was rejected for the initial foundation because it omits server-owned Codex, Claude and Antigravity implementations and their runtime dependencies. A future extraction can be made with tests once integration boundaries are established.

## Keep factory state beside the inherited runtime — 20 October 2026

Implement initial durable messaging in `packages/factory-core`, independent of agent session lifetimes. This does not add a new inference harness. Network authentication, agent tools and UI integration are separate implementation work and must be verified before claiming cross-device messaging.

## File-based launch configuration — 20 October 2026

Perpeto's launcher reads non-secret host, port and data-path settings from `config/perpeto.json` and passes explicit runtime flags. Upstream retains legacy environment-variable compatibility internally; it has not been globally refactored. New Perpeto code must follow the repository's configuration rule.

## Separate saved graphs from execution — 21 October 2026

Implementation choice within the authorized factory build: persist versioned definitions before wiring them to provider sessions. Nodes describe agents, context, checks and merge queues; typed edges distinguish delegation, context and workflow. Optimistic version checks preserve another editor's work. These definitions do not yet execute, enforce native subagent limits or merge changes. The interface must expose that boundary.

## Pin CI work and require explicit recovery — 21 October 2026

The initial owned-machine runner uses a Perpeto-native queue, owner-configured local repository/executable mappings, full commit SHAs and isolated checkouts. It keeps execution independent of the submitting agent session without adding a new inference provider. Confirmed leases and fencing reject stale completion. An expired job becomes lost and needs explicit retry, since automatic replay could repeat a command whose effects are uncertain. This is process cleanup and workspace separation, not an OS sandbox. Artifact files are not retained yet; only bounded logs and artifact summaries are stored.
