# HeartPet

HeartPet ist eine deutschsprachige Webapp für Tierhalter, Gnadenhöfe und kleinere Tierhaltungen. Ziel ist eine zentrale Tierakte pro Tier mit Dokumenten, Tierarztbezug, Medikamenten, Impfungen, Fütterungsplänen, Erinnerungen, Bildern und Exporten.

## Aktueller Stand

HeartPet ist inzwischen ein brauchbares MVP für den Alltag:

- Tierakten mit Stammdaten, Herkunft, Status, Mikrochip, Notizen und Tierarzt
- Tierarzt je Tier und Standard-Tierarzt je Tierart
- Profilbild und Bildergalerie pro Tier
- Dokument-Uploads mit lokalem Dateispeicher
- Dokumentkategorien mit optionalen Pflichtkategorien
- Vorerkrankungen, Medikamente, Impfungen, Fütterungspläne und Protokolle
- Erinnerungen mit E-Mail, Telegram, ntfy, Browser-Hinweisen und Wiederholungen
- Stallkameras per HTTP/MJPEG oder RTSP; RTSP wird serverseitig mit `ffmpeg` umgewandelt
- JSON- und PDF-Export pro Tier
- Import eines HeartPet-JSON-Exports
- Adminbereich für Kommunikation, Benutzer, Tierarten, Tierärzte, Kategorien und Rechtstexte
- Hilfe-Seite direkt in der App

## Technik

- Node.js 20+
- Express
- EJS Templates
- SQLite
- Lokaler Dateispeicher unter `data/uploads`
- `ffmpeg` für Kamera-Standbilder und RTSP-Streams

Kein Docker. Kein externer Objekt-Storage. HeartPet ist für einen einfachen Betrieb auf einem LXC oder Linux-Server gedacht.

## Installation

Das Installationsskript installiert `ffmpeg` über den verfügbaren Linux-Paketmanager und anschließend alle Node.js-Abhängigkeiten:

```bash
chmod +x scripts/install.sh
./scripts/install.sh
```

Unter Debian und Ubuntu entspricht die manuelle FFmpeg-Nachinstallation:

```bash
sudo apt update
sudo apt install -y ffmpeg
sudo systemctl restart heartpet
```

Für einen kurzen Test ohne `systemd`:

```bash
./scripts/start.sh
```

Die App läuft danach standardmäßig unter:

```text
http://127.0.0.1:3000
```

Bei einer neuen Installation erscheint zuerst die Ersteinrichtung unter:

```text
/setup
```

Dort werden in einem kurzen Wizard angelegt:

- der erste Administrator
- der erste Tierarzt
- das erste Tier

Erst danach wird die normale Oberfläche freigeschaltet.

## Konfiguration

HeartPet liest derzeit folgende Umgebungsvariablen:

- `PORT`
- `HEARTPET_SESSION_SECRET`
- `HEARTPET_SESSION_DAYS` (optional, Standard: `30`)
- `HEARTPET_SESSION_STORE` (optional; nicht auf `memory` setzen, wenn Logins Updates ueberleben sollen)

Eine Vorlage liegt in [.env.example](/Users/michael/Programmerierung/HeartPet/.env.example).

Wenn du HeartPet per `systemd` startest, kannst du die Werte direkt über `Environment=` setzen.

## Datenablage

- SQLite Datenbank: `data/heartpet.sqlite`
- Uploads: `data/uploads`
- Exporte: `data/exports`
- Sessions: `data/sessions.sqlite`
- Backups: `data/backups`

## Reverse Proxy / SSL

HeartPet selbst spricht nur HTTP. SSL und Domain wie `heartpet.de` sollten über einen externen Reverse Proxy erledigt werden, zum Beispiel Nginx auf dem Host.

Eine Beispielkonfiguration liegt in:

```text
deploy/nginx-heartpet.example.conf
```

Ziel der Weiterleitung:

```text
http://127.0.0.1:3000
```

## Betrieb mit systemd

Eine Beispiel-Datei liegt in:

```text
deploy/heartpet.service.example
```

Typischer Ablauf:

```bash
sudo cp deploy/heartpet.service.example /etc/systemd/system/heartpet.service
sudo systemctl daemon-reload
sudo systemctl enable --now heartpet
```

Wenn du eine `.env`-Datei verwenden willst, kannst du die Service-Datei erweitern um:

```ini
EnvironmentFile=/opt/HeartPet/.env
```

und danach:

```bash
sudo systemctl daemon-reload
sudo systemctl restart heartpet
```

## Grundlegende Befehle nach der Installation

