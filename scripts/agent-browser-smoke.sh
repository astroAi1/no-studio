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
ab wait --text "24×24"

echo "Loading token #7804"
ab find placeholder "token id" fill "7804"
ab wait 150
ab find text "#7804" click
ab wait 600

echo "Capturing final state"
ab screenshot "${SCREENSHOT_PATH}"
ab snapshot -i

echo "Smoke test complete: ${SCREENSHOT_PATH}"
