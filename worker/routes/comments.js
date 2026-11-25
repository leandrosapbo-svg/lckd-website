// Coach notes about a student.
//   GET  /api/admin/comments?pid=...   the notes + the categories to pick from      (any signed-in person)
//   POST /api/admin/comments           { action: 'add', pid, category, body }        (a coach signed in with Google)
//                                      { action: 'delete', pid, id }                 (the author, or the owner)
// Every answer carries the student's fresh list of notes.

import { readSession, json, sameOrigin } from '../lib/auth.js';
import { hasDb } from '../lib/coaches.js';
import { CATEGORIES, categoryKey, cleanBody, validPid, listComments, addComment, deleteComment } from '../lib/comments.js';

const notReady = () => json({ error: 'The notes database is not connected.' }, 503);

async function answer(env, session, pid, extra) {
  const comments = await listComments(env, pid, session.email, session.role === 'owner');
  return json({ ...(extra || {}), categories: CATEGORIES, comments, canWrite: session.kind === 'coach' });
}

export async function onRequestGet({ request, env }) {
  const s = await readSession(request, env);
  if (!s) return json({ error: 'Please sign in.' }, 401);
  const pid = new URL(request.url).searchParams.get('pid') || '';
  if (!validPid(pid)) return json({ error: 'Bad student.' }, 400);
  if (!hasDb(env)) return notReady();
  return answer(env, s, pid);
}

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ error: 'Not allowed.' }, 403);
  const s = await readSession(request, env);
  if (!s) return json({ error: 'Please sign in.' }, 401);
  if (s.kind !== 'coach') return json({ error: 'Sign in with Google to write notes under your name.' }, 403);
  if (!hasDb(env)) return notReady();

  let b;
  try {
    const text = await request.text();
    if (text.length > 10000) throw new Error('too big');
    b = JSON.parse(text);
  } catch (e) {
    return json({ error: 'Bad request.' }, 400);
  }
  if (!b || typeof b !== 'object' || !validPid(b.pid)) return json({ error: 'Bad student.' }, 400);

  if (b.action === 'add') {
    const category = categoryKey(b.category);
    const body = cleanBody(b.body);
    if (!category) return json({ error: 'Pick a category.' }, 400);
    if (!body) return json({ error: 'Write something first.' }, 400);
    await addComment(env, { pid: b.pid, category, body, authorEmail: s.email, authorName: s.name });
    return answer(env, s, b.pid, { ok: true });
  }

  if (b.action === 'delete') {
    const id = Number(b.id);
    if (!Number.isInteger(id) || id < 1) return json({ error: 'Bad note.' }, 400);
    const done = await deleteComment(env, { id, pid: b.pid, byEmail: s.email, isOwner: s.role === 'owner' });
    if (!done) return json({ error: 'You can only delete your own notes.' }, 403);
    return answer(env, s, b.pid, { ok: true });
  }

  return json({ error: 'Bad request.' }, 400);
}
