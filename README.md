# RevierApp

Jagd-Webanwendung für die Jagdgemeinschaft eines Reviers: aktuelles Wetter mit Wind, Revierkarte mit Grenzen, Kanzeln und Wildkameras, Ein-/Auschecken mit Push-Nachrichten, angekündigte Ansitze mit Lese- und Bestätigungsquittung sowie eine Planungsabteilung für Drückjagden. Mehrere Personen können die App gleichzeitig nutzen, Änderungen erscheinen bei allen sofort.

## Funktionen

- **Wetter** (Open-Meteo, kein API-Schlüssel nötig): Temperatur, gefühlte Temperatur, Luftdruck, Luftfeuchte, Bewölkung, Windrichtung/-geschwindigkeit/Böen mit Kompass, 24-Stunden- und 7-Tage-Vorhersage, Sonnenauf-/-untergang, Mondphase und ein jagdlicher Hinweis zum Wind.
- **Karte** (Leaflet, topografisch / Straße / Luftbild): Reviergrenze als Polygon zeichnen und bearbeiten, Kanzeln, Wildkameras und Kirrungen per Tipp setzen, verschieben, benennen. Besetzte Kanzeln pulsieren rot, angekündigte sind gold umrandet. Windpfeil direkt auf der Karte, eigener Standort per GPS.
- **Ein-/Auschecken**: „Pirsch“ oder konkrete Kanzel mit Notiz. Alle anderen Nutzer bekommen eine Push-Nachricht beim Ein- und Auschecken.
- **Ankündigen** („Ich möchte heute ca. 21 Uhr auf Kanzel X“): alle Nutzer werden per Push informiert, sehen die Anfrage und können sie bestätigen (optional mit Kommentar). Der Antragsteller sieht pro Nutzer: nicht gelesen ○, gelesen ✓, bestätigt ✓✓, und erhält bei Bestätigung selbst eine Push-Nachricht. Aus der Ankündigung kann direkt eingecheckt werden.
- **Drückjagd-Planung**: Jagden mit Datum, Treffpunkt, Jagdleitung, Belehrungstext und Status; Teilnehmer mit Rolle (Jagdleiter, Schütze, Treiber, Hundeführer, Ansteller, Helfer), Standzuweisung, Treiben-Zuordnung und Zusage; Treiben mit Zeiten und Notizen; Checkliste mit Standardaufgaben; Streckenliste.
- **Echtzeit**: WebSocket-Broadcast, Online-Anzeige, In-App-Benachrichtigungsliste.
- **PWA**: installierbar auf Android/iOS (Zum Home-Bildschirm), Web-Push über VAPID, Offline-Cache der App-Hülle.

## Schnellstart zum Ausprobieren (mit Demodaten)

Voraussetzung: Node.js 22.13 oder neuer von https://nodejs.org (nutzt das eingebaute `node:sqlite`).

- **Windows**: Doppelklick auf `start.bat`
- **macOS / Linux**: `bash start.sh`

Das Skript installiert die Abhängigkeiten, spielt ein Demo-Revier ein (Grenze, vier Kanzeln, Wildkameras, Kirrung, eine laufende Anwesenheit, eine Ankündigung mit Bestätigungen und eine geplante Drückjagd) und öffnet http://localhost:3000.

Demo-Zugänge: **Hans / demo**, **Grete / demo**, **Karl / demo**. Für den Mehrbenutzer-Test im zweiten Browserfenster (Inkognito) als Grete anmelden.

Die Demodaten werden nur in eine leere Datenbank geschrieben. Zum Zurücksetzen den Ordner `data/` löschen.

## Ohne eigenen Computer testen (iPad, Tablet, Handy) mit GitHub Codespaces

1. Auf GitHub anmelden und dieses Repository öffnen, Branch `claude/revierapp` wählen.
2. Grüner Button „Code“ → Reiter „Codespaces“ → „Create codespace on claude/revierapp“.
3. Zwei bis drei Minuten warten. Der Codespace installiert alles und startet die App mit Demodaten automatisch.
4. Es öffnet sich ein Tab mit der App. Falls nicht: unten den Reiter „Ports“ (bzw. „Anschlüsse“) wählen und bei Port 3000 auf das Globus-Symbol tippen.

Demo-Zugänge wie oben: Hans / demo, Grete / demo, Karl / demo. Die Adresse (`…-3000.app.github.dev`) ist HTTPS, also funktionieren auch Standort und Push. Standardmäßig ist der Port privat, nur dein GitHub-Konto kommt an die App. Sollen andere mittesten, im Reiter „Ports“ mit Rechtsklick bzw. langem Tippen auf Port 3000 die Sichtbarkeit auf „Public“ stellen.

Codespaces ist für private GitHub-Konten mit 60 Stunden pro Monat kostenlos. Ein Codespace stoppt nach 30 Minuten ohne Aktivität und wird über die Codespaces-Übersicht wieder gestartet. Die Daten bleiben erhalten, solange der Codespace existiert.

