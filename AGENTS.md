# Repository guidance

Perpeto is in early implementation, with brand exploration still provisional. Read README.md, brand.md, docs/vision.md, and docs/status.md before changing project direction. Keep proposals clearly distinguished from approved decisions and implemented features. The approved foundation reuses T3 Code's orchestrator and all provider integrations under vendor/t3code. Preserve upstream notices and provenance; keep new factory services outside that directory unless a change to the inherited runtime is necessary. Do not describe planned capabilities as shipped without supporting work.

## Challenge plans and assumptions

Always challenge Justus when you believe part of his plan is flawed or there is a better approach, including product, implementation, and architecture decisions. Explain the specific concern, the tradeoffs, and the alternative you recommend. Ask him to defend the reasoning or assumptions behind his position rather than accepting it without scrutiny. Keep challenges constructive and grounded in evidence; distinguish facts from uncertainty. Once the tradeoffs are understood and he makes an informed decision, respect that decision unless new evidence warrants reopening it.

## Configuration

Keep all non-secret configuration in appropriate configuration files. Only sensitive secrets, credentials, tokens, API keys, and similar private values belong in environment variables or secret stores.

## Design

Never use small numbered or indexed labels above titles or tiny tracked-out mono section kickers. Let titles stand on their own. If a section needs context, put it in the title.

Use brand/tokens.css as the source of truth for the proposed Workshop visual system. Alternative concepts are explorations, not approved themes.

## Validation

Use checks appropriate to the change. For documentation and brand work, check links, terminology, and rendered layout when available. Report unverified behavior honestly.
