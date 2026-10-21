#!/bin/sh
# Builds the app, launches it with demo data and captures each main screen.
# Only the app's own window is captured (screencapture -l <window number>).
# Requires Screen Recording permission for the terminal running this script.
# Usage: scripts/snapshots.sh [output-dir]   (default: apps/apple/screenshots)
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/screenshots}"
"$ROOT/scripts/build-app.sh" debug >/dev/null
mkdir -p "$OUT"
"$ROOT/build/Perpeto.app/Contents/MacOS/Perpeto" --snapshots "$OUT" &
PID=$!
# The app quits by itself after the last screen; stop it if it hangs.
( sleep 90; kill "$PID" 2>/dev/null ) &
wait "$PID" || true
ls "$OUT"
