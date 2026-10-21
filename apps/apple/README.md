# Perpeto for Apple platforms

Native SwiftUI client for the Perpeto hub: macOS 15 or later, and iPhone and iPad on iOS 18 or later. Status: early implementation. It reads a live local hub and falls back to demo fixtures. The visual style is about to be replaced by a new design system; screenshots show the current, provisional look.

## Build and run

Requires Xcode 27 (Swift 6) on macOS.

```sh
cd apps/apple
swift build                  # PerpetoKit, PerpetoUI and the Perpeto executable
swift test                   # model, decoding, client, validation and demo-data tests
scripts/build-app.sh         # build/Perpeto.app, release, ad-hoc signed
open build/Perpeto.app
scripts/snapshots.sh         # rebuild screenshots/ from demo data
```

iPhone and iPad:

```sh
xcodebuild -project iOS/Perpeto.xcodeproj -scheme Perpeto -destination 'generic/platform=iOS Simulator' build
NODE=builder WIDE=1 scripts/ios-snapshots.sh <simulator-udid> ipad screenshots/ios [hub-url token-file]
```

`iOS/project.yml` is the XcodeGen spec; the generated `iOS/Perpeto.xcodeproj` is checked in, so building needs only Xcode. Run `xcodegen generate` in `iOS/` after editing the spec. Device signing is not configured.

Against a live hub (Node 24, from the repo root):

```sh
node apps/hub/bin/perpeto-hub.js --config <hub.json>     # see apps/hub/README.md
node apps/apple/scripts/seed-hub.mjs --url http://127.0.0.1:4320 --token-file .perpeto/hub/owner.secret
PERPETO_HUB_URL=http://127.0.0.1:4320 PERPETO_HUB_TOKEN_FILE=.perpeto/hub/owner.secret swift test --package-path apps/apple --filter LiveHubTests
apps/apple/scripts/snapshots.sh /tmp/shots http://127.0.0.1:4320 .perpeto/hub/owner.secret --live-check
```

The seed script uses only the public API: a project, the build template as the active workflow, an architect-drafted version 2, two simulated machines and a live run. It keeps the machines heartbeating until stopped (`--minutes`, default 20). The live tests read every route the app uses and run a human decision round trip; they create a small project on the hub.

SwiftPM builds the Mac app; the iOS app is the only Xcode project. Open `Package.swift` in Xcode to edit and debug. `build-app.sh` wraps the SwiftPM executable in an app bundle with an icon and `Info.plist`.

`snapshots.sh` launches the app with demo data and captures only its own window with `screencapture -l`. The terminal running it needs Screen Recording permission.

## Layout

| Target | Contents |
| --- | --- |
| `PerpetoKit` | Codable contract entities, workflow graph v1 with local validation and version diff, run metrics, Hub API v1 client with server-sent events, Keychain token store, demo fixtures, `FactoryStore`. Design tokens and the Spindle and wordmark geometry. |
| `PerpetoUI` | Screens and components for both platforms. Layouts stack when the detail column is narrower than 760 pt on the Mac or 900 pt on iOS. |
| `PerpetoMac` | macOS app: window, menus, keyboard shortcuts, Settings. |
| `iOS/` | iPhone and iPad app target sharing PerpetoKit and PerpetoUI. |

`Sources/PerpetoKit/Design/PerpetoTokens.swift` is a verbatim copy of `packages/design-tokens/swift/PerpetoTokens.swift`, generated from `brand/tokens.css`. Do not edit it here; regenerate the package and copy it again. Colors come only from it. The logo shapes are parsed at runtime from the identity SVG path data in `LogoPathData.swift`.

## Hub connection

Open Settings (⌘,) on the Mac, or Connect a hub in the sidebar footer on iPhone and iPad, and enter the hub address and owner token. The address is stored in UserDefaults under `perpeto.hubURL`. The token is stored only in the Keychain (service `app.perpeto.hub`) and is sent only in the `Authorization` header. HTTPS is required except for localhost. Without both values the app shows demo data, marked in the sidebar footer and window subtitle.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| ⌘1 to ⌘6 | Overview, Workflows, Runs, Work, Messages, Merge queue |
| ⌥⌘1 to ⌥⌘3 | Machines, Accounts, Usage |
| ⌘N | New workflow draft |
| ⌘R | Refresh |
| ⌘↩ | Draft workflow from the prompt; send a message |
| ⌘S | Save the hand-edited graph as a draft |
| ⌘Z ⇧⌘Z | Undo and redo in the graph editor |
| ⌘- ⌘= ⌘0 | Zoom out, zoom in, fit the graph |
| ⇧⌘P | Pause or resume the selected run |
| Delete | Remove the selected node or edge in the editor |
