/**
 * Express-App der RevierApp. Läuft lokal/Render als normaler Server (server/index.js)
 * und auf Netlify als Function (netlify/functions/api.js).
 */
import express from 'express';
import { getDb, getSetting, setSetting, bump, versions, now } from './db.js';
import { register, login, logout, requireAuth, requireAdmin, httpError, userCount, getInviteCode, setInviteCode, changePassword, setPassword } from './auth.js';
import { getVapidKeys, saveSubscription, removeSubscription, notify } from './push.js';
import { getWeather } from './weather.js';

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const num = v => (v === null || v === undefined || v === '' ? null : Number(v));
const KINDS = ['kanzel', 'kamera', 'kirrung', 'sonstiges'];
const ROLES = ['jagdleiter', 'schuetze', 'treiber', 'hundefuehrer', 'ansteller', 'helfer'];
const HUNT_TYPES = ['drueckjagd', 'ansitz', 'buschieren', 'vogeljagd', 'frettieren', 'fallenjagd', 'revierarbeit', 'sonstiges'];
const HUNT_STATUS = ['planung', 'bestaetigt', 'abgeschlossen', 'abgesagt'];
const ONLINE_WINDOW_MS = 45000;

function fmtTime(iso) {
  return new Date(iso).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: process.env.TZ || 'Europe/Berlin' });
}

/**
 * @param {{ onChange?: (name: string, data?: object) => void }} opts  onChange wird nach jeder Änderung aufgerufen (lokal: WebSocket-Broadcast)
 */
