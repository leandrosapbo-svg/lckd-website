import { clearCookie, json, sameOrigin } from '../lib/auth.js';

export async function onRequestPost({ request }) {
  if (!sameOrigin(request)) return json({ error: 'Not allowed.' }, 403);
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(request) });
}
