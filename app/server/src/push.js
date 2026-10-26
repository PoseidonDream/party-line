/* Push notifications for people who don't have Party Line open: private messages, @mentions, calls and the
   like still reach their phone or computer (Web Push, in Chrome, Edge, Firefox, and Safari on iPhone after
   "Add to Home Screen"). The keys are made once and kept in the database, so a backup (and a restore onto a new
   server) keeps every browser's subscription working. Only the big browser push services are ever contacted,
   never an address someone typed in. */
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { one, all, run } from './db.js';
import { config } from './config.js';
import { UserError } from './model.js';

const parseKeys = (s) => { try { const k = JSON.parse(s); return k && k.publicKey && k.privateKey ? k : null; } catch { return null; } };
let keys = parseKeys((one("SELECT value FROM kv WHERE key = 'vapid'") || {}).value);
if (!keys) {
  // Servers from before keep the keys they made in the data folder (browsers subscribed with them).
  try { keys = parseKeys(fs.readFileSync(path.join(config.dataDir, 'vapid.json'), 'utf8')); } catch {}
  keys ||= webpush.generateVAPIDKeys();
  run("INSERT OR REPLACE INTO kv (key, value) VALUES ('vapid', ?)", JSON.stringify(keys));
}
webpush.setVapidDetails('https://github.com/PoseidonDream/party-line', keys.publicKey, keys.privateKey);
export const publicKey = () => keys.publicKey;

const PUSH_HOSTS = /^https:\/\/([a-z0-9-]+\.)*(fcm\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)\//i;
/* session: the sign-in it was made from (M.sessionKey), so signing that device out stops its notifications. */
export function subscribe(userId, sub, device, session) {
  const endpoint = String(sub && sub.endpoint || ''), p256dh = String(sub && sub.keys && sub.keys.p256dh || ''), auth = String(sub && sub.keys && sub.keys.auth || '');
  if (!(PUSH_HOSTS.test(endpoint) || (config.previewPrivate && /^https:\/\/127\.0\.0\.1:\d+\//.test(endpoint))) || endpoint.length > 1000) throw new UserError('That isn’t a browser push address.');
  if (!/^[\w-]{40,120}$/.test(p256dh) || !/^[\w-]{10,40}$/.test(auth)) throw new UserError('That isn’t a browser push address.');
  run('INSERT OR REPLACE INTO push_subs (endpoint, user_id, p256dh, auth, device, created_at, session) VALUES (?, ?, ?, ?, ?, ?, ?)',
    endpoint, userId, p256dh, auth, String(device || '').slice(0, 60), Date.now(), session || null);
  if (all('SELECT endpoint FROM push_subs WHERE user_id = ?', userId).length > 10) {
    run('DELETE FROM push_subs WHERE user_id = ? AND endpoint NOT IN (SELECT endpoint FROM push_subs WHERE user_id = ? ORDER BY created_at DESC LIMIT 10)', userId, userId);
  }
}
export const unsubscribe = (userId, endpoint) => run('DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?', userId, String(endpoint || ''));
export const hasPush = (userId) => !!one('SELECT 1 AS x FROM push_subs WHERE user_id = ?', userId);

/* payload: { title, body, url, tag }. Subscriptions the push service says are gone are forgotten. */
export function pushTo(userId, payload) {
  for (const s of all('SELECT * FROM push_subs WHERE user_id = ?', userId)) {
    webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 6 * 3600, urgency: 'high' })
      .catch((e) => { if (e && (e.statusCode === 404 || e.statusCode === 410)) run('DELETE FROM push_subs WHERE endpoint = ?', s.endpoint); });
  }
}
