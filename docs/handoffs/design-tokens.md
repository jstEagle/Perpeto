# Design tokens handoff

`packages/design-tokens` is a dependency-free generator that reads `brand/tokens.css` and `brand/identity/*.svg` and writes web tokens, SwiftUI tokens, recoloured marks, app icons, favicons and a component specimen. On 2026-10-21 it moved from the Workshop proposal to **Perpeto Mono**, the product UI direction Justus selected after calling the current clients cluttered. Component rules are in [docs/architecture/design-system.md](../architecture/design-system.md).

## What changed

- `brand/tokens.css` is the Perpeto Mono source of truth: canvas `#f6f5f2`, surface white, `surface-subtle`, `grey-100` to `grey-600`, ink `#161615`, roles as `var()` references, signal orange `#f05a28` for the live dot and brand only, one red `#b3372c` for failure. It also holds the layout defaults (page 48/24, card 28/20, section gap 40, content max 1120, sidebar 248), radii (8, 12, 16, 20, 28, pill), three soft shadows and motion (140/220/360 ms, `ease-standard`, `ease-out`).
- `src/scale.json`: text 12, 13, 14, 16, 20, 24, 28, 32; display 40 to 72; weights regular, medium, semibold; space steps to 24 (96); controls 32/40/48; icon sizes; indicator dot; editor dot grid, node and edge geometry; derived states, editor and chart colours; contrast pairs.
- The generator resolves `var()` chains, groups layout, radius, shadow and motion tokens, and marks legacy aliases. Swift gains `PerpetoLayout`, `PerpetoElevation` (ring plus shadow layers), `PerpetoIcon`, `PerpetoIndicator`, motion curves that return `nil` under Reduce Motion, `PerpetoType.title()`, and the `perpetoCard`, `perpetoElevation` and `perpetoTitle` modifiers. Display type is semibold.
- The specimen was rebuilt around Perpeto Mono and includes two mock screens, project overview and run live map, at desktop and mobile. Screens are partials in `src/screens/`, inserted by the build. `specimen.html#<frame-id>` shows one frame alone for screenshots.
- `scripts/screenshot.mjs` writes `screenshots/` with Playwright when available, otherwise headless Chrome at fixed sizes.

## Screenshots

- [specimen-desktop.png](../../packages/design-tokens/screenshots/specimen-desktop.png)
- [overview-desktop.png](../../packages/design-tokens/screenshots/overview-desktop.png), [overview-mobile.png](../../packages/design-tokens/screenshots/overview-mobile.png)
- [run-desktop.png](../../packages/design-tokens/screenshots/run-desktop.png), [run-mobile.png](../../packages/design-tokens/screenshots/run-mobile.png)

## Compatibility for the restyle

Every token name the web and Apple clients use today still exists, so both keep building before they are restyled; they will simply pick up the new values (black primary buttons, grey status colours, larger radii).

- Legacy aliases, to remove after the restyle: `success-wash`, `warning-wash` (now `surface-subtle`), `grid-minor`, `grid-major` (now `editor-dot`), and Swift `PerpetoEditor.gridMinor`/`gridMajor` (kept at 16 and 64 so existing snapping doesn't move). They are `@available(*, deprecated)` in Swift and annotated in the CSS.
- `--weight-bold` is gone; nothing in `apps/` used it. `PerpetoType.mono()` now defaults to 13.
- The Apple app's copy in `apps/apple/Sources/PerpetoKit/Design/PerpetoTokens.swift` was not updated (outside this scope). A temporary copy of `apps/apple` with the new file built with `swift build`; the only new diagnostics are the deprecation warnings in `GraphCanvas.swift` and `GraphLayout.swift`, which mark exactly the line-grid code the restyle replaces.
- `brand/preview.html` reads `brand/tokens.css` directly, so its Workshop concept now renders with Perpeto Mono values.

## Verification

- `npm test`: 11 node:test cases pass. They cover outputs matching a fresh build (PNG pixels compared), brand variable parity, scales, layout and radius ranges, soft shadows, the accent being reserved (no role reuses it, every other brand colour is neutral apart from the red), JSON/TS parity, the Swift API including the names the Apple app uses, WCAG contrast for 20 text pairs (4.5:1) and 13 non-text pairs (3:1), unchanged SVG path data, icon sizes, and specimen bans (external resources, uppercase, tracking, gradients, unreplaced markers). Pointing `--action` at the accent made three tests fail, as intended.
- `swiftc -typecheck -swift-version 6` passed for macOS 14 and the iOS 17 simulator.
- The specimen and the four mock frames were screenshotted in headless Chromium and Chrome and reviewed against the Monochrome Orange board over several iterations. No horizontal overflow at 1440 or 390 outside the deliberate map and table scroll.
- Not verified: the specimen's `::details-content` expand animation needs Chrome 131 or later and degrades to an instant toggle elsewhere; nothing was checked in Safari or Firefox.

## Follow-ups outside this scope

- Restyle `apps/web` and `apps/apple` to the component specs, then remove the legacy aliases.
- These files still describe Workshop and need a wording pass: `README.md` (brand paragraph), `docs/README.md` (design system row, still "Proposed"), `docs/architecture/README.md` (client design paragraph), `docs/handoffs/apple-app.md` and `docs/handoffs/messaging-ui.md`.

## Open questions for Justus

1. **Input borders.** Fields use a 3:1 grey border so they stay identifiable under WCAG 1.4.11. A softer hairline would look calmer but fail that check. Kept the accessible version.
2. **Small Spindle.** Still a proposal in `assets/proposed/`; favicons ship with the master.
3. **Dark mode.** Still undefined. The tokens are structured as roles, so a dark set can be added later without renaming.