## Start im echten Betrieb

```bash
npm install
npm start
```

Danach http://localhost:3000 öffnen.

### Zugang für die Jäger: Einladungscode

- Der **erste Nutzer** legt bei der Registrierung den Einladungscode des Reviers fest und wird automatisch **Admin**.
- Alle weiteren Jäger registrieren sich selbst mit Name, eigenem Passwort und diesem Einladungscode. Ohne Code ist keine Registrierung möglich.
- Der Admin findet unter „Mehr → Verwaltung“ den Code, kann ihn ändern, per „Einladung teilen“ einen fertigen Einladungstext verschicken, Nutzern ein neues Startpasswort erzeugen, weitere Admins ernennen und Nutzer entfernen.
- Jeder Nutzer kann unter „Mehr → Konto“ sein Passwort ändern.
- Alternativ lässt sich der Code fest über die Umgebungsvariable `INVITE_CODE` vorgeben.

Demodaten verwenden den Einladungscode `demo`.

### Umgebungsvariablen

| Variable | Bedeutung | Standard |
|---|---|---|
| `PORT` | HTTP-Port | `3000` |
| `DATA_DIR` | Verzeichnis für SQLite-Datenbank und VAPID-Schlüssel | `./data` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Eigene Web-Push-Schlüssel (werden sonst beim ersten Start erzeugt) | automatisch |
| `INVITE_CODE` | Fester Einladungscode; sonst legt ihn der erste Nutzer fest | – |
| `VAPID_SUBJECT` | Kontakt für Push-Dienste, z. B. `mailto:ich@example.com` | `mailto:revier@example.com` |
| `TZ` | Zeitzone für Push-Texte | `Europe/Berlin` |

### Betrieb

Für Push-Nachrichten, GPS-Standort und PWA-Installation muss die App über **HTTPS** erreichbar sein (z. B. hinter Caddy, nginx oder einem Tunnel). Lokal funktioniert `http://localhost` ebenfalls. Auf dem iPhone müssen Nutzer die App zuerst über „Teilen → Zum Home-Bildschirm“ installieren, bevor Push erlaubt werden kann.

```bash
# Mit Docker
docker build -t revierapp .
docker run -p 3000:3000 -v revierdaten:/app/data revierapp
```

## Veröffentlichen (Hosting)

Die App braucht einen dauerhaft laufenden Node-Server (WebSockets, SQLite-Datei). Reine Static-Hoster wie Netlify oder GitHub Pages reichen dafür nicht. Zwei vorbereitete Wege:

### Render (empfohlen, wenige Klicks)

1. Auf https://render.com anmelden und GitHub verbinden.
2. „New +“ → „Blueprint“ → dieses Repository und den Branch wählen. Render liest `render.yaml`.
3. Unter Environment die Variable `VAPID_SUBJECT` auf die eigene E-Mail setzen (`mailto:…`).
4. „Apply“. Nach dem Build ist die App unter `https://revierapp-xxxx.onrender.com` erreichbar, mit HTTPS, also Push-fähig.

Die SQLite-Datenbank und die Push-Schlüssel liegen auf der Persistent Disk unter `/var/data` und überleben Neustarts und Deploys. Persistent Disks gibt es ab dem Starter-Plan. Auf dem Free-Plan läuft die App ebenfalls, verliert aber bei jedem Deploy die Daten und schläft nach 15 Minuten ohne Zugriffe ein.

### Fly.io (kostenloses Kontingent mit Volume)

```bash
curl -L https://fly.io/install.sh | sh
fly auth login
fly launch --copy-config --no-deploy     # App-Namen wählen, Region fra
fly volumes create revierdaten --region fra --size 1
fly deploy
fly open
```

`fly.toml` hält eine Instanz dauerhaft am Laufen und hängt das Volume unter `/app/data` ein.

### Nach dem Deploy

- Jeder Jäger öffnet die URL, registriert sich und aktiviert unter „Mehr“ die Push-Benachrichtigungen.
- Auf dem iPhone zuerst „Teilen → Zum Home-Bildschirm“, dann Push aktivieren.
- Unter „Mehr“ die Karte an das Revier schieben und „Kartenausschnitt als Mittelpunkt speichern“, damit das Wetter für das Revier gilt.

## Tests

```bash
npm test
```

Die Tests starten den Server mit einer temporären Datenbank und prüfen Registrierung, Revierobjekte, Ein-/Auschecken mit Benachrichtigungen, Ankündigungen mit Lese-/Bestätigungsquittung, Drückjagd-Planung und Push-Abonnements.

## Technik

- Backend: Node.js, Express, `node:sqlite`, `ws`, `web-push`
- Frontend: Vanilla JS (ES-Modul), Leaflet + Leaflet.draw (lokal eingebunden), Service Worker
- Karten: OpenTopoMap, OpenStreetMap, Esri World Imagery · Wetter: Open-Meteo
