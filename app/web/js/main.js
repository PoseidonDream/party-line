/* Party Line app: sign in, servers and channels, chat, friends and private chats, voice and screen sharing. */
import { api, upload, live, store, setToken, hasToken, absUrl } from './net.js';
import { $, iconSvg, settings, saveSettings, friendVols, saveVols, clampLevel, hue, initials, toast, chime, level, fmtTime, fmtDay, fmtSize } from './util.js';
import * as Voice from './voice.js';
const { V } = Voice;

const desktop = window.partyLineDesktop || null;   // set by the desktop app's preload script
const S = {
  me: null, ready: false,
  users: new Map(), servers: new Map(), friends: new Map(), dms: new Map(), voice: new Map(),
  view: { kind: 'friends' }, friendTab: 'online',
  msgs: new Map(),          // 'c:<channelId>' or 'd:<userId>' -> { list, loaded, hasMore, loading }
  lastChan: store.get('lastChan', {}) || {},
  attach: [], sending: false, watching: null, pendingInvite: null,
  mutedSince: 0, fbCount: 0, popUser: null, popServer: null,
};
const MAX_IMAGE = 15 * 1048576, MAX_VIDEO = 50 * 1048576;

/* ================= dark and light mode ================= */
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const isDark = () => settings.theme === 'dark' || (settings.theme === 'system' && darkQuery.matches);
function applyTheme() {
  const root = document.documentElement;
  if (settings.theme === 'system') delete root.dataset.theme; else root.dataset.theme = settings.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = isDark() ? '#11151d' : '#e8ebf0';
  $('#themeToggle').querySelector('use').setAttribute('href', isDark() ? '#i-sun' : '#i-moon');
  for (const r of document.querySelectorAll('input[name="theme"]')) r.checked = r.value === settings.theme;
  if (desktop && desktop.setTheme) desktop.setTheme(settings.theme);
}
function setTheme(t) { settings.theme = t; saveSettings(); applyTheme(); }
darkQuery.addEventListener('change', applyTheme);
applyTheme();
$('#themeToggle').addEventListener('click', () => setTheme(isDark() ? 'light' : 'dark'));

/* ================= small view helpers ================= */
const user = (id) => S.users.get(id) || { id, name: 'Someone', avatar: null, online: false };
const nameOf = (id) => user(id).name;
const curServer = () => (S.view.serverId ? S.servers.get(S.view.serverId) : null);
const canManage = (srv) => !!S.me && (S.me.admin || (srv && srv.ownerId === S.me.id));
const msgKey = () => (S.view.kind === 'text' ? `c:${S.view.channelId}` : S.view.kind === 'dm' ? `d:${S.view.userId}` : null);
const isTyping = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
const voiceIn = (channelId) => [...S.voice.values()].filter((v) => v.channelId === channelId).sort((a, b) => a.since - b.since);
function findChannel(id) {
  for (const s of S.servers.values()) { const c = s.channels.find((x) => x.id === id); if (c) return { server: s, channel: c }; }
  return null;
}
function paintAv(el, id) {
  const u = user(id);
  el.style.setProperty('--h', hue(u.name));
  el.textContent = initials(u.name);
  if (u.avatar) { el.classList.add('has-img'); el.style.backgroundImage = `url("${absUrl(u.avatar)}")`; }
  else { el.classList.remove('has-img'); el.style.backgroundImage = ''; }
}
function avEl(id, cls = 'mini-av') { const s = document.createElement('span'); s.className = cls; s.setAttribute('aria-hidden', 'true'); paintAv(s, id); return s; }
function serverInitials(name) { return initials(name).slice(0, 2) || '#'; }
function confirmBox(title, text, okLabel = 'Delete', input) {
  return new Promise((resolve) => {
    const d = $('#confirmDlg');
    $('#cfTitle').textContent = title; $('#cfText').textContent = text; $('#cfOk').textContent = okLabel;
    const inp = $('#cfInput');
    inp.hidden = input === undefined; inp.value = input || '';
    $('#cfOk').classList.toggle('cf-ok', input === undefined);
    d.returnValue = '';
    d.addEventListener('close', () => resolve(d.returnValue === 'ok' ? (input === undefined ? true : inp.value) : false), { once: true });
    d.showModal();
    if (input !== undefined) inp.select();
  });
}
async function act(fn, okText) {
  try { const r = await fn(); if (okText) toast(okText, 2200); return r; }
  catch (e) { toast(e.message || 'Something went wrong.', 4500); return null; }
}

/* ================= sign in ================= */
let authMode = 'login', info = { needsGroupPassword: false };
function showAuth(mode) {
  authMode = mode;
  $('#tabLogin').setAttribute('aria-selected', String(mode === 'login'));
  $('#tabRegister').setAttribute('aria-selected', String(mode === 'register'));
  $('#groupField').hidden = mode !== 'register' || !info.needsGroupPassword;
  $('#authPassHint').hidden = mode !== 'register';
  $('#authPass').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  $('#authBtn').textContent = mode === 'register' ? 'Create account' : 'Sign in';
  $('#authError').hidden = true;
}
function showJoinScreen() {
  $('#booting').hidden = true; $('#room').hidden = true; $('#join').hidden = false; $('#themeToggle').hidden = false;
  if (S.pendingInvite) { $('#joinInvite').hidden = false; $('#joinInvite').textContent = 'You were invited to a server. Sign in or create an account to join.'; }
  api('/api/info').then((i) => { info = i; showAuth(authMode); }).catch(() => {});
  showAuth(store.get('hadAccount', false) ? 'login' : 'register');
  setTimeout(() => $('#authName').focus(), 50);
}
$('#tabLogin').addEventListener('click', () => showAuth('login'));
$('#tabRegister').addEventListener('click', () => showAuth('register'));
$('#authShow').addEventListener('click', () => {
  const i = $('#authPass'), show = i.type === 'password';
  i.type = show ? 'text' : 'password';
  $('#authShow').setAttribute('aria-pressed', String(show));
});
$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#authBtn'), err = $('#authError');
  err.hidden = true; btn.disabled = true;
  try {
    const body = { name: $('#authName').value, password: $('#authPass').value, groupPassword: $('#authGroup').value };
    const r = await api(authMode === 'register' ? '/api/register' : '/api/login', { body });
    setToken(r.token); store.set('hadAccount', true);
    $('#authPass').value = ''; $('#authGroup').value = '';
    start();
  } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  finally { btn.disabled = false; }
});
(function jackfield() {
  const f = $('#jackfield');
  for (let i = 0; i < 32; i++) { const j = document.createElement('span'); j.className = 'jack'; f.appendChild(j); }
  const jacks = [...f.children];
  setInterval(() => { if ($('#join').hidden) return; const j = jacks[Math.floor(Math.random() * jacks.length)]; j.classList.toggle('lit'); }, 450);
})();

function start() {
  $('#join').hidden = true; $('#booting').hidden = false; $('#bootText').textContent = 'Connecting…';
  live.connect();
}
async function signOut() {
  if (V.channelId) Voice.leaveVoice();
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  live.close(); setToken(''); S.ready = false;
  $('#settings').close();
  showJoinScreen();
}

/* ================= live events ================= */
live.on('auth-failed', () => { setToken(''); S.ready = false; if (V.channelId) Voice.leaveVoice(false); showJoinScreen(); });
live.on('down', () => { $('#offlineBar').hidden = !S.ready; renderConn(); });
live.on('open', () => { $('#offlineBar').hidden = true; renderConn(); });
live.on('ready', (d) => {
  S.me = d.me;
  S.users = new Map(d.users.map((u) => [u.id, u]));
  S.servers = new Map(d.servers.map((s) => [s.id, s]));
  S.friends = new Map(d.friends.map((f) => [f.id, f.state]));
  S.dms = new Map(d.dms.map((x) => [x.userId, x]));
  S.voice = new Map(d.voice.map((v) => [v.userId, v]));
  for (const [k, m] of S.msgs) if (m.loaded) S.msgs.delete(k);   // reload what we show, in case we missed messages
  const first = !S.ready;
  S.ready = true;
  $('#booting').hidden = true; $('#join').hidden = true; $('#room').hidden = false; $('#themeToggle').hidden = true;
  if (first) {
    const last = store.get('lastView', null);
    if (last && last.kind === 'dm' && S.users.has(last.userId)) S.view = last;
    else if (last && last.serverId && S.servers.has(last.serverId)) openServer(last.serverId, true);
    else if (S.servers.size) openServer([...S.servers.keys()][0], true);
    else S.view = { kind: 'friends' };
  } else if (S.view.serverId && !S.servers.has(S.view.serverId)) S.view = { kind: 'friends' };
  if (S.view.kind === 'voice' && !findChannel(S.view.channelId)) S.view = { kind: 'friends' };
  renderAll();
  openCurrent();
  if (V.channelId) Voice.rejoinVoice();
  if (S.pendingInvite) { const code = S.pendingInvite; S.pendingInvite = null; joinInvite(code); }
  if (S.me.admin) live.req('feedback.list', {}).then((r) => { S.fbCount = r.items.filter((x) => !x.done).length; renderFbCount(); }).catch(() => {});
});
live.on('user', (d) => {
  S.users.set(d.user.id, d.user);
  if (S.me && d.user.id === S.me.id) S.me = Object.assign(S.me, d.user);
  renderAll(); rerenderMessagesSoft();
});
live.on('presence', (d) => { const u = S.users.get(d.userId); if (u) { u.online = d.online; renderSide(); renderConn(); if (S.view.kind === 'friends') renderFriends(); if (S.view.kind === 'dm') renderHeader(); } });
live.on('server', (d) => {
  S.servers.set(d.server.id, d.server);
  for (const v of d.voice || []) S.voice.set(v.userId, v);
  renderAll();
});
live.on('server.gone', (d) => {
  const s = S.servers.get(d.id);
  S.servers.delete(d.id);
  if (V.channelId && s && s.channels.some((c) => c.id === V.channelId)) Voice.leaveVoice(false);
  if (S.view.serverId === d.id) setView({ kind: 'friends' });
  if (d.reason === 'kicked' && s) toast(`You were removed from ${s.name}.`, 5000);
  renderAll();
});
live.on('server.renamed', (d) => { const s = S.servers.get(d.id); if (s) { s.name = d.name; renderAll(); } });
live.on('member', (d) => { const s = S.servers.get(d.serverId); if (s && !s.members.includes(d.userId)) { s.members.push(d.userId); renderConn(); } });
live.on('member.left', (d) => { const s = S.servers.get(d.serverId); if (s) { s.members = s.members.filter((x) => x !== d.userId); renderConn(); } });
live.on('chan', (d) => { const s = S.servers.get(d.channel.serverId); if (s && !s.channels.some((c) => c.id === d.channel.id)) { s.channels.push(d.channel); renderSide(); } });
live.on('chan.del', (d) => {
  const s = S.servers.get(d.serverId);
  if (!s) return;
  s.channels = s.channels.filter((c) => c.id !== d.id);
  if (S.view.channelId === d.id) openServer(s.id);
  renderAll();
});
live.on('voice', (d) => {
  const st = d.state, prev = S.voice.get(st.userId);
  S.voice.set(st.userId, st);
  Voice.onVoiceState(st);
  if (V.channelId && S.me && st.userId !== S.me.id) {
    if (st.channelId === V.channelId && (!prev || prev.channelId !== V.channelId)) chime('join', V.deafened);
    if (prev && prev.channelId === V.channelId && st.channelId !== V.channelId) chime('leave', V.deafened);
  }
  if (S.watching === st.userId && !st.sharing && !(st.userId === S.me.id && V.sharing)) S.watching = null;
  renderVoiceBits();
});
live.on('voice.left', (d) => {
  const prev = S.voice.get(d.userId);
  S.voice.delete(d.userId);
  Voice.onVoiceLeft(d.userId);
  if (prev && V.channelId && prev.channelId === V.channelId && d.userId !== S.me.id) chime('leave', V.deafened);
  if (S.watching === d.userId) S.watching = null;
  renderVoiceBits();
});
live.on('voice.kicked', (d) => {
  Voice.leaveVoice(false);
  const why = { 'other-device': 'You joined voice on another device, so this one left voice.', admin: 'An admin disconnected you from voice.',
    deleted: 'That voice channel was deleted.', kicked: 'You were removed from the server.' }[d.reason] || 'You were disconnected from voice.';
  toast(why, 5000);
  renderVoiceBits();
});
live.on('rtc', (d) => Voice.onRtc(d.from, d.data));
live.on('msg', (d) => onMessage(`c:${d.msg.channelId}`, d.msg));
live.on('dm', (d) => {
  const key = `d:${d.withUserId}`;
  const cur = S.dms.get(d.withUserId) || { id: d.msg.dmId, userId: d.withUserId, unread: 0 };
  cur.id = d.msg.dmId; cur.lastId = d.msg.id; cur.lastAt = d.msg.at;
  S.dms.set(d.withUserId, cur);
  onMessage(key, d.msg);
});
live.on('msg.edit', (d) => {
  const key = d.msg.channelId ? `c:${d.msg.channelId}` : dmKeyById(d.msg.dmId);
  const m = key && S.msgs.get(key);
  if (!m) return;
  const i = m.list.findIndex((x) => x.id === d.msg.id);
  if (i >= 0) { m.list[i] = d.msg; if (msgKey() === key) renderMessages(true); }
});
live.on('msg.del', (d) => {
  const key = d.channelId ? `c:${d.channelId}` : dmKeyById(d.dmId);
  const m = key && S.msgs.get(key);
  if (!m) return;
  m.list = m.list.filter((x) => x.id !== d.id);
  if (msgKey() === key) renderMessages(true);
});
live.on('read', (d) => {
  if (d.target.startsWith('c:')) { const f = findChannel(Number(d.target.slice(2))); if (f && f.channel.lastId <= d.id) { f.channel.unread = 0; f.channel.mentions = 0; } }
  else for (const x of S.dms.values()) if (`d:${x.id}` === d.target && x.lastId <= d.id) x.unread = 0;
  renderRail(); renderSide();
});
live.on('friend', (d) => {
  const prev = S.friends.get(d.id);
  if (d.state) S.friends.set(d.id, d.state); else S.friends.delete(d.id);
  if (d.state === 'incoming' && prev !== 'incoming') { chime('msg', V.deafened); toast(`${nameOf(d.id)} sent you a friend request.`, 5000, { label: 'View', fn: () => { S.friendTab = 'pending'; setView({ kind: 'friends' }); } }); }
  if (d.state === 'friends' && prev === 'outgoing') toast(`${nameOf(d.id)} accepted your friend request.`, 4000);
  renderRail(); renderSide();
  if (S.view.kind === 'friends') renderFriends();
});
live.on('feedback.new', () => { S.fbCount++; renderFbCount(); });
const dmKeyById = (dmId) => { for (const x of S.dms.values()) if (x.id === dmId) return `d:${x.userId}`; return null; };

