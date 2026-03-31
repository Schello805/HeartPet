#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LINES="${1:-100}"
LOG_FILE="$APP_DIR/data/logs/heartpet.log"

run_journalctl() {
  if [ "$(id -u)" -eq 0 ]; then
    journalctl "$@"
  else
    sudo journalctl "$@"
  fi
}

service_exists() {
  command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files | grep -q '^heartpet\.service'
}

if service_exists; then
  run_journalctl -u heartpet -n "$LINES" --no-pager
  exit 0
fi

if [ -f "$LOG_FILE" ]; then
  tail -n "$LINES" "$LOG_FILE"
  exit 0
fi

echo "Keine Logdatei gefunden."
