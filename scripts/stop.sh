#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$APP_DIR/scripts/lib/systemd.sh"
PID_FILE="$APP_DIR/data/heartpet.pid"

if service_exists; then
  echo "Stoppe heartpet.service"
  run_systemctl stop heartpet
  exit 0
fi

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Stoppe HeartPet PID $(cat "$PID_FILE")"
  kill "$(cat "$PID_FILE")"
  sleep 1
  rm -f "$PID_FILE"
  exit 0
fi

if pgrep -f "node src/app.js" >/dev/null 2>&1; then
  echo "Stoppe laufende HeartPet-Prozesse"
  pkill -f "node src/app.js"
fi

rm -f "$PID_FILE"
echo "HeartPet ist gestoppt."