/* ================= navigation ================= */
function setView(v) {
  S.view = v;
  cancelReply(); closeMentionPop(); closeSearch();
  if (v.serverId) S.lastChan[v.serverId] = { kind: v.kind, channelId: v.channelId };
  store.set('lastChan', S.lastChan);
  store.set('lastView', v);
  $('#room').classList.remove('drawer-open'); $('#drawerScrim').hidden = true;
  renderAll();
  openCurrent();
}
function openServer(id, quiet) {
  const s = S.servers.get(id);
  if (!s) return;
  const last = S.lastChan[id];
  const c = last && s.channels.find((x) => x.id === last.channelId && x.kind === 'text') || s.channels.find((x) => x.kind === 'text');
  const v = c ? { kind: 'text', serverId: id, channelId: c.id } : { kind: 'voice', serverId: id, channelId: (s.channels[0] || {}).id };
  if (quiet) S.view = v; else setView(v);
}
function openCurrent() {
  const key = msgKey();
  if (!key) return;
  const m = S.msgs.get(key);
  if (!m || !m.loaded) loadHistory(key); else { renderMessages(); markViewedRead(); }
  if (!isPhone()) setTimeout(() => $('#chatInput').focus(), 0);
}
const isPhone = () => matchMedia('(max-width: 860px)').matches;
async function loadHistory(key, older) {
  let m = S.msgs.get(key);
  if (!m) { m = { list: [], loaded: false, hasMore: true, loading: false }; S.msgs.set(key, m); }
  if (m.loading || (older && !m.hasMore)) return;
  m.loading = true;
  if (!older) renderMessages();
  const before = older && m.list.length ? m.list[0].id : 0;
  try {
    const path = key.startsWith('c:') ? `/api/channels/${key.slice(2)}/messages` : `/api/dms/${key.slice(2)}/messages`;
    const r = await api(`${path}${before ? `?before=${before}` : ''}`);
    const ids = new Set(m.list.map((x) => x.id));
    const got = r.messages.filter((x) => !ids.has(x.id));
    m.list = older ? got.concat(m.list) : got.concat(m.list.filter((x) => x.id > (got.length ? got[got.length - 1].id : 0)));
    m.hasMore = r.messages.length >= 50;
    m.loaded = true;
  } catch (e) { toast(e.message, 4000); }
  m.loading = false;
  if (msgKey() === key) {
    const box = $('#messages'), fromBottom = box.scrollHeight - box.scrollTop;
    renderMessages();
    if (older) box.scrollTop = box.scrollHeight - fromBottom;
    markViewedRead();
  }
}
function markViewedRead() {
  if (document.hidden) return;
  if (S.view.kind === 'text') {
    const f = findChannel(S.view.channelId);
    if (f && (f.channel.unread || f.channel.lastId)) { f.channel.unread = 0; f.channel.mentions = 0; live.send('read', { target: `c:${f.channel.id}`, id: f.channel.lastId || 0 }); }
  } else if (S.view.kind === 'dm') {
    const x = S.dms.get(S.view.userId);
    if (x && x.id) { x.unread = 0; live.send('read', { target: `d:${x.id}`, id: x.lastId || 0 }); }
  }
  renderRail(); renderSide(); updateBadge();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.ready) markViewedRead(); });

function onMessage(key, msg) {
  const m = S.msgs.get(key);
  if (m && m.loaded && !m.list.some((x) => x.id === msg.id)) m.list.push(msg);
  if (typing.has(key)) { typing.get(key).delete(msg.userId); renderTyping(); }
  const mine = msg.userId === S.me.id;
  const viewing = msgKey() === key && !document.hidden;
  if (key.startsWith('c:')) {
    const f = findChannel(msg.channelId);
    if (f) {
      f.channel.lastId = msg.id;
      if (!mine && !viewing) f.channel.unread = (f.channel.unread || 0) + 1;
      if (!mine && !viewing && mentionsMe(msg)) {
        f.channel.mentions = (f.channel.mentions || 0) + 1;
        chime('msg', V.deafened);
        notify(`${nameOf(msg.userId)} in #${f.channel.name}`, decodeMentions(msg.body), () => setView({ kind: 'text', serverId: f.server.id, channelId: f.channel.id }));
      }
    }
  } else {
    const x = S.dms.get(Number(key.slice(2)));
    if (x && !mine && !viewing) x.unread = (x.unread || 0) + 1;
    if (!mine && !viewing) {
      chime('msg', V.deafened);
      notify(nameOf(msg.userId), decodeMentions(msg.body) || 'Sent a photo or video', () => setView({ kind: 'dm', userId: msg.userId }));
    }
  }
  if (msgKey() === key) { appendMessage(msg); if (viewing) markViewedRead(); }
  renderRail(); renderSide(); updateBadge();
}
function notify(title, body, onClick) {
  if (!document.hidden || !settings.notify || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body: String(body).slice(0, 140), silent: true, tag: 'pl-' + title });
    n.onclick = () => { window.focus(); if (desktop && desktop.focus) desktop.focus(); onClick(); n.close(); };
  } catch {}
}
function updateBadge() {
  let n = 0;
  for (const x of S.dms.values()) n += x.unread || 0;
  for (const st of S.friends.values()) if (st === 'incoming') n++;
  for (const s of S.servers.values()) for (const c of s.channels) n += c.mentions || 0;
  document.title = n ? `(${n}) Party Line` : 'Party Line';
  if (desktop && desktop.setBadge) desktop.setBadge(n);
}

