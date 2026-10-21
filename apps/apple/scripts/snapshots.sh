#!/bin/sh
# Builds the app, launches it with demo data and captures each main screen.
# Only the app's own window is captured (screencapture -l <window number>).
# Requires Screen Recording permission for the terminal running this script.
# Usage: scripts/snapshots.sh [output-dir] [hub-url hub-token-file [--live-check]]
#   (default output: apps/apple/screenshots, demo data)
# With a hub URL and token file it captures that hub's first project instead.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/screenshots}"
HUB_ARGS=""
if [ $# -ge 3 ]; then HUB_ARGS="--hub-url $2 --hub-token-file $3 ${4:-}"; fi
"$ROOT/scripts/build-app.sh" debug >/dev/null
mkdir -p "$OUT"
# shellcheck disable=SC2086
"$ROOT/build/Perpeto.app/Contents/MacOS/Perpeto" --snapshots "$OUT" $HUB_ARGS &
PID=$!
# The app quits by itself after the last screen; stop it if it hangs.
( sleep 90; kill "$PID" 2>/dev/null ) &
wait "$PID" || true
ls "$OUT"
