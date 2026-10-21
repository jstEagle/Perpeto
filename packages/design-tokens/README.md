# Design tokens

The only place the Perpeto clients read colours, type, spacing, radii, elevation, motion and identity assets from. Everything here is generated from [brand/tokens.css](../../brand/tokens.css) and [brand/identity](../../brand/identity/) by a dependency-free Node script. The system is Perpeto Mono, the product UI direction selected on 2026-10-21; see [brand/README.md](../../brand/README.md) and [docs/architecture/design-system.md](../../docs/architecture/design-system.md).

```sh
npm run build        # regenerate dist/, swift/, assets/ and specimen.html
npm test             # outputs match the source, contrast, ranges, accent use, Swift API
npm run screenshot   # specimen and mock screens into screenshots/ (Playwright or local Chrome)
```

| Output | For |
| --- | --- |
| `dist/tokens.css` | Web. All brand variables with identical names and values (including `var()` references), then derived scales and states. Durations drop to 0 under reduced motion. |
| `dist/tokens.json` | Tools and native code generation. Resolved hex values, aliases, legacy names and computed contrast ratios. |
| `dist/tokens.ts` | Typed web import: `tokens`, `color`, `cssVar()`, `space()`. |
| `swift/PerpetoTokens.swift` | SwiftUI, macOS and iOS: `PerpetoColor`, `PerpetoSpacing`, `PerpetoLayout`, `PerpetoRadius`, `PerpetoElevation`, `PerpetoType`, `PerpetoStroke`, `PerpetoControl`, `PerpetoIcon`, `PerpetoIndicator`, `PerpetoEditor`, `PerpetoMotion`, and the `perpetoCard`, `perpetoElevation`, `perpetoTitle`, `perpetoDisplay`, `perpetoBody` modifiers. |
| `assets/` | Spindle, wordmark and lockup in black, ink, paper and orange; app icons; favicons. See [assets/README.md](assets/README.md). |
| `specimen.html` | Self-contained specimen of every token and component, plus the project overview and run live map mocks at desktop and mobile. `specimen.html#run-desktop` (or `overview-desktop`, `overview-mobile`, `run-mobile`) shows one mock alone. |
| `screenshots/` | Committed renders of the specimen and the four mock frames. |

The Apple client keeps a verbatim copy of `swift/PerpetoTokens.swift` in `apps/apple/Sources/PerpetoKit/Design/`; copy it again after a change.

## Changing values

Decisions change only in `brand/tokens.css`: colours, fonts, layout defaults, radii, shadows and motion. Colour roles may reference other colours with `var(--name)`. Derived scales, state mixes, aliases and the contrast pairs the build checks live in [src/scale.json](src/scale.json). Derived colours are sRGB mixes or aliases of brand colours, never new hues. Mock screens live in `src/screens/` and use only the specimen's component classes and tokens. Generated files are committed so clients need no build step; the tests fail if they drift from their sources.

Names marked `legacy` in `src/scale.json` exist only so today's clients keep building; they are deprecated in Swift and annotated in the CSS. Remove them once the clients are restyled.

The SVG rasterizer in `scripts/lib/raster.mjs` handles only the path, rect and transform subset used by the identity files.
