#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$APP_DIR/data/backups/$TIMESTAMP"

mkdir -p "$BACKUP_DIR"

echo "Erstelle HeartPet Backup unter $BACKUP_DIR"

if [ -f "$APP_DIR/data/heartpet.sqlite" ]; then
  cp "$APP_DIR/data/heartpet.sqlite" "$BACKUP_DIR/"
fi

if [ -f "$APP_DIR/data/heartpet.sqlite-shm" ]; then
  cp "$APP_DIR/data/heartpet.sqlite-shm" "$BACKUP_DIR/"
fi

if [ -f "$APP_DIR/data/heartpet.sqlite-wal" ]; then
  cp "$APP_DIR/data/heartpet.sqlite-wal" "$BACKUP_DIR/"
fi

if [ -f "$APP_DIR/data/sessions.sqlite" ]; then
  cp "$APP_DIR/data/sessions.sqlite" "$BACKUP_DIR/"
fi

if [ -d "$APP_DIR/data/uploads" ]; then
  cp -R "$APP_DIR/data/uploads" "$BACKUP_DIR/"
fi

if [ -d "$APP_DIR/data/exports" ]; then
  cp -R "$APP_DIR/data/exports" "$BACKUP_DIR/"
fi

echo "Backup abgeschlossen."
