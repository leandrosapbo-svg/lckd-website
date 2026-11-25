// Receives what the sync add-on collected from the LCKD G8TS admin session and stores it
// (Cloudflare KV, binding name BOOKINGS) so only the signed-in admin page can read it.
//
// POST /api/admin/ingest   Authorization: Bearer <INGEST_TOKEN>
// body: { days?: [ { date: 'YYYY-MM-DD', classes: [ ... ] } ],          the day snapshots (see _lib/data.js)
//         histories?: [ { pin, plan: [...], bookings: [...] } ],         what each student's G8TS profile says
//         directory?: { shard, people: [ { pin, name, phone, gender? } ] } }      one shard of the student search list
//
// Student PINs are turned into private ids (pid) here and thrown away; the PIN is never stored.

import { json } from '../lib/auth.js';
import { makePid } from '../lib/pid.js';
import { SHARDS, forgetDirectory } from '../lib/directory.js';

const ALLOWED_ORIGINS = ['https://lckd.g8ts.app']; // the admin site the old in-page collector ran on
const KINDS = ['Mixed', 'Ladies only'];
const TYPES = ['trial', 'walkin', 'membership', 'pack', 'g8ts'];
const STATUSES = ['enrolled', 'completed', 'noshow'];
const HIST_STATUSES = ['booked', 'completed', 'noshow', 'cancelled'];
const ZONES = ['S', 'C', 'H'];
const MAX_BODY = 2 * 1024 * 1024;
const KEEP_SECONDS = 400 * 24 * 3600;

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  if (!ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

async function sameToken(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const ax = new Uint8Array(x), by = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < ax.length; i++) d |= ax[i] ^ by[i];
  return d === 0;
}

const str = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v));
const cleanPin = (v) => (/^\d{3,12}$/.test(String(v || '')) ? String(v) : '');

function cleanClass(c) {
  if (!c || typeof c !== 'object') return null;
  const time = str(c.time, 5);
  if (!/^\d{2}:\d{2}$/.test(time) || !KINDS.includes(c.kind) || !Array.isArray(c.students) || c.students.length > 80) return null;
  const students = [];
  for (const p of c.students) {
    if (!p || typeof p !== 'object') continue;
    const type = TYPES.includes(p.type) ? p.type : 'walkin';
    const status = STATUSES.includes(p.status) ? p.status : 'enrolled';
    const zone = ZONES.includes(p.zone) ? p.zone : '';
    const spot = Number.isInteger(p.spot) && p.spot >= 0 && p.spot < 100 ? p.spot : 0;
    const gender = p.gender === 'F' || p.gender === 'M' ? p.gender : '';
    const name = str(p.name, 80);
    if (!name) continue;
    // bd = it is their birthday that day; cn = the booking is their 10th / 25th / 50th ... class (the page shows both on the gift icon)
    const cn = Number.isInteger(p.cn) && p.cn >= 1 && p.cn <= 9999 ? p.cn : undefined;
    // For the "Talk to these" card: te = the day their trial pack ends (they have no paid plan yet), nc = classes they
    // had completed before this one (only sent with te), ab = days since their previous class when that is a long break
    const te = isDate(p.te) && !Number.isNaN(Date.parse(p.te + 'T00:00:00Z')) ? String(p.te) : undefined;
    const nc = te && Number.isInteger(p.nc) && p.nc >= 0 && p.nc <= 9999 ? p.nc : undefined;
    const ab = Number.isInteger(p.ab) && p.ab >= 1 && p.ab <= 999 ? p.ab : undefined;
    students.push({ name, pin: cleanPin(p.pin), zone, spot, type, gender, status, first: p.first === true ? true : undefined, bd: p.bd === true ? true : undefined, cn, te, nc, ab });
  }
  return { id: str(c.id, 40) || null, time, kind: c.kind, name: str(c.name, 120), students };
}

function cleanHistory(h) {
  const pin = cleanPin(h && h.pin);
  if (!pin) return null;
  const plan = (Array.isArray(h.plan) ? h.plan : []).slice(0, 4).map((p) => ({
    kind: p && p.kind === 'membership' ? 'membership' : 'pack',
    name: str(p && p.name, 60),
    until: isDate(p && p.until) ? p.until : '',
  })).filter((p) => p.name);
  const bookings = [];
  for (const b of (Array.isArray(h.bookings) ? h.bookings : []).slice(0, 80)) {
    if (!b || !isDate(b.date) || !/^\d{2}:\d{2}$/.test(String(b.time))) continue;
    bookings.push({
      date: b.date,
      time: b.time,
      status: HIST_STATUSES.includes(b.status) ? b.status : 'booked',
      type: TYPES.includes(b.type) ? b.type : '',
      zone: ZONES.includes(b.zone) ? b.zone : '',
      spot: Number.isInteger(b.spot) && b.spot >= 0 && b.spot < 100 ? b.spot : 0,
    });
  }
  return { pin, plan, bookings };
}

