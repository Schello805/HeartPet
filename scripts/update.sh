#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"$APP_DIR/scripts/backup.sh"

cd "$APP_DIR"
echo "Hole aktuellen Stand aus GitHub"
git pull --ff-only

echo "Installiere oder aktualisiere Abhaengigkeiten"
npm install

if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files | grep -q '^heartpet\.service'; then
  echo "Starte heartpet.service neu"
  sudo systemctl restart heartpet
  sudo systemctl status heartpet --no-pager || true
else
  echo "Kein heartpet.service gefunden. Bitte HeartPet manuell neu starten."
fi

echo "HeartPet wurde aktualisiert."
