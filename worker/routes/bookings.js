import { readSession, json } from '../lib/auth.js';
import { getBookings, dohaToday, addDays } from '../lib/data.js';
import { hasDb } from '../lib/coaches.js';
import { noteSummary } from '../lib/comments.js';
import { talksForDay } from '../lib/talks.js';

export async function onRequestGet({ request, env }) {
  const session = await readSession(request, env);
  if (!session) return json({ error: 'Please sign in.' }, 401);

  const date = new URL(request.url).searchParams.get('date') || dohaToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date + 'T00:00:00Z'))) {
    return json({ error: 'Bad date.' }, 400);
  }
  const today = dohaToday();
  if (date < addDays(today, -120) || date > addDays(today, 60)) return json({ error: 'Date out of range.' }, 400);

  try {
    const day = await getBookings(date, env);

    // Which of today's students have coach notes: the page shows a small note icon next to them.
    // (A problem with the notes database must never hide the bookings, so it is ignored here.)
    if (hasDb(env) && Array.isArray(day.classes) && day.classes.length) {
      try {
        const pids = [];
        day.classes.forEach((c) => (c.students || []).forEach((s) => { if (s.pid) pids.push(s.pid); }));
        const notes = await noteSummary(env, pids);
        if (Object.keys(notes).length) day.notes = notes;
      } catch (e) { /* no icons this time */ }
      // Who has already been spoken to on this day (the ticks on the "Talk to these" card). Same rule: never hides the bookings.
      try {
        const talks = await talksForDay(env, date, session.email);
        if (Object.keys(talks).length) day.talks = talks;
      } catch (e) { /* no ticks this time */ }
    }
    return json(day);
  } catch (e) {
    return json({ error: /not set up/.test(String(e && e.message)) ? 'Bookings storage is not set up yet.' : 'Could not load bookings.' }, 503);
  }
}
