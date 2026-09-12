#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_ROOT="${HEARTPET_RELEASE_ROOT:-$APP_DIR/.releases}"
CURRENT_LINK="${HEARTPET_CURRENT_LINK:-$APP_DIR/.runtime/current}"
DATA_DIR="${HEARTPET_DATA_DIR:-$APP_DIR/data}"
PORT="${PORT:-3000}"
REVISION="$(tr -d '[:space:]' < "$APP_DIR/REVISION")"
RELEASE_ID="${REVISION}-$(git -C "$APP_DIR" rev-parse --short=12 HEAD)"
RELEASE_DIR="$RELEASE_ROOT/$RELEASE_ID"
PREVIOUS_TARGET="$(readlink "$CURRENT_LINK" 2>/dev/null || printf '%s' "$APP_DIR")"

run_systemctl() {
  if [ "$(id -u)" -eq 0 ]; then systemctl "$@"; else sudo systemctl "$@"; fi
}

run_as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

write_service_override() {
  local npm_path override_tmp
  npm_path="$(command -v npm)"
  override_tmp="$(mktemp)"
  cat > "$override_tmp" <<EOF
[Service]
WorkingDirectory=$CURRENT_LINK
ExecStart=
ExecStart=$npm_path start
Environment=HEARTPET_DATA_DIR=$DATA_DIR
EOF
  run_as_root mkdir -p /etc/systemd/system/heartpet.service.d
  run_as_root cp "$override_tmp" /etc/systemd/system/heartpet.service.d/override.conf
  rm -f "$override_tmp"
  run_systemctl daemon-reload
}

activate_release() {
  local target="$1" next_link="${CURRENT_LINK}.next"
  mkdir -p "$(dirname "$CURRENT_LINK")"
  ln -sfn "$target" "$next_link"
  mv -Tf "$next_link" "$CURRENT_LINK"
}

wait_for_revision() {
  local attempt body
  for attempt in $(seq 1 20); do
    body="$(curl --max-time 2 -sS "http://127.0.0.1:${PORT}/health" 2>/dev/null || true)"
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
  run_systemctl status heartpet --no-pager --full || true
  run_as_root journalctl -u heartpet.service -n 80 --no-pager --output=short-iso || true
}

mkdir -p "$RELEASE_ROOT" "$DATA_DIR"
if [ ! -d "$RELEASE_DIR" ]; then
  mkdir -p "$RELEASE_DIR"
  git -C "$APP_DIR" archive HEAD | tar -x -C "$RELEASE_DIR"
  npm --prefix "$RELEASE_DIR" ci --omit=dev
fi

TEMP_DATA="$(mktemp -d)"
trap 'rm -rf "$TEMP_DATA"' EXIT
HEARTPET_DATA_DIR="$TEMP_DATA" NODE_ENV=test HEARTPET_SESSION_STORE=memory HEARTPET_SESSION_SECRET=release-validation-secret-1234567890 \
  node -e "require('$RELEASE_DIR/src/app'); process.exit(0)"

write_service_override
run_systemctl enable heartpet
activate_release "$RELEASE_DIR"
if run_systemctl restart heartpet && wait_for_revision; then
  echo "HeartPet Revision $REVISION ist aktiv."
  find "$RELEASE_ROOT" -mindepth 1 -maxdepth 1 -type d ! -path "$RELEASE_DIR" -mtime +14 -exec rm -rf {} +
  exit 0
fi

echo "Deployment fehlgeschlagen. Stelle vorherige Version wieder her."
print_service_diagnostics
activate_release "$PREVIOUS_TARGET"
if ! run_systemctl restart heartpet; then
  echo "Fehler: Auch die vorherige HeartPet-Version konnte nicht gestartet werden."
  print_service_diagnostics
fi
exit 1
