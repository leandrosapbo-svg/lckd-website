import { isConfigured, checkLogin, sessionCookie, json, sameOrigin } from '../lib/auth.js';

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ error: 'Not allowed.' }, 403);
  if (!isConfigured(env)) return json({ error: 'Admin login is not set up yet.' }, 503);

  let body;
  try {
    const text = await request.text();
    if (text.length > 2000) throw new Error('too big');
    body = JSON.parse(text);
  } catch (e) {
    return json({ error: 'Bad request.' }, 400);
  }

  const username = String(body.username || '').slice(0, 100);
  const password = String(body.password || '').slice(0, 200);
  const ok = await checkLogin(env, username, password);
  if (!ok) {
    await new Promise((r) => setTimeout(r, 700)); // slows down guessing
    return json({ error: 'Wrong username or password.' }, 401);
  }
  return json({ ok: true }, 200, { 'Set-Cookie': await sessionCookie(request, env) });
}
