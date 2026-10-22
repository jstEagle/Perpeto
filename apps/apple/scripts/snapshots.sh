#!/bin/sh
# Builds the app, launches it with demo data and captures each main screen.
# Only the app's own window is captured (screencapture -l <window number>).
# Requires Screen Recording permission for the terminal running this script.
# Usage: scripts/snapshots.sh [output-dir] [hub-url hub-token-file [--live-check]]
#   (default output: apps/apple/screenshots, demo data)
# With a hub URL and token file it captures that hub's first project instead.
#        scripts/snapshots.sh --themes [output-dir]
#   captures the main screens in light and dark (default: screenshots/themes,
#   light-*.png and dark-*.png). Set APPEARANCE=light|dark to force one
#   appearance for a normal run.
#        scripts/snapshots.sh --pacing [output-dir]
#   captures Accounts and Pacing in light and dark (default: screenshots/pacing).
#        scripts/snapshots.sh --observe [output-dir]
#   captures the observe-only demo (no projects: Home, Sessions, Accounts,
#   Pacing, Usage, Machines) in light and dark (default: screenshots/observe).
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ "${1:-}" = "--observe" ]; then
  OUT="${2:-$ROOT/screenshots/observe}"
  "$ROOT/scripts/build-app.sh" debug >/dev/null
  mkdir -p "$OUT"
  for MODE in light dark; do
    "$ROOT/build/Perpeto.app/Contents/MacOS/Perpeto" --snapshots "$OUT" --observe "$MODE-" -perpeto.appearance "$MODE" -perpeto.demo observe &
    PID=$!
    ( sleep 90; kill "$PID" 2>/dev/null ) &
    wait "$PID" || true
  done
  ls "$OUT"
  exit 0
fi
if [ "${1:-}" = "--themes" ] || [ "${1:-}" = "--pacing" ]; then
  MODE_FLAG="$1"
  OUT="${2:-$ROOT/screenshots/${MODE_FLAG#--}}"
  "$ROOT/scripts/build-app.sh" debug >/dev/null
  mkdir -p "$OUT"
  for MODE in light dark; do
    "$ROOT/build/Perpeto.app/Contents/MacOS/Perpeto" --snapshots "$OUT" "$MODE_FLAG" "$MODE-" -perpeto.appearance "$MODE" &
    PID=$!
    ( sleep 90; kill "$PID" 2>/dev/null ) &
    wait "$PID" || true
  done
  ls "$OUT"
  exit 0
fi
OUT="${1:-$ROOT/screenshots}"
HUB_ARGS=""
if [ $# -ge 3 ]; then HUB_ARGS="--hub-url $2 --hub-token-file $3 ${4:-}"; fi
if [ -n "${APPEARANCE:-}" ]; then HUB_ARGS="$HUB_ARGS -perpeto.appearance $APPEARANCE"; fi
"$ROOT/scripts/build-app.sh" debug >/dev/null
mkdir -p "$OUT"
# shellcheck disable=SC2086
"$ROOT/build/Perpeto.app/Contents/MacOS/Perpeto" --snapshots "$OUT" $HUB_ARGS &
PID=$!
# The app quits by itself after the last screen; stop it if it hangs.
( sleep 90; kill "$PID" 2>/dev/null ) &
wait "$PID" || true
ls "$OUT"
