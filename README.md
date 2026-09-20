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

Auf Debian, Fedora/RHEL und Alpine installiert `scripts/install.sh` fehlende
Grundpakete einschließlich Node.js und npm automatisch aus den jeweiligen
Paketquellen. Anschließend wird geprüft, ob mindestens Node.js 20 vorhanden ist.

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
- `HEARTPET_HOST` (optional, Standard: `0.0.0.0` fuer Zugriff im Heimnetz; `127.0.0.1` fuer nur lokal)
- `HEARTPET_APP_URL` (optional, Basis-URL fuer Links in E-Mails/Erinnerungen, falls keine Domain in den Einstellungen gesetzt ist)
- `HEARTPET_SESSION_SECRET`
- `HEARTPET_SESSION_DAYS` (optional, Standard: `30`)
- `HEARTPET_SESSION_STORE` (optional; `memory` wird aus Sicherheitsgründen ausschließlich mit `NODE_ENV=test` verwendet)

Eine Vorlage liegt in [.env.example](/Users/michael/Programmerierung/HeartPet/.env.example).

Wenn du HeartPet per `systemd` startest, kannst du die Werte direkt über `Environment=` setzen.

## Datenablage

- SQLite Datenbank: `data/heartpet.sqlite`
- Uploads: `data/uploads`
- Exporte: `data/exports`
- Sessions: `data/sessions.sqlite`
- Backups: `data/backups`

### Updates ohne erzwungenen Logout

Der Session-Schlüssel liegt dauerhaft in `data/.session-secret`. Zusammen mit
`data/sessions.sqlite` darf dieser Ordner bei Updates nicht verschoben,
gelöscht oder durch einen temporären Release-Ordner ersetzt werden. Das
mitgelieferte `scripts/update.sh` und `scripts/deploy-release.sh` verwenden
deshalb immer `data/` außerhalb des Releases.

Nach einem Update kannst du die aktive Revision und den Dienst prüfen:

```bash
./scripts/status.sh
curl -fsS http://127.0.0.1:3000/health
```

Wenn eine ältere Installation den Session-Schlüssel bereits verloren hat,
musst du dich einmal neu anmelden. Danach bleiben Sitzungen bei weiteren
Updates erhalten. Prüfe bei manuellen systemd-Units zusätzlich:

```bash
systemctl show heartpet -p WorkingDirectory -p Environment
```

Die Ausgabe muss `HEARTPET_DATA_DIR=.../data` enthalten.

Tier-Profilbilder und Galeriebilder werden beim Upload automatisch auf WebP verkleinert. Bereits vorhandene Tierbilder kannst du erst prüfen und danach gezielt optimieren:

```bash
npm run images:audit
npm run images:optimize
```

## Reverse Proxy / SSL

HeartPet selbst spricht nur HTTP. SSL und die eigene Domain sollten über einen externen Reverse Proxy erledigt werden, zum Beispiel Nginx auf dem Host.

Eine Beispielkonfiguration liegt in:

```text
deploy/nginx-heartpet.example.conf
```

Ziel der Weiterleitung:

```text
http://127.0.0.1:3000
```

### Separate Installation in einem weiteren LXC

HeartPet ist nicht mandantenfähig. Jede Person benötigt deshalb eine eigene
Instanz mit eigenem LXC, eigener Datenbank und eigenem `data/`-Verzeichnis.
Eine weitere Domain darf nicht einfach auf eine bestehende Instanz zeigen,
wenn die Datenbestände getrennt bleiben sollen.

Für einen neuen LXC empfiehlt sich folgende Grundkonfiguration:

```bash
git clone https://github.com/Schello805/HeartPet.git /opt/HeartPet
cd /opt/HeartPet
./scripts/install.sh --configure
```

Der Assistent fragt nach Heimnetz- oder Domainbetrieb, Port und Dienstbenutzer,
legt den dauerhaften Datenpfad fest und richtet systemd ein. Im Domainbetrieb
kann er außerdem Nginx vorbereiten. Eine unbeaufsichtigte Installation ist
ebenfalls möglich:

```bash
./scripts/install.sh --configure --mode domain --domain https://tiere.example.de --user www-data --nginx --yes
```

Installiere HeartPet nicht unter `/root`: Ein gehärteter Dienstbenutzer kann
diesen Pfad nicht betreten. Für LXC-Installationen ist `/opt/HeartPet` vorgesehen.

Danach:

1. DNS-Eintrag der Domain auf den neuen LXC beziehungsweise Reverse Proxy setzen.
2. `tiere.example.de` in `deploy/nginx-heartpet.example.conf` ersetzen. Das Beispiel setzt Nginx im selben LXC voraus.
3. Nginx-Konfiguration aktivieren und ein TLS-Zertifikat einrichten.
4. In `/setup` einen eigenen Administrator und die neue Haltung anlegen.
5. Unter `Verwaltung > Systemlog` die Installationsdiagnose prüfen.
6. Ein Backup erstellen und eine Wiederherstellung testen.

Neue Installationen enthalten keine voreingestellte Domain und keinen
voreingestellten Wetterstandort. Bleibt die öffentliche Adresse im Setup leer,
verwendet HeartPet `HEARTPET_APP_URL`. Eine später im Adminbereich gespeicherte
Domain hat Vorrang vor der Umgebungsvariable.

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
- baut bei `systemd` ein unveränderliches Release mit eigenen Abhängigkeiten
- prüft den App-Load vor der Aktivierung
- schaltet den `current`-Symlink atomar auf das neue Release um
- startet HeartPet verbindlich neu und prüft `/health` auf die erwartete Revision
- aktiviert bei einem fehlgeschlagenen Start automatisch wieder das vorherige Release

Wenn `heartpet.service` eingerichtet ist, wird der atomare Release-Pfad verwendet. Daten und Uploads bleiben unabhängig vom Release dauerhaft im gemeinsamen `data`-Verzeichnis. Ohne `systemd` nutzt das Skript weiterhin die direkte Installation und startet HeartPet automatisch im Hintergrund, damit die Shell frei bleibt.

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
