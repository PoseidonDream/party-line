/* The live part: one WebSocket per open app. Carries new messages, who's online, who's in which voice
   channel, and relays the WebRTC handshakes that connect voices and screen shares directly between people. */
import { WebSocketServer } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import * as M from './model.js';
import { config } from './config.js';
import * as Bot from './bot.js';
import { previewFor, linksIn, imagePath } from './preview.js';
import * as Push from './push.js';
import QRCode from 'qrcode';

const conns = new Map();     // connId -> { id, ws, userId }
const byUser = new Map();    // userId -> Set(conn)
const voice = new Map();     // userId -> { channelId, serverId, connId, muted, deafened, sharing, screenId, serverMuted, since }
const voiceStatus = new Map();   // voice channelId -> { text, by }: a line like "ranked Valorant 🔥", until the channel empties
let nextConn = 1;
const cmdTimes = new Map();   // userId -> times of recent bot commands
const startedAt = Date.now();
/* Developer log: voice events and errors reported by everyone's app, newest last. Kept in memory only. */
const devLog = [];
function addDevLog(entry) {
  devLog.push(entry);
  if (devLog.length > 500) devLog.splice(0, devLog.length - 500);
  for (const u of M.allUsers()) if (u.admin) toUser(u.id, { t: 'dev.log', entry });
}
function folderSize(dir) {
  let files = 0, bytes = 0;
  try { for (const f of fs.readdirSync(dir)) { try { const st = fs.statSync(path.join(dir, f)); if (st.isFile()) { files++; bytes += st.size; } } catch {} } } catch {}
  return { files, bytes };
}

const send = (c, msg) => { if (c && c.ws.readyState === 1) c.ws.send(JSON.stringify(msg)); };
const toUser = (userId, msg, except) => { for (const c of byUser.get(userId) || []) if (c !== except) send(c, msg); };
const toUsers = (ids, msg) => { for (const id of new Set(ids)) toUser(id, msg); };
const toServer = (serverId, msg) => toUsers(M.memberIds(serverId), msg);
const userView = (id) => { const u = M.getUser(id); return u && Object.assign(M.publicUser(u), presenceOf(id, u)); };
/* What others see: offline when no app is open or the person chose Invisible; idle when they chose it or every
   open app has been untouched for 10 minutes; plus what game the desktop app says they're playing. */
function presenceOf(id, u = M.getUser(id)) {
  const set = byUser.get(id);
  if (!set || !set.size || !u || u.status === 'invisible') return { online: false, status: 'offline', activity: null };
  const cs = [...set];
  const status = u.status === 'dnd' ? 'dnd' : u.status === 'idle' || cs.every((c) => c.idle) ? 'idle' : 'online';
  const act = cs.map((c) => c.activity).find(Boolean) || null;
  return { online: true, status, activity: act };
}
const lastPresence = new Map();   // userId -> what was last announced, to skip repeats
function announce(userId) {
  const p = presenceOf(userId), key = JSON.stringify(p);
  if (lastPresence.get(userId) === key) return;
  lastPresence.set(userId, key);
  const msg = Object.assign({ t: 'presence', userId }, p);
  toWatchers(userId, msg);
}
/* Everyone online who can see this person (see M.canSeeUser). */
const toWatchers = (userId, msg) => { for (const uid of byUser.keys()) if (M.canSeeUser(uid, userId)) toUser(uid, msg); };
const online = (userId) => (byUser.get(userId) || new Set()).size > 0;

/* Push notifications reach people who have no Party Line open, following the same rules as the in-app ones:
   private chats and group chats ring by default, servers only for @mentions and replies, mute is mute, and
   Do Not Disturb silences everything. */
const plainText = (body) => M.readableBody(body)
  .replace(/\|\|[\s\S]*?\|\|/g, '[spoiler]').replace(/```\w*\n?|\*\*|__|~~|[*`]/g, '').replace(/^> /gm, '').replace(/\s+/g, ' ').trim();
function pushIfAway(userId, payload) {
  if (online(userId)) return;
  const u = M.getUser(userId);
  if (!u || u.is_bot || u.status === 'dnd' || !Push.hasPush(userId)) return;
  Push.pushTo(userId, payload);
}
function pushMessage(m, author) {
  const what = plainText(m.body) || (m.attachments && m.attachments.length ? '📎 sent a file' : '');
  if (m.dmId || m.dm_id) {
    const dm = M.getDm(m.dmId || m.dm_id), to = dm.user_a === author.id ? dm.user_b : dm.user_a;
    if ((M.notifyPrefs(to)[`d:${author.id}`] || 'all') === 'mute') return;
    return pushIfAway(to, { title: author.name, body: what, url: `/?dm=${author.id}`, tag: `d:${author.id}` });
  }
  const ch = M.getChannel(m.channelId || m.channel_id), srv = M.getServer(ch.server_id);
  const mentioned = new Set(M.mentionedIds(m.body));
  const replied = m.replyTo || m.reply_to ? M.getMessage(m.replyTo || m.reply_to) : null;
  if (replied) mentioned.add(replied.user_id);
  const hidden = srv.kind === 'group' || srv.kind === 'pair';
  for (const id of M.memberIds(srv.id)) {
    if (id === author.id || online(id) || !Push.hasPush(id)) continue;   // cheap checks first: this runs for every message
    const prefs = M.notifyPrefs(id);
    const level = prefs[`c:${ch.id}`] || prefs[`s:${srv.id}`] || (hidden ? 'all' : 'mentions');
    if (level === 'mute' || (level === 'mentions' && !mentioned.has(id))) continue;
    pushIfAway(id, { title: hidden ? `${author.name} · ${srv.name || 'group chat'}` : `${author.name} in ${ch.kind === 'voice' ? '🔊 ' : '#'}${ch.name} · ${srv.name}`, body: what, url: `/?channel=${ch.id}`, tag: `c:${ch.id}` });
  }
}
const voiceView = (userId, v) => ({ userId, channelId: v.channelId, serverId: v.serverId, muted: v.muted, deafened: v.deafened,
  sharing: v.sharing, camera: !!v.camera, screenId: v.screenId || null, serverMuted: v.serverMuted, since: v.since });
const fail = (msg) => { throw new M.UserError(msg); };
/* Admin action log (developer panel). */
const log = (user, serverId, action, details) => M.audit(user.id, serverId, action, details);
const nm = (id) => (M.getUser(id) || { name: '?' }).name;

export const voiceChannelOf = (userId) => (voice.get(userId) || {}).channelId || null;
export const voiceCount = () => voice.size;
export const hub = {
  /* A forgot-password request: tell every admin who's online (others see it when they open the app). */
  resetRequested(request) { for (const u of M.allUsers()) if (u.admin) toUser(u.id, { t: 'reset.request', request }); },
  userChanged(u) { toWatchers(u.id, { t: 'user', user: userView(u.id) }); toUser(u.id, { t: 'me', me: M.selfView(u) }); announce(u.id); },
  joinedServers(userId) { for (const s of M.serverIdsOf(userId)) toServer(s, { t: 'member', serverId: s, userId, user: userView(userId) }); },
};

/* What Party Bot (bot.js) may do: post messages, react, start polls, and see who's in voice. */
const botHost = {
  games: (where) => shareGames(where),
  post(where, body, replyTo) {
    const b = Bot.botUser();
    try {
      const m = M.postMessage(b.id, where, body, null, replyTo);
      if (where.channelId) { const ch = M.getChannel(where.channelId); toServer(ch.server_id, { t: 'msg', msg: m, serverId: ch.server_id }); }
      else { const dm = M.getDm(where.dmId); toUser(dm.user_a, { t: 'dm', msg: m, withUserId: dm.user_b, user: userView(b.id) }); toUser(dm.user_b, { t: 'dm', msg: m, withUserId: dm.user_a, user: userView(b.id) }); }
      return m;
    } catch (e) { console.error('bot post', e); return null; }   // e.g. the channel was deleted
  },
  /* /poll: a poll card posted by whoever typed it. */
  poll(user, where, question, options) {
    const dm = where.dmId && M.getDm(where.dmId);
    const t = dm ? { toUserId: dm.user_a === user.id ? dm.user_b : dm.user_a } : { channelId: where.channelId };
    return handlers['poll.create'](null, user, Object.assign({ question, options }, t));
  },
  broadcastReactions(m, reactions) { if (m) broadcastAbout(M.getMessage(m.id), { t: 'reactions', id: m.id, channelId: m.channelId || null, dmId: m.dmId || null, reactions }); },
  voiceOf(userId) {
    const v = voice.get(userId), ch = v && M.getChannel(v.channelId);
    return ch ? { channelId: ch.id, serverId: ch.server_id, channelName: ch.name } : null;
  },
  music(serverId, channelId, state) {
    if (serverId == null) { const ch = M.getChannel(channelId); if (!ch) return; serverId = ch.server_id; }
    toServer(serverId, { t: 'music', channelId, state, serverNow: Date.now() });
  },
};
Bot.initBot(botHost);

