// Single-user login for the LCKD admin page (Cloudflare Pages Functions).
//
// Secrets (set in Cloudflare > Pages project > Settings > Variables and Secrets,
// or in .dev.vars for local runs):
//   ADMIN_USER           the one allowed username
//   ADMIN_PASSWORD_HASH  pbkdf2$<iterations>$<salt>$<hash>  (made by make-password-hash.mjs)
//   SESSION_SECRET       32+ random characters, signs the login cookie
// Changing SESSION_SECRET signs everybody out.

const enc = new TextEncoder();
const COOKIE = 'lckd_admin';
const SESSION_SECONDS = 14 * 24 * 3600; // stay signed in for 14 days

function b64uEncode(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64uDecode(str) {
  str = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function safeEqual(a, b) {
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

export function isConfigured(env) {
  return !!(env.ADMIN_USER && env.ADMIN_PASSWORD_HASH && env.SESSION_SECRET && String(env.SESSION_SECRET).length >= 32);
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

export async function sessionCookie(request, env) {
  const now = Math.floor(Date.now() / 1000);
  const payload = b64uEncode(enc.encode(JSON.stringify({ u: String(env.ADMIN_USER), iat: now, exp: now + SESSION_SECONDS })));
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

export async function readSession(request, env) {
  if (!isConfigured(env)) return null;
  const m = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)lckd_admin=([^;]+)/);
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(env.SESSION_SECRET, ['verify']), b64uDecode(sig), enc.encode(payload));
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(b64uDecode(payload)));
    if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
    if (String(data.u).toLowerCase() !== String(env.ADMIN_USER).toLowerCase()) return null;
    return data;
  } catch (e) {
    return null;
  }
}

// Refuse form posts coming from other websites.
export function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  return !origin || origin === new URL(request.url).origin;
}
