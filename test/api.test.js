// Integrationstests: starten den Server mit temporärer Datenbank und prüfen die Kernabläufe.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3900 + Math.floor(Math.random() * 100);
const BASE = `http://localhost:${PORT}/api`;
let proc, dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revierapp-test-'));
  proc = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', 'server/index.js'], { env: { ...process.env, PORT, DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', d => { if (String(d).includes('läuft')) resolve(); });
    proc.stderr.on('data', d => process.stderr.write(d));
    proc.on('exit', code => reject(new Error('Server beendet mit ' + code)));
    setTimeout(() => reject(new Error('Server-Start Timeout')), 8000);
  });
});
after(() => { proc?.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });

async function call(path, { token, method, body } = {}) {
  const res = await fetch(BASE + path, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}

let hans, grete, standId, planId, huntId;

test('Registrierung mit Einladungscode und Anmeldung', async () => {
  assert.equal((await call('/auth/status')).data.needsSetup, true);
  const noCode = await call('/auth/register', { body: { name: 'Hans', password: 'geheim1' } });
  assert.equal(noCode.status, 400, 'erster Nutzer muss Code festlegen');
  hans = (await call('/auth/register', { body: { name: 'Hans', password: 'geheim1', invite_code: 'Buchenhain' } })).data;
  assert.ok(hans.token); assert.equal(hans.user.name, 'Hans'); assert.equal(hans.user.is_admin, 1, 'erster Nutzer ist Admin');
  assert.equal((await call('/auth/status')).data.needsSetup, false);
  const wrong = await call('/auth/register', { body: { name: 'Fremder', password: 'xxxx', invite_code: 'falsch' } });
  assert.equal(wrong.status, 403);
  const missing = await call('/auth/register', { body: { name: 'Fremder', password: 'xxxx' } });
  assert.equal(missing.status, 403);
  grete = (await call('/auth/register', { body: { name: 'Grete', password: 'geheim2', invite_code: 'Buchenhain' } })).data;
  assert.equal(grete.user.is_admin, 0);
  const dup = await call('/auth/register', { body: { name: 'hans', password: 'xxxx', invite_code: 'Buchenhain' } });
  assert.equal(dup.status, 409);
  const bad = await call('/auth/login', { body: { name: 'Hans', password: 'falsch' } });
  assert.equal(bad.status, 401);
  const ok = await call('/auth/login', { body: { name: 'Hans', password: 'geheim1' } });
  assert.equal(ok.status, 200);
  assert.equal((await call('/checkins')).status, 401);
});

test('Revier: Kanzel, Kamera und Grenze anlegen', async () => {
  const k = await call('/features', { token: hans.token, body: { kind: 'kanzel', name: 'Kanzel Eichenwiese', lat: 50.95, lng: 10.2 } });
  assert.equal(k.status, 200); standId = k.data.id;
  const cam = await call('/features', { token: hans.token, body: { kind: 'kamera', lat: 50.951, lng: 10.201 } });
  assert.equal(cam.data.name, 'Wildkamera 1');
  const noPos = await call('/features', { token: hans.token, body: { kind: 'kanzel' } });
  assert.equal(noPos.status, 400);
  const b = await call('/boundaries', { token: hans.token, body: { geojson: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[10.19, 50.94], [10.21, 50.94], [10.21, 50.96], [10.19, 50.94]]] } } } });
  assert.equal(b.status, 200);
  const r = (await call('/revier', { token: hans.token })).data;
  assert.equal(r.features.length, 2); assert.equal(r.boundaries.length, 1);
});

test('Check-in benachrichtigt andere Nutzer und beendet vorheriges Check-in', async () => {
  const c = await call('/checkins', { token: hans.token, body: { mode: 'kanzel', feature_id: standId, note: 'Abendansitz' } });
  assert.equal(c.status, 200);
  const list = (await call('/checkins', { token: grete.token })).data;
  assert.equal(list.active.length, 1); assert.equal(list.active[0].feature_name, 'Kanzel Eichenwiese');
  const n = (await call('/notifications', { token: grete.token })).data;
  assert.ok(n.some(x => x.title.includes('Hans ist im Revier')));
  const own = (await call('/notifications', { token: hans.token })).data;
  assert.equal(own.length, 0, 'Verursacher wird nicht selbst benachrichtigt');
  await call('/checkins', { token: hans.token, body: { mode: 'pirsch' } });
  const list2 = (await call('/checkins', { token: grete.token })).data;
  assert.equal(list2.active.length, 1); assert.equal(list2.active[0].mode, 'pirsch');
  await call('/checkins/checkout', { token: hans.token, method: 'POST' });
  const list3 = (await call('/checkins', { token: grete.token })).data;
  assert.equal(list3.active.length, 0); assert.equal(list3.history.length, 2);
  assert.ok((await call('/notifications', { token: grete.token })).data.some(x => x.title.includes('verlassen')));
  const noStand = await call('/checkins', { token: hans.token, body: { mode: 'kanzel' } });
  assert.equal(noStand.status, 400);
});

