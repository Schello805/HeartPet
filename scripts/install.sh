#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

run_as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "Fehler: Für die Installation von Systempaketen werden root-Rechte oder sudo benötigt."
    exit 1
  fi
}

install_ffmpeg() {
  if command -v ffmpeg >/dev/null 2>&1; then
    echo "ffmpeg ist bereits installiert: $(ffmpeg -version | head -n 1)"
    return 0
  fi

  echo "Installiere ffmpeg für Kamera-Standbilder und RTSP-Streams."
  if command -v apt-get >/dev/null 2>&1; then
    run_as_root apt-get update
    run_as_root apt-get install -y ffmpeg
  elif command -v dnf >/dev/null 2>&1; then
    run_as_root dnf install -y ffmpeg
  elif command -v yum >/dev/null 2>&1; then
    run_as_root yum install -y ffmpeg
  elif command -v apk >/dev/null 2>&1; then
    run_as_root apk add --no-cache ffmpeg
  else
    echo "Fehler: Kein unterstützter Paketmanager gefunden. Bitte ffmpeg manuell installieren."
    exit 1
  fi

  if ! command -v ffmpeg >/dev/null 2>&1; then
    echo "Fehler: ffmpeg wurde nicht erfolgreich installiert."
    exit 1
  fi
}

for command_name in node npm git; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Fehler: $command_name fehlt. HeartPet benötigt Git sowie Node.js 20 oder neuer inklusive npm."
    exit 1
  fi
done

node_major="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "$node_major" -lt 20 ]; then
  echo "Fehler: Node.js $(node --version) ist zu alt. HeartPet benötigt Node.js 20 oder neuer."
  exit 1
fi

install_ffmpeg

cd "$APP_DIR"
mkdir -p data data/uploads data/exports data/backups data/logs

echo "Installiere HeartPet-Abhängigkeiten."
npm install

echo "Prüfe App-Load."
node -e "require('./src/app'); console.log('app-load-ok'); process.exit(0)"

echo "HeartPet ist installiert. Start mit: ./scripts/start.sh"
