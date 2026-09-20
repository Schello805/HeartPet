#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$APP_DIR/data"
MODE=""
DOMAIN=""
PORT_VALUE="3000"
SERVICE_USER="www-data"
CONFIGURE_NGINX=""
ASSUME_YES=0

usage() {
  cat <<'EOF'
HeartPet-Instanz konfigurieren

Interaktiv:
  ./scripts/configure-instance.sh

Automatisiert:
  ./scripts/configure-instance.sh --mode domain --domain https://tiere.example.de --port 3000 --user www-data --nginx --yes

Optionen:
  --mode lan|domain
  --domain https://tiere.example.de
  --port PORT
  --user SYSTEMBENUTZER
  --nginx | --no-nginx
  --yes
EOF
}

run_as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; elif command -v sudo >/dev/null 2>&1; then sudo "$@"; else
    echo "Fehler: Für die Systemkonfiguration werden root-Rechte oder sudo benötigt."
    exit 1
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --port) PORT_VALUE="${2:-}"; shift 2 ;;
    --user) SERVICE_USER="${2:-}"; shift 2 ;;
    --nginx) CONFIGURE_NGINX="yes"; shift ;;
    --no-nginx) CONFIGURE_NGINX="no"; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unbekannte Option: $1"; usage; exit 1 ;;
  esac
done

if [ -z "$MODE" ]; then
  echo "Wie soll HeartPet erreichbar sein?"
  echo "  1) Nur im Heimnetz"
  echo "  2) Über eine HTTPS-Domain"
  read -r -p "Auswahl [1]: " mode_choice
  MODE="$([ "${mode_choice:-1}" = "2" ] && printf domain || printf lan)"
fi

if [ "$MODE" != "lan" ] && [ "$MODE" != "domain" ]; then
  echo "Fehler: --mode muss lan oder domain sein."
  exit 1
fi

if [ "$MODE" = "domain" ] && [ -z "$DOMAIN" ]; then
  read -r -p "Öffentliche HTTPS-Adresse (z. B. https://tiere.example.de): " DOMAIN
fi
if [ "$MODE" = "domain" ]; then
  DOMAIN="${DOMAIN%/}"
  if [[ ! "$DOMAIN" =~ ^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$ ]]; then
    echo "Fehler: Bitte eine HTTPS-Adresse ohne Pfad angeben."
    exit 1
  fi
fi

if [ "$ASSUME_YES" -eq 0 ]; then
  read -r -p "App-Port [$PORT_VALUE]: " input_port
  PORT_VALUE="${input_port:-$PORT_VALUE}"
  read -r -p "Systembenutzer [$SERVICE_USER]: " input_user
  SERVICE_USER="${input_user:-$SERVICE_USER}"
fi
if [[ ! "$PORT_VALUE" =~ ^[0-9]+$ ]] || [ "$PORT_VALUE" -lt 1 ] || [ "$PORT_VALUE" -gt 65535 ]; then
  echo "Fehler: Ungültiger Port."
  exit 1
fi
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "Fehler: Systembenutzer $SERVICE_USER existiert nicht."
  exit 1
