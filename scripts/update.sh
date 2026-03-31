#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"$APP_DIR/scripts/backup.sh"

cd "$APP_DIR"
echo "Hole aktuellen Stand aus GitHub"
git pull --ff-only

echo "Installiere oder aktualisiere Abhaengigkeiten"
npm install

echo "HeartPet wurde aktualisiert."
echo "Falls die App ueber systemd laeuft, jetzt den Dienst neu starten."
