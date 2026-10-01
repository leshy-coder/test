// Demodaten für den lokalen Test der Oberfläche. Wird nur eingespielt, wenn die Datenbank leer ist.
import { getDb, setSetting, now } from './db.js';
import { register } from './auth.js';

export async function seedDemo() {
  const db = await getDb();
  if (Number((await db.get('SELECT COUNT(*) AS c FROM users')).c) > 0) return false;

  const hans = (await register('Hans', 'demo', 'demo')).user; // erster Nutzer: legt Einladungscode fest, wird Admin
  const grete = (await register('Grete', 'demo', 'demo')).user;
  const karl = (await register('Karl', 'demo', 'demo')).user;

  await setSetting('revier_name', 'Revier Buchenhain (Demo)');
  await setSetting('center', { lat: 50.952, lng: 10.205, zoom: 14 });

  const polygon = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[10.186, 50.941], [10.228, 50.939], [10.232, 50.958], [10.214, 50.967], [10.190, 50.963], [10.183, 50.950], [10.186, 50.941]]] } };
  await db.run('INSERT INTO boundaries (name, geojson, updated_by, updated_at) VALUES (?, ?, ?, ?)', ['Reviergrenze', JSON.stringify(polygon), hans.id, now()]);

  const ids = {};
  for (const [kind, name, lat, lng, notes] of [
    ['kanzel', 'Kanzel Eichenwiese', 50.9545, 10.1960, 'Blick auf die Wiese, Wind aus West ideal'],
    ['kanzel', 'Kanzel Buchenhang', 50.9490, 10.2150, 'Leiter 2024 erneuert'],
    ['kanzel', 'Drückjagdbock Kreuzung', 50.9600, 10.2050, 'Nur bei Drückjagd besetzen'],
    ['kanzel', 'Kanzel Bachtal', 50.9440, 10.2000, 'Sauen wechseln abends über die Furt'],
    ['kamera', 'Wildkamera Suhle', 50.9565, 10.2120, 'SD-Karte alle 2 Wochen tauschen'],
    ['kamera', 'Wildkamera Kirrung Nord', 50.9610, 10.1980, ''],
    ['kirrung', 'Kirrung Nord', 50.9615, 10.1975, 'Mais, Dienstag und Freitag beschicken'],
  ]) ids[name] = await db.insert('INSERT INTO features (kind, name, lat, lng, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [kind, name, lat, lng, notes, hans.id, now()]);

  await db.run("INSERT INTO checkins (user_id, mode, feature_id, note, started_at) VALUES (?, 'kanzel', ?, ?, ?)", [grete.id, ids['Kanzel Buchenhang'], 'bis zum Dunkelwerden', new Date(Date.now() - 40 * 60000).toISOString()]);
  const tonight = new Date(); tonight.setHours(21, 0, 0, 0); if (tonight < new Date()) tonight.setDate(tonight.getDate() + 1);
  const planId = await db.insert("INSERT INTO plans (user_id, mode, feature_id, planned_at, note, created_at) VALUES (?, 'kanzel', ?, ?, ?, ?)", [hans.id, ids['Kanzel Eichenwiese'], tonight.toISOString(), 'Abendansitz, Wind passt', now()]);
  await db.run('INSERT INTO plan_receipts (plan_id, user_id, read_at, confirmed_at, comment) VALUES (?, ?, ?, ?, ?)', [planId, grete.id, now(), now(), 'Passt, ich bleibe am Buchenhang']);
  await db.run('INSERT INTO plan_receipts (plan_id, user_id) VALUES (?, ?)', [planId, karl.id]);
  await db.run('INSERT INTO notifications (user_id, title, body, url, created_at) VALUES (?, ?, ?, ?, ?)', [hans.id, 'Grete hat bestätigt', 'Grete hat deine Ankündigung für heute Abend bestätigt. „Passt, ich bleibe am Buchenhang“', `/#plan-${planId}`, now()]);
  await db.run('INSERT INTO notifications (user_id, title, body, url, created_at) VALUES (?, ?, ?, ?, ?)', [hans.id, 'Grete ist im Revier', 'Grete ist jetzt auf Kanzel Buchenhang. – bis zum Dunkelwerden', '/#karte', now()]);

  const lastNight = new Date(); lastNight.setHours(2, 0, 0, 0);
  await db.run("INSERT INTO sightings (user_id, species, kind, note, lat, lng, observed_at, created_at) VALUES (?, 'Schwarzwild', 'faehrte', ?, ?, ?, ?, ?)", [grete.id, 'Rotte, ca. 6 Stück, Richtung Maisfeld', 50.9470, 10.2080, lastNight.toISOString(), now()]);
  await db.run("INSERT INTO sightings (user_id, species, kind, note, lat, lng, observed_at, created_at) VALUES (?, 'Rehwild', 'sichtung', ?, ?, ?, ?, ?)", [karl.id, 'Bock mit zwei Ricken am Waldrand', 50.9580, 10.1950, new Date(Date.now() - 3 * 86400e3).toISOString(), now()]);
  await db.run("INSERT INTO sightings (user_id, species, kind, note, lat, lng, observed_at, created_at) VALUES (?, 'Schwarzwild', 'wuehlstelle', ?, ?, ?, ?, ?)", [hans.id, 'Wiese am Bachtal frisch umgebrochen', 50.9435, 10.1985, new Date(Date.now() - 9 * 86400e3).toISOString(), now()]);

  await db.run("INSERT INTO shots (user_id, species, shot_at, lat, lng, flight_bearing, flight_path, signs, note, status, feature_id, created_at) VALUES (?, 'Rehwild (Bock)', ?, ?, ?, ?, ?, ?, ?, 'nachsuche', ?, ?)",
    [karl.id, new Date(Date.now() - 2 * 3600e3).toISOString(), 50.9500, 10.2120, 230, JSON.stringify([[50.9492, 10.2105], [50.9486, 10.2092], [50.9478, 10.2088]]), 'Schweiß hell, Schnitthaar', 'Blattschuss vermutet, Stück sofort ab in die Dickung', ids['Kanzel Buchenhang'], now()]);
  await db.run("INSERT INTO areas (name, color, geojson, notes, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)", ['Elsbruch', '#3b7dd8', JSON.stringify({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[10.188, 50.943], [10.204, 50.942], [10.206, 50.952], [10.190, 50.953], [10.188, 50.943]]] } }), 'Feuchter Erlenbruch, Sauen-Einstand', hans.id, now()]);
  await db.run("INSERT INTO areas (name, color, geojson, notes, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)", ['Buchenhang', '#c9a24b', JSON.stringify({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[10.208, 50.944], [10.226, 50.942], [10.228, 50.956], [10.210, 50.958], [10.208, 50.944]]] } }), '', hans.id, now()]);
  const ev = await db.insert('INSERT INTO events (title, date, time, place, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ['Hegeringsitzung', new Date(Date.now() + 12 * 86400e3).toISOString().slice(0, 10), '19:30', 'Gasthaus Linde', 'Tagesordnung: Abschussplanung, Trophäenschau-Vorbereitung', hans.id, now()]);
  await db.run('INSERT INTO event_responses (event_id, user_id, status, brings, updated_at) VALUES (?, ?, ?, ?, ?)', [ev, grete.id, 'zusage', 'Beamer', now()]);

  await db.run("UPDATE features SET interval_days = 4, wind_dirs = '' WHERE id = ?", [ids['Kirrung Nord']]);
  await db.run("UPDATE features SET interval_days = 14 WHERE id = ?", [ids['Wildkamera Suhle']]);
  await db.run("UPDATE features SET wind_dirs = 'W,SW,NW' WHERE id = ?", [ids['Kanzel Eichenwiese']]);
  await db.run("UPDATE features SET wind_dirs = 'N,NO,O' WHERE id = ?", [ids['Kanzel Buchenhang']]);
  await db.run("UPDATE features SET wind_dirs = 'S,SW' WHERE id = ?", [ids['Kanzel Bachtal']]);
  await db.run("INSERT INTO feature_logs (feature_id, user_id, kind, note, created_at) VALUES (?, ?, 'beschickt', 'Mais 10 kg', ?)", [ids['Kirrung Nord'], grete.id, new Date(Date.now() - 6 * 86400e3).toISOString()]);
  await db.run("INSERT INTO feature_logs (feature_id, user_id, kind, note, created_at) VALUES (?, ?, 'karte', '', ?)", [ids['Wildkamera Suhle'], karl.id, new Date(Date.now() - 3 * 86400e3).toISOString()]);
  await db.run("INSERT INTO tasks (title, kind, feature_id, assignee, due_date, notes, created_by, created_at) VALUES (?, 'kanzelpruefung', ?, 'Karl', ?, 'Leiter und Sprossen prüfen', ?, ?)", ['Jährliche Standsicherheitsprüfung Kanzel Bachtal', ids['Kanzel Bachtal'], new Date(Date.now() + 10 * 86400e3).toISOString().slice(0, 10), hans.id, now()]);
  await db.run("INSERT INTO tasks (title, kind, feature_id, assignee, due_date, done_at, done_by, notes, created_by, created_at) VALUES (?, 'kanzelpruefung', ?, 'Hans', ?, ?, ?, '', ?, ?)", ['Standsicherheitsprüfung Kanzel Eichenwiese', ids['Kanzel Eichenwiese'], new Date(Date.now() - 20 * 86400e3).toISOString().slice(0, 10), new Date(Date.now() - 20 * 86400e3).toISOString(), hans.id, hans.id, now()]);
  await db.run("INSERT INTO tasks (title, kind, assignee, due_date, notes, created_by, created_at) VALUES (?, 'freischneiden', '', ?, 'Schussschneise Richtung Wiese', ?, ?)", ['Schneise am Buchenhang freischneiden', new Date(Date.now() + 20 * 86400e3).toISOString().slice(0, 10), hans.id, now()]);
  const season = (() => { const d = new Date(); const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; return `${y}/${String(y + 1).slice(2)}`; })();
  for (const [sp, t] of [['Rehwild – Bock / Schmalreh', 6], ['Rehwild – Ricke / Kitz', 10], ['Schwarzwild – Frischling / Überläufer', 20], ['Schwarzwild – Bache / Keiler', 4], ['Fuchs – Altfuchs', 5]]) await db.run('INSERT INTO quota (season, species, target) VALUES (?, ?, ?)', [season, sp, t]);
  const d30 = new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10), d12 = new Date(Date.now() - 12 * 86400e3).toISOString().slice(0, 10);
  await db.run("INSERT INTO harvest (user_id, species, count, date, shooter, weight_kg, notes, created_at) VALUES (?, 'Rehwild – Bock / Schmalreh', 1, ?, 'Hans', 17.5, 'Jährling', ?)", [hans.id, d30, now()]);
  await db.run("INSERT INTO harvest (user_id, species, count, date, shooter, weight_kg, notes, created_at) VALUES (?, 'Schwarzwild – Frischling / Überläufer', 2, ?, 'Grete', 22, 'Kirrung Nord', ?)", [grete.id, d12, now()]);
  await db.run("INSERT INTO incidents (kind, user_id, species, happened_at, lat, lng, road, police_ref, status, note, created_at) VALUES ('wildunfall', ?, 'Rehwild', ?, 50.9395, 10.2050, 'K12 Höhe Abzweig Forsthaus', 'VU 2026/1187', 'erledigt', 'Stück verendet, von Polizei aufgenommen', ?)", [karl.id, new Date(Date.now() - 5 * 86400e3).toISOString(), now()]);
  await db.run("INSERT INTO incidents (kind, user_id, species, happened_at, lat, lng, crop, farmer, area_ha, status, note, created_at) VALUES ('wildschaden', ?, 'Schwarzwild', ?, 50.9625, 10.2160, 'Mais', 'Landwirt Müller', 0.4, 'gemeldet', 'Ecke zum Wald umgebrochen', ?)", [hans.id, new Date(Date.now() - 2 * 86400e3).toISOString(), now()]);
  for (const [n, r, ph, note] of [['Peter Schweißhund (Nachsuchengespann)', 'nachsuche', '0170 1234567', 'Hannoverscher Schweißhund, rund um die Uhr'], ['Tierarztpraxis Dr. Vogel', 'tierarzt', '03691 12345', ''], ['Polizei Revier Eisenach', 'polizei', '110', 'Wildunfälle melden'], ['Förster Brandt', 'forst', '0171 7654321', '']]) await db.run('INSERT INTO contacts (name, role, phone, note, created_at) VALUES (?, ?, ?, ?, ?)', [n, r, ph, note, now()]);

  const date = new Date(); date.setDate(date.getDate() + 30);
  const huntId = await db.insert('INSERT INTO hunts (title, date, meet_time, meet_point, leader, description, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['Herbstdrückjagd Buchenhain', date.toISOString().slice(0, 10), '08:00', 'Parkplatz Forsthaus', 'Hans',
      'Freigabe: Schwarzwild alle Klassen, Rehwild (Kitz vor Ricke), Fuchs.\nKeine Schüsse in Richtung Straße K12. Signale: 1x lang = Jagd beginnt, 3x kurz = Jagd aus.\nSchüsseltreiben ab 15 Uhr im Forsthaus.', 'planung', hans.id, now()]);
  const d1 = await db.insert('INSERT INTO hunt_drives (hunt_id, name, start_time, end_time, notes) VALUES (?, ?, ?, ?, ?)', [huntId, 'Treiben 1 – Buchenhang', '09:30', '11:00', 'Treiber von Süden anstellen']);
  const d2 = await db.insert('INSERT INTO hunt_drives (hunt_id, name, start_time, end_time, notes) VALUES (?, ?, ?, ?, ?)', [huntId, 'Treiben 2 – Bachtal', '11:30', '13:00', '']);
  for (const p of [['Hans', 'jagdleiter', null, null, '', 1], ['Grete', 'schuetze', ids['Kanzel Buchenhang'], d1, '0171 2345678', 1], ['Karl', 'schuetze', ids['Drückjagdbock Kreuzung'], d1, '', 0], ['Peter M.', 'hundefuehrer', null, d2, '', 1], ['Treibergruppe Dorf', 'treiber', null, d1, '', 0]]) {
    await db.run('INSERT INTO hunt_participants (hunt_id, name, role, feature_id, drive_id, phone, confirmed) VALUES (?, ?, ?, ?, ?, ?, ?)', [huntId, ...p]);
  }
  for (const [text, person] of [['Wildwanne und Wasser', 'Karl'], ['Signalwesten für Treiber (10 Stück)', 'Hans'], ['Kaffee und Kuchen fürs Schüsseltreiben', 'Grete'], ['Funkgeräte', '']]) await db.run('INSERT INTO hunt_items (hunt_id, text, person) VALUES (?, ?, ?)', [huntId, text, person]);
  for (const [text, done, who] of [['Einladungen verschicken', 1, 'Hans'], ['Stände kontrollieren und freischneiden', 1, 'Karl'], ['Jagdleiter-Belehrung vorbereiten', 0, 'Hans'], ['Hundeführer organisieren', 1, 'Grete'], ['Streckenplatz und Wildwanne vorbereiten', 0, ''], ['Straßenschilder „Vorsicht Treibjagd“ beantragen', 0, 'Hans'], ['Schüsseltreiben planen', 0, 'Grete']]) {
    await db.run('INSERT INTO hunt_tasks (hunt_id, text, done, assignee) VALUES (?, ?, ?, ?)', [huntId, text, done, who]);
  }
  return true;
}
