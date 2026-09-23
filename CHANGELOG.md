# Änderungsprotokoll

Alle wesentlichen Änderungen an HeartPet werden hier absteigend dokumentiert.

## 0.10.88 - 23.09.2026

- Atomare Updates starten systemd direkt aus dem unveränderlichen Release-Verzeichnis und prüfen dessen Revision und Commit vor der Aktivierung.
- Fehlgeschlagene Deployments stellen neben dem Release-Link auch den vorherigen systemd-Startpfad wieder her und zeigen den Prozess auf dem App-Port an.

## 0.10.86 - 23.09.2026

- Der Hinweis für einen veralteten Serverprozess funktioniert unabhängig vom Installationsordner.

## 0.10.85 - 23.09.2026

- Bei einem noch laufenden alten Serverprozess werden Versorgung und Kalenderexport nicht mehr als defekte Links angezeigt.
- Administratoren erhalten bei einem gemischten Versionsstand einen sichtbaren Hinweis mit dem vollständigen Updatebefehl.

## 0.10.84 - 23.09.2026

- Gemischte Versionsstände blenden TBA, Updateprüfung und Web-App-Manifest sicher aus, bis der Serverprozess neu gestartet wurde.
- Web-App-Metadaten verwenden zusätzlich den aktuellen browserübergreifenden Standard.

## 0.10.83 - 23.09.2026

- Der Systemlog bleibt mit älteren Audit-Einträgen und bei unvollständigen optionalen Stammdaten erreichbar.

## 0.10.82 - 23.09.2026

- Der Footer prüft für Administratoren ausfallsicher auf neue GitHub-Versionen und zeigt den benötigten Updatebefehl an.

## 0.10.81 - 23.09.2026

- Beim Erledigen einer Impf-Erinnerung wird das tatsächliche Impfdatum abgefragt und im Impfeintrag gespeichert.

## 0.10.80 - 23.09.2026

- Bei medizinischen Ereignissen mit „Durch Tierarzt“ muss wieder ein konkreter Tierarzt gewählt werden. Fehlt die Auswahl, bietet ein Modal direkt die Auswahl oder das Entfernen des Hakens an.
- Das Bundesland der Instanz kann neben der Zeitzone ausgewählt werden.
- Die Historie enthält einen quellenbasierten Akkordeon-Hinweis zu Bestattung und Tierkörperbeseitigung mit Rechtsstand, amtlichen Links und einer Warnung für Nutztiere und Seuchenverdacht.
- Tierkörperbeseitigungsanlagen können mit Adresse, Kontakt, Website, Öffnungszeiten, Preisen und Abholservice vollständig in den Stammdaten verwaltet werden.

## 0.10.79 - 21.09.2026

- Termine und offene Erinnerungen lassen sich global oder je Tier als Kalenderdatei exportieren.
- Das mobile Dashboard bietet eine kompakte Schnellerfassung.
- Neue Versorgungsverwaltung für Vorräte, Mindestbestände, Haltbarkeit und Kosten.
- Tieralter zeigt Jahre immer zusammen mit den vollen Monaten und keine Tage mehr.
- Profil- und Galeriebilder werden beim Upload automatisch verkleinert und als WebP gespeichert.
- Android- und andere unterstützte Smartphone-Browser bieten die Installation als Web-App an.
- App-Logo, Favicons und Web-App-Icons verwenden einheitlich das konfigurierte Logo.

## 0.10.78 - 20.09.2026

- Zeitzone ist direkt in den Benachrichtigungseinstellungen auswählbar und bleibt bei Altinstallationen verfügbar.
- SMTP-, Telegram- und ntfy-Bereiche sind als geschlossene Akkordeons strukturiert und zeigen ihren Status im Kopf.
- Installation, Einmalpasswort, Passwortwechsel und Passwort-Zurücksetzung wurden vereinfacht und robuster geprüft.
- Sessions bleiben bei atomaren Updates erhalten; Health-Check und aktiver Revisionsstand werden geprüft.
- Profil- und Galeriebilder sind auf Smartphones vollständig anlegbar, änderbar und löschbar.
