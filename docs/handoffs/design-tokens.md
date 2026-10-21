# Design tokens handoff

Added `packages/design-tokens`: a dependency-free generator that reads `brand/tokens.css` and `brand/identity/*.svg` and writes web tokens, SwiftUI tokens, recoloured marks, app icons, favicons and a component specimen. Component guidance is in [docs/design-system.md](../design-system.md).

## Consumer paths

- `packages/design-tokens/dist/tokens.css`: every brand variable with identical names and values, then `--text-12..32`, `--display-40..72`, `--leading-body` 1.55, `--leading-heading` 1.15, `--space-1..16` and the derived tokens below.
- `dist/tokens.json`, `dist/tokens.ts` (typed `tokens`, `color`, `cssVar()`, `space()`).
- `swift/PerpetoTokens.swift`: `PerpetoColor`, `PerpetoSpacing` (`unit`, `x(_:)`), `PerpetoRadius`, `PerpetoType` (sizes, `text`, `display`, `mono`, tracking and line-spacing helpers, `perpetoBody`/`perpetoDisplay` modifiers), plus `PerpetoStroke`, `PerpetoControl`, `PerpetoEditor`, `PerpetoMotion`.
- `assets/`: symbol, wordmark and lockup copies plus `-black`, `-ink`, `-paper`, `-orange`; `app-icon/` (iOS full-bleed and macOS grid, 1024 master and smaller sizes); `favicon/`; `proposed/`; `inspection/`.

Generated files are committed through a package `.gitignore` override of the root `dist/` rule.

## Derived tokens for the lead to promote or reject

Colours, all sRGB mixes of brand roles: `--action-hover`, `--action-pressed`, `--surface-hover`, `--canvas-strong`, `--accent-wash`, `--success-wash`, `--warning-wash`, `--error-wash`, `--grid-minor`, `--grid-major`.

Other: `--leading-display` 1.05, `--leading-compact` 1.3, `--weight-*`, `--tracking-heading` −0.01em, `--tracking-display` −0.03em, `--control-height-sm/md/lg` 28/32/40, `--stroke-hairline/edge/selection`, `--focus-width`, `--focus-offset`, `--editor-grid-minor/major` 16/64, `--editor-port` 8, `--editor-node-width` 240, `--duration-fast/base` (0 under reduced motion), `--ease-standard`, `--shadow-overlay`.

No dark ink surface set was added. brand.md leaves dark mode undefined, and the editor is specified on paper.

## Verification

- `npm test` in the package: 9 node:test cases pass. They cover outputs matching a fresh build (pixel-compared for PNGs), brand variable parity, scales, JSON/TS parity, the Swift API, WCAG contrast for 21 text pairs (4.5:1) and 6 non-text pairs (3:1), unchanged SVG path data, icon sizes and specimen bans (no external resources, uppercase, tracking or gradients). A deliberately stale `tokens.css` made the parity test fail.
- `swiftc -typecheck` passed for macOS 14 and the iOS 17 simulator.
- The specimen was screenshotted in headless Chrome at 1440 px and in a 390 px frame and inspected. No horizontal overflow at 390 except the deliberate table and editor scroll.
- The Spindle was rendered and inspected at 16, 24 and 32 px; see `assets/README.md`.

## Open questions for Justus

1. **Small Spindle.** The master is muddy at 16 px. `assets/proposed/` has a simplified eight-arm variant for use below 24 px only. Favicons ship with the master until you decide.
2. **App icon.** Ink tile with paper mark, following the existing badge treatment. Signal-orange tile is the alternative.
3. **Running colour.** Signal orange icon with ink text, or `action` text in badges, matching the boards. This makes orange mean both "brand/primary" and "running".
