/* The live part: one WebSocket per open app. Carries new messages, who's online, who's in which voice
   channel, and relays the WebRTC handshakes that connect voices and screen shares directly between people. */
import { WebSocketServer } from 'ws';
import * as M from './model.js';

const conns = new Map();     // connId -> { id, ws, userId }
const byUser = new Map();    // userId -> Set(conn)
const voice = new Map();     // userId -> { channelId, serverId, connId, muted, deafened, sharing, screenId, serverMuted, since }
let nextConn = 1;

const send = (c, msg) => { if (c && c.ws.readyState === 1) c.ws.send(JSON.stringify(msg)); };
const toUser = (userId, msg, except) => { for (const c of byUser.get(userId) || []) if (c !== except) send(c, msg); };
const toUsers = (ids, msg) => { for (const id of new Set(ids)) toUser(id, msg); };
const toServer = (serverId, msg) => toUsers(M.memberIds(serverId), msg);
const userView = (id) => { const u = M.getUser(id); return u && Object.assign(M.publicUser(u), { online: online(id) }); };
/* Everyone online who can see this person (see M.canSeeUser). */
const toWatchers = (userId, msg) => { for (const uid of byUser.keys()) if (M.canSeeUser(uid, userId)) toUser(uid, msg); };
const online = (userId) => (byUser.get(userId) || new Set()).size > 0;
const voiceView = (userId, v) => ({ userId, channelId: v.channelId, serverId: v.serverId, muted: v.muted, deafened: v.deafened,
  sharing: v.sharing, camera: !!v.camera, screenId: v.screenId || null, serverMuted: v.serverMuted, since: v.since });
const fail = (msg) => { throw new M.UserError(msg); };

export const hub = {
  userChanged(u) { toWatchers(u.id, { t: 'user', user: userView(u.id) }); },
  joinedServers(userId) { for (const s of M.serverIdsOf(userId)) toServer(s, { t: 'member', serverId: s, userId, user: userView(userId) }); },
};

function readyFor(user) {
  const servers = M.serverIdsOf(user.id).map((id) => M.serverView(id, user.id)).filter(Boolean);
  const mine = new Set(servers.map((s) => s.id));
  return {
    t: 'ready',
    me: M.publicUser(user),
    users: M.visibleUsers(user.id).map((u) => Object.assign(u, { online: online(u.id) })),
    servers,
    friends: M.friendsOf(user.id),
    dms: M.dmsOf(user.id),
    voice: [...voice].filter(([, v]) => mine.has(v.serverId)).map(([id, v]) => voiceView(id, v)),
  };
}

function leaveVoice(userId, reason) {
  const v = voice.get(userId);
  if (!v) return;
  voice.delete(userId);
  toServer(v.serverId, { t: 'voice.left', userId, channelId: v.channelId, serverId: v.serverId });
  if (reason) { const c = conns.get(v.connId); send(c, { t: 'voice.kicked', reason }); }
}

