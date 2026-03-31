#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$APP_DIR/data/heartpet.pid"

run_systemctl() {
  if [ "$(id -u)" -eq 0 ]; then
    systemctl "$@"
  else
    sudo systemctl "$@"
  fi
}

service_exists() {
  command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files | grep -q '^heartpet\.service'
}

if service_exists; then
  run_systemctl status heartpet --no-pager
  exit 0
fi

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "HeartPet läuft mit PID $(cat "$PID_FILE")"
  ps -p "$(cat "$PID_FILE")" -o pid=,etime=,command=
  exit 0
fi

if pgrep -f "node src/app.js" >/dev/null 2>&1; then
  PID="$(pgrep -f "node src/app.js" | head -n 1)"
  echo "HeartPet läuft ohne PID-Datei mit PID $PID"
  ps -p "$PID" -o pid=,etime=,command=
  exit 0
fi

echo "HeartPet läuft aktuell nicht."
exit 1
