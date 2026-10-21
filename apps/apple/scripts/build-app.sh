#!/bin/sh
# Builds apps/apple/build/Perpeto.app from the Swift package.
# Usage: scripts/build-app.sh [debug|release]   (default: release)
set -eu

CONFIG="${1:-release}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/build"
APP="$OUT/Perpeto.app"

cd "$ROOT"
swift build -c "$CONFIG" --product Perpeto
BIN="$(swift build -c "$CONFIG" --show-bin-path)/Perpeto"

rm -rf "$APP" "$OUT/AppIcon.iconset"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# The icon is drawn in code from the Spindle master geometry.
"$BIN" --render-icon "$OUT/AppIcon.iconset"
iconutil -c icns "$OUT/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"

cp "$BIN" "$APP/Contents/MacOS/Perpeto"
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/../../package.json" | head -n 1)"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Perpeto</string>
  <key>CFBundleDisplayName</key><string>Perpeto</string>
  <key>CFBundleIdentifier</key><string>app.perpeto.mac</string>
  <key>CFBundleExecutable</key><string>Perpeto</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleShortVersionString</key><string>${VERSION:-0.0.0}</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>15.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSRequiresAquaSystemAppearance</key><true/>
</dict>
</plist>
PLIST

# Ad-hoc signature for local runs only. Distribution signing is not configured.
codesign --force --sign - "$APP" >/dev/null
echo "$APP"
