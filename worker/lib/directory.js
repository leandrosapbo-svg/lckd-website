// The student directory: everyone the sync add-on knows (name + phone), stored under private ids.
//
// It lives in KV as SHARDS small lists (dir:0 ... dir:7). The add-on knows which shard a person belongs to
// (their PIN modulo SHARDS), so it only re-sends the shards that changed. The PIN itself is never stored.

import { prepare } from './search.js';
import { demoDirectory } from './data.js';

export const SHARDS = 8;
const CACHE_MS = 60 * 1000;

let cached = { at: 0, list: null };

export function forgetDirectory() { cached = { at: 0, list: null }; }

// -> array of prepared entries (see search.js). Kept in memory for a minute, so typing in the search box
// does not read the storage on every keystroke.
export async function loadDirectory(env) {
  if (env.DEMO === '1') {
    if (!cached.list) cached = { at: Date.now(), list: demoDirectory().map(prepare) };
    return cached.list;
  }
  if (cached.list && Date.now() - cached.at < CACHE_MS) return cached.list;
  if (!env.BOOKINGS) throw new Error('Bookings storage is not set up.');
  const parts = await Promise.all(Array.from({ length: SHARDS }, (_, i) => env.BOOKINGS.get('dir:' + i, 'json')));
  const list = [];
  parts.forEach((part) => {
    if (!Array.isArray(part)) return;
    part.forEach((p) => { if (p && p.p && p.n) list.push(prepare({ pid: p.p, name: p.n, phone: p.t || '', gender: p.g || '' })); });
  });
  cached = { at: Date.now(), list };
  return list;
}

// 'F', 'M' or '' (not on file) for one student, from the search list. Costs up to SHARDS reads when the list
// is not in memory, so callers that are close to the 50-lookups-per-request limit must count them.
export async function genderFromDirectory(env, pid) {
  const list = await loadDirectory(env);
  const e = list.find((x) => x.pid === pid);
  return e ? e.gender : '';
}
