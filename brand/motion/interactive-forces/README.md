# Interactive forces

[Open the playground](preview.html)

Six candidates inspired by Force Field and Tension:

- Brush: cursor movement applies local impulses.
- Pluck: drag the nearest arm independently.
- Elastic Web: drag one arm with decreasing influence on its neighbors.
- Pressure: hold to increase local repulsion.
- Squeeze: drag an opposing pair inward or outward.
- Wake: cursor movement leaves slower spring recovery.

Only existing arms translate. No rotation, flipping, ink filling, added shapes, or opacity pulses.

Keep `preview.html` and `interactions.js` together. There are no runtime dependencies. Pointer capture handles drag release and cancellation. Arrow keys provide directional input; Space activates, Escape releases. Reset clears all movement. Reduced motion honors the system preference and can be toggled in the preview.

The earlier selected Force Field and Tension behaviors are preserved as a working snapshot in `../selected/interactive/`.
