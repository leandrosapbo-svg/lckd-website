// The coaches: who may sign in with Google, kept in the D1 database (binding DB, database "lckd-admin").
//
// The tables are created by the Worker itself the first time it runs (CREATE TABLE IF NOT EXISTS), so there is no
// separate migration step: add a statement to SCHEMA when a new table is needed. Existing tables are never changed
// by these statements, so a new column needs its own careful ALTER.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS coaches (
    email TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'coach',
    active INTEGER NOT NULL DEFAULT 1,
    added_by TEXT NOT NULL DEFAULT '',
    added_at TEXT NOT NULL,
    last_login TEXT
  )`,
  // Coach notes about students (lib/comments.js). Kept forever: a deleted note only gets deleted_at, it is never removed.
  // pid = the student's private id (HMAC of their G8TS PIN with SESSION_SECRET, see lib/pid.js).
  `CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pid TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    body TEXT NOT NULL,
    author_email TEXT NOT NULL,
    author_name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    deleted_at TEXT,
    deleted_by TEXT,
    edited_at TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS comments_by_pid ON comments (pid, created_at)',
  // The earlier version of a note, saved every time its author edits it (so nothing is ever lost).
  // (A database created before notes could be edited gets the edited_at column from migrateComments in lib/comments.js.)
  `CREATE TABLE IF NOT EXISTS comment_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    body TEXT NOT NULL,
    saved_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS comment_history_by_comment ON comment_history (comment_id)',
  // "Talked to": a coach ticks a student on the "Talk to these" card once they really had a chat (lib/talks.js).
  // One live row per student per class day; undoing only fills undone_at, so nothing is ever removed.
  `CREATE TABLE IF NOT EXISTS talks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pid TEXT NOT NULL,
    day TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    by_email TEXT NOT NULL,
    by_name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    undone_at TEXT,
    undone_by TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS talks_by_day ON talks (day)',
  'CREATE INDEX IF NOT EXISTS talks_by_pid ON talks (pid, day)',
];

export function hasDb(env) {
  return !!(env && env.DB && typeof env.DB.prepare === 'function');
}

let schemaReady = null;
export function forgetSchema() { schemaReady = null; }

export function ensureSchema(env) {
  if (!hasDb(env)) return Promise.reject(new Error('The coaches database is not connected.'));
  if (!schemaReady) {
    schemaReady = env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

// ---------- emails ----------

// One form per mailbox: lowercase, and for Gmail the dots and "+tag" do not matter (Google may report
// "sara.a@gmail.com" while the owner typed "saraa@gmail.com").
export function normEmail(s) {
  let e = String(s == null ? '' : s).trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return e;
  let local = e.slice(0, at), domain = e.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.split('+')[0].replace(/\./g, '');
  return local + '@' + domain;
}

export function validEmail(s) {
  const e = String(s == null ? '' : s);
  return e.length <= 254 && /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/.test(e);
}

// ---------- reading ----------

const CACHE_MS = 30 * 1000;
const cache = new Map(); // email -> { at, coach }
export function forgetCoachCache() { cache.clear(); }

const rowToCoach = (r) => ({
  email: r.email,
  name: r.name || '',
  role: r.role === 'owner' ? 'owner' : 'coach',
  active: !!r.active,
  addedBy: r.added_by || '',
  addedAt: r.added_at || '',
  lastLogin: r.last_login || '',
});

// One coach, or null. Kept for 30 seconds so a page that asks every minute does not hit the database every time.
export async function getCoach(env, email, fresh) {
  if (!hasDb(env)) return null;
  const key = normEmail(email);
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.coach;
  await ensureSchema(env);
  const row = await env.DB.prepare('SELECT email, name, role, active, added_by, added_at, last_login FROM coaches WHERE email = ?').bind(key).first();
  const coach = row ? rowToCoach(row) : null;
  cache.set(key, { at: Date.now(), coach });
  return coach;
}

export async function listCoaches(env) {
  await ensureSchema(env);
  const { results } = await env.DB.prepare(
    "SELECT email, name, role, active, added_by, added_at, last_login FROM coaches WHERE active = 1 ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, lower(CASE WHEN name = '' THEN email ELSE name END)"
  ).all();
  return (results || []).map(rowToCoach);
}

// ---------- changing ----------

// Add a coach, or bring back one who was removed. A name typed by the owner is kept until the coach signs in
// (then the name from their Google account replaces it).
export async function addCoach(env, { email, name, addedBy }) {
  await ensureSchema(env);
  const key = normEmail(email);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO coaches (email, name, role, active, added_by, added_at) VALUES (?, ?, 'coach', 1, ?, ?)
     ON CONFLICT(email) DO UPDATE SET active = 1, name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE coaches.name END`
  ).bind(key, String(name || '').trim().slice(0, 80), normEmail(addedBy), now).run();
  cache.delete(key);
  return getCoach(env, key, true);
}

// Take a coach off the list (their old comments keep their name). The owner cannot be removed.
export async function removeCoach(env, email) {
  await ensureSchema(env);
  const key = normEmail(email);
  const r = await env.DB.prepare("UPDATE coaches SET active = 0 WHERE email = ? AND role <> 'owner'").bind(key).run();
  cache.delete(key);
  return !!(r && r.meta && r.meta.changes);
}

// The person named in OWNER_EMAIL is always the owner (created on their first sign-in).
export async function ensureOwner(env, email, name) {
  await ensureSchema(env);
  const key = normEmail(email);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO coaches (email, name, role, active, added_by, added_at) VALUES (?, ?, 'owner', 1, '', ?)
     ON CONFLICT(email) DO UPDATE SET role = 'owner', active = 1`
  ).bind(key, String(name || '').trim().slice(0, 80), now).run();
  cache.delete(key);
  return getCoach(env, key, true);
}

// Called at every Google sign-in: remembers the name on their Google account and when they came.
export async function touchCoach(env, email, name) {
  await ensureSchema(env);
  const key = normEmail(email);
  await env.DB.prepare("UPDATE coaches SET name = CASE WHEN ? <> '' THEN ? ELSE name END, last_login = ? WHERE email = ?")
    .bind(String(name || '').trim().slice(0, 80), String(name || '').trim().slice(0, 80), new Date().toISOString(), key).run();
  cache.delete(key);
}
