// "Talked to": the coach ticks a student on the "Talk to these" card of a class once they really had a chat.
//
// The card (admin page) suggests who to speak to and about what: a trial that is about to end, a first class, someone
// back after a break, an injury note, a milestone, a birthday. This file keeps the ticks, so the team can see who has
// been spoken to and, later, whether chatting helps people stay.
//
// Rules: one live tick per student per class day (the first coach to tick wins), only the coach who ticked (or the
// owner) can undo it, and undoing only fills undone_at / undone_by: the row stays, like the coach notes.
// A student is identified by their private id (pid), as everywhere else.

import { ensureSchema, normEmail } from './coaches.js';
import { validPid } from './comments.js';

export const REASONS = ['trial', 'injury', 'followup', 'first', 'back', 'milestone', 'birthday'];
export const reasonKey = (r) => (REASONS.includes(r) ? r : 'other');
export const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !Number.isNaN(Date.parse(d + 'T00:00:00Z'));

// Who has been ticked on this class day: { [pid]: { by: 'Allan Carvalho', mine: true/false } }. Names only, never emails.
export async function talksForDay(env, day, viewerEmail) {
  if (!isDay(day)) return {};
  await ensureSchema(env);
  const me = normEmail(viewerEmail);
  const { results } = await env.DB.prepare(
    'SELECT pid, by_email, by_name FROM talks WHERE day = ? AND undone_at IS NULL ORDER BY id'
  ).bind(day).all();
  const out = {};
  (results || []).forEach((r) => {
    if (out[r.pid]) return;
    out[r.pid] = { by: r.by_name || String(r.by_email || '').split('@')[0], mine: !!me && normEmail(r.by_email) === me };
  });
  return out;
}

// Ticks a student for a class day. -> true if a tick was added, false if somebody had already ticked them that day.
export async function markTalk(env, { pid, day, reason, byEmail, byName }) {
  if (!validPid(pid) || !isDay(day)) return false;
  await ensureSchema(env);
  const r = await env.DB.prepare(
    `INSERT INTO talks (pid, day, reason, by_email, by_name, created_at)
     SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM talks WHERE pid = ? AND day = ? AND undone_at IS NULL)`
  ).bind(pid, day, reasonKey(reason), normEmail(byEmail), String(byName || '').slice(0, 80), new Date().toISOString(), pid, day).run();
  return !!(r && r.meta && r.meta.changes);
}

// Takes a tick back (it is hidden, not removed). The coach who ticked it, or the owner. -> true if one was undone.
export async function undoTalk(env, { pid, day, byEmail, isOwner }) {
  if (!validPid(pid) || !isDay(day)) return false;
  await ensureSchema(env);
  const now = new Date().toISOString();
  const by = normEmail(byEmail);
  const r = isOwner
    ? await env.DB.prepare('UPDATE talks SET undone_at = ?, undone_by = ? WHERE pid = ? AND day = ? AND undone_at IS NULL').bind(now, by, pid, day).run()
    : await env.DB.prepare('UPDATE talks SET undone_at = ?, undone_by = ? WHERE pid = ? AND day = ? AND by_email = ? AND undone_at IS NULL').bind(now, by, pid, day, by).run();
  return !!(r && r.meta && r.meta.changes);
}

// The most recent chat with this student: { by, day } or null (shown on the student's page: "Last chat: Allan, 24 Nov")
export async function lastTalk(env, pid) {
  if (!validPid(pid)) return null;
  await ensureSchema(env);
  const row = await env.DB.prepare(
    'SELECT day, by_name, by_email FROM talks WHERE pid = ? AND undone_at IS NULL ORDER BY day DESC, id DESC LIMIT 1'
  ).bind(pid).first();
  return row ? { by: row.by_name || String(row.by_email || '').split('@')[0], day: row.day } : null;
}
