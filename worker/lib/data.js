// Where the admin page gets its bookings.
//
// SAMPLE VERSION: this invents believable demo classes and students (fake names) from the weekly
// timetable so the page can be tried and tuned. When we go live, only getBookings() is replaced:
// it will return the latest snapshot collected from the LCKD admin session. The page and the
// login do not change.
//
// getBookings(date) returns:
//   { date, source, updated, capacity, zones: [{ key, name, capacity }],
//     classes: [ { id, time, kind: 'Mixed' | 'Ladies only', name,
//                  students: [ { name, zone: 'S'|'C'|'H', spot, type, gender: 'F'|'M'|'', status,
//                                first?: true, bd?: true, cn?: 25 } ] } ] }
//   type   = trial | walkin | membership | pack | g8ts
//   status = enrolled | completed | noshow   (cancelled bookings are left out)
//   first  = their very first class ever;  bd = their birthday is on this day;  cn = this booking is their 10th / 25th / 50th ... class

const CAPACITY = 50;
const ZONES = [
  { key: 'S', name: 'Strength', capacity: 14 },
  { key: 'C', name: 'Cardio', capacity: 14 },
  { key: 'H', name: 'Hybrid', capacity: 22 },
];

// Same timetable as lckd.qa/schedule. 0 = Sunday ... 6 = Saturday.
const MIXED = {
  0: ['07:00', '08:15', '16:30', '17:30', '19:00'],
  1: ['07:00', '08:15', '14:30', '16:30', '17:30'],
  2: ['07:00', '08:15', '16:30', '17:30', '19:00'],
  3: ['07:00', '08:15', '14:30', '16:30', '17:30'],
  4: ['07:00', '08:15', '16:30', '17:30'],
  5: ['09:15'],
  6: ['09:00', '10:15'],
};
const LADIES = {
  0: ['10:30', '14:30'],
  1: ['10:30', '19:00'],
  2: ['10:30', '14:30'],
  3: ['10:30', '19:00'],
  4: ['10:30', '14:30'],
  5: ['10:30'],
  6: ['11:30'],
};
const CLASS_NAME = {
  0: 'Push Strength - Cardio - Hybrid',
  1: 'Pull Strength - Cardio - Hybrid',
  2: 'Full Body Hypertrophy - Cardio - Hybrid',
  3: 'Lower Strength - Cardio - Hybrid',
  4: 'Upper Strength - Cardio - Hybrid',
  5: 'Hybrid',
  6: 'Full Body Functional Strength - Cardio - Hybrid',
};

// How busy each slot usually is (relative).
const DEMAND = {
  '07:00': 0.6, '08:15': 0.5, '09:00': 0.5, '09:15': 0.5, '10:15': 0.5, '10:30': 0.45,
  '11:30': 0.45, '14:30': 0.35, '16:30': 1, '17:30': 0.8, '19:00': 0.6,
};

// Mix of how people booked (close to what the roster shows today).
const TYPE_WEIGHTS = [['trial', 0.32], ['membership', 0.36], ['g8ts', 0.18], ['walkin', 0.07], ['pack', 0.07]];
const ZONE_WEIGHTS = [['S', 0.4], ['C', 0.2], ['H', 0.4]];

const FIRST_F = ['Layla', 'Noor', 'Sara', 'Maya', 'Hessa', 'Aisha', 'Rana', 'Lina', 'Dana', 'Mariam', 'Nadia', 'Yasmin', 'Reem', 'Fatima', 'Joanna', 'Elena'];
const FIRST_M = ['Omar', 'Khalid', 'Ali', 'Yousef', 'Hamad', 'Karim', 'Faisal', 'Tariq', 'Nasser', 'Sami', 'Daniel', 'Marco', 'Adam', 'Ravi', 'Ahmed', 'Jamal'];
const LAST = ['Al Thani', 'Haddad', 'Rahman', 'Santos', 'Khan', 'Nasser', 'Mansour', 'Silva', 'Farouk', 'Ibrahim', 'Costa', 'Hassan', 'Qasim', 'Petrov', 'Demir', 'Said'];

export function dohaToday() {
  // built from parts, because the "en-CA" shortcut formats dates differently in different engines
  const o = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Qatar', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date()).forEach((p) => { o[p.type] = p.value; });
  return o.year + '-' + o.month + '-' + o.day;
}

function dohaMinutes() {
  let h = 0, m = 0;
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Qatar', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).forEach((p) => {
      if (p.type === 'hour') h = +p.value;
      if (p.type === 'minute') m = +p.value;
    });
  return h * 60 + m;
}

