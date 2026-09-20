#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIGURE_INSTANCE=1

usage() {
  cat <<'EOF'
Vollständige Installation:
  ./scripts/install.sh

Nur Abhängigkeiten für die Entwicklung:
  ./scripts/install.sh --dependencies-only
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
elif [ "${1:-}" = "--configure" ]; then
  shift
elif [ "${1:-}" = "--dependencies-only" ]; then
  CONFIGURE_INSTANCE=0
  shift
fi
if [ "$CONFIGURE_INSTANCE" -eq 1 ] && { [ "$APP_DIR" = "/root" ] || [[ "$APP_DIR" == /root/* ]]; }; then
  echo "Fehler: HeartPet darf als Dienst nicht unter $APP_DIR installiert werden."
  echo "Empfohlen: git clone https://github.com/Schello805/HeartPet.git /opt/HeartPet"
  exit 1
fi
if [ "$CONFIGURE_INSTANCE" -eq 0 ] && [ "$#" -gt 0 ]; then
  echo "Unbekannte Option: $1"
  echo "Verwendung: ./scripts/install.sh [--configure] [Konfigurationsoptionen]"
  echo "         oder ./scripts/install.sh --dependencies-only"
  exit 1
fi

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

install_required_tools() {
  local missing=()
  for command_name in node npm git curl; do
    command -v "$command_name" >/dev/null 2>&1 || missing+=("$command_name")
  done
  if [ "${#missing[@]}" -eq 0 ]; then return 0; fi

  echo "Installiere fehlende Systemvoraussetzungen: ${missing[*]}"
  if command -v apt-get >/dev/null 2>&1; then
    run_as_root apt-get update
    run_as_root apt-get install -y ca-certificates curl git nodejs npm build-essential python3
  elif command -v dnf >/dev/null 2>&1; then
    run_as_root dnf install -y ca-certificates curl git nodejs npm gcc-c++ make python3
  elif command -v yum >/dev/null 2>&1; then
    run_as_root yum install -y ca-certificates curl git nodejs npm gcc-c++ make python3
  elif command -v apk >/dev/null 2>&1; then
    run_as_root apk add --no-cache ca-certificates curl git nodejs npm build-base python3
  else
    echo "Fehler: Kein unterstützter Paketmanager gefunden. Bitte Git, curl sowie Node.js 20 oder neuer inklusive npm installieren."
    exit 1
  fi
}

install_supported_node() {
  local node_major=0
  if command -v node >/dev/null 2>&1; then
    node_major="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || printf '0')"
  fi
  if [ "$node_major" -ge 20 ] && command -v npm >/dev/null 2>&1; then return 0; fi

  echo "Installiere Node.js 22 LTS, weil die vorhandene Node.js-Version nicht unterstützt wird."
  if command -v apt-get >/dev/null 2>&1; then
    local key_tmp source_tmp
    key_tmp="$(mktemp)"
    source_tmp="$(mktemp)"
    trap 'rm -f "${key_tmp:-}" "${source_tmp:-}"' RETURN
    run_as_root apt-get update
    run_as_root apt-get install -y ca-certificates curl gnupg
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o "$key_tmp"
    run_as_root mkdir -p /etc/apt/keyrings
    run_as_root gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg "$key_tmp"
    printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' > "$source_tmp"
    run_as_root install -m 644 "$source_tmp" /etc/apt/sources.list.d/nodesource.list
    run_as_root apt-get update
    run_as_root apt-get install -y nodejs
    hash -r
  elif command -v dnf >/dev/null 2>&1; then
    run_as_root dnf install -y nodejs npm
  elif command -v yum >/dev/null 2>&1; then
    run_as_root yum install -y nodejs npm
  elif command -v apk >/dev/null 2>&1; then
    run_as_root apk add --no-cache nodejs npm
  fi

  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo "Fehler: Node.js inklusive npm konnte nicht installiert werden."
    exit 1
  fi
  node_major="$(node -p "Number(process.versions.node.split('.')[0])")"
  if [ "$node_major" -lt 20 ]; then
    echo "Fehler: Node.js $(node --version) ist zu alt. HeartPet benötigt Node.js 20 oder neuer."
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

install_required_tools
install_supported_node

for command_name in node npm git curl; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Fehler: $command_name fehlt. HeartPet benötigt Git sowie Node.js 20 oder neuer inklusive npm."
    exit 1
  fi
done

install_ffmpeg

cd "$APP_DIR"
mkdir -p data data/uploads data/exports data/backups data/logs

echo "Installiere HeartPet-Abhängigkeiten."
npm install

echo "Prüfe App-Load."
node -e "require('./src/app'); console.log('app-load-ok'); process.exit(0)"

if [ "$CONFIGURE_INSTANCE" -eq 1 ]; then
  "$APP_DIR/scripts/configure-instance.sh" "$@"
else
  echo "HeartPet-Abhängigkeiten sind installiert. Manueller Start mit: ./scripts/start.sh"
fi
