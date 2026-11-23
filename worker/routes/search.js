// GET /api/admin/search?q=...   (needs the login cookie)
// Finds students by name or phone number. Answers with their private id (pid), name and phone,
// which is all the page needs to open the student's history.

import { readSession, json } from '../lib/auth.js';
import { loadDirectory } from '../lib/directory.js';
import { search } from '../lib/search.js';

export async function onRequestGet({ request, env }) {
  if (!(await readSession(request, env))) return json({ error: 'Please sign in.' }, 401);

  const q = new URL(request.url).searchParams.get('q') || '';
  const list = await loadDirectory(env);
  if (!list.length) return json({ ready: false, kind: 'short', results: [], total: 0 });

  const out = search(list, q);
  return json({ ready: true, people: list.length, ...out });
}
