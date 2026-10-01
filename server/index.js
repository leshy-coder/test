import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { db, getSetting, setSetting } from './db.js';
import { register, login, logout, requireAuth, userFromToken, httpError } from './auth.js';
import { vapidKeys, saveSubscription, removeSubscription, notify } from './push.js';
import { getWeather } from './weather.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT || 3000);

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { etag: true, maxAge: 0 }));

// ---------- Realtime (WebSocket) ----------
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Map(); // ws -> user

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const user = userFromToken(url.searchParams.get('token'));
  if (!user) { ws.close(4001, 'unauthorized'); return; }
  clients.set(ws, user);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => { clients.delete(ws); broadcastPresence(); });
  broadcastPresence();
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

function broadcast(type, data = {}) {
  const msg = JSON.stringify({ type, data, at: new Date().toISOString() });
  for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(msg);
}
function broadcastPresence() {
  const online = [...new Map([...clients.values()].map(u => [u.id, u])).values()];
  broadcast('presence', { online });
}

// ---------- Helpers ----------
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const num = v => (v === null || v === undefined || v === '' ? null : Number(v));

function featureName(id) {
  if (!id) return null;
  const f = db.prepare('SELECT name FROM features WHERE id = ?').get(id);
  return f ? f.name : null;
}
function describeSpot(mode, featureId) {
  return mode === 'pirsch' ? 'auf der Pirsch' : `auf ${featureName(featureId) || 'einer Kanzel'}`;
}
function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: process.env.TZ || 'Europe/Berlin' });
}

// ---------- Auth ----------
app.post('/api/auth/register', wrap((req, res) => res.json(register(req.body.name, req.body.password))));
app.post('/api/auth/login', wrap((req, res) => res.json(login(req.body.name, req.body.password))));
app.post('/api/auth/logout', requireAuth, (req, res) => { logout(req.token); res.json({ ok: true }); });
app.get('/api/auth/me', requireAuth, (req, res) => res.json(req.user));
app.get('/api/users', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT id, name, color FROM users ORDER BY name').all());
});

// ---------- Push ----------
app.get('/api/push/key', (req, res) => res.json({ publicKey: vapidKeys.publicKey }));
app.post('/api/push/subscribe', requireAuth, (req, res) => { saveSubscription(req.user.id, req.body); res.json({ ok: true }); });
app.post('/api/push/unsubscribe', requireAuth, (req, res) => { removeSubscription(str(req.body.endpoint, 2000)); res.json({ ok: true }); });
app.post('/api/push/test', requireAuth, wrap(async (req, res) => {
  await notify([req.user.id], { title: 'Waidmannsheil!', body: 'Push-Benachrichtigungen funktionieren.', url: '/' });
  res.json({ ok: true });
}));

