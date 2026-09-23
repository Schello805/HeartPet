#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$APP_DIR/scripts/lib/systemd.sh"
RELEASE_ROOT="${HEARTPET_RELEASE_ROOT:-$APP_DIR/.releases}"
CURRENT_LINK="${HEARTPET_CURRENT_LINK:-$APP_DIR/.runtime/current}"
DATA_DIR="${HEARTPET_DATA_DIR:-$APP_DIR/data}"
PORT="${PORT:-3000}"
REVISION="$(tr -d '[:space:]' < "$APP_DIR/REVISION")"
RELEASE_ID="${REVISION}-$(git -C "$APP_DIR" rev-parse --short=12 HEAD)"
RELEASE_DIR="$RELEASE_ROOT/$RELEASE_ID"
PREVIOUS_TARGET="$(readlink "$CURRENT_LINK" 2>/dev/null || printf '%s' "$APP_DIR")"
RELEASE_COMMIT="$(git -C "$APP_DIR" rev-parse HEAD)"

write_service_override() {
  local release_path="$1" runtime_revision node_path current_user current_group target_user target_group override_tmp
  runtime_revision="$(tr -d '[:space:]' < "$release_path/REVISION")"
  node_path="$(command -v node)"
  current_user="$(run_systemctl show -p User --value heartpet 2>/dev/null || true)"
  current_group="$(run_systemctl show -p Group --value heartpet 2>/dev/null || true)"
  target_user="${current_user:-root}"
  target_group="${current_group:-$target_user}"

  # /root is intentionally not traversable by service accounts such as www-data.
  if [[ "$CURRENT_LINK" == /root/* ]] && [ "$target_user" != "root" ]; then
    target_user="root"
    target_group="root"
  fi

  override_tmp="$(mktemp)"
  cat > "$override_tmp" <<EOF
[Service]
WorkingDirectory=$release_path
ExecStart=
ExecStart=$node_path $release_path/src/app.js
User=$target_user
Group=$target_group
Environment=HEARTPET_DATA_DIR=$DATA_DIR
Environment=HEARTPET_RUNTIME_REVISION=$runtime_revision
EOF
  run_as_root mkdir -p /etc/systemd/system/heartpet.service.d
  run_as_root cp "$override_tmp" /etc/systemd/system/heartpet.service.d/override.conf
  rm -f "$override_tmp"
  run_systemctl daemon-reload

  SERVICE_USER="$target_user"
}

verify_service_access() {
  local release_path="$1"
  if [ "$SERVICE_USER" != "root" ] && ! run_as_root runuser -u "$SERVICE_USER" -- test -x "$release_path"; then
    echo "Fehler: Dienstbenutzer $SERVICE_USER darf $release_path nicht betreten."
    echo "Installiere HeartPet unter /opt/HeartPet oder korrigiere User/Group der Unit."
    return 1
  fi
}

release_is_valid() {
  [ -f "$RELEASE_DIR/REVISION" ] \
    && [ -f "$RELEASE_DIR/.heartpet-release" ] \
    && [ "$(tr -d '[:space:]' < "$RELEASE_DIR/REVISION")" = "$REVISION" ] \
    && [ "$(tr -d '[:space:]' < "$RELEASE_DIR/.heartpet-release")" = "$RELEASE_COMMIT" ]
}

prepare_release() {
  local build_dir="${RELEASE_DIR}.build.$$"
  if release_is_valid; then
    return 0
  fi

  if [ -e "$RELEASE_DIR" ]; then
    echo "Vorhandenes Release $RELEASE_ID ist unvollständig oder inkonsistent und wird neu erzeugt."
    rm -rf "$RELEASE_DIR"
  fi

  rm -rf "$build_dir"
  mkdir -p "$build_dir"
  git -C "$APP_DIR" archive HEAD | tar -x -C "$build_dir"
  npm --prefix "$build_dir" ci --omit=dev
  printf '%s\n' "$RELEASE_COMMIT" > "$build_dir/.heartpet-release"
  mv "$build_dir" "$RELEASE_DIR"
}

activate_release() {
  local target="$1" next_link="${CURRENT_LINK}.next"
  mkdir -p "$(dirname "$CURRENT_LINK")"
  ln -sfn "$target" "$next_link"
  mv -Tf "$next_link" "$CURRENT_LINK"
}

stop_legacy_instances() {
  local pid cwd
  if ! command -v pgrep >/dev/null 2>&1; then
    return 0
  fi

  while read -r pid; do
    [ -n "$pid" ] || continue
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
    case "$cwd" in
      "$APP_DIR"|"$APP_DIR"/*)
        echo "Beende verwaisten HeartPet-Prozess $pid aus $cwd."
        run_as_root kill "$pid" 2>/dev/null || true
        ;;
    esac
  done < <(pgrep -f 'node .*src/app\.js' || true)
}

start_release_service() {
  run_systemctl stop heartpet
  stop_legacy_instances
  run_systemctl start heartpet
}

wait_for_revision() {
  local attempt body status_code
  for attempt in $(seq 1 20); do
    body="$(curl --max-time 2 -sS -w $'\n%{http_code}' "http://127.0.0.1:${PORT}/health" 2>/dev/null || true)"
    status_code="${body##*$'\n'}"
    body="${body%$'\n'*}"
    LAST_HEALTH_BODY="$body"
    LAST_HEALTH_STATUS="$status_code"
    if HEALTH_BODY="$body" EXPECTED_REVISION="$REVISION" node -e '
      try {
        const health = JSON.parse(process.env.HEALTH_BODY || "{}");
        process.exit(health.revision === process.env.EXPECTED_REVISION && health.restartRequired === false ? 0 : 1);
      } catch { process.exit(1); }
    '; then
      return 0
    fi
    sleep 1
  done
  return 1
}

print_service_diagnostics() {
  echo "Erwartete Revision: $REVISION"
  echo "Letzter Health-Status: ${LAST_HEALTH_STATUS:-unbekannt}"
  echo "Letzte Health-Antwort: ${LAST_HEALTH_BODY:-keine Antwort}"
  echo "Aktives Release-Ziel: $(readlink "$CURRENT_LINK" 2>/dev/null || printf '%s' "$APP_DIR")"
  echo "systemd-Arbeitsverzeichnis: $(run_systemctl show -p WorkingDirectory --value heartpet 2>/dev/null || printf '%s' 'unbekannt')"
  echo "systemd-Prozess: $(run_systemctl show -p MainPID --value heartpet 2>/dev/null || printf '%s' 'unbekannt')"
  if command -v ss >/dev/null 2>&1; then
    echo "Prozess auf Port $PORT:"
    run_as_root ss -ltnp "sport = :$PORT" || true
  fi
  run_systemctl status heartpet --no-pager --full || true
  run_as_root journalctl -u heartpet.service -n 80 --no-pager --output=short-iso || true
}

mkdir -p "$RELEASE_ROOT" "$DATA_DIR"
prepare_release

TEMP_DATA="$(mktemp -d)"
trap 'rm -rf "$TEMP_DATA"' EXIT
HEARTPET_DATA_DIR="$TEMP_DATA" NODE_ENV=test HEARTPET_SESSION_STORE=memory HEARTPET_SESSION_SECRET=release-validation-secret-1234567890 \
  node -e "require('$RELEASE_DIR/src/app'); process.exit(0)"

write_service_override "$RELEASE_DIR"
run_systemctl enable heartpet
activate_release "$RELEASE_DIR"
verify_service_access "$RELEASE_DIR"
if start_release_service && wait_for_revision; then
  echo "HeartPet Revision $REVISION ist aktiv."
  find "$RELEASE_ROOT" -mindepth 1 -maxdepth 1 -type d ! -path "$RELEASE_DIR" -mtime +14 -exec rm -rf {} +
  exit 0
fi

echo "Deployment fehlgeschlagen. Stelle vorherige Version wieder her."
print_service_diagnostics
activate_release "$PREVIOUS_TARGET"
write_service_override "$PREVIOUS_TARGET"
if ! start_release_service; then
  echo "Fehler: Auch die vorherige HeartPet-Version konnte nicht gestartet werden."
  print_service_diagnostics
fi
exit 1
