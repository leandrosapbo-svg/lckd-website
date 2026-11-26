// Achievements for the student page: badges a member has really earned, worked out from their class history.
// Pure functions (rows in, badges out), so they can be tested without a server.
//
// rows  = the merged class history, any order: [{ date, time, status, type, zone, ... }] (see history.js)
// A badge is only ever returned when it has been earned, so a brand-new member simply has none (the page then
// shows no achievements section at all).

const DAY = 86400000;
const dayNum = (date) => Math.round(Date.parse(date + 'T00:00:00Z') / DAY);
const weekNum = (date) => { const n = dayNum(date); return Math.floor((n + 4) / 7); }; // weeks run Sunday to Saturday (1 Jan 1970 was a Thursday)
const byTime = (a, b) => (a.date + a.time).localeCompare(b.date + b.time);

// class count -> badge
const MILESTONES = [
  [1, '👟', 'First step', 'Finished their first class'],
  [5, '🖐️', 'High five', '5 classes done'],
  [10, '🔟', 'Double digits', '10 classes done'],
  [25, '🏅', 'Quarter century', '25 classes done'],
  [50, '🥇', 'Half century', '50 classes done'],
  [100, '🏆', 'Centurion', '100 classes done'],
  [250, '💎', '250 club', '250 classes done'],
  [500, '👑', '500 club', '500 classes done'],
];

// weeks in a row with at least one class -> badge (only the highest one reached is shown)
const STREAKS = [
  [2, 'Two weeks strong'],
  [4, 'A month locked in'],
  [8, 'Eight-week run'],
  [12, 'A quarter locked in'],
  [26, 'Half-year habit'],
  [52, 'A full year'],
];

const ZONES = ['S', 'C', 'H'];
const AWAY_DAYS = 10; // the same "long break" the sync uses for the Talk to these card

function earliest(dates) { return dates.length ? dates.slice().sort()[0] : null; }

