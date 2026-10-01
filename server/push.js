import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { db, DATA_DIR } from './db.js';

const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');

function loadKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  if (fs.existsSync(VAPID_FILE)) return JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
  const keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2));
  return keys;
}

export const vapidKeys = loadKeys();
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:revier@example.com', vapidKeys.publicKey, vapidKeys.privateKey);

export function saveSubscription(userId, sub) {
  if (!sub || !sub.endpoint) return;
  db.prepare(`INSERT INTO push_subs (user_id, endpoint, sub_json) VALUES (?, ?, ?)
              ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, sub_json = excluded.sub_json`)
    .run(userId, sub.endpoint, JSON.stringify(sub));
}

export function removeSubscription(endpoint) {
  db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(endpoint);
}

/**
 * Sends a push notification to a set of users and stores it in the in-app inbox.
 * @param {number[]|'all'} userIds
 * @param {{title:string, body:string, url?:string, tag?:string}} payload
 * @param {number|null} excludeUserId
 */
export async function notify(userIds, payload, excludeUserId = null) {
  let ids = userIds === 'all'
    ? db.prepare('SELECT id FROM users').all().map(r => r.id)
    : userIds;
  ids = [...new Set(ids)].filter(id => id !== excludeUserId);
  if (!ids.length) return;

  const insert = db.prepare('INSERT INTO notifications (user_id, title, body, url) VALUES (?, ?, ?, ?)');
  for (const id of ids) insert.run(id, payload.title, payload.body, payload.url || '/');

  const placeholders = ids.map(() => '?').join(',');
  const subs = db.prepare(`SELECT endpoint, sub_json FROM push_subs WHERE user_id IN (${placeholders})`).all(...ids);
  const body = JSON.stringify({ ...payload, url: payload.url || '/' });
  await Promise.allSettled(subs.map(async s => {
    try {
      await webpush.sendNotification(JSON.parse(s.sub_json), body, { TTL: 60 * 60 * 6 });
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) removeSubscription(s.endpoint);
      else console.warn('Push fehlgeschlagen:', err.statusCode || err.message);
    }
  }));
}