/* ================= rendering ================= */
function renderAll() {
  if (!S.ready) return;
  renderRail(); renderSide(); renderHeader(); renderMainView(); renderUserArea(); renderConn(); updateBadge();
}
function renderRail() {
  const homeUnread = [...S.dms.values()].reduce((a, x) => a + (x.unread || 0), 0) + [...S.friends.values()].filter((s) => s === 'incoming').length;
  const homeOn = !S.view.serverId;
  $('#railHome').setAttribute('aria-current', String(homeOn));
  $('#railHomeItem').classList.toggle('current', homeOn);
  $('#railHomeBadge').hidden = !homeUnread; $('#railHomeBadge').textContent = homeUnread > 99 ? '99+' : homeUnread;
  const list = $('#railList');
  list.textContent = '';
  for (const s of S.servers.values()) {
    const li = document.createElement('li');
    const on = S.view.serverId === s.id;
    const unread = s.channels.some((c) => c.unread);
    li.className = 'rail-item' + (on ? ' current' : '') + (unread && !on ? ' joined' : '');
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'rail-btn'; b.title = s.name; b.setAttribute('aria-label', s.name);
    b.setAttribute('aria-current', String(on));
    b.style.setProperty('--h', hue(s.name));
    b.textContent = serverInitials(s.name);
    b.addEventListener('click', () => openServer(s.id));
    li.appendChild(b);
    const pings = s.channels.reduce((a, c) => a + (c.mentions || 0), 0);
    if (pings && !on) { const bd = document.createElement('span'); bd.className = 'rail-badge'; bd.textContent = pings > 99 ? '99+' : pings; li.appendChild(bd); }
    else if (V.channelId && s.channels.some((c) => c.id === V.channelId)) {
      const dot = document.createElement('span'); dot.className = 'rail-badge'; dot.style.background = 'var(--ok)'; dot.textContent = '♪'; li.appendChild(dot);
    }
    list.appendChild(li);
  }
  const anyUnread = homeUnread || [...S.servers.values()].some((s) => s.channels.some((c) => c.unread));
  $('#drawerBadge').hidden = !anyUnread;
}
function renderSide() {
  if (!S.ready) return;
  const home = !S.view.serverId;
  $('#room').classList.toggle('home', home);
  if (home) { renderHomeSide(); return; }
  const s = curServer();
  if (!s) return;
  $('#serverName').textContent = s.name;
  const tl = $('#textList'), vl = $('#voiceList');
  tl.textContent = ''; vl.textContent = '';
  const manage = canManage(s);
  for (const c of [...s.channels].sort((a, b) => a.position - b.position || a.id - b.id)) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chan';
    const current = S.view.channelId === c.id;
    b.setAttribute('aria-current', String(current));
    if (c.kind === 'text') {
      if (c.unread && !current) b.classList.add('unread');
      b.innerHTML = '<span class="glyph" aria-hidden="true">#</span>';
      const n = document.createElement('span'); n.className = 'chan-name'; n.textContent = c.name; b.appendChild(n);
      if (c.mentions && !current) { const bd = document.createElement('span'); bd.className = 'chan-badge'; bd.title = 'Mentions of you'; bd.textContent = c.mentions > 99 ? '99+' : c.mentions; b.appendChild(bd); }
      b.addEventListener('click', () => setView({ kind: 'text', serverId: s.id, channelId: c.id }));
      li.appendChild(b);
      tl.appendChild(li);
    } else {
      const people = voiceIn(c.id);
      if (V.channelId === c.id) b.classList.add('in-voice');
      b.innerHTML = iconSvg('volume');
      const n = document.createElement('span'); n.className = 'chan-name'; n.textContent = c.name; b.appendChild(n);
      if (people.some((p) => p.sharing)) { const l = document.createElement('span'); l.className = 'chan-live'; l.textContent = 'LIVE'; b.appendChild(l); }
      b.addEventListener('click', () => { setView({ kind: 'voice', serverId: s.id, channelId: c.id }); if (V.channelId !== c.id) joinVoice(c.id); });
      li.appendChild(b);
      if (people.length) {
        const ul = document.createElement('ul'); ul.className = 'members';
        for (const p of people) {
          const mi = document.createElement('li');
          const mb = document.createElement('button');
          mb.type = 'button'; mb.className = 'member' + (p.userId === S.me.id ? ' is-me' : '') + (V.speaking.has(p.userId) ? ' speaking' : '');
          mb.dataset.uid = p.userId;
          mb.appendChild(avEl(p.userId));
          const nm = document.createElement('span'); nm.className = 'member-name'; nm.textContent = nameOf(p.userId); mb.appendChild(nm);
          if (p.sharing) { const l = document.createElement('span'); l.className = 'chan-live'; l.textContent = 'LIVE'; mb.appendChild(l); }
          if (p.deafened) mb.insertAdjacentHTML('beforeend', iconSvg('headphones-off'));
          else if (p.muted || p.serverMuted) mb.insertAdjacentHTML('beforeend', iconSvg('mic-off'));
          mb.addEventListener('click', (e) => openUserPop(p.userId, e.currentTarget));
          mi.appendChild(mb); ul.appendChild(mi);
        }
        li.appendChild(ul);
      }
      vl.appendChild(li);
    }
    if (manage) {
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'chan-del'; del.title = `Delete ${c.name}`; del.setAttribute('aria-label', `Delete ${c.name}`);
      del.innerHTML = iconSvg('trash');
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (await confirmBox(`Delete ${c.kind === 'text' ? '#' : ''}${c.name}?`, c.kind === 'text' ? 'All its messages are deleted for everyone.' : 'Anyone talking in it is disconnected.')) act(() => live.req('chan.delete', { id: c.id }));
      });
      li.appendChild(del);
    }
  }
  $('#mRename').hidden = !manage;
  $('#mDelete').hidden = !manage || s.isDefault;
}
function renderHomeSide() {
  $('#navFriends').setAttribute('aria-current', String(S.view.kind === 'friends'));
  const pend = [...S.friends.values()].filter((s) => s === 'incoming').length;
  for (const el of [$('#pendingCount'), $('#pendingCount2')]) { el.hidden = !pend; el.textContent = pend; }
  const list = $('#dmList');
  list.textContent = '';
  const ids = new Set([...S.dms.keys()]);
  if (S.view.kind === 'dm') ids.add(S.view.userId);
  const sorted = [...ids].sort((a, b) => ((S.dms.get(b) || {}).lastAt || Infinity) - ((S.dms.get(a) || {}).lastAt || Infinity));
  for (const id of sorted) {
    const x = S.dms.get(id) || {};
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'dm-item' + (x.unread ? ' unread' : '');
    b.setAttribute('aria-current', String(S.view.kind === 'dm' && S.view.userId === id));
    const w = document.createElement('span'); w.className = 'av-wrap'; w.appendChild(avEl(id));
    const dot = document.createElement('span'); dot.className = 'status-dot' + (user(id).online ? ' on' : ''); w.appendChild(dot);
    b.appendChild(w);
    const n = document.createElement('span'); n.className = 'dm-name'; n.textContent = nameOf(id); b.appendChild(n);
    if (x.unread) { const c = document.createElement('span'); c.className = 'count-pill'; c.textContent = x.unread; b.appendChild(c); }
    b.addEventListener('click', () => setView({ kind: 'dm', userId: id }));
    li.appendChild(b); list.appendChild(li);
  }
  $('#dmEmpty').hidden = sorted.length > 0;
}
function renderConn() {
  if (!S.ready) return;
  const up = live.open;
  $('#statusDot').className = 'dot' + (up ? '' : ' bad');
  $('#statusText').textContent = up ? 'Connected' : 'Reconnecting…';
  const s = curServer();
  if (s) {
    const on = s.members.filter((id) => user(id).online).length;
    $('#countText').textContent = `${on} online · ${s.members.length} member${s.members.length === 1 ? '' : 's'}`;
  }
}
function renderHeader() {
  const v = S.view, icon = $('#viewIcon');
  $('#copyInvite').hidden = !v.serverId;
  if (v.kind === 'friends') { icon.innerHTML = iconSvg('users'); $('#viewTitle').textContent = 'Friends'; $('#viewSub').textContent = ''; }
  else if (v.kind === 'dm') {
    icon.textContent = '@'; $('#viewTitle').textContent = nameOf(v.userId);
    $('#viewSub').textContent = user(v.userId).online ? 'Online' : 'Offline';
  } else {
    const f = findChannel(v.channelId);
    if (!f) return;
    if (v.kind === 'text') icon.textContent = '#'; else icon.innerHTML = iconSvg('volume');
    $('#viewTitle').textContent = f.channel.name;
    $('#viewSub').textContent = f.server.name;
  }
}
function renderMainView() {
  const k = S.view.kind;
  $('#viewText').hidden = k !== 'text' && k !== 'dm';
  $('#viewHome').hidden = k !== 'friends';
  $('#viewVoice').hidden = k !== 'voice';
  if (k === 'friends') renderFriends();
  if (k === 'voice') renderVoiceView();
  if (k === 'text' || k === 'dm') {
    const f = k === 'text' && findChannel(S.view.channelId);
    $('#chatInput').placeholder = k === 'dm' ? `Message @${nameOf(S.view.userId)}` : f ? `Message #${f.channel.name}` : 'Message';
  }
}
function renderVoiceBits() { renderSide(); renderRail(); renderUserArea(); if (S.view.kind === 'voice') renderVoiceView(); }

