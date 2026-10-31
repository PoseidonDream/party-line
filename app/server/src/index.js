/* Party Line server: the web app, a small JSON API, file uploads and the live WebSocket hub. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import express from 'express';
import { config } from './config.js';
import * as M from './model.js';
import { db } from './db.js';
import { mailReady, sendMail } from './mail.js';
import { proxyImage, signatureOk } from './preview.js';
import * as Push from './push.js';
import * as Gifs from './gifs.js';
import * as Usage from './usage.js';
import { attachHub, hub, voiceChannelOf, voiceCount } from './hub.js';

M.ensureDefaultServer();
M.syncAdmins();
const uploadDir = path.join(config.dataDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));

/* What pages may load and run: only this server's own scripts (plus YouTube's player, for watching together), so
   text slipped into a page can't run as code. The app can't be shown inside another site (which could trick
   clicks), and once it's on HTTPS, browsers stay on HTTPS. Uploads and link pictures set stricter rules of their own. */
const livekitOrigins = (() => { try { const o = new URL(config.livekit.url).origin; return [o, o.replace(/^ws/, 'http')]; } catch { return []; } })();
function contentPolicy(req) {
  // The Android app (Capacitor, in Android's WebView) adds its bridge to the page as an inline script.
  const inline = /; wv\)/.test(req.get('user-agent') || '') ? " 'unsafe-inline'" : '';
  const testEval = process.env.CSP_TEST_EVAL === '1' ? " 'unsafe-eval'" : '';   // tests only: the test tool's waitForFunction
  return [
    "default-src 'self'",
    `script-src 'self' https://www.youtube.com${inline}${testEval}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    ["connect-src 'self' https://api.github.com", ...livekitOrigins].join(' '),
    'frame-src https://www.youtube.com https://www.youtube-nocookie.com',
    "worker-src 'self' blob:",
    "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
  ].join('; ');
}
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', contentPolicy(req));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), midi=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});

/* Too many tries from one address (signing in, making accounts, password resets): slow down. */
const attempts = new Map();
function throttle(req, res, next) {
  const k = req.ip, t = Date.now();
  const a = (attempts.get(k) || []).filter((x) => t - x < 10 * 60_000);
  if (a.length >= 20) return res.status(429).json({ error: 'Too many tries. Wait a few minutes and try again.' });
  a.push(t); attempts.set(k, a);
  next();
}
setInterval(() => { const t = Date.now(); for (const [k, a] of attempts) if (!a.some((x) => t - x < 10 * 60_000)) attempts.delete(k); }, 10 * 60_000).unref();
const bearer = (req) => (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
function auth(req, res, next) {
  const u = M.userForToken(bearer(req));
  if (!u) return res.status(401).json({ error: 'Sign in again.' });
  req.user = u; next();
}
const wrap = (fn) => async (req, res) => {
  try { const r = await fn(req, res); if (r !== undefined) res.json(r); }
  catch (e) {
    if (e instanceof M.UserError) res.status(400).json({ error: e.message });
    else { console.error(e); res.status(500).json({ error: 'Something went wrong on the server.' }); }
  }
};

app.get('/api/info', wrap(() => ({ name: 'Party Line', version: 1, contact: config.contactEmail || null, mail: mailReady() })));
/* For the auto-updater on the server itself (deploy/auto-update.sh): how many people are in voice right now.
   Only answers requests from inside the machine; through Caddy the request comes from another address. */
app.get('/api/local/voice-count', (req, res) => {
  const ip = req.socket.remoteAddress || '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return res.status(404).end();
  res.json({ inVoice: voiceCount() });
});
app.post('/api/register', throttle, wrap((req) => {
  const { name, password, agree } = req.body || {};
  const r = M.register(name, password, agree);
  hub.userChanged(r.user);
  hub.joinedServers(r.user.id);
  return { token: r.token, user: M.publicUser(r.user) };
}));
app.post('/api/login', throttle, wrap((req) => {
  const b = req.body || {};
  const r = M.login(b.name, b.password, b.code, b.device);
  if (r.needCode) return { needCode: true };
  return { token: r.token, user: M.publicUser(r.user) };
}));
/* Forgot password: ask an admin to confirm, then poll until they answer. */
app.post('/api/reset-request', throttle, wrap((req) => {
  const b = req.body || {};
  const r = M.createResetRequest(b.name, b.newPassword, b.note, b.device);
  hub.resetRequested(r.request);
  return { id: r.id, secret: r.secret };
}));
/* Forgot password, for accounts with a confirmed email: a code goes there. The answer is the same either way, so
   nobody can find out which accounts have an email. The code and a new password then sign you in. */
app.post('/api/reset-email', throttle, wrap(async (req) => {
  if (!mailReady()) throw new M.UserError('Email isn’t set up on this server.');
  const r = M.startEmailReset((req.body || {}).name);
  if (r) await sendMail(r.email, `Your Party Line reset code: ${r.code}`, `Hi ${r.name},\n\nSomeone (hopefully you) asked to reset your Party Line password. Your code is: ${r.code}\n\nIt works for 15 minutes. If it wasn’t you, ignore this email: your password stays the same.`).catch(() => {});
  return { ok: true };
}));
app.post('/api/reset-email/confirm', throttle, wrap((req) => {
  const b = req.body || {};
  const r = M.finishEmailReset(b.name, b.code, b.newPassword, b.device);
  hub.closeSessions(r.user.id, r.ended);   // every other device goes back to the sign-in screen
  return { token: r.token, user: M.publicUser(r.user) };
}));
app.post('/api/reset-request/:id', wrap((req) => M.resetStatus(Number(req.params.id), (req.body || {}).secret)));
app.post('/api/logout', wrap((req) => { M.logout(bearer(req)); return { ok: true }; }));
/* Deleting your account from the web page (/delete-account), for people without the app: sign in there, then this. */
app.post('/api/account/delete', throttle, auth, wrap((req) => { hub.deleteAccount(req.user.id, (req.body || {}).password); return { ok: true }; }));
/* Changing your password signs out your other devices. */
app.post('/api/password', throttle, auth, wrap((req) => {
  const b = req.body || {};
  hub.closeSessions(req.user.id, M.changePassword(req.user.id, b.oldPassword, b.newPassword, M.sessionKey(bearer(req))));
  return { ok: true };
}));

/* ICE servers for voice. TURN passwords are short-lived and signed with TURN_SECRET (coturn "use-auth-secret"). */
app.get('/api/ice', auth, wrap((req) => {
  const ice = [{ urls: config.stunUrls }];
  if (config.turnUrls.length && config.turnSecret) {
    const username = `${Math.floor(Date.now() / 1000) + 24 * 3600}:${req.user.id}`;
    const credential = crypto.createHmac('sha1', config.turnSecret).update(username).digest('base64');
    ice.push({ urls: config.turnUrls, username, credential });
  }
  return { iceServers: ice, sfu: !!(config.livekit.url && config.livekit.secret) };
}));

/* A pass for the media server, valid for the voice channel you're in (LiveKit access token, HS256 JWT). */
const b64url = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
app.get('/api/voice-token', auth, wrap((req, res) => {
  const lk = config.livekit;
  if (!lk.url || !lk.secret) { res.status(404).json({ error: 'No media server is set up.' }); return undefined; }
  const channelId = Number(req.query.channelId);
  if (!channelId || voiceChannelOf(req.user.id) !== channelId) { res.status(403).json({ error: 'Join the voice channel first.' }); return undefined; }
  const t = Math.floor(Date.now() / 1000);
  const body = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({
    iss: lk.key, sub: String(req.user.id), name: req.user.name, nbf: t - 10, exp: t + 6 * 3600,
    video: { room: `party-line-${channelId}`, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false },
  })}`;
  const sig = crypto.createHmac('sha256', lk.secret).update(body).digest('base64url');
  return { url: lk.url, token: `${body}.${sig}` };
}));
app.get('/vendor/livekit-client.js', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'node_modules', 'livekit-client', 'dist', 'livekit-client.umd.js'));
});

