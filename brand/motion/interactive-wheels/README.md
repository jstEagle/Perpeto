# Interactive wheels

[Open the playground](preview.html)

Rotation is explicitly authorized for this exploration. No extra visible shapes, rings, trails, or fill effects are added.

- Flywheel: tangential cursor velocity drives angular velocity; friction gradually stops it.
- Clutch: brush to spin, hold to brake.
- Handwheel: directly drag around the center, then release with momentum.
- Wind-up: drag to wind an angular spring, release to unwind.
- Turbine: faster spin separates the existing arms radially.
- Indexed Wheel: coasts, then settles into its original orientation.

`preview.html` and `interactions.js` form a standalone, dependency-free playground. Pointer input supports mouse, pen, and touch. Left/right arrows add spin (or wind the spring), Space brakes/releases, and Escape stops. Reset returns every mark home. Reduced motion disables movement. Spring simulation uses a capped timestep and bounded angular velocity.

The wheel couples its speed toward the cursor's tangential speed near the rim. Direction reverses with the brush direction. Radial movement through the center supplies little or no torque. This is a stylized interaction model, not a rigid-body physics simulation.

Brush and Pressure are saved separately in `../selected/interactive-brush-pressure/`.

## Shared home orientation

All six interactions now settle to a whole-turn multiple (360 degrees), preserving the exact original orientation of this traced, slightly asymmetric mark. A damped spring engages as coasting slows and snaps precisely home below a small tolerance. Wind-up returns to the nearest home orientation recorded when winding begins. Braking, keyboard stopping, and drag release also finish at home. Active dragging can hold the mark off-home until released.
