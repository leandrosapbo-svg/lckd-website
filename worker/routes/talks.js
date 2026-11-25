// "Talked to" ticks on the "Talk to these" card (see lib/talks.js).
//   GET  /api/admin/talks?date=YYYY-MM-DD        who has been ticked that day                (any signed-in person)
//   POST /api/admin/talks  { action: 'done', pid, date, reason }   tick a student            (a coach signed in with Google)
//                          { action: 'undo', pid, date }           take their own tick back  (the coach who ticked, or the owner)
// Every answer carries that day's fresh list: { talks: { [pid]: { by, mine } } }

import { readSession, json, sameOrigin } from '../lib/auth.js';
import { hasDb } from '../lib/coaches.js';
import { validPid } from '../lib/comments.js';
import { dohaToday, addDays } from '../lib/data.js';
import { isDay, talksForDay, markTalk, undoTalk } from '../lib/talks.js';

const notReady = () => json({ error: 'The notes database is not connected.' }, 503);

// a chat is ticked on the day it happened (or the day before, for a late tick): not weeks ago, not in the future
const inRange = (day) => { const t = dohaToday(); return day >= addDays(t, -14) && day <= addDays(t, 1); };

export async function onRequestGet({ request, env }) {
  const s = await readSession(request, env);
  if (!s) return json({ error: 'Please sign in.' }, 401);
  const date = new URL(request.url).searchParams.get('date') || dohaToday();
  if (!isDay(date)) return json({ error: 'Bad date.' }, 400);
  if (!hasDb(env)) return notReady();
  return json({ talks: await talksForDay(env, date, s.email) });
}

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ error: 'Not allowed.' }, 403);
  const s = await readSession(request, env);
  if (!s) return json({ error: 'Please sign in.' }, 401);
  if (s.kind !== 'coach') return json({ error: 'Sign in with Google so the chat is saved under your name.' }, 403);
  if (!hasDb(env)) return notReady();

  let b;
  try {
    const text = await request.text();
    if (text.length > 2000) throw new Error('too big');
    b = JSON.parse(text);
  } catch (e) {
    return json({ error: 'Bad request.' }, 400);
  }
  if (!b || typeof b !== 'object' || !validPid(b.pid)) return json({ error: 'Bad student.' }, 400);
  if (!isDay(b.date) || !inRange(b.date)) return json({ error: 'Bad date.' }, 400);

  if (b.action === 'done') {
    await markTalk(env, { pid: b.pid, day: b.date, reason: b.reason, byEmail: s.email, byName: s.name });
    return json({ ok: true, talks: await talksForDay(env, b.date, s.email) });
  }

  if (b.action === 'undo') {
    const done = await undoTalk(env, { pid: b.pid, day: b.date, byEmail: s.email, isOwner: s.role === 'owner' });
    if (!done) {
      const now = await talksForDay(env, b.date, s.email);
      // nothing to undo: either it was already taken back, or it was ticked by another coach
      return json({ error: now[b.pid] ? 'Only the coach who ticked this can take it back.' : 'Already taken back.', talks: now }, now[b.pid] ? 403 : 409);
    }
    return json({ ok: true, talks: await talksForDay(env, b.date, s.email) });
  }

  return json({ error: 'Bad request.' }, 400);
}
