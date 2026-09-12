#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$APP_DIR/scripts/lib/systemd.sh"
PID_FILE="$APP_DIR/data/heartpet.pid"

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
