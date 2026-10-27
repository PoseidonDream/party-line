/* Everything the app stores, as plain functions over the database. No networking here. */
import crypto from 'node:crypto';
import { one, all, run, tx } from './db.js';
import { config } from './config.js';

export const now = () => Date.now();
export class UserError extends Error {}
const fail = (msg) => { throw new UserError(msg); };

/* ---------- names and passwords ---------- */
export const foldKey = (s) => String(s || '').toLowerCase().replace(/ı/g, 'i').normalize('NFKD')
  .replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const foldPass = (s) => foldKey(s).replace(/\s+/g, '');
export const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
export const cleanChannel = (s, kind) => {
  const t = String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 32);
  return kind === 'text' ? t.toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') : t;
};
const cleanBody = (s) => String(s || '').replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 4000);

function hashPass(pass) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pass), salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}
function checkPass(pass, stored) {
  const [s, h] = String(stored).split(':');
  if (!s || !h) return false;
  const got = crypto.scryptSync(String(pass), Buffer.from(s, 'hex'), 32);
  return crypto.timingSafeEqual(got, Buffer.from(h, 'hex'));
}
export function groupPasswordOk(pass) {
  if (!config.groupPassword) return true;
  const a = Buffer.from(foldPass(pass)), b = Buffer.from(foldPass(config.groupPassword));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');
const inviteCode = () => crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 8);

/* ---------- users and sessions ---------- */
export const publicUser = (u) => u && ({ id: u.id, name: u.name, avatar: u.avatar || null, admin: !!u.is_admin, bot: !!u.is_bot,
  custom: u.custom_status || null, bio: u.bio || null, banner: u.banner || null, birthday: u.birthday || null,
  flair: u.flair || null, bannerFx: u.banner_fx || null, favGames: u.fav_games ? JSON.parse(u.fav_games) : [], xp: u.xp || 0,
  streak: [dayKey(0), dayKey(-1)].includes(u.streak_day) ? u.streak : 0, badges: u.badges ? JSON.parse(u.badges) : {}, nameColor: u.name_color || null });
