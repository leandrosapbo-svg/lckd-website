// Login for the LCKD admin page. Two ways in, both end in the same signed cookie:
//   1. "Sign in with Google" (routes/google.js): each coach has their own identity, listed in the D1 table `coaches`
//   2. the shared username + password (the original login; can be switched off with PASSWORD_LOGIN=off)
//
// Secrets / variables (Cloudflare > Worker > Settings > Variables and Secrets, or .dev.vars for local runs):
//   ADMIN_USER           the shared username
//   ADMIN_PASSWORD_HASH  pbkdf2$<iterations>$<salt>$<hash>  (made by make-password-hash.mjs)
//   SESSION_SECRET       32+ random characters, signs the login cookie
//   PASSWORD_LOGIN       "off" = only Google sign-in works
// Changing SESSION_SECRET signs everybody out (and would change every student's private id: never rotate it casually).

import { getCoach } from './coaches.js';

const enc = new TextEncoder();
const COOKIE = 'lckd_admin';
const SESSION_SECONDS = 14 * 24 * 3600; // stay signed in for 14 days

export function b64uEncode(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(str) {
  str = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

function hmacKey(secret, usages) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

export function hasSecret(env) {
  return !!(env.SESSION_SECRET && String(env.SESSION_SECRET).length >= 32);
}

// the shared username + password is set up
export function isConfigured(env) {
  return !!(env.ADMIN_USER && env.ADMIN_PASSWORD_HASH && hasSecret(env));
}

// the shared password may be used (PASSWORD_LOGIN=off turns it off once every coach has a Google sign-in)
export function passwordLoginOn(env) {
  return String(env.PASSWORD_LOGIN || '').trim().toLowerCase() !== 'off';
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex',
      ...headers,
    },
  });
}

// Username and password are both checked on every attempt, so timing does not reveal which one was wrong.
export async function checkLogin(env, username, password) {
  const parts = String(env.ADMIN_PASSWORD_HASH).split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = parseInt(parts[1], 10);
  const salt = b64uDecode(parts[2]);
  const want = b64uDecode(parts[3]);
  if (!(iterations > 0 && iterations <= 100000)) return false; // Workers cap PBKDF2 at 100,000
  const material = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const got = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, want.length * 8)
  );
  const passOk = safeEqual(got, want);
  const userOk = safeEqual(await sha256(username.trim().toLowerCase()), await sha256(String(env.ADMIN_USER).trim().toLowerCase()));
  return passOk && userOk;
}

// identity = { email, name } for a coach who signed in with Google; none = the shared password
export async function sessionCookie(request, env, identity) {
  const now = Math.floor(Date.now() / 1000);
  const body = identity
    ? { e: identity.email, n: String(identity.name || '').slice(0, 80), iat: now, exp: now + SESSION_SECONDS }
    : { u: String(env.ADMIN_USER), iat: now, exp: now + SESSION_SECONDS };
  const payload = b64uEncode(enc.encode(JSON.stringify(body)));
  const sig = b64uEncode(await crypto.subtle.sign('HMAC', await hmacKey(env.SESSION_SECRET, ['sign']), enc.encode(payload)));
  return cookieString(request, payload + '.' + sig, SESSION_SECONDS);
}

export function clearCookie(request) {
  return cookieString(request, '', 0);
}

function cookieString(request, value, maxAge) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  // Path limits the cookie to the admin API; HttpOnly keeps it away from page scripts.
  return `${COOKIE}=${value}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

// -> { kind: 'coach', email, name, role: 'owner'|'coach' }   a coach signed in with Google (still on the list)
//    { kind: 'shared' }                                         the shared password
//    null                                                       not signed in
export async function readSession(request, env) {
  if (!hasSecret(env)) return null;
  const m = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)lckd_admin=([^;]+)/);
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(env.SESSION_SECRET, ['verify']), b64uDecode(sig), enc.encode(payload));
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(b64uDecode(payload)));
    if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
    if (data.e) {
      // a Google sign-in: only valid while the coach is still on the list (taking someone off locks them out within seconds)
      const coach = await getCoach(env, data.e);
      if (!coach || !coach.active) return null;
      return { kind: 'coach', email: coach.email, name: coach.name || data.n || coach.email, role: coach.role };
    }
    if (!passwordLoginOn(env) || !isConfigured(env)) return null;
    if (String(data.u).toLowerCase() !== String(env.ADMIN_USER).toLowerCase()) return null;
    return { kind: 'shared' };
  } catch (e) {
    return null;
  }
}

// Refuse form posts coming from other websites.
export function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  return !origin || origin === new URL(request.url).origin;
}
