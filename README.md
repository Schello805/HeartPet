# HeartPet

HeartPet ist eine deutschsprachige Webapp fuer Tierhalter, Gnadenhoefe und kleinere Tierhaltungen. Ziel ist eine zentrale Tierakte pro Tier mit Dokumenten, Tierarztbezug, Medikamenten, Impfungen, Fuetterungsplaenen, Erinnerungen und Exporten.

## Funktionsumfang im aktuellen MVP

- Tierakten mit Stammdaten, Herkunft, Status, Mikrochip, Notizen und Tierarzt
- Tierarzt je Tier und Standard-Tierarzt je Tierart
- Dokument-Uploads mit lokalem Dateispeicher und frei verwaltbaren Kategorien
- Vorerkrankungen, Medikamente, Impfungen, Fuetterungsplaene und Protokolle
- Erinnerungen mit E-Mail- und Telegram-Kanaelen
- Browser-Hinweise bei offenen Erinnerungen
- JSON-Export mit Import-Hinweis und PDF-Export pro Tier
- Adminbereich fuer SMTP, Telegram, Benutzer, Tierarten, Tieraerzte und Kategorien
- Hilfe-Seite direkt in der App

## Technik

- Node.js 20+
- Express
- EJS Templates
- SQLite
- Lokaler Dateispeicher unter `data/uploads`

Kein Docker. Kein externer Objekt-Storage. Die App ist fuer einen einfachen Betrieb auf einem LXC oder Linux-Server gedacht.

## Installation

```bash
npm install
npm start
```

Die App laeuft danach standardmaessig unter:

```text
http://127.0.0.1:3000
```

Standard-Login beim ersten Start:

```text
E-Mail: admin@heartpet.local
Passwort: admin123!
```

Dieses Passwort sollte direkt im Adminbereich geaendert werden.

## Datenablage

- SQLite Datenbank: `data/heartpet.sqlite`
- Uploads: `data/uploads`
- Exporte: `data/exports`
- Sessions: `data/sessions.sqlite`

## Reverse Proxy / SSL

HeartPet selbst spricht nur HTTP. SSL und Domain wie `heartpet.de` sollten ueber einen externen Reverse Proxy erledigt werden, z. B. Nginx oder Traefik auf dem Host.

Beispielziel:

```text
http://127.0.0.1:3000
```

## SMTP und Telegram

Die SMTP- und Telegram-Daten werden im Adminbereich hinterlegt.

Telegram Einrichtung:

1. In Telegram `@BotFather` oeffnen
2. `/newbot` ausfuehren
3. Token kopieren
4. Dem Bot einmal schreiben
5. `https://api.telegram.org/botTOKEN/getUpdates` aufrufen
6. `chat.id` aus der Antwort in HeartPet eintragen

## Updates aus GitHub

Ein einfaches Updateskript liegt unter:

```bash
./scripts/update.sh
```

Das Skript:

- sichert Datenbank und Uploads
- macht `git pull --ff-only`
- fuehrt `npm install` aus

Wenn HeartPet ueber `systemd` laeuft, den Dienst danach neu starten.

## Deployment mit systemd

Beispiel fuer `/etc/systemd/system/heartpet.service`:

```ini
[Unit]
Description=HeartPet
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/HeartPet
ExecStart=/usr/bin/npm start
Restart=always
User=www-data
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
```

Danach:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now heartpet
```

## Hinweise

- PDF-Exporte enthalten die wichtigsten Daten einer Tierakte.
- JSON-Exporte enthalten einen Import-Hinweis fuer HeartPet.
- Dokumentdateien werden lokal gespeichert und nicht versioniert.
- Sprache ist aktuell nur Deutsch.
