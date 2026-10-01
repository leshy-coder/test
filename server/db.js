/**
 * Datenbank-Adapter: SQLite (lokal, Render, Docker) oder Postgres (Netlify DB / Neon, jede DATABASE_URL).
 * Alle Abfragen nutzen "?"-Platzhalter und werden für Postgres in $1, $2 … übersetzt.
 * Zeitstempel werden immer als ISO-Text aus JavaScript gesetzt, damit beide Datenbanken gleich rechnen.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR || path.join(moduleDir, '..', 'data');
export const now = () => new Date().toISOString();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id {{ID}}, name TEXT NOT NULL UNIQUE {{NOCASE}}, pass_hash TEXT NOT NULL, salt TEXT NOT NULL, color TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0, last_seen TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS versions (name TEXT PRIMARY KEY, v INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS boundaries (id {{ID}}, name TEXT NOT NULL DEFAULT 'Reviergrenze', geojson TEXT NOT NULL, updated_by INTEGER, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS features (id {{ID}}, kind TEXT NOT NULL, name TEXT NOT NULL, lat DOUBLE PRECISION NOT NULL, lng DOUBLE PRECISION NOT NULL,
  notes TEXT NOT NULL DEFAULT '', created_by INTEGER, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS checkins (id {{ID}}, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, mode TEXT NOT NULL,
  feature_id INTEGER REFERENCES features(id) ON DELETE SET NULL, note TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL, ended_at TEXT);
CREATE TABLE IF NOT EXISTS plans (id {{ID}}, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, mode TEXT NOT NULL,
  feature_id INTEGER REFERENCES features(id) ON DELETE SET NULL, planned_at TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'offen', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS plan_receipts (plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TEXT, confirmed_at TEXT, comment TEXT NOT NULL DEFAULT '', PRIMARY KEY (plan_id, user_id));
CREATE TABLE IF NOT EXISTS hunts (id {{ID}}, title TEXT NOT NULL, date TEXT NOT NULL, meet_time TEXT NOT NULL DEFAULT '', meet_point TEXT NOT NULL DEFAULT '',
  leader TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'planung', created_by INTEGER, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS hunt_participants (id {{ID}}, hunt_id INTEGER NOT NULL REFERENCES hunts(id) ON DELETE CASCADE, name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'schuetze', feature_id INTEGER REFERENCES features(id) ON DELETE SET NULL, drive_id INTEGER, phone TEXT NOT NULL DEFAULT '',
  confirmed INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS hunt_drives (id {{ID}}, hunt_id INTEGER NOT NULL REFERENCES hunts(id) ON DELETE CASCADE, name TEXT NOT NULL,
  start_time TEXT NOT NULL DEFAULT '', end_time TEXT NOT NULL DEFAULT '', geojson TEXT, notes TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS hunt_tasks (id {{ID}}, hunt_id INTEGER NOT NULL REFERENCES hunts(id) ON DELETE CASCADE, text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0, assignee TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS hunt_bag (id {{ID}}, hunt_id INTEGER NOT NULL REFERENCES hunts(id) ON DELETE CASCADE, species TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1, shooter TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS push_subs (id {{ID}}, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, endpoint TEXT NOT NULL UNIQUE,
  sub_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notifications (id {{ID}}, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, body TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '/', read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
`;

function toPg(sql) { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); }

async function sqliteAdapter() {
  const { DatabaseSync } = await import('node:sqlite');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(DATA_DIR, 'revier.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA.replace(/{{ID}}/g, 'INTEGER PRIMARY KEY AUTOINCREMENT').replace(/{{NOCASE}}/g, 'COLLATE NOCASE'));
  // Migrationen älterer Datenbanken
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!cols.includes('last_seen')) db.exec('ALTER TABLE users ADD COLUMN last_seen TEXT');
  const plain = rows => rows.map(r => ({ ...r }));
  return {
    dialect: 'sqlite',
    async all(sql, params = []) { return plain(db.prepare(sql).all(...params)); },
    async get(sql, params = []) { const r = db.prepare(sql).get(...params); return r ? { ...r } : null; },
    async run(sql, params = []) { const r = db.prepare(sql).run(...params); return { changes: Number(r.changes) }; },
    async insert(sql, params = []) { const r = db.prepare(sql + ' RETURNING id').all(...params); return Number(r[0].id); },
  };
}

/** Postgres: Netlify DB (automatisch über NETLIFY_DB_URL) oder jede DATABASE_URL über den pg-Treiber. */
async function pgAdapter(url) {
  let pool;
  if (process.env.NETLIFY_DB_URL && !process.env.DATABASE_URL) {
    const { getDatabase } = await import('@netlify/database');
    pool = getDatabase().pool;
  } else {
    const { default: pg } = await import('pg');
    const ssl = /sslmode=require|neon\.tech|\.aws\.|render\.com/i.test(url) ? { rejectUnauthorized: false } : undefined;
    pool = new pg.Pool({ connectionString: url, max: 3, ssl });
  }
  const query = (s, p) => pool.query(s, p);
  for (const stmt of SCHEMA.replace(/{{ID}}/g, 'SERIAL PRIMARY KEY').replace(/{{NOCASE}}/g, '').split(';')) {
    if (stmt.trim()) await query(stmt, []);
  }
  await query('CREATE UNIQUE INDEX IF NOT EXISTS users_name_lower ON users (LOWER(name))', []);
  const q = (s, p) => query(toPg(s), p);
  return {
    dialect: 'pg',
    async all(s, p = []) { return (await q(s, p)).rows; },
    async get(s, p = []) { return (await q(s, p)).rows[0] || null; },
    async run(s, p = []) { return { changes: (await q(s, p)).rowCount ?? 0 }; },
    async insert(s, p = []) { return Number((await q(s + ' RETURNING id', p)).rows[0].id); },
  };
}

let dbPromise;
export function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      let url = process.env.DATABASE_URL || process.env.NETLIFY_DB_URL;
      if (!url && (globalThis.Netlify || process.env.NETLIFY === 'true')) {
        try { url = (await import('@netlify/database')).getConnectionString(); process.env.NETLIFY_DB_URL = url; } catch {}
      }
      if (!url && (globalThis.Netlify || process.env.NETLIFY === 'true')) {
        throw new Error('Keine Datenbank konfiguriert: NETLIFY_DB_URL fehlt. Netlify DB im Projekt aktivieren oder DATABASE_URL setzen.');
      }
      return url ? pgAdapter(url) : sqliteAdapter();
    })();
    dbPromise.catch(e => { dbPromise = null; throw e; });
  }
  return dbPromise;
}

export async function getSetting(key, fallback = null) {
  const db = await getDb();
  const row = await db.get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? JSON.parse(row.value) : fallback;
}
export async function setSetting(key, value) {
  const db = await getDb();
  await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [key, JSON.stringify(value)]);
}

/** Erhöht den Versionszähler einer Sammlung; Clients fragen diese Zähler ab, um Änderungen zu erkennen. */
export async function bump(name) {
  const db = await getDb();
  await db.run('INSERT INTO versions (name, v) VALUES (?, 1) ON CONFLICT (name) DO UPDATE SET v = versions.v + 1', [name]);
}
export async function versions() {
  const db = await getDb();
  const rows = await db.all('SELECT name, v FROM versions');
  return Object.fromEntries(rows.map(r => [r.name, Number(r.v)]));
}
