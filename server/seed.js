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

  const date = new Date(); date.setDate(date.getDate() + 30);
  const huntId = await db.insert('INSERT INTO hunts (title, date, meet_time, meet_point, leader, description, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['Herbstdrückjagd Buchenhain', date.toISOString().slice(0, 10), '08:00', 'Parkplatz Forsthaus', 'Hans',
      'Freigabe: Schwarzwild alle Klassen, Rehwild (Kitz vor Ricke), Fuchs.\nKeine Schüsse in Richtung Straße K12. Signale: 1x lang = Jagd beginnt, 3x kurz = Jagd aus.\nSchüsseltreiben ab 15 Uhr im Forsthaus.', 'planung', hans.id, now()]);
  const d1 = await db.insert('INSERT INTO hunt_drives (hunt_id, name, start_time, end_time, notes) VALUES (?, ?, ?, ?, ?)', [huntId, 'Treiben 1 – Buchenhang', '09:30', '11:00', 'Treiber von Süden anstellen']);
  const d2 = await db.insert('INSERT INTO hunt_drives (hunt_id, name, start_time, end_time, notes) VALUES (?, ?, ?, ?, ?)', [huntId, 'Treiben 2 – Bachtal', '11:30', '13:00', '']);
  for (const p of [['Hans', 'jagdleiter', null, null, '', 1], ['Grete', 'schuetze', ids['Kanzel Buchenhang'], d1, '0171 2345678', 1], ['Karl', 'schuetze', ids['Drückjagdbock Kreuzung'], d1, '', 0], ['Peter M.', 'hundefuehrer', null, d2, '', 1], ['Treibergruppe Dorf', 'treiber', null, d1, '', 0]]) {
    await db.run('INSERT INTO hunt_participants (hunt_id, name, role, feature_id, drive_id, phone, confirmed) VALUES (?, ?, ?, ?, ?, ?, ?)', [huntId, ...p]);
  }
  for (const [text, done, who] of [['Einladungen verschicken', 1, 'Hans'], ['Stände kontrollieren und freischneiden', 1, 'Karl'], ['Jagdleiter-Belehrung vorbereiten', 0, 'Hans'], ['Hundeführer organisieren', 1, 'Grete'], ['Streckenplatz und Wildwanne vorbereiten', 0, ''], ['Straßenschilder „Vorsicht Treibjagd“ beantragen', 0, 'Hans'], ['Schüsseltreiben planen', 0, 'Grete']]) {
    await db.run('INSERT INTO hunt_tasks (hunt_id, text, done, assignee) VALUES (?, ?, ?, ?)', [huntId, text, done, who]);
  }
  return true;
}
