/**
 * Erzeugt das Anwenderhandbuch als PDF: startet die App mit Demodaten, nimmt Screenshots auf und rendert
 * docs/RevierApp-Handbuch.pdf.   Aufruf: node docs/handbuch/build.mjs   (benötigt Playwright + Chromium)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const imgDir = path.join(here, 'img'); fs.mkdirSync(imgDir, { recursive: true });
const PORT = 3990 + Math.floor(Math.random() * 9);
const BASE = `http://localhost:${PORT}`;

// ---------- Demo-Server ----------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handbuch-'));
const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', 'server/index.js'], { cwd: root, env: { ...process.env, PORT, DATA_DIR: dataDir, DEMO: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(res => server.stdout.on('data', d => { if (String(d).includes('läuft')) res(); }));

// ---------- Browser ----------
const fixture = JSON.parse(fs.readFileSync(path.join(here, 'weather-fixture.json'), 'utf8'));
fixture.moon = { age: 19, illumination: 72, name: 'Abnehmender Mond', index: 5 }; fixture.fetched_at = new Date().toISOString();
// Schematischer Kartenhintergrund statt echter Kacheln (Handbuch wird ohne Internetzugang erzeugt)
const tile = (x, y) => { const g = (x * 7 + y * 13) % 5; const shades = ['#cfd9b8', '#c6d2ae', '#d6dcc0', '#c9d6b4', '#d2d8bd']; return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="${shades[g]}"/><path d="M0 ${60 + g * 30}h256M${40 + g * 20} 0v256" stroke="#b9c4a0" stroke-width="2"/><circle cx="${180 - g * 20}" cy="${90 + g * 25}" r="${22 + g * 4}" fill="#9fb98a" opacity=".55"/></svg>`; };
const browser = await chromium.launch();
async function makeContext(mobile = true) {
  const ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, geolocation: { latitude: 50.95, longitude: 10.21 }, permissions: ['geolocation'] } : { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5 });
  await ctx.route('**/api/weather**', r => r.fulfill({ json: fixture }));
  await ctx.route(/tile\.opentopomap|tile\.openstreetmap|arcgisonline/, r => { const m = r.request().url().match(/\/(\d+)\/(\d+)\/(\d+)/); r.fulfill({ contentType: 'image/svg+xml', body: tile(Number(m?.[2] || 0), Number(m?.[3] || 0)) }); });
  await ctx.route(/fonts\.g/, r => r.abort());
  return ctx;
}
const shots = {};
async function shot(page, name, opts = {}) { const file = path.join(imgDir, name + '.png'); await page.screenshot({ path: file, ...opts }); shots[name] = file; }
async function login(page, name = 'Hans') {
  await page.goto(BASE + '/'); await page.waitForSelector('#auth:not(.hidden)');
  await page.fill('input[name=name]', name); await page.fill('input[name=password]', 'demo'); await page.click('#btn-login');
  await page.waitForSelector('#app:not(.hidden)'); await page.waitForTimeout(1500);
}
const closePopup = p => p.evaluate(() => { document.querySelector('.leaflet-popup-close-button')?.click(); document.querySelector('#dialog')?.close(); });
// Hohe Ansicht für große Popups: Viewport vergrößern, nur Kopf + Karte aufnehmen, danach zurücksetzen
const withTall = async (p, fn) => { await p.setViewportSize({ width: 390, height: 1200 }); await p.waitForTimeout(500); try { await fn(); } finally { await p.setViewportSize({ width: 390, height: 844 }); await p.waitForTimeout(500); } };
// Popup ganz in die Karte holen (Tastatur-Pan, hält das Popup offen)
const fitPopup = async (p) => { const pb = await p.locator('.leaflet-popup').boundingBox(); const mb = await p.locator('.map-wrap').boundingBox(); if (!pb || !mb) return; const need = mb.y + 12 - pb.y; if (need > 0) { await p.locator('#map').focus(); for (let i = 0; i < Math.ceil(need / 80); i++) { await p.keyboard.press('ArrowUp'); await p.waitForTimeout(350); } await p.waitForTimeout(400); } };
const shotMap = async (p, name) => { const b = await p.locator('.map-wrap').boundingBox(); await shot(p, name, { clip: { x: 0, y: 0, width: 390, height: Math.round(b.y + b.height) } }); };