const handlers = {
  ping: () => ({ pong: Date.now() }),

  /* ---- messages ---- */
  'msg.send'(c, user, d) {
    if (d.channelId) {
      const ch = M.getChannel(Number(d.channelId));
      if (!ch || ch.kind !== 'text' || !M.isMember(user.id, ch.server_id)) fail('You can’t post there.');
      const m = M.postMessage(user.id, { channelId: ch.id }, d.body, d.attachments, d.replyTo);
      toServer(ch.server_id, { t: 'msg', msg: m, serverId: ch.server_id, nonce: d.nonce });
      return { msg: m };
    }
    const other = M.getUser(Number(d.toUserId));
    if (!other) fail('That person doesn’t exist.');
    const shares = M.serverIdsOf(user.id).some((s) => M.isMember(other.id, s));
    if (M.friendState(user.id, other.id) !== 'friends' && !shares) fail(`Add ${other.name} as a friend first.`);
    const dm = M.dmWith(user.id, other.id, true);
    const m = M.postMessage(user.id, { dmId: dm.id }, d.body, d.attachments, d.replyTo);
    toUser(user.id, { t: 'dm', msg: m, withUserId: other.id, nonce: d.nonce });
    toUser(other.id, { t: 'dm', msg: m, withUserId: user.id, user: userView(user.id) });
    return { msg: m };
  },
  'msg.edit'(c, user, d) {
    const m = M.getMessage(Number(d.id));
    if (!m || m.user_id !== user.id) fail('You can only edit your own messages.');
    const out = M.editMessage(m.id, d.body);
    broadcastAbout(m, { t: 'msg.edit', msg: out });
    return {};
  },
  'msg.delete'(c, user, d) {
    const m = M.getMessage(Number(d.id));
    if (!m) return {};
    let ok = m.user_id === user.id || !!user.is_admin;
    if (!ok && m.channel_id) ok = M.canManage(user, M.getServer(M.getChannel(m.channel_id).server_id));
    if (!ok) fail('You can only delete your own messages.');
    M.deleteMessage(m.id);
    broadcastAbout(m, { t: 'msg.del', id: m.id, channelId: m.channel_id, dmId: m.dm_id });
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
    const s = M.serverByInvite(code);
    if (!s) fail('That invite doesn’t work. Ask for a new one.');
    if (!M.isMember(user.id, s.id)) {
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
    return {};
  },
  'server.rename'(c, user, d) {
    const s = M.getServer(Number(d.id));
    if (!s || !M.canManage(user, s)) fail('Only the server’s owner can rename it.');
    const name = String(d.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!name) fail('Give the server a name.');
    M.renameServer(s.id, name);
    toServer(s.id, { t: 'server.renamed', id: s.id, name });
    return {};
  },
  'server.delete'(c, user, d) {
    const s = M.getServer(Number(d.id));
    if (!s || !M.canManage(user, s)) fail('Only the server’s owner can delete it.');
    if (s.is_default) fail('The main server can’t be deleted.');
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
    if (!M.canManage(user, M.getServer(ch.server_id))) fail('Only an admin or the server’s owner can delete channels.');
    for (const [uid, v] of voice) if (v.channelId === ch.id) leaveVoice(uid, 'deleted');
    M.deleteChannel(ch.id);
    toServer(ch.server_id, { t: 'chan.del', id: ch.id, serverId: ch.server_id });
    return {};
  },

  /* ---- profile ---- */
  'profile.rename'(c, user, d) { hub.userChanged(M.rename(user.id, d.name)); return {}; },

  /* ---- friends ---- */
  'friend.request'(c, user, d) {
    const r = M.requestFriend(user.id, d.name);
    toUser(user.id, { t: 'friend', id: r.other.id, state: r.state, user: userView(r.other.id) });
    toUser(r.other.id, { t: 'friend', id: user.id, state: r.state === 'friends' ? 'friends' : 'incoming', user: userView(user.id) });
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
    voice.set(user.id, v);
    toServer(ch.server_id, { t: 'voice', state: voiceView(user.id, v) });
    return { peers: [...voice].filter(([id, x]) => id !== user.id && x.channelId === ch.id).map(([id]) => id) };
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
    toServer(v.serverId, { t: 'voice', state: voiceView(user.id, v) });
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
    if (!M.canManage(user, M.getServer(v.serverId))) fail('Admins only.');
    leaveVoice(Number(d.userId), 'admin');
    return {};
  },
  'admin.mute'(c, user, d) {
    const v = voice.get(Number(d.userId));
    if (!v) return {};
    if (!M.canManage(user, M.getServer(v.serverId))) fail('Admins only.');
    v.serverMuted = !!d.on;
    toServer(v.serverId, { t: 'voice', state: voiceView(Number(d.userId), v) });
    return {};
  },
  'admin.kick'(c, user, d) {
    const s = M.getServer(Number(d.serverId));
    if (!s || !M.canManage(user, s)) fail('Admins only.');
    if (Number(d.userId) === user.id) fail('That’s you.');
    removeFromServer(Number(d.userId), s.id, 'kicked');
    return {};
  },

  'admin.resetPassword'(c, user, d) {
    if (!user.is_admin) fail('Only an admin can reset passwords.');
    const target = M.getUser(Number(d.userId));
    if (!target) fail('That person doesn’t exist.');
    if (target.id === user.id) fail('Change your own password in Settings.');
    const temp = M.resetPassword(target.id);
    for (const tc of [...(byUser.get(target.id) || [])]) tc.ws.close(4001, 'auth');   // signed out on every device
    return { password: temp, name: target.name };
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

function canSee(userId, m) {
  if (m.channel_id) { const ch = M.getChannel(m.channel_id); return !!ch && M.isMember(userId, ch.server_id); }
  const dm = M.getDm(m.dm_id);
  return !!dm && (dm.user_a === userId || dm.user_b === userId);
}
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
    const c = { id: nextConn++, ws, userId: user.id, alive: true };
    conns.set(c.id, c);
    const first = !online(user.id);
    if (!byUser.has(user.id)) byUser.set(user.id, new Set());
    byUser.get(user.id).add(c);
    send(c, readyFor(user));
    if (first) toWatchers(user.id, { t: 'presence', userId: user.id, online: true });

    ws.on('pong', () => { c.alive = true; });
    ws.on('message', (raw) => {
      let d;
      try { d = JSON.parse(raw); } catch { return; }
      if (!d || typeof d.t !== 'string') return;
      const h = Object.prototype.hasOwnProperty.call(handlers, d.t) ? handlers[d.t] : null;
      const fresh = M.getUser(c.userId);
      if (!fresh) { ws.close(4001, 'auth'); return; }
      let reply;
      try { reply = h ? h(c, fresh, d) : { error: 'unknown' }; }
      catch (e) {
        if (!(e instanceof M.UserError)) console.error(d.t, e);
        reply = { error: e instanceof M.UserError ? e.message : 'Something went wrong on the server.' };
      }
      if (d.rid) send(c, Object.assign({ t: 'ack', rid: d.rid }, reply || {}));
    });
    ws.on('close', () => {
      conns.delete(c.id);
      const set = byUser.get(user.id);
      set && set.delete(c);
      const v = voice.get(user.id);
      if (v && v.connId === c.id) leaveVoice(user.id);
      if (!online(user.id)) { byUser.delete(user.id); toWatchers(user.id, { t: 'presence', userId: user.id, online: false }); }
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