Typische Betriebsbefehle auf dem LXC:

```bash
sudo systemctl start heartpet
sudo systemctl stop heartpet
sudo systemctl restart heartpet
sudo systemctl status heartpet --no-pager
sudo journalctl -u heartpet -n 100 --no-pager
sudo journalctl -u heartpet -f
```

Ohne `systemd` stehen die mitgelieferten Skripte zur Verfügung:

```bash
./scripts/start.sh
./scripts/stop.sh
./scripts/status.sh
./scripts/logs.sh
```

`npm start` ist nur für kurze manuelle Tests gedacht und blockiert das Terminal im Vordergrund.

## Update

HeartPet bringt ein Update-Skript mit:

```bash
./scripts/update.sh
```

Das Skript:

- erstellt zuerst ein Backup
- prüft Git, Node.js und npm
- holt den aktuellen Stand aus GitHub
- installiert oder aktualisiert Abhängigkeiten
- prüft den App-Load
- startet HeartPet sauber neu

Wenn `heartpet.service` eingerichtet ist, wird der Dienst verwendet. Ohne `systemd` startet HeartPet automatisch im Hintergrund weiter, damit die Shell frei bleibt.

Manuell geht es ebenfalls:

```bash
git pull --ff-only
npm install
./scripts/stop.sh
./scripts/start.sh
```

## Backup und Wiederherstellung

Backup erstellen:

```bash
./scripts/backup.sh
```

Gesichert werden:

- konsistenter SQLite-Snapshot über die SQLite-Backup-API
- Sessions
- Uploads
- Exporte
- Prüfmanifest mit dem Ergebnis der SQLite-Integritätsprüfung

Jedes Backup wird direkt nach der Erstellung geöffnet und mit `PRAGMA integrity_check` geprüft. Der vollständige Build prüft zusätzlich automatisch eine Wiederherstellung inklusive Upload-Datei.

Wiederherstellung erfolgt durch Zurückkopieren des Inhalts eines Backup-Ordners nach `data/`.
Vorher HeartPet stoppen:

```bash
sudo systemctl stop heartpet
```

danach Daten zurückkopieren und wieder starten:

```bash
sudo systemctl start heartpet
```

## Monitoring

- `GET /health` liefert für Uptime Kuma einen minimalen Status ohne interne Details.
- `GET /admin/health` liefert angemeldeten Administratoren Detailprüfungen.
- Der Systemlog zeigt Datenbank, Datenablage, freien Speicher, Backup-Alter, Versandfehler und konfigurierte Integrationen.
- Kritische Fehler bei Datenbank, Schreibzugriff oder Speicherplatz liefern über `/health` HTTP `503`; ein fehlendes Backup erzeugt nur den Zustand `degraded`.

## Schneller LXC-Check

Nach der Installation solltest du mindestens diese Punkte prüfen:

```bash
sudo systemctl status heartpet --no-pager
curl -I http://127.0.0.1:3000
ls -lah data
```

Erwartung:

- der Dienst läuft ohne Neustart-Schleife
- Port `3000` antwortet lokal
- `data/heartpet.sqlite` und `data/sessions.sqlite` werden angelegt
- `data/uploads` existiert

## Reverse Proxy / SSL

## SMTP und Telegram

Die SMTP- und Telegram-Daten werden im Adminbereich hinterlegt.

Telegram Einrichtung:

1. In Telegram `@BotFather` öffnen
2. `/newbot` ausführen
3. Token kopieren
4. Dem Bot einmal schreiben
5. `https://api.telegram.org/botTOKEN/getUpdates` aufrufen
6. `chat.id` aus der Antwort in HeartPet eintragen

## Import / Export

- PDF-Exporte enthalten die wichtigsten Daten einer Tierakte
- JSON-Exporte enthalten einen Import-Hinweis für HeartPet
- Dokument- und Bilddateien werden im HeartPet-JSON-Export eingebettet
- Beim Import werden strukturierte Daten und eingebettete Dateien wiederhergestellt

## Rollen

Aktuell gibt es drei Rollen:

- `Administrator`
- `Benutzer`
- `Nur Lesen`

`Administrator` hat Vollzugriff. `Benutzer` kann unter `Tiere` alles sehen, anlegen, ändern und löschen. `Nur Lesen` darf ausschließlich lesen.

## Hinweise

- Sprache ist aktuell nur Deutsch
- Dateispeicher ist bewusst lokal gehalten
- Dokumente werden nicht versioniert oder signiert
- HeartPet ist für Self-Hosting gedacht und nicht als SaaS aufgebaut
