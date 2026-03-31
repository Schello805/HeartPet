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

run_as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

service_exists() {
  command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files --type=service --no-legend 2>/dev/null | grep -q '^heartpet\.service'
}

ensure_service_override() {
  local npm_path current_working_dir current_exec_start current_user current_group target_user target_group override_tmp needs_override

  npm_path="$(command -v npm || true)"
  if [ -z "$npm_path" ]; then
    echo "Warnung: npm wurde nicht gefunden, Service-Override kann nicht geprueft werden."
    return 0
  fi

  current_working_dir="$(run_systemctl show -p WorkingDirectory --value heartpet 2>/dev/null || true)"
  current_exec_start="$(run_systemctl show -p ExecStart --value heartpet 2>/dev/null || true)"
  current_user="$(run_systemctl show -p User --value heartpet 2>/dev/null || true)"
  current_group="$(run_systemctl show -p Group --value heartpet 2>/dev/null || true)"
  target_user="${current_user:-root}"
  target_group="${current_group:-$target_user}"
  if [[ "$APP_DIR" == /root/* ]] && [ "$target_user" != "root" ]; then
    target_user="root"
    target_group="root"
  fi
  needs_override=0

  if [ "$current_working_dir" != "$APP_DIR" ]; then
    needs_override=1
  fi

  if [[ "$current_exec_start" != *"$npm_path start"* ]] && [[ "$current_exec_start" != *"npm start"* ]]; then
    needs_override=1
  fi

  if [ "$current_user" != "$target_user" ] || [ "$current_group" != "$target_group" ]; then
    needs_override=1
  fi

  if [ "$needs_override" -eq 0 ]; then
    return 0
  fi

  echo "Korrigiere heartpet.service (WorkingDirectory/ExecStart/User/Group) automatisch."
  override_tmp="$(mktemp)"
  cat > "$override_tmp" <<EOF
[Service]
WorkingDirectory=$APP_DIR
ExecStart=
ExecStart=$npm_path start
User=$target_user
Group=$target_group
EOF

  run_as_root mkdir -p /etc/systemd/system/heartpet.service.d
  run_as_root cp "$override_tmp" /etc/systemd/system/heartpet.service.d/override.conf
  rm -f "$override_tmp"
  run_systemctl daemon-reload
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
  ensure_service_override
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
