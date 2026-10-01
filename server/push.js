import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { getDb, getSetting, setSetting, DATA_DIR, now } from './db.js';

let keysPromise;
/** VAPID-Schlüssel: aus Umgebungsvariablen, sonst einmalig erzeugt und in der Datenbank abgelegt. */
export function getVapidKeys() {
  if (!keysPromise) keysPromise = (async () => {
    let keys;
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
    else {
      keys = await getSetting('vapid', null);
      const legacy = path.join(DATA_DIR, 'vapid.json');
      if (!keys && fs.existsSync(legacy)) keys = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      if (!keys) keys = webpush.generateVAPIDKeys();
      await setSetting('vapid', keys);
    }
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:revier@example.com', keys.publicKey, keys.privateKey);
    return keys;
  })();
  return keysPromise;
}

export async function saveSubscription(userId, sub) {
  if (!sub || !sub.endpoint) return;
  const db = await getDb();
  await db.run(`INSERT INTO push_subs (user_id, endpoint, sub_json, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, sub_json = excluded.sub_json`, [userId, sub.endpoint, JSON.stringify(sub), now()]);
}
export async function removeSubscription(endpoint) { const db = await getDb(); await db.run('DELETE FROM push_subs WHERE endpoint = ?', [endpoint]); }

/** Push an Nutzer senden und in der In-App-Liste ablegen. userIds: Array oder 'all'. */
export async function notify(userIds, payload, excludeUserId = null) {
  const db = await getDb();
  let ids = userIds === 'all' ? (await db.all('SELECT id FROM users')).map(r => r.id) : userIds;
  ids = [...new Set(ids)].filter(id => id !== excludeUserId);
  if (!ids.length) return;
  const ts = now();
  for (const id of ids) await db.run('INSERT INTO notifications (user_id, title, body, url, created_at) VALUES (?, ?, ?, ?, ?)', [id, payload.title, payload.body, payload.url || '/', ts]);
  await getVapidKeys();
  const subs = await db.all(`SELECT endpoint, sub_json FROM push_subs WHERE user_id IN (${ids.map(() => '?').join(',')})`, ids);
  const body = JSON.stringify({ ...payload, url: payload.url || '/' });
  await Promise.allSettled(subs.map(async s => {
    try { await webpush.sendNotification(JSON.parse(s.sub_json), body, { TTL: 6 * 3600 }); }
    catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) await removeSubscription(s.endpoint);
      else console.warn('Push fehlgeschlagen:', err.statusCode || err.message);
    }
  }));
}
