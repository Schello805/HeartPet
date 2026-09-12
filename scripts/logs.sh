#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$APP_DIR/scripts/lib/systemd.sh"
LINES="${1:-100}"
LOG_FILE="$APP_DIR/data/logs/heartpet.log"
FOLLOW="${FOLLOW:-0}"

if service_exists; then
  if [ "$FOLLOW" = "1" ]; then
    run_journalctl -u heartpet -n "$LINES" -f
  else
    run_journalctl -u heartpet -n "$LINES" --no-pager
  fi
  exit 0
fi

if [ -f "$LOG_FILE" ]; then
  if [ "$FOLLOW" = "1" ]; then
    tail -n "$LINES" -f "$LOG_FILE"
  else
    tail -n "$LINES" "$LOG_FILE"
  fi
  exit 0
fi

echo "Keine Logdatei gefunden."
