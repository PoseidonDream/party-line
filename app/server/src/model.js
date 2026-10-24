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
  custom: u.custom_status || null, bio: u.bio || null, banner: u.banner || null });
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
  const id = Number(run('INSERT INTO users (name, name_key, pass_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)',
    name, foldKey(name), hashPass(pass), isAdminName(name) ? 1 : 0, now()).lastInsertRowid);
  const def = one('SELECT id FROM servers WHERE is_default = 1');
  if (def) joinServer(id, def.id);
  return { user: getUser(id), token: newSession(id) };
}
export function login(name, pass) {
  const u = userByName(name);
  if (!u || !checkPass(pass, u.pass_hash)) fail('Wrong name or password.');
  return { user: u, token: newSession(u.id) };
}
function newSession(userId) {
  const t = token();
  run('INSERT INTO sessions (token_hash, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)', sha(t), userId, now(), now());
  return t;
}
export function userForToken(t) {
  if (!t || typeof t !== 'string') return null;
  const s = one('SELECT * FROM sessions WHERE token_hash = ?', sha(t));
  if (!s) return null;
  if (now() - s.last_seen > 60_000) run('UPDATE sessions SET last_seen = ? WHERE token_hash = ?', now(), s.token_hash);
  return getUser(s.user_id);
}
export const logout = (t) => run('DELETE FROM sessions WHERE token_hash = ?', sha(String(t || '')));
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
  run('UPDATE users SET pass_hash = ? WHERE id = ?', hashPass(temp), userId);
  run('DELETE FROM sessions WHERE user_id = ?', userId);
  return temp;
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
export function ensureDefaultServer() {
  if (!one('SELECT id FROM servers WHERE is_default = 1')) createServer(null, 'Party Line', true);
}
export const getServer = (id) => one('SELECT * FROM servers WHERE id = ?', id);
export const serverByInvite = (code) => one('SELECT * FROM servers WHERE invite = ?', String(code || '').trim());
export const isMember = (userId, serverId) => !!one('SELECT 1 AS x FROM members WHERE server_id = ? AND user_id = ?', serverId, userId);
export const joinServer = (userId, serverId) => run('INSERT OR IGNORE INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)', serverId, userId, now());
export const leaveServer = (userId, serverId) => run('DELETE FROM members WHERE server_id = ? AND user_id = ?', serverId, userId);
export const memberIds = (serverId) => all('SELECT user_id FROM members WHERE server_id = ?', serverId).map((r) => r.user_id);
export const serverIdsOf = (userId) => all('SELECT server_id FROM members WHERE user_id = ?', userId).map((r) => r.server_id);
export const getChannel = (id) => one('SELECT * FROM channels WHERE id = ?', id);
export const deleteServer = (id) => run('DELETE FROM servers WHERE id = ?', id);
export const renameServer = (id, name) => run('UPDATE servers SET name = ? WHERE id = ?', name, id);
export function canManage(user, server) { return !!user.is_admin || (server && server.owner_id === user.id); }

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
const publicChannel = (c) => ({ id: c.id, serverId: c.server_id, kind: c.kind, name: c.name, position: c.position });

export function serverView(serverId, viewerId) {
  const s = getServer(serverId);
  if (!s) return null;
  const channels = all('SELECT * FROM channels WHERE server_id = ? ORDER BY position, id', serverId).map(publicChannel);
  for (const c of channels) {
    if (c.kind !== 'text') continue;
    c.lastId = one('SELECT MAX(id) AS m FROM messages WHERE channel_id = ?', c.id).m || 0;
    c.unread = unreadCount(viewerId, `c:${c.id}`, 'channel_id', c.id);
    c.mentions = c.unread ? mentionCount(viewerId, `c:${c.id}`, c.id) : 0;
  }
  return { id: s.id, name: s.name, ownerId: s.owner_id, invite: s.invite, isDefault: !!s.is_default, channels, members: memberIds(serverId) };
}