const groupText = (serverId) => (M.serverView(serverId, 0).channels.find((x) => x.kind === 'text') || {}).id;
function sendServerTo(userId, serverId) {
  toUser(userId, { t: 'server', server: M.serverView(serverId, userId), users: M.memberIds(serverId).map(userView),
    voice: [...voice].filter(([, v]) => v.serverId === serverId).map(([id, v]) => voiceView(id, v)), emoji: M.emojiOf(serverId) });
}
/* Channels, categories or roles changed: everyone in the server gets its fresh view (unread counts are per person). */
function refreshServer(serverId) {
  for (const id of M.memberIds(serverId)) if (online(id)) toUser(id, { t: 'server', server: M.serverView(serverId, id) });
}
const shareEvents = (serverId) => toServer(serverId, { t: 'events', serverId, events: M.eventsOf(serverId) });
/* 15 minutes before an event: Party Bot pings everyone going. */
setInterval(() => {
  for (const e of M.eventsToRemind()) {
    if (!e.announce_channel_id) continue;
    const going = M.eventView(e).going.map((id) => `<@${id}>`).join(' ');
    const where = e.channel_id ? ` in 🔊 ${(M.getChannel(e.channel_id) || {}).name}` : '';
    botHost.post({ channelId: e.announce_channel_id }, `⏰ **${e.title}** starts <t:${Math.floor(e.starts_at / 1000)}:R>${where}!` + (going ? ` ${going}` : ''));
  }
}, 30_000).unref();

function readyFor(user) {
  const servers = M.serverIdsOf(user.id).map((id) => M.serverView(id, user.id)).filter(Boolean);
  const mine = new Set(servers.map((s) => s.id));
  return {
    t: 'ready',
    me: M.selfView(user),
    users: M.visibleUsers(user.id).map((u) => Object.assign(u, presenceOf(u.id))),
    servers,
    friends: M.friendsOf(user.id),
    dms: M.dmsOf(user.id),
    voice: [...voice].filter(([, v]) => mine.has(v.serverId)).map(([id, v]) => voiceView(id, v)),
    previews: [...voice].filter(([, v]) => mine.has(v.serverId) && v.preview).map(([userId, v]) => ({ userId, img: v.preview })),
    voiceStatus: [...voiceStatus].filter(([chId]) => { const ch = M.getChannel(chId); return ch && mine.has(ch.server_id); }).map(([channelId, st]) => ({ channelId, status: st })),
    music: Bot.musicStates(mine),
    events: [...mine].flatMap((id) => M.eventsOf(id)),
    sounds: [...mine].flatMap((id) => M.soundsOf(id)),
    emoji: [...mine].flatMap((id) => M.emojiOf(id)),
    gifs: M.favGifs(user.id),
    bookmarks: M.bookmarkIds(user.id),
    commands: Bot.COMMAND_LIST,
    serverNow: Date.now(),
    resets: user.is_admin ? M.pendingResets() : [],
    notify: M.notifyPrefs(user.id),
  };
}

function leaveVoice(userId, reason) {
  const v = voice.get(userId);
  if (!v) return;
  voice.delete(userId);
  toServer(v.serverId, { t: 'voice.left', userId, channelId: v.channelId, serverId: v.serverId });
  if (![...voice.values()].some((x) => x.channelId === v.channelId)) {
    Bot.voiceEmptied(v.channelId);
    if (voiceStatus.delete(v.channelId)) toServer(v.serverId, { t: 'voice.status', channelId: v.channelId, status: null });
    toServer(v.serverId, { t: 'ring.stop', channelId: v.channelId });
  }
  if (reason) { const c = conns.get(v.connId); send(c, { t: 'voice.kicked', reason }); }
}

