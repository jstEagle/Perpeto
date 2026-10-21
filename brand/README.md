# Perpeto brand direction

Status: the product UI direction, Perpeto Mono, was selected on 2026-10-21. The rest of the brand is proposed. Perpeto is the working name inherited from this repository; no naming, trademark, or domain clearance has been performed.

## The idea

A software factory should feel deliberate, understandable, and capable of sustained work. Perpeto's identity should make complex coordination feel orderly without implying that autonomous work is infallible.

**Descriptor:** The open-source software factory for coordinated agents.

**Short line:** Intent into working software.

**One sentence:** Perpeto brings project goals, requirements, context, and feedback together to coordinate autonomous agents across machines.

The descriptor and sentence describe the intended product. Until it exists, public copy must make the project's design-stage status visible.

## Three directions

| Direction | Character | Visual language | Tradeoff |
| --- | --- | --- | --- |
| **Workshop**, the basis for Perpeto Mono | Precise, grounded, approachable | Warm paper, ink, signal orange; strong type | Needs disciplined spacing to avoid becoming generic developer tooling |
| **Current** | Continuous, distributed, calm | Deep blue, pale blue, electric blue; connected paths; open layouts | Networking imagery can overwhelm the software-building story |
| **Commons** | Open, collaborative, durable | Cream, forest green, restrained serif headlines; editorial layouts | Less immediately associated with agent orchestration |

See [the visual exploration](preview.html). It compares the original concepts; the selected product UI direction is below.

## Perpeto Mono: the product UI direction

**Decision, 2026-10-21:** Justus selected Perpeto Mono as the product UI direction for the web and Apple clients, after reviewing the existing clients and asking for an interface that is minimal, spacious, monochrome, simple, elegant, rounded, smooth and clean. The [Monochrome Orange board](overviews/favorites/monochrome-orange.png) is the primary reference, with [Monochrome Blue](overviews/favorites/monochrome-blue.png) and the [monochrome set](overviews/monochrome/) as secondary references.

Perpeto Mono keeps Workshop's warm paper, ink and signal orange, and drops its orange buttons, ruled surfaces and coloured status roles. [brand/tokens.css](tokens.css) is the source of truth; [packages/design-tokens](../packages/design-tokens/README.md) generates the client formats and a specimen, and [docs/architecture/design-system.md](../docs/architecture/design-system.md) specifies the components. The clients have not been restyled yet.

This decision covers the product interface. The name, trademark and domain clearance, the small Spindle variant and dark mode remain open.

### Typography

Use the system sans-serif stack for interface and display text, in three weights: regular, medium and semibold. Use the system monospace stack only for identifiers such as run IDs, paths, branches and machine names. This keeps the assets portable and avoids font downloads.

Titles are large, semibold, tightly spaced and sentence case: 40 px page titles, 32 px metrics, 16 px card titles. Body text is 14 px in the app and 16 px for reading, at a 1.5 line height. Display sizes from 48 to 72 px are for brand moments. Do not use uppercase microcopy or table headers, numbered eyebrows, or tracked-out section kickers.

### Color and semantics

Warm off-white is the canvas; white cards carry the work. Six warm greys run between them and near-black ink. Ink carries text, primary buttons and keyboard focus.

Signal orange is the only hue, reserved for a small dot that marks live activity and for the brand mark. It is never a button, link, text colour, fill, border or selection. States are told in greys by icon, word and weight: things that need a person are filled and medium weight, quiet states are outlined and muted. One restrained red appears only where a failure would otherwise be missed. Text meets WCAG AA contrast on every surface. Dark mode is intentionally undefined until the product needs it.

### Mark and wordmark

The lowercase **perpeto** wordmark and the eight-arm Spindle live in [identity/](identity/). In the product they appear in ink on paper; orange is for display-size brand moments. Use clearspace at least equal to one arm width on every side. The master Spindle muddies below 24 px; the simplified small variant in `packages/design-tokens/assets/proposed/` is not approved. Avoid infinity signs, robot faces, brains and dense node meshes.

### Interface character

Generous space does the separating: 48 px page padding, 28 px card padding, 20 px card radii, soft shadows instead of borders, pill buttons and 12 px controls. Each view has one black primary action. Show what is live, what needs a person and at most three numbers; secondary metrics, tables and older events wait behind a disclosure.

Primary navigation should reflect project work. Detailed events and logs belong near the work they explain, with deeper information available on demand. Running states should occupy reserved space so updates do not move controls. Prefer explicit status labels over animated activity. Motion is short, eased out, and disappears under reduced-motion preferences.

An empty state should offer one useful next action. An error should explain the affected operation and recovery path. Tables must remain usable at narrow widths through deliberate scrolling or alternate layouts, not illegible compression. The workflow map is a calm drawing: a barely visible dot grid, soft rounded nodes and thin grey edges, and on narrow screens a list of steps.

## Voice

Be direct, specific, and calm. Describe observable outcomes. Distinguish planned, running, blocked, failed, and verified work. Reserve “verified” for results supported by named checks; do not equate an agent finishing its turn with a completed project.

| Context | Example |
| --- | --- |
| Primary action | Create project |
| Empty project | Add a goal to start planning work. |
| Worker interruption | Worker disconnected. Its last reported progress is saved. |
| Verification failure | Build failed. Review the output before retrying. |
| Human decision needed | Approval needed to deploy this change. |

These are copy examples, not promises about implemented recovery behavior. Avoid claims such as “fully autonomous,” “self-healing,” and “production-ready” without clear scope and evidence.

## Next brand decisions

The product UI direction is decided. Still open: clearing the name, trademark and domain; approving or rejecting the small Spindle for favicons; and defining dark mode when the product needs it.
