# Design tokens

The only place the Perpeto clients read colours, type, spacing, radii and identity assets from. Everything here is generated from [brand/tokens.css](../../brand/tokens.css) and [brand/identity](../../brand/identity/) by a dependency-free Node script. The Workshop direction is still a proposal; see [brand.md](../../brand.md).

```sh
npm run build        # regenerate dist/, swift/, assets/ and specimen.html
npm test             # outputs match the source, contrast, geometry, sizes
npm run screenshot   # optional: specimen screenshot with local Chrome
```

| Output | For |
| --- | --- |
| `dist/tokens.css` | Web. All brand variables with identical names and values, then derived scales and states. |
| `dist/tokens.json` | Tools and native code generation. Includes computed contrast ratios. |
| `dist/tokens.ts` | Typed web import: `tokens`, `color`, `cssVar()`, `space()`. |
| `swift/PerpetoTokens.swift` | SwiftUI, macOS and iOS: `PerpetoColor`, `PerpetoSpacing`, `PerpetoRadius`, `PerpetoType`, `PerpetoStroke`, `PerpetoControl`, `PerpetoEditor`, `PerpetoMotion`. |
| `assets/` | Spindle, wordmark and lockup in black, ink, paper and orange; app icons; favicons. See [assets/README.md](assets/README.md). |
| `specimen.html` | Self-contained specimen of tokens and components. |

Component guidance lives in [docs/design-system.md](../../docs/design-system.md).

## Changing values

Brand values change only in `brand/tokens.css`. Derived scales, state mixes and the contrast pairs the build checks live in [src/scale.json](src/scale.json). Derived colours are sRGB mixes of brand roles, never new hues. Generated files are committed so clients need no build step; the tests fail if they drift from their sources.

The SVG rasterizer in `scripts/lib/raster.mjs` handles only the path, rect and transform subset used by the identity files.
