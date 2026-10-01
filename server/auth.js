import crypto from 'node:crypto';
import { db, getSetting, setSetting } from './db.js';

const COLORS = ['#6b8e23', '#8b5a2b', '#b8860b', '#556b2f', '#a0522d', '#2f4f4f', '#cd853f', '#4b6043', '#7b3f00', '#9c6b30'];

function hash(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

export function userCount() { return db.prepare('SELECT COUNT(*) AS c FROM users').get().c; }
export function getInviteCode() { return process.env.INVITE_CODE || getSetting('invite_code', null); }
export function setInviteCode(code) {
  code = String(code || '').trim();
  if (code.length < 4 || code.length > 60) throw httpError(400, 'Einladungscode muss 4–60 Zeichen lang sein.');
  setSetting('invite_code', code);
}
function codesMatch(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * Registrierung. Der erste Nutzer legt den Einladungscode fest und wird Admin,
 * alle weiteren müssen den gültigen Code angeben.
 */
export function register(name, password, inviteCode) {
  name = String(name || '').trim();
  if (name.length < 2 || name.length > 40) throw httpError(400, 'Name muss 2–40 Zeichen lang sein.');
  if (String(password || '').length < 4) throw httpError(400, 'Passwort muss mindestens 4 Zeichen haben.');
  const first = userCount() === 0;
  if (first) {
    if (!getInviteCode()) setInviteCode(inviteCode);
  } else {
    const code = getInviteCode();
    if (!code) throw httpError(403, 'Es ist kein Einladungscode festgelegt. Bitte den Admin fragen.');
    if (!inviteCode || !codesMatch(inviteCode.trim(), code)) throw httpError(403, 'Einladungscode ist falsch.');
  }
  const exists = db.prepare('SELECT id FROM users WHERE name = ?').get(name);
  if (exists) throw httpError(409, 'Dieser Name ist bereits vergeben.');
  const salt = crypto.randomBytes(16).toString('hex');
  const color = COLORS[userCount() % COLORS.length];
  const info = db.prepare('INSERT INTO users (name, pass_hash, salt, color, is_admin) VALUES (?, ?, ?, ?, ?)')
    .run(name, hash(password, salt), salt, color, first ? 1 : 0);
  return createSession(Number(info.lastInsertRowid));
}

export function changePassword(userId, oldPassword, newPassword) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw httpError(404, 'Nutzer nicht gefunden.');
  if (!crypto.timingSafeEqual(Buffer.from(hash(String(oldPassword || ''), user.salt)), Buffer.from(user.pass_hash))) throw httpError(401, 'Altes Passwort ist falsch.');
  setPassword(userId, newPassword);
}

export function setPassword(userId, newPassword) {
  if (String(newPassword || '').length < 4) throw httpError(400, 'Passwort muss mindestens 4 Zeichen haben.');
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?').run(hash(newPassword, salt), salt, userId);
  // Alle Sitzungen des Nutzers beenden, damit das neue Passwort überall gilt
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Nur für den Admin.' });
  next();
}

export function login(name, password) {
  const user = db.prepare('SELECT * FROM users WHERE name = ?').get(String(name || '').trim());
  if (!user) throw httpError(401, 'Unbekannter Name oder falsches Passwort.');
  const h = hash(String(password || ''), user.salt);
  if (!crypto.timingSafeEqual(Buffer.from(h), Buffer.from(user.pass_hash))) {
    throw httpError(401, 'Unbekannter Name oder falsches Passwort.');
  }
  return createSession(user.id);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
  return { token, user: publicUser(userId) };
}

export function publicUser(id) {
  return db.prepare('SELECT id, name, color, is_admin, created_at FROM users WHERE id = ?').get(id);
}

export function userFromToken(token) {
  if (!token) return null;
  const row = db.prepare('SELECT u.id, u.name, u.color, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(token);
  return row || null;
}

export function logout(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  const user = userFromToken(token);
  if (!user) return res.status(401).json({ error: 'Nicht angemeldet.' });
  req.user = user;
  req.token = token;
  next();
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
