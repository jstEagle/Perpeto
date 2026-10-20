# Interactive Perpeto motion

[Open the playground](preview.html)

- **Magnetic Field:** cursor attraction.
- **Force Field:** proximity-based repulsion of individual arms.
- **Contact:** staggered recoil on pointer entry.
- **Trigger:** click or tap to release a mechanical kick.
- **Tension:** drag to stretch arms along their existing radial directions.
- **Pick Up:** drag the complete mark; release for staggered spring docking.

The original paths are preserved. Only translation changes: no rotation, flips, extra shapes, filling, or opacity pulses.

## Use

Serve or open `preview.html` alongside `interactions.js`. No dependencies or build step. These are interactive HTML/JavaScript behaviors, rather than autonomous animated SVG downloads. Reuse an individual `.card` and the script; each card selects its behavior through `data-mode`.

Pointer events handle mouse, pen, and touch. Drag panels capture the active pointer and release on pointer-up, cancellation, or lost capture. Tab focuses each panel; arrow keys apply directional input, Space activates, and Escape releases. A reduced-motion toggle follows the system preference initially and disables displacement. Reset returns all arms to their exact home positions.

Spring tuning and interaction limits live in `interactions.js`. The render loop uses a capped timestep after inactive tabs. This is a design exploration, not a progress indicator tied to application state.
