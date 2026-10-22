# Perpeto for Apple platforms

Native SwiftUI client for the Perpeto hub: macOS 15 or later, and iPhone and iPad on iOS 18 or later. Status: early implementation. It reads a live local hub and falls back to demo fixtures. It follows the Perpeto Mono design system ([docs/architecture/design-system.md](../../docs/architecture/design-system.md)).

Screenshots: `screenshots/` (macOS, demo data, including settings, an empty state and an error), `screenshots/observe/` (the observe-only demo, light and dark), `screenshots/hub/` (macOS against a seeded local hub) and `screenshots/ios/` (iPhone 17 Pro and iPad Pro 13-inch simulators, demo data).

## Build and run

Requires Xcode 27 (Swift 6) on macOS.

```sh
cd apps/apple
swift build                  # PerpetoKit, PerpetoUI and the Perpeto executable
swift test                   # model, decoding, client, validation and demo-data tests
scripts/build-app.sh         # build/Perpeto.app, release, ad-hoc signed
open build/Perpeto.app
scripts/snapshots.sh         # rebuild screenshots/ from demo data
scripts/snapshots.sh --themes # screenshots/themes/: main screens in light and dark
scripts/snapshots.sh --pacing # screenshots/pacing/: Accounts and Pacing in light and dark
scripts/snapshots.sh --observe # screenshots/observe/: the observe-only demo in light and dark
```

iPhone and iPad:

```sh
xcodebuild -project iOS/Perpeto.xcodeproj -scheme Perpeto -destination 'generic/platform=iOS Simulator' build
NODE=review WIDE=1 scripts/ios-snapshots.sh <simulator-udid> ipad screenshots/ios [hub-url token-file]
```

`iOS/project.yml` is the XcodeGen spec; the generated `iOS/Perpeto.xcodeproj` is checked in, so building needs only Xcode. Run `xcodegen generate` in `iOS/` after editing the spec. Device signing is not configured.

Against a live hub (Node 24, from the repo root):

```sh
node apps/hub/bin/perpeto-hub.js --config <hub.json>     # see apps/hub/README.md
node apps/apple/scripts/seed-hub.mjs --url http://127.0.0.1:4320 --token-file .perpeto/hub/owner.secret
PERPETO_HUB_URL=http://127.0.0.1:4320 PERPETO_HUB_TOKEN_FILE=.perpeto/hub/owner.secret swift test --package-path apps/apple --filter LiveHubTests
apps/apple/scripts/snapshots.sh /tmp/shots http://127.0.0.1:4320 .perpeto/hub/owner.secret --live-check
```

The seed script uses only the public API: a project, the build template as the active workflow, an architect-drafted version 2, two simulated machines and a live run with a daily budget and a saturated reviewer (a bottleneck for the map to open on). It keeps the machines heartbeating until stopped (`--minutes`, default 20). The live tests read every route the app uses and run a human decision round trip; they create a small project on the hub.

SwiftPM builds the Mac app; the iOS app is the only Xcode project. Open `Package.swift` in Xcode to edit and debug. `build-app.sh` wraps the SwiftPM executable in an app bundle with an icon and `Info.plist`.

`snapshots.sh` launches the app with demo data and captures only its own window with `screencapture -l`. The terminal running it needs Screen Recording permission.

## Layout

| Target | Contents |
| --- | --- |
| `PerpetoKit` | Codable contract entities, workflow graph v1 with local validation and version diff, run metrics, Hub API v1 client with server-sent events, Keychain token store, demo fixtures, `FactoryStore`. Design tokens and the Spindle and wordmark geometry. |
| `PerpetoUI` | Screens and components for both platforms. Mac and iPad use a split view with the Mono sidebar; iPhone uses five tabs. Layouts stack when the detail column is narrower than 760 pt on the Mac or 900 pt on iOS, and the workflow map becomes a list of steps. |
| `PerpetoMac` | macOS app: window, menus, keyboard shortcuts, Settings. |
| `iOS/` | iPhone and iPad app target sharing PerpetoKit and PerpetoUI. |

`Sources/PerpetoKit/Design/PerpetoTokens.swift` is a verbatim copy of `packages/design-tokens/swift/PerpetoTokens.swift`, generated from `brand/tokens.css`. Do not edit it here; regenerate the package and copy it again. Colours, spacing, radii, elevation and motion come only from it, and the app uses none of its deprecated aliases. The shared components (cards, pill buttons, status labels, disclosures, the pill segmented control) are in `Sources/PerpetoUI/Components`. The logo shapes are parsed at runtime from the identity SVG path data in `LogoPathData.swift`.

## Appearance

Settings has an Appearance control: System (default), Light (pure white) or Dark (graphite). The choice is stored in UserDefaults under `perpeto.appearance`; on the Mac it also sets the app appearance so menus and windows match. Every token colour resolves per appearance, including the logo, which is drawn in `ink`. Pass `-perpeto.appearance light` or `dark` at launch to override it once (`APPEARANCE=dark scripts/snapshots.sh` does this).

## Subscriptions and pacing

Accounts lists each Claude and Codex subscription by provider, in rotation order: label, plan, machine, the session and weekly meters with their resets and the hub's projection at reset (the lighter extension and the small mark), and the pacing state. The pencil edits the label and plan (`PATCH /accounts/:id`). "Add subscription" explains how a login gets into a machine's account pool; the `perpeto` CLI has no command for that yet, and the sheet says so.

