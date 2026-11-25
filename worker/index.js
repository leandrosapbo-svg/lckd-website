// The lckd.qa Worker. The website itself is static files (served straight from the assets);
// this script only answers the admin API under /api/admin/*.
//
//   POST /api/admin/login      the shared password sign in
//   GET  /api/admin/auth/options, /auth/google, /auth/google/callback   "Sign in with Google" (see routes/google.js)
//   GET  /api/admin/me         who is signed in
//   GET/POST /api/admin/coaches   the coach list (owner only)
//   GET/POST /api/admin/comments  coach notes about a student
//   POST /api/admin/logout
//   GET  /api/admin/bookings   ?date=YYYY-MM-DD  (needs the login cookie)
//   GET  /api/admin/student    ?pid=...          one student's history (needs the login cookie)
//   GET  /api/admin/search     ?q=name or phone  find students (needs the login cookie)
//   POST /api/admin/ingest     snapshot from the G8TS collector (needs the ingest token)

import { json } from './lib/auth.js';
import { onRequestPost as login } from './routes/login.js';
import { onRequestPost as logout } from './routes/logout.js';
import { onRequestGet as bookings } from './routes/bookings.js';
import { onRequest as ingest } from './routes/ingest.js';
import { onRequestGet as student } from './routes/student.js';
import { onRequestGet as search } from './routes/search.js';
import { onRequestOptions as authOptions, onRequestStart as googleStart, onRequestCallback as googleCallback } from './routes/google.js';
import { onRequestMe as me, onRequestGet as coachesGet, onRequestPost as coachesPost } from './routes/coaches.js';
import { onRequestGet as commentsGet, onRequestPost as commentsPost } from './routes/comments.js';
import { wrongAddressRedirect } from './lib/origin.js';

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    // The admin has one address (https://lckd.qa/admin): anyone who arrives by http:// or the workers.dev address is sent there
    const wrong = wrongAddressRedirect(request, env);
    if (wrong) return wrong;

    // Anything that is not the admin API is the normal website: serve it untouched.
    if (!pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    const c = { request, env, waitUntil: (p) => ctx.waitUntil(p) };
    try {
      if (pathname === '/api/admin/ingest') return await ingest(c);
      if (pathname === '/api/admin/login') return request.method === 'POST' ? await login(c) : json({ error: 'Method not allowed.' }, 405);
      if (pathname === '/api/admin/logout') return request.method === 'POST' ? await logout(c) : json({ error: 'Method not allowed.' }, 405);
      if (pathname === '/api/admin/bookings') return request.method === 'GET' ? await bookings(c) : json({ error: 'Method not allowed.' }, 405);
      if (pathname === '/api/admin/student') return request.method === 'GET' ? await student(c) : json({ error: 'Method not allowed.' }, 405);
      if (pathname === '/api/admin/search') return request.method === 'GET' ? await search(c) : json({ error: 'Method not allowed.' }, 405);
      if (pathname === '/api/admin/auth/options') return request.method === 'GET' ? authOptions(c) : json({ error: 'Method not allowed.' }, 405);
      if (pathname === '/api/admin/auth/google') return request.method === 'GET' ? await googleStart(c) : json({ error: 'Method not allowed.' }, 405);
      if (pathname === '/api/admin/auth/google/callback') return request.method === 'GET' ? await googleCallback(c) : json({ error: 'Method not allowed.' }, 405);
      if (pathname === '/api/admin/me') return request.method === 'GET' ? await me(c) : json({ error: 'Method not allowed.' }, 405);
      if (pathname === '/api/admin/comments') return request.method === 'GET' ? await commentsGet(c) : request.method === 'POST' ? await commentsPost(c) : json({ error: 'Method not allowed.' }, 405);
      if (pathname === '/api/admin/coaches') return request.method === 'GET' ? await coachesGet(c) : request.method === 'POST' ? await coachesPost(c) : json({ error: 'Method not allowed.' }, 405);
      return json({ error: 'Not found.' }, 404);
    } catch (e) {
      return json({ error: 'Something went wrong.' }, 500);
    }
  },
};