test('Geplantes Einchecken mit Lese- und Bestätigungsquittung', async () => {
  const p = await call('/plans', { token: grete.token, body: { mode: 'kanzel', feature_id: standId, planned_at: new Date(Date.now() + 3600e3).toISOString(), note: 'ca. 21 Uhr' } });
  assert.equal(p.status, 200); planId = p.data.id;
  assert.equal(p.data.receipts.length, 1); assert.equal(p.data.receipts[0].user_name, 'Hans'); assert.equal(p.data.receipts[0].read_at, null);
  assert.ok((await call('/notifications', { token: hans.token })).data.some(x => x.title.includes('Ansitz angekündigt')));
  await call(`/plans/${planId}/read`, { token: hans.token, method: 'POST' });
  let plans = (await call('/plans', { token: grete.token })).data;
  assert.ok(plans[0].receipts[0].read_at, 'Lesebestätigung gesetzt');
  assert.equal(plans[0].receipts[0].confirmed_at, null);
  const self = await call(`/plans/${planId}/confirm`, { token: grete.token, body: {} });
  assert.equal(self.status, 400);
  await call(`/plans/${planId}/confirm`, { token: hans.token, body: { comment: 'Passt' } });
  plans = (await call('/plans', { token: grete.token })).data;
  assert.ok(plans[0].receipts[0].confirmed_at); assert.equal(plans[0].receipts[0].comment, 'Passt');
  assert.ok((await call('/notifications', { token: grete.token })).data.some(x => x.title.includes('hat bestätigt')));
  await call('/checkins', { token: grete.token, body: { mode: 'kanzel', feature_id: standId, plan_id: planId } });
  plans = (await call('/plans', { token: grete.token })).data;
  assert.equal(plans[0].status, 'gestartet');
  const foreignCancel = await call(`/plans/${planId}/cancel`, { token: hans.token, method: 'POST' });
  assert.equal(foreignCancel.status, 404);
});

test('Drückjagd-Planung: Teilnehmer, Treiben, Checkliste, Strecke', async () => {
  const h = await call('/hunts', { token: hans.token, body: { title: 'Herbstdrückjagd', date: '2026-11-14', meet_time: '08:00', leader: 'Hans' } });
  assert.equal(h.status, 200); huntId = h.data.id;
  assert.ok(h.data.tasks.length >= 5, 'Standard-Checkliste angelegt');
  assert.ok((await call('/notifications', { token: grete.token })).data.some(x => x.title.includes('Drückjagd')));
  let full = (await call(`/hunts/${huntId}/drives`, { token: grete.token, body: { name: 'Treiben 1', start_time: '09:00', end_time: '11:00' } })).data;
  const driveId = full.drives[0].id;
  full = (await call(`/hunts/${huntId}/participants`, { token: grete.token, body: { name: 'Grete', role: 'schuetze', feature_id: standId, drive_id: driveId, confirmed: true } })).data;
  assert.equal(full.participants[0].feature_name, 'Kanzel Eichenwiese');
  const pid = full.participants[0].id;
  full = (await call(`/hunts/${huntId}/participants/${pid}`, { token: hans.token, method: 'PUT', body: { role: 'hundefuehrer', feature_id: null } })).data;
  assert.equal(full.participants[0].role, 'hundefuehrer'); assert.equal(full.participants[0].feature_id, null);
  full = (await call(`/hunts/${huntId}/tasks/${full.tasks[0].id}`, { token: hans.token, method: 'PUT', body: { done: true } })).data;
  assert.equal(full.tasks.filter(t => t.done).length, 1);
  full = (await call(`/hunts/${huntId}/bag`, { token: hans.token, body: { species: 'Schwarzwild – Frischling', count: 2, shooter: 'Grete' } })).data;
  assert.equal(full.bag[0].count, 2);
  full = (await call(`/hunts/${huntId}`, { token: hans.token, method: 'PUT', body: { status: 'bestaetigt' } })).data;
  assert.equal(full.status, 'bestaetigt');
  const list = (await call('/hunts', { token: grete.token })).data;
  assert.equal(list[0].participant_count, 1);
  await call(`/hunts/${huntId}`, { token: hans.token, method: 'DELETE' });
  assert.equal((await call(`/hunts/${huntId}`, { token: hans.token })).status, 404);
});

test('Passwort ändern und Admin-Funktionen', async () => {
  const wrongOld = await call('/auth/password', { token: grete.token, body: { old_password: 'nein', new_password: 'neu1234' } });
  assert.equal(wrongOld.status, 401);
  await call('/auth/password', { token: grete.token, body: { old_password: 'geheim2', new_password: 'neu1234' } });
  assert.equal((await call('/auth/me', { token: grete.token })).status, 401, 'alte Sitzung beendet');
  grete = (await call('/auth/login', { body: { name: 'Grete', password: 'neu1234' } })).data;
  assert.ok(grete.token);
  assert.equal((await call('/admin/invite', { token: grete.token })).status, 403, 'kein Admin');
  await call('/admin/invite', { token: hans.token, method: 'PUT', body: { code: 'NeuerCode' } });
  assert.equal((await call('/auth/register', { body: { name: 'Karl', password: 'xxxx', invite_code: 'Buchenhain' } })).status, 403);
  const karl = (await call('/auth/register', { body: { name: 'Karl', password: 'xxxx', invite_code: 'NeuerCode' } })).data;
  const reset = (await call(`/admin/users/${karl.user.id}/reset-password`, { token: hans.token, method: 'POST' })).data;
  assert.ok(reset.password.length >= 6);
  assert.equal((await call('/auth/login', { body: { name: 'Karl', password: reset.password } })).status, 200);
  assert.equal((await call(`/admin/users/${hans.user.id}`, { token: hans.token, method: 'DELETE' })).status, 400, 'nicht selbst löschen');
  await call(`/admin/users/${karl.user.id}`, { token: hans.token, method: 'DELETE' });
  assert.equal((await call('/users', { token: hans.token })).data.some(u => u.name === 'Karl'), false);
});