/* Today (offset 0), yesterday (-1)... on the server's clock, like birthdays: streaks count these days. */
export function dayKey(offset) {
  const d = new Date(Date.now() + offset * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/* Profile flair: an animated ring around your picture and an effect on your profile banner. Some are level rewards. */
export const FLAIRS = ['glow', 'rainbow', 'fire', 'ice', 'gold', 'galaxy', 'plasma'];
export const BANNER_FX = ['aurora', 'stars', 'scan', 'matrix'];
export const NAME_COLORS = ['#ff6b6b', '#ffa94d', '#ffd43b', '#8ce99a', '#66d9e8', '#74c0fc', '#b197fc', '#f783ac'];
/* The level each reward needs (the app shows the rest locked). At level 20 your name shimmers. */
export const UNLOCKS = { flair: { galaxy: 10, plasma: 15 }, bannerFx: { matrix: 10 }, nameColor: 5, legend: 20 };
const needLevel = (userId, lvl, what) => { if (levelOf(getUser(userId).xp) < lvl) fail(`Reach level ${lvl} to unlock ${what}.`); };
/* What only you see about yourself. */
export const selfView = (u) => Object.assign(publicUser(u), { status: u.status || 'online', newsSeen: u.news_seen, twoStep: !!u.totp_secret });
export const getUser = (id) => one('SELECT * FROM users WHERE id = ?', id);
export const userByName = (name) => one('SELECT * FROM users WHERE name_key = ?', foldKey(name));
const isAdminName = (name) => config.adminNames.some((n) => foldKey(n) === foldKey(name));

export function register(name, pass, groupPass) {
  name = cleanName(name);
  if (!groupPasswordOk(groupPass)) fail('That group password is wrong. Ask whoever invited you.');
  if (name.length < 2) fail('Pick a name with at least 2 characters.');
  if (foldKey(name) === foldKey(BOT_NAME)) fail('That name belongs to the bot. Pick another one.');
  if (String(pass || '').length < 4) fail('Pick a password with at least 4 characters.');
  if (userByName(name)) fail('That name is taken. If it’s yours, sign in instead.');
  // news_seen -1: a new account, which starts after the newest "What's new" note instead of seeing them all
  const id = Number(run('INSERT INTO users (name, name_key, pass_hash, is_admin, created_at, news_seen) VALUES (?, ?, ?, ?, ?, -1)',
    name, foldKey(name), hashPass(pass), isAdminName(name) ? 1 : 0, now()).lastInsertRowid);
  const def = one('SELECT id FROM servers WHERE is_default = 1');
  if (def) joinServer(id, def.id);
  return { user: getUser(id), token: newSession(id) };
}
export function login(name, pass, code, device) {
  const u = userByName(name);
  if (!u || !checkPass(pass, u.pass_hash)) fail('Wrong name or password.');
  if (u.totp_secret) {
    if (!code) return { needCode: true };
    if (!totpOk(u.totp_secret, code)) fail('That code is wrong or too old. Check the time on your phone and try the newest code.');
  }
  return { user: u, token: newSession(u.id, device) };
}

/* ---------- 2-step sign-in: a 6-digit code from an authenticator app (Google Authenticator, Authy, ...) ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32encode = (buf) => { let bits = '', out = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0'); for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)]; return out; };
const b32decode = (s) => { let bits = ''; for (const ch of s.replace(/=+$/, '')) bits += B32.indexOf(ch).toString(2).padStart(5, '0'); const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); };
function totpAt(secret, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}
const usedCodes = new Map();   // "userSecret:step" -> time, so a code can't be used twice
function totpOk(secret, code) {
  code = String(code || '').replace(/\D/g, '');
  if (code.length !== 6) return false;
  const step = Math.floor(Date.now() / 30000);
  for (const d of [0, -1, 1]) {
    const key = `${secret}:${step + d}`;
    if (!usedCodes.has(key) && crypto.timingSafeEqual(Buffer.from(totpAt(secret, step + d)), Buffer.from(code))) {
      usedCodes.set(key, Date.now());
      for (const [k, t] of usedCodes) if (Date.now() - t > 120_000) usedCodes.delete(k);
      return true;
    }
  }
  return false;
}
export function startTotp(userId) {
  const secret = b32encode(crypto.randomBytes(20));
  run('UPDATE users SET totp_pending = ? WHERE id = ?', secret, userId);
  return { secret, uri: `otpauth://totp/Party%20Line:${encodeURIComponent(getUser(userId).name)}?secret=${secret}&issuer=Party%20Line` };
}
export function confirmTotp(userId, code) {
  const u = getUser(userId);
  if (!u.totp_pending) fail('Start again: press “Turn on” first.');
  if (!totpOk(u.totp_pending, code)) fail('That code doesn’t match. Type the 6 digits your app shows right now.');
  run('UPDATE users SET totp_secret = totp_pending, totp_pending = NULL WHERE id = ?', userId);
}
export function stopTotp(userId, pass) {
  if (!checkPass(pass, getUser(userId).pass_hash)) fail('Your password is wrong.');
  run('UPDATE users SET totp_secret = NULL, totp_pending = NULL WHERE id = ?', userId);
}

/* ---------- devices you're signed in on ---------- */
export const sessionKey = (t) => sha(String(t || ''));
export const sessionsOf = (userId) => all('SELECT token_hash, device, created_at, last_seen FROM sessions WHERE user_id = ? ORDER BY last_seen DESC', userId)
  .map((s) => ({ id: s.token_hash.slice(0, 16), key: s.token_hash, device: s.device || 'Unknown device', createdAt: s.created_at, lastSeen: s.last_seen }));
export function setSessionDevice(key, device) { run('UPDATE sessions SET device = ? WHERE token_hash = ?', String(device || '').slice(0, 60) || null, key); }
/* Signing a device out also stops its push notifications (a lost phone shouldn't keep showing your messages). */
export function endSessions(userId, keys) {
  for (const k of keys) { run('DELETE FROM sessions WHERE user_id = ? AND token_hash = ?', userId, k); run('DELETE FROM push_subs WHERE user_id = ? AND session = ?', userId, k); }
  // Subscriptions from before sign-ins were recorded can't be told apart, so they go too. Devices still signed in
  // add theirs back (with their sign-in) the next time they start.
  if (keys.length) run('DELETE FROM push_subs WHERE user_id = ? AND session IS NULL', userId);
}
const signOutEverywhere = (userId) => { run('DELETE FROM sessions WHERE user_id = ?', userId); run('DELETE FROM push_subs WHERE user_id = ?', userId); };
function newSession(userId, device) {
  const t = token();
  run('INSERT INTO sessions (token_hash, user_id, created_at, last_seen, device) VALUES (?, ?, ?, ?, ?)', sha(t), userId, now(), now(), device ? String(device).slice(0, 60) : null);
  return t;
}
export function userForToken(t) {
  if (!t || typeof t !== 'string') return null;
  const s = one('SELECT * FROM sessions WHERE token_hash = ?', sha(t));
  if (!s) return null;
  if (now() - s.last_seen > 60_000) run('UPDATE sessions SET last_seen = ? WHERE token_hash = ?', now(), s.token_hash);
  return getUser(s.user_id);
}
export function logout(t) { const k = sha(String(t || '')); run('DELETE FROM sessions WHERE token_hash = ?', k); run('DELETE FROM push_subs WHERE session = ?', k); }
export function changePassword(userId, oldPass, newPass) {
  const u = getUser(userId);
  if (!checkPass(oldPass, u.pass_hash)) fail('Your current password is wrong.');
  if (String(newPass || '').length < 4) fail('Pick a password with at least 4 characters.');
  run('UPDATE users SET pass_hash = ? WHERE id = ?', hashPass(newPass), userId);
}
/* Admin reset: a new temporary password, and the person is signed out everywhere. */
const WORDS = ['amber', 'brass', 'comet', 'falcon', 'harbor', 'lantern', 'meteor', 'otter', 'pixel', 'radio', 'raven', 'signal', 'tiger', 'velvet'];
export function resetPassword(userId) {
  const pick = () => WORDS[crypto.randomInt(WORDS.length)];
  const temp = `${pick()}-${pick()}-${crypto.randomInt(100, 1000)}`;
  run('UPDATE users SET pass_hash = ?, totp_secret = NULL, totp_pending = NULL WHERE id = ?', hashPass(temp), userId);
  signOutEverywhere(userId);
  return temp;
}
/* Forgot password: the person picks a new password and asks; an admin confirms it's really them. The new
   password is stored only as a hash, so the admin never sees it. The requester's device holds a secret for
   the request and is signed in once it's approved. Requests expire after 24 hours. */
const RESET_TTL = 24 * 3600_000;
export function createResetRequest(name, newPass, note, device) {
  const u = userByName(name);
  if (!u || u.is_bot) fail('There’s no account with that name. Check the spelling.');
  if (String(newPass || '').length < 4) fail('Pick a new password with at least 4 characters.');
  run("UPDATE reset_requests SET state = 'replaced' WHERE user_id = ? AND state = 'pending'", u.id);
  const secret = token();
  const id = Number(run('INSERT INTO reset_requests (user_id, secret_hash, pass_hash, note, device, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    u.id, sha(secret), hashPass(newPass), String(note || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200) || null,
    String(device || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60) || null, now()).lastInsertRowid);
  return { id, secret, request: resetView(one('SELECT * FROM reset_requests WHERE id = ?', id)) };
}
const resetView = (r) => { const u = getUser(r.user_id); return { id: r.id, userId: r.user_id, name: u ? u.name : '?', note: r.note, device: r.device, at: r.created_at }; };
export const pendingResets = () => all("SELECT * FROM reset_requests WHERE state = 'pending' AND created_at > ? ORDER BY id", now() - RESET_TTL).map(resetView);
export function decideReset(id, adminId, approve) {
  const r = one('SELECT * FROM reset_requests WHERE id = ?', id);
  if (!r || r.state !== 'pending' || r.created_at < now() - RESET_TTL) fail('That request is no longer waiting.');
  if (approve) {
    run('UPDATE users SET pass_hash = ?, totp_secret = NULL, totp_pending = NULL WHERE id = ?', r.pass_hash, r.user_id);
    signOutEverywhere(r.user_id);
  }
  run('UPDATE reset_requests SET state = ?, decided_by = ?, decided_at = ? WHERE id = ?', approve ? 'approved' : 'denied', adminId, now(), id);
  return r;
}
/* What the requester's device sees while waiting. Approved: signs it in, once. */
export function resetStatus(id, secret) {
  const r = one('SELECT * FROM reset_requests WHERE id = ?', id);
  if (!r || typeof secret !== 'string' || sha(secret) !== r.secret_hash) fail('That request doesn’t exist.');
  if (r.state === 'pending' && r.created_at < now() - RESET_TTL) return { state: 'expired' };
  if (r.state === 'approved' && !r.consumed) {
    run('UPDATE reset_requests SET consumed = 1 WHERE id = ?', id);
    const u = getUser(r.user_id);
    return { state: 'approved', token: newSession(u.id), user: publicUser(u) };
  }
  return { state: r.state === 'approved' ? 'used' : r.state };
}
/* Notification settings per person, kept on the server so they follow you to every device.
   Targets: s:<server>, c:<channel>, d:<other person>. Levels: all, mentions, mute. */
export function notifyPrefs(userId) {
  const out = {};
  for (const r of all('SELECT target, level FROM notify_prefs WHERE user_id = ?', userId)) out[r.target] = r.level;
  return out;
}
export function setNotifyPref(userId, target, level) {
  if (!/^[scd]:\d+$/.test(String(target))) fail('Unknown chat.');
  if (level === null || level === '' || level === undefined) run('DELETE FROM notify_prefs WHERE user_id = ? AND target = ?', userId, target);
  else if (['all', 'mentions', 'mute'].includes(level)) run('INSERT INTO notify_prefs (user_id, target, level) VALUES (?, ?, ?) ON CONFLICT (user_id, target) DO UPDATE SET level = excluded.level', userId, target, level);
  else fail('Unknown setting.');
  return notifyPrefs(userId);
}
/* ---------- admin action log ---------- */
export function audit(actorId, serverId, action, details) {
  run('INSERT INTO audit (at, actor_id, server_id, action, details) VALUES (?, ?, ?, ?, ?)', now(), actorId, serverId || null, action, String(details || '').slice(0, 300));
  run('DELETE FROM audit WHERE id <= (SELECT MAX(id) FROM audit) - 2000');
}
export const auditLog = (limit = 300) => all('SELECT a.*, u.name AS actor, s.name AS server FROM audit a LEFT JOIN users u ON u.id = a.actor_id LEFT JOIN servers s ON s.id = a.server_id ORDER BY a.id DESC LIMIT ?', limit)
  .map((r) => ({ id: r.id, at: r.at, actorId: r.actor_id, actor: r.actor, server: r.server, action: r.action, details: r.details }));

/* ---------- invite links that expire or run out ---------- */
export function createInvite(serverId, creatorId, hours, maxUses) {
  if (all('SELECT code FROM invites WHERE server_id = ?', serverId).length >= 50) fail('This server has too many invite links. Remove some first.');
  const code = inviteCode();
  const h = Number(hours) || 0, uses = Number(maxUses) || 0;
  run('INSERT INTO invites (code, server_id, creator_id, expires_at, max_uses, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    code, serverId, creatorId, h > 0 ? now() + Math.min(h, 24 * 365) * 3600_000 : null, uses > 0 ? Math.min(uses, 1000) : null, now());
  return code;
}
export const invitesOf = (serverId) => all('SELECT * FROM invites WHERE server_id = ? AND (expires_at IS NULL OR expires_at > ?) AND (max_uses IS NULL OR uses < max_uses) ORDER BY created_at DESC', serverId, now())
  .map((r) => ({ code: r.code, creatorId: r.creator_id, expiresAt: r.expires_at, maxUses: r.max_uses, uses: r.uses }));
export const deleteInvite = (code) => run('DELETE FROM invites WHERE code = ?', code);
export const getInvite = (code) => one('SELECT * FROM invites WHERE code = ?', String(code || ''));
/* Which server an invite code opens: an expiring link (if still valid) or the server's permanent link. */
export function serverForInvite(code) {
  code = String(code || '').trim();
  const inv = getInvite(code);
  if (inv) {
    if ((inv.expires_at && inv.expires_at <= now()) || (inv.max_uses && inv.uses >= inv.max_uses)) fail('That invite has expired. Ask for a new one.');
    return { server: getServer(inv.server_id), invite: inv };
  }
  const s = serverByInvite(code);
  return s ? { server: s, invite: null } : null;
}
export const useInvite = (code) => run('UPDATE invites SET uses = uses + 1 WHERE code = ?', code);
export function resetServerInvite(serverId) { const code = inviteCode(); run('UPDATE servers SET invite = ? WHERE id = ?', code, serverId); return code; }

/* Read receipts: how far the other person in a private chat has read. */
export function seenBy(dmId, userId) {
  const r = one('SELECT last_id FROM reads WHERE user_id = ? AND target = ?', userId, `d:${dmId}`);
  return r ? r.last_id : 0;
}
export function rename(userId, name) {
  name = cleanName(name);
  if (name.length < 2) fail('Pick a name with at least 2 characters.');
  if (foldKey(name) === foldKey(BOT_NAME)) fail('That name belongs to the bot. Pick another one.');
  const other = userByName(name);
  if (other && other.id !== userId) fail('That name is taken.');
  run('UPDATE users SET name = ?, name_key = ? WHERE id = ?', name, foldKey(name), userId);
  return getUser(userId);
}
/* Status (online, idle, dnd, invisible), custom status line, About me and banner color. */
export const STATUSES = ['online', 'idle', 'dnd', 'invisible'];
export function setProfile(userId, d) {
  if (d.status !== undefined) { if (!STATUSES.includes(d.status)) fail('Unknown status.'); run('UPDATE users SET status = ? WHERE id = ?', d.status, userId); }
  if (d.custom !== undefined) run('UPDATE users SET custom_status = ? WHERE id = ?', String(d.custom || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) || null, userId);
  if (d.bio !== undefined) run('UPDATE users SET bio = ? WHERE id = ?', String(d.bio || '').replace(/\r\n/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f]/g, '').trim().slice(0, 300) || null, userId);
  if (d.birthday !== undefined) {
    // Month and day only (no year), e.g. 03-14
    const b = String(d.birthday || '');
    const m = /^(\d{2})-(\d{2})$/.exec(b);
    if (b && !(m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= new Date(2024, +m[1], 0).getDate())) fail('Pick a month and day.');
    run('UPDATE users SET birthday = ? WHERE id = ?', b || null, userId);
  }
  if (d.flair !== undefined) {
    if (d.flair && !FLAIRS.includes(d.flair)) fail('Pick one of the rings.');
    if (UNLOCKS.flair[d.flair]) needLevel(userId, UNLOCKS.flair[d.flair], `the ${d.flair[0].toUpperCase() + d.flair.slice(1)} ring`);
    run('UPDATE users SET flair = ? WHERE id = ?', d.flair || null, userId);
  }
  if (d.bannerFx !== undefined) {
    if (d.bannerFx && !BANNER_FX.includes(d.bannerFx)) fail('Pick one of the banner effects.');
    if (UNLOCKS.bannerFx[d.bannerFx]) needLevel(userId, UNLOCKS.bannerFx[d.bannerFx], `the ${d.bannerFx[0].toUpperCase() + d.bannerFx.slice(1)} banner`);
    run('UPDATE users SET banner_fx = ? WHERE id = ?', d.bannerFx || null, userId);
  }
  if (d.nameColor !== undefined) {
    if (d.nameColor && !NAME_COLORS.includes(d.nameColor)) fail('Pick one of the name colors.');
    if (d.nameColor) needLevel(userId, UNLOCKS.nameColor, 'name colors');
    run('UPDATE users SET name_color = ? WHERE id = ?', d.nameColor || null, userId);
  }
  if (d.favGames !== undefined) {
    const list = [...new Set((Array.isArray(d.favGames) ? d.favGames : String(d.favGames || '').split(','))
      .map((g) => String(g).replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40)).filter(Boolean))].slice(0, 5);
    run('UPDATE users SET fav_games = ? WHERE id = ?', list.length ? JSON.stringify(list) : null, userId);
  }
  if (d.newsSeen !== undefined) run('UPDATE users SET news_seen = ? WHERE id = ?', Math.max(0, Math.min(1e6, Math.floor(Number(d.newsSeen) || 0))), userId);
  if (d.banner !== undefined) {
    const c = String(d.banner || '');
    if (c && !/^#[0-9a-f]{6}$/i.test(c)) fail('Pick a color from the list.');
    run('UPDATE users SET banner = ? WHERE id = ?', c || null, userId);
  }
  return getUser(userId);
}
export const setAvatar = (userId, url) => { run('UPDATE users SET avatar = ? WHERE id = ?', url, userId); return getUser(userId); };
/* Party Bot's account. It can't sign in: no name anyone types matches its name_key, and it has no password. */
export const BOT_NAME = 'Party Bot';
export function ensureBot() {
  const b = one('SELECT * FROM users WHERE is_bot = 1');
  if (b) return b;
  // A leading space: folded names are trimmed, so no person's name_key can ever equal it.
  run("INSERT INTO users (name, name_key, pass_hash, is_admin, is_bot, created_at) VALUES (?, ' party-bot', '!', 0, 1, ?)", BOT_NAME, now());
  return one('SELECT * FROM users WHERE is_bot = 1');
}
export function syncAdmins() {
  for (const u of all('SELECT id, name, is_admin FROM users')) {
    const want = isAdminName(u.name) ? 1 : 0;
    if (want !== u.is_admin) run('UPDATE users SET is_admin = ? WHERE id = ?', want, u.id);
  }
}

/* ---------- servers and channels ---------- */
const DEFAULT_CHANNELS = [
  ['text', 'general'], ['text', 'clips-and-highlights'], ['text', 'game-night'],
  ['voice', 'Lobby'], ['voice', 'Gaming'],
];
export function createServer(ownerId, name, isDefault = false) {
  name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!name) fail('Give the server a name.');
  return tx(() => {
    const id = Number(run('INSERT INTO servers (name, owner_id, invite, is_default, created_at) VALUES (?, ?, ?, ?, ?)',
      name, ownerId, inviteCode(), isDefault ? 1 : 0, now()).lastInsertRowid);
    DEFAULT_CHANNELS.forEach(([kind, n], i) => run('INSERT INTO channels (server_id, kind, name, position, created_at) VALUES (?, ?, ?, ?, ?)', id, kind, n, i, now()));
    if (ownerId) joinServer(ownerId, id);
    return id;
  });
}
/* Group chats are small hidden servers (kind 'group') with one chat and one call room; a 1-on-1 call uses a
   hidden room for the two people (kind 'pair'). Neither shows in the server bar, and neither has invites. */
export function createGroup(ownerId, memberIds, name) {
  const others = [...new Set((memberIds || []).map(Number))].filter((id) => id !== ownerId);
  if (others.length < 2) fail('Pick at least two friends for a group chat.');
  if (others.length > 9) fail('Group chats can have up to 10 people.');
  for (const id of others) if (!getUser(id) || !canSeeUser(ownerId, id)) fail('You can only add people you know.');
  return tx(() => {
    const id = Number(run("INSERT INTO servers (name, owner_id, invite, is_default, created_at, kind) VALUES (?, ?, ?, 0, ?, 'group')",
      String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40), ownerId, inviteCode(), now()).lastInsertRowid);
    run("INSERT INTO channels (server_id, kind, name, position, created_at) VALUES (?, 'text', 'chat', 0, ?)", id, now());
    run("INSERT INTO channels (server_id, kind, name, position, created_at) VALUES (?, 'voice', 'Call', 1, ?)", id, now());
    for (const uid of [ownerId, ...others]) joinServer(uid, id);
    return id;
  });
}
export function pairRoom(a, b) {
  const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
  const found = one('SELECT id FROM servers WHERE pair_key = ?', key);
  if (found) return { id: found.id, created: false };
  return tx(() => {
    const id = Number(run("INSERT INTO servers (name, owner_id, invite, is_default, created_at, kind, pair_key) VALUES ('Call', NULL, ?, 0, ?, 'pair', ?)", inviteCode(), now(), key).lastInsertRowid);
    run("INSERT INTO channels (server_id, kind, name, position, created_at) VALUES (?, 'voice', 'Call', 0, ?)", id, now());
    joinServer(a, id); joinServer(b, id);
    return { id, created: true };
  });
}
export function ensureDefaultServer() {
  if (!one('SELECT id FROM servers WHERE is_default = 1')) createServer(null, 'Party Line', true);
}
export const getServer = (id) => one('SELECT * FROM servers WHERE id = ?', id);
export const serverByInvite = (code) => one('SELECT * FROM servers WHERE invite = ?', String(code || '').trim());
export const isMember = (userId, serverId) => !!one('SELECT 1 AS x FROM members WHERE server_id = ? AND user_id = ?', serverId, userId);
export const joinServer = (userId, serverId) => run('INSERT OR IGNORE INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)', serverId, userId, now());
export function leaveServer(userId, serverId) {
  run('DELETE FROM members WHERE server_id = ? AND user_id = ?', serverId, userId);
  run('DELETE FROM member_roles WHERE server_id = ? AND user_id = ?', serverId, userId);
}
export const memberIds = (serverId) => all('SELECT user_id FROM members WHERE server_id = ?', serverId).map((r) => r.user_id);
export const serverIdsOf = (userId) => all('SELECT server_id FROM members WHERE user_id = ?', userId).map((r) => r.server_id);
export const getChannel = (id) => one('SELECT * FROM channels WHERE id = ?', id);
export const deleteServer = (id) => run('DELETE FROM servers WHERE id = ?', id);
export const renameServer = (id, name) => run('UPDATE servers SET name = ? WHERE id = ?', name, id);
export function canManage(user, server) { return !!user.is_admin || (server && server.owner_id === user.id); }
/* Roles give members some of the owner's powers. The owner and global admins can always do everything. */
export const PERMS = { channels: 1, messages: 2, voice: 4, kick: 8, server: 16 };
export function can(user, server, perm) {
  if (!user || !server) return false;
  if (canManage(user, server)) return true;
  const r = one('SELECT COALESCE(SUM(DISTINCT r.perms & ?), 0) AS p FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.user_id = ? AND mr.server_id = ?', PERMS[perm], user.id, server.id);
  return !!r.p;
}
const permList = (bits) => Object.keys(PERMS).filter((k) => bits & PERMS[k]);
const permBits = (list) => (Array.isArray(list) ? list : []).reduce((a, k) => a | (Object.hasOwn(PERMS, k) ? PERMS[k] : 0), 0);
const cleanColor = (c) => (/^#[0-9a-f]{6}$/i.test(String(c || '')) ? String(c) : null);
export function createRole(serverId, d) {
  const name = String(d.name || '').replace(/\s+/g, ' ').trim().slice(0, 24);
  if (!name) fail('Give the role a name.');
  if (one('SELECT COUNT(*) AS n FROM roles WHERE server_id = ?', serverId).n >= 20) fail('A server can have up to 20 roles.');
  const pos = (one('SELECT MAX(position) AS p FROM roles WHERE server_id = ?', serverId).p ?? -1) + 1;
  return Number(run('INSERT INTO roles (server_id, name, color, position, perms) VALUES (?, ?, ?, ?, ?)', serverId, name, cleanColor(d.color), pos, permBits(d.perms)).lastInsertRowid);
}
export const getRole = (id) => one('SELECT * FROM roles WHERE id = ?', id);
export function editRole(id, d) {
  const r = getRole(id);
  const name = d.name !== undefined ? String(d.name || '').replace(/\s+/g, ' ').trim().slice(0, 24) : r.name;
  if (!name) fail('Give the role a name.');
  run('UPDATE roles SET name = ?, color = ?, perms = ? WHERE id = ?', name, d.color !== undefined ? cleanColor(d.color) : r.color, d.perms !== undefined ? permBits(d.perms) : r.perms, id);
}
export const deleteRole = (id) => run('DELETE FROM roles WHERE id = ?', id);
export function assignRole(serverId, userId, roleId, on) {
  if (!isMember(userId, serverId)) fail('They’re not in this server.');
  if (on) run('INSERT OR IGNORE INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)', serverId, userId, roleId);
  else run('DELETE FROM member_roles WHERE user_id = ? AND role_id = ?', userId, roleId);
}

/* ---------- categories, topics and channel order ---------- */
export function createCategory(serverId, name) {
  name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 32);
  if (!name) fail('Give the category a name.');
  if (one('SELECT COUNT(*) AS n FROM categories WHERE server_id = ?', serverId).n >= 20) fail('A server can have up to 20 categories.');
  const pos = (one('SELECT MAX(position) AS p FROM categories WHERE server_id = ?', serverId).p ?? -1) + 1;
  return Number(run('INSERT INTO categories (server_id, name, position) VALUES (?, ?, ?)', serverId, name, pos).lastInsertRowid);
}
export const getCategory = (id) => one('SELECT * FROM categories WHERE id = ?', id);
export function renameCategory(id, name) {
  name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 32);
  if (!name) fail('Give the category a name.');
  run('UPDATE categories SET name = ? WHERE id = ?', name, id);
}
export function deleteCategory(id) {
  run('UPDATE channels SET category_id = NULL WHERE category_id = ?', id);
  run('DELETE FROM categories WHERE id = ?', id);
}
export function editChannel(id, d) {
  const ch = getChannel(id);
  if (d.name !== undefined) { const name = cleanChannel(d.name, ch.kind); if (!name) fail('Give the channel a name.'); run('UPDATE channels SET name = ? WHERE id = ?', name, id); }
  if (d.topic !== undefined) run('UPDATE channels SET topic = ? WHERE id = ?', String(d.topic || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200) || null, id);
}
/* Moves a channel before another one (or to the end) and into a category (or none). */
export function moveChannel(id, categoryId, beforeId) {
  const ch = getChannel(id);
  const cat = categoryId ? getCategory(Number(categoryId)) : null;
  if (categoryId && (!cat || cat.server_id !== ch.server_id)) fail('That category is gone.');
  const list = all('SELECT id FROM channels WHERE server_id = ? AND id != ? ORDER BY position, id', ch.server_id, id).map((r) => r.id);
  const at = beforeId ? list.indexOf(Number(beforeId)) : -1;
  list.splice(at < 0 ? list.length : at, 0, id);
  tx(() => {
    list.forEach((cid, i) => run('UPDATE channels SET position = ? WHERE id = ?', i, cid));
    run('UPDATE channels SET category_id = ? WHERE id = ?', cat ? cat.id : null, id);
  });
}

