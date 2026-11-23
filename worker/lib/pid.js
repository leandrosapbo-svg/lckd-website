// A student's public id on the admin page is NOT their G8TS PIN. It is a keyed hash of it, made here
// on the server, so the PIN never reaches a coach's phone and the ids cannot be guessed or reversed.
// (Changing SESSION_SECRET changes every id; saved histories would then need to be re-collected.)

const enc = new TextEncoder();

export async function makePid(env, pin) {
  const secret = String(env.SESSION_SECRET || env.INGEST_TOKEN || 'lckd');
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode('pid:' + String(pin))));
  let s = '';
  for (let i = 0; i < 12; i++) s += String.fromCharCode(sig[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); // 16 characters
}