/* A channel (text, or a voice channel's chat) in one of your servers, or null. */
const myChannel = (userId, id) => { const c = M.getChannel(Number(id)); return M.canOpenChannel(userId, c) ? c : null; };
app.get('/api/channels/:id/messages', auth, wrap((req) => {
  const c = myChannel(req.user.id, req.params.id);
  if (!c) return { messages: [] };
  return { messages: M.addMyVotes(M.history('channel_id', c.id, Number(req.query.before) || 0), req.user.id) };
}));
app.get('/api/dms/:userId/messages', auth, wrap((req) => {
  const d = M.dmWith(req.user.id, Number(req.params.userId), false);
  return { dmId: d ? d.id : null, messages: d ? M.addMyVotes(M.history('dm_id', d.id, Number(req.query.before) || 0), req.user.id) : [], seenId: d ? M.seenBy(d.id, Number(req.params.userId)) : 0 };
}));

/* Backups an admin can download from the developer panel, in the same format as deploy/backup.sh (so
   `backup.sh restore FILE` puts one back). The panel asks for a one-time link first, so the download can be a
   plain link the browser saves to disk however big it is, without a password in the address. */
const backupLinks = new Map();   // token -> expiry
app.post('/api/dev/backup-link', auth, wrap((req) => {
  if (!req.user.is_admin) throw new M.UserError('Admins only.');
  for (const [t, exp] of backupLinks) if (exp < Date.now()) backupLinks.delete(t);
  const token = crypto.randomBytes(24).toString('base64url');
  backupLinks.set(token, Date.now() + 2 * 60_000);
  return { url: `/api/dev/backup/${token}` };
}));
app.get('/api/dev/backup/:token', (req, res) => {
  const exp = backupLinks.get(req.params.token);
  backupLinks.delete(req.params.token);
  if (!exp || exp < Date.now()) return res.status(404).type('text').send('This backup link has expired. Press “Download a backup” again.');
  const dir = fs.mkdtempSync(path.join(config.dataDir, '.backup-'));
  const done = () => fs.rmSync(dir, { recursive: true, force: true });
  try { db.exec(`VACUUM INTO '${path.join(dir, 'snapshot.db').replace(/'/g, "''")}'`); } catch (e) { done(); console.error(e); return res.status(500).type('text').send('Couldn’t copy the database.'); }
  fs.mkdirSync(uploadDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  res.setHeader('content-type', 'application/gzip');
  res.setHeader('content-disposition', `attachment; filename="party-line-backup-${stamp}.tgz"`);
  const tar = spawn('tar', ['czf', '-', '-C', dir, 'snapshot.db', '-C', config.dataDir, 'uploads'], { stdio: ['ignore', 'pipe', 'ignore'] });
  tar.stdout.pipe(res);
  tar.on('close', done); tar.on('error', (e) => { done(); console.error(e); res.destroy(); });
  res.on('close', () => { if (tar.exitCode === null) tar.kill(); });
});

/* GIF search and sending (see gifs.js), limited per person so nobody uses up the group's Giphy allowance (each
   new GIF sent is a Giphy request and a download too). */
const perMinute = (limit, error) => {
  const times = new Map();   // userId -> times of recent requests
  return (req, res, next) => {
    const now = Date.now(), recent = (times.get(req.user.id) || []).filter((t) => now - t < 60_000);
    if (recent.length >= limit) return res.status(429).json({ error });
    recent.push(now); times.set(req.user.id, recent);
    next();
  };
};
app.get('/api/gifs', auth, perMinute(30, 'Slow down a little with the GIF searches.'), wrap((req) => { Usage.countOnce(req.user.id, 'gifs'); return Gifs.searchGifs(req.query.q); }));
app.post('/api/gifs/send', auth, perMinute(20, 'Slow down a little with the GIFs.'), wrap(async (req) => ({ uploadId: await Gifs.saveGif(req.user.id, (req.body || {}).id) })));

/* Push notifications (see push.js). */
app.get('/api/push/key', (req, res) => res.json({ key: Push.publicKey() }));
app.post('/api/push/subscribe', auth, wrap((req) => { Usage.countOnce(req.user.id, 'push', 86_400_000); Push.subscribe(req.user.id, req.body.subscription, req.body.device, M.sessionKey(bearer(req))); return { ok: true }; }));
app.post('/api/push/unsubscribe', auth, wrap((req) => { Push.unsubscribe(req.user.id, req.body.endpoint); return { ok: true }; }));

app.get('/api/bookmarks', auth, wrap((req) => { Usage.countOnce(req.user.id, 'bookmarks'); return { messages: M.bookmarksOf(req.user.id) }; }));
/* Media gallery for a channel (channelId) or a private chat (userId); see M.mediaOf. */
app.get('/api/media', auth, wrap((req) => {
  Usage.countOnce(req.user.id, 'gallery');
  if (req.query.channelId) {
    const c = myChannel(req.user.id, req.query.channelId);
    return c ? M.mediaOf('channel_id', c.id, req.query.before) : { items: [], before: null };
  }
  const d = M.dmWith(req.user.id, Number(req.query.userId), false);
  return d ? M.mediaOf('dm_id', d.id, req.query.before) : { items: [], before: null };
}));

/* Pinned messages in a channel (channelId) or a private chat (userId). */
app.get('/api/pins', auth, wrap((req) => {
  Usage.countOnce(req.user.id, 'pins');
  if (req.query.channelId) {
    const c = myChannel(req.user.id, req.query.channelId);
    return { messages: c ? M.pins('channel_id', c.id) : [] };
  }
  const d = M.dmWith(req.user.id, Number(req.query.userId), false);
  return { messages: d ? M.pins('dm_id', d.id) : [] };
}));

/* Search messages you can see: in one server (serverId), in your private chats (serverId=-1), or everywhere. */
app.get('/api/search', auth, wrap((req) => { Usage.countOnce(req.user.id, 'search'); return { messages: M.search(req.user.id, req.query.q, Number(req.query.serverId) || 0) }; }));

/* Uploads: the raw file is the request body. Photos, videos and audio are shown in the chat; any other file
   is offered as a download only, never opened in the page (an uploaded web page or SVG could run code). */
const IMAGE = /^image\/(png|jpeg|gif|webp|avif|bmp)$/;
const VIDEO = /^video\/(mp4|webm|quicktime|ogg|x-matroska)$/;
const AUDIO = /^audio\/(mpeg|ogg|wav|x-wav|webm|mp4|x-m4a|aac|flac)$/;
const playable = (t) => IMAGE.test(t) || VIDEO.test(t) || AUDIO.test(t);
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/ogg': 'ogv', 'video/x-matroska': 'mkv' };
function receive(req, res, max, okType, done) {
  let type = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type)) type = 'application/octet-stream';
  if (!okType(type)) return res.status(415).json({ error: 'Only photos can be used here.' });
  const len = Number(req.get('content-length') || 0);
  if (len > max) return res.status(413).json({ error: `That file is too big. The limit is ${Math.round(max / 1048576)} MB.` });
  let name;
  try { name = decodeURIComponent(String(req.get('x-file-name') || 'file')); } catch { name = 'file'; }
  name = name.replace(/[\u0000-\u001f\u007f/\\]/g, '').slice(0, 120) || 'file';
  const tmp = path.join(uploadDir, `.tmp-${crypto.randomBytes(8).toString('hex')}`);
  const out = fs.createWriteStream(tmp);
  let size = 0, aborted = false;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > max && !aborted) { aborted = true; req.unpipe(out); out.destroy(); fs.rm(tmp, () => {}); res.status(413).json({ error: 'That file is too big.' }); req.destroy(); }
  });
  req.pipe(out);
  out.on('finish', () => {
    if (aborted) return;
    const id = M.addUpload(req.user.id, name, type, size);
    fs.rename(tmp, path.join(uploadDir, id), (err) => {
      if (err) return res.status(500).json({ error: 'Could not save the file.' });
      done({ id, url: `/uploads/${id}`, name, type, size, ext: EXT[type] });
    });
  });
  out.on('error', () => { if (!aborted) res.status(500).json({ error: 'Could not save the file.' }); });
}
const uploadLimit = perMinute(60, 'That’s a lot of files at once. Wait a minute and try again.');
app.post('/api/upload', auth, uploadLimit, (req, res) => {
  const type = String(req.get('content-type') || '').toLowerCase();
  const max = VIDEO.test(type) ? config.maxVideo : IMAGE.test(type) ? config.maxImage : config.maxFile;
  receive(req, res, max, () => true, (f) => res.json(f));
});
app.post('/api/avatar', auth, uploadLimit, (req, res) => {
  receive(req, res, config.maxAvatar, (t) => IMAGE.test(t), (f) => {
    const u = M.setAvatar(req.user.id, f.url);
    hub.userChanged(u);
    res.json({ user: M.publicUser(u) });
  });
});
app.delete('/api/avatar', auth, wrap((req) => { const u = M.setAvatar(req.user.id, null); hub.userChanged(u); return { user: M.publicUser(u) }; }));
app.get('/uploads/:id', (req, res) => {
  const up = M.getUpload(String(req.params.id));
  if (!up) return res.status(404).end();
  const show = playable(up.type);
  res.setHeader('Content-Type', show ? up.type : 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; sandbox");
  res.setHeader('Content-Disposition', `${show ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(up.name)}`);
  res.sendFile(path.join(uploadDir, up.id), { acceptRanges: true });
});

/* Pictures for link previews, passed through so other sites don't see friends' addresses. */
app.get('/api/link-image', async (req, res) => {
  const url = String(req.query.u || '');
  if (!signatureOk(url, String(req.query.s || ''))) return res.status(403).end();
  try {
    const img = await proxyImage(url);
    res.setHeader('Content-Type', img.type);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.end(img.body);
  } catch { res.status(404).end(); }
});

/* The web app. Invite links (/invite/CODE) open the same page. */
app.use(express.static(config.webDir, { index: 'index.html', extensions: ['html'], setHeaders: (res, p) => {
  if (p.endsWith('.html') || p.endsWith('.js') || p.endsWith('.css')) res.setHeader('Cache-Control', 'no-cache');
} }));
app.get(['/invite/:code', '/app'], (req, res) => res.sendFile(path.join(config.webDir, 'index.html')));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
/* Broken or oversized requests get a short answer the app can show, not a web page with the server's insides. */
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That’s too big.' });
  if (err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: 'That request wasn’t readable.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

/* Hourly: delete photos and videos nothing uses any more, half-finished uploads, and sign-ins unused for months. */
function cleanUploads() {
  M.expireSessions();
  let n = 0;
  for (const id of M.unusedUploads()) { fs.rm(path.join(uploadDir, id), { force: true }, () => {}); M.forgetUpload(id); n++; }
  for (const f of fs.readdirSync(uploadDir)) {
    if (!f.startsWith('.tmp-')) continue;
    const p = path.join(uploadDir, f);
    try { if (Date.now() - fs.statSync(p).mtimeMs > 60 * 60_000) { fs.rmSync(p, { force: true }); n++; } } catch {}
  }
  if (n) console.log(`Cleaned up ${n} unused upload${n === 1 ? '' : 's'}.`);
}
setTimeout(cleanUploads, Number(process.env.CLEANUP_FIRST_MS) || 30_000).unref();
setInterval(cleanUploads, 60 * 60_000).unref();

const server = http.createServer(app);
attachHub(server);
server.listen(config.port, () => console.log(`Party Line server on http://localhost:${server.address().port} (data in ${config.dataDir})`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); process.exit(0); });
