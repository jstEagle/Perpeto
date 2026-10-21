#!/bin/sh
# Builds the iPhone and iPad app, runs it on a simulator and captures each
# main screen with `simctl io screenshot`, which records only the simulated
# device's display.
# Usage: [NODE=<node id>] [WIDE=1] scripts/ios-snapshots.sh <simulator-udid> <name-prefix> [output-dir] [hub-url hub-token-file]
#   WIDE=1 adds iPad captures with the sidebar hidden.
#   Without a hub the app shows demo data.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UDID="$1"
PREFIX="$2"
OUT="${3:-$ROOT/screenshots/ios}"
HUB_ARGS=""
if [ $# -ge 5 ]; then HUB_ARGS="--hub-url $4 --hub-token-file $5"; fi
BUNDLE=app.perpeto.ios

xcodebuild -project "$ROOT/iOS/Perpeto.xcodeproj" -scheme Perpeto -destination "id=$UDID" \
  -derivedDataPath "$ROOT/build/ios-dd" build >/dev/null
APP="$ROOT/build/ios-dd/Build/Products/Debug-iphonesimulator/Perpeto.app"
xcrun simctl bootstatus "$UDID" -b >/dev/null
xcrun simctl install "$UDID" "$APP"
xcrun simctl status_bar "$UDID" override --time 9:41 --batteryState charged --batteryLevel 100 >/dev/null 2>&1 || true
mkdir -p "$OUT"

shot() {
  name="$1"; shift
  xcrun simctl terminate "$UDID" "$BUNDLE" >/dev/null 2>&1 || true
  # shellcheck disable=SC2086
  xcrun simctl launch "$UDID" "$BUNDLE" $HUB_ARGS "$@" >/dev/null
  sleep 5
  xcrun simctl io "$UDID" screenshot "$OUT/$PREFIX-$name.png" >/dev/null 2>&1
}

shot 01-overview --route overview
shot 02-workflow-proposal --route workflows
shot 03a-runs-list --route runs-list
shot 03-run-live-map --route runs
shot 03b-run-node-selected --route runs --node "${NODE:-review}"
if [ "${WIDE:-0}" = 1 ]; then
  shot 01w-overview-full-width --route overview --detail-only
  shot 03w-run-live-map-full-width --route runs --detail-only
  shot 03bw-run-node-selected-full-width --route runs --node "${NODE:-review}" --detail-only
  shot 02w-workflow-proposal-full-width --route workflows --detail-only
fi
shot 07-machines --route machines
shot 09-usage --route usage
xcrun simctl terminate "$UDID" "$BUNDLE" >/dev/null 2>&1 || true
ls "$OUT" | grep "^$PREFIX-"
