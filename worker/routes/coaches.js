// GET  /api/admin/me        who is signed in (any signed-in person)
// GET  /api/admin/coaches   the coach list                       (owner only)
// POST /api/admin/coaches   { action: 'add', email, name? } or { action: 'remove', email }   (owner only)

import { readSession, json, sameOrigin } from '../lib/auth.js';
import { hasDb, listCoaches, addCoach, removeCoach, normEmail, validEmail } from '../lib/coaches.js';

export async function onRequestMe({ request, env }) {
  const s = await readSession(request, env);
  if (!s) return json({ error: 'Please sign in.' }, 401);
  if (s.kind === 'shared') return json({ kind: 'shared' });
  return json({ kind: 'coach', email: s.email, name: s.name, role: s.role });
}

const isOwner = (s) => !!s && s.kind === 'coach' && s.role === 'owner';

export async function onRequestGet({ request, env }) {
  const s = await readSession(request, env);
  if (!s) return json({ error: 'Please sign in.' }, 401);
  if (!isOwner(s)) return json({ error: 'Only the owner can manage coaches.' }, 403);
  if (!hasDb(env)) return json({ error: 'The coaches database is not connected.' }, 503);
  return json({ coaches: await listCoaches(env) });
}

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ error: 'Not allowed.' }, 403);
  const s = await readSession(request, env);
  if (!s) return json({ error: 'Please sign in.' }, 401);
  if (!isOwner(s)) return json({ error: 'Only the owner can manage coaches.' }, 403);
  if (!hasDb(env)) return json({ error: 'The coaches database is not connected.' }, 503);

  let body;
  try {
    const text = await request.text();
    if (text.length > 2000) throw new Error('too big');
    body = JSON.parse(text);
  } catch (e) {
    return json({ error: 'Bad request.' }, 400);
  }

  const action = body && body.action;
  const email = normEmail(body && body.email);
  if (!validEmail(email)) return json({ error: 'That does not look like an email address.' }, 400);

  if (action === 'add') {
    await addCoach(env, { email, name: body.name, addedBy: s.email });
  } else if (action === 'remove') {
    if (email === s.email) return json({ error: 'You cannot remove yourself.' }, 400);
    const done = await removeCoach(env, email);
    if (!done) return json({ error: 'That coach is not on the list (the owner cannot be removed).' }, 404);
  } else {
    return json({ error: 'Bad request.' }, 400);
  }
  return json({ ok: true, coaches: await listCoaches(env) });
}
