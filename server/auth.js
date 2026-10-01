import crypto from 'node:crypto';
import { db } from './db.js';

const COLORS = ['#6b8e23', '#8b5a2b', '#b8860b', '#556b2f', '#a0522d', '#2f4f4f', '#cd853f', '#4b6043', '#7b3f00', '#9c6b30'];

function hash(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

export function register(name, password) {
  name = String(name || '').trim();
  if (name.length < 2 || name.length > 40) throw httpError(400, 'Name muss 2–40 Zeichen lang sein.');
  if (String(password || '').length < 4) throw httpError(400, 'Passwort muss mindestens 4 Zeichen haben.');
  const exists = db.prepare('SELECT id FROM users WHERE name = ?').get(name);
  if (exists) throw httpError(409, 'Dieser Name ist bereits vergeben.');
  const salt = crypto.randomBytes(16).toString('hex');
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const color = COLORS[count % COLORS.length];
  const info = db.prepare('INSERT INTO users (name, pass_hash, salt, color) VALUES (?, ?, ?, ?)')
    .run(name, hash(password, salt), salt, color);
  return createSession(Number(info.lastInsertRowid));
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
  return db.prepare('SELECT id, name, color, created_at FROM users WHERE id = ?').get(id);
}

export function userFromToken(token) {
  if (!token) return null;
  const row = db.prepare('SELECT u.id, u.name, u.color FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(token);
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
