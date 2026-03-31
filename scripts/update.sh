#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$APP_DIR/data/backups/$TIMESTAMP"

mkdir -p "$BACKUP_DIR"

echo "Sichere Datenbank und Uploads nach $BACKUP_DIR"
if [ -f "$APP_DIR/data/heartpet.sqlite" ]; then
  cp "$APP_DIR/data/heartpet.sqlite" "$BACKUP_DIR/"
fi

if [ -d "$APP_DIR/data/uploads" ]; then
  cp -R "$APP_DIR/data/uploads" "$BACKUP_DIR/"
fi

cd "$APP_DIR"
echo "Hole aktuellen Stand aus GitHub"
git pull --ff-only

echo "Installiere oder aktualisiere Abhaengigkeiten"
npm install

echo "HeartPet wurde aktualisiert."
echo "Falls die App ueber systemd laeuft, jetzt den Dienst neu starten."
