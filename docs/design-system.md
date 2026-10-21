# Perpeto design system

Status: proposed. This applies the Workshop direction from [brand.md](../brand.md) to the web and Apple clients. Values come only from [`packages/design-tokens`](../packages/design-tokens/README.md), which is generated from [brand/tokens.css](../brand/tokens.css). The [specimen](../packages/design-tokens/specimen.html) renders every component described here.

Workshop in one line: warm paper canvas, white work surfaces, ink text, signal orange for the brand and primary actions, system sans, ruled and precise.

## Using tokens

| Concern | Web | SwiftUI |
| --- | --- | --- |
| Colour | `var(--ink)`, `var(--accent-wash)` | `PerpetoColor.ink`, `PerpetoColor.accentWash` |
| Spacing, 4 px base | `var(--space-4)` (16 px) | `PerpetoSpacing.x(4)` |
| Radius | `var(--radius-control)` 6, `var(--radius-panel)` 12 | `PerpetoRadius.control`, `.panel` |
| Interface type | `var(--text-14)` with `var(--leading-body)` | `PerpetoType.text(PerpetoType.text14)`, `.perpetoBody()` |
| Display type | `var(--display-56)`, `var(--tracking-display)` | `.perpetoDisplay(PerpetoType.display56)` |
| Mono | `var(--font-mono)` | `PerpetoType.mono()` |
| Control height | `var(--control-height-md)` 32 | `PerpetoControl.height` |
| Strokes and focus | `var(--stroke-hairline)`, `var(--focus-width)`, `var(--focus-offset)` | `PerpetoStroke.*` |
| Motion | `var(--duration-fast)`, `var(--ease-standard)` | `PerpetoMotion.duration(_:reduceMotion:)` |

Never write a hex value, pixel size or font name in a client. If a value is missing, add it to `packages/design-tokens/src/scale.json` as a mix or step of existing tokens.

## Layout

- Paper (`canvas`) is the page. White (`surface`) carries editable work: panels, tables, forms, editor nodes.
- Separate regions with one hairline rule in `border`. Use `control-border` only for things you can click or type into.
- Spacing comes from the 4 px scale. Common rhythm: 8 inside controls, 12 to 16 inside panels, 24 between panels, 48 between page sections.
- Reserve space for anything that updates (running counts, status, timers) so controls never shift.
- Shadows: none on resting surfaces. `shadow-overlay` is only for menus, popovers, the editor toolbar and a node being dragged.

## Typography

- System sans for interface and display. Mono only for identifiers, paths, timestamps, logs and code.
- Interface scale: 12, 14, 16, 20, 24, 32. Body text is 14 in the app, 16 for reading. Line height 1.55 for body, 1.15 for headings.
- Display: 40 to 72, bold, line height 1.05, tracking −0.03em. Marketing and empty landing moments only, not in dense product views.
- Weights: regular for text, medium for labels and emphasis, bold for headings.
- Sentence case everywhere: titles, buttons, table headers, navigation.
- Titles stand on their own. No numbered eyebrows, indexed labels or tiny tracked-out kickers. If a section needs context, put it in the title.

## Colour

- Text is `ink` or `muted`. Both pass 4.5:1 on canvas, surface and the derived hover fills.
- `accent` (signal orange) is decorative: brand marks, selection outlines, running icons, the orange period. Never text on white.
- `action` is for filled primary buttons with `on-action` text, and for running badge text.
- Status colours (`success`, `warning`, `error`) always come with an icon and a word. Their `-wash` tints are backgrounds for badges and banners.
- `focus` blue is reserved for keyboard focus. Don't use it for links or selection.
- Dark mode is undefined. Ink surfaces exist only as brand tiles (app icon, reversed marks).

The build checks every text pair at 4.5:1 and every icon or boundary pair at 3:1; the ratios are in `dist/tokens.json` and the specimen.

## Buttons

| Kind | Fill | Text | Border | Use |
| --- | --- | --- | --- | --- |
| Primary | `action`, hover `action-hover`, pressed `action-pressed` | `on-action` | none | One per view: the main next step |
| Secondary | `surface`, hover `surface-hover` | `ink` | `control-border` | Other actions |
| Ghost | transparent, hover `canvas-strong` | `ink` | none | Cancel, toolbars, row actions |
| Danger | `surface`, hover `error-wash` | `error` | `control-border` | Stop, delete. Confirm destructive actions |
| Disabled | `canvas-strong` | `muted` | none | Explain why nearby when it isn't obvious |

- Heights 28, 32 (default), 40. Radius `radius-control`. Horizontal padding 12 (8 small, 16 large).
- Labels are verbs in sentence case: "Create project", "Retry build". Icons are optional, 16 px, leading.
- Icon-only buttons are square at the control height and need an accessible label.
- Focus: 2 px `focus` outline, 2 px offset, on every interactive element. Never remove it.

## Inputs

- 32 high, `surface` fill, 1 px `control-border`, `radius-control`, 12 px padding.
- Label above in medium weight; help text below in 12 `muted`. Placeholder is an example, never the label.
- Mono for paths, branches, URLs and identifiers.
- Error: border becomes `error`, and a 12 px message with the failed icon says what's wrong and how to fix it. Link it with `aria-describedby`.
- Focus uses the same blue outline with offset.

## Status labels

Every status is an icon plus a word. Colour only reinforces.

| Status | Icon | Icon colour | Meaning |
| --- | --- | --- | --- |
| Planned | open circle | `muted` | Accepted, not started |
| Running | half-filled circle | `accent` | Work in progress |
| Blocked | circle with bar | `warning` | Waiting on another item |
| Approval needed | triangle with mark | `warning` | A person must decide |
| Failed | circle with cross | `error` | Name the operation and recovery |
| Verified | circle with check | `success` | Only when named checks passed |