export function createChannel(serverId, kind, name) {
  if (kind !== 'text' && kind !== 'voice') fail('Unknown channel type.');
  name = cleanChannel(name, kind);
  if (!name) fail('Give the channel a name.');
  const count = one('SELECT COUNT(*) AS n FROM channels WHERE server_id = ?', serverId).n;
  if (count >= 60) fail('This server has too many channels.');
  const pos = (one('SELECT MAX(position) AS p FROM channels WHERE server_id = ?', serverId).p ?? -1) + 1;
  const id = Number(run('INSERT INTO channels (server_id, kind, name, position, created_at) VALUES (?, ?, ?, ?, ?)', serverId, kind, name, pos, now()).lastInsertRowid);
  return getChannel(id);
}
export const deleteChannel = (id) => run('DELETE FROM channels WHERE id = ?', id);
const publicChannel = (c) => ({ id: c.id, serverId: c.server_id, kind: c.kind, name: c.name, position: c.position, topic: c.topic || '', categoryId: c.category_id || null });

export function serverView(serverId, viewerId) {
  const s = getServer(serverId);
  if (!s) return null;
  const channels = all('SELECT * FROM channels WHERE server_id = ? ORDER BY position, id', serverId).map(publicChannel);
  for (const c of channels) {   // voice channels have a chat too
    const last = one('SELECT id, created_at FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT 1', c.id);   // newest is the last id: an index lookup
    c.lastId = last ? last.id : 0; c.lastAt = last ? last.created_at : 0;
    c.unread = unreadCount(viewerId, `c:${c.id}`, 'channel_id', c.id);
    c.mentions = c.unread ? mentionCount(viewerId, `c:${c.id}`, c.id) : 0;
  }
  const roles = all('SELECT * FROM roles WHERE server_id = ? ORDER BY position, id', serverId).map((r) => ({ id: r.id, name: r.name, color: r.color, position: r.position, perms: permList(r.perms) }));
  const memberRoles = {};
  for (const r of all('SELECT user_id, role_id FROM member_roles WHERE server_id = ?', serverId)) (memberRoles[r.user_id] ||= []).push(r.role_id);
  const categories = all('SELECT id, name, position FROM categories WHERE server_id = ? ORDER BY position, id', serverId);
  const afk = channels.some((c) => c.id === s.afk_channel_id && c.kind === 'voice') ? s.afk_channel_id : null;
  return { disappear: s.disappear || 0, id: s.id, kind: s.kind || 'server', name: s.name, ownerId: s.owner_id, invite: s.invite, isDefault: !!s.is_default, channels, members: memberIds(serverId), roles, memberRoles, categories, afkChannelId: afk };
}

