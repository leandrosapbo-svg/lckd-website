// Receives the booking snapshot collected from the LCKD G8TS admin session and stores it
// (Cloudflare KV, binding name BOOKINGS) so only the signed-in admin page can read it.
//
// POST /api/admin/ingest   Authorization: Bearer <INGEST_TOKEN>
// body: { days: [ { date: 'YYYY-MM-DD', classes: [ ... ] } ] }   (shape: see _lib/data.js)

import { json } from '../lib/auth.js';

const ALLOWED_ORIGINS = ['https://lckd.g8ts.app']; // the admin site the collector runs on
const KINDS = ['Mixed', 'Ladies only'];
const TYPES = ['trial', 'walkin', 'membership', 'pack', 'g8ts'];
const STATUSES = ['enrolled', 'completed', 'noshow'];
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
    students.push({ name, zone, spot, type, gender, status });
  }
  return { id: str(c.id, 40) || null, time, kind: c.kind, name: str(c.name, 120), students };
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
  if (!body || !Array.isArray(body.days) || body.days.length < 1 || body.days.length > 14) return json({ error: 'Bad request.' }, 400, cors);

  const now = new Date().toISOString();
  const saved = [];
  for (const day of body.days) {
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(String(day.date)) || !Array.isArray(day.classes) || day.classes.length > 20) {
      return json({ error: 'Bad day.' }, 400, cors);
    }
    const classes = day.classes.map(cleanClass);
    if (classes.some((c) => !c)) return json({ error: 'Bad class on ' + day.date + '.' }, 400, cors);
    classes.forEach((c, i) => { c.id = c.id || day.date + 'T' + c.time + (c.kind === 'Ladies only' ? 'L' : 'M'); });
    classes.sort((a, b) => a.time.localeCompare(b.time) || a.kind.localeCompare(b.kind));
    await env.BOOKINGS.put('day:' + day.date, JSON.stringify({ date: day.date, updated: now, capacity: 50, classes }), { expirationTtl: KEEP_SECONDS });
    saved.push(day.date);
  }
  return json({ ok: true, saved, updated: now }, 200, cors);
}