/* ================= messages ================= */
const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;
const TOKEN_RE = new RegExp(`${URL_RE.source}|<@(\\d+)>`, 'g');
/* Message text with clickable links and @mentions. Mentions are stored as <@userId>. */
function richText(el, text) {
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
    if (m[1]) {
      const id = Number(m[1]);
      const b = document.createElement('button'); b.type = 'button'; b.className = 'mention' + (id === S.me.id ? ' me' : '');
      b.textContent = `@${nameOf(id)}`;
      b.addEventListener('click', (e) => openUserPop(id, e.currentTarget));
      el.appendChild(b);
    } else {
      const a = document.createElement('a'); a.href = m[0]; a.textContent = m[0]; a.target = '_blank'; a.rel = 'noopener noreferrer';
      el.appendChild(a);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Everyone you can mention here: the server's members, or the two of you in a private chat.
const mentionables = () => (S.view.kind === 'dm' ? [S.view.userId, S.me.id] : (curServer() || { members: [] }).members);
/* "@Deniz Can" -> "<@12>". Longest names first, so "Deniz Can" wins over "Deniz". */
function encodeMentions(text) {
  const people = mentionables().map(user).filter((u) => u.name).sort((a, b) => b.name.length - a.name.length);
  for (const u of people) text = text.replace(new RegExp(`(^|[^\\p{L}\\p{N}_])@${escapeRe(u.name)}(?![\\p{L}\\p{N}_])`, 'giu'), `$1<@${u.id}>`);
  return text;
}
const decodeMentions = (text) => String(text || '').replace(/<@(\d+)>/g, (x, id) => `@${nameOf(Number(id))}`);
const mentionsMe = (msg) => !!msg.body && msg.body.includes(`<@${S.me.id}>`);
let lastRendered = { author: null, at: 0 };
function messageEl(msg, prev) {
  const cont = !msg.reply && prev && prev.userId === msg.userId && msg.at - prev.at < 5 * 60_000 && fmtDay(prev.at) === fmtDay(msg.at);
  const li = document.createElement('li');
  li.className = 'msg' + (cont ? ' cont' : '') + (msg.reply ? ' has-reply' : '') + (mentionsMe(msg) ? ' mentioned' : '');
  li.dataset.id = msg.id;
  if (msg.reply) {
    const r = document.createElement('button'); r.type = 'button'; r.className = 'msg-reply';
    if (msg.reply.deleted) r.textContent = 'Original message was deleted';
    else {
      r.appendChild(avEl(msg.reply.userId));
      const n = document.createElement('b'); n.textContent = nameOf(msg.reply.userId); r.appendChild(n);
      const t = document.createElement('span'); t.textContent = msg.reply.body ? decodeMentions(msg.reply.body) : 'Photo or video'; r.appendChild(t);
      r.addEventListener('click', () => jumpTo(msgKey(), msg.reply.id));
    }
    li.appendChild(r);
  }
  const av = avEl(msg.userId); av.style.cursor = 'pointer';
  av.addEventListener('click', (e) => openUserPop(msg.userId, e.currentTarget));
  li.appendChild(av);
  const head = document.createElement('div'); head.className = 'msg-head';
  const nm = document.createElement('span'); nm.className = 'msg-name'; nm.style.setProperty('--h', hue(nameOf(msg.userId))); nm.textContent = nameOf(msg.userId);
  if (user(msg.userId).admin) nm.insertAdjacentHTML('beforeend', `<span class="crown" title="Admin">${iconSvg('crown')}</span>`);
  head.appendChild(nm);
  const tm = document.createElement('time'); tm.className = 'msg-time'; tm.dateTime = new Date(msg.at).toISOString();
  tm.textContent = `${fmtDay(msg.at)} ${fmtTime(msg.at)}`; tm.title = new Date(msg.at).toLocaleString();
  head.appendChild(tm);
  li.appendChild(head);
  if (msg.body) {
    const body = document.createElement('div'); body.className = 'msg-body';
    richText(body, msg.body);
    if (msg.editedAt) { const e = document.createElement('span'); e.className = 'msg-edited'; e.textContent = '(edited)'; body.appendChild(e); }
    li.appendChild(body);
  }
  for (const a of msg.attachments || []) li.appendChild(mediaEl(a));
  if (msg.reactions && msg.reactions.length) li.appendChild(reactionsEl(msg));
  const mine = msg.userId === S.me.id;
  const srv = msg.channelId ? (findChannel(msg.channelId) || {}).server : null;
  const tools = document.createElement('div'); tools.className = 'msg-tools';
  const tool = (icon, label, fn, cls = '') => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'msg-tool ' + cls; b.title = label; b.setAttribute('aria-label', label);
    b.innerHTML = iconSvg(icon); b.addEventListener('click', fn); tools.appendChild(b);
  };
  tool('smile', 'Add reaction', (e) => openEmojiPop(msg, e.currentTarget));
  tool('reply', 'Reply', () => startReply(msg));
  if (mine && msg.body) tool('pencil', 'Edit', () => editMessage(li, msg));
  if (mine || S.me.admin || (srv && canManage(srv))) {
    tool('trash', 'Delete', async (ev) => {
      if (ev.shiftKey || await confirmBox('Delete this message?', 'It’s removed for everyone. Hold Shift while clicking to skip this question.')) act(() => live.req('msg.delete', { id: msg.id }));
    }, 'del');
  }
  li.appendChild(tools);
  return li;
}

/* ---------- reactions ---------- */
const QUICK_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👀', '💯', '🙏', '😡', '✅'];
function reactionsEl(msg) {
  const row = document.createElement('div'); row.className = 'reactions';
  for (const r of msg.reactions) {
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'reaction' + (r.users.includes(S.me.id) ? ' mine' : '');
    b.textContent = `${r.emoji} ${r.users.length}`;
    b.title = `${r.users.map(nameOf).join(', ')} reacted with ${r.emoji}`;
    b.setAttribute('aria-pressed', String(r.users.includes(S.me.id)));
    b.addEventListener('click', () => toggleReaction(msg, r.emoji));
    row.appendChild(b);
  }
  const add = document.createElement('button'); add.type = 'button'; add.className = 'reaction add'; add.title = 'Add reaction'; add.setAttribute('aria-label', 'Add reaction');
  add.innerHTML = iconSvg('smile'); add.addEventListener('click', (e) => openEmojiPop(msg, e.currentTarget));
  row.appendChild(add);
  return row;
}
function toggleReaction(msg, emoji) {
  const r = (msg.reactions || []).find((x) => x.emoji === emoji);
  live.req('react', { id: msg.id, emoji, on: !(r && r.users.includes(S.me.id)) }).catch((e) => toast(e.message, 3000));
}
let emojiFor = null;
function openEmojiPop(msg, anchor) {
  const pop = $('#emojiPop');
  if (!pop.hidden && emojiFor === msg.id) { closeEmojiPop(); return; }
  emojiFor = msg.id;
  pop.textContent = '';
  for (const e of QUICK_EMOJI) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = e; b.setAttribute('aria-label', `React with ${e}`);
    b.addEventListener('click', () => { toggleReaction(msg, e); closeEmojiPop(); });
    pop.appendChild(b);
  }
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.right - pop.offsetWidth))}px`;
  pop.style.top = `${r.top - pop.offsetHeight - 6 < 8 ? r.bottom + 6 : r.top - pop.offsetHeight - 6}px`;
  pop.firstChild.focus();
}
function closeEmojiPop() { $('#emojiPop').hidden = true; emojiFor = null; }
document.addEventListener('pointerdown', (e) => { if (!$('#emojiPop').hidden && !e.target.closest('#emojiPop, .msg-tool, .reaction.add')) closeEmojiPop(); });
live.on('reactions', (d) => {
  const key = d.channelId ? `c:${d.channelId}` : dmKeyById(d.dmId);
  const m = key && S.msgs.get(key);
  const msg = m && m.list.find((x) => x.id === d.id);
  if (!msg) return;
  msg.reactions = d.reactions;
  if (msgKey() === key) renderMessages(true);
});

/* ---------- jumping to a message (replies and search) ---------- */
async function jumpTo(key, id) {
  if (msgKey() !== key) {
    if (key.startsWith('c:')) { const f = findChannel(Number(key.slice(2))); if (!f) return; setView({ kind: 'text', serverId: f.server.id, channelId: f.channel.id }); }
    else setView({ kind: 'dm', userId: Number(key.slice(2)) });
  }
  for (let i = 0; i < 60; i++) {
    const m = S.msgs.get(key);
    if (m && m.loaded && (m.list.some((x) => x.id === id) || !m.hasMore)) break;
    if (!m || m.loading) { await new Promise((r) => setTimeout(r, 100)); continue; }
    await loadHistory(key, true);
  }
  const el = document.querySelector(`.msg[data-id="${id}"]`);
  if (!el) { toast('That message is gone.', 2500); return; }
  el.scrollIntoView({ block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 2200);
}
function mediaEl(a) {
  const wrap = document.createElement('div'); wrap.className = 'msg-media';
  const url = absUrl(a.url);
  if (a.type.startsWith('image/')) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'media-btn'; b.setAttribute('aria-label', `Open ${a.name}`);
    const img = document.createElement('img'); img.className = 'media-img'; img.loading = 'lazy'; img.src = url; img.alt = a.name;
    img.addEventListener('load', () => { const box = $('#messages'); if (box.scrollHeight - box.scrollTop - box.clientHeight < img.height + 120) box.scrollTop = box.scrollHeight; });
    b.appendChild(img);
    b.addEventListener('click', () => openLightbox(url, a.name));
    wrap.appendChild(b);
  } else {
    const v = document.createElement('video'); v.className = 'media-video'; v.controls = true; v.preload = 'metadata'; v.src = url; v.playsInline = true;
    wrap.appendChild(v);
  }
  const meta = document.createElement('div'); meta.className = 'media-meta';
  const n = document.createElement('span'); n.textContent = `${a.name} · ${fmtSize(a.size)}`; meta.appendChild(n);
  const dl = document.createElement('a'); dl.href = url; dl.download = a.name; dl.textContent = 'Save'; meta.appendChild(dl);
  wrap.appendChild(meta);
  return wrap;
}
function introEl() {
  const li = document.createElement('li'); li.className = 'chan-intro';
  const g = document.createElement('div'); g.className = 'glyph-big';
  const h = document.createElement('h2'), p = document.createElement('p');
  if (S.view.kind === 'dm') {
    li.classList.add('dm-intro');
    const w = document.createElement('span'); w.className = 'av-wrap'; w.appendChild(avEl(S.view.userId));
    const dot = document.createElement('span'); dot.className = 'status-dot' + (user(S.view.userId).online ? ' on' : ''); w.appendChild(dot);
    li.appendChild(w);
    h.textContent = nameOf(S.view.userId);
    p.textContent = `This is the start of your private chat with ${nameOf(S.view.userId)}. Only the two of you can see it.`;
  } else {
    const f = findChannel(S.view.channelId);
    g.textContent = '#'; li.appendChild(g);
    h.textContent = `Welcome to #${f ? f.channel.name : ''}`;
    p.textContent = 'This is the start of the channel. Messages, photos and videos posted here are saved for everyone in the server.';
  }
  li.appendChild(h); li.appendChild(p);
  return li;
}
function renderMessages(keepScroll) {
  const key = msgKey(), box = $('#messages');
  if (!key) return;
  const m = S.msgs.get(key) || { list: [], loaded: false };
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const top = box.scrollTop;
  box.textContent = '';
  if (m.hasMore && m.loaded) {
    const more = document.createElement('button'); more.type = 'button'; more.className = 'btn small load-more'; more.textContent = m.loading ? 'Loading…' : 'Load older messages';
    more.addEventListener('click', () => loadHistory(key, true));
    box.appendChild(more);
  } else if (m.loaded) box.appendChild(introEl());
  if (!m.loaded) { const li = document.createElement('li'); li.className = 'sys'; li.textContent = 'Loading messages…'; box.appendChild(li); }
  let prev = null;
  for (const msg of m.list) { box.appendChild(messageEl(msg, prev)); prev = msg; }
  lastRendered = { key, prev };
  if (keepScroll && !atBottom) box.scrollTop = top; else box.scrollTop = box.scrollHeight;
}
function appendMessage(msg) {
  const box = $('#messages');
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120 || msg.userId === S.me.id;
  const m = S.msgs.get(msgKey());
  const list = m ? m.list : [];
  const prev = list.length > 1 ? list[list.length - 2] : null;
  box.appendChild(messageEl(msg, prev));
  if (near) box.scrollTop = box.scrollHeight;
}
function rerenderMessagesSoft() { if (S.view.kind === 'text' || S.view.kind === 'dm') renderMessages(true); }
$('#messages').addEventListener('scroll', () => {
  const box = $('#messages'), key = msgKey(), m = key && S.msgs.get(key);
  if (box.scrollTop < 80 && m && m.loaded && m.hasMore && !m.loading) loadHistory(key, true);
});
function editMessage(li, msg) {
  if (li.querySelector('.msg-editbox')) return;
  const body = li.querySelector('.msg-body');
  const box = document.createElement('div'); box.className = 'msg-editbox';
  const ta = document.createElement('textarea'); ta.value = decodeMentions(msg.body); ta.maxLength = 4000;
  const hint = document.createElement('small'); hint.textContent = 'Enter to save · Esc to cancel';
  box.appendChild(ta); box.appendChild(hint);
  if (body) body.replaceWith(box); else li.appendChild(box);
  ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  const done = () => renderMessages(true);
  ta.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { e.preventDefault(); done(); }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const t = encodeMentions(ta.value.trim());
      if (!t || t === msg.body) { done(); return; }
      await act(() => live.req('msg.edit', { id: msg.id, body: t }));
      done();
    }
  });
}

/* ---------- who's typing ---------- */
const typing = new Map();   // message key -> Map(userId -> show until)
live.on('typing', (d) => {
  const key = d.channelId ? `c:${d.channelId}` : `d:${d.dmUserId}`;
  if (!typing.has(key)) typing.set(key, new Map());
  typing.get(key).set(d.userId, Date.now() + 6000);
  renderTyping();
});
function renderTyping() {
  const key = msgKey(), m = key && typing.get(key), t = Date.now();
  const names = m ? [...m].filter(([, until]) => until > t).map(([id]) => nameOf(id)) : [];
  $('#typingLine').textContent = !names.length ? '' : names.length === 1 ? `${names[0]} is typing…`
    : names.length === 2 ? `${names[0]} and ${names[1]} are typing…` : 'Several people are typing…';
}
setInterval(renderTyping, 1000);

/* ---------- composer ---------- */
const chatInput = $('#chatInput');
function autosize() { chatInput.style.height = 'auto'; chatInput.style.height = Math.min(220, chatInput.scrollHeight) + 'px'; }
const composeTarget = () => (S.view.kind === 'text' ? { channelId: S.view.channelId } : S.view.kind === 'dm' ? { toUserId: S.view.userId } : null);
let typingSentAt = 0;
chatInput.addEventListener('input', () => {
  autosize();
  updateMentionPop();
  const t = composeTarget();
  if (t && chatInput.value.trim() && Date.now() - typingSentAt > 3000) { typingSentAt = Date.now(); live.send('typing', t); }
});
chatInput.addEventListener('click', updateMentionPop);
chatInput.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== chatInput) closeMentionPop(); }, 150));

function startReply(msg) {
  S.replyTo = msg;
  $('#replyText').textContent = `Replying to ${nameOf(msg.userId)}`;
  $('#replyBar').hidden = false;
  chatInput.focus();
}
function cancelReply() { S.replyTo = null; $('#replyBar').hidden = true; }
$('#replyX').addEventListener('click', cancelReply);

/* Typing "@" shows the people you can mention. */
let mention = null;   // { start, end, items, index }
function updateMentionPop() {
  const pos = chatInput.selectionStart, before = chatInput.value.slice(0, pos);
  const m = /(^|\s)@([^\s@]{0,24})$/u.exec(before);
  if (!m) { closeMentionPop(); return; }
  const q = m[2].toLowerCase();
  const items = mentionables().filter((id) => id !== S.me.id).map(user)
    .filter((u) => u.name.toLowerCase().includes(q))
    .sort((a, b) => (b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name)).slice(0, 8);
  if (!items.length) { closeMentionPop(); return; }
  mention = { start: pos - m[2].length - 1, end: pos, items, index: 0 };
  renderMentionPop();
}
function renderMentionPop() {
  const pop = $('#mentionPop');
  pop.textContent = '';
  mention.items.forEach((u, i) => {
    const li = document.createElement('li'); li.setAttribute('role', 'option'); li.setAttribute('aria-selected', String(i === mention.index));
    li.appendChild(avEl(u.id));
    const n = document.createElement('span'); n.textContent = u.name; li.appendChild(n);
    li.addEventListener('pointerdown', (e) => { e.preventDefault(); pickMention(u); });
    pop.appendChild(li);
  });
  pop.hidden = false;
}
function closeMentionPop() { mention = null; $('#mentionPop').hidden = true; }
function pickMention(u) {
  const v = chatInput.value, ins = `@${u.name} `;
  chatInput.value = v.slice(0, mention.start) + ins + v.slice(mention.end);
  const caret = mention.start + ins.length;
  chatInput.setSelectionRange(caret, caret);
  closeMentionPop();
  chatInput.focus();
}

