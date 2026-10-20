# Perpeto brand direction

Status: proposed. Perpeto is the working name inherited from this repository. No naming, trademark, or domain clearance has been performed.

## The idea

A software factory should feel deliberate, understandable, and capable of sustained work. Perpeto's identity should make complex coordination feel orderly without implying that autonomous work is infallible.

**Descriptor:** The open-source software factory for coordinated agents.

**Short line:** Intent into working software.

**One sentence:** Perpeto brings project goals, requirements, context, and feedback together to coordinate autonomous agents across machines.

The descriptor and sentence describe the intended product. Until it exists, public copy must make the project's design-stage status visible.

## Three directions

| Direction | Character | Visual language | Tradeoff |
| --- | --- | --- | --- |
| **Workshop — recommended** | Precise, grounded, approachable | Warm paper, ink, signal orange; strong type; ruled work surfaces | Needs disciplined spacing to avoid becoming generic developer tooling |
| **Current** | Continuous, distributed, calm | Deep blue, pale blue, electric blue; connected paths; open layouts | Networking imagery can overwhelm the software-building story |
| **Commons** | Open, collaborative, durable | Cream, forest green, restrained serif headlines; editorial layouts | Less immediately associated with agent orchestration |

See [the visual exploration](brand/preview.html). It compares concepts; it does not imply approval of any direction.

## Workshop visual system

The initial [CSS tokens](brand/tokens.css) are the canonical color, spacing, radius, and typography values for this proposal. The preview uses them directly. Alternatives are scoped within the preview and are not implementation themes.

### Typography

Use the system sans-serif stack for interface and display text; use the system monospace stack only for identifiers, paths, timestamps, and logs. This keeps the initial assets portable and avoids font downloads.

Display type is bold, tightly spaced, and sentence case. Interface type is regular or medium. Body text uses a 1.55 line height; headings use 1.05–1.2. The interface scale is 12, 14, 16, 20, 24, and 32 px. Large brand headlines may scale from 40 to 72 px. Do not use uppercase microcopy, numbered eyebrows, or tracked-out section kickers.

### Color and semantics

Warm paper is the default canvas; white surfaces carry editable work. Ink carries primary text, and muted ink carries secondary text. Orange identifies the brand and primary actions. Status colors have separate success, warning, and error roles; always pair them with a readable label or icon.

Use the darker action token for filled buttons with white text. The brighter orange is decorative, not a text color on white. The stronger border token is for interactive boundaries; the subtle border token is for nonessential separators. Focus uses a blue outline with an offset. Dark mode is intentionally undefined until the product needs it.

### Mark and wordmark

Start with a lowercase **perpeto** wordmark in a bold sans-serif. Explore a compact symbol made from two offset, interlocking right-angle forms: separate work units forming one system. Avoid infinity signs, robot faces, brains, and dense node meshes.

This is a logo brief, not a finished logo. Before adoption, test black, white, and orange variants at 16, 24, and 32 px, alongside the wordmark and on their own. Use clearspace at least equal to one symbol stroke on every side. Do not ship an untested symbol as a favicon.

### Interface character

Favor compact navigation, readable tables, stable columns, restrained borders, and clear ownership. Use a 4 px spacing base, 6 px control radii, and 12 px panel radii. Avoid floating dashboards full of decorative metrics.

Primary navigation should reflect project work. Detailed events and logs belong near the work they explain, with deeper information available on demand. Running states should occupy reserved space so updates do not move controls. Prefer explicit status labels over animated activity. Motion, when useful, should be brief and respect reduced-motion preferences.

An empty state should offer one useful next action. An error should explain the affected operation and recovery path. Tables must remain usable at narrow widths through deliberate scrolling or alternate layouts, not illegible compression.

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

## Next brand decision

Choose a direction before developing a final mark, custom typography, or a full product interface. Workshop is the recommendation because it connects the factory idea to clear, useful tools without relying on familiar AI imagery.
