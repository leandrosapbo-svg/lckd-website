// The lckd.qa Worker. The website itself is static files (served straight from the assets);
// this script only answers the admin API under /api/admin/*.
//
//   POST /api/admin/login      single-user sign in
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

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

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
      return json({ error: 'Not found.' }, 404);
    } catch (e) {
      return json({ error: 'Something went wrong.' }, 500);
    }
  },
};
