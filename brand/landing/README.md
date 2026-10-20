# Perpeto landing concepts

Status: exploration.

- `index.html`: the current single page. Pure white, a metallic rich black (cool dark gray with a brushed sheen) for buttons, the app window and dark panels, Plus Jakarta Sans titles and Inter UI text. Monochrome; only status states (verified, waiting, failed) carry color. `stage.js` animates the hero: the mockup replays a 25-second scripted run (request, plan, workers, a dropped machine and handoff, checks, change ready for review), and on wide screens the photo tiles orbit the window, sharpening as they swing to the sides and blurring as they pass behind. Reduced motion shows a still frame.
- `experiments.html`: a texture lab on top of the single page. Every effect starts off; the panel turns each one on separately and picks its style: grain (fine, coarse, paper, scratch; page, dark panels or both; amount; still or jitter), dithered photos (Atkinson, Floyd–Steinberg, Bayer, halftone; 2 or 4 tones; pixel size), dithered dark panels (Bayer, dots, lines), and ASCII (a rotating text-mode Spindle in four character sets and three tones, an animated factory floor, scrambled headings). Settings persist in the browser.
- `directions.html`: the earlier comparison of four brand directions, laid out after a reference product hero (nav, two-line headline, pill actions, app window with a floating detail card, photo collage). Nothing here is an approved direction, and the product UI shown is a concept, not a shipped feature.

Serve the repository root and open `brand/landing/` (relative links point at the repo docs):

```bash
python3 -m http.server 4317
```

Then visit `http://localhost:4317/brand/landing/`. On `directions.html`, the bar at the bottom switches direction and title typeface; `#paper`, `#cobalt`, `#industrial` and `#grid` link to each one.

| Direction | Based on | Title face | Accent |
| --- | --- | --- | --- |
| Paper | Monochrome Orange | Geist | `#f26b21` |
| Cobalt | Monochrome Blue | Plus Jakarta Sans | `#2864f0` |
| Industrial | Industrial Guidelines | Archivo | `#f05a28`, dark app window |
| Grid | Modular Grid | Instrument Sans | `#637e98`, grid and ASCII decor |

UI text is Inter (variable, optical sizing). The title menu also offers Inter Tight, Host Grotesk and Inter Display for comparison. Fonts load from Google Fonts.

## Assets

- `marks.js`: the Spindle arm paths and wordmark path, copied unchanged from `../logo/perpeto-spindle.svg` and `../identity/perpeto-wordmark.svg`.
- Loaders use `../motion/motion.css` (Flywheel, Relay, Assembly, Ratchet, Breath). The nav mark plays Ratchet on hover. The large mark is a pointer-driven flywheel that settles back to its home orientation; reduced motion disables it.
- `assets/*.jpg`: crops of the favorite boards in `../overviews/favorites/` for the collage. They are generated images and stay illustrative.
