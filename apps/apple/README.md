# Perpeto for Apple platforms

Native SwiftUI client for the Perpeto hub, macOS 15 or later first. Status: early implementation. It runs against demo fixtures today; the hub client is tested against stubbed responses, not a live hub.

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

SwiftPM is the only build system; there is no checked-in Xcode project. Open `Package.swift` in Xcode to edit and debug. `build-app.sh` wraps the SwiftPM executable in an app bundle with an icon and `Info.plist`.

`snapshots.sh` launches the app with demo data and captures only its own window with `screencapture -l`. The terminal running it needs Screen Recording permission.

## Layout

| Target | Contents |
| --- | --- |
| `PerpetoKit` | Codable contract entities, workflow graph v1 with local validation and version diff, run metrics, Hub API v1 client with server-sent events, Keychain token store, demo fixtures, `FactoryStore`. Design tokens and the Spindle and wordmark geometry. |
| `PerpetoUI` | Screens and components. Compiles for macOS and iOS Simulator. |
| `PerpetoMac` | macOS app: window, menus, keyboard shortcuts, Settings. |

`Sources/PerpetoKit/Design/PerpetoTokens.swift` is a verbatim copy of `packages/design-tokens/swift/PerpetoTokens.swift`, generated from `brand/tokens.css`. Do not edit it here; regenerate the package and copy it again. Colors come only from it. The logo shapes are parsed at runtime from the identity SVG path data in `LogoPathData.swift`.

## Hub connection

Open Settings (⌘,) and enter the hub address and owner token. The address is stored in UserDefaults under `perpeto.hubURL`. The token is stored only in the login Keychain (service `app.perpeto.hub`) and is sent only in the `Authorization` header. HTTPS is required except for localhost. Without both values the app shows demo data, marked in the sidebar footer and window subtitle.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| ⌘1 to ⌘6 | Overview, Workflows, Runs, Work, Messages, Merge queue |
| ⌥⌘1 to ⌥⌘3 | Machines, Accounts, Usage |
| ⌘N | New workflow draft |
| ⌘R | Refresh |
| ⌘↩ | Draft workflow from the prompt; send a message |
| ⌘S | Save the hand-edited graph as a draft |
| ⌘- ⌘= ⌘0 | Zoom out, zoom in, fit the graph |
| ⇧⌘P | Pause or resume the selected run |
| Delete | Remove the selected node or edge in the editor |
