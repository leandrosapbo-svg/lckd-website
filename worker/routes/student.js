// GET /api/admin/student?pid=...   (needs the login cookie)
// The history of one student: summary + their most recent classes.

import { readSession, json } from '../lib/auth.js';
import { dohaToday, addDays, demoHistoryRows } from '../lib/data.js';
import { normStatus, mergeRows, summarize } from '../lib/history.js';
import { directoryEntry } from '../lib/directory.js';
import { phoneLabel, whatsappNumber } from '../lib/search.js';
import { hasDb } from '../lib/coaches.js';
import { lastTalk } from '../lib/talks.js';

// Lookups per request: 1 history + (LOOK_BACK + LOOK_AHEAD + 1) days = 39, plus 8 when the search list is not in
// memory yet (phone and gender come from it). The free plan allows 50.
const LOOK_BACK = 30;   // days of our own saved snapshots to search (keeps us inside the 50 lookups a request may make)
const LOOK_AHEAD = 7;
const RECENT = 15;

export async function onRequestGet({ request, env }) {
  if (!(await readSession(request, env))) return json({ error: 'Please sign in.' }, 401);

  const pid = new URL(request.url).searchParams.get('pid') || '';
  if (!/^[A-Za-z0-9_-]{8,32}$/.test(pid)) return json({ error: 'Bad student.' }, 400);

  const today = dohaToday();
  let profile = null, saved = [], source = 'live', gender = '';

  if (env.DEMO === '1') {
    source = 'sample';
    profile = { plan: [{ kind: 'membership', name: 'LCKD FOUNDING 1 MONTH', until: addDays(today, 12) }], bookings: demoHistoryRows(pid, today) };
  } else {
    if (!env.BOOKINGS) return json({ error: 'Bookings storage is not set up yet.' }, 503);
    profile = await env.BOOKINGS.get('hist:' + pid, 'json');

    // what we saved ourselves from the daily snapshots
    const days = [];
    for (let n = -LOOK_BACK; n <= LOOK_AHEAD; n++) days.push(addDays(today, n));
    const found = [];
    for (let i = 0; i < days.length; i += 10) {
      const batch = await Promise.all(days.slice(i, i + 10).map((d) => env.BOOKINGS.get('day:' + d, 'json')));
      found.push(...batch);
    }
    found.forEach((day) => {
      if (!day) return;
      day.classes.forEach((c) => c.students.forEach((s) => {
        if (s.pid !== pid) return;
        saved.push({ date: day.date, time: c.time, kind: c.kind, type: s.type, zone: s.zone, spot: s.spot, status: normStatus(s.status) });
        if (s.gender === 'F' || s.gender === 'M') gender = s.gender; // days run oldest to newest, so the latest one wins
      }));
    });
  }

  // The search list knows their phone number, and their gender when they were not booked lately (found through
  // the search box). It is kept in memory for a minute, so this is usually free. Never fails the request.
  let entry = null;
  try { entry = await directoryEntry(env, pid); } catch (e) { entry = null; }
  if (!gender && entry) gender = entry.gender || '';

  // The last time a coach ticked them on the "Talk to these" card. Never fails the request.
  let chat = null;
  try { if (hasDb(env)) chat = await lastTalk(env, pid); } catch (e) { chat = null; }

  const rows = mergeRows(profile && profile.bookings, saved);
  const summary = summarize(rows, today);
  const oldestSaved = saved.map((r) => r.date).sort()[0] || null;

  return json({
    source,
    hasProfile: !!profile,
    gender, // 'F', 'M' or '' when G8TS has none on file
    phone: entry ? phoneLabel(entry.phone) : '',   // as shown to the coach
    wa: entry ? whatsappNumber(entry.phone) : '',  // for a WhatsApp chat link; '' = no usable number
    lastChat: chat, // { by, day } of the last "talked to" tick, or null
    // for G8TS-app members there is no profile, so history only goes back as far as we saved it
    limitedSince: profile ? null : oldestSaved,
    plan: (profile && profile.plan) || [],
    summary,
    recent: rows.slice(0, RECENT),
    total: rows.length,
  });
}