export function achievementsFor(rows, plan, today) {
  const attended = (rows || []).filter((r) => r && r.status === 'completed' && r.date).slice().sort(byTime);
  const out = [];
  const add = (key, icon, title, text, date) => out.push({ key, icon, title, text, date: date || null });

  // 1. class milestones
  MILESTONES.forEach(([n, icon, title, text]) => {
    if (attended.length >= n) add('m' + n, icon, title, text, attended[n - 1].date);
  });

  // 2. weeks in a row
  if (attended.length) {
    const firstOfWeek = new Map(); // week number -> date of the first class they went to that week
    attended.forEach((r) => { const w = weekNum(r.date); if (!firstOfWeek.has(w)) firstOfWeek.set(w, r.date); });
    const weeks = [...firstOfWeek.keys()].sort((a, b) => a - b);
    let best = null; // { n: streak threshold, date }
    let runStart = 0;
    for (let i = 0; i < weeks.length; i++) {
      if (i > 0 && weeks[i] !== weeks[i - 1] + 1) runStart = i;
      const len = i - runStart + 1;
      STREAKS.forEach(([n, title], k) => {
        if (len < n) return;
        // the day that streak reached n weeks = the first class of its n-th week
        if (!best || k > best.k || (k === best.k && firstOfWeek.get(weeks[i]) < best.date)) best = { k, n, title, date: firstOfWeek.get(weeks[i]) };
      });
    }
    if (best) add('streak', '🔥', best.title, best.n + ' weeks in a row', best.date);
  }

  // 3. busy weeks: 3 classes in one week (hat trick), 5 (full week)
  {
    const perWeek = new Map();
    attended.forEach((r) => { const w = weekNum(r.date); (perWeek.get(w) || perWeek.set(w, []).get(w)).push(r.date); });
    let three = [], five = [];
    perWeek.forEach((dates) => { // dates are already oldest first
      if (dates.length >= 3) three.push(dates[2]);
      if (dates.length >= 5) five.push(dates[4]);
    });
    if (five.length) add('week5', '💥', 'Full week', '5 classes in one week', earliest(five));
    else if (three.length) add('week3', '🎯', 'Hat trick', '3 classes in one week', earliest(three));
  }

  // 4. two classes on one day / three days in a row
  {
    const perDay = new Map();
    attended.forEach((r) => perDay.set(r.date, (perDay.get(r.date) || 0) + 1));
    const doubles = [...perDay.keys()].filter((d) => perDay.get(d) >= 2);
    if (doubles.length) add('double', '✌️', 'Double up', 'Two classes in one day', earliest(doubles));

    const days = [...perDay.keys()].sort();
    const threeRow = [];
    for (let i = 2; i < days.length; i++) {
      if (dayNum(days[i]) - dayNum(days[i - 2]) === 2 && dayNum(days[i - 1]) - dayNum(days[i - 2]) === 1) threeRow.push(days[i]);
    }
    if (threeRow.length) add('row3', '🔗', 'Three in a row', 'Three days in a row', earliest(threeRow));

    // 5. back after a long break (the latest comeback)
    let comeback = null;
    for (let i = 1; i < days.length; i++) {
      const gap = dayNum(days[i]) - dayNum(days[i - 1]);
      if (gap >= AWAY_DAYS) comeback = { gap, date: days[i] };
    }
    if (comeback) add('comeback', '💪', 'Comeback', 'Back after ' + comeback.gap + ' days away', comeback.date);
  }

  // 6. early mornings and evenings
  {
    const early = attended.filter((r) => r.time && r.time < '08:00');
    if (early.length >= 3) add('early', '🌅', 'Early bird', early.length + ' classes before 8 am', early[2].date);
    const late = attended.filter((r) => r.time && r.time >= '19:00');
    if (late.length >= 3) add('late', '🦉', 'Night owl', late.length + ' evening classes', late[2].date);
  }

  // 7. every zone tried
  {
    const seen = new Set();
    let when = null;
    for (const r of attended) {
      if (ZONES.includes(r.zone)) seen.add(r.zone);
      if (seen.size === ZONES.length) { when = r.date; break; }
    }
    if (when) add('zones', '🧭', 'Zone hopper', 'Tried Strength, Cardio and Hybrid', when);
  }

  // 8. the same time slot again and again
  {
    const slots = new Map();
    attended.forEach((r) => { if (r.time) (slots.get(r.time) || slots.set(r.time, []).get(r.time)).push(r.date); });
    let top = null;
    slots.forEach((dates, time) => { if (dates.length >= 5 && (!top || dates.length > top.dates.length)) top = { time, dates }; });
    if (top) add('habit', '📌', 'Creature of habit', top.dates.length + ' classes at ' + top.time, top.dates[4]);
  }

  // 9. never missed a booking
  {
    const noShows = (rows || []).filter((r) => r && r.status === 'noshow').length;
    if (attended.length >= 10 && noShows === 0) add('reliable', '✅', 'Never a no-show', '10+ classes and not one missed', attended[9].date);
  }

  // 10. became a member: booked a class with a membership (the date), or holds one now (no date)
  {
    const withMembership = (rows || []).filter((r) => r && r.type === 'membership' && r.status !== 'cancelled' && r.date).map((r) => r.date);
    const holdsOne = (plan || []).some((p) => p && p.kind === 'membership');
    if (withMembership.length) add('member', '🔒', 'Locked in', 'Became a member', earliest(withMembership));
    else if (holdsOne) add('member', '🔒', 'Locked in', 'Became a member', null);
  }

  // newest first (badges without a date last); "fresh" = earned in the last 3 days, so the page can make it glow
  out.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  out.forEach((a) => { a.fresh = !!a.date && dayNum(today) - dayNum(a.date) <= 3 && dayNum(today) >= dayNum(a.date); });
  return out;
}

// Their birthday, from the days they were booked on one (the sync marks a booking with bd when that day is their birthday).
// dates = every such day we saw; returns the one that matters: today, else the nearest from 3 days ago to a week ahead, else null.
export function pickBirthday(dates, today) {
  let best = null;
  (dates || []).forEach((d) => {
    const diff = dayNum(d) - dayNum(today);
    if (diff < -3 || diff > 7) return;
    if (!best || Math.abs(diff) < Math.abs(dayNum(best) - dayNum(today)) || (Math.abs(diff) === Math.abs(dayNum(best) - dayNum(today)) && diff > 0)) best = d;
  });
  return best;
}