const handlers = {
  ping: () => ({ pong: Date.now() }),

  /* ---- messages ---- */
  'msg.send'(c, user, d) {
    const command = Bot.isCommand(d.body) && !(d.attachments || []).length;
    if (command) {
      // At most 8 bot commands per person every 10 s.
      const now = Date.now(), recent = (cmdTimes.get(user.id) || []).filter((t) => now - t < 10_000);
      if (recent.length >= 8) return { command: true, ephemeral: 'Slow down a little. Try that again in a few seconds.' };
      recent.push(now); cmdTimes.set(user.id, recent);
    }
    if (d.channelId) {
      const ch = M.getChannel(Number(d.channelId));
      if (!ch || !M.isMember(user.id, ch.server_id)) fail('You can’t post there.');   // text channels, and voice channels' own chat
      if (command) return Bot.runCommand(user, { channelId: ch.id }, d.body).then((r) => Object.assign({ command: true }, r));
      const m = M.postMessage(user.id, { channelId: ch.id }, d.body, d.attachments, d.replyTo);
      toServer(ch.server_id, { t: 'msg', msg: m, serverId: ch.server_id, nonce: d.nonce });
      gainXp(ch.server_id, user.id, 10, true, { channelId: ch.id });
      pushMessage(m, user);
      addPreviews(M.getMessage(m.id)).catch(() => {});
      return { msg: m };
    }
    const other = M.getUser(Number(d.toUserId));
    if (!other) fail('That person doesn’t exist.');
    const shares = M.serverIdsOf(user.id).some((s) => M.isMember(other.id, s));
    if (M.friendState(user.id, other.id) !== 'friends' && !shares) fail(`Add ${other.name} as a friend first.`);
    const dm = M.dmWith(user.id, other.id, true);
    if (command) return Bot.runCommand(user, { dmId: dm.id }, d.body).then((r) => Object.assign({ command: true }, r));
    const m = M.postMessage(user.id, { dmId: dm.id }, d.body, d.attachments, d.replyTo);
    toUser(user.id, { t: 'dm', msg: m, withUserId: other.id, nonce: d.nonce });
    toUser(other.id, { t: 'dm', msg: m, withUserId: user.id, user: userView(user.id) });
    pushMessage(m, user);
    addPreviews(M.getMessage(m.id)).catch(() => {});
    return { msg: m };
  },
  /* Polls (see M.createPoll). Targets like msg.send: { channelId } or { toUserId }. */
  'poll.create'(c, user, d) {
    const id = M.createPoll(user.id, d);
    try { return handlers['msg.send'](c, user, { channelId: d.channelId, toUserId: d.toUserId, body: `<poll:${id}>`, attachments: [] }); }
    catch (e) { M.closePoll(id); throw e; }
  },
  'poll.vote'(c, user, d) {
    const p = M.getPoll(Number(d.id)), m = p && p.message_id && M.getMessage(p.message_id);
    if (!m || !canSee(user.id, m)) fail('That poll is gone.');
    M.votePoll(p.id, user.id, d.option, !!d.on);
    sharePoll(p.id);
    return { mine: M.myPollVotes(p.id, user.id) };
  },
  'poll.end'(c, user, d) {
    const p = M.getPoll(Number(d.id)), m = p && p.message_id && M.getMessage(p.message_id);
    if (!m || !canSee(user.id, m)) fail('That poll is gone.');
    const mod = m.channel_id && M.can(user, M.getServer(M.getChannel(m.channel_id).server_id), 'messages');
    if (p.created_by !== user.id && !mod) fail('Only whoever made the poll (or a moderator) can end it.');
    if (!p.closed) finishPoll(p);
    return {};
  },
  'remind.set'(c, user, d) {
    const m = M.getMessage(Number(d.id));
    if (!m || !canSee(user.id, m)) fail('That message is gone.');
    let jump = `c:${m.channel_id}`;
    if (m.dm_id) { const dm = M.getDm(m.dm_id); jump = `d:${dm.user_a === user.id ? dm.user_b : dm.user_a}`; }
    M.addMsgReminder(user.id, m.id, jump, d.at);
    return {};
  },
  /* Disappearing messages: either person in a private chat (or anyone in a group chat) can change it. */
  'disappear.set'(c, user, d) {
    let where, target, tell;
    if (d.serverId) {
      const srv = M.getServer(Number(d.serverId));
      if (!srv || srv.kind !== 'group' || !M.isMember(user.id, srv.id)) fail('Only group chats can do that.');
      target = { serverId: srv.id }; where = { channelId: groupText(srv.id) };
      tell = () => refreshServer(srv.id);
    } else {
      const other = M.getUser(Number(d.userId));
      if (!other || other.id === user.id) fail('That person doesn’t exist.');
      if (M.friendState(user.id, other.id) !== 'friends' && !M.serverIdsOf(user.id).some((s) => M.isMember(other.id, s))) fail(`Add ${other.name} as a friend first.`);
      const dm = M.dmWith(user.id, other.id, true);
      target = { dmId: dm.id }; where = { dmId: dm.id };
      tell = () => toUsers([dm.user_a, dm.user_b], { t: 'disappear', dmId: dm.id, users: [dm.user_a, dm.user_b], seconds: M.getDm(dm.id).disappear || 0 });
    }
    const secs = M.setDisappear(target, d.seconds);
    tell();
    const len = secs >= 86400 ? `${Math.round(secs / 86400)} day${secs >= 172800 ? 's' : ''}`.replace('1 day', '24 hours') : `${secs} seconds`;
    botHost.post(where, secs ? `⏳ **${user.name}** turned on disappearing messages: new messages here delete themselves after ${len}.` : `⏳ **${user.name}** turned off disappearing messages. New messages stay.`);
    return {};
  },
  'bookmark.set'(c, user, d) {
    const m = M.getMessage(Number(d.id));
    if (!m || !canSee(user.id, m)) fail('That message is gone.');
    M.setBookmark(user.id, m.id, !!d.on);
    toUser(user.id, { t: 'bookmarks', ids: M.bookmarkIds(user.id) });
    return {};
  },
  /* Send later. Targets like msg.send: { channelId } or { toUserId }. */
  'later.list'(c, user, d) { return { list: M.scheduledFor(user.id, laterTarget(user, d)) }; },
  'later.add'(c, user, d) {
    const t = laterTarget(user, d);
    if (Bot.isCommand(d.body)) fail('Bot commands can’t be sent later. Send them now instead.');
    M.addScheduled(user.id, t, d.body, d.sendAt);
    toUser(user.id, { t: 'later', ...t, list: M.scheduledFor(user.id, t) });
    return {};
  },
  'later.cancel'(c, user, d) {
    const r = M.getScheduled(Number(d.id));
    if (!r || r.user_id !== user.id) return {};
    M.deleteScheduled(r.id);
    const t = r.channel_id ? { channelId: r.channel_id } : { toUserId: r.to_user_id };
    toUser(user.id, { t: 'later', ...t, list: M.scheduledFor(user.id, t) });
    return {};
  },
  'msg.edit'(c, user, d) {
    const m = M.getMessage(Number(d.id));
    if (!m || m.user_id !== user.id) fail('You can only edit your own messages.');
    const out = M.editMessage(m.id, d.body);
    broadcastAbout(m, { t: 'msg.edit', msg: out });
    addPreviews(M.getMessage(m.id)).catch(() => {});
    return {};
  },
  'msg.delete'(c, user, d) {
    const m = M.getMessage(Number(d.id));
    if (!m) return {};
    let ok = m.user_id === user.id || !!user.is_admin;
    if (!ok && m.channel_id) ok = M.can(user, M.getServer(M.getChannel(m.channel_id).server_id), 'messages');
    if (!ok) fail('You can only delete your own messages.');
    if (m.user_id !== user.id) log(user, m.channel_id ? M.getChannel(m.channel_id).server_id : null, 'Deleted a message', `by ${nm(m.user_id)}${m.channel_id ? ` in #${M.getChannel(m.channel_id).name}` : ''}: “${String(m.body || '(file)').slice(0, 80)}”`);
    M.deleteMessage(m.id);
    broadcastAbout(m, { t: 'msg.del', id: m.id, channelId: m.channel_id, dmId: m.dm_id });
    return {};
  },
  'msg.pin'(c, user, d) {
    const m = M.getMessage(Number(d.id));
    if (!m || !canSee(user.id, m)) fail('That message is gone.');
    if (!!m.pinned_at === !!d.on) return {};
    const out = M.pin(m.id, user.id, !!d.on);
    broadcastAbout(m, { t: 'msg.edit', msg: out });
    if (d.on) botHost.post(m.channel_id ? { channelId: m.channel_id } : { dmId: m.dm_id }, `📌 **${user.name}** pinned a message. See all pinned messages with the 📌 button at the top.`, m.id);
    return {};
  },
  react(c, user, d) {
    const m = M.getMessage(Number(d.id));
    if (!m || !canSee(user.id, m)) fail('That message is gone.');
    const reactions = M.react(user.id, m.id, d.emoji, !!d.on);
    broadcastAbout(m, { t: 'reactions', id: m.id, channelId: m.channel_id, dmId: m.dm_id, reactions });
    return {};
  },
  typing(c, user, d) {
    if (d.channelId) {
      const ch = M.getChannel(Number(d.channelId));
      if (!ch || !M.isMember(user.id, ch.server_id)) return {};
      for (const id of M.memberIds(ch.server_id)) if (id !== user.id) toUser(id, { t: 'typing', userId: user.id, channelId: ch.id });
    } else if (d.toUserId) {
      const other = Number(d.toUserId);
      if (M.friendState(user.id, other) === 'friends' || M.serverIdsOf(user.id).some((s) => M.isMember(other, s))) toUser(other, { t: 'typing', userId: user.id, dmUserId: user.id });
    }
    return {};
  },
  read(c, user, d) {
    const target = String(d.target || '');
    if (!/^[cd]:\d+$/.test(target)) return {};
    M.markRead(user.id, target, Number(d.id) || 0);
    toUser(user.id, { t: 'read', target, id: Number(d.id) || 0 }, c);
    // Read receipts: the other person in a private chat sees "Seen".
    if (target.startsWith('d:')) { const dm = M.getDm(Number(target.slice(2))); if (dm && (dm.user_a === user.id || dm.user_b === user.id)) toUser(dm.user_a === user.id ? dm.user_b : dm.user_a, { t: 'seen', dmId: dm.id, userId: user.id, id: Number(d.id) || 0 }); }
    return {};
  },

  /* ---- servers and channels ---- */
  'server.create'(c, user, d) {
    const id = M.createServer(user.id, d.name);
    toUser(user.id, { t: 'server', server: M.serverView(id, user.id), users: [userView(user.id)] });
    return { id };
  },
  'server.join'(c, user, d) {
    const code = String(d.invite || '').trim().replace(/^.*\/invite\//, '');
    const found = M.serverForInvite(code), s = found && found.server;
    if (!s || (s.kind || 'server') !== 'server') fail('That invite doesn’t work. Ask for a new one.');
    if (!M.isMember(user.id, s.id)) {
      if (found.invite) M.useInvite(found.invite.code);
      M.joinServer(user.id, s.id);
      toServer(s.id, { t: 'member', serverId: s.id, userId: user.id, user: userView(user.id) });
    }
    toUser(user.id, { t: 'server', server: M.serverView(s.id, user.id), users: M.memberIds(s.id).map(userView), voice: [...voice].filter(([, v]) => v.serverId === s.id).map(([id, v]) => voiceView(id, v)) });
    return { id: s.id };
  },
  'server.leave'(c, user, d) {
    const s = M.getServer(Number(d.id));
    if (!s) return {};
    removeFromServer(user.id, s.id);
    if (s.kind === 'group') {
      if (!M.memberIds(s.id).length) M.deleteServer(s.id);
      else { const t = M.getChannel(groupText(s.id)); if (t) botHost.post({ channelId: t.id }, `👋 **${user.name}** left the group.`); }
    }
    return {};
  },
  /* Game ideas for a chat (see M.gamesOf). Targets: { channelId } or { userId } for a private chat. */
  'games.list'(c, user, d) { const w = gameWhere(user, d, false); return { games: w ? M.gamesOf(w) : [] }; },
  'games.add'(c, user, d) {
    const w = gameWhere(user, d, true);
    M.addGame(user.id, w, d);
    shareGames(w);
    return {};
  },
  'games.vote'(c, user, d) { const { g, w } = gameFor(user, d.id); M.voteGame(user.id, g.id, !!d.on); shareGames(w); return {}; },
  'games.played'(c, user, d) { const { g, w } = gameFor(user, d.id); M.setGamePlayed(g.id, !!d.on); shareGames(w); return {}; },
  'games.delete'(c, user, d) {
    const { g, w } = gameFor(user, d.id);
    const mod = g.channel_id && M.can(user, M.getServer(M.getChannel(g.channel_id).server_id), 'messages');
    if (g.user_id !== user.id && !mod) fail('Only whoever suggested it (or a moderator) can remove it.');
    M.deleteGame(g.id);
    shareGames(w);
    return {};
  },
  'games.poll'(c, user, d) { return Bot.startGamePoll(user, gameWhere(user, d, true), d.minutes); },
  /* 🎲: Party Bot picks one of the games nobody has ticked off yet; more votes, better odds. */
  'games.pick'(c, user, d) {
    const w = gameWhere(user, d, false);
    const open = w ? M.gamesOf(w).filter((g) => !g.playedAt) : [];
    if (!open.length) fail('Add some games first (or untick one you’ve played).');
    const tickets = open.flatMap((g) => Array(1 + g.votes.length).fill(g));
    const g = tickets[Math.floor(Math.random() * tickets.length)];
    const why = g.votes.length > 1 ? ` (${g.votes.length} votes)` : '';
    botHost.post(w, `🎲 ${user.name} asked me to pick a game… **${g.name}**!${why}${g.url ? ` ${g.url}` : ''}`);
    return {};
  },
  'server.afk'(c, user, d) {
    const s = M.getServer(Number(d.id));
    if (!s || !M.can(user, s, 'server')) fail('You need the Manage server permission for that.');
    M.setAfkChannel(s.id, d.channelId || null);
    const ch = d.channelId ? M.getChannel(Number(d.channelId)) : null;
    log(user, s.id, 'Changed the AFK channel', ch ? `🔊 ${ch.name}` : 'off');
    refreshServer(s.id);
    return {};
  },
  'server.rename'(c, user, d) {
    const s = M.getServer(Number(d.id));
    if (!s || !(M.can(user, s, 'server') || (s.kind === 'group' && M.isMember(user.id, s.id)))) fail('You need the Manage server permission to rename it.');
    const name = String(d.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!name) fail('Give the server a name.');
    log(user, s.id, 'Renamed the server', `“${s.name}” → “${name}”`);
    M.renameServer(s.id, name);
    toServer(s.id, { t: 'server.renamed', id: s.id, name });
    return {};
  },
  /* ---- group chats and calls ---- */
  'group.create'(c, user, d) {
    const id = M.createGroup(user.id, d.userIds, d.name);
    for (const uid of M.memberIds(id)) sendServerTo(uid, id);
    const names = M.memberIds(id).filter((x) => x !== user.id).map((x) => M.getUser(x).name).join(', ');
    botHost.post({ channelId: groupText(id) }, `👋 **${user.name}** started a group chat with ${names}.`);
    return { id };
  },
  'group.add'(c, user, d) {
    const s = M.getServer(Number(d.serverId));
    if (!s || s.kind !== 'group' || !M.isMember(user.id, s.id)) fail('That group is gone.');
    const add = [...new Set((d.userIds || []).map(Number))].filter((id) => !M.isMember(id, s.id) && M.getUser(id) && M.canSeeUser(user.id, id));
    if (!add.length) return {};
    if (M.memberIds(s.id).length + add.length > 10) fail('Group chats can have up to 10 people.');
    for (const id of add) M.joinServer(id, s.id);
    for (const id of M.memberIds(s.id)) sendServerTo(id, s.id);
    botHost.post({ channelId: groupText(s.id) }, `➕ **${user.name}** added ${add.map((id) => `**${M.getUser(id).name}**`).join(', ')} to the group.`);
    return {};
  },
  /* A 1-on-1 call: the hidden room for the two of you. The client then joins its voice channel, which rings. */
  'call.start'(c, user, d) {
    const other = M.getUser(Number(d.userId));
    if (!other || other.is_bot || other.id === user.id) fail('You can’t call them.');
    if (M.friendState(user.id, other.id) !== 'friends' && !M.serverIdsOf(user.id).some((s) => M.isMember(other.id, s))) fail(`Add ${other.name} as a friend first.`);
    const room = M.pairRoom(user.id, other.id);
    if (room.created) { sendServerTo(user.id, room.id); sendServerTo(other.id, room.id); }
    const ch = M.serverView(room.id, user.id).channels.find((x) => x.kind === 'voice');
    return { serverId: room.id, channelId: ch.id };
  },
  'server.delete'(c, user, d) {
    const s = M.getServer(Number(d.id));
    if (!s || !M.canManage(user, s)) fail('Only the server’s owner can delete it.');
    if (s.is_default) fail('The main server can’t be deleted.');
    log(user, null, 'Deleted a server', s.name);
    const ids = M.memberIds(s.id);
    for (const [uid, v] of voice) if (v.serverId === s.id) leaveVoice(uid, 'deleted');
    M.deleteServer(s.id);
    toUsers(ids, { t: 'server.gone', id: s.id });
    return {};
  },
  'chan.create'(c, user, d) {
    const s = M.getServer(Number(d.serverId));
    if (!s || !M.isMember(user.id, s.id)) fail('You’re not in that server.');
    const ch = M.createChannel(s.id, d.kind, d.name);
    toServer(s.id, { t: 'chan', channel: { id: ch.id, serverId: s.id, kind: ch.kind, name: ch.name, position: ch.position, lastId: 0, unread: 0 } });
    return { id: ch.id };
  },
  'chan.delete'(c, user, d) {
    const ch = M.getChannel(Number(d.id));
    if (!ch) return {};
    if (!M.can(user, M.getServer(ch.server_id), 'channels')) fail('You need the Manage channels permission to delete channels.');
    for (const [uid, v] of voice) if (v.channelId === ch.id) leaveVoice(uid, 'deleted');
    log(user, ch.server_id, 'Deleted a channel', `${ch.kind === 'text' ? '#' : '🔊 '}${ch.name}`);
    M.deleteChannel(ch.id);
    toServer(ch.server_id, { t: 'chan.del', id: ch.id, serverId: ch.server_id });
    return {};
  },

  'chan.edit'(c, user, d) {
    const ch = M.getChannel(Number(d.id));
    if (!ch || !M.can(user, M.getServer(ch.server_id), 'channels')) fail('You need the Manage channels permission.');
    log(user, ch.server_id, 'Edited a channel', `${ch.kind === 'text' ? '#' : '🔊 '}${ch.name}${d.name && d.name !== ch.name ? ` → ${d.name}` : ''}${d.topic !== undefined ? ' (topic)' : ''}`);
    M.editChannel(ch.id, d);
    refreshServer(ch.server_id);
    return {};
  },
  'chan.move'(c, user, d) {
    const ch = M.getChannel(Number(d.id));
    if (!ch || !M.can(user, M.getServer(ch.server_id), 'channels')) fail('You need the Manage channels permission.');
    M.moveChannel(ch.id, d.categoryId || null, d.beforeId || null);
    refreshServer(ch.server_id);
    return {};
  },
  'cat.create'(c, user, d) {
    const s = M.getServer(Number(d.serverId));
    if (!s || !M.can(user, s, 'channels')) fail('You need the Manage channels permission.');
    const id = M.createCategory(s.id, d.name);
    log(user, s.id, 'Created a category', d.name);
    refreshServer(s.id);
    return { id };
  },
  'cat.rename'(c, user, d) {
    const cat = M.getCategory(Number(d.id));
    if (!cat || !M.can(user, M.getServer(cat.server_id), 'channels')) fail('You need the Manage channels permission.');
    M.renameCategory(cat.id, d.name);
    refreshServer(cat.server_id);
    return {};
  },
  'cat.delete'(c, user, d) {
    const cat = M.getCategory(Number(d.id));
    if (!cat || !M.can(user, M.getServer(cat.server_id), 'channels')) fail('You need the Manage channels permission.');
    log(user, cat.server_id, 'Deleted a category', cat.name);
    M.deleteCategory(cat.id);
    refreshServer(cat.server_id);
    return {};
  },

  /* ---- roles ---- */
  'role.create'(c, user, d) {
    const s = M.getServer(Number(d.serverId));
    if (!s || !M.can(user, s, 'server')) fail('You need the Manage server permission.');
    const id = M.createRole(s.id, d);
    log(user, s.id, 'Created a role', d.name);
    refreshServer(s.id);
    return { id };
  },
  'role.edit'(c, user, d) {
    const r = M.getRole(Number(d.id));
    if (!r || !M.can(user, M.getServer(r.server_id), 'server')) fail('You need the Manage server permission.');
    log(user, r.server_id, 'Changed a role', `${r.name}${d.perms ? ` (can: ${d.perms.join(', ') || 'nothing'})` : ''}`);
    M.editRole(r.id, d);
    refreshServer(r.server_id);
    return {};
  },
  'role.delete'(c, user, d) {
    const r = M.getRole(Number(d.id));
    if (!r || !M.can(user, M.getServer(r.server_id), 'server')) fail('You need the Manage server permission.');
    log(user, r.server_id, 'Deleted a role', r.name);
    M.deleteRole(r.id);
    refreshServer(r.server_id);
    return {};
  },
  'role.assign'(c, user, d) {
    const r = M.getRole(Number(d.roleId));
    if (!r || !M.can(user, M.getServer(r.server_id), 'server')) fail('You need the Manage server permission.');
    M.assignRole(r.server_id, Number(d.userId), r.id, !!d.on);
    log(user, r.server_id, d.on ? 'Gave a role' : 'Took a role away', `${r.name} ${d.on ? 'to' : 'from'} ${nm(Number(d.userId))}`);
    refreshServer(r.server_id);
    return {};
  },

  /* ---- profile ---- */
  'profile.rename'(c, user, d) { hub.userChanged(M.rename(user.id, d.name)); return {}; },

  /* ---- friends ---- */
  'friend.request'(c, user, d) {
    const r = M.requestFriend(user.id, d.name);
    toUser(user.id, { t: 'friend', id: r.other.id, state: r.state, user: userView(r.other.id) });
    toUser(r.other.id, { t: 'friend', id: user.id, state: r.state === 'friends' ? 'friends' : 'incoming', user: userView(user.id) });
    if (r.state !== 'friends') pushIfAway(r.other.id, { title: 'Friend request', body: `${user.name} wants to be friends.`, url: '/?friends=1', tag: `friend:${user.id}` });
    return { state: r.state, name: r.other.name };
  },
  'friend.accept'(c, user, d) {
    const id = Number(d.id);
    M.acceptFriend(user.id, id);
    toUser(user.id, { t: 'friend', id, state: 'friends', user: userView(id) });
    toUser(id, { t: 'friend', id: user.id, state: 'friends', user: userView(user.id) });
    return {};
  },
  'friend.remove'(c, user, d) {
    const id = Number(d.id);
    M.removeFriend(user.id, id);
    toUser(user.id, { t: 'friend', id, state: null });
    toUser(id, { t: 'friend', id: user.id, state: null });
    return {};
  },

  /* ---- voice ---- */
  'voice.join'(c, user, d) {
    const ch = M.getChannel(Number(d.channelId));
    if (!ch || ch.kind !== 'voice' || !M.isMember(user.id, ch.server_id)) fail('You can’t join that voice channel.');
    const old = voice.get(user.id);
    if (old && old.connId !== c.id) leaveVoice(user.id, 'other-device');
    else if (old) leaveVoice(user.id);
    const v = { channelId: ch.id, serverId: ch.server_id, connId: c.id, muted: !!d.muted, deafened: !!d.deafened,
      sharing: false, screenId: null, serverMuted: old ? old.serverMuted : false, since: Date.now() };
    const wasEmpty = ![...voice.values()].some((x) => x.channelId === ch.id);
    voice.set(user.id, v);
    toServer(ch.server_id, { t: 'voice', state: voiceView(user.id, v) });
    // Starting a call in a group chat or a 1-on-1 call room rings everyone else.
    const srv = M.getServer(ch.server_id);
    if (wasEmpty && srv.kind && srv.kind !== 'server') {
      for (const id of M.memberIds(srv.id)) if (id !== user.id) {
        toUser(id, { t: 'ring', from: user.id, serverId: srv.id, channelId: ch.id });
        if ((M.notifyPrefs(id)[`s:${srv.id}`] || 'all') !== 'mute') pushIfAway(id, { title: `📞 ${user.name} is calling`, body: srv.kind === 'group' ? (srv.name || 'Group call') : 'Open Party Line to answer.', url: `/?call=${ch.id}`, tag: `call:${srv.id}`, call: true });
      }
    }
    return { peers: [...voice].filter(([id, x]) => id !== user.id && x.channelId === ch.id).map(([id]) => id) };
  },
  /* ---- status and profile ---- */
  'profile.set'(c, user, d) {
    const u = M.setProfile(user.id, d || {});
    if (Object.keys(d || {}).every((k) => k === 'newsSeen')) return {};   // nothing others can see
    hub.userChanged(u);
    if (d.birthday) Bot.birthdays();   // set to today: the wish comes right away
    return {};
  },
  'presence.idle'(c, user, d) { c.idle = !!d.idle; announce(user.id); return {}; },
  'presence.activity'(c, user, d) {
    c.activity = typeof d.name === 'string' ? d.name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) || null : null;
    announce(user.id);
    return {};
  },
  /* ---- soundboard ---- */
  'sound.add'(c, user, d) {
    const srv = M.getServer(Number(d.serverId));
    if (!srv || !M.isMember(user.id, srv.id)) fail('You’re not in that server.');
    M.addSound(user.id, srv.id, d);
    toServer(srv.id, { t: 'sounds', serverId: srv.id, sounds: M.soundsOf(srv.id) });
    return {};
  },
  'emoji.add'(c, user, d) {
    const srv = M.getServer(Number(d.serverId));
    if (!srv || !M.isMember(user.id, srv.id)) fail('You’re not in that server.');
    M.addEmoji(user.id, srv.id, d);
    toServer(srv.id, { t: 'emoji', serverId: srv.id, emoji: M.emojiOf(srv.id) });
    return {};
  },
  'emoji.delete'(c, user, d) {
    const e = M.getEmoji(Number(d.id));
    if (!e) return {};
    if (e.user_id !== user.id && !M.can(user, M.getServer(e.server_id), 'messages')) fail('Only whoever added it (or a moderator) can remove it.');
    if (e.user_id !== user.id) log(user, e.server_id, `Removed ${e.kind === 'emoji' ? 'an emoji' : 'a sticker'}`, `:${e.name}: (by ${nm(e.user_id)})`);
    M.deleteEmoji(e.id);
    toServer(e.server_id, { t: 'emoji', serverId: e.server_id, emoji: M.emojiOf(e.server_id) });
    return {};
  },
  'gif.fav'(c, user, d) {
    const gifs = M.setFavGif(user.id, d.id, !!d.on);
    toUser(user.id, { t: 'gifs', gifs });
    return {};
  },
  'sound.delete'(c, user, d) {
    const snd = M.getSound(Number(d.id));
    if (!snd) return {};
    if (snd.user_id !== user.id && !M.can(user, M.getServer(snd.server_id), 'messages')) fail('Only whoever added the sound (or a moderator) can remove it.');
    if (snd.user_id !== user.id) log(user, snd.server_id, 'Removed a sound', `${snd.name} (by ${nm(snd.user_id)})`);
    M.deleteSound(snd.id);
    toServer(snd.server_id, { t: 'sounds', serverId: snd.server_id, sounds: M.soundsOf(snd.server_id) });
    return {};
  },
  'sound.play'(c, user, d) {
    const v = voice.get(user.id);
    if (!v || v.connId !== c.id) fail('Join a voice channel to use the soundboard.');
    const now = Date.now();
    if (now - (c.lastSound || 0) < 1500) return {};   // one sound every 1.5 s per person
    c.lastSound = now;
    const msg = { t: 'sound', userId: user.id };
    if (d.builtin) { if (!/^[a-z]{2,16}$/.test(String(d.builtin))) fail('Unknown sound.'); msg.builtin = d.builtin; }
    else {
      const snd = M.getSound(Number(d.id));
      if (!snd || snd.server_id !== v.serverId) fail('That sound is gone.');
      Object.assign(msg, { url: `/uploads/${snd.upload_id}`, name: snd.name, emoji: snd.emoji });
    }
    for (const [id, x] of voice) if (x.channelId === v.channelId) toUser(id, msg);
    return {};
  },
  /* ---- events ---- */
  'event.create'(c, user, d) {
    const srv = M.getServer(Number(d.serverId));
    if (!srv || !M.isMember(user.id, srv.id)) fail('You’re not in that server.');
    const e = M.createEvent(user.id, srv.id, d);
    shareEvents(srv.id);
    if (e.announce_channel_id) botHost.post({ channelId: e.announce_channel_id }, `📅 **${user.name}** planned **${e.title}** for <t:${Math.floor(e.starts_at / 1000)}>. Open **Events** at the top to say if you’re going.`);
    return { id: e.id };
  },
  'event.rsvp'(c, user, d) {
    const e = M.getEvent(Number(d.id));
    if (!e || !M.isMember(user.id, e.server_id)) fail('That event is gone.');
    M.rsvp(e.id, user.id, d.state);
    shareEvents(e.server_id);
    return {};
  },
  'event.delete'(c, user, d) {
    const e = M.getEvent(Number(d.id));
    if (!e) return {};
    if (e.creator_id !== user.id && !M.can(user, M.getServer(e.server_id), 'messages')) fail('Only whoever made the event (or a moderator) can cancel it.');
    if (e.creator_id !== user.id) log(user, e.server_id, 'Cancelled an event', `${e.title} (by ${nm(e.creator_id)})`);
    M.deleteEvent(e.id);
    shareEvents(e.server_id);
    if (e.announce_channel_id && e.starts_at > Date.now()) botHost.post({ channelId: e.announce_channel_id }, `🚫 **${e.title}** was cancelled by **${user.name}**.`);
    return {};
  },
  'music.event'(c, user, d) { return Bot.musicEvent(user, d); },
  'music.control'(c, user, d) { return Bot.musicControl(user, String(d.action || '')); },
  'music.watch'(c, user, d) {
    const m = M.getMessage(Number(d.id));
    if (!m || !canSee(user.id, m)) fail('That message is gone.');
    const att = (m.attachments ? JSON.parse(m.attachments) : []).find((a) => a.url === d.url && /^video\//.test(a.type));
    if (!att) fail('That video is gone.');
    return Bot.watchFile(user, m.channel_id ? { channelId: m.channel_id } : { dmId: m.dm_id }, att);
  },
  'voice.leave'(c, user) {
    const v = voice.get(user.id);
    if (v && v.connId === c.id) leaveVoice(user.id);
    return {};
  },
  'voice.state'(c, user, d) {
    const v = voice.get(user.id);
    if (!v || v.connId !== c.id) return {};
    v.muted = !!d.muted; v.deafened = !!d.deafened; v.sharing = !!d.sharing;
    v.screenId = d.sharing && typeof d.screenId === 'string' ? d.screenId.slice(0, 80) : null;
    v.camera = !!d.camera;
    if (!v.sharing && v.preview) { v.preview = null; toServer(v.serverId, { t: 'voice.preview', userId: user.id, img: null }); }
    toServer(v.serverId, { t: 'voice', state: voiceView(user.id, v) });
    return {};
  },
  /* Voice channel status: anyone in the channel (or who can manage channels) sets a short line everyone sees
     under the channel's name. It clears when the last person leaves. */
  'voice.status'(c, user, d) {
    const ch = M.getChannel(Number(d.channelId));
    if (!ch || ch.kind !== 'voice' || !M.isMember(user.id, ch.server_id)) fail('That voice channel is gone.');
    const v = voice.get(user.id);
    if (!(v && v.channelId === ch.id) && !M.can(user, M.getServer(ch.server_id), 'channels')) fail('Join the voice channel to set its status.');
    if (![...voice.values()].some((x) => x.channelId === ch.id)) fail('Nobody is in that channel, so there’s nothing to set a status for.');
    const text = String(d.text || '').replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (text) voiceStatus.set(ch.id, { text, by: user.id }); else voiceStatus.delete(ch.id);
    toServer(ch.server_id, { t: 'voice.status', channelId: ch.id, status: text ? { text, by: user.id } : null });
    return {};
  },
  /* Go Live preview: whoever shares their screen sends a small snapshot every so often, so people in the server
     can peek before joining. Kept only in memory, and only while they share. */
  'voice.preview'(c, user, d) {
    const v = voice.get(user.id);
    if (!v || v.connId !== c.id || !v.sharing) return {};
    const img = String(d.img || '');
    if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(img) || img.length > 120_000) fail('That preview is too big.');
    v.preview = img;
    toServer(v.serverId, { t: 'voice.preview', userId: user.id, img });
    return {};
  },
  rtc(c, user, d) {
    const me = voice.get(user.id), them = voice.get(Number(d.to));
    if (!me || !them || me.connId !== c.id || me.channelId !== them.channelId) return {};
    send(conns.get(them.connId), { t: 'rtc', from: user.id, data: d.data });
    return {};
  },

  /* ---- admin ---- */
  'admin.voiceKick'(c, user, d) {
    const v = voice.get(Number(d.userId));
    if (!v) return {};
    if (!M.can(user, M.getServer(v.serverId), 'voice')) fail('You need the Moderate voice permission.');
    log(user, v.serverId, 'Disconnected from voice', nm(Number(d.userId)));
    leaveVoice(Number(d.userId), 'admin');
    return {};
  },
  'admin.mute'(c, user, d) {
    const v = voice.get(Number(d.userId));
    if (!v) return {};
    if (!M.can(user, M.getServer(v.serverId), 'voice')) fail('You need the Moderate voice permission.');
    v.serverMuted = !!d.on;
    log(user, v.serverId, d.on ? 'Muted for everyone' : 'Unmuted', nm(Number(d.userId)));
    toServer(v.serverId, { t: 'voice', state: voiceView(Number(d.userId), v) });
    return {};
  },
  'admin.kick'(c, user, d) {
    const s = M.getServer(Number(d.serverId));
    if (!s || !M.can(user, s, 'kick')) fail('You need the Remove members permission.');
    if (Number(d.userId) === user.id) fail('That’s you.');
    log(user, s.id, 'Removed from the server', nm(Number(d.userId)));
    removeFromServer(Number(d.userId), s.id, 'kicked');
    return {};
  },

  'admin.resetPassword'(c, user, d) {
    if (!user.is_admin) fail('Only an admin can reset passwords.');
    const target = M.getUser(Number(d.userId));
    if (!target) fail('That person doesn’t exist.');
    if (target.id === user.id) fail('Change your own password in Settings.');
    const temp = M.resetPassword(target.id);
    log(user, null, 'Made a temporary password', target.name);
    for (const tc of [...(byUser.get(target.id) || [])]) tc.ws.close(4001, 'auth');   // signed out on every device
    return { password: temp, name: target.name };
  },

  /* ---- developer panel (admins) ---- */
  'dev.report'(c, user, d) {
    const t = Date.now();
    c.reports = (c.reports || []).filter((x) => t - x < 60_000);
    if (c.reports.length >= 30) return {};   // a broken app can't flood the log
    c.reports.push(t);
    addDevLog({ at: t, userId: user.id, kind: String(d.kind || 'info').slice(0, 20), text: String(d.text || '').slice(0, 500) });
    return {};
  },
  /* Which app and version this connection is ("Windows app 1.1.0", "Android app build 12", "Chrome on Windows"). */
  /* ---- invite links ---- */
  'invite.create'(c, user, d) {
    const s = M.getServer(Number(d.serverId));
    if (!s || s.kind && s.kind !== 'server' || !M.isMember(user.id, s.id)) fail('You’re not in that server.');
    return { code: M.createInvite(s.id, user.id, d.hours, d.maxUses) };
  },
  'invite.list'(c, user, d) {
    const s = M.getServer(Number(d.serverId));
    if (!s || !M.isMember(user.id, s.id)) fail('You’re not in that server.');
    return { invites: M.invitesOf(s.id) };
  },
  'invite.delete'(c, user, d) {
    const inv = M.getInvite(d.code);
    if (!inv) return {};
    if (inv.creator_id !== user.id && !M.can(user, M.getServer(inv.server_id), 'server')) fail('Only whoever made the link (or an admin) can remove it.');
    M.deleteInvite(inv.code);
    return {};
  },
  'invite.reset'(c, user, d) {
    const s = M.getServer(Number(d.serverId));
    if (!s || !M.can(user, s, 'server')) fail('You need the Manage server permission.');
    M.resetServerInvite(s.id);
    log(user, s.id, 'Made a new permanent invite link', 'the old one stopped working');
    refreshServer(s.id);
    return {};
  },
  'reset.decide'(c, user, d) {
    if (!user.is_admin) fail('Admins only.');
    const r = M.decideReset(Number(d.id), user.id, !!d.approve);
    log(user, null, d.approve ? 'Approved a password reset' : 'Denied a password reset', nm(r.user_id));
    for (const u of M.allUsers()) if (u.admin) toUser(u.id, { t: 'reset.done', id: r.id, approved: !!d.approve, by: user.id });
    // Approved: everywhere they were signed in with the old password is signed out.
    if (d.approve) for (const x of [...(byUser.get(r.user_id) || [])]) x.ws.close(4001, 'auth');
    return {};
  },
  'notify.set'(c, user, d) {
    const prefs = M.setNotifyPref(user.id, String(d.target || ''), d.level);
    toUser(user.id, { t: 'notify', prefs });
    return {};
  },
  'client.info'(c, user, d) { c.client = String(d.label || '').replace(/[\u0000-\u001f]/g, '').slice(0, 60) || null; if (c.client) M.setSessionDevice(c.session, c.client); return {}; },
  /* Devices you're signed in on, and signing them out. */
  'sessions.list'(c, user) {
    const live = new Set([...(byUser.get(user.id) || [])].map((x) => x.session));
    return { sessions: M.sessionsOf(user.id).map(({ key, ...s }) => Object.assign(s, { current: key === c.session, online: live.has(key) })) };
  },
  'sessions.end'(c, user, d) {
    const mine = M.sessionsOf(user.id).filter((s) => s.key !== c.session);
    const keys = (d.others ? mine : mine.filter((s) => s.id === String(d.id || ''))).map((s) => s.key);
    M.endSessions(user.id, keys);
    for (const x of [...(byUser.get(user.id) || [])]) if (keys.includes(x.session)) x.ws.close(4001, 'auth');
    return { ended: keys.length };
  },
  'totp.start'(c, user) {
    if (user.totp_secret) fail('2-step sign-in is already on.');
    const r = M.startTotp(user.id);
    return QRCode.toString(r.uri, { type: 'svg', margin: 1 }).then((svg) => ({ secret: r.secret, qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` }));
  },
  'totp.confirm'(c, user, d) {
    M.confirmTotp(user.id, d.code);
    // Other devices stay signed in; new sign-ins need the code.
    hub.userChanged(M.getUser(user.id));
    return {};
  },
  'totp.stop'(c, user, d) { M.stopTotp(user.id, d.password); hub.userChanged(M.getUser(user.id)); return {}; },
  'dev.stats'(c, user) {
    if (!user.is_admin) fail('Admins only.');
    const mem = process.memoryUsage();
    let dbBytes = 0;
    for (const f of ['party-line.db', 'party-line.db-wal']) { try { dbBytes += fs.statSync(path.join(config.dataDir, f)).size; } catch {} }
    const voiceList = [...voice].map(([id, v]) => Object.assign(voiceView(id, v), { connId: v.connId }));
    return {
      server: {
        uptime: Math.round((Date.now() - startedAt) / 1000), node: process.version, version: config.version,
        rss: mem.rss, heap: mem.heapUsed, dbBytes, uploads: folderSize(path.join(config.dataDir, 'uploads')),
        users: M.allUsers().length, online: byUser.size, connections: conns.size,
        turn: !!(config.turnUrls.length && config.turnSecret), sfu: !!(config.livekit.url && config.livekit.secret),
        groupPassword: !!config.groupPassword,
        health: Bot.healthProblems().map(([, text]) => text),
        backup: Bot.readJson('backup-status.json'),   // written by deploy/backup.sh
      },
      voice: voiceList,
      people: [...byUser].map(([id, set]) => ({ userId: id, devices: set.size, apps: [...set].map((x) => x.client || 'unknown app') })),
      directory: M.userDirectory().map((u) => Object.assign(u, { online: online(u.id), openApps: (byUser.get(u.id) || new Set()).size, apps: [...(byUser.get(u.id) || [])].map((x) => x.client || 'unknown app') })),
      log: devLog.slice(-300),
      audit: M.auditLog(300),
    };
  },
  'dev.ask'(c, user, d) {
    if (!user.is_admin) fail('Admins only.');
    const target = Number(d.userId);
    if (!online(target)) fail('They’re not online.');
    toUser(target, { t: 'dev.ask', from: user.id });
    return {};
  },
  'dev.answer'(c, user, d) {
    const admin = M.getUser(Number(d.to));
    if (!admin || !admin.is_admin) return {};
    let data = d.data;
    try { if (JSON.stringify(data).length > 60_000) data = { error: 'too big' }; } catch { data = { error: 'unreadable' }; }
    toUser(admin.id, { t: 'dev.answer', userId: user.id, device: c.id, data });
    return {};
  },

  /* ---- feedback ---- */
  'feedback.send'(c, user, d) {
    const id = M.addFeedback(d.anonymous ? null : user.id, d.kind, d.body);
    for (const u of M.allUsers()) if (u.admin) toUser(u.id, { t: 'feedback.new', id });
    return { id };
  },
  'feedback.list'(c, user) { if (!user.is_admin) fail('Admins only.'); return { items: M.listFeedback() }; },
  'feedback.done'(c, user, d) { if (!user.is_admin) fail('Admins only.'); M.setFeedbackDone(Number(d.id), !!d.done); return {}; },
  'feedback.delete'(c, user, d) { if (!user.is_admin) fail('Admins only.'); M.deleteFeedback(Number(d.id)); return {}; },
};

/* After a message is sent or edited: fetch previews for its links, then update it for everyone. */
async function addPreviews(m) {
  const links = linksIn(m.body);
  if (!links.length && !m.embeds) return;
  const found = (await Promise.all(links.map(previewFor))).filter(Boolean)
    .map((p) => Object.assign({}, p, { image: imagePath(p.image) }));
  const now = M.getMessage(m.id);
  if (!now || now.body !== m.body) return;   // deleted or edited again meanwhile
  broadcastAbout(now, { t: 'msg.edit', msg: M.setEmbeds(m.id, found) });
}
function canSee(userId, m) {
  if (m.channel_id) { const ch = M.getChannel(m.channel_id); return !!ch && M.isMember(userId, ch.server_id); }
  const dm = M.getDm(m.dm_id);
  return !!dm && (dm.user_a === userId || dm.user_b === userId);
}
function gameWhere(user, d, create) {
  if (d.channelId) {
    const ch = M.getChannel(Number(d.channelId));
    if (!ch || ch.kind !== 'text' || !M.isMember(user.id, ch.server_id)) fail('You can’t see that chat.');
    return { channelId: ch.id };
  }
  const other = M.getUser(Number(d.userId));
  if (!other || other.id === user.id) fail('You can’t see that chat.');
  const dm = M.dmWith(user.id, other.id, false);
  if (dm) return { dmId: dm.id };
  if (!create) return null;
  if (M.friendState(user.id, other.id) !== 'friends' && !M.serverIdsOf(user.id).some((s) => M.isMember(other.id, s))) fail(`Add ${other.name} as a friend first.`);
  return { dmId: M.dmWith(user.id, other.id, true).id };
}
function gameFor(user, id) {
  const g = M.getGame(Number(id));
  if (!g || !canSee(user.id, g)) fail('That game isn’t on the list any more.');
  return { g, w: g.channel_id ? { channelId: g.channel_id } : { dmId: g.dm_id } };
}
function shareGames(w) {
  const msg = { t: 'games', channelId: w.channelId || null, dmId: w.dmId || null, games: M.gamesOf(w) };
  if (w.channelId) toServer(M.getChannel(w.channelId).server_id, msg);
  else { const dm = M.getDm(w.dmId); toUsers([dm.user_a, dm.user_b], msg); }
}
function laterTarget(user, d) {
  if (d.channelId) {
    const ch = M.getChannel(Number(d.channelId));
    if (!ch || !M.isMember(user.id, ch.server_id)) fail('You can’t post there.');
    return { channelId: ch.id };
  }
  const other = M.getUser(Number(d.toUserId));
  if (!other || other.id === user.id) fail('That person doesn’t exist.');
  return { toUserId: other.id };
}
/* A poll changed: everyone in its chat gets the new results, each with their own picks. */
/* XP (see M.addXp). Everyone in the server sees the new total; from level 2 up Party Bot cheers in the chat it
   happened in (a voice channel's own chat for time in voice). */
function gainXp(serverId, userId, amount, fromMessage, where) {
  const r = M.addXp(serverId, userId, amount, fromMessage);
  if (!r) return;
  toServer(serverId, { t: 'xp', serverId, userId, xp: r.xp });
  if (r.up >= 2) botHost.post(where, `🎉 **${M.getUser(userId).name}** reached **level ${r.up}**!`);
}
/* Every minute in a voice channel with at least one other person (not deafened, not in the AFK channel): 5 XP. */
setInterval(() => {
  const byChannel = new Map();
  for (const [userId, v] of voice) if (!v.deafened) (byChannel.get(v.channelId) || byChannel.set(v.channelId, []).get(v.channelId)).push(userId);
  for (const [channelId, ids] of byChannel) {
    const ch = M.getChannel(channelId), srv = ch && M.getServer(ch.server_id);
    if (!srv || ids.length < 2 || srv.afk_channel_id === ch.id) continue;
    for (const id of ids) gainXp(srv.id, id, 5, false, { channelId: ch.id });
  }
}, Number(process.env.XP_VOICE_MS) || 60_000).unref();
function sharePoll(pollId) {
  const p = M.getPoll(pollId), m = p && M.getMessage(p.message_id);
  if (!m) return;
  const view = M.pollView(pollId), ids = m.channel_id ? M.memberIds(M.getChannel(m.channel_id).server_id) : (({ user_a, user_b }) => [user_a, user_b])(M.getDm(m.dm_id));
  for (const id of ids) if (online(id)) toUser(id, { t: 'poll', messageId: m.id, channelId: m.channel_id, dmId: m.dm_id, poll: Object.assign({}, view, { mine: M.myPollVotes(pollId, id) }) });
}
function finishPoll(p) {
  M.closePoll(p.id);
  sharePoll(p.id);
  const v = M.pollView(p.id), m = M.getMessage(p.message_id);
  if (!m) return;
  const top = Math.max(...v.options.map((o) => o.votes));
  const best = v.options.filter((o) => o.votes === top);
  const text = !top ? `📊 The poll “${v.question}” ended with no votes.`
    : best.length > 1 ? `📊 The poll “${v.question}” ended in a tie: ${best.map((o) => `**${o.text}**`).join(' and ')} (${top} each).`
    : `📊 The poll “${v.question}” ended: **${best[0].text}** won with ${top} vote${top === 1 ? '' : 's'}.`;
  botHost.post(m.channel_id ? { channelId: m.channel_id } : { dmId: m.dm_id }, text, m.id);
}
setInterval(() => { for (const p of M.pollsDue()) finishPoll(p); }, Number(process.env.POLL_TICK_MS) || 15_000).unref();
/* Disappearing messages whose time is up are deleted for everyone. */
setInterval(() => {
  for (const m of M.expiredMessages()) { M.deleteMessage(m.id); broadcastAbout(m, { t: 'msg.del', id: m.id, channelId: m.channel_id, dmId: m.dm_id }); }
}, Number(process.env.DISAPPEAR_TICK_MS) || 30_000).unref();
/* Every 15 s: send the scheduled messages that are due, as their writers, through the normal send path (which
   checks they may still post there). If it fails, the writer is told and gets the text back. */
setInterval(() => {
  for (const r of M.scheduledDue()) {
    const user = M.getUser(r.user_id);
    const t = r.channel_id ? { channelId: r.channel_id } : { toUserId: r.to_user_id };
    try { handlers['msg.send'](null, user, Object.assign({ body: r.body, attachments: [] }, t)); }
    catch (e) { toUser(r.user_id, { t: 'later.failed', body: r.body, error: e instanceof M.UserError ? e.message : 'Something went wrong.' }); if (!(e instanceof M.UserError)) console.error('send later', e); }
    toUser(r.user_id, { t: 'later', ...t, list: M.scheduledFor(r.user_id, t) });
  }
}, Number(process.env.LATER_TICK_MS) || 15_000).unref();
function broadcastAbout(m, msg) {
  if (m.channel_id) toServer(M.getChannel(m.channel_id).server_id, msg);
  else if (m.dm_id) { const dm = M.getDm(m.dm_id); toUsers([dm.user_a, dm.user_b], msg); }
}
function removeFromServer(userId, serverId, why) {
  const v = voice.get(userId);
  if (v && v.serverId === serverId) leaveVoice(userId, why === 'kicked' ? 'kicked' : null);
  M.leaveServer(userId, serverId);
  toServer(serverId, { t: 'member.left', serverId, userId });
  toUser(userId, { t: 'server.gone', id: serverId, reason: why || 'left' });
}

export function attachHub(server) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://x');
    const user = M.userForToken(url.searchParams.get('token'));
    if (!user) { ws.close(4001, 'auth'); return; }
    const c = { id: nextConn++, ws, userId: user.id, alive: true, idle: false, activity: null, session: M.sessionKey(url.searchParams.get('token')) };
    conns.set(c.id, c);
    const first = !online(user.id);
    M.touchUser(user.id);
    if (!byUser.has(user.id)) byUser.set(user.id, new Set());
    byUser.get(user.id).add(c);
    send(c, readyFor(user));
    if (first) lastPresence.delete(user.id);
    announce(user.id);

    ws.on('pong', () => { c.alive = true; });
    ws.on('message', (raw) => {
      let d;
      try { d = JSON.parse(raw); } catch { return; }
      if (!d || typeof d.t !== 'string') return;
      const h = Object.prototype.hasOwnProperty.call(handlers, d.t) ? handlers[d.t] : null;
      const fresh = M.getUser(c.userId);
      if (!fresh) { ws.close(4001, 'auth'); return; }
      const failed = (e) => {
        if (!(e instanceof M.UserError)) console.error(d.t, e);
        return { error: e instanceof M.UserError ? e.message : 'Something went wrong on the server.' };
      };
      const ack = (reply) => { if (d.rid) send(c, Object.assign({ t: 'ack', rid: d.rid }, reply || {})); };
      let reply;
      try { reply = h ? h(c, fresh, d) : { error: 'unknown' }; }
      catch (e) { reply = failed(e); }
      // Bot commands answer asynchronously (looking up a video's title).
      if (reply && typeof reply.then === 'function') reply.then(ack, (e) => ack(failed(e)));
      else ack(reply);
    });
    ws.on('close', () => {
      conns.delete(c.id);
      const set = byUser.get(user.id);
      set && set.delete(c);
      const v = voice.get(user.id);
      if (v && v.connId === c.id) leaveVoice(user.id);
      M.touchUser(user.id);
      if (!online(user.id)) byUser.delete(user.id);
      announce(user.id);
    });
  });
  const beat = setInterval(() => {
    for (const c of conns.values()) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch {}
    }
  }, 30_000);
  wss.on('close', () => clearInterval(beat));
}
