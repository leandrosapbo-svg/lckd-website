// "Sign in with Google" for the coaches (OpenID Connect, authorization-code flow, done server side).
//
//   GET /api/admin/auth/options           what the login page may offer: { google, password }
//   GET /api/admin/auth/google            sends the browser to Google
//   GET /api/admin/auth/google/callback   Google sends the browser back here with a one-time code
//
// Variables (Cloudflare > Worker > Settings > Variables and Secrets):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   from Google Cloud > APIs & Services > Credentials (OAuth client, Web application)
//   OWNER_EMAIL                              the Google account that is always the owner (adds and removes coaches)
// Redirect URI registered at Google: https://lckd.qa/api/admin/auth/google/callback
//
// Only people on the `coaches` list get in; a Google account that is not on it is refused.

import { json, hasSecret, isConfigured, passwordLoginOn, sessionCookie, b64uEncode, b64uDecode, safeEqual } from '../lib/auth.js';
import { hasDb, getCoach, ensureOwner, touchCoach, normEmail } from '../lib/coaches.js';

const enc = new TextEncoder();
const STATE_COOKIE = 'lckd_oauth';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

// (the two URL overrides exist only so the local test setup can use a pretend Google; leave them unset in Cloudflare)
const authUrl = (env) => env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const tokenUrl = (env) => env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';

export function googleReady(env) {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && hasSecret(env) && hasDb(env));
}

function redirect(location, cookies) {
  const h = new Headers({ Location: location, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  (cookies || []).forEach((c) => h.append('Set-Cookie', c));
  return new Response(null, { status: 302, headers: h });
}

// The login page shows a message for ?signin=<code> (see admin.js)
const back = (code, cookies) => redirect('/admin/?signin=' + code, cookies);

const isHttps = (request) => new URL(request.url).protocol === 'https:';
function stateCookie(request, value, maxAge) {
  // Lax, not Strict: Google sends the browser back with a normal link click from another site, and Strict cookies are not sent then
  return `${STATE_COOKIE}=${value}; Path=/api/admin/auth; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(request) ? '; Secure' : ''}`;
}

function random(bytes) {
  return b64uEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

const redirectUri = (request) => new URL(request.url).origin + '/api/admin/auth/google/callback';

export function onRequestOptions({ env }) {
  return json({ google: googleReady(env), password: passwordLoginOn(env) && isConfigured(env) });
}

export async function onRequestStart({ request, env }) {
  if (!googleReady(env)) return back('notsetup');
  const state = random(18), nonce = random(18);
  const url = new URL(authUrl(env));
  url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri(request));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('prompt', 'select_account'); // lets a coach with several Google accounts pick the right one
  return redirect(url.toString(), [stateCookie(request, state + '.' + nonce, 600)]);
}

function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try { return JSON.parse(new TextDecoder().decode(b64uDecode(parts[1]))); } catch (e) { return null; }
}

// The ID token comes straight from Google's token endpoint over HTTPS in exchange for our one-time code, so Google's
// own documentation says its signature need not be checked again; what must be checked is who it is for and when.
// -> { email, name } or null
export function checkIdToken(claims, env, nonce, nowSeconds) {
  if (!claims || typeof claims !== 'object') return null;
  if (!GOOGLE_ISSUERS.includes(claims.iss)) return null;
  if (claims.aud !== env.GOOGLE_CLIENT_ID) return null;
  if (!(claims.exp > nowSeconds)) return null;
  if (!nonce || claims.nonce !== nonce) return null;
  if (!(claims.email_verified === true || claims.email_verified === 'true')) return null;
  const email = normEmail(claims.email);
  if (!email || !email.includes('@')) return null;
  const name = String(claims.name || '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 80);
  return { email, name };
}

export async function onRequestCallback({ request, env }, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const clear = stateCookie(request, '', 0);
  try {
    if (!googleReady(env)) return back('notsetup', [clear]);
    const url = new URL(request.url);
    if (url.searchParams.get('error')) return back('cancelled', [clear]);

    // the state in the link must be the one we put in the cookie when the sign-in started
    const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + STATE_COOKIE + '=([^;]+)'));
    const [cState, cNonce] = m ? m[1].split('.') : [];
    const state = url.searchParams.get('state') || '', code = url.searchParams.get('code') || '';
    if (!cState || !cNonce || !state || !code || !safeEqual(enc.encode(cState), enc.encode(state))) return back('expired', [clear]);

    const res = await doFetch(tokenUrl(env), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri(request), grant_type: 'authorization_code',
      }).toString(),
    });
    if (!res.ok) return back('failed', [clear]);
    const tok = await res.json();
    const who = checkIdToken(decodeJwtPayload(tok.id_token), env, cNonce, Math.floor(Date.now() / 1000));
    if (!who) return back('failed', [clear]);

    let coach = await getCoach(env, who.email, true);
    if (env.OWNER_EMAIL && normEmail(env.OWNER_EMAIL) === who.email) coach = await ensureOwner(env, who.email, who.name);
    if (!coach || !coach.active) return back('notallowed', [clear]);

    await touchCoach(env, who.email, who.name);
    return redirect('/admin/', [await sessionCookie(request, env, { email: who.email, name: who.name || coach.name }), clear]);
  } catch (e) {
    return back('failed', [clear]);
  }
}