// One shard of the search list. Only the name, phone and gender are kept, next to the private id.
function cleanDirectory(d) {
  if (!d || typeof d !== 'object' || !Number.isInteger(d.shard) || d.shard < 0 || d.shard >= SHARDS) return null;
  if (!Array.isArray(d.people) || d.people.length > 600) return null;
  const people = [];
  const seen = new Set();
  for (const p of d.people) {
    if (!p || typeof p !== 'object') continue;
    const pin = cleanPin(p.pin);
    const name = str(p.name, 80);
    if (!pin || !name || seen.has(pin)) continue;
    seen.add(pin);
    people.push({ pin, name, phone: str(p.phone, 24).replace(/[^\d+()\s-]/g, ''), gender: p.gender === 'F' || p.gender === 'M' ? p.gender : '' });
  }
  return { shard: d.shard, people };
}

export async function onRequest({ request, env }) {
  const cors = corsHeaders(request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405, cors);
  if (!env.INGEST_TOKEN || !env.BOOKINGS) return json({ error: 'Not set up.' }, 503, cors);

  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token || !(await sameToken(token, String(env.INGEST_TOKEN)))) {
    await new Promise((r) => setTimeout(r, 500));
    return json({ error: 'Not allowed.' }, 401, cors);
  }

  let body;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return json({ error: 'Too big.' }, 413, cors);
    body = JSON.parse(text);
  } catch (e) {
    return json({ error: 'Bad request.' }, 400, cors);
  }
  const days = body && body.days, histories = body && body.histories;
  const directory = body && body.directory ? cleanDirectory(body.directory) : null;
  if (!body || (!Array.isArray(days) && !Array.isArray(histories) && !directory)) return json({ error: 'Bad request.' }, 400, cors);
  if ((days && (days.length < 1 || days.length > 14)) || (histories && histories.length > 100)) return json({ error: 'Bad request.' }, 400, cors);

  const now = new Date().toISOString();
  const pidCache = new Map();
  const pidOf = async (pin) => { if (!pidCache.has(pin)) pidCache.set(pin, await makePid(env, pin)); return pidCache.get(pin); };

  // Cloudflare's free KV plan allows 1,000 writes a day (and 100,000 reads), so nothing is written when it is
  // identical to what is already stored. Reading is cheap; writing is the scarce thing.
  const saved = [], same = [];
  for (const day of days || []) {
    if (!day || !isDate(day.date) || !Array.isArray(day.classes) || day.classes.length > 20) return json({ error: 'Bad day.' }, 400, cors);
    const classes = day.classes.map(cleanClass);
    if (classes.some((c) => !c)) return json({ error: 'Bad class on ' + day.date + '.' }, 400, cors);
    for (const c of classes) {
      c.id = c.id || day.date + 'T' + c.time + (c.kind === 'Ladies only' ? 'L' : 'M');
      for (const s of c.students) {
        if (s.pin) s.pid = await pidOf(s.pin);
        delete s.pin; // the PIN is never stored
      }
    }
    classes.sort((a, b) => a.time.localeCompare(b.time) || a.kind.localeCompare(b.kind));
    const prev = await env.BOOKINGS.get('day:' + day.date, 'json');
    if (prev && JSON.stringify(prev.classes) === JSON.stringify(classes)) { same.push(day.date); continue; }
    await env.BOOKINGS.put('day:' + day.date, JSON.stringify({ date: day.date, updated: now, capacity: 50, classes }), { expirationTtl: KEEP_SECONDS });
    saved.push(day.date);
  }
  // "Last checked" lives in one small record, so a sync that changed nothing still shows as fresh on the page
  // (the page uses it for the days it covers) at the cost of a single write.
  if (days && days.length) {
    const dates = days.map((d) => d.date).sort();
    await env.BOOKINGS.put('meta:sync', JSON.stringify({ at: now, from: dates[0], to: dates[dates.length - 1] }), { expirationTtl: KEEP_SECONDS });
  }

  // (each KV lookup counts toward the 50 a request may make, so comparing is only done for small batches)
  const canCompare = !days && (histories || []).length <= 20;
  let savedHistories = 0, sameHistories = 0;
  for (const h of histories || []) {
    const clean = cleanHistory(h);
    if (!clean) continue;
    const pid = await pidOf(clean.pin);
    if (canCompare) {
      const prev = await env.BOOKINGS.get('hist:' + pid, 'json');
      if (prev && JSON.stringify({ plan: prev.plan, bookings: prev.bookings }) === JSON.stringify({ plan: clean.plan, bookings: clean.bookings })) { sameHistories++; continue; }
    }
    await env.BOOKINGS.put('hist:' + pid, JSON.stringify({ updated: now, plan: clean.plan, bookings: clean.bookings }), { expirationTtl: KEEP_SECONDS });
    savedHistories++;
  }

  let savedPeople = 0;
  if (directory) {
    const list = [];
    for (const p of directory.people) list.push({ p: await pidOf(p.pin), n: p.name, t: p.phone, g: p.gender || undefined });
    list.sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));
    const text = JSON.stringify(list);
    if ((await env.BOOKINGS.get('dir:' + directory.shard, 'text')) !== text) {
      await env.BOOKINGS.put('dir:' + directory.shard, text, { expirationTtl: KEEP_SECONDS });
      forgetDirectory();
      savedPeople = list.length;
    }
  }

  return json({ ok: true, saved, same, histories: savedHistories, historiesSame: sameHistories, people: savedPeople, updated: now }, 200, cors);
}
