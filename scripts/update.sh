#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Fehlender Befehl: $1"
    exit 1
  fi
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
echo "Hole aktuellen Stand aus GitHub"
git pull --ff-only

echo "Installiere oder aktualisiere Abhaengigkeiten"
npm install

echo "Pruefe App-Load"
node -e "require('./src/app'); console.log('app-load-ok'); process.exit(0)"

echo "Starte HeartPet neu"
"$APP_DIR/scripts/stop.sh" || true
"$APP_DIR/scripts/start.sh"

echo "HeartPet wurde aktualisiert."
echo "Die Shell bleibt frei. Status bei Bedarf mit ./scripts/status.sh pruefen."