const ctx = await makeContext(true);
const p = await ctx.newPage(); p.on('dialog', d => d.accept()); p.setDefaultTimeout(8000);
const step = async (name, fn) => { try { await fn(); } catch (e) { console.warn('Schritt übersprungen:', name, '-', e.message.split('\n')[0]); } };
await p.goto(BASE + '/'); await p.waitForSelector('#auth:not(.hidden)'); await p.waitForTimeout(300);
await shot(p, 'login');
await login(p, 'Hans');
await shot(p, 'karte');
const box = await p.locator('#map').boundingBox();
await step('kanzel-popup', async () => { await withTall(p, async () => { await p.locator('.marker.kanzel').first().dispatchEvent('click'); await p.waitForTimeout(600); await fitPopup(p); await shotMap(p, 'kanzel-popup'); await closePopup(p); }); });
await step('kanzel-dialog', async () => { await p.goto(BASE + '/#mehr'); await p.waitForTimeout(600); await p.locator('#features-list .item:has-text("Kanzel") [data-edit]').first().click(); await p.waitForTimeout(400); await shot(p, 'kanzel-dialog'); await closePopup(p); await p.goto(BASE + '/#karte'); await p.waitForTimeout(800); });
await step('await p.click(\'.tool[data-tool=layer]\'); await p.w', async () => { await p.click('.tool[data-tool=layer]'); await p.waitForTimeout(300); await shot(p, 'ebenen'); await p.click('.tool[data-tool=layer]'); });
await step('await p.click(\'.tool[data-tool=messen]\'); await p.', async () => { await p.click('.tool[data-tool=messen]'); await p.waitForTimeout(300); });
for (const [x, y] of [[0.25, 0.6], [0.5, 0.62], [0.6, 0.4]]) { await p.touchscreen.tap(box.x + box.width * x, box.y + box.height * y); await p.waitForTimeout(500); }
await step('messen', async () => { await p.waitForTimeout(400); await shot(p, 'messen'); await p.click('.tool[data-tool=messen]'); await p.waitForTimeout(300); });
await step('await p.click(\'.tool[data-tool=faehrte]\'); await p', async () => { await p.click('.tool[data-tool=faehrte]'); await p.waitForTimeout(300); await p.touchscreen.tap(box.x + box.width * 0.6, box.y + box.height * 0.72); await p.waitForTimeout(500); await shot(p, 'faehrte-dialog'); await closePopup(p); });
await step('anschuss-popup', async () => { await p.click('#tools-toggle'); await p.waitForTimeout(300); await withTall(p, async () => { await p.locator('.leaflet-marker-icon .shot').first().dispatchEvent('click'); await p.waitForTimeout(800); await fitPopup(p); await shotMap(p, 'anschuss-popup'); await p.click('.leaflet-popup [data-act=flucht]'); await p.waitForTimeout(500); await shotMap(p, 'fluchtweg'); await p.click('#path-cancel'); await p.waitForTimeout(300); }); await p.click('#tools-toggle'); await p.waitForTimeout(300); });
await step('await p.click(\'.tool[data-tool=anschuss]\'); await ', async () => { await p.click('.tool[data-tool=anschuss]'); await p.waitForTimeout(300); await p.touchscreen.tap(box.x + box.width * 0.3, box.y + box.height * 0.8); await p.waitForTimeout(500); await shot(p, 'anschuss-dialog'); await closePopup(p); });
await step('await p.click(\'.tool[data-tool=gebiet]\'); await p.', async () => { await p.click('.tool[data-tool=gebiet]'); await p.waitForTimeout(400); await shot(p, 'gebiet-zeichnen'); await p.click('.tool[data-tool=gebiet]'); await p.waitForTimeout(200); });
await step('await p.click(\'.tool[data-tool=schaden]\'); await p', async () => { await p.click('.tool[data-tool=schaden]'); await p.waitForTimeout(300); await p.touchscreen.tap(box.x + box.width * 0.4, box.y + box.height * 0.65); await p.waitForTimeout(500); await shot(p, 'schaden-dialog'); await closePopup(p); });
await step('await p.click(\'#tools-toggle\'); await p.waitForTim', async () => { await p.click('#tools-toggle'); await p.waitForTimeout(200); await shot(p, 'werkzeuge-eingeklappt'); await p.click('#tools-toggle'); });
await step('await p.click(\'#btn-notifications\'); await p.waitF', async () => { await p.click('#btn-notifications'); await p.waitForTimeout(400); await shot(p, 'benachrichtigungen'); await p.click('#btn-notif-close'); });
await step('await p.goto(BASE + \'/#wetter\'); await p.waitForTi', async () => { await p.goto(BASE + '/#wetter'); await p.waitForTimeout(800); await shot(p, 'wetter'); });
await step('await p.evaluate(() => document.querySelector(\'#vi', async () => { await p.evaluate(() => document.querySelector('#view-wetter').scrollTo(0, 900)); await p.waitForTimeout(300); await shot(p, 'wetter-2'); });
await step('await p.goto(BASE + \'/#ansitz\'); await p.waitForTi', async () => { await p.goto(BASE + '/#ansitz'); await p.waitForTimeout(600); await p.click('#btn-plan-toggle'); await p.waitForTimeout(300); await shot(p, 'ansitz'); });
await step('await p.evaluate(() => document.querySelector(\'#vi', async () => { await p.evaluate(() => document.querySelector('#view-ansitz').scrollTo(0, 700)); await p.waitForTimeout(300); await shot(p, 'ansitz-plaene'); });
await step('await p.goto(BASE + \'/#jagd\'); await p.waitForTime', async () => { await p.goto(BASE + '/#jagd'); await p.waitForTimeout(800); await shot(p, 'planung'); });
await step('await p.evaluate(() => document.querySelector(\'#vi', async () => { await p.evaluate(() => document.querySelector('#view-jagd').scrollTo(0, 420)); await p.waitForTimeout(300); await shot(p, 'termine'); });
await step('await p.click(\'.hunt\'); await p.waitForTimeout(700', async () => { await p.click('.hunt'); await p.waitForTimeout(700); await shot(p, 'jagd-uebersicht'); });
await step('await p.click(\'.tabs button[data-tab=teilnehmer]\')', async () => { await p.click('.tabs button[data-tab=teilnehmer]'); await p.waitForTimeout(400); await shot(p, 'jagd-teilnehmer'); });
await step('await p.click(\'.tabs button[data-tab=material]\'); ', async () => { await p.click('.tabs button[data-tab=material]'); await p.waitForTimeout(400); await shot(p, 'jagd-material'); });
await step('await p.click(\'.tabs button[data-tab=strecke]\'); a', async () => { await p.click('.tabs button[data-tab=strecke]'); await p.waitForTimeout(400); await shot(p, 'jagd-strecke'); });
await step('await p.goto(BASE + \'/#mehr\'); await p.waitForTime', async () => { await p.goto(BASE + '/#mehr'); await p.waitForTimeout(600); await shot(p, 'mehr'); });
for (const pg of ['strecke', 'arbeiten', 'kirrungen', 'vorfaelle', 'kontakte', 'jagdzeiten', 'offline']) { await p.goto(BASE + '/#mehr-' + pg); await p.waitForTimeout(800); await shot(p, 'mehr-' + pg); }
await step('await p.goto(BASE + \'/#mehr\'); await p.waitForTime', async () => { await p.goto(BASE + '/#mehr'); await p.waitForTimeout(500); await p.evaluate(() => document.querySelector('#view-mehr').scrollTo(0, 99999)); await p.waitForTimeout(300); await shot(p, 'verwaltung'); });
await ctx.close();
const dctx = await makeContext(false); const d = await dctx.newPage(); await login(d, 'Hans'); await shot(d, 'desktop'); await dctx.close();

