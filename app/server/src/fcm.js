/* Notifications for the Android app while it's closed, through Firebase Cloud Messaging (Google's push service for
   Android). The server signs in to Firebase with a service account (FIREBASE_SERVICE_ACCOUNT in deploy/.env: the
   account's JSON file, as is or base64), using only Node's own crypto: a short signed token (RS256 JWT) buys an
   access token for an hour, then each notification is one HTTPS request. Without the setting, it stays off. */
import crypto from 'node:crypto';

const TOKEN_URL = process.env.FIREBASE_TOKEN_URL || 'https://oauth2.googleapis.com/token';   // tests point these at a stand-in
const FCM_BASE = process.env.FCM_BASE_URL || 'https://fcm.googleapis.com';

function readAccount() {
  const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (!raw) return null;
  try {
    const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const a = JSON.parse(text);
    if (a.client_email && a.private_key && a.project_id) return a;
  } catch {}
  console.error('FIREBASE_SERVICE_ACCOUNT isn’t a readable service account file: Android notifications stay off.');
  return null;
}
const account = readAccount();
export const fcmReady = () => !!account;

const b64url = (b) => Buffer.from(b).toString('base64url');
let access = { token: null, until: 0 }, signingIn = null;
function accessToken() {
  if (access.token && Date.now() < access.until - 60_000) return Promise.resolve(access.token);
  // Many notifications at once (an @everyone) share one sign-in instead of each asking Google for a token.
  signingIn ||= signIn().finally(() => { signingIn = null; });
  return signingIn;
}
async function signIn() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${claims}`), account.private_key).toString('base64url');
  const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${sig}` }), signal: AbortSignal.timeout(10_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Firebase sign-in failed (${r.status}${j.error ? `: ${j.error}` : ''})`);
  access = { token: j.access_token, until: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return access.token;
}

/* Sends one notification to one phone. Resolves 'gone' when Firebase says the app was uninstalled or the address
   expired (the caller forgets it), true when sent. Data only, so the app always draws it itself (see PushService). */
export async function sendFcm(token, payload) {
  if (!account) return false;
  const data = {};
  for (const [k, v] of Object.entries(payload)) if (v != null) data[k] = String(v).slice(0, 1000);
  const r = await fetch(`${FCM_BASE}/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`, {
    method: 'POST', headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message: { token, data, android: { priority: 'high', ttl: '21600s' } } }), signal: AbortSignal.timeout(10_000),
  });
  if (r.ok) return true;
  const j = await r.json().catch(() => ({}));
  const why = JSON.stringify(j);
  // Only Firebase's explicit "unregistered" answer means the app was uninstalled: a 404 alone can also mean a wrong
  // project in the settings, and then the addresses must be kept for when the settings are fixed.
  if (/UNREGISTERED|registration-token-not-registered/.test(why)) return 'gone';
  if (r.status === 401) access = { token: null, until: 0 };   // sign in again next time
  throw new Error(`Firebase didn't take a notification (${r.status})`);
}