Pacing is its own Factory section: the headline sentence, what limits each provider, the rotation for the next ten hours (burn turns in ink, rest in grey, a line at now and the live dot on the subscription burning), the projection per subscription, and the settings (on or off, Rotation or Parallel, target use, and agent limits when the hub reports them; `PUT /pacing/settings`). It refreshes on `pacing.*` and `account.*` events. A hub without `GET /pacing` shows an explanation instead. The contract is new, so decoding is tolerant: optional fields, lenient numbers, and unknown enum values decode to a neutral case (`Models/Pacing.swift`). Demo data has five Claude subscriptions mid-rotation and two Codex ones (`Data/DemoPacing.swift`).

## Observe-only mode

When the hub reports no projects, the app is about the factory alone: each machine's node watches the owner's T3 Code app read-only and the hub aggregates. The sidebar shows Home and the Factory group (Sessions, Machines, Accounts, Pacing, Usage) and hides the project sections; iPhone tabs become Home, Sessions, Accounts, Usage and More. With projects, Sessions is the first Factory item and nothing else changes.

- **Sessions** (`GET /sessions`, `GET /sessions/summary`): running, waiting and tokens in the last hour, each machine (online, watching T3 Code, last seen), a status filter (All, Running, Waiting, Idle, and Errors when there are some) and a machine picker, then one card per machine. Rows are ordered waiting, running, failed, idle; waiting reads "Waiting for you" with the filled triangle in medium weight, and only running sessions carry the orange dot. Subagents nest under their parent behind a disclosure, open while one is working.
- **Home**: the advice line ("4 sessions running · Claude on track for 82% by reset, Codex for 61% · room for about 5 more agents"), what is running now, tokens over 24 hours, machines and subscriptions with their meters and resets.
- **Accounts and Pacing** read `source: "observed"` and `mode: "advise"`: no edit, add or settings controls, "Observed" with the room each subscription has (`headroomAgents`), and one line saying nothing is enforced. A pacing `mode` the app doesn't know is treated as advice too.
- **Usage** without projects shows tokens from the session summary per window (1 h, 24 h, 7 d) by provider, model and machine.

Decoding is tolerant (`Models/Sessions.swift`): only ids are required, numbers may be strings, unknown statuses decode to `unknown`, and a hub without the routes shows "This hub doesn't observe sessions yet". `session.*` and `sessions.*` events refresh the factory after the usual debounce. Without a hub, Settings › Demo data switches between the full factory and **Observe only** (also `-perpeto.demo observe` at launch; `Data/DemoObserve.swift`: this Mac and a Mac mini, 13 sessions, Claude Max and ChatGPT Pro).

## Hub connection

Open Settings (⌘,) on the Mac, or Settings in the sidebar footer or the More tab on iPhone and iPad, and enter the hub address and owner token. The address is stored in UserDefaults under `perpeto.hubURL`. The token is stored only in the Keychain (service `app.perpeto.hub`) and is sent only in the `Authorization` header. HTTPS is required except for localhost. Without both values the app shows demo data, marked in the sidebar footer and window subtitle.

A hub that serves HTTPS with its own self-signed certificate (`tlsEnabled`, see [apps/hub/README.md](../hub/README.md)) needs its **certificate fingerprint**: the SHA-256 that `perpeto hub init --tls` and `perpeto hub tls status` print (64 hex characters; colons, spaces, upper case and openssl's `sha256 Fingerprint=` form are accepted and normalised). Settings shows that command when the address is https and the field is empty. The fingerprint is not secret and is stored in UserDefaults under `perpeto.hubFingerprint`. Join codes (`pj1_`) are not accepted, because they carry an enrollment secret.

With a fingerprint, REST requests and the event stream run on their own ephemeral URLSession and trust exactly the certificate whose DER hashes to the pin, the same rule as a machine's node (`Hub/CertificatePinning.swift`); anything else fails with "The hub's certificate doesn't match the pinned fingerprint". Without one, the system validates the certificate as usual, and a self-signed hub fails with a hint to add the fingerprint. During a rotation (`perpeto hub tls rotate`), the app reads `GET /tls` over the pinned connection on each factory refresh, accepts the announced `next` certificate (stored under `perpeto.hubFingerprintNext`) and moves the pin to it once the hub serves it; a served certificate it doesn't already trust never changes the pin. Changing the fingerprint by hand drops a learned `next`.

To check pinning against a throwaway TLS hub (`tlsEnabled: true`):

```sh
PERPETO_TLS_HUB_URL=https://127.0.0.1:4399 PERPETO_TLS_HUB_FINGERPRINT=<fingerprint> PERPETO_TLS_HUB_TOKEN_FILE=<dir>/owner.secret \
  swift test --package-path apps/apple --filter LivePinnedHubTests   # add PERPETO_TLS_HUB_ALLOW_ROTATE=1 to also rotate the certificate
```

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| ⌘1 to ⌘6 | Overview, Workflows, Runs, Work, Messages, Merge queue |
| ⌥⌘0 | Home (the observe-only factory home) |
| ⌥⌘1 to ⌥⌘5 | Sessions, Machines, Accounts, Pacing, Usage |
| ⌘N | New workflow draft |
| ⌘R | Refresh |
| ⌘↩ | Draft workflow from the prompt; send a message |
| ⌘S | Save the hand-edited graph as a draft |
| ⌘Z ⇧⌘Z | Undo and redo in the graph editor |
| ⌘- ⌘= ⌘0 | Zoom out, zoom in, fit the graph |
| ⇧⌘P | Pause or resume the selected run |
| Delete | Remove the selected node or edge in the editor |