// ---------- Notifications inbox ----------
app.get('/api/notifications', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id));
});
app.post('/api/notifications/read', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

// ---------- Settings / Revier ----------
app.get('/api/revier', requireAuth, (req, res) => {
  res.json({
    name: getSetting('revier_name', 'Mein Revier'),
    center: getSetting('center', { lat: 51.1657, lng: 10.4515, zoom: 6 }),
    boundaries: db.prepare('SELECT * FROM boundaries ORDER BY id').all().map(b => ({ ...b, geojson: JSON.parse(b.geojson) })),
    features: db.prepare('SELECT * FROM features ORDER BY kind, name').all(),
  });
});
app.put('/api/revier/settings', requireAuth, (req, res) => {
  if (req.body.name !== undefined) setSetting('revier_name', str(req.body.name, 80) || 'Mein Revier');
  if (req.body.center) setSetting('center', { lat: Number(req.body.center.lat), lng: Number(req.body.center.lng), zoom: Number(req.body.center.zoom || 13) });
  broadcast('revier');
  res.json({ ok: true });
});

app.post('/api/boundaries', requireAuth, (req, res) => {
  const geo = req.body.geojson;
  if (!geo || geo.type !== 'Feature') throw httpError(400, 'Ungültige Geometrie.');
  const info = db.prepare('INSERT INTO boundaries (name, geojson, updated_by) VALUES (?, ?, ?)')
    .run(str(req.body.name, 80) || 'Reviergrenze', JSON.stringify(geo), req.user.id);
  broadcast('revier');
  res.json({ id: Number(info.lastInsertRowid) });
});
app.put('/api/boundaries/:id', requireAuth, (req, res) => {
  const sets = [];
  const vals = [];
  if (req.body.geojson) { sets.push('geojson = ?'); vals.push(JSON.stringify(req.body.geojson)); }
  if (req.body.name !== undefined) { sets.push('name = ?'); vals.push(str(req.body.name, 80)); }
  if (!sets.length) return res.json({ ok: true });
  sets.push('updated_by = ?', "updated_at = datetime('now')");
  vals.push(req.user.id, req.params.id);
  db.prepare(`UPDATE boundaries SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  broadcast('revier');
  res.json({ ok: true });
});
app.delete('/api/boundaries/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM boundaries WHERE id = ?').run(req.params.id);
  broadcast('revier');
  res.json({ ok: true });
});

app.post('/api/features', requireAuth, (req, res) => {
  const kind = ['kanzel', 'kamera', 'kirrung', 'sonstiges'].includes(req.body.kind) ? req.body.kind : 'sonstiges';
  const lat = num(req.body.lat), lng = num(req.body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw httpError(400, 'Position fehlt.');
  const info = db.prepare('INSERT INTO features (kind, name, lat, lng, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(kind, str(req.body.name, 80) || defaultName(kind), lat, lng, str(req.body.notes, 1000), req.user.id);
  broadcast('revier');
  res.json(db.prepare('SELECT * FROM features WHERE id = ?').get(info.lastInsertRowid));
});
function defaultName(kind) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM features WHERE kind = ?').get(kind).c + 1;
  return { kanzel: `Kanzel ${count}`, kamera: `Wildkamera ${count}`, kirrung: `Kirrung ${count}`, sonstiges: `Punkt ${count}` }[kind];
}
app.put('/api/features/:id', requireAuth, (req, res) => {
  const f = db.prepare('SELECT * FROM features WHERE id = ?').get(req.params.id);
  if (!f) throw httpError(404, 'Nicht gefunden.');
  db.prepare('UPDATE features SET name = ?, notes = ?, lat = ?, lng = ?, kind = ? WHERE id = ?').run(
    str(req.body.name ?? f.name, 80) || f.name,
    str(req.body.notes ?? f.notes, 1000),
    num(req.body.lat) ?? f.lat,
    num(req.body.lng) ?? f.lng,
    ['kanzel', 'kamera', 'kirrung', 'sonstiges'].includes(req.body.kind) ? req.body.kind : f.kind,
    f.id,
  );
  broadcast('revier');
  res.json(db.prepare('SELECT * FROM features WHERE id = ?').get(f.id));
});
app.delete('/api/features/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM features WHERE id = ?').run(req.params.id);
  broadcast('revier');
  res.json({ ok: true });
});

// ---------- Weather ----------
app.get('/api/weather', requireAuth, wrap(async (req, res) => {
  const center = getSetting('center', { lat: 51.1657, lng: 10.4515 });
  const lat = num(req.query.lat) ?? center.lat;
  const lng = num(req.query.lng) ?? center.lng;
  res.json(await getWeather(lat, lng));
}));

// ---------- Check-ins ----------
const activeCheckinsQuery = `
  SELECT c.*, u.name AS user_name, u.color AS user_color, f.name AS feature_name, f.lat, f.lng
  FROM checkins c JOIN users u ON u.id = c.user_id LEFT JOIN features f ON f.id = c.feature_id
  WHERE c.ended_at IS NULL ORDER BY c.started_at DESC`;

app.get('/api/checkins', requireAuth, (req, res) => {
  res.json({
    active: db.prepare(activeCheckinsQuery).all(),
    history: db.prepare(`SELECT c.*, u.name AS user_name, u.color AS user_color, f.name AS feature_name
      FROM checkins c JOIN users u ON u.id = c.user_id LEFT JOIN features f ON f.id = c.feature_id
      WHERE c.ended_at IS NOT NULL ORDER BY c.started_at DESC LIMIT 40`).all(),
  });
});

app.post('/api/checkins', requireAuth, wrap(async (req, res) => {
  const mode = req.body.mode === 'kanzel' ? 'kanzel' : 'pirsch';
  const featureId = mode === 'kanzel' ? num(req.body.feature_id) : null;
  if (mode === 'kanzel' && !featureId) throw httpError(400, 'Bitte eine Kanzel wählen.');
  // vorhandenes Check-in beenden
  db.prepare("UPDATE checkins SET ended_at = datetime('now') WHERE user_id = ? AND ended_at IS NULL").run(req.user.id);
  const info = db.prepare('INSERT INTO checkins (user_id, mode, feature_id, note) VALUES (?, ?, ?, ?)')
    .run(req.user.id, mode, featureId, str(req.body.note, 300));
  if (req.body.plan_id) {
    db.prepare("UPDATE plans SET status = 'gestartet' WHERE id = ? AND user_id = ?").run(req.body.plan_id, req.user.id);
  }
  broadcast('checkins');
  broadcast('plans');
  const spot = describeSpot(mode, featureId);
  await notify('all', {
    title: `${req.user.name} ist im Revier`,
    body: `${req.user.name} ist jetzt ${spot}.${req.body.note ? ' – ' + str(req.body.note, 100) : ''}`,
    url: '/#karte', tag: 'checkin',
  }, req.user.id);
  res.json(db.prepare('SELECT * FROM checkins WHERE id = ?').get(info.lastInsertRowid));
}));

app.post('/api/checkins/checkout', requireAuth, wrap(async (req, res) => {
  const active = db.prepare('SELECT * FROM checkins WHERE user_id = ? AND ended_at IS NULL').get(req.user.id);
  if (!active) return res.json({ ok: true });
  db.prepare("UPDATE checkins SET ended_at = datetime('now') WHERE id = ?").run(active.id);
  broadcast('checkins');
  await notify('all', {
    title: `${req.user.name} hat das Revier verlassen`,
    body: `${req.user.name} war ${describeSpot(active.mode, active.feature_id)} und hat ausgecheckt.`,
    url: '/#karte', tag: 'checkout',
  }, req.user.id);
  res.json({ ok: true });
}));

// ---------- Planned check-ins ----------
function planWithReceipts(id) {
  const p = db.prepare(`SELECT p.*, u.name AS user_name, u.color AS user_color, f.name AS feature_name
    FROM plans p JOIN users u ON u.id = p.user_id LEFT JOIN features f ON f.id = p.feature_id WHERE p.id = ?`).get(id);
  if (!p) return null;
  p.receipts = db.prepare(`SELECT r.*, u.name AS user_name, u.color AS user_color FROM plan_receipts r JOIN users u ON u.id = r.user_id WHERE r.plan_id = ? ORDER BY u.name`).all(id);
  return p;
}

app.get('/api/plans', requireAuth, (req, res) => {
  const ids = db.prepare(`SELECT id FROM plans WHERE status = 'offen' AND planned_at > datetime('now', '-12 hours')
    OR created_at > datetime('now', '-2 days') ORDER BY planned_at`).all();
  res.json(ids.map(r => planWithReceipts(r.id)));
});

app.post('/api/plans', requireAuth, wrap(async (req, res) => {
  const mode = req.body.mode === 'kanzel' ? 'kanzel' : 'pirsch';
  const featureId = mode === 'kanzel' ? num(req.body.feature_id) : null;
  if (mode === 'kanzel' && !featureId) throw httpError(400, 'Bitte eine Kanzel wählen.');
  const plannedAt = new Date(req.body.planned_at);
  if (Number.isNaN(plannedAt.getTime())) throw httpError(400, 'Ungültige Uhrzeit.');
  const info = db.prepare('INSERT INTO plans (user_id, mode, feature_id, planned_at, note) VALUES (?, ?, ?, ?, ?)')
    .run(req.user.id, mode, featureId, plannedAt.toISOString(), str(req.body.note, 300));
  const planId = Number(info.lastInsertRowid);
  const others = db.prepare('SELECT id FROM users WHERE id != ?').all(req.user.id).map(r => r.id);
  const ins = db.prepare('INSERT INTO plan_receipts (plan_id, user_id) VALUES (?, ?)');
  for (const uid of others) ins.run(planId, uid);
  broadcast('plans');
  await notify(others, {
    title: `Ansitz angekündigt: ${req.user.name}`,
    body: `${req.user.name} möchte ${fmtTime(plannedAt)} ${describeSpot(mode, featureId)} sein. Bitte bestätigen.`,
    url: `/#plan-${planId}`, tag: `plan-${planId}`,
  });
  res.json(planWithReceipts(planId));
}));

