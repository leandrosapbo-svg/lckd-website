import { readSession, json } from '../lib/auth.js';
import { getBookings, dohaToday, addDays } from '../lib/data.js';

export async function onRequestGet({ request, env }) {
  if (!(await readSession(request, env))) return json({ error: 'Please sign in.' }, 401);

  const date = new URL(request.url).searchParams.get('date') || dohaToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date + 'T00:00:00Z'))) {
    return json({ error: 'Bad date.' }, 400);
  }
  const today = dohaToday();
  if (date < addDays(today, -120) || date > addDays(today, 60)) return json({ error: 'Date out of range.' }, 400);

  try {
    return json(await getBookings(date, env));
  } catch (e) {
    return json({ error: /not set up/.test(String(e && e.message)) ? 'Bookings storage is not set up yet.' : 'Could not load bookings.' }, 503);
  }
}