// ---------- Handbuch-HTML ----------
const img = (name, caption) => `<figure><img src="file://${shots[name]}" alt="${caption}"><figcaption>${caption}</figcaption></figure>`;
const img2 = (a, ca, b, cb) => `<div class="pair">${img(a, ca)}${img(b, cb)}</div>`;
const iconUri = 'file://' + path.join(root, 'public', 'icons', 'icon.svg');
const today = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' });
const chapters = [
['Einleitung', `
<p>Die RevierApp ist die gemeinsame Revier-Anwendung für alle Jägerinnen und Jäger eines Reviers. Sie läuft im Browser auf Handy, Tablet und Computer, lässt sich wie eine App auf den Startbildschirm legen und zeigt allen Nutzern denselben Stand: Wer sitzt gerade wo, was wurde gefährtet, wo liegt ein Anschuss, welche Jagd ist geplant.</p>
<p>Dieses Handbuch beschreibt alle Funktionen in der Reihenfolge der Bedienung. Die Bildschirmfotos stammen aus einem Demo-Revier; der Kartenhintergrund ist darin schematisch dargestellt, in der echten App sehen Sie topografische Karte, Straßenkarte oder Luftbild.</p>
<h3>Das Wichtigste in Kürze</h3>
<ul>
<li><b>Karte</b>: Reviergrenze, Gebiete, Kanzeln, Wildkameras, Kirrungen, Reviernachbarn, Fährten, Anschüsse mit Nachsuche, Wildunfälle und Wildschäden, Entfernungsmesser, Windpfeil.</li>
<li><b>Wetter</b>: aktuelle Lage mit Wind, passende Kanzeln bei der aktuellen Windlage, Jagdzeiten heute, 24-Stunden- und 7-Tage-Vorhersage, Sonne und Mond.</li>
<li><b>Ansitz</b>: Einchecken und Auschecken, Ansitze ankündigen, Bestätigungen und Lesebestätigungen, Dämmerungszeiten.</li>
<li><b>Planung</b>: Jagden aller Art mit Teilnehmern, Ständen, Treiben, Material, Checkliste und Strecke; Termine mit Zu- und Absagen.</li>
<li><b>Revierbuch</b> unter „Mehr“: Streckenbuch und Abschussplan, Revierarbeiten, Kirrungs- und Kameraprotokoll, Wildunfälle und Wildschäden, Kontakte, Jagdzeiten, Offline-Karte.</li>
<li><b>Push-Nachrichten</b> bei Ein- und Auschecken, Ankündigungen, Fährten, Anschüssen, neuen Jagden und Terminen.</li>
</ul>`],
['Erste Schritte', `
<h3>App öffnen und installieren</h3>
<p>Öffnen Sie den Link Ihres Reviers im Browser des Handys. Damit die App wie eine echte App startet und Push-Nachrichten empfangen kann, legen Sie sie auf den Startbildschirm:</p>
<ul><li><b>iPhone / iPad (Safari)</b>: Teilen-Symbol → „Zum Home-Bildschirm“. Push-Nachrichten funktionieren auf dem iPhone nur in dieser installierten Form.</li>
<li><b>Android (Chrome)</b>: Menü (drei Punkte) → „App installieren“ oder „Zum Startbildschirm hinzufügen“.</li>
<li><b>Computer</b>: einfach im Browser nutzen, Chrome bietet oben rechts ebenfalls „Installieren“ an.</li></ul>
<h3>Registrieren mit Einladungscode</h3>
<p>Jeder Nutzer legt sich sein Konto selbst an. Dazu brauchen Sie den <b>Einladungscode</b> des Reviers, den Sie vom Revier-Admin bekommen. Namen und ein eigenes Passwort wählen, Code eintragen, „Neu registrieren“. Danach genügt die Anmeldung mit Name und Passwort; auf dem Handy bleibt sie gespeichert.</p>
${img('login', 'Anmeldeseite. Der Einladungscode wird nur beim Registrieren gebraucht.')}
<h3>Push-Nachrichten aktivieren</h3>
<p>Unter <b>Mehr → Benachrichtigungen</b> auf „Push aktivieren“ tippen und die Nachfrage des Browsers erlauben. Mit „Test senden“ prüfen Sie den Empfang. Ohne Push sehen Sie alle Nachrichten trotzdem in der App unter dem Glocken-Symbol.</p>
<h3>Aufbau der App</h3>
<p>Unten (am Computer links) liegt die Hauptnavigation: <b>Karte</b>, <b>Wetter</b>, <b>Ansitz</b>, <b>Planung</b>, <b>Mehr</b>. Oben steht der Reviername, daneben wer gerade online ist, die Glocke für Benachrichtigungen und Ihr Kürzel für Konto und Einstellungen. Ein roter Punkt am Reiter „Ansitz“ bedeutet: eine Ankündigung wartet auf Ihre Bestätigung.</p>
${img2('karte', 'Startansicht auf dem Handy: Karte oben, darunter „Im Revier“, „Nachsuche“ und „Fährten“.', 'benachrichtigungen', 'Die Glocke öffnet alle Nachrichten der letzten Zeit.')}
${img('desktop', 'Am Computer liegt die Navigation links, die Listen rechts neben der Karte.')}`],
['Die Karte', `
<h3>Kartenansichten und Ebenen</h3>
<p>Über <b>Ebenen</b> in der Werkzeugleiste wählen Sie die Kartenart (Topografisch, Straßenkarte, Luftbild) und blenden einzelne Symbolarten ein oder aus: Kanzeln, Wildkameras, Kirrungen, Reviernachbarn, sonstige Punkte, Beschriftungen, Fährten, Anschüsse, Nachsuche-Strecken, Wildunfälle und Wildschäden, Gebiete und die Reviergrenze. Die Auswahl bleibt auf Ihrem Gerät gespeichert.</p>
${img2('ebenen', 'Ebenen-Menü mit Kartenart und Filtern.', 'werkzeuge-eingeklappt', 'Die Werkzeugleiste lässt sich über „Werkzeuge“ einklappen; das Schloss bleibt sichtbar.')}
<h3>Werkzeugleiste und Schloss</h3>
<p>Die Leiste rechts enthält alle Zeichen- und Meldewerkzeuge. Das <b>Schloss</b> schützt bestehende Markierungen: Im Zustand „Gesperrt“ lässt sich nichts versehentlich verschieben. Zum Verschieben einmal auf das Schloss tippen („Offen“, gelb), Marker ziehen, danach wieder sperren. Neue Markierungen lassen sich immer setzen, unabhängig vom Schloss.</p>
<h3>Kanzeln, Wildkameras, Kirrungen und Reviernachbarn</h3>
<p>Werkzeug antippen (Kanzel, Kamera, Kirrung, Nachbar), dann auf die Stelle in der Karte tippen. Es öffnet sich der Bearbeitungsdialog mit Name, Art, Telefon, Notizen und je nach Art weiteren Feldern:</p>
<ul><li><b>Kanzel</b>: gute Windrichtungen (Wind weht von …). Damit zeigt die App bei aktueller Windlage, welche Kanzeln passen (grüner Ring) und welche nicht (ausgegraut).</li>
<li><b>Kirrung / Wildkamera</b>: Intervall in Tagen für Beschickung bzw. Kartentausch. Fällige Objekte sind gelb umrandet.</li>
<li><b>Reviernachbar</b>: Name und Telefonnummer des Nachbarn an der Grenze. Erscheint im Anschuss-Popup zum Anrufen, etwa vor einer grenzüberschreitenden Nachsuche.</li></ul>
<p>Ein Tipp auf einen Marker öffnet das Popup mit Status, Wind-Eignung, letzter Beschickung, Standsicherheitsprüfung und Knöpfen wie „Hier einchecken“, „Ankündigen“, „Beschickt“, „Karte getauscht“, „Prüfung erledigt“ und „Bearbeiten“.</p>
${img2('kanzel-popup', 'Popup einer Kanzel mit Wind-Hinweis und Standsicherheitsprüfung.', 'kanzel-dialog', 'Bearbeitungsdialog mit Windrichtungen.')}
<h3>Reviergrenze und Gebiete</h3>
<p><b>Grenze</b>: Werkzeug antippen, dann die Eckpunkte der Grenze nacheinander antippen; zum Abschließen den ersten Punkt erneut antippen. Die Grenze erscheint als rote gestrichelte Linie. Zum Ändern das Werkzeug erneut wählen und links „Bearbeiten“ nutzen, dann Eckpunkte ziehen und speichern.</p>
<p><b>Gebiet</b>: genauso, aber für benannte Teilflächen wie „Elsbruch“ oder „Buchenhang“. Nach dem Zeichnen vergeben Sie Name, Farbe und Notiz; das Gebiet erscheint leicht eingefärbt mit Namen in der Mitte. Ein Tipp auf die Fläche zeigt Größe und Notizen und erlaubt Bearbeiten, Form ändern und Löschen.</p>
${img('gebiet-zeichnen', 'Gebiet zeichnen: Eckpunkte antippen, zum Abschluss ersten Punkt erneut antippen.')}
<h3>Entfernungen messen</h3>
<p>Werkzeug <b>Messen</b> wählen und Punkte antippen, auch direkt auf Kanzeln oder andere Marker. Jeder Abschnitt zeigt seine Länge, die Box oben links Gesamtstrecke, letzten Abschnitt und Richtung. „Rückgängig“, „Neu“ und „Fertig“ steuern die Messung.</p>
${img('messen', 'Entfernungsmesser mit Teilstrecken und Richtung.')}
<h3>Fährten und Wildbeobachtungen</h3>
<p>Werkzeug <b>Fährte</b>, Stelle antippen, dann Wildart, Art der Beobachtung (Fährte, Sichtung, Losung, Wühlstelle, Suhle, Wildschaden, Riss, Fallwild, Wildkamera-Aufnahme), Zeitpunkt (Jetzt, Heute Nacht, Gestern oder genau) und Notiz. Alle Nutzer erhalten eine Push-Nachricht. Die Marker tragen die Farbe der Wildart, frische Meldungen einen goldenen Ring; sie verblassen mit der Zeit und verschwinden nach 14 Tagen. Das Kartenpanel listet die Fährten der letzten zwei Wochen.</p>
${img('faehrte-dialog', 'Fährte melden.')}
<h3>Anschuss und Nachsuche</h3>
<p>Werkzeug <b>Anschuss</b>, Stelle antippen, dann Wildart, Schusszeit, Kanzel, grobe Fluchtrichtung, Pirschzeichen (Schweiß hell/dunkel, Lungenschweiß, Schnitthaar, Knochensplitter, Panseninhalt, Wildbret, kein Pirschzeichen), Notiz und bis zu fünf Fotos direkt mit der Kamera. Nach dem Melden setzen Sie sofort den <b>Fluchtweg</b>: Punkte in Fluchtrichtung antippen, Punkte ziehen, „Speichern“. Der Weg lässt sich jederzeit über „Fluchtweg bearbeiten“ ändern.</p>
<p>Im Popup des Anschusses finden Sie: Status (Offen, Nachsuche läuft, Gefunden mit Fundort, Abgebrochen), Fotos, „Nachsuche aufzeichnen“ (GPS-Aufzeichnung der gelaufenen Strecke mit Kilometerzähler; das Handy muss die App dabei im Vordergrund behalten), sowie Anruf-Knöpfe für das Nachsuchengespann aus den Kontakten und die nächstgelegenen Reviernachbarn. Jede Statusänderung geht als Push an alle.</p>
${img2('anschuss-dialog', 'Anschuss markieren mit Pirschzeichen und Fotos.', 'anschuss-popup', 'Popup mit Status, Fluchtweg, Aufzeichnung und Anruf-Knöpfen.')}
${img('fluchtweg', 'Fluchtweg Punkt für Punkt setzen und bearbeiten.')}
<h3>Wildunfall und Wildschaden</h3>
<p>Werkzeug <b>Unfall</b> (Straße, Polizei-Aktenzeichen) oder <b>Schaden</b> (Kultur, Landwirt, geschädigte Fläche in Hektar), jeweils mit Fotos. Der Status (gemeldet, besichtigt, reguliert, erledigt) wird im Popup gesetzt. „PDF“ erzeugt ein Protokoll für Polizei, Versicherung oder Landwirt. Alle Meldungen stehen gesammelt unter Mehr → Wildunfälle &amp; Wildschäden.</p>
${img('schaden-dialog', 'Wildschaden dokumentieren.')}
<h3>Weitere Kartenfunktionen</h3>
<ul><li><b>Windpfeil</b> unten links zeigt Richtung, Stärke und Böen; ein Tipp öffnet das Wetter.</li>
<li><b>Ich</b> zeigt den eigenen GPS-Standort.</li>
<li><b>Offline-Karte</b> (Mehr → Offline-Karte) speichert die Kacheln des Reviers auf dem Gerät für Stellen ohne Empfang.</li></ul>`],
['Wetter', `
<p>Die Wetteransicht gilt für den gespeicherten Reviermittelpunkt. Oben die aktuelle Lage mit gefühlter Temperatur, Luftdruck, Luftfeuchte, Sonnenauf- und -untergang und Mondphase. Darunter der Windkompass mit Richtung, Geschwindigkeit, Böen und Bewölkung sowie ein jagdlicher Hinweis zur Windlage.</p>
<p><b>Kanzeln bei … -Wind</b> listet, welche Kanzeln zur aktuellen Windrichtung passen. Grundlage sind die je Kanzel hinterlegten guten Windrichtungen. <b>Jagdzeiten heute</b> zeigt, welche Wildarten aktuell bejagt werden dürfen und welche Schonzeit haben (Einstellungen unter Mehr → Jagdzeiten).</p>
<p>Es folgen die Vorhersage für 24 Stunden mit Wind und Niederschlagswahrscheinlichkeit je Stunde und die 7-Tage-Vorhersage mit Wind, Böen, Regenwahrscheinlichkeit und Sonnenzeiten.</p>
${img2('wetter', 'Aktuelle Lage und Wind.', 'wetter-2', 'Passende Kanzeln, Jagdzeiten und Vorhersage.')}`],
['Ansitz: Einchecken und Ankündigen', `
<h3>Einchecken und Auschecken</h3>
<p>Unter <b>Ansitz</b> wählen Sie „Kanzel / Ansitz“ mit der gewünschten Kanzel (die Liste zeigt besetzte Kanzeln und ob der Wind passt) oder „Pirsch“, optional mit Notiz, und tippen „Jetzt einchecken“. Alle anderen erhalten eine Push-Nachricht, die Kanzel pulsiert auf der Karte rot. Zum Beenden „Auschecken“ im Ansitz-Bereich oder im Kartenpanel. Einchecken geht auch direkt im Popup einer Kanzel über „Hier einchecken“.</p>
<h3>Ansitz ankündigen</h3>
<p>„Für später ankündigen“ öffnet die Zeitwahl, darunter erscheinen für den gewählten Zeitpunkt Dämmerung, Sonnenauf- und -untergang und Mondphase. „Ankündigung senden“ informiert alle Nutzer per Push. Jeder kann bestätigen, auch mit Kommentar („Ich gehe dann auf Kanzel 3“). Der Antragsteller sieht pro Person: ○ noch nicht gelesen, ✓ gelesen, ✓✓ bestätigt. Aus einer Ankündigung lässt sich mit „Jetzt einchecken“ direkt einchecken, „Absagen“ informiert ebenfalls alle.</p>
<p>Unter „Letzte Reviergänge“ steht die Historie der Ein- und Auscheckvorgänge.</p>
${img2('ansitz', 'Einchecken und Ankündigung mit Dämmerungszeiten.', 'ansitz-plaene', 'Angekündigte Ansitze mit Lese- und Bestätigungsstatus.')}`],
['Planung: Jagden und Termine', `
<h3>Jagden anlegen</h3>
<p>Unter <b>Planung</b> legen Sie mit „+ Neue Jagd“ eine Drückjagd, einen Gemeinschaftsansitz, Buschieren, Vogeljagd, Frettieren, Fallenjagd, Revierarbeit oder Sonstiges an: Titel, Datum, Treffpunkt und Zeit, Leitung, Beschreibung bzw. Belehrungstext (Freigabe, Sicherheitshinweise, Signale). Alle Nutzer werden benachrichtigt. Der Status (In Planung, Bestätigt, Abgeschlossen, Abgesagt) wird über „Bearbeiten“ gesetzt.</p>
${img2('planung', 'Liste der Jagden mit Jagdart und Status.', 'jagd-uebersicht', 'Übersicht einer Jagd mit Standverteilung.')}
<h3>Register einer Jagd</h3>
<ul><li><b>Teilnehmer</b>: Name, Rolle (Jagdleiter, Schütze, Treiber, Hundeführer, Ansteller, Helfer), Stand, Treiben, Zusage, Telefon. Nutzer der App lassen sich per Tipp übernehmen.</li>
<li><b>Treiben</b> (nur Drückjagd): Name, Zeiten, Notizen zum Anstellen; Teilnehmer werden den Treiben zugeordnet.</li>
<li><b>Material</b>: Was wird gebraucht, wer bringt es mit. „Ich bringe das mit“ trägt den eigenen Namen ein, abhaken wenn eingepackt.</li>
<li><b>Checkliste</b>: Aufgaben mit Zuständigkeit, passend zur Jagdart vorbelegt.</li>
<li><b>Strecke</b>: Wildart (mit Schonzeit-Prüfung), Stück, Erleger, Notiz; „Streckenmeldung drucken / PDF“ erzeugt die Meldung mit Unterschriftszeilen. Die Strecke fließt automatisch ins Streckenbuch.</li></ul>
${img2('jagd-teilnehmer', 'Teilnehmer mit Rolle, Stand und Zusage.', 'jagd-material', 'Materialliste: wer bringt was mit.')}
${img('jagd-strecke', 'Strecke erfassen und als PDF drucken.')}
<h3>Termine</h3>
<p>Unter den Jagden stehen die Termine: Hegeringsitzung, Trophäenschau, Revierversammlung oder frei beschreibbar, mit Datum, Uhrzeit, Ort und Beschreibung. Jeder antwortet mit Zusage, Vielleicht oder Absage und kann unter „Ich bringe mit“ eintragen, was er mitbringt. Alle Rückmeldungen sind für alle sichtbar. Neue Termine lösen eine Push-Nachricht aus.</p>
${img('termine', 'Termin mit Rückmeldungen und Mitbringliste.')}`],
['Revierbuch (Bereich „Mehr“)', `
<p>Der Bereich <b>Mehr</b> beginnt mit dem Revierbuch. Jede Kachel öffnet eine eigene Seite, „← Revierbuch“ führt zurück.</p>
${img('mehr', 'Revierbuch mit sieben Bereichen, darunter die Einstellungen.')}
<h3>Streckenbuch und Abschussplan</h3>
<p>Das Streckenbuch gilt je Jagdjahr (1. April bis 31. März), mit Pfeilen wechseln Sie das Jahr. Oben der Abschussplan je Wildart mit Soll, Ist und Balken: grün im Plan, gelb hinter der Zeit, rot deutlich hinter der Zeit. Der Admin pflegt die Sollzahlen über „Abschussplan bearbeiten“. Darunter tragen Sie Strecke ein (Wildart, Stück, Datum, Erleger, Gewicht, Notiz, optional GPS-Standort); bei Schonzeit fragt die App nach. Die Liste zeigt alle Einträge einschließlich der Drückjagd-Strecken. „Drucken / PDF“ erzeugt das komplette Streckenbuch mit Abschussplan.</p>
${img('mehr-strecke', 'Streckenbuch mit Abschussplan.')}
<h3>Revierarbeiten</h3>
<p>Arbeiten wie Kanzelprüfung, Freischneiden, Reparatur, Kirrung, Wegearbeit mit Objekt, Zuständigkeit, Fälligkeit und Notiz. Abhaken dokumentiert Datum und Person. Die Warnung oben nennt Kanzeln, deren jährliche Standsicherheitsprüfung fehlt oder älter als ein Jahr ist; dokumentiert wird sie mit einem Tipp im Kanzel-Popup („Prüfung erledigt“).</p>
${img('mehr-arbeiten', 'Revierarbeiten mit Prüfhinweis.')}
<h3>Kirrungen und Wildkameras</h3>
<p>Alle Kirrungen und Kameras mit Intervall, letzter Beschickung bzw. letztem Kartentausch und Fälligkeit. Mit „Beschickt“, „Karte“, „Batterie“ oder „Kontrolle“ tragen Sie den Vorgang ein, „Verlauf“ zeigt die Historie. Das Intervall setzen Sie im Karten-Popup unter „Bearbeiten“.</p>
${img('mehr-kirrungen', 'Kirrungs- und Kameraprotokoll.')}
<h3>Wildunfälle und Wildschäden</h3>
<p>Liste aller Meldungen mit Status, Antippen springt auf die Karte, „PDF“ erzeugt das Protokoll. Neue Meldungen entstehen über die Kartenwerkzeuge „Unfall“ und „Schaden“.</p>
${img('mehr-vorfaelle', 'Wildunfälle und Wildschäden.')}
<h3>Kontakte</h3>
<p>Nachsuchengespann, Tierarzt, Polizei, Forst, Landwirt, Wildhandel, Jagdbehörde und weitere mit Telefonnummer und Anruf-Knopf. Kontakte mit der Rolle „Nachsuchengespann“ erscheinen direkt im Anschuss-Popup.</p>
${img('mehr-kontakte', 'Kontakte mit Anruf-Knopf.')}
<h3>Jagdzeiten</h3>
<p>Jagd- und Schonzeiten je Wildart. Voreingestellt ist die Bundesjagdzeitenverordnung; da die Länder abweichen, passt der Admin die Zeiten an (Format Monat-Tag, beide Felder leer bedeutet ganzjährig). Die Zeiten steuern die Schonzeit-Warnung beim Eintragen und die Anzeige „Jagdzeiten heute“ im Wetter.</p>
${img('mehr-jagdzeiten', 'Jagdzeiten je Wildart.')}
<h3>Offline-Karte</h3>
<p>„Revier offline speichern“ lädt die Kartenkacheln des Reviers (aktuelle Kartenart, Zoomstufen 12 bis 16, höchstens 1500 Kacheln) auf das Gerät. Danach zeigt die Karte das Revier auch ohne Empfang. „Gespeicherte Kacheln löschen“ gibt den Speicher frei.</p>
${img('mehr-offline', 'Offline-Karte speichern.')}`],
['Einstellungen und Verwaltung', `
<p>Unterhalb des Revierbuchs liegen die Einstellungen:</p>
<ul><li><b>Revier</b>: Reviername und Kartenmittelpunkt. Verschieben Sie die Karte auf die Reviermitte und tippen Sie „Kartenausschnitt als Mittelpunkt speichern“. Der Mittelpunkt ist die Startansicht beim Öffnen und der Ort der Wetterdaten.</li>
<li><b>Benachrichtigungen</b>: Push aktivieren und testen.</li>
<li><b>Objekte im Revier</b>: alle Kanzeln, Kameras, Kirrungen und Nachbarn als Liste zum Bearbeiten.</li>
<li><b>Konto</b>: Passwort ändern, Abmelden.</li></ul>
<h3>Verwaltung (nur Admin)</h3>
<p>Der erste registrierte Nutzer ist Admin. Er sieht zusätzlich den Bereich „Verwaltung“: Einladungscode ansehen und ändern, „Einladung teilen“ (fertiger Text mit Link, Anleitung und Code für WhatsApp oder Mail), für Nutzer ein neues Startpasswort erzeugen, weitere Admins ernennen, Nutzer entfernen. Admins pflegen außerdem Abschussplan und Jagdzeiten.</p>
${img('verwaltung', 'Konto und Verwaltung für den Admin.')}`],
['Tipps und Problemlösung', `
<ul>
<li><b>Keine Push-Nachrichten auf dem iPhone</b>: Die App muss über „Teilen → Zum Home-Bildschirm“ installiert und aus diesem Symbol gestartet sein. Dann unter Mehr → Benachrichtigungen „Push aktivieren“.</li>
<li><b>Markierung lässt sich nicht verschieben</b>: Das Schloss in der Werkzeugleiste ist gesperrt. Antippen, verschieben, wieder sperren.</li>
<li><b>Gebiet oder Grenze zeichnen</b>: Nach dem Antippen des Werkzeugs die Eckpunkte setzen und zum Abschluss den ersten Punkt erneut antippen.</li>
<li><b>Standort wird nicht gefunden</b>: Ortungsdienste für den Browser bzw. die installierte App erlauben. Die GPS-Aufzeichnung der Nachsuche läuft nur, solange die App im Vordergrund bleibt.</li>
<li><b>Kein Empfang im Revier</b>: Vorher unter Mehr → Offline-Karte das Revier speichern. Eigene Marker und Grenzen bleiben ohnehin vom letzten Laden erhalten; Meldungen werden gesendet, sobald wieder Verbindung besteht und Sie den Vorgang erneut ausführen.</li>
<li><b>Wer darf was ändern</b>: Eigene Fährten, Anschüsse und Meldungen bearbeitet der Melder, der Admin alles. Kanzeln, Kameras, Kirrungen, Gebiete, Jagden und Termine sind für alle bearbeitbar.</li>
<li><b>Datenschutz</b>: Alle Nutzer des Reviers sehen gegenseitig, wer eingecheckt ist. Den Einladungscode daher nur an Jäger des Reviers weitergeben.</li>
</ul>
<h3>Symbole auf der Karte</h3>
<table>
<tr><th>Symbol</th><th>Bedeutung</th></tr>
<tr><td>Brauner Pin mit Haus</td><td>Kanzel; rot pulsierend = besetzt; goldener Ring = angekündigt; grüner Ring = Wind passt; ausgegraut = Wind ungünstig</td></tr>
<tr><td>Blaugrauer Pin mit Kamera</td><td>Wildkamera; gelb umrandet = Kartentausch fällig</td></tr>
<tr><td>Ockerfarbener Pin mit Tropfen</td><td>Kirrung; gelb umrandet = Beschickung fällig</td></tr>
<tr><td>Violetter Pin mit Person</td><td>Reviernachbar mit Telefonnummer</td></tr>
<tr><td>Runder Punkt mit Pfote</td><td>Fährte oder Beobachtung, Farbe nach Wildart, goldener Ring = frisch</td></tr>
<tr><td>Roter Kreis mit Zielmarke</td><td>Anschuss; pulsierend = Nachsuche läuft; grün = gefunden; grau = abgebrochen; gestrichelte Linie mit Pfeil = Fluchtweg; grüne Linie = Nachsuche-Strecke; grüner Punkt = Fundort</td></tr>
<tr><td>Dunkles Quadrat mit Auto / ockerfarbenes mit Feld</td><td>Wildunfall / Wildschaden</td></tr>
<tr><td>Rote gestrichelte Linie</td><td>Reviergrenze</td></tr>
<tr><td>Farbige Fläche mit Namen</td><td>Gebiet</td></tr>
</table>`],
];