app.post('/api/plans/:id/read', requireAuth, (req, res) => {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
  if (!plan || plan.user_id === req.user.id) return res.json({ ok: true });
  const r = db.prepare('UPDATE plan_receipts SET read_at = COALESCE(read_at, datetime(\'now\')) WHERE plan_id = ? AND user_id = ? AND read_at IS NULL').run(plan.id, req.user.id);
  if (r.changes) broadcast('plans', { plan_id: plan.id });
  res.json({ ok: true });
});

app.post('/api/plans/:id/confirm', requireAuth, wrap(async (req, res) => {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
  if (!plan) throw httpError(404, 'Nicht gefunden.');
  if (plan.user_id === req.user.id) throw httpError(400, 'Eigene Ankündigung kann nicht bestätigt werden.');
  db.prepare(`INSERT INTO plan_receipts (plan_id, user_id, read_at, confirmed_at, comment) VALUES (?, ?, datetime('now'), datetime('now'), ?)
    ON CONFLICT(plan_id, user_id) DO UPDATE SET read_at = COALESCE(read_at, datetime('now')), confirmed_at = datetime('now'), comment = excluded.comment`)
    .run(plan.id, req.user.id, str(req.body.comment, 200));
  broadcast('plans', { plan_id: plan.id });
  await notify([plan.user_id], {
    title: `${req.user.name} hat bestätigt`,
    body: `${req.user.name} hat deine Ankündigung für ${fmtTime(plan.planned_at)} bestätigt.${req.body.comment ? ' „' + str(req.body.comment, 100) + '“' : ''}`,
    url: `/#plan-${plan.id}`, tag: `plan-${plan.id}-confirm`,
  });
  res.json(planWithReceipts(plan.id));
}));