fi
SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
if [[ "$APP_DIR" == /root || "$APP_DIR" == /root/* ]]; then
  echo "Fehler: Ein Dienst unter $APP_DIR ist für $SERVICE_USER nicht zuverlässig erreichbar."
  echo "Klone HeartPet nach /opt/HeartPet und starte die Konfiguration dort erneut."
  exit 1
fi
if [[ "$APP_DIR" == *" "* ]]; then
  echo "Fehler: Der Installationspfad darf keine Leerzeichen enthalten."
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  echo "Fehler: systemctl und curl werden für die Dienstkonfiguration benötigt."
  exit 1
fi

if [ -z "$CONFIGURE_NGINX" ]; then
  if [ "$MODE" = "domain" ]; then
    if [ "$ASSUME_YES" -eq 1 ]; then
      CONFIGURE_NGINX="yes"
    else
      read -r -p "Nginx auf diesem LXC konfigurieren? [J/n]: " nginx_choice
      [[ "${nginx_choice:-j}" =~ ^[JjYy]$ ]] && CONFIGURE_NGINX="yes" || CONFIGURE_NGINX="no"
    fi
  else
    CONFIGURE_NGINX="no"
  fi
fi

echo "Konfiguriere HeartPet unter $APP_DIR"
mkdir -p "$DATA_DIR" "$DATA_DIR/uploads" "$DATA_DIR/exports" "$DATA_DIR/backups" "$DATA_DIR/logs"
run_as_root chown -R "$SERVICE_USER:$SERVICE_GROUP" "$DATA_DIR"

env_tmp="$(mktemp)"
service_tmp="$(mktemp)"
trap 'rm -f "$env_tmp" "$service_tmp" "${nginx_tmp:-}"' EXIT

cat > "$env_tmp" <<EOF
PORT=$PORT_VALUE
HEARTPET_HOST=$([ "$MODE" = "domain" ] && printf '127.0.0.1' || printf '0.0.0.0')
HEARTPET_SESSION_DAYS=30
HEARTPET_TRUST_PROXY=loopback
HEARTPET_SECURE_COOKIE=$([ "$MODE" = "domain" ] && printf 'true' || printf 'false')
EOF
if [ "$MODE" = "domain" ]; then printf 'HEARTPET_APP_URL=%s\n' "$DOMAIN" >> "$env_tmp"; fi

node_path="$(command -v node)"
cat > "$service_tmp" <<EOF
[Unit]
Description=HeartPet Tierverwaltung
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=$node_path $APP_DIR/src/app.js
Restart=always
RestartSec=5
User=$SERVICE_USER
Group=$SERVICE_GROUP
EnvironmentFile=/etc/heartpet/heartpet.env
Environment=HEARTPET_DATA_DIR=$DATA_DIR
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF

run_as_root mkdir -p /etc/heartpet
run_as_root install -m 600 "$env_tmp" /etc/heartpet/heartpet.env
run_as_root install -m 644 "$service_tmp" /etc/systemd/system/heartpet.service

if [ "$CONFIGURE_NGINX" = "yes" ]; then
  if ! command -v nginx >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      run_as_root apt-get update
      run_as_root apt-get install -y nginx
    else
      echo "Fehler: Nginx fehlt und kann auf diesem System nicht automatisch installiert werden."
      exit 1
    fi
  fi
  domain_host="${DOMAIN#https://}"
  domain_host="${domain_host%%:*}"
  nginx_tmp="$(mktemp)"
  sed -e "s/tiere\.example\.de/$domain_host/g" -e "s/127\.0\.0\.1:3000/127.0.0.1:$PORT_VALUE/g" \
    "$APP_DIR/deploy/nginx-heartpet.example.conf" > "$nginx_tmp"
  if [ -d /etc/nginx/sites-available ]; then
    run_as_root install -m 644 "$nginx_tmp" /etc/nginx/sites-available/heartpet
    run_as_root ln -sfn /etc/nginx/sites-available/heartpet /etc/nginx/sites-enabled/heartpet
    run_as_root rm -f /etc/nginx/sites-enabled/default
  else
    run_as_root install -m 644 "$nginx_tmp" /etc/nginx/conf.d/heartpet.conf
  fi
  run_as_root nginx -t
  run_as_root systemctl enable --now nginx
  run_as_root systemctl reload nginx
fi

run_as_root systemctl daemon-reload
run_as_root systemctl enable heartpet
run_as_root systemctl restart heartpet

for _ in $(seq 1 20); do
  if curl --max-time 2 -fsS "http://127.0.0.1:$PORT_VALUE/login" >/dev/null; then break; fi
  sleep 1
done
if ! curl --max-time 2 -fsS "http://127.0.0.1:$PORT_VALUE/login" >/dev/null; then
  echo "Fehler: HeartPet antwortet nicht auf Port $PORT_VALUE."
  run_as_root systemctl status heartpet --no-pager --full || true
  exit 1
fi

echo "HeartPet wurde erfolgreich als systemd-Dienst eingerichtet."
if [ "$MODE" = "domain" ]; then
  echo "Nächster Schritt: TLS-Zertifikat für $DOMAIN einrichten und danach $DOMAIN/setup öffnen."
  if [ "$CONFIGURE_NGINX" = "yes" ]; then echo "Mit Certbot typischerweise: certbot --nginx -d $domain_host"; fi
else
  echo "Öffne http://<LXC-IP>:$PORT_VALUE/setup im Heimnetz."
fi