chatInput.addEventListener('keydown', (e) => {
  if (mention) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); mention.index = (mention.index + (e.key === 'ArrowDown' ? 1 : -1) + mention.items.length) % mention.items.length; renderMentionPop(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mention.items[mention.index]); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeMentionPop(); return; }
  }
  if (e.key === 'Escape' && S.replyTo) { e.preventDefault(); cancelReply(); return; }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isPhone()) { e.preventDefault(); $('#chatForm').requestSubmit(); }
  if (e.key === 'ArrowUp' && !chatInput.value) {
    const m = S.msgs.get(msgKey());
    const mine = m && [...m.list].reverse().find((x) => x.userId === S.me.id && x.body);
    const li = mine && document.querySelector(`.msg[data-id="${mine.id}"]`);
    if (li) { e.preventDefault(); editMessage(li, mine); }
  }
});
$('#chatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (S.sending) return;
  const body = encodeMentions(chatInput.value.trim());
  if (!body && !S.attach.length) return;
  const target = composeTarget();
  if (!target) return;
  if (!live.open) { toast('Not connected to the server right now. Your message is still in the box.', 4000); return; }
  S.sending = true;
  try {
    const ids = [];
    for (const a of S.attach) {
      if (!a.id) { const r = await upload('/api/upload', a.file, (p) => setAttachProgress(a, p)); a.id = r.id; }
      ids.push({ id: a.id });
    }
    await live.req('msg.send', Object.assign({ body, attachments: ids, replyTo: S.replyTo ? S.replyTo.id : null }, target));
    chatInput.value = ''; autosize();
    clearAttach(); cancelReply();
    typingSentAt = 0;
  } catch (ex) { toast(ex.message, 5000); }
  finally { S.sending = false; renderTray(); }
});
$('#attachBtn').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
function addFiles(files) {
  for (const f of files) {
    const isImg = /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(f.type), isVid = /^video\/(mp4|webm|quicktime)$/.test(f.type);
    if (!isImg && !isVid) { toast(`${f.name}: only photos and videos can be shared.`, 4000); continue; }
    if (f.size > (isImg ? MAX_IMAGE : MAX_VIDEO)) { toast(`${f.name} is too big. The limit is ${isImg ? 15 : 50} MB.`, 4500); continue; }
    if (S.attach.length >= 10) { toast('Up to 10 files per message.', 3000); break; }
    S.attach.push({ file: f, url: URL.createObjectURL(f), progress: 0 });
  }
  renderTray();
}
function clearAttach() { for (const a of S.attach) URL.revokeObjectURL(a.url); S.attach = []; renderTray(); }
function setAttachProgress(a, p) { a.progress = p; const bar = document.querySelector(`.att[data-u="${CSS.escape(a.url)}"] .bar i`); if (bar) bar.style.width = `${Math.round(p * 100)}%`; }
function renderTray() {
  const tray = $('#tray');
  tray.textContent = '';
  tray.hidden = !S.attach.length;
  for (const a of S.attach) {
    const d = document.createElement('div'); d.className = 'att'; d.dataset.u = a.url;
    const media = document.createElement(a.file.type.startsWith('image/') ? 'img' : 'video');
    media.src = a.url; if (media.tagName === 'VIDEO') media.muted = true;
    d.appendChild(media);
    const n = document.createElement('span'); n.className = 'att-name'; n.textContent = a.file.name; d.appendChild(n);
    if (S.sending) { const bar = document.createElement('div'); bar.className = 'bar'; bar.innerHTML = `<i style="width:${Math.round(a.progress * 100)}%"></i>`; d.appendChild(bar); }
    else {
      const x = document.createElement('button'); x.type = 'button'; x.className = 'att-x'; x.setAttribute('aria-label', `Remove ${a.file.name}`); x.innerHTML = iconSvg('x');
      x.addEventListener('click', () => { URL.revokeObjectURL(a.url); S.attach = S.attach.filter((y) => y !== a); renderTray(); });
      d.appendChild(x);
    }
    tray.appendChild(d);
  }
}
const vt = $('#viewText');
let dragDepth = 0;
vt.addEventListener('dragenter', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; $('#dropzone').hidden = false; } });
vt.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropzone').hidden = true; });
vt.addEventListener('dragover', (e) => e.preventDefault());
vt.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; $('#dropzone').hidden = true; addFiles([...(e.dataTransfer.files || [])]); });
chatInput.addEventListener('paste', (e) => { const files = [...(e.clipboardData && e.clipboardData.files || [])]; if (files.length) { e.preventDefault(); addFiles(files); } });

function openLightbox(url, name) { $('#lbImg').src = url; $('#lbName').textContent = name; $('#lbSave').href = url; $('#lbSave').download = name; $('#lightbox').hidden = false; $('#lbClose').focus(); }
$('#lbClose').addEventListener('click', () => { $('#lightbox').hidden = true; $('#lbImg').src = ''; });
$('#lightbox').addEventListener('click', (e) => { if (e.target === e.currentTarget || e.target.id === 'lbImg') $('#lbClose').click(); });

/* ================= friends ================= */
document.querySelectorAll('.tabs [data-tab]').forEach((t) => t.addEventListener('click', () => { S.friendTab = t.dataset.tab; renderFriends(); }));
function renderFriends() {
  document.querySelectorAll('.tabs [data-tab]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === S.friendTab)));
  $('#frAddForm').hidden = S.friendTab !== 'add';
  const body = $('#frBody');
  body.textContent = '';
  if (S.friendTab !== 'add') {
    const rows = [...S.friends].filter(([id, st]) => (S.friendTab === 'pending' ? st !== 'friends' : st === 'friends' && (S.friendTab === 'all' || user(id).online)))
      .sort((a, b) => nameOf(a[0]).localeCompare(nameOf(b[0])));
    const title = document.createElement('h3'); title.className = 'fr-section-title';
    title.textContent = `${{ online: 'Online', all: 'All friends', pending: 'Pending' }[S.friendTab]} — ${rows.length}`;
    body.appendChild(title);
    if (!rows.length) {
      const p = document.createElement('p'); p.className = 'fr-empty';
      p.textContent = { online: 'None of your friends are online right now.', all: 'No friends yet. Press Add friend and type their name.', pending: 'No friend requests right now.' }[S.friendTab];
      body.appendChild(p);
    }
    const ul = document.createElement('ul'); ul.className = 'fr-list';
    for (const [id, st] of rows) {
      const li = document.createElement('li'); li.className = 'fr-row';
      const w = document.createElement('span'); w.className = 'av-wrap'; w.appendChild(avEl(id));
      const dot = document.createElement('span'); dot.className = 'status-dot' + (user(id).online ? ' on' : ''); w.appendChild(dot);
      li.appendChild(w);
      const t = document.createElement('div'); t.className = 'fr-text';
      const b = document.createElement('b'); b.textContent = nameOf(id); t.appendChild(b);
      const s = document.createElement('span');
      const vst = S.voice.get(id);
      s.textContent = st === 'incoming' ? 'Wants to be your friend' : st === 'outgoing' ? 'Friend request sent' : vst ? `In voice: ${(findChannel(vst.channelId) || { channel: { name: '' } }).channel.name}` : user(id).online ? 'Online' : 'Offline';
      t.appendChild(s); li.appendChild(t);
      const acts = document.createElement('div'); acts.className = 'fr-actions';
      const btn = (icon, label, cls, fn) => { const x = document.createElement('button'); x.type = 'button'; x.className = 'fr-act ' + cls; x.title = label; x.setAttribute('aria-label', label); x.innerHTML = iconSvg(icon); x.addEventListener('click', fn); acts.appendChild(x); };
      if (st === 'friends') {
        btn('chat', `Message ${nameOf(id)}`, '', () => setView({ kind: 'dm', userId: id }));
        btn('user-x', `Remove ${nameOf(id)}`, 'no', async () => { if (await confirmBox(`Remove ${nameOf(id)} as a friend?`, 'Your private chat stays, but you can’t send new messages until you’re friends again.', 'Remove')) act(() => live.req('friend.remove', { id })); });
      } else if (st === 'incoming') {
        btn('check', 'Accept', 'ok', () => act(() => live.req('friend.accept', { id })));
        btn('x', 'Ignore', 'no', () => act(() => live.req('friend.remove', { id })));
      } else btn('x', 'Cancel request', 'no', () => act(() => live.req('friend.remove', { id })));
      li.appendChild(acts);
      ul.appendChild(li);
    }
    body.appendChild(ul);
  }
  const hs = $('#homeServers');
  hs.textContent = '';
  for (const s of S.servers.values()) {
    const li = document.createElement('li');
    const b = document.createElement('button'); b.type = 'button'; b.className = 'home-server';
    const ic = document.createElement('span'); ic.className = 'rail-btn'; ic.style.setProperty('--h', hue(s.name)); ic.textContent = serverInitials(s.name);
    b.appendChild(ic);
    const t = document.createElement('span'); t.className = 'home-server-text';
    const nb = document.createElement('b'); nb.textContent = s.name; t.appendChild(nb);
    const on = s.members.filter((id) => user(id).online).length;
    const sp = document.createElement('span'); sp.textContent = `${on} online · ${s.members.length} member${s.members.length === 1 ? '' : 's'}`; t.appendChild(sp);
    b.appendChild(t);
    b.addEventListener('click', () => openServer(s.id));
    li.appendChild(b); hs.appendChild(li);
  }
  $('#homeEmpty').hidden = S.servers.size > 0;
}
$('#frAddForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const note = $('#frAddNote'), name = $('#frAddName').value.trim();
  if (!name) return;
  try {
    const r = await live.req('friend.request', { name });
    note.textContent = r.state === 'friends' ? `You and ${r.name} are now friends.` : `Friend request sent to ${r.name}.`;
    note.classList.remove('bad'); $('#frAddName').value = '';
  } catch (ex) { note.textContent = ex.message; note.classList.add('bad'); }
  note.hidden = false;
});

/* ================= voice ================= */
async function joinVoice(channelId) {
  try { await Voice.joinVoice(channelId); chime('join', V.deafened); }
  catch (e) { toast(e.message || 'Couldn’t join voice.', 4500); }
  renderVoiceBits();
}
function renderVoiceView() {
  const chId = S.view.channelId;
  const people = voiceIn(chId);
  const inThis = V.channelId === chId;
  const tiles = $('#tiles');
  tiles.textContent = '';
  // the stage: someone's screen share you chose to watch
  const sharers = people.filter((p) => p.sharing || (p.userId === S.me.id && V.sharing));
  if (S.watching && !sharers.some((p) => p.userId === S.watching)) S.watching = null;
  const stage = $('#stage'), video = $('#stageVideo');
  let stream = null;
  if (S.watching && inThis) stream = S.watching === S.me.id ? V.screenStream : (V.peers.get(S.watching) || {}).screenStream;
  stage.hidden = !S.watching || !inThis;
  $('#viewVoice').classList.toggle('has-stage', !stage.hidden);
  if (!stage.hidden) {
    $('#stageTitle').textContent = '';
    $('#stageTitle').append(`${S.watching === S.me.id ? 'Your screen' : `${nameOf(S.watching)}'s screen`}`);
    if (video.srcObject !== stream) video.srcObject = stream || null;
    video.muted = S.watching === S.me.id || V.deafened;
    if (stream) video.play().catch(() => {});
    $('#stageWait').hidden = !!stream;
    const sw = $('#stageSwitch'); sw.textContent = '';
    for (const p of sharers) if (p.userId !== S.watching) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn small'; b.textContent = `Watch ${p.userId === S.me.id ? 'yours' : nameOf(p.userId)}`;
      b.addEventListener('click', () => { S.watching = p.userId; renderVoiceView(); });
      sw.appendChild(b);
    }
  } else if (video.srcObject) video.srcObject = null;
  for (const p of people) {
    const d = document.createElement('div');
    const isMe = p.userId === S.me.id;
    const peer = V.peers.get(p.userId);
    d.className = 'tile' + (V.speaking.has(p.userId) ? ' speaking' : '') + (inThis && !isMe && peer && peer.net !== 'ok' ? ' dim' : '');
    d.dataset.uid = p.userId;
    d.innerHTML = '<span class="lamp" aria-hidden="true"></span>';
    const av = avEl(p.userId, 'avatar'); d.appendChild(av);
    const meta = document.createElement('div'); meta.className = 'tile-meta';
    const n = document.createElement('span'); n.className = 'tile-name'; n.textContent = nameOf(p.userId) + (isMe ? ' (you)' : ''); meta.appendChild(n);
    const sub = document.createElement('span'); sub.className = 'tile-sub';
    sub.textContent = p.serverMuted ? 'Muted by admin' : p.deafened ? 'Deafened' : p.muted ? 'Muted' : !inThis || isMe ? 'In voice'
      : !peer || peer.net === 'connecting' ? 'Connecting…' : peer.net === 'failed' ? 'Can’t connect' : peer.net === 'unstable' ? 'Unstable connection' : 'Connected';
    meta.appendChild(sub);
    d.appendChild(meta);
    const badges = document.createElement('div'); badges.className = 'tile-badges';
    if (p.sharing) {
      const live2 = document.createElement('button'); live2.type = 'button'; live2.className = 'live'; live2.textContent = S.watching === p.userId ? 'WATCHING' : 'LIVE';
      live2.title = inThis ? 'Watch their screen' : 'Join voice to watch';
      live2.addEventListener('click', (e) => { e.stopPropagation(); if (!inThis) { joinVoice(chId).then(() => { S.watching = p.userId; renderVoiceView(); }); return; } S.watching = S.watching === p.userId ? null : p.userId; renderVoiceView(); });
      badges.appendChild(live2);
    }
    if (p.deafened) badges.insertAdjacentHTML('beforeend', `<span class="tb" title="Deafened">${iconSvg('headphones-off')}</span>`);
    else if (p.muted || p.serverMuted) badges.insertAdjacentHTML('beforeend', `<span class="tb" title="Muted">${iconSvg('mic-off')}</span>`);
    d.appendChild(badges);
    if (!isMe) {
      const vb = document.createElement('button'); vb.type = 'button'; vb.className = 'tile-vol'; vb.title = 'Volume and more'; vb.setAttribute('aria-label', `Volume for ${nameOf(p.userId)}`);
      vb.innerHTML = iconSvg(Voice.peerPrefs(p.userId).mute ? 'volume-x' : 'volume');
      vb.addEventListener('click', (e) => { e.stopPropagation(); openUserPop(p.userId, vb); });
      d.appendChild(vb);
      d.addEventListener('click', () => openUserPop(p.userId, d));
    }
    tiles.appendChild(d);
  }
  $('#voiceEmpty').hidden = people.length > 0;
  $('#voiceEmptyText').textContent = 'Nobody’s in this voice channel yet.';
  $('#joinVoiceBtn').hidden = inThis;
  $('#joinVoiceRow').hidden = inThis || !people.length;
  for (const b of [$('#joinVoiceBtn'), $('#joinVoiceBtn2')]) { b.disabled = V.joining; b.lastChild.textContent = V.joining ? 'Joining…' : 'Join voice'; }
  $('#alone').hidden = !(inThis && people.length === 1);
  $('#aloneText').textContent = 'You’re the only one here. Friends in this server see you in the channel list and can hop in.';
}
for (const b of [$('#joinVoiceBtn'), $('#joinVoiceBtn2')]) b.addEventListener('click', () => joinVoice(S.view.channelId));
$('#stageClose').addEventListener('click', () => { S.watching = null; renderVoiceView(); });
$('#stageFull').addEventListener('click', () => { const el = $('#stage'); if (document.fullscreenElement) document.exitFullscreen(); else el.requestFullscreen && el.requestFullscreen().catch(() => {}); });