app.post('/api/plans/:id/cancel', requireAuth, wrap(async (req, res) => {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!plan) throw httpError(404, 'Nicht gefunden.');
  db.prepare("UPDATE plans SET status = 'abgesagt' WHERE id = ?").run(plan.id);
  broadcast('plans');
  await notify('all', {
    title: `Ansitz abgesagt: ${req.user.name}`,
    body: `${req.user.name} hat den geplanten Ansitz ${fmtTime(plan.planned_at)} abgesagt.`,
    url: '/#ansitz', tag: `plan-${plan.id}`,
  }, req.user.id);
  res.json({ ok: true });
}));

// ---------- Drückjagd planning ----------
function huntFull(id) {
  const h = db.prepare('SELECT h.*, u.name AS created_by_name FROM hunts h LEFT JOIN users u ON u.id = h.created_by WHERE h.id = ?').get(id);
  if (!h) return null;
  h.participants = db.prepare('SELECT p.*, f.name AS feature_name FROM hunt_participants p LEFT JOIN features f ON f.id = p.feature_id WHERE hunt_id = ? ORDER BY role, name').all(id);
  h.drives = db.prepare('SELECT * FROM hunt_drives WHERE hunt_id = ? ORDER BY start_time, id').all(id).map(d => ({ ...d, geojson: d.geojson ? JSON.parse(d.geojson) : null }));
  h.tasks = db.prepare('SELECT * FROM hunt_tasks WHERE hunt_id = ? ORDER BY done, id').all(id);
  h.bag = db.prepare('SELECT * FROM hunt_bag WHERE hunt_id = ? ORDER BY id').all(id);
  return h;
}