/* ---------- messages ---------- */
function attachmentsFrom(userId, list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list.slice(0, 10)) {
    const id = String(a && a.id || '');
    const up = one('SELECT * FROM uploads WHERE id = ? AND user_id = ?', id, userId);
    if (up) out.push({ id: up.id, url: `/uploads/${up.id}`, name: up.name, type: up.type, size: up.size });
  }
  return out;
}
const basicMessage = (m) => ({
  id: m.id, channelId: m.channel_id, dmId: m.dm_id, userId: m.user_id, body: m.body,
  attachments: m.attachments ? JSON.parse(m.attachments) : [], at: m.created_at, editedAt: m.edited_at,
  replyTo: m.reply_to || null, reply: null, reactions: [], pinned: m.pinned_at ? { at: m.pinned_at, by: m.pinned_by } : null,
  embeds: m.embeds ? JSON.parse(m.embeds) : [],
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
export function postMessage(userId, where, body, attachments, replyTo) {
  body = cleanBody(body);
  const att = attachmentsFrom(userId, attachments);
  if (!body && !att.length) fail('Empty message.');
  const parent = replyTo ? getMessage(Number(replyTo)) : null;
  const okParent = parent && (where.channelId ? parent.channel_id === where.channelId : parent.dm_id === where.dmId);
  const id = Number(run('INSERT INTO messages (channel_id, dm_id, user_id, body, attachments, created_at, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?)',
    where.channelId || null, where.dmId || null, userId, body, att.length ? JSON.stringify(att) : null, now(), okParent ? parent.id : null).lastInsertRowid);
  markRead(userId, where.channelId ? `c:${where.channelId}` : `d:${where.dmId}`, id);
  return publicMessage(one('SELECT * FROM messages WHERE id = ?', id));
}
/* Mentions are written in messages as <@userId>. */
export const mentionedIds = (body) => [...new Set([...String(body || '').matchAll(/<@(\d+)>/g)].map((x) => Number(x[1])))];
const EMOJI = /^(?=.*(?:\p{Extended_Pictographic}|\u20e3))[^\s]{1,16}$/u;   // \u20e3: keycap numbers like 1️⃣
export function react(userId, messageId, emoji, on) {
  emoji = String(emoji || '');
  if (!EMOJI.test(emoji)) fail('That’s not an emoji.');
  if (on) {
    const kinds = one('SELECT COUNT(DISTINCT emoji) AS n FROM reactions WHERE message_id = ?', messageId).n;
    if (kinds >= 20 && !one('SELECT 1 AS x FROM reactions WHERE message_id = ? AND emoji = ?', messageId, emoji)) fail('That message has enough reactions.');
    run('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)', messageId, userId, emoji, now());
  } else run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', messageId, userId, emoji);
  return publicMessage(getMessage(messageId)).reactions;
}
export function search(userId, text, serverId) {
  text = String(text || '').trim().slice(0, 100);
  if (text.length < 2) return [];
  const like = `%${text.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
  const rows = all(`SELECT m.* FROM messages m
      LEFT JOIN channels c ON c.id = m.channel_id
      LEFT JOIN members mb ON mb.server_id = c.server_id AND mb.user_id = ?
      LEFT JOIN dms d ON d.id = m.dm_id
    WHERE (mb.user_id IS NOT NULL OR d.user_a = ? OR d.user_b = ?)
      AND m.body LIKE ? ESCAPE '\\'
      AND (? = 0 OR c.server_id = ?)
      AND (? != -1 OR m.dm_id IS NOT NULL)
    ORDER BY m.id DESC LIMIT 50`, userId, userId, userId, like, serverId > 0 ? serverId : 0, serverId > 0 ? serverId : 0, serverId);
  return decorate(rows);
}
export const getMessage = (id) => one('SELECT * FROM messages WHERE id = ?', id);
export function editMessage(id, body) {
  body = cleanBody(body);
  if (!body) fail('Empty message.');
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
    channelId: e.channel_id, going: rsvps.filter((r) => r.state === 'going').map((r) => r.user_id), maybe: rsvps.filter((r) => r.state === 'maybe').map((r) => r.user_id) };
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
  const announce = one("SELECT id FROM channels WHERE server_id = ? AND kind = 'text' ORDER BY position, id LIMIT 1", serverId);
  const id = Number(run('INSERT INTO events (server_id, creator_id, title, description, starts_at, channel_id, announce_channel_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    serverId, userId, title, String(d.description || '').trim().slice(0, 1000) || null, startsAt, ch && ch.server_id === serverId && ch.kind === 'voice' ? ch.id : null, announce ? announce.id : null, now()).lastInsertRowid);
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
/* ---------- soundboard: each server's uploaded sounds (up to 30, 1 MB each) ---------- */
const soundView = (r) => ({ id: r.id, serverId: r.server_id, userId: r.user_id, name: r.name, emoji: r.emoji || '🔊', url: `/uploads/${r.upload_id}` });
export const soundsOf = (serverId) => all('SELECT * FROM sounds WHERE server_id = ? ORDER BY id', serverId).map(soundView);
export const getSound = (id) => one('SELECT * FROM sounds WHERE id = ?', id);
export function addSound(userId, serverId, d) {
  const name = String(d.name || '').replace(/\s+/g, ' ').trim().slice(0, 24);
  if (!name) fail('Give the sound a name.');
  const up = one('SELECT * FROM uploads WHERE id = ? AND user_id = ?', String(d.uploadId || ''), userId);
  if (!up || !up.type.startsWith('audio/')) fail('Pick an audio file (MP3, WAV, OGG or M4A).');
  if (up.size > 1048576) fail('Sounds can be up to 1 MB. Use a shorter clip.');
  if (one('SELECT COUNT(*) AS n FROM sounds WHERE server_id = ?', serverId).n >= 30) fail('This server already has 30 sounds. Remove one first.');
  const emoji = EMOJI.test(String(d.emoji || '')) ? String(d.emoji) : '🔊';
  run('INSERT INTO sounds (server_id, user_id, name, emoji, upload_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', serverId, userId, name, emoji, up.id, now());
}
export const deleteSound = (id) => run('DELETE FROM sounds WHERE id = ?', id);
export const deleteMessage = (id) => run('DELETE FROM messages WHERE id = ?', id);
export function history(col, targetId, before, limit = 50) {
  const rows = before
    ? all(`SELECT * FROM messages WHERE ${col} = ? AND id < ? ORDER BY id DESC LIMIT ?`, targetId, before, limit)
    : all(`SELECT * FROM messages WHERE ${col} = ? ORDER BY id DESC LIMIT ?`, targetId, limit);
  return decorate(rows.reverse());
}
export function markRead(userId, target, lastId) {
  run(`INSERT INTO reads (user_id, target, last_id) VALUES (?, ?, ?)
       ON CONFLICT (user_id, target) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)`, userId, target, lastId);
}
function mentionCount(userId, target, channelId) {
  const r = one('SELECT last_id FROM reads WHERE user_id = ? AND target = ?', userId, target);
  return one(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM messages WHERE channel_id = ? AND id > ? AND body LIKE ? LIMIT 99)`,
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
                     (SELECT MAX(created_at) FROM messages WHERE dm_id = d.id) AS last_at
              FROM dms d WHERE user_a = ? OR user_b = ?`, userId, userId)
    .filter((d) => d.last_id)
    .map((d) => ({ id: d.id, userId: d.user_a === userId ? d.user_b : d.user_a, lastId: d.last_id, lastAt: d.last_at, unread: unreadCount(userId, `d:${d.id}`, 'dm_id', d.id) }));
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
  for (const r of all('SELECT attachments FROM messages WHERE attachments IS NOT NULL')) for (const a of JSON.parse(r.attachments)) used.add(a.id);
  for (const r of all('SELECT avatar FROM users WHERE avatar IS NOT NULL')) used.add(String(r.avatar).replace('/uploads/', ''));
  for (const r of all('SELECT upload_id FROM sounds')) used.add(r.upload_id);
  return all('SELECT id FROM uploads WHERE created_at < ?', now() - olderThan).map((r) => r.id).filter((id) => !used.has(id));
}
export const forgetUpload = (id) => run('DELETE FROM uploads WHERE id = ?', id);