function renderSpeaking(set) {
  document.querySelectorAll('.tile[data-uid], .member[data-uid]').forEach((el) => el.classList.toggle('speaking', set.has(Number(el.dataset.uid))));
}
/* ---------- your controls ---------- */
const MIC_ISSUES = {
  blocked: { title: 'Party Line can’t use your microphone', steps: ['Allow microphone access when your browser or computer asks (in a browser, click the icon at the left of the address bar).', 'On Windows, check Settings → Privacy → Microphone, and that desktop apps may use it.', 'Press Try again.'] },
  notfound: { title: 'No microphone found', steps: ['Plug in your headset or microphone.', 'Make sure an input device is on in your computer’s sound settings.', 'Pick it below, then press Try again.'] },
  busy: { title: 'Another app is holding your microphone', steps: ['Close apps that may be using the mic: Discord, Zoom, Teams, OBS, or a browser tab with a call.', 'Press Try again.'] },
  unsupported: { title: 'This browser can’t use a microphone here', steps: ['Use the Party Line app, or open the site in Chrome, Edge or Firefox.'] },
  disconnected: { title: 'Your microphone was disconnected', steps: ['Reconnect your headset or microphone.', 'Pick it below, then press Try again.'] },
  osmuted: { title: 'Your computer is muting the microphone', steps: ['Check for a mute switch on your headset or cable, or a mic mute key on your keyboard.', 'Check the mic isn’t muted in your sound settings.'] },
  unknown: { title: 'Your microphone didn’t start', steps: ['Pick your mic below and press Try again.', 'If that fails, restart Party Line.'] },
};
let micPanelOpen = false;
function renderMicPanel() {
  const issue = V.micIssue && MIC_ISSUES[V.micIssue];
  const panel = $('#micPanel');
  panel.hidden = !micPanelOpen;
  $('#meBtn').setAttribute('aria-expanded', String(micPanelOpen));
  if (panel.hidden) return;
  panel.classList.toggle('bad', !!issue); panel.classList.toggle('ok', !issue);
  $('#mpIconUse').setAttribute('href', issue ? '#i-mic-off' : '#i-mic');
  $('#mpTitle').textContent = issue ? issue.title : V.channelId ? 'Your mic is working' : 'Mic check';
  $('#mpText').textContent = issue ? 'Your friends can’t hear you right now. You can still listen and chat.'
    : !V.channelId ? 'Join a voice channel to start talking. Your mic turns on when you join.'
      : V.deafened ? 'You’re deafened, so your mic is off too.' : V.muted ? 'You’re muted. Press M to talk.'
        : settings.ptt ? 'Push to talk is on. Hold Space while you speak.' : 'Your friends can hear you. The bar moves when you talk.';
  const steps = $('#mpSteps'); steps.textContent = '';
  if (issue) for (const t of issue.steps) { const li = document.createElement('li'); li.textContent = t; steps.appendChild(li); }
  steps.hidden = !issue;
  $('#mpRetry').hidden = !issue;
}
$('#meBtn').addEventListener('click', () => { micPanelOpen = !micPanelOpen; if (micPanelOpen) refreshDevices(); renderMicPanel(); });
$('#mpClose').addEventListener('click', () => { micPanelOpen = false; renderMicPanel(); });
$('#mpRetry').addEventListener('click', async () => { $('#mpRetry').disabled = true; await Voice.setupMic(settings.micId); $('#mpRetry').disabled = false; renderUserArea(); });
$('#mpMic').addEventListener('change', (e) => Voice.chooseMic(e.target.value));

function micStatus() {
  if (V.micIssue && V.channelId) return { bad: true, text: 'Mic not working' };
  if (!V.channelId) return { text: S.me && user(S.me.id).online ? 'Online' : 'Online' };
  if (V.serverMuted) return { text: 'Muted by admin' };
  if (V.deafened) return { text: 'Deafened' };
  if (V.muted) return { text: 'Muted' };
  if (settings.ptt) return { text: V.pttHeld ? 'Talking' : 'Push to talk' };
  return { text: 'In voice' };
}
function renderUserArea() {
  if (!S.me) return;
  paintAv($('#meAv'), S.me.id);
  $('#meName').textContent = S.me.name;
  const st = micStatus();
  $('#meStatus').textContent = st.text; $('#meStatus').classList.toggle('bad', !!st.bad);
  const mic = $('#micBtn'), off = V.muted || V.deafened || V.serverMuted;
  mic.classList.toggle('off', off);
  mic.querySelector('use').setAttribute('href', off ? '#i-mic-off' : '#i-mic');
  mic.querySelector('.lbl').textContent = off ? 'Unmute' : 'Mute'; mic.title = `${off ? 'Unmute' : 'Mute'} (M)`;
  const deaf = $('#deafBtn');
  deaf.classList.toggle('off', V.deafened);
  deaf.querySelector('use').setAttribute('href', V.deafened ? '#i-headphones-off' : '#i-headphones');
  deaf.querySelector('.lbl').textContent = V.deafened ? 'Undeafen' : 'Deafen'; deaf.title = `${V.deafened ? 'Undeafen' : 'Deafen'} (D)`;
  const vs = $('#voiceStatus');
  vs.hidden = !V.channelId;
  if (V.channelId) {
    const f = findChannel(V.channelId);
    $('#vsChan').textContent = f ? `${f.channel.name} / ${f.server.name}` : '';
    const peers = [...V.peers.values()];
    const bad = peers.some((p) => p.net === 'failed');
    $('#vsState').lastChild.textContent = V.joining ? 'Connecting…' : bad ? 'Voice trouble' : 'Voice connected';
    $('#vsState').style.color = bad ? 'var(--danger)' : '';
    const sh = $('#shareBtn');
    sh.hidden = !Voice.canShare();
    sh.classList.toggle('on', V.sharing);
    sh.querySelector('use').setAttribute('href', V.sharing ? '#i-screen-off' : '#i-screen');
    sh.querySelector('.lbl').textContent = V.sharing ? 'Stop sharing' : 'Share screen'; sh.title = V.sharing ? 'Stop sharing' : 'Share your screen';
    const nb = $('#noiseBtn');
    nb.classList.toggle('active', settings.noiseMode === 'strong');
    nb.title = `Noise filter: ${{ strong: 'Strong', standard: 'Standard', off: 'Off' }[settings.noiseMode]} (N)`;
  }
  $('#pttBtn').hidden = !(settings.ptt && V.channelId);
  $('#pttBtn').classList.toggle('held', V.pttHeld);
  renderMicPanel();
}
$('#micBtn').addEventListener('click', toggleMute);
$('#deafBtn').addEventListener('click', toggleDeafen);
function toggleMute() {
  if (V.serverMuted) { toast('An admin muted you.', 2500); return; }
  const now = !(V.muted || V.deafened);
  if (V.deafened) Voice.setDeafened(false);
  Voice.setMuted(now);
  chime(now ? 'off' : 'on', V.deafened);
  S.mutedSince = now ? Date.now() : 0;
  renderVoiceBits();
}
function toggleDeafen() {
  Voice.setDeafened(!V.deafened);
  chime(V.deafened ? 'off' : 'on');
  S.mutedSince = V.deafened || V.muted ? (S.mutedSince || Date.now()) : 0;
  renderVoiceBits();
}
$('#shareBtn').addEventListener('click', async () => {
  if (V.sharing) Voice.stopShare(); else { await Voice.startShare(); if (V.sharing) { S.watching = S.me.id; if (S.view.kind !== 'voice') setView({ kind: 'voice', serverId: V.serverId || S.view.serverId, channelId: V.channelId }); } }
  renderVoiceBits();
});
$('#noiseBtn').addEventListener('click', cycleNoise);
function cycleNoise() { Voice.setNoiseMode(settings.noiseMode === 'strong' ? 'standard' : 'strong').then(() => { toast(`Noise filter: ${settings.noiseMode === 'strong' ? 'Strong' : 'Standard'}`, 1800); renderUserArea(); syncSettingsForm(); }); }
$('#vcLeaveBtn').addEventListener('click', () => { Voice.leaveVoice(); chime('leave'); renderVoiceBits(); });
$('#vsChan').addEventListener('click', () => { const f = findChannel(V.channelId); if (f) setView({ kind: 'voice', serverId: f.server.id, channelId: f.channel.id }); });
$('#audioUnlock').addEventListener('click', () => { Voice.unlockAudio(); $('#audioUnlockRow').hidden = true; });
const ptt = $('#pttBtn');
ptt.addEventListener('pointerdown', (e) => { e.preventDefault(); ptt.setPointerCapture(e.pointerId); Voice.setPtt(true); });
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) ptt.addEventListener(ev, () => Voice.setPtt(false));

document.addEventListener('keydown', (e) => {
  if (!S.ready || e.ctrlKey || e.metaKey || e.altKey || isTyping(document.activeElement) || document.querySelector('dialog[open]')) return;
  if (e.code === 'Space' && settings.ptt && V.channelId) { e.preventDefault(); if (!e.repeat) Voice.setPtt(true); return; }
  if (e.repeat) return;
  const k = e.key.toLowerCase();
  if (k === 'm') { e.preventDefault(); toggleMute(); }
  else if (k === 'd') { e.preventDefault(); toggleDeafen(); }
  else if (k === 'n') { e.preventDefault(); cycleNoise(); }
  else if (k === 'escape') { closeUserPop(); if (!$('#lightbox').hidden) $('#lbClose').click(); }
});
document.addEventListener('keyup', (e) => { if (e.code === 'Space' && settings.ptt) Voice.setPtt(false); });
window.addEventListener('blur', () => { if (V.pttHeld) Voice.setPtt(false); });
// Desktop app: push to talk works even when Party Line isn't the window in front.
if (desktop && desktop.onPtt) desktop.onPtt((held) => { if (settings.ptt && V.channelId) Voice.setPtt(held); });

