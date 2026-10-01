import crypto from 'node:crypto';
import { getDb, getSetting, setSetting, now } from './db.js';

const COLORS = ['#6b8e23', '#8b5a2b', '#b8860b', '#556b2f', '#a0522d', '#2f4f4f', '#cd853f', '#4b6043', '#7b3f00', '#9c6b30'];
const hash = (password, salt) => crypto.scryptSync(password, salt, 32).toString('hex');
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

export function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

export async function userCount() { const db = await getDb(); return Number((await db.get('SELECT COUNT(*) AS c FROM users')).c); }
export async function getInviteCode() { return process.env.INVITE_CODE || getSetting('invite_code', null); }
export async function setInviteCode(code) {
  code = String(code || '').trim();
  if (code.length < 4 || code.length > 60) throw httpError(400, 'Einladungscode muss 4–60 Zeichen lang sein.');
  await setSetting('invite_code', code);
}

/** Der erste Nutzer legt den Einladungscode fest und wird Admin; alle weiteren brauchen den Code. */
export async function register(name, password, inviteCode) {
  const db = await getDb();
  name = String(name || '').trim();
  if (name.length < 2 || name.length > 40) throw httpError(400, 'Name muss 2–40 Zeichen lang sein.');
  if (String(password || '').length < 4) throw httpError(400, 'Passwort muss mindestens 4 Zeichen haben.');
  const count = await userCount();
  const first = count === 0;
  if (first) {
    if (!(await getInviteCode())) await setInviteCode(inviteCode);
  } else {
    const code = await getInviteCode();
    if (!code) throw httpError(403, 'Es ist kein Einladungscode festgelegt. Bitte den Admin fragen.');
    if (!inviteCode || !eq(String(inviteCode).trim(), code)) throw httpError(403, 'Einladungscode ist falsch.');
  }
  if (await db.get('SELECT id FROM users WHERE LOWER(name) = LOWER(?)', [name])) throw httpError(409, 'Dieser Name ist bereits vergeben.');
  const salt = crypto.randomBytes(16).toString('hex');
  const id = await db.insert('INSERT INTO users (name, pass_hash, salt, color, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [name, hash(password, salt), salt, COLORS[count % COLORS.length], first ? 1 : 0, now()]);
  return createSession(id);
}

export async function login(name, password) {
  const db = await getDb();
  const user = await db.get('SELECT * FROM users WHERE LOWER(name) = LOWER(?)', [String(name || '').trim()]);
  if (!user || !eq(hash(String(password || ''), user.salt), user.pass_hash)) throw httpError(401, 'Unbekannter Name oder falsches Passwort.');
  return createSession(user.id);
}

async function createSession(userId) {
  const db = await getDb();
  const token = crypto.randomBytes(32).toString('hex');
  await db.run('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)', [token, userId, now()]);
  return { token, user: await publicUser(userId) };
}
export async function publicUser(id) {
  const db = await getDb();
  return db.get('SELECT id, name, color, is_admin, created_at FROM users WHERE id = ?', [id]);
}
export async function userFromToken(token) {
  if (!token) return null;
  const db = await getDb();
  return db.get('SELECT u.id, u.name, u.color, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?', [token]);
}
export async function logout(token) { const db = await getDb(); await db.run('DELETE FROM sessions WHERE token = ?', [token]); }

export async function changePassword(userId, oldPassword, newPassword) {
  const db = await getDb();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) throw httpError(404, 'Nutzer nicht gefunden.');
  if (!eq(hash(String(oldPassword || ''), user.salt), user.pass_hash)) throw httpError(401, 'Altes Passwort ist falsch.');
  await setPassword(userId, newPassword);
}
export async function setPassword(userId, newPassword) {
  if (String(newPassword || '').length < 4) throw httpError(400, 'Passwort muss mindestens 4 Zeichen haben.');
  const db = await getDb();
  const salt = crypto.randomBytes(16).toString('hex');
  await db.run('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?', [hash(newPassword, salt), salt, userId]);
  await db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
}

export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
    const user = await userFromToken(token);
    if (!user) return res.status(401).json({ error: 'Nicht angemeldet.' });
    req.user = user; req.token = token;
    next();
  } catch (e) { next(e); }
}
export function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Nur für den Admin.' });
  next();
}