test('Fährten melden, bearbeiten, löschen', async () => {
  const bad = await call('/sightings', { token: hans.token, body: { species: 'Schwarzwild' } });
  assert.equal(bad.status, 400);
  const sg = await call('/sightings', { token: hans.token, body: { species: 'Schwarzwild', kind: 'faehrte', note: 'Rotte Richtung Mais', lat: 50.95, lng: 10.2, observed_at: new Date(Date.now() - 6 * 3600e3).toISOString() } });
  assert.equal(sg.status, 200); assert.equal(sg.data.user_name, 'Hans');
  const list = (await call('/sightings', { token: grete.token })).data;
  assert.equal(list.length, 1); assert.equal(list[0].species, 'Schwarzwild');
  assert.ok((await call('/notifications', { token: grete.token })).data.some(x => x.title.startsWith('Schwarzwild')));
  const foreign = await call(`/sightings/${sg.data.id}`, { token: grete.token, method: 'PUT', body: { note: 'x' } });
  assert.equal(foreign.status, 403, 'fremde Meldung nicht änderbar');
  const upd = await call(`/sightings/${sg.data.id}`, { token: hans.token, method: 'PUT', body: { kind: 'sichtung', lat: 50.951 } });
  assert.equal(upd.data.kind, 'sichtung'); assert.equal(upd.data.lat, 50.951);
  assert.equal((await call(`/sightings/${sg.data.id}`, { token: grete.token, method: 'DELETE' })).status, 403);
  assert.equal((await call(`/sightings/${sg.data.id}`, { token: hans.token, method: 'DELETE' })).status, 200);
  assert.equal((await call('/sightings', { token: hans.token })).data.length, 0);
});

test('Anschuss mit Foto, Fluchtrichtung und Status', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const sh = await call('/shots', { token: hans.token, body: { species: 'Schwarzwild', lat: 50.95, lng: 10.2, flight_bearing: 225, signs: 'Schweiß dunkel', note: 'Kugel sitzt weit hinten', photos: [png, 'nicht-erlaubt'] } });
  assert.equal(sh.status, 200); assert.equal(sh.data.photo_count, 1); assert.equal(sh.data.flight_bearing, 225); assert.equal(sh.data.status, 'offen');
  assert.ok((await call('/notifications', { token: grete.token })).data.some(x => x.title.startsWith('Anschuss')));
  const photos = (await call(`/shots/${sh.data.id}/photos`, { token: grete.token })).data;
  assert.equal(photos.length, 1); assert.ok(photos[0].data.startsWith('data:image/png'));
  // Fluchtrichtung über Kartenpunkt: Punkt nördlich -> Peilung ~0
  const dir = await call(`/shots/${sh.data.id}`, { token: hans.token, method: 'PUT', body: { flight_lat: 50.96, flight_lng: 10.2 } });
  assert.ok(dir.data.flight_bearing < 1 || dir.data.flight_bearing > 359, 'Peilung nach Norden');
  assert.equal((await call(`/shots/${sh.data.id}`, { token: grete.token, method: 'PUT', body: { status: 'gefunden' } })).status, 403);
  const found = await call(`/shots/${sh.data.id}`, { token: hans.token, method: 'PUT', body: { status: 'gefunden', found_lat: 50.955, found_lng: 10.201 } });
  assert.equal(found.data.status, 'gefunden'); assert.equal(found.data.found_lat, 50.955);
  assert.ok((await call('/notifications', { token: grete.token })).data.some(x => x.title.includes('gefunden')));
  assert.equal((await call('/shots', { token: grete.token })).data.length, 1);
  await call(`/shots/${sh.data.id}/photos/${photos[0].id}`, { token: hans.token, method: 'DELETE' });
  assert.equal((await call(`/shots/${sh.data.id}/photos`, { token: hans.token })).data.length, 0);
  assert.equal((await call(`/shots/${sh.data.id}`, { token: hans.token, method: 'DELETE' })).status, 200);
});

test('Push-Schlüssel und Abonnement', async () => {
  const k = (await call('/push/key')).data;
  assert.ok(k.publicKey.length > 60);
  const s = await call('/push/subscribe', { token: hans.token, body: { endpoint: 'https://push.example/abc', keys: { p256dh: 'x', auth: 'y' } } });
  assert.equal(s.status, 200);
});