app.get('/api/hunts', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT h.*, (SELECT COUNT(*) FROM hunt_participants p WHERE p.hunt_id = h.id) AS participant_count
    FROM hunts h ORDER BY date DESC`).all();
  res.json(rows);
});
app.get('/api/hunts/:id', requireAuth, (req, res) => {
  const h = huntFull(req.params.id);
  if (!h) throw httpError(404, 'Nicht gefunden.');
  res.json(h);
});
app.post('/api/hunts', requireAuth, wrap(async (req, res) => {
  if (!str(req.body.title, 120)) throw httpError(400, 'Titel fehlt.');
  if (!str(req.body.date, 20)) throw httpError(400, 'Datum fehlt.');
  const info = db.prepare('INSERT INTO hunts (title, date, meet_time, meet_point, leader, description, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(str(req.body.title, 120), str(req.body.date, 20), str(req.body.meet_time, 20), str(req.body.meet_point, 200), str(req.body.leader, 80), str(req.body.description, 4000), req.user.id);
  const id = Number(info.lastInsertRowid);
  const defaults = ['Einladungen verschicken', 'Stände kontrollieren und freischneiden', 'Jagdleiter-Belehrung vorbereiten', 'Hundeführer organisieren', 'Streckenplatz und Wildwanne vorbereiten', 'Behörde / Straßenschilder (Vorsicht Treibjagd) beantragen', 'Verpflegung (Schüsseltreiben) planen'];
  const ins = db.prepare('INSERT INTO hunt_tasks (hunt_id, text) VALUES (?, ?)');
  for (const t of defaults) ins.run(id, t);
  broadcast('hunts');
  await notify('all', {
    title: 'Neue Drückjagd geplant',
    body: `${req.user.name} hat „${str(req.body.title, 120)}“ am ${req.body.date} angelegt.`,
    url: `/#jagd-${id}`, tag: `hunt-${id}`,
  }, req.user.id);
  res.json(huntFull(id));
}));
app.put('/api/hunts/:id', requireAuth, (req, res) => {
  const h = db.prepare('SELECT * FROM hunts WHERE id = ?').get(req.params.id);
  if (!h) throw httpError(404, 'Nicht gefunden.');
  const status = ['planung', 'bestaetigt', 'abgeschlossen', 'abgesagt'].includes(req.body.status) ? req.body.status : h.status;
  db.prepare('UPDATE hunts SET title = ?, date = ?, meet_time = ?, meet_point = ?, leader = ?, description = ?, status = ? WHERE id = ?')
    .run(str(req.body.title ?? h.title, 120) || h.title, str(req.body.date ?? h.date, 20) || h.date, str(req.body.meet_time ?? h.meet_time, 20),
      str(req.body.meet_point ?? h.meet_point, 200), str(req.body.leader ?? h.leader, 80), str(req.body.description ?? h.description, 4000), status, h.id);
  broadcast('hunts', { hunt_id: h.id });
  res.json(huntFull(h.id));
});
app.delete('/api/hunts/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM hunts WHERE id = ?').run(req.params.id);
  broadcast('hunts');
  res.json({ ok: true });
});