/* Muted or deafened in voice for 30 minutes: disconnect, with a warning from 25 minutes. Sharing pauses it. */
setInterval(() => {
  const bar = $('#afkBar');
  if (!V.channelId || !(V.muted || V.deafened) || V.sharing || !S.mutedSince) { bar.hidden = true; return; }
  const left = 30 * 60_000 - (Date.now() - S.mutedSince);
  if (left <= 0) { Voice.leaveVoice(); S.mutedSince = 0; bar.hidden = true; toast('You were muted for 30 minutes, so you left voice.', 6000); renderVoiceBits(); return; }
  if (left > 5 * 60_000) { bar.hidden = true; return; }
  const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
  $('#afkText').innerHTML = `You’ve been ${V.deafened ? 'deafened' : 'muted'} a while. Leaving voice in <b>${m}:${String(s).padStart(2, '0')}</b>.`;
  bar.hidden = false;
}, 1000);
$('#afkUnmute').addEventListener('click', () => { if (V.deafened) Voice.setDeafened(false); Voice.setMuted(false); S.mutedSince = 0; renderVoiceBits(); });

/* ---------- meters ---------- */
function meterLoop() {
  const lv = Voice.localMeter.analyser ? Math.min(100, level(Voice.localMeter.analyser) * 400) : 0;
  for (const i of document.querySelectorAll('#micPanel .meter i, #settings .level .meter i')) i.style.width = `${lv}%`;
  requestAnimationFrame(meterLoop);
}
requestAnimationFrame(meterLoop);

/* ================= person pop-up ================= */
function openUserPop(id, anchor) {
  const pop = $('#userPop');
  if (!pop.hidden && S.popUser === id) { closeUserPop(); return; }
  S.popUser = id; S.popServer = S.view.serverId || null;
  const isMe = id === S.me.id;
  paintAv($('#popAv'), id);
  $('#popName').textContent = nameOf(id) + (isMe ? ' (you)' : '');
  const vst = S.voice.get(id);
  const sameVoice = !isMe && V.channelId && vst && vst.channelId === V.channelId;
  $('#popVolBox').hidden = !sameVoice;
  if (sameVoice) {
    const pref = Voice.peerPrefs(id);
    $('#volRange').value = Math.round(clampLevel(pref.vol) * 100);
    $('#volOut').textContent = `${$('#volRange').value}%`;
    $('#volMute').checked = !!pref.mute;
  }
  $('#popMsg').hidden = isMe;
  const fs = S.friends.get(id);
  const fb = $('#popFriend');
  fb.hidden = isMe || fs === 'friends';
  fb.disabled = fs === 'outgoing';
  fb.lastChild.textContent = fs === 'incoming' ? 'Accept request' : fs === 'outgoing' ? 'Request sent' : 'Add friend';
  const srv = S.popServer && S.servers.get(S.popServer);
  const srvAdmin = !isMe && srv && canManage(srv);
  const admin = srvAdmin || (!isMe && S.me.admin);
  $('#popAdmin').hidden = !admin;
  if (admin) {
    const inSrvVoice = srvAdmin && vst && srv.channels.some((c) => c.id === vst.channelId);
    $('#admVoiceKick').hidden = !inSrvVoice; $('#admMute').hidden = !inSrvVoice;
    $('#admMute').textContent = vst && vst.serverMuted ? 'Unmute for everyone' : 'Mute for everyone';
    $('#admKick').hidden = !srvAdmin || (srv.isDefault && !S.me.admin);
    $('#admReset').hidden = !S.me.admin;
  }
  pop.hidden = false;
  const r = anchor.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
  let x = r.right + 8, y = r.top;
  if (x + w > innerWidth - 8) x = Math.max(8, r.left - w - 8);
  if (x < 8) x = 8;
  if (y + h > innerHeight - 8) y = Math.max(8, innerHeight - h - 8);
  pop.style.left = `${x}px`; pop.style.top = `${y}px`;
}
function closeUserPop() { $('#userPop').hidden = true; S.popUser = null; }
document.addEventListener('pointerdown', (e) => { const pop = $('#userPop'); if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('.member, .tile, .mini-av, .tile-vol')) closeUserPop(); });
function setPref(id, patch) { friendVols[id] = Object.assign(Voice.peerPrefs(id), patch); saveVols(); Voice.applyAllVolumes(); }
$('#volRange').addEventListener('input', (e) => { $('#volOut').textContent = `${e.target.value}%`; $('#volOut').classList.toggle('boost', e.target.value > 100); setPref(S.popUser, { vol: e.target.value / 100 }); });
$('#volMute').addEventListener('change', (e) => { setPref(S.popUser, { mute: e.target.checked }); renderVoiceBits(); });
$('#volReset').addEventListener('click', () => { $('#volRange').value = 100; $('#volOut').textContent = '100%'; setPref(S.popUser, { vol: 1, mute: false }); $('#volMute').checked = false; });
$('#popMsg').addEventListener('click', () => { const id = S.popUser; closeUserPop(); setView({ kind: 'dm', userId: id }); });
$('#popFriend').addEventListener('click', async () => {
  const id = S.popUser;
  if (S.friends.get(id) === 'incoming') await act(() => live.req('friend.accept', { id }), 'Friend added.');
  else await act(() => live.req('friend.request', { name: nameOf(id) }), 'Friend request sent.');
  closeUserPop();
});
$('#admVoiceKick').addEventListener('click', () => { act(() => live.req('admin.voiceKick', { userId: S.popUser })); closeUserPop(); });
$('#admMute').addEventListener('click', () => { const v = S.voice.get(S.popUser); act(() => live.req('admin.mute', { userId: S.popUser, on: !(v && v.serverMuted) })); closeUserPop(); });
$('#admKick').addEventListener('click', async () => {
  const id = S.popUser, srv = S.servers.get(S.popServer);
  closeUserPop();
  if (srv && await confirmBox(`Remove ${nameOf(id)} from ${srv.name}?`, 'They can come back with an invite link.', 'Remove')) act(() => live.req('admin.kick', { serverId: srv.id, userId: id }));
});

$('#admReset').addEventListener('click', async () => {
  const id = S.popUser;
  closeUserPop();
  if (!await confirmBox(`Reset ${nameOf(id)}'s password?`, 'They’re signed out everywhere and get a temporary password from you. They can change it in Settings.', 'Reset')) return;
  const r = await act(() => live.req('admin.resetPassword', { userId: id }));
  if (r) await confirmBox(`New password for ${r.name}`, 'Send this to them privately. They sign in with it, then change it in Settings → Change password.', 'Done', r.password);
});

/* ================= search ================= */
const searchScope = () => (S.view.serverId ? S.view.serverId : -1);
function openSearch() {
  const s = curServer();
  $('#searchNote').textContent = s ? `Searching messages in ${s.name}.` : 'Searching your private chats.';
  $('#searchResults').textContent = '';
  $('#searchPanel').hidden = false;
  $('#searchInput').focus(); $('#searchInput').select();
}
function closeSearch() { $('#searchPanel').hidden = true; }
$('#searchBtn').addEventListener('click', () => ($('#searchPanel').hidden ? openSearch() : closeSearch()));
$('#searchClose').addEventListener('click', closeSearch);
$('#searchInput').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeSearch(); } });
document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && S.ready) { e.preventDefault(); openSearch(); } });
$('#searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#searchInput').value.trim();
  const ol = $('#searchResults');
  if (q.length < 2) { $('#searchNote').textContent = 'Type at least 2 letters.'; return; }
  $('#searchNote').textContent = 'Searching…';
  let res;
  try { res = (await api(`/api/search?q=${encodeURIComponent(q)}&serverId=${searchScope()}`)).messages; }
  catch (ex) { $('#searchNote').textContent = ex.message; return; }
  $('#searchNote').textContent = res.length ? `${res.length === 50 ? '50+' : res.length} result${res.length === 1 ? '' : 's'}. Click one to jump to it.` : `Nothing found for “${q}”.`;
  ol.textContent = '';
  for (const msg of res) {
    const key = msg.channelId ? `c:${msg.channelId}` : dmKeyById(msg.dmId);
    if (!key) continue;
    const li = document.createElement('li');
    const b = document.createElement('button'); b.type = 'button'; b.className = 'search-hit';
    const where = msg.channelId ? `#${(findChannel(msg.channelId) || { channel: { name: '?' } }).channel.name}` : `@${nameOf(Number(key.slice(2)))}`;
    const head = document.createElement('div'); head.className = 'search-head';
    head.appendChild(avEl(msg.userId));
    const n = document.createElement('b'); n.textContent = nameOf(msg.userId); head.appendChild(n);
    const w = document.createElement('span'); w.textContent = `${where} · ${fmtDay(msg.at)} ${fmtTime(msg.at)}`; head.appendChild(w);
    b.appendChild(head);
    const body = document.createElement('div'); body.className = 'search-body'; body.textContent = decodeMentions(msg.body);
    b.appendChild(body);
    b.addEventListener('click', () => { closeSearch(); jumpTo(key, msg.id); });
    li.appendChild(b); ol.appendChild(li);
  }
});

/* ================= servers ================= */
const inviteLink = (s) => `${location.origin.startsWith('http') ? location.origin : ''}/invite/${s.invite}`;
async function copyInvite() {
  const s = curServer();
  if (!s) return;
  try { await navigator.clipboard.writeText(inviteLink(s)); toast('Invite link copied. Send it to a friend.', 2600); }
  catch { await confirmBox('Invite link', 'Copy this and send it to a friend:', 'Done', inviteLink(s)); }
}
$('#copyInvite').addEventListener('click', copyInvite);
$('#mInvite').addEventListener('click', () => { closeMenu(); copyInvite(); });
$('#serverBtn').addEventListener('click', () => { const m = $('#serverMenu'); m.hidden = !m.hidden; $('#serverBtn').setAttribute('aria-expanded', String(!m.hidden)); });
function closeMenu() { $('#serverMenu').hidden = true; $('#serverBtn').setAttribute('aria-expanded', 'false'); }
document.addEventListener('click', (e) => { if (!e.target.closest('.server-head')) closeMenu(); });
$('#mRename').addEventListener('click', async () => {
  closeMenu();
  const s = curServer();
  const name = await confirmBox('Rename server', 'Everyone in the server sees the new name.', 'Rename', s.name);
  if (name && name.trim() && name.trim() !== s.name) act(() => live.req('server.rename', { id: s.id, name: name.trim() }));
});
$('#mLeave').addEventListener('click', async () => {
  closeMenu();
  const s = curServer();
  if (await confirmBox(`Leave ${s.name}?`, 'You can come back with an invite link.', 'Leave')) act(() => live.req('server.leave', { id: s.id }));
});
$('#mDelete').addEventListener('click', async () => {
  closeMenu();
  const s = curServer();
  if (await confirmBox(`Delete ${s.name}?`, 'Every channel and message in it is deleted for everyone. This can’t be undone.')) act(() => live.req('server.delete', { id: s.id }));
});
$('#mSettings').addEventListener('click', () => { closeMenu(); openSettings(); });
$('#mFeedback').addEventListener('click', () => { closeMenu(); openFeedback(); });
$('#railHome').addEventListener('click', () => setView({ kind: 'friends' }));
$('#navFriends').addEventListener('click', () => setView({ kind: 'friends' }));
for (const b of [$('#railAdd'), $('#homeAdd')]) b.addEventListener('click', () => { $('#asError').hidden = true; $('#asInvite').value = ''; $('#asName').value = ''; $('#addServer').showModal(); });
$('#asClose').addEventListener('click', () => $('#addServer').close());
$('#asJoinForm').addEventListener('submit', async (e) => { e.preventDefault(); const v = $('#asInvite').value.trim(); if (v) joinInvite(v, true); });
$('#asCreateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#asName').value.trim();
  if (!name) return;
  try { const r = await live.req('server.create', { name }); $('#addServer').close(); setTimeout(() => openServer(r.id), 50); }
  catch (ex) { $('#asError').textContent = ex.message; $('#asError').hidden = false; }
});
async function joinInvite(code, fromDialog) {
  try {
    const r = await live.req('server.join', { invite: code });
    if (fromDialog) $('#addServer').close();
    setTimeout(() => { openServer(r.id); const s = S.servers.get(r.id); if (s) toast(`Welcome to ${s.name}!`, 3000); }, 50);
  } catch (ex) {
    if (fromDialog) { $('#asError').textContent = ex.message; $('#asError').hidden = false; } else toast(ex.message, 5000);
  }
}
function newChannelForm(btn, form, input, kind) {
  btn.addEventListener('click', () => { form.hidden = !form.hidden; if (!form.hidden) input.focus(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { form.hidden = true; input.value = ''; } });
  input.addEventListener('blur', () => setTimeout(() => { if (!input.value) form.hidden = true; }, 150));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    const s = curServer();
    const r = await act(() => live.req('chan.create', { serverId: s.id, kind, name }));
    if (r) { input.value = ''; form.hidden = true; if (kind === 'text') setTimeout(() => setView({ kind: 'text', serverId: s.id, channelId: r.id }), 50); }
  });
}
newChannelForm($('#addText'), $('#newTextForm'), $('#newText'), 'text');
newChannelForm($('#addVoice'), $('#newVoiceForm'), $('#newVoice'), 'voice');
document.querySelectorAll('.cat-toggle').forEach((t) => t.addEventListener('click', () => {
  const open = t.getAttribute('aria-expanded') !== 'true';
  t.setAttribute('aria-expanded', String(open));
  document.getElementById(t.getAttribute('aria-controls')).hidden = !open;
}));
$('#drawerBtn').addEventListener('click', () => { $('#room').classList.add('drawer-open'); $('#drawerScrim').hidden = false; });
$('#drawerScrim').addEventListener('click', () => { $('#room').classList.remove('drawer-open'); $('#drawerScrim').hidden = true; });

