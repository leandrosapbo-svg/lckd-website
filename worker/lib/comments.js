// Coach notes about students, kept in the D1 table `comments` (created in lib/coaches.js).
//
// Rules the owner chose (2026-11-25): every coach sees every note, each note has a category, notes are kept forever.
// So a "deleted" note is only hidden (deleted_at / deleted_by are filled in); the row stays in the database.
// A student is identified by their private id (pid). Do not rotate SESSION_SECRET: the pids would change and every
// note would lose its student.

import { ensureSchema, normEmail } from './coaches.js';

// The categories coaches can pick. Change the labels here (or add one at the end): the page reads this list from the
// Worker. Do not rename a key that already has notes (they would show up as "General").
export const CATEGORIES = [
  { key: 'injury', label: 'Injury or health' },
  { key: 'goal', label: 'Goal' },
  { key: 'progress', label: 'Progress' },
  { key: 'followup', label: 'Follow up' },
  { key: 'membership', label: 'Membership' },
  { key: 'general', label: 'General' },
];
export const MAX_BODY = 1500;
const MAX_LIST = 300;   // notes shown per student (newest first)
const CHUNK = 90;       // D1 allows 100 values in one query

export const categoryKey = (k) => (CATEGORIES.some((c) => c.key === k) ? k : null);
export const validPid = (p) => /^[A-Za-z0-9_-]{8,32}$/.test(String(p || ''));

// Plain text only: no control characters, no more than one blank line in a row, at most MAX_BODY characters.
export function cleanBody(s) {
  return String(s == null ? '' : s)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_BODY);
}

// Newest first. viewerEmail / viewerIsOwner decide which notes show a Delete button (your own; the owner may delete any).
export async function listComments(env, pid, viewerEmail, viewerIsOwner) {
  await ensureSchema(env);
  const me = normEmail(viewerEmail);
  const { results } = await env.DB.prepare(
    'SELECT id, category, body, author_email, author_name, created_at FROM comments WHERE pid = ? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT ?'
  ).bind(pid, MAX_LIST).all();
  return (results || []).map((r) => {
    const mine = !!me && normEmail(r.author_email) === me;
    return {
      id: r.id,
      category: categoryKey(r.category) || 'general',
      body: r.body,
      author: r.author_name || String(r.author_email || '').split('@')[0],
      at: r.created_at,
      mine,
      canDelete: mine || !!viewerIsOwner,
    };
  });
}

export async function addComment(env, { pid, category, body, authorEmail, authorName }) {
  await ensureSchema(env);
  await env.DB.prepare(
    'INSERT INTO comments (pid, category, body, author_email, author_name, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(pid, category, body, normEmail(authorEmail), String(authorName || '').slice(0, 80), new Date().toISOString()).run();
}

// Hides a note (never removes it). The author can hide their own; the owner can hide any. -> true if one was hidden
export async function deleteComment(env, { id, pid, byEmail, isOwner }) {
  await ensureSchema(env);
  const now = new Date().toISOString();
  const by = normEmail(byEmail);
  const r = isOwner
    ? await env.DB.prepare('UPDATE comments SET deleted_at = ?, deleted_by = ? WHERE id = ? AND pid = ? AND deleted_at IS NULL').bind(now, by, id, pid).run()
    : await env.DB.prepare('UPDATE comments SET deleted_at = ?, deleted_by = ? WHERE id = ? AND pid = ? AND author_email = ? AND deleted_at IS NULL').bind(now, by, id, pid, by).run();
  return !!(r && r.meta && r.meta.changes);
}

// For the little note icon in a class's student list: { [pid]: { n: how many notes, inj: has an injury/health note } }
// Only students who have notes appear. Uses the pid index, so it reads little however many notes exist overall.
export async function noteSummary(env, pids) {
  const list = [...new Set((pids || []).filter(validPid))];
  const out = {};
  if (!list.length) return out;
  await ensureSchema(env);
  for (let i = 0; i < list.length; i += CHUNK) {
    const part = list.slice(i, i + CHUNK);
    const { results } = await env.DB.prepare(
      `SELECT pid, COUNT(*) AS n, MAX(CASE WHEN category = 'injury' THEN 1 ELSE 0 END) AS inj
       FROM comments WHERE deleted_at IS NULL AND pid IN (${part.map(() => '?').join(',')}) GROUP BY pid`
    ).bind(...part).all();
    (results || []).forEach((r) => { out[r.pid] = { n: r.n, inj: !!r.inj }; });
  }
  return out;
}
