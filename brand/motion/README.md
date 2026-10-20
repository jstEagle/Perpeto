# Perpeto motion

Six loading animations and six static treatments, using the approved eight-arm Spindle SVG without changing its paths.

**Selected directions:** [Flywheel, Relay, Assembly, and Ratchet](selected/README.md), saved together in `selected/` on 2026-10-17.

Open `preview.html` in a browser to compare all six. Controls toggle playback and background, adjust size (32–160 px) and speed. Each card downloads a standalone SVG.

| Loader | Motion | Cycle |
| --- | --- | --- |
| `loaders/spin.svg` | Flywheel: continuous rotation | 2.4 s |
| `loaders/index.svg` | Index: eight mechanical steps | 3.2 s |
| `loaders/pulse.svg` | Relay: traveling opacity pulse | 1.6 s |
| `loaders/assemble.svg` | Assembly: staggered separation and return | 3.2 s |
| `loaders/breathe.svg` | Breath: subtle radial expansion | 2.8 s |
| `loaders/reverse.svg` | Ratchet: advance, backstep, complete | 3.6 s |

## Use

```html
<img src="brand/motion/loaders/pulse.svg" width="32" height="32" alt="Loading">
```

All loaders are transparent, self-contained SVGs with CSS animation. No runtime library is required. They are indeterminate indicators, not progress measurements. Every loader respects `prefers-reduced-motion` by displaying the complete static mark.

For custom colors, inline the SVG and set `--logo-color` on it. Host-page CSS cannot recolor an SVG loaded through an `img` element. For accessible loading UI, put a brief status message in a `role="status"` element and make a duplicate decorative icon `aria-hidden="true"`.

## Static treatments

`variants/` contains Ink, White, Signal orange, Outline, Badge, and Signal Badge. The White version is intended for dark backgrounds. The original master remains at `../logo/perpeto-spindle.svg`.

## Timeline companion

`studio/` contains a silent, twelve-second HyperFrames comparison composition. It uses finite CSS animations for timeline seeking. Run `npm run check` or `npm run dev -- --background` inside that directory. A video export is not required to use any of the web assets.
