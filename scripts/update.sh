#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUTO_STASHED=0
AUTO_STASH_NAME=""

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Fehlender Befehl: $1"
    exit 1
  fi
}

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
  if ! service_exists; then
    return 0
  fi

  local npm_path current_working_dir current_exec_start override_tmp needs_override
  npm_path="$(command -v npm || true)"
  if [ -z "$npm_path" ]; then
    echo "Warnung: npm wurde nicht gefunden, Service-Override kann nicht geprueft werden."
    return 0
  fi

  current_working_dir="$(run_systemctl show -p WorkingDirectory --value heartpet 2>/dev/null || true)"
  current_exec_start="$(run_systemctl show -p ExecStart --value heartpet 2>/dev/null || true)"
  needs_override=0

  if [ "$current_working_dir" != "$APP_DIR" ]; then
    needs_override=1
  fi

  if [[ "$current_exec_start" != *"$npm_path start"* ]] && [[ "$current_exec_start" != *"npm start"* ]]; then
    needs_override=1
  fi

  if [ "$needs_override" -eq 0 ]; then
    return 0
  fi

  echo "Korrigiere heartpet.service (WorkingDirectory/ExecStart) automatisch."
  override_tmp="$(mktemp)"
  cat > "$override_tmp" <<EOF
[Service]
WorkingDirectory=$APP_DIR
ExecStart=
ExecStart=$npm_path start
EOF

  run_as_root mkdir -p /etc/systemd/system/heartpet.service.d
  run_as_root cp "$override_tmp" /etc/systemd/system/heartpet.service.d/override.conf
  rm -f "$override_tmp"
  run_systemctl daemon-reload
}

prepare_git_workspace() {
  local has_unstaged has_staged has_untracked
  has_unstaged=0
  has_staged=0
  has_untracked=0

  git diff --quiet || has_unstaged=1
  git diff --cached --quiet || has_staged=1
  if [ -n "$(git ls-files --others --exclude-standard)" ]; then
    has_untracked=1
  fi

  if [ "$has_unstaged" -eq 0 ] && [ "$has_staged" -eq 0 ] && [ "$has_untracked" -eq 0 ]; then
    return 0
  fi

  AUTO_STASH_NAME="heartpet-auto-update-$(date +%Y%m%d-%H%M%S)"
  echo "Lokale Git-Aenderungen erkannt. Sichere sie als Stash: $AUTO_STASH_NAME"
  git stash push --include-untracked -m "$AUTO_STASH_NAME" >/dev/null
  AUTO_STASHED=1
}

echo "Pruefe Systemvoraussetzungen"
require_command git
require_command node
require_command npm

if ! git -C "$APP_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Kein Git-Repository gefunden unter $APP_DIR"
  exit 1
fi

mkdir -p "$APP_DIR/data" "$APP_DIR/data/uploads" "$APP_DIR/data/exports" "$APP_DIR/data/backups" "$APP_DIR/data/logs"

"$APP_DIR/scripts/backup.sh"

cd "$APP_DIR"
prepare_git_workspace

echo "Hole aktuellen Stand aus GitHub"
git pull --ff-only

echo "Installiere oder aktualisiere Abhaengigkeiten"
npm install

echo "Pruefe App-Load"
node -e "require('./src/app'); console.log('app-load-ok'); process.exit(0)"

echo "Starte HeartPet neu"
ensure_service_override
"$APP_DIR/scripts/stop.sh" || true
"$APP_DIR/scripts/start.sh"

echo "HeartPet wurde aktualisiert."
if [ "$AUTO_STASHED" -eq 1 ]; then
  echo "Hinweis: Lokale Aenderungen wurden im Stash gesichert: $AUTO_STASH_NAME"
  echo "Bei Bedarf anzeigen mit: git stash list"
fi
echo "Die Shell bleibt frei. Status bei Bedarf mit ./scripts/status.sh pruefen."
