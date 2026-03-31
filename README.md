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
- Erinnerungen mit E-Mail, Telegram, Browser-Hinweisen und Wiederholungen
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

Kein Docker. Kein externer Objekt-Storage. HeartPet ist für einen einfachen Betrieb auf einem LXC oder Linux-Server gedacht.

## Installation

```bash
npm install
npm start
```

Die App läuft danach standardmäßig unter:

```text
http://127.0.0.1:3000
```

Standard-Login beim ersten Start:

```text
E-Mail: admin@heartpet.local
Passwort: admin123!
```

Dieses Passwort sollte direkt im Adminbereich geändert werden.

## Konfiguration

HeartPet liest derzeit folgende Umgebungsvariablen:

- `PORT`
- `HEARTPET_SESSION_SECRET`

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

## Backup

Ein separates Backup-Skript liegt unter:

```bash
./scripts/backup.sh
```

Gesichert werden:

- Datenbank
- WAL-/SHM-Dateien
- Sessions
- Uploads
- Exporte

## Updates aus GitHub

Ein einfaches Updateskript liegt unter:

```bash
./scripts/update.sh
```

Das Skript:

- erstellt zuerst ein Backup
- holt den aktuellen Stand aus GitHub
- installiert oder aktualisiert Abhängigkeiten

Wenn HeartPet über `systemd` läuft, den Dienst danach neu starten:

```bash
sudo systemctl restart heartpet
```

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
- Dokument- und Bilddateien selbst werden aktuell nicht in den JSON-Export eingebettet
- Beim Import werden deshalb derzeit nur strukturierte Daten sicher übernommen, keine Binärdateien

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