const toc = chapters.map(([t], i) => `<li>${i + 1}. ${t}</li>`).join('');
const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>RevierApp – Handbuch</title>
<style>
@page { size: A4; margin: 18mm 16mm 20mm 16mm; }
body { font-family: "DejaVu Serif", Georgia, serif; color: #22281f; font-size: 10.5pt; line-height: 1.45; }
h1, h2, h3 { font-family: "DejaVu Serif", Georgia, serif; color: #1f3a2a; }
h1 { font-size: 26pt; margin: 0 0 .2em; } h2 { font-size: 17pt; border-bottom: 2px solid #c9a24b; padding-bottom: .15em; margin: 0 0 .6em; page-break-after: avoid; }
h3 { font-size: 12pt; margin: 1.1em 0 .3em; page-break-after: avoid; }
p, li { text-align: left; } ul { padding-left: 1.2em; }
.cover { height: 250mm; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; page-break-after: always; }
.cover img { width: 110px; margin-bottom: 1.2em; } .cover .sub { font-style: italic; color: #5c3d22; font-size: 14pt; } .cover .meta { color: #666; margin-top: 3em; font-size: 10pt; }
.toc { page-break-after: always; } .toc ol { list-style: none; padding: 0; font-size: 12pt; line-height: 1.9; }
section.chapter { page-break-before: always; }
figure { margin: .6em 0 1em; text-align: center; page-break-inside: avoid; }
figure img { max-width: 62mm; max-height: 112mm; border: 1px solid #c9bfa3; border-radius: 6px; box-shadow: 0 2px 6px rgba(0,0,0,.15); }
figcaption { font-size: 8.5pt; color: #5a614f; margin-top: .3em; }
.pair { display: flex; gap: 8mm; justify-content: center; page-break-inside: avoid; } .pair figure { flex: 1; }
section.chapter figure:only-child img, figure img[alt*="Computer"] { max-width: 100%; }
table { border-collapse: collapse; width: 100%; font-size: 9.5pt; } th, td { border: 1px solid #b9b19c; padding: .3em .5em; text-align: left; vertical-align: top; } th { background: #ece5d0; }
.tip { background: #f3e8c4; border-left: 4px solid #c9a24b; padding: .5em .8em; border-radius: 4px; }
</style></head><body>
<div class="cover"><img src="${iconUri}" alt=""><h1>RevierApp</h1><div class="sub">Handbuch für Anwenderinnen und Anwender</div>
<p>Wetter · Karte · Ansitz · Nachsuche · Planung · Revierbuch</p><div class="meta">Stand: ${today}</div></div>
<div class="toc"><h2>Inhalt</h2><ol>${toc}</ol></div>
${chapters.map(([t, body], i) => `<section class="chapter"><h2>${i + 1}. ${t}</h2>${body}</section>`).join('')}
</body></html>`;
fs.writeFileSync(path.join(here, 'handbuch.html'), html);

const pctx = await browser.newContext(); const pp = await pctx.newPage();
await pp.goto('file://' + path.join(here, 'handbuch.html')); await pp.waitForTimeout(500);
const out = path.join(root, 'docs', 'RevierApp-Handbuch.pdf');
await pp.pdf({ path: out, format: 'A4', printBackground: true, displayHeaderFooter: true,
  headerTemplate: '<div></div>', footerTemplate: '<div style="width:100%;font-size:8px;color:#777;text-align:center;font-family:serif">RevierApp – Handbuch · Seite <span class="pageNumber"></span> von <span class="totalPages"></span></div>',
  margin: { top: '18mm', bottom: '20mm', left: '16mm', right: '16mm' } });
await browser.close(); server.kill(); fs.rmSync(dataDir, { recursive: true, force: true });
console.log('PDF erzeugt:', out, Math.round(fs.statSync(out).size / 1024), 'kB, Screenshots:', Object.keys(shots).length);
