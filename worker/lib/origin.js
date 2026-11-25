// The admin lives at ONE address: https://lckd.qa/admin
//
// Google sign-in accepts exactly one return address (https://lckd.qa/api/admin/auth/google/callback, registered in
// Google Cloud), and the login cookie belongs to one host. If someone opens the admin through http://lckd.qa or the
// lckd-website.<account>.workers.dev address, the sign-in would send Google a different return address and fail with
// "Error 400: redirect_uri_mismatch". So such visitors are sent to the right address first, and the return address
// is never taken from the request.
//
// Optional variable PUBLIC_ORIGIN (e.g. https://lckd.qa) overrides the default; it must be a plain https origin.

const DEFAULT_ORIGIN = 'https://lckd.qa';

const isLocal = (hostname) => hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost');

// -> 'https://lckd.qa' (or the PUBLIC_ORIGIN). While testing on this computer (localhost) the address you are on.
export function canonicalOrigin(env, request) {
  const u = new URL(request.url);
  if (isLocal(u.hostname)) return u.origin;
  const set = String((env && env.PUBLIC_ORIGIN) || '').trim().replace(/\/+$/, '');
  return /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(set) ? set : DEFAULT_ORIGIN;
}

export function redirectUri(env, request) {
  return canonicalOrigin(env, request) + '/api/admin/auth/google/callback';
}

// A redirect Response when this request for an admin page (or the start of the Google sign-in) came in through the
// wrong address; otherwise null. Only plain page loads (GET / HEAD) are redirected.
export function wrongAddressRedirect(request, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const u = new URL(request.url);
  const p = u.pathname;
  if (!(p === '/admin' || p.startsWith('/admin/') || p === '/api/admin/auth/google')) return null;
  const want = canonicalOrigin(env, request);
  if (u.origin === want) return null;
  return new Response(null, { status: 302, headers: { Location: want + p + u.search, 'Cache-Control': 'no-store' } });
}
