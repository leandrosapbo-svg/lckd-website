// A student's history with LCKD: merges what G8TS knows about them (their profile: every class booked,
// collected by the sync add-on) with what we saved ourselves from the daily snapshots, then summarises it.

export function normStatus(s) {
  const t = String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!t) return '';
  if (t.startsWith('complet')) return 'completed';
  if (t.includes('noshow')) return 'noshow';
  if (t.includes('cancel')) return 'cancelled';
  return 'booked';
}

// profileRows: [{date,time,status,type,zone,spot}] from the G8TS profile (may be empty)
// savedRows:   same shape, found in our own day snapshots
export function mergeRows(profileRows, savedRows) {
  const map = new Map();
  (profileRows || []).forEach((r) => map.set(r.date + '|' + r.time, { ...r }));
  (savedRows || []).forEach((r) => {
    const k = r.date + '|' + r.time;
    const have = map.get(k);
    if (!have) { map.set(k, { ...r }); return; }
    // the snapshot knows how they booked and where they stood; the profile knows the final status
    if (!have.type) have.type = r.type;
    if (!have.zone) { have.zone = r.zone; have.spot = r.spot; }
    if (!have.status) have.status = r.status;
    if (r.kind) have.kind = r.kind;
  });
  return [...map.values()].sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
}

function top(counts, min) {
  let best = null;
  Object.keys(counts).forEach((k) => { if (counts[k] >= min && (best === null || counts[k] > counts[best])) best = k; });
  return best;
}

export function summarize(rows, today) {
  const live = rows.filter((r) => r.status !== 'cancelled');
  const attended = live.filter((r) => r.status === 'completed');
  const dates = live.map((r) => r.date).sort();
  const first = dates[0] || null;
  const lastVisit = attended.map((r) => r.date).sort().pop() || null;
  const weeks = first ? Math.max(1, (Date.parse(today) - Date.parse(first)) / (7 * 86400000)) : 1;

  const types = {}, zones = {}, times = {};
  live.forEach((r) => {
    if (r.type) types[r.type] = (types[r.type] || 0) + 1;
    if (r.zone) zones[r.zone] = (zones[r.zone] || 0) + 1;
    if (r.time) times[r.time] = (times[r.time] || 0) + 1;
  });

  return {
    firstClass: first,
    lastVisit,
    booked: live.length,
    attended: attended.length,
    noShows: live.filter((r) => r.status === 'noshow').length,
    cancelled: rows.length - live.length,
    upcoming: live.filter((r) => r.status === 'booked' && r.date >= today).length,
    perWeek: attended.length ? Math.round((attended.length / weeks) * 10) / 10 : 0,
    types,
    favZone: top(zones, 1),
    usualTime: top(times, 2),
  };
}
