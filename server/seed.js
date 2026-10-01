// Demodaten für den lokalen Test der Oberfläche. Wird nur eingespielt, wenn die Datenbank leer ist.
import { db, setSetting } from './db.js';
import { register } from './auth.js';

export function seedDemo() {
  const users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (users > 0) return false;

  const hans = register('Hans', 'demo').user;
  const grete = register('Grete', 'demo').user;
  const karl = register('Karl', 'demo').user;

  setSetting('revier_name', 'Revier Buchenhain (Demo)');
  setSetting('center', { lat: 50.952, lng: 10.205, zoom: 14 });

  const polygon = {
    type: 'Feature', properties: {},
    geometry: { type: 'Polygon', coordinates: [[[10.186, 50.941], [10.228, 50.939], [10.232, 50.958], [10.214, 50.967], [10.190, 50.963], [10.183, 50.950], [10.186, 50.941]]] },
  };
  db.prepare('INSERT INTO boundaries (name, geojson, updated_by) VALUES (?, ?, ?)').run('Reviergrenze', JSON.stringify(polygon), hans.id);

  const f = db.prepare('INSERT INTO features (kind, name, lat, lng, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)');
  const ids = {};
  const features = [
    ['kanzel', 'Kanzel Eichenwiese', 50.9545, 10.1960, 'Blick auf die Wiese, Wind aus West ideal'],
    ['kanzel', 'Kanzel Buchenhang', 50.9490, 10.2150, 'Leiter 2024 erneuert'],
    ['kanzel', 'Drückjagdbock Kreuzung', 50.9600, 10.2050, 'Nur bei Drückjagd besetzen'],
    ['kanzel', 'Kanzel Bachtal', 50.9440, 10.2000, 'Sauen wechseln abends über die Furt'],
    ['kamera', 'Wildkamera Suhle', 50.9565, 10.2120, 'SD-Karte alle 2 Wochen tauschen'],
    ['kamera', 'Wildkamera Kirrung Nord', 50.9610, 10.1980, ''],
    ['kirrung', 'Kirrung Nord', 50.9615, 10.1975, 'Mais, Dienstag und Freitag beschicken'],
  ];
  for (const [kind, name, lat, lng, notes] of features) ids[name] = Number(f.run(kind, name, lat, lng, notes, hans.id).lastInsertRowid);

  // Grete sitzt gerade an, Hans hat einen Ansitz angekündigt
  db.prepare("INSERT INTO checkins (user_id, mode, feature_id, note, started_at) VALUES (?, 'kanzel', ?, ?, datetime('now', '-40 minutes'))")
    .run(grete.id, ids['Kanzel Buchenhang'], 'bis zum Dunkelwerden');
  const tonight = new Date(); tonight.setHours(21, 0, 0, 0); if (tonight < new Date()) tonight.setDate(tonight.getDate() + 1);
  const planId = Number(db.prepare("INSERT INTO plans (user_id, mode, feature_id, planned_at, note) VALUES (?, 'kanzel', ?, ?, ?)")
    .run(hans.id, ids['Kanzel Eichenwiese'], tonight.toISOString(), 'Abendansitz, Wind passt').lastInsertRowid);
  db.prepare("INSERT INTO plan_receipts (plan_id, user_id, read_at, confirmed_at, comment) VALUES (?, ?, datetime('now'), datetime('now'), 'Passt, ich bleibe am Buchenhang')").run(planId, grete.id);
  db.prepare('INSERT INTO plan_receipts (plan_id, user_id) VALUES (?, ?)').run(planId, karl.id);
  db.prepare("INSERT INTO notifications (user_id, title, body, url) VALUES (?, ?, ?, ?)").run(hans.id, 'Grete hat bestätigt', 'Grete hat deine Ankündigung für heute Abend bestätigt. „Passt, ich bleibe am Buchenhang“', `/#plan-${planId}`);
  db.prepare("INSERT INTO notifications (user_id, title, body, url) VALUES (?, ?, ?, ?)").run(hans.id, 'Grete ist im Revier', 'Grete ist jetzt auf Kanzel Buchenhang. – bis zum Dunkelwerden', '/#karte');

  // Drückjagd
  const date = new Date(); date.setDate(date.getDate() + 30);
  const huntId = Number(db.prepare('INSERT INTO hunts (title, date, meet_time, meet_point, leader, description, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('Herbstdrückjagd Buchenhain', date.toISOString().slice(0, 10), '08:00', 'Parkplatz Forsthaus', 'Hans',
      'Freigabe: Schwarzwild alle Klassen, Rehwild (Kitz vor Ricke), Fuchs.\nKeine Schüsse in Richtung Straße K12. Signale: 1x lang = Jagd beginnt, 3x kurz = Jagd aus.\nSchüsseltreiben ab 15 Uhr im Forsthaus.', 'planung', hans.id).lastInsertRowid);
  const d = db.prepare('INSERT INTO hunt_drives (hunt_id, name, start_time, end_time, notes) VALUES (?, ?, ?, ?, ?)');
  const d1 = Number(d.run(huntId, 'Treiben 1 – Buchenhang', '09:30', '11:00', 'Treiber von Süden anstellen').lastInsertRowid);
  const d2 = Number(d.run(huntId, 'Treiben 2 – Bachtal', '11:30', '13:00', '').lastInsertRowid);
  const p = db.prepare('INSERT INTO hunt_participants (hunt_id, name, role, feature_id, drive_id, phone, confirmed) VALUES (?, ?, ?, ?, ?, ?, ?)');
  p.run(huntId, 'Hans', 'jagdleiter', null, null, '', 1);
  p.run(huntId, 'Grete', 'schuetze', ids['Kanzel Buchenhang'], d1, '0171 2345678', 1);
  p.run(huntId, 'Karl', 'schuetze', ids['Drückjagdbock Kreuzung'], d1, '', 0);
  p.run(huntId, 'Peter M.', 'hundefuehrer', null, d2, '', 1);
  p.run(huntId, 'Treibergruppe Dorf', 'treiber', null, d1, '', 0);
  const t = db.prepare('INSERT INTO hunt_tasks (hunt_id, text, done, assignee) VALUES (?, ?, ?, ?)');
  for (const [text, done, who] of [['Einladungen verschicken', 1, 'Hans'], ['Stände kontrollieren und freischneiden', 1, 'Karl'], ['Jagdleiter-Belehrung vorbereiten', 0, 'Hans'], ['Hundeführer organisieren', 1, 'Grete'], ['Streckenplatz und Wildwanne vorbereiten', 0, ''], ['Straßenschilder „Vorsicht Treibjagd“ beantragen', 0, 'Hans'], ['Schüsseltreiben planen', 0, 'Grete']]) t.run(huntId, text, done, who);
  return true;
}
