# Implementation decisions

## Preserve T3 Code as a pinned foundation — 20 October 2026

User decision: reuse T3's orchestrator and all provider integrations. The first import retains the upstream workspace under `vendor/t3code`, because orchestration depends on persistence, contracts, provider lifecycle, filesystem/Git services and other workspace packages. Preserve internal package names and upstream licenses to avoid breaking that dependency graph.

The source pin and exclusions are in `config/upstream.json`. Excluded reference repositories and agent instructions are not runtime integrations. Upstream clients are retained as a development surface; their presence is not a Perpeto platform release. No upstream cloud deployment or package publication is enabled.

A surgical extraction of adapters was rejected for the initial foundation because it omits server-owned Codex, Claude and Antigravity implementations and their runtime dependencies. A future extraction can be made with tests once integration boundaries are established.

## Keep factory state beside the inherited runtime — 20 October 2026

Implement initial durable messaging in `packages/messaging`, independent of agent session lifetimes. This does not add a new inference harness. Network authentication, agent tools and UI integration are separate implementation work and must be verified before claiming cross-device messaging.

## File-based launch configuration — 20 October 2026

Perpeto's launcher reads non-secret host, port and data-path settings from `config/perpeto.json` and passes explicit runtime flags. Upstream retains legacy environment-variable compatibility internally; it has not been globally refactored. New Perpeto code must follow the repository's configuration rule.
