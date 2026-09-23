#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMMAND="${1:-help}"
if [ "$#" -gt 0 ]; then shift; fi

show_help() {
  cat <<'EOF'
HeartPet verwalten

Aufruf: ./scripts/heartpet.sh <Befehl> [Optionen]

  status                 Dienststatus anzeigen
  doctor                 Dienst, Konfiguration und Health-Endpunkt prüfen
  start|stop             HeartPet starten oder stoppen
  update                 Installation aktualisieren
  backup                 Sicherung erstellen
  logs                   Dienstprotokoll anzeigen
  password <E-Mail>      Administratorpasswort interaktiv ändern
  password <E-Mail> --generate
                         Einmalpasswort erzeugen
  verify                 Vollständige Projektprüfung ausführen
EOF
}

run_doctor() {
  local failed=0
  echo "== Dienst =="
  "$APP_DIR/scripts/status.sh" || failed=1

  echo
  echo "== Laufzeit =="
  if command -v node >/dev/null 2>&1; then
    echo "Node.js: $(node --version)"
  else
    echo "Fehler: Node.js fehlt."
    failed=1
  fi
  if command -v npm >/dev/null 2>&1; then
    echo "npm: $(npm --version)"
  else
    echo "Fehler: npm fehlt."
    failed=1
  fi

  echo
  echo "== Health =="
  if command -v curl >/dev/null 2>&1 && curl --fail --silent --show-error "http://127.0.0.1:${PORT:-3000}/health"; then
    echo
  else
    echo "Health-Endpunkt ist nicht erreichbar oder meldet einen Neustartbedarf."
    failed=1
  fi

  if command -v systemctl >/dev/null 2>&1 && systemctl cat heartpet >/dev/null 2>&1; then
    echo
    echo "== systemd =="
    systemctl show heartpet -p WorkingDirectory -p ExecStart -p MainPID -p ActiveState --no-pager
  fi

  return "$failed"
}

case "$COMMAND" in
  status|start|stop|update|backup|logs)
    exec "$APP_DIR/scripts/$COMMAND.sh" "$@"
    ;;
  doctor)
    run_doctor
    ;;
  password)
    if [ "$#" -lt 1 ]; then
      echo "Fehler: E-Mail-Adresse fehlt." >&2
      show_help >&2
      exit 1
    fi
    exec node "$APP_DIR/scripts/reset-admin-password.js" "$@"
    ;;
  verify)
    exec npm --prefix "$APP_DIR" run verify
    ;;
  help|-h|--help)
    show_help
    ;;
  *)
    echo "Unbekannter Befehl: $COMMAND" >&2
    show_help >&2
    exit 1
    ;;
esac