/* ================= settings ================= */
const canPickSpeaker = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
async function refreshDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  let list = [];
  try { list = await navigator.mediaDevices.enumerateDevices(); } catch {}
  const ok = (d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications';
  const ins = list.filter((d) => d.kind === 'audioinput' && ok(d)), outs = list.filter((d) => d.kind === 'audiooutput' && ok(d));
  for (const sel of [$('#setMic'), $('#mpMic')]) fill(sel, ins, 'Microphone', settings.micId);
  fill($('#setSpeaker'), outs, 'Speaker', settings.speakerId);
  $('#speakerField').hidden = !canPickSpeaker || !outs.length;
}
function fill(sel, devices, noun, value) {
  sel.textContent = '';
  const def = document.createElement('option'); def.value = ''; def.textContent = 'System default'; sel.appendChild(def);
  devices.forEach((d, i) => { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || `${noun} ${i + 1}`; sel.appendChild(o); });
  sel.value = devices.some((d) => d.deviceId === value) ? value : '';
}
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
function syncSettingsForm() {
  if (!S.me) return;
  paintAv($('#setAv'), S.me.id);
  $('#setAvRemove').hidden = !S.me.avatar;
  for (const r of document.querySelectorAll('input[name="noise"]')) r.checked = r.value === settings.noiseMode;
  for (const r of document.querySelectorAll('input[name="quality"]')) r.checked = r.value === settings.quality;
  for (const r of document.querySelectorAll('input[name="theme"]')) r.checked = r.value === settings.theme;
  $('#setPtt').checked = settings.ptt;
  $('#setNotify').checked = settings.notify && typeof Notification !== 'undefined' && Notification.permission === 'granted';
  $('#notifyField').hidden = typeof Notification === 'undefined';
  $('#inVol').value = Math.round(settings.inputVol * 100); $('#inVolOut').textContent = `${$('#inVol').value}%`;
  $('#outVol').value = Math.round(settings.outputVol * 100); $('#outVolOut').textContent = `${$('#outVol').value}%`;
  $('#pttHint').textContent = desktop ? 'Hold the push-to-talk key to talk, even while you’re in a game (set it in the tray menu).' : 'Hold Space (or the Hold to talk button) to talk. Space only works while Party Line is in front.';
}
function openSettings() {
  syncSettingsForm();
  $('#setName').value = S.me.name; $('#setNameNote').textContent = 'Friends sign in and find you by this name.';
  $('#pwNote').hidden = true; $('#pwOld').value = ''; $('#pwNew').value = '';
  $('#appInfo').textContent = desktop ? `Party Line desktop app ${desktop.version || ''} · Server: ${location.host}` : `Server: ${location.host}`;
  refreshDevices();
  $('#settings').showModal();
}
$('#setBtn').addEventListener('click', openSettings);
$('#setMic').addEventListener('change', (e) => Voice.chooseMic(e.target.value));
$('#setSpeaker').addEventListener('change', (e) => { settings.speakerId = e.target.value; saveSettings(); Voice.applySpeaker(); });
$('#inVol').addEventListener('input', (e) => { $('#inVolOut').textContent = `${e.target.value}%`; Voice.setInputVol(e.target.value / 100); });
$('#outVol').addEventListener('input', (e) => { $('#outVolOut').textContent = `${e.target.value}%`; settings.outputVol = clampLevel(e.target.value / 100); saveSettings(); Voice.applyAllVolumes(); });
document.querySelectorAll('input[name="noise"]').forEach((r) => r.addEventListener('change', () => Voice.setNoiseMode(r.value).then(renderUserArea)));
document.querySelectorAll('input[name="theme"]').forEach((r) => r.addEventListener('change', () => setTheme(r.value)));
document.querySelectorAll('input[name="quality"]').forEach((r) => r.addEventListener('change', () => { settings.quality = r.value; saveSettings(); }));
$('#setPtt').addEventListener('change', (e) => { settings.ptt = e.target.checked; saveSettings(); Voice.setPtt(false); Voice.applyMic(); renderUserArea(); });
$('#setNotify').addEventListener('change', async (e) => {
  if (e.target.checked && Notification.permission !== 'granted') {
    const p = await Notification.requestPermission().catch(() => 'denied');
    if (p !== 'granted') { e.target.checked = false; toast('Notifications are blocked. Allow them in your browser or system settings.', 5000); return; }
  }
  settings.notify = e.target.checked; saveSettings();
});
$('#setNameSave').addEventListener('click', async () => {
  const name = $('#setName').value.trim();
  if (!name || name === S.me.name) return;
  try { await live.req('profile.rename', { name }); $('#setNameNote').textContent = 'Saved. Use this name to sign in from now on.'; }
  catch (ex) { $('#setNameNote').textContent = ex.message; }
});
$('#pwSave').addEventListener('click', async () => {
  const note = $('#pwNote');
  try { await api('/api/password', { body: { oldPassword: $('#pwOld').value, newPassword: $('#pwNew').value } }); note.textContent = 'Password changed.'; $('#pwOld').value = ''; $('#pwNew').value = ''; }
  catch (ex) { note.textContent = ex.message; }
  note.hidden = false;
});
$('#signOut').addEventListener('click', signOut);
for (const b of [$('#setAvBtn'), $('#setAvChange')]) b.addEventListener('click', () => $('#setAvFile').click());
$('#setAvFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const blob = await squareImage(f, 256);
    const r = await upload('/api/avatar', new File([blob], 'avatar.jpg', { type: 'image/jpeg' }));
    S.me = Object.assign(S.me, r.user); syncSettingsForm(); renderUserArea();
  } catch (ex) { toast(ex.message || 'Couldn’t use that picture.', 4000); }
});
$('#setAvRemove').addEventListener('click', async () => { const r = await act(() => api('/api/avatar', { method: 'DELETE' })); if (r) { S.me = Object.assign(S.me, r.user); syncSettingsForm(); renderUserArea(); } });
async function squareImage(file, size) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(bmp.width, bmp.height);
  const c = document.createElement('canvas'); c.width = c.height = size;
  c.getContext('2d').drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, size, size);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Couldn’t read that picture.'))), 'image/jpeg', 0.86));
}

/* ================= feedback ================= */
function renderFbCount() { const el = $('#fbCount'); el.hidden = !S.fbCount; el.textContent = S.fbCount; }
async function openFeedback() {
  $('#fbDone').hidden = true; $('#fbError').hidden = true;
  $('#feedback').showModal();
  $('#fbInboxSec').hidden = !S.me.admin;
  if (S.me.admin) loadInbox();
}
async function loadInbox() {
  const ol = $('#fbInbox');
  let items = [];
  try { items = (await live.req('feedback.list', {})).items; } catch (e) { toast(e.message, 4000); }
  S.fbCount = items.filter((x) => !x.done).length; renderFbCount();
  ol.textContent = '';
  $('#fbInboxEmpty').hidden = items.length > 0;
  for (const f of items) {
    const li = document.createElement('li'); li.className = 'fb-item' + (f.done ? '' : ' new');
    const meta = document.createElement('div'); meta.className = 'fb-meta';
    const pill = document.createElement('span'); pill.className = `fb-pill ${f.kind}`; pill.textContent = f.kind; meta.appendChild(pill);
    const who = document.createElement('b'); who.textContent = f.userId ? nameOf(f.userId) : 'Anonymous'; meta.appendChild(who);
    const when = document.createElement('span'); when.textContent = `${fmtDay(f.at)} ${fmtTime(f.at)}`; meta.appendChild(when);
    li.appendChild(meta);
    const body = document.createElement('div'); body.className = 'fb-body'; body.textContent = f.body; li.appendChild(body);
    const row = document.createElement('div'); row.className = 'pop-btns';
    const done = document.createElement('button'); done.type = 'button'; done.className = 'btn small'; done.textContent = f.done ? 'Mark as new' : 'Mark as done';
    done.addEventListener('click', async () => { await act(() => live.req('feedback.done', { id: f.id, done: !f.done })); loadInbox(); });
    const del = document.createElement('button'); del.type = 'button'; del.className = 'btn small adm-danger'; del.textContent = 'Delete';
    del.addEventListener('click', async () => { await act(() => live.req('feedback.delete', { id: f.id })); loadInbox(); });
    row.append(done, del); li.appendChild(row);
    ol.appendChild(li);
  }
  $('#fbCopyAll').onclick = () => navigator.clipboard.writeText(items.map((f) => `[${f.kind}] ${f.userId ? nameOf(f.userId) : 'Anonymous'} (${new Date(f.at).toLocaleString()}):\n${f.body}`).join('\n\n')).then(() => toast('Copied.', 1500));
}
$('#feedbackBtn').addEventListener('click', openFeedback);
$('#fbClose').addEventListener('click', () => $('#feedback').close());
$('#fbForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = $('#fbText').value.trim();
  if (!body) return;
  $('#fbSend').disabled = true; $('#fbError').hidden = true;
  try {
    await live.req('feedback.send', { kind: document.querySelector('input[name="fbKind"]:checked').value, body, anonymous: $('#fbAnon').checked });
    $('#fbText').value = ''; $('#fbDone').textContent = 'Thanks! The owner will see it.'; $('#fbDone').hidden = false;
    if (S.me.admin) loadInbox();
  } catch (ex) { $('#fbError').textContent = ex.message; $('#fbError').hidden = false; }
  $('#fbSend').disabled = false;
});

/* ================= start ================= */
Voice.initVoice({
  myId: () => (S.me ? S.me.id : 0),
  change: () => { if (S.ready) renderVoiceBits(); },
  speaking: renderSpeaking,
  micIssue: (kind) => { if (kind && V.channelId) { micPanelOpen = true; renderMicPanel(); } },
  system: (what, id) => {
    if (what === 'audio-blocked') $('#audioUnlockRow').hidden = false;
    else if (what === 'voice-failed') toast(`Couldn’t connect voice with ${nameOf(id)}. A strict network may be blocking it.`, 6000);
    else toast(what, 4000);
  },
});
const m = location.pathname.match(/^\/invite\/([\w-]+)/);
if (m) { S.pendingInvite = m[1]; history.replaceState(null, '', '/'); }
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
if (hasToken()) start(); else showJoinScreen();
