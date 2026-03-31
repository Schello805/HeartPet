#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LINES="${1:-100}"
LOG_FILE="$APP_DIR/data/logs/heartpet.log"
FOLLOW="${FOLLOW:-0}"

run_journalctl() {
  if [ "$(id -u)" -eq 0 ]; then
    journalctl "$@"
  else
    sudo journalctl "$@"
  fi
}

service_exists() {
  command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files --type=service --no-legend 2>/dev/null | grep -q '^heartpet\.service'
}

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
