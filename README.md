# HeartPet

HeartPet ist eine deutschsprachige, selbst gehostete Tierverwaltung für private Halter, Gnadenhöfe und kleinere Tierhaltungen. Die App verwaltet Tierakten, Bilder, Dokumente, Tierärzte, Medikamente, Impfungen, Fütterung und Erinnerungen lokal auf dem eigenen Server.

## Voraussetzungen

- Debian oder Ubuntu mit `systemd`, empfohlen als LXC
- Internetzugang während der Installation
- Eine Domain mit HTTPS oder Zugriff ausschließlich im Heimnetz
- Mindestens 1 GB RAM und ausreichend Speicher für Bilder und Dokumente

Das Installationsskript installiert Node.js 22, npm, ffmpeg und weitere benötigte Pakete automatisch. Docker ist nicht erforderlich.

## Neuinstallation

HeartPet muss außerhalb von `/root` liegen. Auf einem neuen Debian- oder Ubuntu-LXC genügen diese Befehle:

```bash
apt update
apt install -y git
git clone https://github.com/Schello805/HeartPet.git /opt/HeartPet
cd /opt/HeartPet
./scripts/install.sh
```

Das Skript fragt anschließend:

- Betrieb über eine Domain oder nur im Heimnetz
- öffentliche HTTPS-Adresse bei Domainbetrieb
- E-Mail-Adresse des ersten Administrators
- Port und Systembenutzer, normalerweise einfach mit Enter bestätigen
- ob Nginx auf demselben LXC eingerichtet werden soll

Danach installiert und startet es `heartpet.service`. Es zeigt ein zufälliges Einmalpasswort für den ersten Login an. Dieses Passwort muss nach der ersten Anmeldung geändert werden.

Bei einem externen Reverse Proxy dessen Ziel auf `<LXC-IP>:3000` setzen und den Port auf Heimnetz beziehungsweise Proxy beschränken.

Nur für eine Entwicklungsumgebung lassen sich die Abhängigkeiten ohne Dienstkonfiguration installieren:

```bash
./scripts/install.sh --dependencies-only
```

## Erster Login

Die Anmeldung erfolgt mit der während der Installation angegebenen E-Mail-Adresse und dem ausgegebenen Einmalpasswort. Eine E-Mail-Bestätigung und ein SMTP-Server sind dafür nicht erforderlich.

Falls das Einmalpasswort verloren ging:

```bash
cd /opt/HeartPet
node scripts/reset-admin-password.js admin@example.de --generate
systemctl restart heartpet
```

Der Befehl erzeugt ein neues Einmalpasswort und beendet bestehende Sitzungen. Mit folgender Diagnose lässt sich der lokale Anmeldeweg prüfen, ohne das Passwort auszugeben:

```bash
node scripts/check-admin-login.js admin@example.de
```

## Betrieb

Status und Protokoll:

```bash
cd /opt/HeartPet
./scripts/status.sh
curl -fsS http://127.0.0.1:3000/health
journalctl -u heartpet -n 100 --no-pager
```

Dienst neu starten:

```bash
systemctl restart heartpet
```

`GET /health` liefert einen knappen öffentlichen Status. Angemeldete Administratoren sehen unter `GET /admin/health` weitere Diagnosen.

## Updates

```bash
cd /opt/HeartPet
./scripts/update.sh
```

Das Update erstellt zuerst ein Backup, installiert Abhängigkeiten, aktiviert die neue Revision atomar und prüft anschließend Dienst und Health-Status. Bei einem fehlgeschlagenen Start wird das vorherige Release wiederhergestellt. Daten, Uploads und Sitzungen bleiben außerhalb des Releases erhalten, sodass ein Update normalerweise nicht abmeldet.

## Backup

```bash
cd /opt/HeartPet
./scripts/backup.sh
```

Die dauerhaften Daten liegen unter `/opt/HeartPet/data`:

- `heartpet.sqlite`: Tier- und Konfigurationsdaten
- `sessions.sqlite`: aktive Sitzungen
- `uploads/`: Bilder und Dokumente
- `backups/`: geprüfte Sicherungen

Profil- und Galeriebilder werden beim Upload automatisch verkleinert und als WebP gespeichert. Vorhandene Bilder lassen sich prüfen und optimieren:

```bash
npm run images:audit
npm run images:optimize
```

## Reverse Proxy

HeartPet stellt intern HTTP bereit. HTTPS endet am Reverse Proxy. Für Nginx liegt eine Vorlage unter `deploy/nginx-heartpet.example.conf`.

Bei einem externen Proxy:

- Ziel: `http://<LXC-IP>:3000`
- öffentliche Adresse: die bei der Installation angegebene HTTPS-Domain
- `Host`, `X-Forwarded-For` und möglichst `X-Forwarded-Proto` weitergeben
- Port 3000 nicht öffentlich ins Internet freigeben

Die Installation setzt die Session-Cookies für diesen Aufbau automatisch passend.

## Entwicklung und Tests

```bash
npm install
npm test
npm run verify
npm start
```

Technisch verwendet HeartPet Node.js, Express, EJS und SQLite. Dokumente und Bilder bleiben im lokalen Dateisystem. Die App ist für eine einzelne selbst gehostete Instanz und nicht als Mehrmandanten-SaaS ausgelegt.

## Rollen

- `Administrator`: vollständige Verwaltung
- `Benutzer`: Tiere und Akteneinträge verwalten
- `Nur Lesen`: ausschließlich lesender Zugriff

Die Oberfläche und Hilfe sind derzeit deutschsprachig.
