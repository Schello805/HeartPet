#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-3000}"
PID_FILE="$APP_DIR/data/heartpet.pid"
LOG_DIR="$APP_DIR/data/logs"
LOG_FILE="$LOG_DIR/heartpet.log"
START_WAIT_SECONDS="${START_WAIT_SECONDS:-15}"

run_systemctl() {
  if [ "$(id -u)" -eq 0 ]; then
    systemctl "$@"
  else
    sudo systemctl "$@"
  fi
}

service_exists() {
  command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files --type=service --no-legend 2>/dev/null | grep -q '^heartpet\.service'
}

wait_for_http() {
  if ! command -v curl >/dev/null 2>&1; then
    return 0
  fi

  local i
  for i in $(seq 1 "$START_WAIT_SECONDS"); do
    if curl --max-time 2 -fsS -o /dev/null "http://127.0.0.1:${PORT}/login"; then
      return 0
    fi
    sleep 1
  done

  return 1
}

mkdir -p "$APP_DIR/data" "$APP_DIR/data/uploads" "$APP_DIR/data/exports" "$APP_DIR/data/backups" "$LOG_DIR"

cd "$APP_DIR"

if service_exists; then
  echo "Starte heartpet.service"
  run_systemctl start heartpet
  run_systemctl status heartpet --no-pager || true
else
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "HeartPet läuft bereits mit PID $(cat "$PID_FILE")"
    exit 0
  fi

  if [ -f "$PID_FILE" ]; then
    echo "Entferne veraltete PID-Datei"
    rm -f "$PID_FILE"
  fi

  echo "Starte HeartPet im Hintergrund"
  nohup npm start >> "$LOG_FILE" 2>&1 < /dev/null &
  echo $! > "$PID_FILE"
  sleep 2
  if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "HeartPet konnte nicht gestartet werden. Siehe $LOG_FILE"
    exit 1
  fi
fi

if command -v curl >/dev/null 2>&1; then
  wait_for_http || {
    echo "Warnung: Health-Check auf Port ${PORT} war nicht erfolgreich."
    exit 1
  }
fi

echo "HeartPet läuft."