// Sub-resources of hunts: participants, drives, tasks, bag
const ROLES = ['jagdleiter', 'schuetze', 'treiber', 'hundefuehrer', 'ansteller', 'helfer'];
app.post('/api/hunts/:id/participants', requireAuth, (req, res) => {
  if (!str(req.body.name, 80)) throw httpError(400, 'Name fehlt.');
  db.prepare('INSERT INTO hunt_participants (hunt_id, name, role, feature_id, drive_id, phone, confirmed, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.params.id, str(req.body.name, 80), ROLES.includes(req.body.role) ? req.body.role : 'schuetze', num(req.body.feature_id), num(req.body.drive_id), str(req.body.phone, 40), req.body.confirmed ? 1 : 0, str(req.body.notes, 500));
  broadcast('hunts', { hunt_id: Number(req.params.id) });
  res.json(huntFull(req.params.id));
});
app.put('/api/hunts/:id/participants/:pid', requireAuth, (req, res) => {
  const p = db.prepare('SELECT * FROM hunt_participants WHERE id = ? AND hunt_id = ?').get(req.params.pid, req.params.id);
  if (!p) throw httpError(404, 'Nicht gefunden.');
  db.prepare('UPDATE hunt_participants SET name = ?, role = ?, feature_id = ?, drive_id = ?, phone = ?, confirmed = ?, notes = ? WHERE id = ?')
    .run(str(req.body.name ?? p.name, 80) || p.name, ROLES.includes(req.body.role) ? req.body.role : p.role,
      'feature_id' in req.body ? num(req.body.feature_id) : p.feature_id, 'drive_id' in req.body ? num(req.body.drive_id) : p.drive_id,
      str(req.body.phone ?? p.phone, 40), 'confirmed' in req.body ? (req.body.confirmed ? 1 : 0) : p.confirmed, str(req.body.notes ?? p.notes, 500), p.id);
  broadcast('hunts', { hunt_id: Number(req.params.id) });
  res.json(huntFull(req.params.id));
});
app.delete('/api/hunts/:id/participants/:pid', requireAuth, (req, res) => {
  db.prepare('DELETE FROM hunt_participants WHERE id = ? AND hunt_id = ?').run(req.params.pid, req.params.id);
  broadcast('hunts', { hunt_id: Number(req.params.id) });
  res.json(huntFull(req.params.id));
});

app.post('/api/hunts/:id/drives', requireAuth, (req, res) => {
  if (!str(req.body.name, 80)) throw httpError(400, 'Name fehlt.');
  db.prepare('INSERT INTO hunt_drives (hunt_id, name, start_time, end_time, geojson, notes) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.params.id, str(req.body.name, 80), str(req.body.start_time, 10), str(req.body.end_time, 10), req.body.geojson ? JSON.stringify(req.body.geojson) : null, str(req.body.notes, 1000));
  broadcast('hunts', { hunt_id: Number(req.params.id) });
  res.json(huntFull(req.params.id));
});
app.put('/api/hunts/:id/drives/:did', requireAuth, (req, res) => {
  const d = db.prepare('SELECT * FROM hunt_drives WHERE id = ? AND hunt_id = ?').get(req.params.did, req.params.id);
  if (!d) throw httpError(404, 'Nicht gefunden.');
  db.prepare('UPDATE hunt_drives SET name = ?, start_time = ?, end_time = ?, geojson = ?, notes = ? WHERE id = ?')
    .run(str(req.body.name ?? d.name, 80) || d.name, str(req.body.start_time ?? d.start_time, 10), str(req.body.end_time ?? d.end_time, 10),
      'geojson' in req.body ? (req.body.geojson ? JSON.stringify(req.body.geojson) : null) : d.geojson, str(req.body.notes ?? d.notes, 1000), d.id);
  broadcast('hunts', { hunt_id: Number(req.params.id) });
  res.json(huntFull(req.params.id));
});
app.delete('/api/hunts/:id/drives/:did', requireAuth, (req, res) => {
  db.prepare('DELETE FROM hunt_drives WHERE id = ? AND hunt_id = ?').run(req.params.did, req.params.id);
  db.prepare('UPDATE hunt_participants SET drive_id = NULL WHERE drive_id = ?').run(req.params.did);
  broadcast('hunts', { hunt_id: Number(req.params.id) });
  res.json(huntFull(req.params.id));
});

app.post('/api/hunts/:id/tasks', requireAuth, (req, res) => {
  if (!str(req.body.text, 200)) throw httpError(400, 'Text fehlt.');
  db.prepare('INSERT INTO hunt_tasks (hunt_id, text, assignee) VALUES (?, ?, ?)').run(req.params.id, str(req.body.text, 200), str(req.body.assignee, 80));
  broadcast('hunts', { hunt_id: Number(req.params.id) });
  res.json(huntFull(req.params.id));
});
app.put('/api/hunts/:id/tasks/:tid', requireAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM hunt_tasks WHERE id = ? AND hunt_id = ?').get(req.params.tid, req.params.id);
  if (!t) throw httpError(404, 'Nicht gefunden.');
  db.prepare('UPDATE hunt_tasks SET text = ?, done = ?, assignee = ? WHERE id = ?')
    .run(str(req.body.text ?? t.text, 200) || t.text, 'done' in req.body ? (req.body.done ? 1 : 0) : t.done, str(req.body.assignee ?? t.assignee, 80), t.id);
  broadcast('hunts', { hunt_id: Number(req.params.id) });
  res.json(huntFull(req.params.id));
});
app.delete('/api/hunts/:id/tasks/:tid', requireAuth, (req, res) => {
  db.prepare('DELETE FROM hunt_tasks WHERE id = ? AND hunt_id = ?').run(req.params.tid, req.params.id);
  broadcast('hunts', { hunt_id: Number(req.params.id) });
  res.json(huntFull(req.params.id));
});

app.post('/api/hunts/:id/bag', requireAuth, (req, res) => {
  if (!str(req.body.species, 80)) throw httpError(400, 'Wildart fehlt.');
  db.prepare('INSERT INTO hunt_bag (hunt_id, species, count, shooter, notes) VALUES (?, ?, ?, ?, ?)')
    .run(req.params.id, str(req.body.species, 80), Math.max(1, Number(req.body.count) || 1), str(req.body.shooter, 80), str(req.body.notes, 300));
  broadcast('hunts', { hunt_id: Number(req.params.id) });
  res.json(huntFull(req.params.id));
});
app.delete('/api/hunts/:id/bag/:bid', requireAuth, (req, res) => {
  db.prepare('DELETE FROM hunt_bag WHERE id = ? AND hunt_id = ?').run(req.params.bid, req.params.id);
  broadcast('hunts', { hunt_id: Number(req.params.id) });
  res.json(huntFull(req.params.id));
});

// ---------- Fallback & errors ----------
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.use((err, req, res, next) => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Interner Fehler.' });
});

server.listen(PORT, () => console.log(`RevierApp läuft auf http://localhost:${PORT}`));