- Inline form: 16 px icon, 4 px gap, `ink` text. Use in tables and lists.
- Badge form: 24 high, 8 px padding, `radius-control`, `-wash` background with the status colour as text (`canvas-strong` and `ink` for planned, `accent-wash` and `action` for running). Use where a status needs to stand out, such as headers.
- Running is static. Don't put spinners or pulsing dots in rows. "Verified" means checks passed, not that an agent finished its turn.

## Tables

- `surface` panel with `radius-panel`, hairline row rules, no zebra stripes, no vertical rules.
- Headers: 12 px medium `muted`, sentence case.
- Rows: 12 px vertical padding, 16 px horizontal. Hover `surface-hover`. Selected: `accent-wash` with a 2 px `accent` bar on the leading edge.
- Tabular numbers. Mono for IDs, machines, times and durations; numbers right-aligned.
- Stable column widths. On narrow screens the table scrolls horizontally inside its panel, or switches to a stacked list. Never compress it until it's illegible.

## Panels

- `surface`, 1 px `border`, `radius-panel`. Header row 12 by 16 padding with a 14 px medium title and a hairline below.
- Panels sit on canvas with 24 px gaps. Don't nest panels inside panels; use rules.
- Events and logs live next to the work they explain, collapsed to the latest few with the rest on demand.

## Navigation

- Left sidebar on `canvas`, 232 wide, with a hairline divider. The lockup sits at the top, 20 px tall.
- Groups follow the architecture: Projects → project (Overview, Workflows, Runs, Work, Messages, Merge queue) and Factory (Machines, Accounts, Usage). Group titles are 12 px `muted`, sentence case.
- Items are 32 high, `radius-control`. Hover `canvas-strong`. Current page: `surface` fill with a hairline ring and medium weight.
- Counts are mono 12 `muted` and right-aligned. Agent and usage counts stay visible in the project bar.
- On iOS and narrow web, the sidebar becomes a list or tab structure with the same order and names.

## Empty and error states

- Empty: one sentence on what goes here and one primary action. "Add a goal to start planning work." with "Add goal". No illustrations, no oversized logo.
- Error: failed icon, the affected operation as the title ("Build failed"), what happened in one or two sentences, the relevant log lines in mono on `canvas`, and the recovery action. Use `role="alert"` on web.
- Interruptions say what's saved: "Worker disconnected. Its last reported progress is saved."

## Loading and motion

- Prefer explicit status text to animation. Page-level loading may use a Spindle loader from `brand/motion/selected/` at 32 px or more, with the text in a `role="status"` element and the loader hidden from assistive technology.
- Durations: `duration-fast` (120 ms) for hover and press, `duration-base` (200 ms) for panels and popovers, `ease-standard`. Both drop to 0 under reduced motion. On Apple, pass `accessibilityReduceMotion` to `PerpetoMotion.duration`.

## Workflow editor

The one place nodes and edges appear. It should look like a precise ruled drawing, not a network graph.

- **Canvas**: `canvas` fill, 1 px rulings every 16 px in `grid-minor`, every 64 px in `grid-major`. Lines, not dots. The canvas pans; on narrow screens it scrolls instead of scaling nodes down.
- **Nodes**: `surface`, 1 px `control-border`, `radius-control`, 240 wide (`editor-node-width`), positions and sizes snapped to the 16 px grid. A 40 px header holds a 16 px step icon, the step name in 14 medium and the step kind in mono 12 `muted`. The body shows the agent and an inline status label.
- **Ports**: 8 px squares (`editor-port`) centred on the node edge, on a grid line. Open: `surface` with a 1.5 px `control-border` outline. Connected: solid `ink`. Valid drop target while dragging: solid `accent`. Inputs on the left, outputs on the right.
- **Edges**: 1.5 px (`stroke-edge`), orthogonal, routed along grid lines with 6 px rounded elbows. `ink` once data has passed; `control-border` dashed for paths not yet reached. No arrowheads; direction is left to right, ports show it. No glow or animated dashes.
- **Selection**: `accent`, 2 px (`stroke-selection`) on nodes and edges. Multi-select uses the same treatment.
- **Focus**: keyboard focus is the blue `focus` outline with offset, separate from selection, so a focused node can also be selected. Every node, port and edge is reachable by keyboard.
- **Toolbar**: a small `surface` strip with `shadow-overlay`, ghost buttons, zoom as mono 12 `muted`.
- **Status**: running and failed steps show an inline status label in the node body. Don't colour the whole node.

## Marks in the product

- Use the lockup or symbol from `packages/design-tokens/assets`, never redrawn or approximated. Ink on light, paper on ink, orange only at display sizes.
- Keep clearspace of one arm width on every side. Don't rotate, outline, add effects or animate the static mark outside the selected motion studies.
- Below 24 px the master Spindle muddies. A simplified small variant is proposed but not approved; see [assets/README.md](../packages/design-tokens/assets/README.md).

## Do

- Use paper for the page and white for work.
- Use one orange primary action per view.
- Pair every status colour with an icon and a word.
- Write sentence-case, verb-first labels and specific copy.
- Keep columns stable and numbers tabular.
- Put logs and events next to the work they explain.
- Keep visible focus, reduced-motion support and 4.5:1 text contrast.

## Don't

- Uppercase microcopy, numbered eyebrows or tracked-out section kickers.
- Gradients, glows, glass or decorative shadows.
- Robots, brains, infinity signs, sparkles or decorative node meshes.
- Orange text on white, or blue for anything except focus.
- Floating dashboards of decorative metrics.
- Spinners in rows, or "verified" for work no named check confirmed.
- Ad-hoc colours, sizes or fonts outside the tokens.