/* ---------- XP and levels: one total per person for the whole app ----------
   10 XP for chatting anywhere (at most once a minute), 5 XP a minute in voice with someone else (see hub.js).
   Level n needs 30 * n² XP: level 1 after 3 messages, level 5 at 750, level 10 at 3000. */
const XP_GAP = Number(process.env.XP_GAP_MS) || 60_000;
export const levelOf = (xp) => Math.floor(Math.sqrt(xp / 30));
/* Returns the new total and the level reached (0 if no new level), or null if nothing was added. */
export function addXp(userId, amount, fromMessage) {
  const u = getUser(userId);
  if (!u || u.is_bot) return null;
  if (fromMessage && now() - u.xp_msg_at < XP_GAP) return null;
  const xp = u.xp + amount;
  run('UPDATE users SET xp = ?, xp_msg_at = ? WHERE id = ?', xp, fromMessage ? now() : u.xp_msg_at, userId);
  return { xp, up: levelOf(xp) > levelOf(u.xp) ? levelOf(xp) : 0 };
}
/* Place among everyone in the app (1 = the most XP). */
export const xpRank = (xp) => one('SELECT COUNT(*) AS n FROM users WHERE is_bot = 0 AND xp > ?', xp).n + 1;

/* ---------- hall of fame: messages that got enough ⭐ are copied (by Party Bot) into #hall-of-fame ---------- */
export const inHallOfFame = (messageId) => !!one('SELECT 1 AS x FROM hall_of_fame WHERE message_id = ?', messageId);
export const hallOfFameCopy = (messageId) => one('SELECT m.* FROM hall_of_fame h JOIN messages m ON m.id = h.post_id WHERE h.message_id = ?', messageId);
export const addHallOfFame = (messageId, postId) => run('INSERT OR IGNORE INTO hall_of_fame (message_id, post_id) VALUES (?, ?)', messageId, postId);
export const clipsChannel = (serverId) => one("SELECT * FROM channels WHERE server_id = ? AND kind = 'text' AND name LIKE '%clip%' ORDER BY position, id LIMIT 1", serverId);
export const textChannelNamed = (serverId, name) => one("SELECT * FROM channels WHERE server_id = ? AND kind = 'text' AND name = ?", serverId, name);
/* A message by Party Bot carrying another message's files (the files stay as long as any message uses them). */
export function postCopy(botId, where, body, attachments) {
  const id = Number(run('INSERT INTO messages (channel_id, dm_id, user_id, body, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    where.channelId || null, where.dmId || null, botId, cleanBody(body), attachments || null, now()).lastInsertRowid);
  return publicMessage(getMessage(id));
}

/* ---------- looking for group: "Need 2 for Valorant at 21:00", posted as a message <lfg:id> people can join ---------- */
export const getLfg = (id) => one('SELECT * FROM lfg WHERE id = ?', id);
const oneLine = (t, max) => String(t || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
export function createLfg(userId, d) {
  const game = oneLine(d.game, 40);
  if (!game) fail('Which game?');
  const need = Math.floor(Number(d.need));
  if (!(need >= 1 && need <= 9)) fail('Pick how many more people you need (1 to 9).');
  const at = d.at ? Number(d.at) : null;
  if (at !== null && (!Number.isFinite(at) || at < now() - 60_000 || at > now() + 7 * 86_400_000)) fail('Pick a time in the next 7 days.');
  return Number(run('INSERT INTO lfg (created_by, game, need, at, note, created_at) VALUES (?, ?, ?, ?, ?, ?)', userId, game, need, at, oneLine(d.note, 120) || null, now()).lastInsertRowid);
}
/* A post closes when its maker (or a moderator) closes it, or by itself 3 hours after its time (12 hours after it was
   posted if it had no time). Full groups stay open, so someone can still leave and make room. */
export function lfgView(id) {
  const l = getLfg(id);
  if (!l) return null;
  const members = all('SELECT user_id FROM lfg_members WHERE lfg_id = ? ORDER BY joined_at', id).map((r) => r.user_id);
  const expired = now() > (l.at ? l.at + 3 * 3600_000 : l.created_at + 12 * 3600_000);
  return { id: l.id, game: l.game, need: l.need, at: l.at, note: l.note, by: l.created_by, members, full: members.length >= l.need, closed: !!l.closed || expired, expired };
}
export function joinLfg(id, userId, on) {
  const v = lfgView(id);
  if (!v) fail('That group is gone.');
  if (v.closed) fail('This group is closed.');
  if (userId === v.by) fail('It’s your own group.');
  if (on && v.full && !v.members.includes(userId)) fail('The group is full.');
  if (on) run('INSERT OR IGNORE INTO lfg_members (lfg_id, user_id, joined_at) VALUES (?, ?, ?)', id, userId, now());
  else run('DELETE FROM lfg_members WHERE lfg_id = ? AND user_id = ?', id, userId);
  return lfgView(id);
}
export const closeLfg = (id) => run('UPDATE lfg SET closed = 1 WHERE id = ?', id);
/* Open group posts in these servers (for the Home dashboard), newest first. */
export function openLfgs(serverIds) {
  if (!serverIds.length) return [];
  return all(`SELECT l.id, m.id AS message_id, m.channel_id FROM lfg l JOIN messages m ON m.id = l.message_id JOIN channels c ON c.id = m.channel_id
    WHERE l.closed = 0 AND l.created_at > ? AND c.server_id IN (${serverIds.map(() => '?').join(',')}) ORDER BY l.created_at DESC LIMIT 20`, now() - 8 * 86_400_000, ...serverIds)
    .map((r) => Object.assign(lfgView(r.id), { messageId: r.message_id, channelId: r.channel_id })).filter((v) => !v.closed);
}

/* ---------- messages ---------- */
function attachmentsFrom(userId, list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list.slice(0, 10)) {
    const id = String(a && a.id || '');
    const up = one('SELECT * FROM uploads WHERE id = ? AND user_id = ?', id, userId);
    if (!up) continue;
    const item = { id: up.id, url: `/uploads/${up.id}`, name: up.name, type: up.type, size: up.size };
    // A small preview made by the sender's device, shown in the chat to save mobile data.
    const th = a.thumb && one("SELECT * FROM uploads WHERE id = ? AND user_id = ? AND type LIKE 'image/%'", String(a.thumb), userId);
    if (th && up.type.startsWith('image/')) { item.thumb = th.id; item.thumbUrl = `/uploads/${th.id}`; }
    out.push(item);
  }
  return out;
}
const basicMessage = (m) => ({
  id: m.id, channelId: m.channel_id, dmId: m.dm_id, userId: m.user_id, body: m.body,
  attachments: m.attachments ? JSON.parse(m.attachments) : [], at: m.created_at, editedAt: m.edited_at,
  replyTo: m.reply_to || null, reply: null, reactions: [], pinned: m.pinned_at ? { at: m.pinned_at, by: m.pinned_by } : null,
  embeds: m.embeds ? JSON.parse(m.embeds) : [], expiresAt: m.expires_at || null,
});
const placeholders = (n) => Array(n).fill('?').join(',');
/* Adds each message's reactions and a short preview of the message it replies to. */
function decorate(rows) {
  const out = rows.map(basicMessage);
  if (!out.length) return out;
  const byId = new Map(out.map((m) => [m.id, m]));
  for (const r of all(`SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN (${placeholders(out.length)}) ORDER BY created_at`, ...out.map((m) => m.id))) {
    const msg = byId.get(r.message_id);
    let e = msg.reactions.find((x) => x.emoji === r.emoji);
    if (!e) { e = { emoji: r.emoji, users: [] }; msg.reactions.push(e); }
    e.users.push(r.user_id);
  }
  for (const m of out) {
    const pl = /^<poll:(\d+)>$/.exec(m.body || ''), lg = /^<lfg:(\d+)>$/.exec(m.body || '');
    if (pl) m.poll = pollView(Number(pl[1]));
    if (lg) m.lfg = lfgView(Number(lg[1]));
  }
  const replyIds = [...new Set(out.filter((m) => m.replyTo).map((m) => m.replyTo))];
  if (replyIds.length) {
    const found = new Map(all(`SELECT id, user_id, body, attachments FROM messages WHERE id IN (${placeholders(replyIds.length)})`, ...replyIds).map((r) => [r.id, r]));
    for (const m of out) {
      if (!m.replyTo) continue;
      const r = found.get(m.replyTo);
      m.reply = r ? { id: r.id, userId: r.user_id, body: r.body.slice(0, 140), hasMedia: !!r.attachments } : { id: m.replyTo, deleted: true };
    }
  }
  return out;
}
export const publicMessage = (m) => m && decorate([m])[0];
/* A message that is only <g:upload> (a saved GIF) or <s:id> (a sticker) must point at a real one. Checked for new
   and edited messages alike. */
function checkSpecial(body) {
  const g = /^<g:([\w-]+)>$/.exec(body), st = /^<s:(\d+)>$/.exec(body);
  if (g) { const up = getUpload(g[1]); if (!up || !up.type.startsWith('image/')) fail('That GIF is gone.'); }
  if (st) { const e = getEmoji(Number(st[1])); if (!e || e.kind !== 'sticker') fail('That sticker is gone.'); }
}
export function postMessage(userId, where, body, attachments, replyTo) {
  body = cleanBody(body);
  const att = attachmentsFrom(userId, attachments);
  if (!body && !att.length) fail('Empty message.');
  checkSpecial(body);
  // A poll message (<poll:id>) is posted once, by whoever made the poll (see createPoll).
  const pl = /^<poll:(\d+)>$/.exec(body), poll = pl && getPoll(Number(pl[1]));
  if (pl && (!poll || poll.created_by !== userId || poll.message_id)) fail('That poll is gone.');
  const lg = /^<lfg:(\d+)>$/.exec(body), group = lg && getLfg(Number(lg[1]));
  if (lg && (!group || group.created_by !== userId || group.message_id)) fail('That group is gone.');
  const parent = replyTo ? getMessage(Number(replyTo)) : null;
  const okParent = parent && (where.channelId ? parent.channel_id === where.channelId : parent.dm_id === where.dmId);
  const ttl = disappearOf(where);
  const id = Number(run('INSERT INTO messages (channel_id, dm_id, user_id, body, attachments, created_at, reply_to, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    where.channelId || null, where.dmId || null, userId, body, att.length ? JSON.stringify(att) : null, now(), okParent ? parent.id : null, ttl ? now() + ttl * 1000 : null).lastInsertRowid);
  if (poll) run('UPDATE polls SET message_id = ? WHERE id = ?', id, poll.id);
  if (group) run('UPDATE lfg SET message_id = ? WHERE id = ?', id, group.id);
  markRead(userId, where.channelId ? `c:${where.channelId}` : `d:${where.dmId}`, id);
  return publicMessage(one('SELECT * FROM messages WHERE id = ?', id));
}
/* A message as plain words: @names instead of <@12>, times written out, :emoji: names, [sticker] and [GIF].
   For push notifications and /ask. */
export const readableBody = (body) => String(body || '')
  .replace(/<@(\d+)>/g, (_, id) => '@' + ((getUser(Number(id)) || {}).name || 'someone'))
  .replace(/<t:(\d+)(?::\w)?>/g, (_, t) => new Date(Number(t) * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC')
  .replace(/<:(\w+):\d+>/g, ':$1:').replace(/^<s:\d+>$/, '[sticker]').replace(/^<g:[\w-]+>$/, '[GIF]').replace(/\s*<m:[cd]:\d+:\d+>/g, '')
  .replace(/^<poll:(\d+)>$/, (_, id) => `📊 Poll: ${(getPoll(Number(id)) || { question: '' }).question}`)
  .replace(/^<lfg:(\d+)>$/, (_, id) => `🎮 Looking for ${(getLfg(Number(id)) || { game: 'a group' }).game} players`);
/* Mentions are written in messages as <@userId>. */
export const mentionedIds = (body) => [...new Set([...String(body || '').matchAll(/<@(\d+)>/g)].map((x) => Number(x[1])))];
const EMOJI = /^(?=.*(?:\p{Extended_Pictographic}|\u20e3))[^\s]{1,16}$/u;   // \u20e3: keycap numbers like 1️⃣
export function react(userId, messageId, emoji, on) {
  emoji = String(emoji || '');
  const custom = /^<:\w{2,32}:(\d+)>$/.exec(emoji);
  if (custom ? on && !getEmoji(Number(custom[1])) : !EMOJI.test(emoji)) fail('That’s not an emoji.');
  if (on) {
    const kinds = one('SELECT COUNT(DISTINCT emoji) AS n FROM reactions WHERE message_id = ?', messageId).n;
    if (kinds >= 20 && !one('SELECT 1 AS x FROM reactions WHERE message_id = ? AND emoji = ?', messageId, emoji)) fail('That message has enough reactions.');
    run('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)', messageId, userId, emoji, now());
  } else run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', messageId, userId, emoji);
  return publicMessage(getMessage(messageId)).reactions;
}
/* Search, with optional filters: from:Name, in:#channel (or in:channel), has:file / image / video / audio / link. */
export function search(userId, text, serverId) {
  let q = String(text || '').trim().slice(0, 200);
  const where = [], args = [];
  q = q.replace(/(^|\s)from:(\S+)/gi, (x, sp, name) => {
    const u = userByName(name.replace(/^@/, '').replace(/_/g, ' ')) || userByName(name.replace(/^@/, ''));
    where.push('m.user_id = ?'); args.push(u ? u.id : -1); return sp;
  });
  q = q.replace(/(^|\s)in:#?(\S+)/gi, (x, sp, name) => {
    const ch = serverId > 0 ? one('SELECT id FROM channels WHERE server_id = ? AND name = ? COLLATE NOCASE', serverId, name) : null;
    where.push('m.channel_id = ?'); args.push(ch ? ch.id : -1); return sp;
  });
  const HAS = { file: 'm.attachments IS NOT NULL', image: `m.attachments LIKE '%"type":"image/%'`, photo: `m.attachments LIKE '%"type":"image/%'`,
    video: `m.attachments LIKE '%"type":"video/%'`, audio: `m.attachments LIKE '%"type":"audio/%'`, link: "m.body LIKE '%http%'", pin: 'm.pinned_at IS NOT NULL' };
  q = q.replace(/(^|\s)has:(\w+)/gi, (x, sp, k) => { where.push(Object.hasOwn(HAS, k.toLowerCase()) ? HAS[k.toLowerCase()] : '0'); return sp; });
  q = q.trim().slice(0, 100);
  if (q.length < 2 && !where.length) return [];
  if (q) { where.push("m.body LIKE ? ESCAPE '\\'"); args.push(`%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`); }
  const rows = all(`SELECT m.* FROM messages m
      LEFT JOIN channels c ON c.id = m.channel_id
      LEFT JOIN members mb ON mb.server_id = c.server_id AND mb.user_id = ?
      LEFT JOIN dms d ON d.id = m.dm_id
    WHERE (mb.user_id IS NOT NULL OR d.user_a = ? OR d.user_b = ?)
      AND (? = 0 OR c.server_id = ?)
      AND (? != -1 OR m.dm_id IS NOT NULL)
      ${where.map((w) => `AND ${w}`).join(' ')}
    ORDER BY m.id DESC LIMIT 50`, userId, userId, userId, serverId > 0 ? serverId : 0, serverId > 0 ? serverId : 0, serverId, ...args);
  return decorate(rows);
}
export const getMessage = (id) => one('SELECT * FROM messages WHERE id = ?', id);
export function editMessage(id, body) {
  body = cleanBody(body);
  if (!body) fail('Empty message.');
  checkSpecial(body);
  if (/<poll:\d+>/.test(body) || /^<poll:\d+>$/.test((getMessage(id) || {}).body || '')) fail('Polls can’t be edited. Make a new one instead.');
  if (/<lfg:\d+>/.test(body) || /^<lfg:\d+>$/.test((getMessage(id) || {}).body || '')) fail('Group posts can’t be edited. Make a new one instead.');
  run('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?', body, now(), id);
  return publicMessage(getMessage(id));
}
/* Pinned messages: up to 50 per channel or private chat. */
export function pin(messageId, userId, on) {
  const m = getMessage(messageId);
  if (on && !m.pinned_at) {
    const col = m.channel_id ? 'channel_id' : 'dm_id';
    if (one(`SELECT COUNT(*) AS n FROM messages WHERE ${col} = ? AND pinned_at IS NOT NULL`, m.channel_id || m.dm_id).n >= 50) fail('This chat already has 50 pinned messages. Unpin some first.');
    run('UPDATE messages SET pinned_at = ?, pinned_by = ? WHERE id = ?', now(), userId, messageId);
  } else if (!on) run('UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE id = ?', messageId);
  return publicMessage(getMessage(messageId));
}
export const pins = (col, targetId) => decorate(all(`SELECT * FROM messages WHERE ${col} = ? AND pinned_at IS NOT NULL ORDER BY pinned_at DESC LIMIT 50`, targetId));
export function setEmbeds(id, embeds) {
  run('UPDATE messages SET embeds = ? WHERE id = ?', embeds.length ? JSON.stringify(embeds) : null, id);
  return publicMessage(getMessage(id));
}
/* ---------- events ---------- */
/* Upcoming events of a server (and ones that started in the last 3 hours), soonest first. */
export function eventsOf(serverId) {
  const rows = all('SELECT * FROM events WHERE server_id = ? AND starts_at > ? ORDER BY starts_at LIMIT 50', serverId, now() - 3 * 3600_000);
  return rows.map(eventView);
}
export function eventView(e) {
  const rsvps = all('SELECT user_id, state FROM event_rsvps WHERE event_id = ?', e.id);
  return { id: e.id, serverId: e.server_id, creatorId: e.creator_id, title: e.title, description: e.description || '', startsAt: e.starts_at,
    channelId: e.channel_id, gameVote: e.game_vote || 0, textChannelId: e.announce_channel_id,
    going: rsvps.filter((r) => r.state === 'going').map((r) => r.user_id), maybe: rsvps.filter((r) => r.state === 'maybe').map((r) => r.user_id) };
}
export const getEvent = (id) => one('SELECT * FROM events WHERE id = ?', id);
export function createEvent(userId, serverId, d) {
  const title = String(d.title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!title) fail('Give the event a name.');
  const startsAt = Number(d.startsAt);
  if (!Number.isFinite(startsAt) || startsAt < now() - 60_000) fail('Pick a time in the future.');
  if (startsAt > now() + 366 * 86400_000) fail('Events can be up to a year ahead.');
  if (one('SELECT COUNT(*) AS n FROM events WHERE server_id = ? AND starts_at > ?', serverId, now()).n >= 50) fail('This server already has 50 upcoming events.');
  const ch = d.channelId ? getChannel(Number(d.channelId)) : null;
  // Announced (and its game vote held) in the chat it was planned from, or the server's first text channel.
  const from = d.textChannelId ? getChannel(Number(d.textChannelId)) : null;
  const announce = from && from.server_id === serverId && from.kind === 'text' ? from : one("SELECT id FROM channels WHERE server_id = ? AND kind = 'text' ORDER BY position, id LIMIT 1", serverId);
  // Game night: a vote on the chat's 🎮 list opens this many minutes before it starts.
  const gameVote = [15, 30, 60, 120].includes(Number(d.gameVote)) ? Number(d.gameVote) : null;
  const id = Number(run('INSERT INTO events (server_id, creator_id, title, description, starts_at, channel_id, announce_channel_id, created_at, game_vote) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    serverId, userId, title, String(d.description || '').trim().slice(0, 1000) || null, startsAt, ch && ch.server_id === serverId && ch.kind === 'voice' ? ch.id : null, announce ? announce.id : null, now(), gameVote).lastInsertRowid);
  run("INSERT INTO event_rsvps (event_id, user_id, state) VALUES (?, ?, 'going')", id, userId);
  return getEvent(id);
}
export function rsvp(eventId, userId, state) {
  if (state === 'going' || state === 'maybe') run('INSERT INTO event_rsvps (event_id, user_id, state) VALUES (?, ?, ?) ON CONFLICT (event_id, user_id) DO UPDATE SET state = excluded.state', eventId, userId, state);
  else run('DELETE FROM event_rsvps WHERE event_id = ? AND user_id = ?', eventId, userId);
}
export const deleteEvent = (id) => run('DELETE FROM events WHERE id = ?', id);
/* Events starting within the next 15 minutes that haven't been announced yet. */
export function eventsToRemind() {
  const rows = all('SELECT * FROM events WHERE reminded = 0 AND starts_at <= ? AND starts_at > ?', now() + 15 * 60_000, now() - 5 * 60_000);
  for (const e of rows) run('UPDATE events SET reminded = 1 WHERE id = ?', e.id);
  return rows;
}
/* Media gallery: every photo, video, GIF and file shared in a channel or private chat, newest first, 60
   messages at a time. col: 'channel_id' or 'dm_id'. */
export function mediaOf(col, targetId, before) {
  const rows = all(`SELECT id, user_id, body, attachments, created_at FROM messages WHERE ${col} = ? AND id < ? AND (attachments IS NOT NULL OR body LIKE '<g:%') ORDER BY id DESC LIMIT 60`,
    targetId, Number(before) || Number.MAX_SAFE_INTEGER);
  const items = [];
  for (const m of rows) {
    const base = { messageId: m.id, userId: m.user_id, at: m.created_at };
    const g = /^<g:([\w-]+)>$/.exec(m.body || '');
    if (g) { const up = getUpload(g[1]); if (up) items.push({ ...base, kind: 'gif', url: `/uploads/${up.id}`, name: up.name, type: up.type, size: up.size }); }
    for (const a of m.attachments ? JSON.parse(m.attachments) : []) {
      const kind = /^image\//.test(a.type) ? 'image' : /^video\//.test(a.type) ? 'video' : /^audio\//.test(a.type) ? 'audio' : 'file';
      items.push({ ...base, kind, url: a.url, thumbUrl: a.thumbUrl || null, name: a.name, type: a.type, size: a.size });
    }
  }
  return { items, before: rows.length === 60 ? rows[rows.length - 1].id : null };
}
/* Polls: a question with 2 to 10 choices, one or several picks each, optionally anonymous and with an end time.
   The poll is made first, then posted as a message <poll:id> (whose card shows live results). */
export const getPoll = (id) => one('SELECT * FROM polls WHERE id = ?', id);
export const pollOfMessage = (messageId) => one('SELECT * FROM polls WHERE message_id = ?', messageId);
export function createPoll(userId, d) {
  const question = String(d.question || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!question) fail('Write the question.');
  const options = [...new Set((Array.isArray(d.options) ? d.options : []).map((o) => String(o || '').replace(/\s+/g, ' ').trim().slice(0, 80)).filter(Boolean))];
  if (options.length < 2) fail('Give at least 2 different choices.');
  if (options.length > 10) fail('Polls can have up to 10 choices.');
  const minutes = Number(d.minutes) || 0;
  if (minutes && ![60, 1440, 10080].includes(minutes) && !(process.env.POLL_TEST && minutes > 0)) fail('Pick how long the poll lasts.');
  const ends = minutes ? now() + minutes * (Number(process.env.POLL_MINUTE_MS) || 60_000) : null;
  return Number(run('INSERT INTO polls (created_by, question, options, multi, anon, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    userId, question, JSON.stringify(options), d.multi ? 1 : 0, d.anon ? 1 : 0, ends, now()).lastInsertRowid);
}
/* What everyone sees. Who voted for what only when the poll isn't anonymous. */
export function pollView(id) {
  const p = getPoll(id);
  if (!p) return null;
  const votes = all('SELECT user_id, option FROM poll_votes WHERE poll_id = ?', id);
  const options = JSON.parse(p.options).map((text, i) => {
    const who = votes.filter((v) => v.option === i).map((v) => v.user_id);
    return { text, votes: who.length, voters: p.anon ? null : who };
  });
  return { id: p.id, question: p.question, options, multi: !!p.multi, anon: !!p.anon, endsAt: p.ends_at, closed: !!p.closed, by: p.created_by, people: new Set(votes.map((v) => v.user_id)).size };
}
export const myPollVotes = (pollId, userId) => all('SELECT option FROM poll_votes WHERE poll_id = ? AND user_id = ?', pollId, userId).map((r) => r.option);
export function votePoll(pollId, userId, option, on) {
  const p = getPoll(pollId);
  if (!p || !p.message_id) fail('That poll is gone.');
  if (p.closed) fail('This poll has ended.');
  option = Number(option);
  if (!Number.isInteger(option) || option < 0 || option >= JSON.parse(p.options).length) fail('Unknown choice.');
  if (on && !p.multi) run('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?', pollId, userId);
  if (on) run('INSERT OR IGNORE INTO poll_votes (poll_id, user_id, option) VALUES (?, ?, ?)', pollId, userId, option);
  else run('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ? AND option = ?', pollId, userId, option);
}
export const closePoll = (pollId) => run('UPDATE polls SET closed = 1 WHERE id = ?', pollId);
export const pollsDue = () => all('SELECT * FROM polls WHERE closed = 0 AND ends_at IS NOT NULL AND ends_at <= ? AND message_id IS NOT NULL', now());
/* Each person's own picks, added to messages they load. */
export function addMyVotes(messages, userId) {
  for (const m of messages) if (m.poll) m.poll.mine = myPollVotes(m.poll.id, userId);
  return messages;
}

/* Disappearing messages, for private chats and group chats: off, 24 hours or 7 days (in seconds). */
export const DISAPPEAR = [0, 86400, 604800];
function disappearOf(where) {
  if (where.dmId) return (getDm(where.dmId) || {}).disappear || 0;
  const ch = getChannel(where.channelId), srv = ch && getServer(ch.server_id);
  return srv && srv.kind === 'group' ? srv.disappear || 0 : 0;
}
export function setDisappear(target, seconds) {
  seconds = Number(seconds) || 0;
  if (!DISAPPEAR.includes(seconds) && !(process.env.DISAPPEAR_TEST && seconds > 0 && seconds < 3600)) fail('Pick off, 24 hours or 7 days.');
  if (target.dmId) run('UPDATE dms SET disappear = ? WHERE id = ?', seconds || null, target.dmId);
  else run('UPDATE servers SET disappear = ? WHERE id = ?', seconds || null, target.serverId);
  return seconds;
}
/* Messages whose time is up (at most 200 at a time); the caller deletes them and tells the chat. */
export const expiredMessages = () => all('SELECT * FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ? LIMIT 200', now());

/* "Remind me about this": Party Bot brings a message back to you privately later. jump: c:<channel> or d:<person>. */
export function addMsgReminder(userId, messageId, jump, at) {
  at = Number(at);
  if (!Number.isFinite(at) || at < now() + Number(process.env.LATER_MIN_MS ?? 30_000)) fail('Pick a time at least a minute from now.');
  if (at > now() + 366 * 86400_000) fail('Reminders can be up to a year ahead.');
  if (one('SELECT COUNT(*) AS n FROM msg_reminders WHERE user_id = ?', userId).n >= 50) fail('You already have 50 reminders waiting.');
  run('INSERT INTO msg_reminders (user_id, message_id, jump, due_at) VALUES (?, ?, ?, ?)', userId, messageId, jump, at);
}
export function dueMsgReminders() {
  const rows = all('SELECT * FROM msg_reminders WHERE due_at <= ? ORDER BY due_at LIMIT 50', now());
  for (const r of rows) run('DELETE FROM msg_reminders WHERE id = ?', r.id);
  return rows;
}

/* Bookmarks: messages you saved for later. Only you see them, and only while you can still see the message. */
export const bookmarkIds = (userId) => all('SELECT message_id FROM bookmarks WHERE user_id = ? ORDER BY created_at DESC LIMIT 500', userId).map((r) => r.message_id);
export function setBookmark(userId, messageId, on) {
  if (!on) { run('DELETE FROM bookmarks WHERE user_id = ? AND message_id = ?', userId, messageId); return; }
  if (one('SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = ?', userId).n >= 500) fail('You have 500 saved messages. Remove some first.');
  run('INSERT OR IGNORE INTO bookmarks (user_id, message_id, created_at) VALUES (?, ?, ?)', userId, messageId, now());
}
export function bookmarksOf(userId) {
  const rows = all(`SELECT m.* FROM bookmarks b JOIN messages m ON m.id = b.message_id
    LEFT JOIN channels c ON c.id = m.channel_id LEFT JOIN dms d ON d.id = m.dm_id
    WHERE b.user_id = ? AND ((c.id IS NOT NULL AND EXISTS (SELECT 1 FROM members WHERE server_id = c.server_id AND user_id = ?)) OR d.user_a = ? OR d.user_b = ?)
    ORDER BY b.created_at DESC LIMIT 200`, userId, userId, userId, userId);
  return decorate(rows);
}

/* Send later: messages written now and sent at a chosen time (text only, no bot commands). */
const scheduledView = (r) => ({ id: r.id, channelId: r.channel_id, toUserId: r.to_user_id, body: r.body, sendAt: r.send_at });
export function scheduledFor(userId, target) {
  const rows = target.channelId ? all('SELECT * FROM scheduled WHERE user_id = ? AND channel_id = ? ORDER BY send_at', userId, target.channelId)
    : all('SELECT * FROM scheduled WHERE user_id = ? AND to_user_id = ? ORDER BY send_at', userId, target.toUserId);
  return rows.map(scheduledView);
}
export function addScheduled(userId, target, body, sendAt) {
  body = cleanBody(body);
  if (!body) fail('Write the message first.');
  sendAt = Number(sendAt);
  if (!Number.isFinite(sendAt) || sendAt < now() + Number(process.env.LATER_MIN_MS ?? 30_000)) fail('Pick a time at least a minute from now.');   // tests shorten it
  if (sendAt > now() + 30 * 86400_000) fail('Messages can be scheduled up to 30 days ahead.');
  if (one('SELECT COUNT(*) AS n FROM scheduled WHERE user_id = ?', userId).n >= 25) fail('You already have 25 messages waiting to be sent.');
  run('INSERT INTO scheduled (user_id, channel_id, to_user_id, body, send_at, created_at) VALUES (?, ?, ?, ?, ?, ?)', userId, target.channelId || null, target.toUserId || null, body, sendAt, now());
}
export const getScheduled = (id) => one('SELECT * FROM scheduled WHERE id = ?', id);
export const deleteScheduled = (id) => run('DELETE FROM scheduled WHERE id = ?', id);
export function scheduledDue() {
  const rows = all('SELECT * FROM scheduled WHERE send_at <= ? ORDER BY send_at LIMIT 50', now());
  for (const r of rows) run('DELETE FROM scheduled WHERE id = ?', r.id);
  return rows;
}

/* Game nights whose vote should open now (minute: ms per minute, shorter in tests). Marks them as started. */
export function gameVotesDue(minute) {
  const rows = all('SELECT * FROM events WHERE game_vote > 0 AND vote_started = 0 AND starts_at > ? AND starts_at - game_vote * ? <= ?', now(), minute, now());
  for (const e of rows) run('UPDATE events SET vote_started = 1 WHERE id = ?', e.id);
  return rows;
}
/* ---------- soundboard: each server's uploaded sounds (up to 30, 1 MB each) ---------- */
const soundView = (r) => ({ id: r.id, serverId: r.server_id, userId: r.user_id, name: r.name, emoji: r.emoji || '🔊', url: `/uploads/${r.upload_id}` });
export const soundsOf = (serverId) => all('SELECT * FROM sounds WHERE server_id = ? ORDER BY id', serverId).map(soundView);
export const getSound = (id) => one('SELECT * FROM sounds WHERE id = ?', id);
export const SOUNDS_EACH = 10, SOUNDS_MAX = 100;
export function addSound(userId, serverId, d) {
  const name = String(d.name || '').replace(/\s+/g, ' ').trim().slice(0, 24);
  if (!name) fail('Give the sound a name.');
  const up = one('SELECT * FROM uploads WHERE id = ? AND user_id = ?', String(d.uploadId || ''), userId);
  if (!up || !up.type.startsWith('audio/')) fail('Pick an audio file (MP3, WAV, OGG or M4A).');
  if (up.size > 1048576) fail('Sounds can be up to 1 MB. Use a shorter clip.');
  // Everyone can add sounds: up to 10 each, so nobody fills the board for the others, and 100 in a server.
  if (one('SELECT COUNT(*) AS n FROM sounds WHERE server_id = ? AND user_id = ?', serverId, userId).n >= SOUNDS_EACH) fail(`You’ve added ${SOUNDS_EACH} sounds here already. Remove one of yours first.`);
  if (one('SELECT COUNT(*) AS n FROM sounds WHERE server_id = ?', serverId).n >= SOUNDS_MAX) fail(`This server already has ${SOUNDS_MAX} sounds. Remove one first.`);
  const emoji = EMOJI.test(String(d.emoji || '')) ? String(d.emoji) : '🔊';
  run('INSERT INTO sounds (server_id, user_id, name, emoji, upload_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', serverId, userId, name, emoji, up.id, now());
}
export const deleteSound = (id) => run('DELETE FROM sounds WHERE id = ?', id);
/* Game ideas: each chat (a channel or a private chat) keeps a list of games to try later. Friends vote 👍,
   tick off what they've played, and Party Bot can pick one. where: { channelId } or { dmId }. */
const gameCol = (where) => (where.channelId ? ['channel_id', where.channelId] : ['dm_id', where.dmId]);
export function gamesOf(where) {
  const [col, id] = gameCol(where);
  const votes = new Map();
  for (const v of all(`SELECT v.game_id, v.user_id FROM game_votes v JOIN game_ideas g ON g.id = v.game_id WHERE g.${col} = ?`, id)) (votes.get(v.game_id) || votes.set(v.game_id, []).get(v.game_id)).push(v.user_id);
  return all(`SELECT * FROM game_ideas WHERE ${col} = ? ORDER BY played_at IS NOT NULL, id`, id).map((g) => ({
    id: g.id, name: g.name, url: g.url, note: g.note, by: g.user_id, at: g.created_at, playedAt: g.played_at, votes: votes.get(g.id) || [],
  })).sort((a, b) => (!!a.playedAt - !!b.playedAt) || (b.votes.length - a.votes.length) || (a.id - b.id));
}
export const getGame = (id) => one('SELECT * FROM game_ideas WHERE id = ?', id);
export function addGame(userId, where, d) {
  const name = String(d.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!name) fail('Type the game’s name.');
  let url = String(d.url || '').trim();
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  if (url) { try { const u = new URL(url); if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) throw 0; url = u.href.slice(0, 300); } catch { fail('That link doesn’t look right. Paste the game’s store page, or leave it empty.'); } }
  const note = String(d.note || '').replace(/\s+/g, ' ').trim().slice(0, 140) || null;
  const [col, id] = gameCol(where);
  if (one(`SELECT COUNT(*) AS n FROM game_ideas WHERE ${col} = ?`, id).n >= 200) fail('This list is full (200 games). Remove some old ones first.');
  const dup = one(`SELECT id FROM game_ideas WHERE ${col} = ? AND lower(name) = lower(?)`, id, name);
  if (dup) fail(`${name} is already on the list. Vote for it instead!`);
  const gid = Number(run(`INSERT INTO game_ideas (${col}, name, url, note, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`, id, name, url || null, note, userId, now()).lastInsertRowid);
  run('INSERT INTO game_votes (game_id, user_id) VALUES (?, ?)', gid, userId);   // you'd play what you suggest
  return gid;
}
export function voteGame(userId, gameId, on) {
  if (on) run('INSERT OR IGNORE INTO game_votes (game_id, user_id) VALUES (?, ?)', gameId, userId);
  else run('DELETE FROM game_votes WHERE game_id = ? AND user_id = ?', gameId, userId);
}
export const setGamePlayed = (gameId, played) => run('UPDATE game_ideas SET played_at = ? WHERE id = ?', played ? now() : null, gameId);
export const deleteGame = (gameId) => run('DELETE FROM game_ideas WHERE id = ?', gameId);

/* The AFK channel: people quiet in voice for a while are moved there (by their own app). null turns it off. */
export function setAfkChannel(serverId, channelId) {
  const ch = channelId ? getChannel(Number(channelId)) : null;
  if (channelId && (!ch || ch.server_id !== serverId || ch.kind !== 'voice')) fail('Pick one of this server’s voice channels.');
  run('UPDATE servers SET afk_channel_id = ? WHERE id = ?', ch ? ch.id : null, serverId);
}
/* Custom emoji and stickers, per server. In messages, an emoji is written <:name:id>; a sticker message is
   just <s:id>. Anyone in a server can use its emoji anywhere (in other servers and private chats too). */
const emojiView = (e) => ({ id: e.id, serverId: e.server_id, kind: e.kind, name: e.name, url: `/uploads/${e.upload_id}`, by: e.user_id });
export const emojiOf = (serverId) => all('SELECT * FROM emoji WHERE server_id = ? ORDER BY kind, name', serverId).map(emojiView);
export const getEmoji = (id) => one('SELECT * FROM emoji WHERE id = ?', id);
export function addEmoji(userId, serverId, d) {
  const kind = d.kind === 'sticker' ? 'sticker' : 'emoji';
  const name = String(d.name || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
  if (name.length < 2) fail('Give it a name of at least 2 letters (letters, numbers and _).');
  const up = one('SELECT * FROM uploads WHERE id = ? AND user_id = ?', String(d.uploadId || ''), userId);
  if (!up || !/^image\/(png|gif|webp|jpeg)$/.test(up.type)) fail('Pick a picture (PNG, GIF, WEBP or JPG).');
  const max = kind === 'emoji' ? 524288 : 2097152;
  if (up.size > max) fail(kind === 'emoji' ? 'Emoji can be up to 512 KB.' : 'Stickers can be up to 2 MB.');
  const limit = kind === 'emoji' ? 100 : 50;
  if (one('SELECT COUNT(*) AS n FROM emoji WHERE server_id = ? AND kind = ?', serverId, kind).n >= limit) fail(`This server already has ${limit} ${kind === 'emoji' ? 'emoji' : 'stickers'}. Remove one first.`);
  if (one('SELECT 1 AS x FROM emoji WHERE server_id = ? AND kind = ? AND name = ?', serverId, kind, name)) fail(`There’s already one called :${name}:.`);
  run('INSERT INTO emoji (server_id, kind, name, upload_id, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', serverId, kind, name, up.id, userId, now());
}
export const deleteEmoji = (id) => run('DELETE FROM emoji WHERE id = ?', id);
/* Saved GIFs (and memes): any picture from the chat, kept for sending again with one click. */
export const favGifs = (userId) => all('SELECT f.upload_id AS id FROM fav_gifs f JOIN uploads u ON u.id = f.upload_id WHERE f.user_id = ? ORDER BY f.created_at DESC', userId).map((r) => ({ id: r.id, url: `/uploads/${r.id}` }));
export function setFavGif(userId, uploadId, on) {
  const up = getUpload(String(uploadId || ''));
  if (on) {
    if (!up || !up.type.startsWith('image/')) fail('Only pictures and GIFs can be saved.');
    if (one('SELECT COUNT(*) AS n FROM fav_gifs WHERE user_id = ?', userId).n >= 200) fail('You have 200 saved GIFs. Remove some first.');
    run('INSERT OR IGNORE INTO fav_gifs (user_id, upload_id, created_at) VALUES (?, ?, ?)', userId, up.id, now());
  } else run('DELETE FROM fav_gifs WHERE user_id = ? AND upload_id = ?', userId, String(uploadId || ''));
  return favGifs(userId);
}
export const deleteMessage = (id) => run('DELETE FROM messages WHERE id = ?', id);
export function history(col, targetId, before, limit = 50) {
  const live = '(expires_at IS NULL OR expires_at > ?)';   // disappeared messages that the cleanup hasn't removed yet
  const rows = before
    ? all(`SELECT * FROM messages WHERE ${col} = ? AND id < ? AND ${live} ORDER BY id DESC LIMIT ?`, targetId, before, now(), limit)
    : all(`SELECT * FROM messages WHERE ${col} = ? AND ${live} ORDER BY id DESC LIMIT ?`, targetId, now(), limit);
  return decorate(rows.reverse());
}
export function markRead(userId, target, lastId) {
  run(`INSERT INTO reads (user_id, target, last_id) VALUES (?, ?, ?)
       ON CONFLICT (user_id, target) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)`, userId, target, lastId);
}
function mentionCount(userId, target, channelId) {
  const r = one('SELECT last_id FROM reads WHERE user_id = ? AND target = ?', userId, target);
  // Only the newest 1,000 unread messages are looked at, so a channel left unread for months stays quick to count.
  return one(`SELECT COUNT(*) AS n FROM (SELECT body FROM messages WHERE channel_id = ? AND id > ? ORDER BY id DESC LIMIT 1000) WHERE body LIKE ?`,
    channelId, r ? r.last_id : 0, `%<@${userId}>%`).n;
}
function unreadCount(userId, target, col, targetId) {
  const r = one('SELECT last_id FROM reads WHERE user_id = ? AND target = ?', userId, target);
  return one(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM messages WHERE ${col} = ? AND id > ? AND (user_id IS NULL OR user_id != ?) LIMIT 99)`,
    targetId, r ? r.last_id : 0, userId).n;
}

/* ---------- friends and private chats ---------- */
export const friendState = (a, b) => (one('SELECT state FROM friends WHERE user_id = ? AND friend_id = ?', a, b) || {}).state || null;
export function friendsOf(userId) {
  return all('SELECT friend_id AS id, state FROM friends WHERE user_id = ?', userId);
}
export function requestFriend(userId, name) {
  const other = userByName(cleanName(name));
  if (!other) fail(`Nobody is called “${cleanName(name)}”. Check the spelling.`);
  if (other.id === userId) fail('That’s you.');
  const st = friendState(userId, other.id);
  if (st === 'friends') fail(`You and ${other.name} are already friends.`);
  if (st === 'incoming') { acceptFriend(userId, other.id); return { other, state: 'friends' }; }
  tx(() => {
    run('INSERT OR REPLACE INTO friends (user_id, friend_id, state, created_at) VALUES (?, ?, ?, ?)', userId, other.id, 'outgoing', now());
    run('INSERT OR REPLACE INTO friends (user_id, friend_id, state, created_at) VALUES (?, ?, ?, ?)', other.id, userId, 'incoming', now());
  });
  return { other, state: 'outgoing' };
}
export function acceptFriend(userId, otherId) {
  if (friendState(userId, otherId) !== 'incoming') fail('There’s no request from them.');
  tx(() => {
    run('UPDATE friends SET state = ? WHERE user_id = ? AND friend_id = ?', 'friends', userId, otherId);
    run('UPDATE friends SET state = ? WHERE user_id = ? AND friend_id = ?', 'friends', otherId, userId);
  });
}
export function removeFriend(userId, otherId) {
  tx(() => {
    run('DELETE FROM friends WHERE user_id = ? AND friend_id = ?', userId, otherId);
    run('DELETE FROM friends WHERE user_id = ? AND friend_id = ?', otherId, userId);
  });
}
export function dmWith(userId, otherId, create) {
  const [a, b] = userId < otherId ? [userId, otherId] : [otherId, userId];
  let d = one('SELECT * FROM dms WHERE user_a = ? AND user_b = ?', a, b);
  if (!d && create) {
    run('INSERT INTO dms (user_a, user_b, created_at) VALUES (?, ?, ?)', a, b, now());
    d = one('SELECT * FROM dms WHERE user_a = ? AND user_b = ?', a, b);
  }
  return d;
}
export const getDm = (id) => one('SELECT * FROM dms WHERE id = ?', id);
export function dmsOf(userId) {
  return all(`SELECT d.*, (SELECT MAX(id) FROM messages WHERE dm_id = d.id) AS last_id,
                     (SELECT created_at FROM messages WHERE dm_id = d.id ORDER BY id DESC LIMIT 1) AS last_at
              FROM dms d WHERE user_a = ? OR user_b = ?`, userId, userId)
    .filter((d) => d.last_id)
    .map((d) => ({ id: d.id, userId: d.user_a === userId ? d.user_b : d.user_a, lastId: d.last_id, lastAt: d.last_at, unread: unreadCount(userId, `d:${d.id}`, 'dm_id', d.id), disappear: d.disappear || 0 }));
}

/* ---------- uploads ---------- */
export function addUpload(userId, name, type, size) {
  const id = crypto.randomBytes(18).toString('base64url');
  run('INSERT INTO uploads (id, user_id, name, type, size, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, userId, name, type, size, now());
  return id;
}
export const getUpload = (id) => one('SELECT * FROM uploads WHERE id = ?', id);

/* ---------- feedback ---------- */
export function addFeedback(userId, kind, body) {
  body = cleanBody(body);
  if (!body) fail('Write something first.');
  if (!['bug', 'idea', 'other'].includes(kind)) kind = 'other';
  return Number(run('INSERT INTO feedback (user_id, kind, body, created_at) VALUES (?, ?, ?, ?)', userId, kind, body, now()).lastInsertRowid);
}
export const listFeedback = () => all('SELECT * FROM feedback ORDER BY id DESC LIMIT 300')
  .map((f) => ({ id: f.id, userId: f.user_id, kind: f.kind, body: f.body, done: !!f.done, at: f.created_at }));
export const setFeedbackDone = (id, done) => run('UPDATE feedback SET done = ? WHERE id = ?', done ? 1 : 0, id);
export const deleteFeedback = (id) => run('DELETE FROM feedback WHERE id = ?', id);

export const allUsers = () => all('SELECT * FROM users').map(publicUser);
export const touchUser = (id) => run('UPDATE users SET last_seen = ? WHERE id = ?', now(), id);
/* Everyone who ever made an account, for the developer panel. */
export function userDirectory() {
  return all(`SELECT u.id, u.name, u.avatar, u.is_admin, u.created_at,
      COALESCE(u.last_seen, (SELECT MAX(last_seen) FROM sessions WHERE user_id = u.id)) AS last_seen,
      (SELECT COUNT(*) FROM sessions WHERE user_id = u.id) AS sessions,
      (SELECT COUNT(*) FROM messages WHERE user_id = u.id) AS messages,
      (SELECT COUNT(*) FROM members WHERE user_id = u.id) AS servers,
      (SELECT COUNT(*) FROM friends WHERE user_id = u.id AND state = 'friends') AS friends
    FROM users u WHERE u.is_bot = 0 ORDER BY last_seen DESC`).map((u) => ({
    id: u.id, name: u.name, avatar: u.avatar, admin: !!u.is_admin, createdAt: u.created_at, lastSeen: u.last_seen,
    devices: u.sessions, messages: u.messages, servers: u.servers, friends: u.friends,
  }));
}

/* Who you can see: people who share a server with you, friends and friend requests, and people you've chatted with. */
const VISIBLE = `
  SELECT m2.user_id AS id FROM members m1 JOIN members m2 ON m2.server_id = m1.server_id WHERE m1.user_id = :me
  UNION SELECT friend_id FROM friends WHERE user_id = :me
  UNION SELECT CASE WHEN user_a = :me THEN user_b ELSE user_a END FROM dms WHERE user_a = :me OR user_b = :me
  UNION SELECT id FROM users WHERE is_bot = 1
  UNION SELECT :me`;
export const visibleUsers = (me) => all(`SELECT * FROM users WHERE id IN (${VISIBLE})`, { me }).map(publicUser);
export const canSeeUser = (me, other) => me === other || !!one(`SELECT 1 AS x FROM (${VISIBLE}) WHERE id = :other`, { me, other });

/* Photos and videos nobody uses any more: from deleted messages, channels or servers, old profile pictures,
   and uploads that were never sent. Kept for an hour first, so a message being written isn't affected. */
export function unusedUploads(olderThan = 60 * 60_000) {
  const used = new Set();
  for (const r of all('SELECT attachments FROM messages WHERE attachments IS NOT NULL')) for (const a of JSON.parse(r.attachments)) { used.add(a.id); if (a.thumb) used.add(a.thumb); }
  for (const r of all('SELECT avatar FROM users WHERE avatar IS NOT NULL')) used.add(String(r.avatar).replace('/uploads/', ''));
  for (const r of all('SELECT upload_id FROM sounds')) used.add(r.upload_id);
  for (const r of all('SELECT upload_id FROM emoji UNION SELECT upload_id FROM fav_gifs')) used.add(r.upload_id);
  for (const r of all("SELECT body FROM messages WHERE body LIKE '<g:%'")) { const m = /^<g:([\w-]+)>$/.exec(r.body); if (m) used.add(m[1]); }
  return all('SELECT id FROM uploads WHERE created_at < ?', now() - olderThan).map((r) => r.id).filter((id) => !used.has(id));
}
export const forgetUpload = (id) => run('DELETE FROM uploads WHERE id = ?', id);
