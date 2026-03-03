#!/usr/bin/env bash
set -euo pipefail

URL="${1:-http://127.0.0.1:${PORT:-8792}/tools/no-studio}"
SCREENSHOT_PATH="${2:-/tmp/no-studio-agent-browser-smoke.png}"
SESSION="no-studio-smoke"

if ! command -v agent-browser >/dev/null 2>&1; then
  echo "agent-browser CLI is not in PATH for this shell."
  echo "Install the CLI binary first, then rerun:"
  echo "  npm install -g agent-browser"
  echo "  agent-browser install"
  exit 1
fi

ab() {
  agent-browser --session "${SESSION}" "$@"
}

cleanup() {
  ab close >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Opening ${URL}"
ab open "${URL}"
ab wait --text "NO-STUDIO"
ab wait --text "No-Minimalism"

echo "Selecting #7804"
ab find placeholder "Search #7804, alien, pipe..." fill "#7804"
ab wait 300
ab find text "No-Punk #7804" click
ab wait 400

echo "Toggling active background mode and applying No-Minimalism"
ab find text "Use Active Color As BG" click
ab wait 150
ab find text "No-Minimalism" click
ab wait 300

echo "Generating Noir and Pop from original-source logic"
ab find text "Noir" click
ab wait 120
ab find text "Render Noir" click
ab wait 250
ab find text "Pop" click
ab wait 120
ab find text "Render Pop" click
ab wait 250

echo "Running background-reactive Bayer dither"
ab find text "Dither" click
ab wait 120
ab find text "Bayer" click
ab wait 100
ab find text "Build Theory From Active" click
ab wait 120
ab find text "Run Pattern" click
ab wait 300

echo "Capturing final state"
ab screenshot "${SCREENSHOT_PATH}"
ab snapshot -i

echo "Smoke test complete: ${SCREENSHOT_PATH}"
