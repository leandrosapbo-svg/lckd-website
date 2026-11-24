// Student search: by name or by phone number. Pure functions (no storage), so they are easy to test.
//
// A directory entry is { pid, name, phone, gender? }. prepare() adds the lowercase / digits-only forms used for matching.

const MAX_RESULTS = 20;

// "José  Al-Thani" -> "jose al thani": no accents, lowercase, punctuation becomes a space
export function foldName(s) {
  return String(s == null ? '' : s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Phone as digits only, without the 00 / + prefix and without Qatar's country code:
// "+974 5555 1234", "00974 55551234" and "5555 1234" are all "55551234".
export function phoneDigits(s) {
  let d = String(s == null ? '' : s).replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length > 8 && d.startsWith('974')) d = d.slice(3);
  return d;
}

// "55551234" -> "5555 1234"; anything else is shown as it was saved
export function phoneLabel(s) {
  const raw = String(s == null ? '' : s).trim();
  const d = phoneDigits(raw);
  if (d.length === 8 && /^[\d\s+()-]*$/.test(raw)) return d.slice(0, 4) + ' ' + d.slice(4);
  return raw;
}

export function prepare(e) {
  const nn = foldName(e.name);
  const ph = phoneDigits(e.phone);
  return { pid: e.pid, name: e.name, phone: e.phone || '', gender: e.gender === 'F' || e.gender === 'M' ? e.gender : '', nn, words: nn.split(' ').filter(Boolean), ph, full: ph.length === 8 ? '974' + ph : ph };
}

// What kind of search is this text?  'name' (has letters), 'phone' (3+ digits) or 'short' (not enough yet)
export function classify(query) {
  const raw = String(query == null ? '' : query).trim().slice(0, 60);
  if (/\p{L}/u.test(raw)) {
    const nn = foldName(raw);
    return nn.replace(/ /g, '').length >= 2 ? { kind: 'name', nn, tokens: nn.split(' ').filter(Boolean) } : { kind: 'short' };
  }
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  return d.length >= 3 ? { kind: 'phone', digits: d } : { kind: 'short' };
}

// list: prepared entries.  Returns { kind, results: [{pid,name,phone}], total }
export function search(list, query, limit) {
  const max = limit || MAX_RESULTS;
  const q = classify(query);
  if (q.kind === 'short') return { kind: 'short', results: [], total: 0 };

  const hits = [];
  if (q.kind === 'name') {
    for (const e of list) {
      if (!e.nn) continue;
      let score;
      if (e.nn === q.nn) score = 0;
      else if (e.nn.startsWith(q.nn)) score = 1;
      else if (q.tokens.every((t) => e.words.some((w) => w.startsWith(t)))) score = 2;
      else if (q.tokens.every((t) => e.nn.includes(t))) score = 3;
      else continue;
      hits.push({ e, score, key: e.nn });
    }
  } else {
    // a number typed with the country code (974...) is compared with it, otherwise only with the local digits,
    // so "4555" cannot match across the "974" and the first digits
    const withCode = q.digits.startsWith('974');
    for (const e of list) {
      if (!e.ph) continue;
      const hay = withCode ? e.full : e.ph;
      const at = hay.indexOf(q.digits);
      if (at < 0) continue;
      // exact number, then "starts with", then "ends with" (people often give the last digits), then anywhere
      const score = hay === q.digits ? 0 : at === 0 ? 1 : hay.endsWith(q.digits) ? 2 : 3;
      hits.push({ e, score, key: e.nn });
    }
  }
  hits.sort((a, b) => a.score - b.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    kind: q.kind,
    total: hits.length,
    results: hits.slice(0, max).map((h) => ({ pid: h.e.pid, name: h.e.name, phone: phoneLabel(h.e.phone) })),
  };
}