export function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function seeded(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = (Math.imul(h ^ (h >>> 16), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(weights, rand) {
  let r = rand();
  for (const [value, w] of weights) {
    if (r < w) return value;
    r -= w;
  }
  return weights[weights.length - 1][0];
}

// Real bookings: the latest snapshot saved by /api/admin/ingest.
// Demo numbers are only ever used when DEMO=1 is set (local runs), never on the live site.
// ----- demo helpers (local runs only) -----
function fakePid(text) {
  const rand = seeded('pid:' + text);
  let s = '';
  for (let i = 0; i < 16; i++) s += 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(rand() * 36)];
  return s;
}

// A made-up history for a made-up student (same pid always gives the same history)
export function demoHistoryRows(pid, today) {
  const rand = seeded('history:' + pid);
  const times = Object.keys(DEMAND);
  const n = 2 + Math.floor(rand() * 22);
  const rows = [];
  const used = new Set();
  for (let i = 0; i < n; i++) {
    const back = Math.floor(rand() * 21) - 2; // from 2 days ahead to 18 days back
    const date = addDays(today, -back);
    const time = times[Math.floor(rand() * times.length)];
    if (used.has(date + time)) continue;
    used.add(date + time);
    const future = date >= today;
    rows.push({
      date, time,
      status: future ? 'booked' : (rand() < 0.08 ? 'noshow' : rand() < 0.05 ? 'cancelled' : 'completed'),
      type: pick(TYPE_WEIGHTS, rand),
      zone: pick(ZONE_WEIGHTS, rand),
      spot: 1 + Math.floor(rand() * 14),
    });
  }
  return rows;
}

// Everyone in the demo (all the made-up names the sample classes use), with made-up phone numbers and gender
export function demoDirectory() {
  const out = [];
  [FIRST_F, FIRST_M].forEach((firsts, i) => firsts.forEach((f) => LAST.forEach((l) => {
    const name = f + ' ' + l;
    const rand = seeded('phone:' + name);
    out.push({ pid: fakePid(name), name, phone: ['3', '5', '6', '7'][Math.floor(rand() * 4)] + String(Math.floor(rand() * 1e7)).padStart(7, '0'), gender: i === 0 ? 'F' : 'M' });
  })));
  return out;
}

export async function getBookings(date, env) {
  if (env.DEMO === '1') return sampleBookings(date);
  if (!env.BOOKINGS) throw new Error('Bookings storage is not set up.');
  const saved = await env.BOOKINGS.get('day:' + date, 'json');
  if (!saved) return { date, source: 'live', updated: null, capacity: 50, zones: ZONES, classes: [], noData: true };
  // A snapshot is only rewritten when something changed, so "updated" is when the last sync that covered this day
  // looked at it (kept in meta:sync), not when the numbers last changed.
  let updated = saved.updated;
  const meta = await env.BOOKINGS.get('meta:sync', 'json');
  if (meta && meta.at && meta.from <= date && date <= meta.to && meta.at > updated) updated = meta.at;
  return { ...saved, updated, source: 'live', zones: ZONES };
}

async function sampleBookings(date) {
  const today = dohaToday();
  const daysAhead = Math.max(0, Math.round((Date.parse(date) - Date.parse(today)) / 86400000));
  const dayFactor = daysAhead === 0 ? 1 : Math.max(0.12, 1 - 0.2 * daysAhead);
  const dow = new Date(date + 'T00:00:00Z').getUTCDay();
  const nowMin = dohaMinutes();

  const slots = [
    ...MIXED[dow].map((time) => ({ time, kind: 'Mixed' })),
    ...LADIES[dow].map((time) => ({ time, kind: 'Ladies only' })),
  ].sort((a, b) => a.time.localeCompare(b.time) || a.kind.localeCompare(b.kind));

  const classes = slots.map((s) => {
    const rand = seeded(date + s.time + s.kind);
    const [hh, mm] = s.time.split(':').map(Number);
    const isPast = date < today || (date === today && hh * 60 + mm + 60 <= nowMin);
    const n = Math.min(CAPACITY, Math.round((DEMAND[s.time] || 0.4) * 22 * dayFactor * (0.4 + rand() * 1.1)));

    const used = { S: new Set(), C: new Set(), H: new Set() };
    const students = [];
    for (let i = 0; i < n; i++) {
      // choose a zone, falling back to one with room
      let zone = pick(ZONE_WEIGHTS, rand);
      const cap = (k) => ZONES.find((z) => z.key === k).capacity;
      if (used[zone].size >= cap(zone)) {
        zone = ZONES.map((z) => z.key).find((k) => used[k].size < cap(k));
        if (!zone) break;
      }
      let spot;
      do { spot = 1 + Math.floor(rand() * cap(zone)); } while (used[zone].has(spot));
      used[zone].add(spot);

      const type = pick(TYPE_WEIGHTS, rand);
      let gender = s.kind === 'Ladies only' || rand() < 0.58 ? 'F' : 'M';
      if (type === 'g8ts' && rand() < 0.2) gender = ''; // app bookings often have no gender on file
      const first = gender === 'M' ? FIRST_M : FIRST_F;
      const fullName = first[Math.floor(rand() * first.length)] + ' ' + LAST[Math.floor(rand() * LAST.length)];
      // a few made-up celebrations (own random stream, so the rest of the sample classes stay as they were)
      const spr = seeded('celebrate:' + date + s.time + s.kind + fullName);
      const bd = spr() < 0.05 ? true : undefined;
      const cn = spr() < 0.06 ? [10, 25, 50, 75, 100][Math.floor(spr() * 5)] : undefined;
      students.push({
        name: fullName,
        pid: fakePid(fullName),
        zone,
        spot,
        type,
        gender,
        status: isPast ? (rand() < 0.07 ? 'noshow' : 'completed') : 'enrolled',
        first: type === 'trial' && rand() < 0.5 ? true : undefined,
        bd,
        cn,
      });
    }
    students.sort((a, b) => ZONES.findIndex((z) => z.key === a.zone) - ZONES.findIndex((z) => z.key === b.zone) || a.spot - b.spot);
    return { id: date + 'T' + s.time + (s.kind === 'Ladies only' ? 'L' : 'M'), time: s.time, kind: s.kind, name: CLASS_NAME[dow], students };
  });

  return { date, source: 'sample', updated: new Date().toISOString(), capacity: CAPACITY, zones: ZONES, classes };
}