export function createApp({ onChange = () => {} } = {}) {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '8mb' }));

  const changed = async (name, data = {}) => { await bump(name); onChange(name, data); };
  const featureName = async (db, id) => id ? (await db.get('SELECT name FROM features WHERE id = ?', [id]))?.name || null : null;
  const describeSpot = async (db, mode, featureId) => mode === 'pirsch' ? 'auf der Pirsch' : `auf ${(await featureName(db, featureId)) || 'einer Kanzel'}`;

  // ---------- Health & Änderungsabfrage ----------
  app.get('/api/health', async (req, res) => {
    try {
      const db = await getDb();
      const users = Number((await db.get('SELECT COUNT(*) AS c FROM users')).c);
      res.json({ ok: true, db: db.dialect, users, hasDbUrl: !!(process.env.DATABASE_URL || process.env.NETLIFY_DB_URL), netlify: !!(globalThis.Netlify || process.env.NETLIFY) });
    } catch (e) {
      console.error('Health-Check fehlgeschlagen', e);
      res.status(500).json({ ok: false, error: `${e.name || 'Error'}: ${e.message}`, hasDbUrl: !!(process.env.DATABASE_URL || process.env.NETLIFY_DB_URL), netlify: !!(globalThis.Netlify || process.env.NETLIFY) });
    }
  });
  app.get('/api/changes', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    await db.run('UPDATE users SET last_seen = ? WHERE id = ?', [now(), req.user.id]);
    const since = new Date(Date.now() - ONLINE_WINDOW_MS).toISOString();
    const online = await db.all('SELECT id, name, color FROM users WHERE last_seen > ? ORDER BY name', [since]);
    res.json({ versions: await versions(), online });
  }));

  // ---------- Auth ----------
  app.get('/api/auth/status', wrap(async (req, res) => res.json({ needsSetup: (await userCount()) === 0, hasInviteCode: !!(await getInviteCode()) })));
  app.post('/api/auth/register', wrap(async (req, res) => { const r = await register(req.body.name, req.body.password, req.body.invite_code); await changed('users'); res.json(r); }));
  app.post('/api/auth/login', wrap(async (req, res) => res.json(await login(req.body.name, req.body.password))));
  app.post('/api/auth/logout', requireAuth, wrap(async (req, res) => { await logout(req.token); res.json({ ok: true }); }));
  app.get('/api/auth/me', requireAuth, (req, res) => res.json(req.user));
  app.post('/api/auth/password', requireAuth, wrap(async (req, res) => { await changePassword(req.user.id, req.body.old_password, req.body.new_password); res.json({ ok: true }); }));
  app.get('/api/users', requireAuth, wrap(async (req, res) => { const db = await getDb(); res.json(await db.all('SELECT id, name, color, is_admin, created_at FROM users ORDER BY name')); }));

  // ---------- Admin ----------
  app.get('/api/admin/invite', requireAuth, requireAdmin, wrap(async (req, res) => res.json({ code: await getInviteCode(), fromEnv: !!process.env.INVITE_CODE })));
  app.put('/api/admin/invite', requireAuth, requireAdmin, wrap(async (req, res) => {
    if (process.env.INVITE_CODE) throw httpError(400, 'Der Code ist per Umgebungsvariable INVITE_CODE festgelegt.');
    await setInviteCode(req.body.code); res.json({ ok: true });
  }));
  app.post('/api/admin/users/:id/reset-password', requireAuth, requireAdmin, wrap(async (req, res) => {
    const db = await getDb();
    const u = await db.get('SELECT id, name FROM users WHERE id = ?', [req.params.id]);
    if (!u) throw httpError(404, 'Nutzer nicht gefunden.');
    const temp = Math.random().toString(36).slice(2, 8);
    await setPassword(u.id, temp);
    res.json({ ok: true, name: u.name, password: temp });
  }));
  app.put('/api/admin/users/:id/admin', requireAuth, requireAdmin, wrap(async (req, res) => {
    if (Number(req.params.id) === req.user.id && !req.body.is_admin) throw httpError(400, 'Du kannst dir selbst die Admin-Rechte nicht entziehen.');
    const db = await getDb();
    await db.run('UPDATE users SET is_admin = ? WHERE id = ?', [req.body.is_admin ? 1 : 0, req.params.id]);
    await changed('users'); res.json({ ok: true });
  }));
  app.delete('/api/admin/users/:id', requireAuth, requireAdmin, wrap(async (req, res) => {
    if (Number(req.params.id) === req.user.id) throw httpError(400, 'Du kannst dich nicht selbst löschen.');
    const db = await getDb();
    await db.run('DELETE FROM users WHERE id = ?', [req.params.id]);
    await changed('users'); await changed('checkins'); await changed('plans');
    res.json({ ok: true });
  }));

  // ---------- Push ----------
  app.get('/api/push/key', wrap(async (req, res) => res.json({ publicKey: (await getVapidKeys()).publicKey })));
  app.post('/api/push/subscribe', requireAuth, wrap(async (req, res) => { await saveSubscription(req.user.id, req.body); res.json({ ok: true }); }));
  app.post('/api/push/unsubscribe', requireAuth, wrap(async (req, res) => { await removeSubscription(str(req.body.endpoint, 2000)); res.json({ ok: true }); }));
  app.post('/api/push/test', requireAuth, wrap(async (req, res) => {
    await notify([req.user.id], { title: 'Waidmannsheil!', body: 'Push-Benachrichtigungen funktionieren.', url: '/' });
    res.json({ ok: true });
  }));

  // ---------- Benachrichtigungen ----------
  app.get('/api/notifications', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    res.json(await db.all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50', [req.user.id]));
  }));
  app.post('/api/notifications/read', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    await db.run('UPDATE notifications SET read = 1 WHERE user_id = ?', [req.user.id]); res.json({ ok: true });
  }));

  // ---------- Revier ----------
  app.get('/api/revier', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    res.json({
      name: await getSetting('revier_name', 'Mein Revier'),
      center: await getSetting('center', { lat: 51.1657, lng: 10.4515, zoom: 6 }),
      boundaries: (await db.all('SELECT * FROM boundaries ORDER BY id')).map(b => ({ ...b, geojson: JSON.parse(b.geojson) })),
      features: await db.all('SELECT * FROM features ORDER BY kind, name'),
    });
  }));
  app.put('/api/revier/settings', requireAuth, wrap(async (req, res) => {
    if (req.body.name !== undefined) await setSetting('revier_name', str(req.body.name, 80) || 'Mein Revier');
    if (req.body.center) await setSetting('center', { lat: Number(req.body.center.lat), lng: Number(req.body.center.lng), zoom: Number(req.body.center.zoom || 13) });
    await changed('revier'); res.json({ ok: true });
  }));

  app.post('/api/boundaries', requireAuth, wrap(async (req, res) => {
    const geo = req.body.geojson;
    if (!geo || geo.type !== 'Feature') throw httpError(400, 'Ungültige Geometrie.');
    const db = await getDb();
    const id = await db.insert('INSERT INTO boundaries (name, geojson, updated_by, updated_at) VALUES (?, ?, ?, ?)', [str(req.body.name, 80) || 'Reviergrenze', JSON.stringify(geo), req.user.id, now()]);
    await changed('revier'); res.json({ id });
  }));
  app.put('/api/boundaries/:id', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    const b = await db.get('SELECT * FROM boundaries WHERE id = ?', [req.params.id]);
    if (!b) throw httpError(404, 'Nicht gefunden.');
    await db.run('UPDATE boundaries SET geojson = ?, name = ?, updated_by = ?, updated_at = ? WHERE id = ?',
      [req.body.geojson ? JSON.stringify(req.body.geojson) : b.geojson, req.body.name !== undefined ? str(req.body.name, 80) : b.name, req.user.id, now(), b.id]);
    await changed('revier'); res.json({ ok: true });
  }));
  app.delete('/api/boundaries/:id', requireAuth, wrap(async (req, res) => {
    const db = await getDb(); await db.run('DELETE FROM boundaries WHERE id = ?', [req.params.id]);
    await changed('revier'); res.json({ ok: true });
  }));

  // ---------- Gebiete innerhalb des Reviers ----------
  app.get('/api/areas', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    res.json((await db.all('SELECT * FROM areas ORDER BY name')).map(a => ({ ...a, geojson: JSON.parse(a.geojson) })));
  }));
  app.post('/api/areas', requireAuth, wrap(async (req, res) => {
    const geo = req.body.geojson;
    if (!geo || geo.type !== 'Feature') throw httpError(400, 'Ungültige Geometrie.');
    const db = await getDb();
    const id = await db.insert('INSERT INTO areas (name, color, geojson, notes, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [str(req.body.name, 80) || 'Gebiet', /^#[0-9a-f]{6}$/i.test(req.body.color || '') ? req.body.color : '#6b8e23', JSON.stringify(geo), str(req.body.notes, 500), req.user.id, now()]);
    await changed('areas'); res.json({ id });
  }));
  app.put('/api/areas/:id', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    const a = await db.get('SELECT * FROM areas WHERE id = ?', [req.params.id]);
    if (!a) throw httpError(404, 'Nicht gefunden.');
    await db.run('UPDATE areas SET name = ?, color = ?, geojson = ?, notes = ?, updated_by = ?, updated_at = ? WHERE id = ?', [
      str(req.body.name ?? a.name, 80) || a.name, /^#[0-9a-f]{6}$/i.test(req.body.color || '') ? req.body.color : a.color,
      req.body.geojson ? JSON.stringify(req.body.geojson) : a.geojson, str(req.body.notes ?? a.notes, 500), req.user.id, now(), a.id]);
    await changed('areas'); res.json({ ok: true });
  }));
  app.delete('/api/areas/:id', requireAuth, wrap(async (req, res) => {
    const db = await getDb(); await db.run('DELETE FROM areas WHERE id = ?', [req.params.id]);
    await changed('areas'); res.json({ ok: true });
  }));

  app.post('/api/features', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    const kind = KINDS.includes(req.body.kind) ? req.body.kind : 'sonstiges';
    const lat = num(req.body.lat), lng = num(req.body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw httpError(400, 'Position fehlt.');
    let name = str(req.body.name, 80);
    if (!name) {
      const c = Number((await db.get('SELECT COUNT(*) AS c FROM features WHERE kind = ?', [kind])).c) + 1;
      name = { kanzel: `Kanzel ${c}`, kamera: `Wildkamera ${c}`, kirrung: `Kirrung ${c}`, sonstiges: `Punkt ${c}` }[kind];
    }
    const id = await db.insert('INSERT INTO features (kind, name, lat, lng, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [kind, name, lat, lng, str(req.body.notes, 1000), req.user.id, now()]);
    await changed('revier'); res.json(await db.get('SELECT * FROM features WHERE id = ?', [id]));
  }));
  app.put('/api/features/:id', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    const f = await db.get('SELECT * FROM features WHERE id = ?', [req.params.id]);
    if (!f) throw httpError(404, 'Nicht gefunden.');
    await db.run('UPDATE features SET name = ?, notes = ?, lat = ?, lng = ?, kind = ? WHERE id = ?', [
      str(req.body.name ?? f.name, 80) || f.name, str(req.body.notes ?? f.notes, 1000), num(req.body.lat) ?? f.lat, num(req.body.lng) ?? f.lng,
      KINDS.includes(req.body.kind) ? req.body.kind : f.kind, f.id]);
    await changed('revier'); res.json(await db.get('SELECT * FROM features WHERE id = ?', [f.id]));
  }));
  app.delete('/api/features/:id', requireAuth, wrap(async (req, res) => {
    const db = await getDb(); await db.run('DELETE FROM features WHERE id = ?', [req.params.id]);
    await changed('revier'); res.json({ ok: true });
  }));

  // ---------- Fährten / Wildbeobachtungen ----------
  const SPECIES = ['Schwarzwild', 'Rehwild', 'Rotwild', 'Damwild', 'Muffelwild', 'Fuchs', 'Dachs', 'Waschbär', 'Wolf', 'Sonstiges'];
  const SIGHTING_KINDS = ['faehrte', 'sichtung', 'losung', 'wuehlstelle', 'suhle', 'wildschaden', 'riss', 'fallwild', 'wildkamera'];
  const SIGHTING_SELECT = 'SELECT s.*, u.name AS user_name, u.color AS user_color FROM sightings s LEFT JOIN users u ON u.id = s.user_id';
  app.get('/api/sightings', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    const since = new Date(Date.now() - 30 * 86400e3).toISOString();
    res.json(await db.all(`${SIGHTING_SELECT} WHERE s.observed_at > ? ORDER BY s.observed_at DESC`, [since]));
  }));
  app.post('/api/sightings', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    const lat = num(req.body.lat), lng = num(req.body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw httpError(400, 'Position fehlt.');
    const species = SPECIES.includes(req.body.species) ? req.body.species : 'Sonstiges';
    const kind = SIGHTING_KINDS.includes(req.body.kind) ? req.body.kind : 'faehrte';
    const observed = req.body.observed_at ? new Date(req.body.observed_at) : new Date();
    if (Number.isNaN(observed.getTime())) throw httpError(400, 'Ungültiger Zeitpunkt.');
    const id = await db.insert('INSERT INTO sightings (user_id, species, kind, note, lat, lng, observed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [req.user.id, species, kind, str(req.body.note, 300), lat, lng, observed.toISOString(), now()]);
    await changed('sightings');
    const kindText = { faehrte: 'Fährte', sichtung: 'Sichtung', losung: 'Losung', wuehlstelle: 'Wühlstelle', suhle: 'Suhle', wildschaden: 'Wildschaden', riss: 'Riss', fallwild: 'Fallwild', wildkamera: 'Wildkamera-Aufnahme' }[kind];
    await notify('all', { title: `${species}: ${kindText}`, body: `${req.user.name} hat ${species} gemeldet (${kindText}, ${fmtTime(observed)}).${req.body.note ? ' – ' + str(req.body.note, 100) : ''}`, url: `/#karte`, tag: `sighting-${id}` }, req.user.id);
    res.json(await db.get(`${SIGHTING_SELECT} WHERE s.id = ?`, [id]));
  }));
  app.put('/api/sightings/:id', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    const sg = await db.get('SELECT * FROM sightings WHERE id = ?', [req.params.id]);
    if (!sg) throw httpError(404, 'Nicht gefunden.');
    if (sg.user_id !== req.user.id && !req.user.is_admin) throw httpError(403, 'Nur eigene Meldungen können geändert werden.');
    const observed = req.body.observed_at ? new Date(req.body.observed_at) : null;
    await db.run('UPDATE sightings SET species = ?, kind = ?, note = ?, lat = ?, lng = ?, observed_at = ? WHERE id = ?', [
      SPECIES.includes(req.body.species) ? req.body.species : sg.species, SIGHTING_KINDS.includes(req.body.kind) ? req.body.kind : sg.kind,
      str(req.body.note ?? sg.note, 300), num(req.body.lat) ?? sg.lat, num(req.body.lng) ?? sg.lng,
      observed && !Number.isNaN(observed.getTime()) ? observed.toISOString() : sg.observed_at, sg.id]);
    await changed('sightings');
    res.json(await db.get(`${SIGHTING_SELECT} WHERE s.id = ?`, [sg.id]));
  }));
  app.delete('/api/sightings/:id', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    const sg = await db.get('SELECT * FROM sightings WHERE id = ?', [req.params.id]);
    if (!sg) throw httpError(404, 'Nicht gefunden.');
    if (sg.user_id !== req.user.id && !req.user.is_admin) throw httpError(403, 'Nur eigene Meldungen können gelöscht werden.');
    await db.run('DELETE FROM sightings WHERE id = ?', [sg.id]);
    await changed('sightings');
    res.json({ ok: true });
  }));

  // ---------- Anschüsse / Nachsuche ----------
  const SHOT_STATUS = ['offen', 'nachsuche', 'gefunden', 'abgebrochen'];
  const SHOT_SELECT = `SELECT s.*, u.name AS user_name, u.color AS user_color, f.name AS feature_name,
    (SELECT CAST(COUNT(*) AS INTEGER) FROM shot_photos p WHERE p.shot_id = s.id) AS photo_count,
    (SELECT COALESCE(SUM(t.distance_m), 0) FROM shot_tracks t WHERE t.shot_id = s.id) AS track_m
    FROM shots s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN features f ON f.id = s.feature_id`;
  const bearingTo = (lat1, lng1, lat2, lng2) => {
    const r = Math.PI / 180, dLng = (lng2 - lng1) * r;
    const y = Math.sin(dLng) * Math.cos(lat2 * r), x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos(dLng);
    return ((Math.atan2(y, x) / r) + 360) % 360;
  };
  const compassName = deg => ['N', 'NNO', 'NO', 'ONO', 'O', 'OSO', 'SO', 'SSO', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(deg / 22.5) % 16];
  function photoOk(d) { return typeof d === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(d) && d.length < 2_000_000; }
  // Fluchtweg: Liste von [lat, lng]; die Peilung des ersten Abschnitts wird als flight_bearing mitgeführt
  function parsePath(v) {
    if (!Array.isArray(v)) return null;
    const pts = v.filter(p => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]))).map(p => [Number(p[0]), Number(p[1])]).slice(0, 200);
    return pts;
  }
  const trackLength = pts => { let d = 0; for (let i = 1; i < pts.length; i++) d += haversine(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]); return d; };
  function haversine(lat1, lng1, lat2, lng2) {
    const r = Math.PI / 180, R = 6371000, dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  const canEditShot = (shot, user) => shot.user_id === user.id || !!user.is_admin;

  app.get('/api/shots', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    const since = new Date(Date.now() - 60 * 86400e3).toISOString();
    res.json(await db.all(`${SHOT_SELECT} WHERE s.shot_at > ? OR s.status IN ('offen', 'nachsuche') ORDER BY s.shot_at DESC`, [since]));
  }));
  app.get('/api/shots/:id/photos', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    res.json(await db.all('SELECT id, data, created_at FROM shot_photos WHERE shot_id = ? ORDER BY id', [req.params.id]));
  }));
  app.post('/api/shots', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    const lat = num(req.body.lat), lng = num(req.body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw httpError(400, 'Position fehlt.');
    const shotAt = req.body.shot_at ? new Date(req.body.shot_at) : new Date();
    if (Number.isNaN(shotAt.getTime())) throw httpError(400, 'Ungültiger Zeitpunkt.');
    let bearing = num(req.body.flight_bearing);
    const path = parsePath(req.body.flight_path);
    if (path && path.length) bearing = bearingTo(lat, lng, path[0][0], path[0][1]);
    const id = await db.insert('INSERT INTO shots (user_id, species, shot_at, lat, lng, flight_bearing, flight_path, signs, note, status, feature_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [req.user.id, str(req.body.species, 60) || 'Unbekannt', shotAt.toISOString(), lat, lng, Number.isFinite(bearing) ? ((bearing % 360) + 360) % 360 : null, path && path.length ? JSON.stringify(path) : null,
        str(req.body.signs, 300), str(req.body.note, 1000), SHOT_STATUS.includes(req.body.status) ? req.body.status : 'offen', num(req.body.feature_id), now()]);
    for (const d of (Array.isArray(req.body.photos) ? req.body.photos : []).slice(0, 5)) {
      if (photoOk(d)) await db.run('INSERT INTO shot_photos (shot_id, data, created_at) VALUES (?, ?, ?)', [id, d, now()]);
    }
    await changed('shots');
    const dir = Number.isFinite(bearing) ? `, Flucht Richtung ${compassName(bearing)}` : '';
    await notify('all', { title: `Anschuss: ${str(req.body.species, 60) || 'Wild'}`, body: `${req.user.name} hat einen Anschuss markiert (${fmtTime(shotAt)}${dir}).${req.body.note ? ' – ' + str(req.body.note, 100) : ''}`, url: '/#karte', tag: `shot-${id}` }, req.user.id);
    res.json(await db.get(`${SHOT_SELECT} WHERE s.id = ?`, [id]));
  }));
  app.put('/api/shots/:id', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    const sh = await db.get('SELECT * FROM shots WHERE id = ?', [req.params.id]);
    if (!sh) throw httpError(404, 'Nicht gefunden.');
    if (!canEditShot(sh, req.user)) throw httpError(403, 'Nur der Schütze oder der Admin kann das ändern.');
    const shotAt = req.body.shot_at ? new Date(req.body.shot_at) : null;
    let bearing = 'flight_bearing' in req.body ? num(req.body.flight_bearing) : sh.flight_bearing;
    let fl = 'flight_lat' in req.body ? num(req.body.flight_lat) : sh.flight_lat, fg = 'flight_lng' in req.body ? num(req.body.flight_lng) : sh.flight_lng;
    const lat = num(req.body.lat) ?? sh.lat, lng = num(req.body.lng) ?? sh.lng;
    let pathJson = sh.flight_path;
    if ('flight_path' in req.body) {
      const path = parsePath(req.body.flight_path);
      pathJson = path && path.length ? JSON.stringify(path) : null;
      if (path && path.length) { bearing = bearingTo(lat, lng, path[0][0], path[0][1]); fl = null; fg = null; }
    } else if (Number.isFinite(fl) && Number.isFinite(fg) && ('flight_lat' in req.body || 'flight_lng' in req.body)) {
      // Einzelner Richtungspunkt: als erster Punkt des Fluchtwegs übernehmen
      bearing = bearingTo(lat, lng, fl, fg); pathJson = JSON.stringify([[fl, fg]]);
    }
    const status = SHOT_STATUS.includes(req.body.status) ? req.body.status : sh.status;
    await db.run('UPDATE shots SET species = ?, shot_at = ?, lat = ?, lng = ?, flight_bearing = ?, flight_path = ?, flight_lat = ?, flight_lng = ?, signs = ?, note = ?, status = ?, feature_id = ?, found_lat = ?, found_lng = ? WHERE id = ?', [
      str(req.body.species ?? sh.species, 60) || sh.species, shotAt && !Number.isNaN(shotAt.getTime()) ? shotAt.toISOString() : sh.shot_at, lat, lng,
      Number.isFinite(bearing) ? ((bearing % 360) + 360) % 360 : null, pathJson, Number.isFinite(fl) ? fl : null, Number.isFinite(fg) ? fg : null,
      str(req.body.signs ?? sh.signs, 300), str(req.body.note ?? sh.note, 1000), status, 'feature_id' in req.body ? num(req.body.feature_id) : sh.feature_id,
      'found_lat' in req.body ? num(req.body.found_lat) : sh.found_lat, 'found_lng' in req.body ? num(req.body.found_lng) : sh.found_lng, sh.id]);
    for (const d of (Array.isArray(req.body.photos) ? req.body.photos : []).slice(0, 5)) {
      if (photoOk(d)) await db.run('INSERT INTO shot_photos (shot_id, data, created_at) VALUES (?, ?, ?)', [sh.id, d, now()]);
    }
    await changed('shots');
    if (status !== sh.status) {
      const text = { nachsuche: 'Nachsuche läuft', gefunden: 'Stück gefunden – Waidmannsheil!', abgebrochen: 'Nachsuche abgebrochen', offen: 'wieder offen' }[status];
      await notify('all', { title: `Anschuss ${sh.species}: ${text}`, body: `${req.user.name}: ${text}.`, url: '/#karte', tag: `shot-${sh.id}` }, req.user.id);
    }
    res.json(await db.get(`${SHOT_SELECT} WHERE s.id = ?`, [sh.id]));
  }));
  // Nachsuche-Strecke (GPS-Aufzeichnung des Nachsuchers)
  app.get('/api/shots/:id/tracks', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    res.json((await db.all('SELECT t.*, u.name AS user_name FROM shot_tracks t LEFT JOIN users u ON u.id = t.user_id WHERE t.shot_id = ? ORDER BY t.id', [req.params.id])).map(t => ({ ...t, points: JSON.parse(t.points) })));
  }));
  app.post('/api/shots/:id/tracks', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    if (!(await db.get('SELECT id FROM shots WHERE id = ?', [req.params.id]))) throw httpError(404, 'Nicht gefunden.');
    const pts = parsePath(req.body.points) || [];
    const id = await db.insert('INSERT INTO shot_tracks (shot_id, user_id, points, distance_m, started_at) VALUES (?, ?, ?, ?, ?)', [req.params.id, req.user.id, JSON.stringify(pts), trackLength(pts), now()]);
    await changed('shots'); res.json({ id });
  }));
  app.put('/api/shots/:id/tracks/:tid', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    const t = await db.get('SELECT * FROM shot_tracks WHERE id = ? AND shot_id = ?', [req.params.tid, req.params.id]);
    if (!t) throw httpError(404, 'Nicht gefunden.');
    if (t.user_id !== req.user.id && !req.user.is_admin) throw httpError(403, 'Nur die eigene Aufzeichnung kann geändert werden.');
    const pts = 'points' in req.body ? (parsePath(req.body.points) || []) : JSON.parse(t.points);
    await db.run('UPDATE shot_tracks SET points = ?, distance_m = ?, ended_at = ? WHERE id = ?', [JSON.stringify(pts), trackLength(pts), req.body.ended ? now() : t.ended_at, t.id]);
    await changed('shots', { quiet: true }); res.json({ ok: true, distance_m: trackLength(pts), points: pts.length });
  }));
  app.delete('/api/shots/:id/tracks/:tid', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    const t = await db.get('SELECT * FROM shot_tracks WHERE id = ? AND shot_id = ?', [req.params.tid, req.params.id]);
    if (!t) throw httpError(404, 'Nicht gefunden.');
    if (t.user_id !== req.user.id && !req.user.is_admin) throw httpError(403, 'Nur die eigene Aufzeichnung kann gelöscht werden.');
    await db.run('DELETE FROM shot_tracks WHERE id = ?', [t.id]);
    await changed('shots'); res.json({ ok: true });
  }));
  app.delete('/api/shots/:id/photos/:pid', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    const sh = await db.get('SELECT * FROM shots WHERE id = ?', [req.params.id]);
    if (!sh) throw httpError(404, 'Nicht gefunden.');
    if (!canEditShot(sh, req.user)) throw httpError(403, 'Nur der Schütze oder der Admin kann das ändern.');
    await db.run('DELETE FROM shot_photos WHERE id = ? AND shot_id = ?', [req.params.pid, sh.id]);
    await changed('shots'); res.json({ ok: true });
  }));
  app.delete('/api/shots/:id', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    const sh = await db.get('SELECT * FROM shots WHERE id = ?', [req.params.id]);
    if (!sh) throw httpError(404, 'Nicht gefunden.');
    if (!canEditShot(sh, req.user)) throw httpError(403, 'Nur der Schütze oder der Admin kann das löschen.');
    await db.run('DELETE FROM shots WHERE id = ?', [sh.id]);
    await changed('shots'); res.json({ ok: true });
  }));

  // ---------- Wetter ----------
  app.get('/api/weather', requireAuth, wrap(async (req, res) => {
    const center = await getSetting('center', { lat: 51.1657, lng: 10.4515 });
    res.json(await getWeather(num(req.query.lat) ?? center.lat, num(req.query.lng) ?? center.lng));
  }));

  // ---------- Check-ins ----------
  const CHECKIN_SELECT = `SELECT c.*, u.name AS user_name, u.color AS user_color, f.name AS feature_name, f.lat, f.lng
    FROM checkins c JOIN users u ON u.id = c.user_id LEFT JOIN features f ON f.id = c.feature_id`;
  app.get('/api/checkins', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    res.json({
      active: await db.all(`${CHECKIN_SELECT} WHERE c.ended_at IS NULL ORDER BY c.started_at DESC`),
      history: await db.all(`${CHECKIN_SELECT} WHERE c.ended_at IS NOT NULL ORDER BY c.started_at DESC LIMIT 40`),
    });
  }));
  app.post('/api/checkins', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    const mode = req.body.mode === 'kanzel' ? 'kanzel' : 'pirsch';
    const featureId = mode === 'kanzel' ? num(req.body.feature_id) : null;
    if (mode === 'kanzel' && !featureId) throw httpError(400, 'Bitte eine Kanzel wählen.');
    await db.run('UPDATE checkins SET ended_at = ? WHERE user_id = ? AND ended_at IS NULL', [now(), req.user.id]);
    const id = await db.insert('INSERT INTO checkins (user_id, mode, feature_id, note, started_at) VALUES (?, ?, ?, ?, ?)', [req.user.id, mode, featureId, str(req.body.note, 300), now()]);
    if (req.body.plan_id) await db.run("UPDATE plans SET status = 'gestartet' WHERE id = ? AND user_id = ?", [req.body.plan_id, req.user.id]);
    await changed('checkins'); await changed('plans');
    const spot = await describeSpot(db, mode, featureId);
    await notify('all', { title: `${req.user.name} ist im Revier`, body: `${req.user.name} ist jetzt ${spot}.${req.body.note ? ' – ' + str(req.body.note, 100) : ''}`, url: '/#karte', tag: 'checkin' }, req.user.id);
    res.json(await db.get('SELECT * FROM checkins WHERE id = ?', [id]));
  }));
  app.post('/api/checkins/checkout', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    const active = await db.get('SELECT * FROM checkins WHERE user_id = ? AND ended_at IS NULL', [req.user.id]);
    if (!active) return res.json({ ok: true });
    await db.run('UPDATE checkins SET ended_at = ? WHERE id = ?', [now(), active.id]);
    await changed('checkins');
    await notify('all', { title: `${req.user.name} hat das Revier verlassen`, body: `${req.user.name} war ${await describeSpot(db, active.mode, active.feature_id)} und hat ausgecheckt.`, url: '/#karte', tag: 'checkout' }, req.user.id);
    res.json({ ok: true });
  }));

  // ---------- Angekündigte Ansitze ----------
  async function planWithReceipts(db, id) {
    const p = await db.get(`SELECT p.*, u.name AS user_name, u.color AS user_color, f.name AS feature_name
      FROM plans p JOIN users u ON u.id = p.user_id LEFT JOIN features f ON f.id = p.feature_id WHERE p.id = ?`, [id]);
    if (!p) return null;
    p.receipts = await db.all('SELECT r.*, u.name AS user_name, u.color AS user_color FROM plan_receipts r JOIN users u ON u.id = r.user_id WHERE r.plan_id = ? ORDER BY u.name', [id]);
    return p;
  }
  app.get('/api/plans', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    const h12 = new Date(Date.now() - 12 * 3600e3).toISOString(), d2 = new Date(Date.now() - 48 * 3600e3).toISOString();
    const ids = await db.all("SELECT id FROM plans WHERE (status = 'offen' AND planned_at > ?) OR created_at > ? ORDER BY planned_at", [h12, d2]);
    res.json(await Promise.all(ids.map(r => planWithReceipts(db, r.id))));
  }));
  app.post('/api/plans', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    const mode = req.body.mode === 'kanzel' ? 'kanzel' : 'pirsch';
    const featureId = mode === 'kanzel' ? num(req.body.feature_id) : null;
    if (mode === 'kanzel' && !featureId) throw httpError(400, 'Bitte eine Kanzel wählen.');
    const plannedAt = new Date(req.body.planned_at);
    if (Number.isNaN(plannedAt.getTime())) throw httpError(400, 'Ungültige Uhrzeit.');
    const planId = await db.insert('INSERT INTO plans (user_id, mode, feature_id, planned_at, note, created_at) VALUES (?, ?, ?, ?, ?, ?)', [req.user.id, mode, featureId, plannedAt.toISOString(), str(req.body.note, 300), now()]);
    const others = (await db.all('SELECT id FROM users WHERE id != ?', [req.user.id])).map(r => r.id);
    for (const uid of others) await db.run('INSERT INTO plan_receipts (plan_id, user_id) VALUES (?, ?)', [planId, uid]);
    await changed('plans');
    await notify(others, { title: `Ansitz angekündigt: ${req.user.name}`, body: `${req.user.name} möchte ${fmtTime(plannedAt)} ${await describeSpot(db, mode, featureId)} sein. Bitte bestätigen.`, url: `/#plan-${planId}`, tag: `plan-${planId}` });
    res.json(await planWithReceipts(db, planId));
  }));
  app.post('/api/plans/:id/read', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    const plan = await db.get('SELECT * FROM plans WHERE id = ?', [req.params.id]);
    if (!plan || plan.user_id === req.user.id) return res.json({ ok: true });
    const r = await db.run('UPDATE plan_receipts SET read_at = ? WHERE plan_id = ? AND user_id = ? AND read_at IS NULL', [now(), plan.id, req.user.id]);
    if (r.changes) await changed('plans', { plan_id: plan.id });
    res.json({ ok: true });
  }));
  app.post('/api/plans/:id/confirm', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    const plan = await db.get('SELECT * FROM plans WHERE id = ?', [req.params.id]);
    if (!plan) throw httpError(404, 'Nicht gefunden.');
    if (plan.user_id === req.user.id) throw httpError(400, 'Eigene Ankündigung kann nicht bestätigt werden.');
    const ts = now();
    await db.run(`INSERT INTO plan_receipts (plan_id, user_id, read_at, confirmed_at, comment) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (plan_id, user_id) DO UPDATE SET read_at = COALESCE(plan_receipts.read_at, excluded.read_at), confirmed_at = excluded.confirmed_at, comment = excluded.comment`,
      [plan.id, req.user.id, ts, ts, str(req.body.comment, 200)]);
    await changed('plans', { plan_id: plan.id });
    await notify([plan.user_id], { title: `${req.user.name} hat bestätigt`, body: `${req.user.name} hat deine Ankündigung für ${fmtTime(plan.planned_at)} bestätigt.${req.body.comment ? ' „' + str(req.body.comment, 100) + '“' : ''}`, url: `/#plan-${plan.id}`, tag: `plan-${plan.id}-confirm` });
    res.json(await planWithReceipts(db, plan.id));
  }));
  app.post('/api/plans/:id/cancel', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    const plan = await db.get('SELECT * FROM plans WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!plan) throw httpError(404, 'Nicht gefunden.');
    await db.run("UPDATE plans SET status = 'abgesagt' WHERE id = ?", [plan.id]);
    await changed('plans');
    await notify('all', { title: `Ansitz abgesagt: ${req.user.name}`, body: `${req.user.name} hat den geplanten Ansitz ${fmtTime(plan.planned_at)} abgesagt.`, url: '/#ansitz', tag: `plan-${plan.id}` }, req.user.id);
    res.json({ ok: true });
  }));

  // ---------- Drückjagd ----------
  async function huntFull(db, id) {
    const h = await db.get('SELECT h.*, u.name AS created_by_name FROM hunts h LEFT JOIN users u ON u.id = h.created_by WHERE h.id = ?', [id]);
    if (!h) return null;
    h.participants = await db.all('SELECT p.*, f.name AS feature_name FROM hunt_participants p LEFT JOIN features f ON f.id = p.feature_id WHERE hunt_id = ? ORDER BY role, name', [id]);
    h.drives = (await db.all('SELECT * FROM hunt_drives WHERE hunt_id = ? ORDER BY start_time, id', [id])).map(d => ({ ...d, geojson: d.geojson ? JSON.parse(d.geojson) : null }));
    h.tasks = await db.all('SELECT * FROM hunt_tasks WHERE hunt_id = ? ORDER BY done, id', [id]);
    h.bag = await db.all('SELECT * FROM hunt_bag WHERE hunt_id = ? ORDER BY id', [id]);
    h.items = await db.all('SELECT * FROM hunt_items WHERE hunt_id = ? ORDER BY done, id', [id]);
    return h;
  }
  const huntRes = (db, id) => async (req, res) => { await changed('hunts', { hunt_id: Number(id) }); res.json(await huntFull(db, id)); };

  app.get('/api/hunts', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    res.json(await db.all('SELECT h.*, (SELECT CAST(COUNT(*) AS INTEGER) FROM hunt_participants p WHERE p.hunt_id = h.id) AS participant_count FROM hunts h ORDER BY date DESC'));
  }));
  app.get('/api/hunts/:id', requireAuth, wrap(async (req, res) => {
    const h = await huntFull(await getDb(), req.params.id);
    if (!h) throw httpError(404, 'Nicht gefunden.');
    res.json(h);
  }));
  app.post('/api/hunts', requireAuth, wrap(async (req, res) => {
    if (!str(req.body.title, 120)) throw httpError(400, 'Titel fehlt.');
    if (!str(req.body.date, 20)) throw httpError(400, 'Datum fehlt.');
    const db = await getDb();
    const type = HUNT_TYPES.includes(req.body.type) ? req.body.type : 'drueckjagd';
    const id = await db.insert('INSERT INTO hunts (title, date, meet_time, meet_point, leader, description, type, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [str(req.body.title, 120), str(req.body.date, 20), str(req.body.meet_time, 20), str(req.body.meet_point, 200), str(req.body.leader, 80), str(req.body.description, 4000), type, req.user.id, now()]);
    const defaults = {
      drueckjagd: ['Einladungen verschicken', 'Stände kontrollieren und freischneiden', 'Jagdleiter-Belehrung vorbereiten', 'Hundeführer organisieren', 'Streckenplatz und Wildwanne vorbereiten', 'Behörde / Straßenschilder (Vorsicht Treibjagd) beantragen', 'Verpflegung (Schüsseltreiben) planen'],
      ansitz: ['Stände verteilen', 'Wind und Wetter am Vortag prüfen', 'Treffpunkt und Abblasen festlegen'],
      buschieren: ['Hunde und Hundeführer einteilen', 'Flächen mit dem Landwirt abstimmen', 'Signalkleidung mitbringen'],
      vogeljagd: ['Jagdzeiten und Freigabe prüfen', 'Apportierhunde organisieren', 'Lockbilder und Tarnung vorbereiten'],
      frettieren: ['Frettchen und Frettchenkasten', 'Bauten vorher verblenden', 'Netze und Rohrzangen prüfen'],
      fallenjagd: ['Fallen kontrollieren und kennzeichnen', 'Fangmeldungen abstimmen'],
      revierarbeit: ['Werkzeug und Material festlegen', 'Fahrzeuge und Anhänger organisieren'],
      sonstiges: ['Teilnehmer einladen'],
    }[type];
    for (const t of defaults) await db.run('INSERT INTO hunt_tasks (hunt_id, text) VALUES (?, ?)', [id, t]);
    await changed('hunts');
    const typeName = { drueckjagd: 'Drückjagd', ansitz: 'Gemeinschaftsansitz', buschieren: 'Buschieren', vogeljagd: 'Vogeljagd', frettieren: 'Frettieren', fallenjagd: 'Fallenjagd', revierarbeit: 'Revierarbeit', sonstiges: 'Jagd' }[type];
    await notify('all', { title: `Neu geplant: ${typeName}`, body: `${req.user.name} hat „${str(req.body.title, 120)}“ am ${req.body.date} angelegt.`, url: `/#jagd-${id}`, tag: `hunt-${id}` }, req.user.id);
    res.json(await huntFull(db, id));
  }));
  app.put('/api/hunts/:id', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    const h = await db.get('SELECT * FROM hunts WHERE id = ?', [req.params.id]);
    if (!h) throw httpError(404, 'Nicht gefunden.');
    await db.run('UPDATE hunts SET title = ?, date = ?, meet_time = ?, meet_point = ?, leader = ?, description = ?, status = ?, type = ? WHERE id = ?', [
      str(req.body.title ?? h.title, 120) || h.title, str(req.body.date ?? h.date, 20) || h.date, str(req.body.meet_time ?? h.meet_time, 20), str(req.body.meet_point ?? h.meet_point, 200),
      str(req.body.leader ?? h.leader, 80), str(req.body.description ?? h.description, 4000), HUNT_STATUS.includes(req.body.status) ? req.body.status : h.status,
      HUNT_TYPES.includes(req.body.type) ? req.body.type : h.type, h.id]);
    await huntRes(db, h.id)(req, res);
  }));
  app.delete('/api/hunts/:id', requireAuth, wrap(async (req, res) => {
    const db = await getDb(); await db.run('DELETE FROM hunts WHERE id = ?', [req.params.id]);
    await changed('hunts'); res.json({ ok: true });
  }));

  app.post('/api/hunts/:id/participants', requireAuth, wrap(async (req, res) => {
    if (!str(req.body.name, 80)) throw httpError(400, 'Name fehlt.');
    const db = await getDb();
    await db.run('INSERT INTO hunt_participants (hunt_id, name, role, feature_id, drive_id, phone, confirmed, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [req.params.id, str(req.body.name, 80), ROLES.includes(req.body.role) ? req.body.role : 'schuetze', num(req.body.feature_id), num(req.body.drive_id), str(req.body.phone, 40), req.body.confirmed ? 1 : 0, str(req.body.notes, 500)]);
    await huntRes(db, req.params.id)(req, res);
  }));
  app.put('/api/hunts/:id/participants/:pid', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    const p = await db.get('SELECT * FROM hunt_participants WHERE id = ? AND hunt_id = ?', [req.params.pid, req.params.id]);
    if (!p) throw httpError(404, 'Nicht gefunden.');
    await db.run('UPDATE hunt_participants SET name = ?, role = ?, feature_id = ?, drive_id = ?, phone = ?, confirmed = ?, notes = ? WHERE id = ?', [
      str(req.body.name ?? p.name, 80) || p.name, ROLES.includes(req.body.role) ? req.body.role : p.role,
      'feature_id' in req.body ? num(req.body.feature_id) : p.feature_id, 'drive_id' in req.body ? num(req.body.drive_id) : p.drive_id,
      str(req.body.phone ?? p.phone, 40), 'confirmed' in req.body ? (req.body.confirmed ? 1 : 0) : p.confirmed, str(req.body.notes ?? p.notes, 500), p.id]);
    await huntRes(db, req.params.id)(req, res);
  }));
  app.delete('/api/hunts/:id/participants/:pid', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    await db.run('DELETE FROM hunt_participants WHERE id = ? AND hunt_id = ?', [req.params.pid, req.params.id]);
    await huntRes(db, req.params.id)(req, res);
  }));

  app.post('/api/hunts/:id/drives', requireAuth, wrap(async (req, res) => {
    if (!str(req.body.name, 80)) throw httpError(400, 'Name fehlt.');
    const db = await getDb();
    await db.run('INSERT INTO hunt_drives (hunt_id, name, start_time, end_time, geojson, notes) VALUES (?, ?, ?, ?, ?, ?)',
      [req.params.id, str(req.body.name, 80), str(req.body.start_time, 10), str(req.body.end_time, 10), req.body.geojson ? JSON.stringify(req.body.geojson) : null, str(req.body.notes, 1000)]);
    await huntRes(db, req.params.id)(req, res);
  }));
  app.put('/api/hunts/:id/drives/:did', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    const d = await db.get('SELECT * FROM hunt_drives WHERE id = ? AND hunt_id = ?', [req.params.did, req.params.id]);
    if (!d) throw httpError(404, 'Nicht gefunden.');
    await db.run('UPDATE hunt_drives SET name = ?, start_time = ?, end_time = ?, geojson = ?, notes = ? WHERE id = ?', [
      str(req.body.name ?? d.name, 80) || d.name, str(req.body.start_time ?? d.start_time, 10), str(req.body.end_time ?? d.end_time, 10),
      'geojson' in req.body ? (req.body.geojson ? JSON.stringify(req.body.geojson) : null) : d.geojson, str(req.body.notes ?? d.notes, 1000), d.id]);
    await huntRes(db, req.params.id)(req, res);
  }));
  app.delete('/api/hunts/:id/drives/:did', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    await db.run('DELETE FROM hunt_drives WHERE id = ? AND hunt_id = ?', [req.params.did, req.params.id]);
    await db.run('UPDATE hunt_participants SET drive_id = NULL WHERE drive_id = ?', [req.params.did]);
    await huntRes(db, req.params.id)(req, res);
  }));

  app.post('/api/hunts/:id/tasks', requireAuth, wrap(async (req, res) => {
    if (!str(req.body.text, 200)) throw httpError(400, 'Text fehlt.');
    const db = await getDb();
    await db.run('INSERT INTO hunt_tasks (hunt_id, text, assignee) VALUES (?, ?, ?)', [req.params.id, str(req.body.text, 200), str(req.body.assignee, 80)]);
    await huntRes(db, req.params.id)(req, res);
  }));
  app.put('/api/hunts/:id/tasks/:tid', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    const t = await db.get('SELECT * FROM hunt_tasks WHERE id = ? AND hunt_id = ?', [req.params.tid, req.params.id]);
    if (!t) throw httpError(404, 'Nicht gefunden.');
    await db.run('UPDATE hunt_tasks SET text = ?, done = ?, assignee = ? WHERE id = ?', [str(req.body.text ?? t.text, 200) || t.text, 'done' in req.body ? (req.body.done ? 1 : 0) : t.done, str(req.body.assignee ?? t.assignee, 80), t.id]);
    await huntRes(db, req.params.id)(req, res);
  }));
  app.delete('/api/hunts/:id/tasks/:tid', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    await db.run('DELETE FROM hunt_tasks WHERE id = ? AND hunt_id = ?', [req.params.tid, req.params.id]);
    await huntRes(db, req.params.id)(req, res);
  }));

  // Materialliste: wer bringt was mit
  app.post('/api/hunts/:id/items', requireAuth, wrap(async (req, res) => {
    if (!str(req.body.text, 200)) throw httpError(400, 'Text fehlt.');
    const db = await getDb();
    await db.run('INSERT INTO hunt_items (hunt_id, text, person) VALUES (?, ?, ?)', [req.params.id, str(req.body.text, 200), str(req.body.person, 80)]);
    await huntRes(db, req.params.id)(req, res);
  }));
  app.put('/api/hunts/:id/items/:iid', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    const it = await db.get('SELECT * FROM hunt_items WHERE id = ? AND hunt_id = ?', [req.params.iid, req.params.id]);
    if (!it) throw httpError(404, 'Nicht gefunden.');
    await db.run('UPDATE hunt_items SET text = ?, person = ?, done = ? WHERE id = ?', [str(req.body.text ?? it.text, 200) || it.text, str(req.body.person ?? it.person, 80), 'done' in req.body ? (req.body.done ? 1 : 0) : it.done, it.id]);
    await huntRes(db, req.params.id)(req, res);
  }));
  app.delete('/api/hunts/:id/items/:iid', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    await db.run('DELETE FROM hunt_items WHERE id = ? AND hunt_id = ?', [req.params.iid, req.params.id]);
    await huntRes(db, req.params.id)(req, res);
  }));

  app.post('/api/hunts/:id/bag', requireAuth, wrap(async (req, res) => {
    if (!str(req.body.species, 80)) throw httpError(400, 'Wildart fehlt.');
    const db = await getDb();
    await db.run('INSERT INTO hunt_bag (hunt_id, species, count, shooter, notes) VALUES (?, ?, ?, ?, ?)', [req.params.id, str(req.body.species, 80), Math.max(1, Number(req.body.count) || 1), str(req.body.shooter, 80), str(req.body.notes, 300)]);
    await huntRes(db, req.params.id)(req, res);
  }));
  app.delete('/api/hunts/:id/bag/:bid', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    await db.run('DELETE FROM hunt_bag WHERE id = ? AND hunt_id = ?', [req.params.bid, req.params.id]);
    await huntRes(db, req.params.id)(req, res);
  }));

  // ---------- Termine (Hegeringsitzung, Trophäenschau, ...) ----------
  const EVENT_STATUS = ['offen', 'zusage', 'absage', 'vielleicht'];
  async function eventFull(db, id) {
    const e = await db.get('SELECT e.*, u.name AS created_by_name FROM events e LEFT JOIN users u ON u.id = e.created_by WHERE e.id = ?', [id]);
    if (!e) return null;
    e.responses = await db.all('SELECT r.*, u.name AS user_name, u.color AS user_color FROM event_responses r JOIN users u ON u.id = r.user_id WHERE r.event_id = ? ORDER BY u.name', [id]);
    return e;
  }
  app.get('/api/events', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    const since = new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10);
    const rows = await db.all('SELECT id FROM events WHERE date >= ? ORDER BY date, time', [since]);
    res.json(await Promise.all(rows.map(r => eventFull(db, r.id))));
  }));
  app.post('/api/events', requireAuth, wrap(async (req, res) => {
    if (!str(req.body.title, 120)) throw httpError(400, 'Titel fehlt.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.date || '')) throw httpError(400, 'Datum fehlt.');
    const db = await getDb();
    const id = await db.insert('INSERT INTO events (title, date, time, place, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [str(req.body.title, 120), req.body.date, str(req.body.time, 20), str(req.body.place, 200), str(req.body.description, 4000), req.user.id, now()]);
    await changed('events');
    await notify('all', { title: `Neuer Termin: ${str(req.body.title, 120)}`, body: `${req.user.name} hat einen Termin am ${req.body.date}${req.body.time ? ' um ' + str(req.body.time, 20) : ''} eingetragen. Bitte zu- oder absagen.`, url: `/#termin-${id}`, tag: `event-${id}` }, req.user.id);
    res.json(await eventFull(db, id));
  }));
  app.put('/api/events/:id', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    const e = await db.get('SELECT * FROM events WHERE id = ?', [req.params.id]);
    if (!e) throw httpError(404, 'Nicht gefunden.');
    await db.run('UPDATE events SET title = ?, date = ?, time = ?, place = ?, description = ? WHERE id = ?', [str(req.body.title ?? e.title, 120) || e.title,
      /^\d{4}-\d{2}-\d{2}$/.test(req.body.date || '') ? req.body.date : e.date, str(req.body.time ?? e.time, 20), str(req.body.place ?? e.place, 200), str(req.body.description ?? e.description, 4000), e.id]);
    await changed('events'); res.json(await eventFull(db, e.id));
  }));
  app.delete('/api/events/:id', requireAuth, wrap(async (req, res) => {
    const db = await getDb(); await db.run('DELETE FROM events WHERE id = ?', [req.params.id]);
    await changed('events'); res.json({ ok: true });
  }));
  app.post('/api/events/:id/respond', requireAuth, wrap(async (req, res) => {
    const db = await getDb();
    const e = await db.get('SELECT * FROM events WHERE id = ?', [req.params.id]);
    if (!e) throw httpError(404, 'Nicht gefunden.');
    const cur = await db.get('SELECT * FROM event_responses WHERE event_id = ? AND user_id = ?', [e.id, req.user.id]);
    const status = EVENT_STATUS.includes(req.body.status) ? req.body.status : (cur?.status || 'offen');
    const brings = 'brings' in req.body ? str(req.body.brings, 200) : (cur?.brings || '');
    await db.run(`INSERT INTO event_responses (event_id, user_id, status, brings, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (event_id, user_id) DO UPDATE SET status = excluded.status, brings = excluded.brings, updated_at = excluded.updated_at`, [e.id, req.user.id, status, brings, now()]);
    await changed('events'); res.json(await eventFull(db, e.id));
  }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Unbekannter Endpunkt.' }));
  app.use((err, req, res, next) => {
    if (!err.status) console.error(err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Interner Fehler.' });
  });
  return app;
}
