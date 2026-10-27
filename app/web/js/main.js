/* Party Line app: sign in, servers and channels, chat, friends and private chats, voice and screen sharing. */
import { api, upload, live, store, setToken, hasToken, absUrl } from './net.js';
import { latestNews, unseenNews } from './news.js';
import { $, iconSvg, settings, saveSettings, friendVols, saveVols, clampLevel, hue, initials, toast, chime, level, fmtTime, fmtDay, fmtSize } from './util.js';
import * as Voice from './voice.js';
import { initDev, openDev, log } from './dev.js';
import { initMusic, updateMusic, listening, musicPlaying, listenAgain } from './music.js';
import { builtinSounds, playSound, soundLength } from './sounds.js';
import { createDrawLayer, createClipBuffer, clipsSupported } from './stagefx.js';
import { withDuration } from './webm.js';
const { V } = Voice;

const desktop = window.partyLineDesktop || null;   // set by the desktop app's preload script
const S = {
  me: null, ready: false,
  perks: { achievements: [], unlocks: { flair: {}, bannerFx: {}, nameColor: 5, legend: 20 }, nameColors: [] },
  users: new Map(), servers: new Map(), friends: new Map(), dms: new Map(), voice: new Map(), music: new Map(), commands: [], events: new Map(), resets: [], notif: {}, sounds: new Map(), soundFlash: new Map(), emoji: new Map(), gifs: [], previews: new Map(), games: new Map(), voiceStatus: new Map(), bookmarks: new Set(), later: new Map(),
  view: { kind: 'friends' }, friendTab: 'online',
  msgs: new Map(),          // 'c:<channelId>' or 'd:<userId>' -> { list, loaded, hasMore, loading }
  lastChan: store.get('lastChan', {}) || {},
  attach: [], sending: false, watching: null, pendingInvite: null,
  mutedSince: 0, fbCount: 0, popUser: null, popServer: null,
};
const MAX_IMAGE = 15 * 1048576, MAX_VIDEO = 50 * 1048576, MAX_FILE = 25 * 1048576;
/* What the chat shows inline; anything else becomes a download card. */
const IMG_RE = /^image\/(png|jpeg|gif|webp|avif|bmp)$/, VID_RE = /^video\/(mp4|webm|quicktime)$/, AUD_RE = /^audio\/(mpeg|ogg|wav|x-wav|webm|mp4|x-m4a|aac|flac)$/;

/* ================= dark and light mode ================= */
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const isDark = () => settings.theme === 'dark' || (settings.theme === 'system' && darkQuery.matches);
function applyTheme() {
  const root = document.documentElement;
  if (settings.theme === 'system') delete root.dataset.theme; else root.dataset.theme = settings.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = isDark() ? '#000000' : '#e8ebf0';
  $('#themeToggle').querySelector('use').setAttribute('href', isDark() ? '#i-sun' : '#i-moon');
  for (const r of document.querySelectorAll('input[name="theme"]')) r.checked = r.value === settings.theme;
  if (settings.accent && settings.accent !== 'amber') root.dataset.accent = settings.accent; else delete root.dataset.accent;
  for (const r of document.querySelectorAll('input[name="accent"]')) r.checked = r.value === (settings.accent || 'amber');
  if (desktop && desktop.setTheme) desktop.setTheme(settings.theme);
}
function setTheme(t) { settings.theme = t; saveSettings(); applyTheme(); }
darkQuery.addEventListener('change', applyTheme);
applyTheme();
$('#themeToggle').addEventListener('click', () => setTheme(isDark() ? 'light' : 'dark'));

/* ================= small view helpers ================= */
const user = (id) => S.users.get(id) || { id, name: 'Someone', avatar: null, online: false };
const nameOf = (id) => user(id).name;
/* Admins (developers) get a crown after their name wherever it shows. */
/* A name: the person's own color (a level reward) or their role's, shimmering from level 20 (also a reward). */
function nameInto(el, id, srv, text = nameOf(id)) {
  const u = user(id), color = u.nameColor || (srv && roleColor(srv, id)) || '';
  el.textContent = '';
  const t = document.createElement('span'); t.className = 'nm'; t.textContent = text;
  if (!u.bot && xpLevel(u.xp) >= S.perks.unlocks.legend) { t.classList.add('name-legend'); t.title = 'Legend: level 20 or higher'; }
  el.style.color = color;
  if (color) t.style.setProperty('--nc', color);
  el.appendChild(t);
}
const addCrown = (el, id) => {
  if (user(id).admin || (S.me && id === S.me.id && S.me.admin)) el.insertAdjacentHTML('beforeend', `<span class="crown" title="Developer">${iconSvg('crown')}</span>`);
  if (user(id).bot) el.insertAdjacentHTML('beforeend', '<span class="bot-tag">BOT</span>');
  if (isBirthday(id)) el.insertAdjacentHTML('beforeend', '<span class="bday" title="It’s their birthday today!">🎂</span>');
};
const todayMD = () => { const d = new Date(); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function isBirthday(id) {
  const b = id === (S.me && S.me.id) ? S.me.birthday : user(id).birthday;
  if (!b) return false;
  const t = todayMD();
  return b === t || (b === '02-29' && t === '02-28' && new Date(new Date().getFullYear(), 1, 29).getMonth() !== 1);
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const fmtBirthday = (b) => { const [m, d] = b.split('-').map(Number); return `${MONTHS[m - 1]} ${d}`; };
const curServer = () => (S.view.serverId ? S.servers.get(S.view.serverId) : null);
const canManage = (srv) => !!S.me && (S.me.admin || (srv && srv.ownerId === S.me.id));
/* What my roles let me do in a server: channels, messages, voice, kick, server. */
const can = (srv, perm) => canManage(srv) || !!(srv && S.me && (srv.memberRoles && srv.memberRoles[S.me.id] || []).some((rid) => (srv.roles || []).some((r) => r.id === rid && r.perms.includes(perm))));
/* Group chats and 1-on-1 call rooms are hidden servers: not in the server bar, shown under Private chats. */
const isPrivate = (srv) => !!(srv && srv.kind && srv.kind !== 'server');
function groupName(srv) {
  if (!srv) return '';
  if (srv.kind === 'pair') { const other = srv.members.find((id) => id !== S.me.id); return `Call with ${nameOf(other)}`; }
  if (srv.name) return srv.name;
  const others = srv.members.filter((id) => id !== S.me.id).map(nameOf);
  return others.slice(0, 3).join(', ') + (others.length > 3 ? ` +${others.length - 3}` : '');
}
const groupText = (srv) => srv.channels.find((c) => c.kind === 'text');
const groupVoice = (srv) => srv.channels.find((c) => c.kind === 'voice');
/* Notification level for a chat ('c:<channel>' or 'd:<person>'): all, mentions or mute. A channel follows
   its server's setting unless it has its own; servers default to mentions, group and private chats to all. */
function serverLevel(srv) { return S.notif[`s:${srv.id}`] || (srv.kind === 'group' || srv.kind === 'pair' ? 'all' : 'mentions'); }
function levelFor(key) {
  if (key.startsWith('d:')) return S.notif[key] || 'all';
  const f = findChannel(Number(key.slice(2)));
  return S.notif[key] || (f ? serverLevel(f.server) : 'mentions');
}
const rolesOf = (srv, userId) => (srv && srv.roles ? srv.roles.filter((r) => (srv.memberRoles[userId] || []).includes(r.id)).sort((a, b) => b.position - a.position) : []);
/* A name's color: the highest role that has one. */
const roleColor = (srv, userId) => { const r = rolesOf(srv, userId).find((x) => x.color); return r ? r.color : null; };
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
  el.textContent = u.bot ? '🤖' : initials(u.name);
  el.classList.toggle('bot', !!u.bot);
  for (const c of [...el.classList]) if (c.startsWith('flair-')) el.classList.remove(c);
  if (u.flair) el.classList.add(`flair-${u.flair}`);
  if (u.avatar) { el.classList.add('has-img'); el.style.backgroundImage = `url("${absUrl(u.avatar)}")`; }
  else { el.classList.remove('has-img'); el.style.backgroundImage = ''; }
}
function avEl(id, cls = 'mini-av') { const s = document.createElement('span'); s.className = cls; s.setAttribute('aria-hidden', 'true'); paintAv(s, id); return s; }
function serverInitials(name) { return initials(name).slice(0, 2) || '#'; }
function confirmBox(title, text, okLabel = 'Delete', input, maxLength = 40) {
  return new Promise((resolve) => {
    const d = $('#confirmDlg');
    $('#cfTitle').textContent = title; $('#cfText').textContent = text; $('#cfOk').textContent = okLabel;
    const inp = $('#cfInput');
    inp.hidden = input === undefined; inp.maxLength = maxLength; inp.value = input || '';
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
  $('#authPassHint').hidden = mode === 'login';
  $('#authPass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#authPassLabel').textContent = mode === 'reset' ? 'New password' : 'Password';
  $('#resetNoteField').hidden = mode !== 'reset';
  $('#authForgot').hidden = mode !== 'login';
  $('#authBackToLogin').hidden = mode !== 'reset';
  $('#authBtn').textContent = { register: 'Create account', login: 'Sign in', reset: 'Ask an admin to reset it' }[mode];
  $('#codeField').hidden = true; $('#authCode').value = '';
  $('#authError').hidden = true;
}
function showJoinScreen() {
  $('#booting').hidden = true; $('#room').hidden = true; $('#join').hidden = false; $('#themeToggle').hidden = false;
  if (S.pendingInvite) { $('#joinInvite').hidden = false; $('#joinInvite').textContent = 'You were invited to a server. Sign in or create an account to join.'; }
  api('/api/info').then((i) => { info = i; showAuth(authMode); }).catch(() => {});
  showAuth(store.get('hadAccount', false) ? 'login' : 'register');
  if (store.get('resetReq', null)) showResetWait(); else setTimeout(() => $('#authName').focus(), 50);
}
$('#tabLogin').addEventListener('click', () => showAuth('login'));
$('#authForgot').addEventListener('click', () => { showAuth('reset'); $('#authPass').value = ''; $('#authPass').focus(); });
$('#authBackToLogin').addEventListener('click', () => showAuth('login'));
/* Forgot password: wait for an admin to approve, checking every 3 s. */
let resetPoll = null;
function showResetWait(text) {
  $('#authForm').hidden = true; $('#resetWait').hidden = false;
  $('#resetWaitTitle').textContent = 'Waiting for an admin';
  if (text) $('#resetWaitText').textContent = text;
  clearInterval(resetPoll);
  const check = async () => {
    const req = store.get('resetReq', null);
    if (!req) return;
    let r;
    try { r = await api(`/api/reset-request/${req.id}`, { body: { secret: req.secret } }); } catch (ex) { if (/doesn’t exist/.test(ex.message)) endResetWait(); return; }
    if (r.state === 'approved') {
      endResetWait();
      setToken(r.token); store.set('hadAccount', true);
      toast('An admin approved it. You’re signed in with your new password.', 5000);
      start();
    } else if (r.state !== 'pending') {
      endResetWait();
      showAuth('login');
      const err = $('#authError');
      err.textContent = r.state === 'denied' ? 'The admin turned the request down. Talk to them directly.' : 'That request expired or was replaced. Ask again if you still need it.';
      err.hidden = false;
    }
  };
  check(); resetPoll = setInterval(check, 3000);
}
function endResetWait() { clearInterval(resetPoll); store.del('resetReq'); $('#resetWait').hidden = true; $('#authForm').hidden = false; }
$('#resetCancel').addEventListener('click', () => { endResetWait(); showAuth('login'); });
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
    if (authMode === 'reset') {
      const r = await api('/api/reset-request', { body: { name: $('#authName').value, newPassword: $('#authPass').value, note: $('#resetNote').value, device: await appLabel() } });
      store.set('resetReq', { id: r.id, secret: r.secret });
      $('#authPass').value = ''; $('#resetNote').value = '';
      showResetWait('Your request was sent. An admin gets a notification and confirms it’s really you. You can keep this open, or close it and come back later.');
      return;
    }
    const body = { name: $('#authName').value, password: $('#authPass').value, groupPassword: $('#authGroup').value, code: $('#authCode').value, device: await appLabel() };
    const r = await api(authMode === 'register' ? '/api/register' : '/api/login', { body });
    if (r.needCode) { $('#codeField').hidden = false; $('#authCode').focus(); return; }   // 2-step sign-in is on
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
  if (pushSupported() && settings.push) await Promise.race([setPush(false).catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);   // the next person on this device shouldn't get your messages
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
  S.perks = d.perks || S.perks;
  S.users = new Map(d.users.map((u) => [u.id, u]));
  S.servers = new Map(d.servers.map((s) => [s.id, s]));
  S.friends = new Map(d.friends.map((f) => [f.id, f.state]));
  S.dms = new Map(d.dms.map((x) => [x.userId, x]));
  S.voice = new Map(d.voice.map((v) => [v.userId, v]));
  S.music = new Map((d.music || []).map((x) => [x.channelId, x.state]));
  S.sounds = new Map();
  for (const x of d.sounds || []) { if (!S.sounds.has(x.serverId)) S.sounds.set(x.serverId, []); S.sounds.get(x.serverId).push(x); }
  S.events = new Map();
  for (const e of d.events || []) { if (!S.events.has(e.serverId)) S.events.set(e.serverId, []); S.events.get(e.serverId).push(e); }
  S.commands = d.commands || [];
  S.serverNow = d.serverNow;
  S.resets = d.resets || [];
  S.notif = d.notify || {};
  S.previews = new Map((d.previews || []).map((p) => [p.userId, p.img]));
  S.voiceStatus = new Map((d.voiceStatus || []).map((x) => [x.channelId, x.status]));
  S.emoji = new Map((d.emoji || []).map((e) => [e.id, e]));
  S.gifs = d.gifs || [];
  S.bookmarks = new Set(d.bookmarks || []);
  renderResetBar();
  for (const [k, m] of S.msgs) if (m.loaded) S.msgs.delete(k);   // reload what we show, in case we missed messages
  const first = !S.ready;
  S.ready = true;
  $('#booting').hidden = true; $('#join').hidden = true; $('#room').hidden = false; $('#themeToggle').hidden = true;
  if (first) {
    const last = store.get('lastView', null);
    if (last && ((last.kind === 'dm' && S.users.has(last.userId)) || last.kind === 'home')) S.view = last;
    else if (last && last.serverId && S.servers.has(last.serverId)) openServer(last.serverId, true);
    else if (S.servers.size) openServer(([...S.servers.values()].find((x) => !isPrivate(x)) || [...S.servers.values()][0]).id, true);
    else S.view = { kind: 'friends' };   // in no servers yet: Add friend is the useful start
  } else if (S.view.serverId && !S.servers.has(S.view.serverId)) S.view = { kind: 'friends' };
  if (S.view.kind === 'voice' && !findChannel(S.view.channelId)) S.view = { kind: 'friends' };
  renderAll();
  openCurrent();
  if (V.channelId) Voice.rejoinVoice();
  appLabel().then((l) => { S.appLabel = l; live.req('client.info', { label: l }).catch(() => {}); });
  if (sentIdle) live.req('presence.idle', { idle: true }).catch(() => {});
  if (myActivity) live.req('presence.activity', { name: myActivity }).catch(() => {});
  if (S.pendingInvite) { const code = S.pendingInvite; S.pendingInvite = null; joinInvite(code); }
  if (S.pendingOpen) { const q = S.pendingOpen; S.pendingOpen = null; openFromPush(q); }
  if (first) showNews();
  if (first) syncPush();
  if (S.me.admin) live.req('feedback.list', {}).then((r) => { S.fbCount = r.items.filter((x) => !x.done).length; renderFbCount(); }).catch(() => {});
});
/* What a person's messages show of them: only a change here redraws the chat (not their XP or streak). */
const looks = (u) => u ? [u.name, u.avatar, u.flair, u.nameColor, u.admin, u.bot, u.birthday, xpLevel(u.xp) >= S.perks.unlocks.legend].join('|') : '';
live.on('user', (d) => {
  const before = looks(S.users.get(d.user.id));
  S.users.set(d.user.id, d.user);
  if (S.me && d.user.id === S.me.id) S.me = Object.assign(S.me, d.user);
  renderAll();
  if (looks(d.user) !== before) rerenderMessagesSoft();
  if (S.popUser === d.user.id && !$('#userPop').hidden) fillUserPop(d.user.id);
});
live.on('presence', (d) => {
  const u = S.users.get(d.userId);
  if (!u) return;
  Object.assign(u, { online: d.online, status: d.status, activity: d.activity });
  renderSide(); renderConn(); renderUserArea();
  if (S.view.kind === 'friends') renderFriends();
  if (S.view.kind === 'home') renderDash();
  if (S.view.kind === 'dm') renderHeader();
  if (S.popUser === d.userId && !$('#userPop').hidden) fillUserPop(d.userId);
});
live.on('me', (d) => { Object.assign(S.me, d.me); renderUserArea(); });
/* Status: what others see (online, idle, dnd, offline) and a one-line description for lists. */
const statusOf = (id) => { const u = user(id); return u.bot ? 'online' : u.online ? (u.status || 'online') : 'offline'; };
const STATUS_TEXT = { online: 'Online', idle: 'Idle', dnd: 'Do not disturb', offline: 'Offline' };
function presenceLine(id) {
  const u = user(id);
  if (u.online && u.activity) return `🎮 Playing ${u.activity}`;
  if (u.custom && (u.online || id === S.me.id)) return u.custom;
  return STATUS_TEXT[statusOf(id)];
}
const quiet = () => !!(S.me && S.me.status === 'dnd');   // Do not disturb: no message sounds or popups
const learnUsers = (list) => { for (const u of list || []) if (u) S.users.set(u.id, u); };
live.on('server', (d) => {
  if (d.emoji) setServerEmoji(d.server.id, d.emoji);
  learnUsers(d.users);
  S.servers.set(d.server.id, d.server);
  for (const v of d.voice || []) S.voice.set(v.userId, v);
  renderAll();
  if (S.view.serverId === d.server.id) rerenderMessagesSoft();   // role colors and delete buttons may have changed
  if ($('#rolesDlg').open) renderRoles();
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
live.on('member', (d) => { learnUsers([d.user]); const s = S.servers.get(d.serverId); if (s && !s.members.includes(d.userId)) { s.members.push(d.userId); renderConn(); } });
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
  S.voice.delete(d.userId); S.previews.delete(d.userId);
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
live.on('music', (d) => {
  if (d.state) S.music.set(d.channelId, d.state); else S.music.delete(d.channelId);
  S.serverNow = d.serverNow;
  renderSide(); syncMusic();
});
live.on('sounds', (d) => { S.sounds.set(d.serverId, d.sounds); if (!$('#soundPop').hidden) renderSoundboard(); });
live.on('sound', (d) => {
  if (V.deafened || (d.userId !== S.me.id && Voice.peerPrefs(d.userId).mute)) return;
  playSound(d.builtin ? { builtin: d.builtin } : { url: absUrl(d.url) }, (settings.soundVolume ?? 60) / 100);
  const b = d.builtin && builtinSounds().find((x) => x.id === d.builtin);
  S.soundFlash.set(d.userId, (b && b.emoji) || d.emoji || '🔊');
  if (S.view.kind === 'voice') renderVoiceView();
  setTimeout(() => { S.soundFlash.delete(d.userId); if (S.view.kind === 'voice') renderVoiceView(); }, 2500);
});
live.on('events', (d) => { S.events.set(d.serverId, d.events); renderHeader(); if ($('#eventsDlg').open) renderEvents(); if (S.view.kind === 'home') renderDash(); });
live.on('reset.request', (d) => {
  S.resets = S.resets.filter((x) => x.userId !== d.request.userId).concat(d.request);
  renderResetBar();
  if ($('#resetDlg').open) renderResets();
  if (!quiet()) chime('msg', V.deafened);
  toast(`🔑 ${d.request.name} wants to reset their password.`, 6000, { label: 'Review', fn: openResets });
  notify('🔑 Password reset request', `${d.request.name} wants to reset their password.`, openResets);
});
live.on('seen', (d) => {
  const m = S.msgs.get(`d:${d.userId}`);
  if (m) { m.seenId = Math.max(m.seenId || 0, d.id); if (msgKey() === `d:${d.userId}`) renderSeen(); }
});
live.on('notify', (d) => { S.notif = d.prefs; renderAll(); });
live.on('reset.done', (d) => { S.resets = S.resets.filter((x) => x.id !== d.id); renderResetBar(); if ($('#resetDlg').open) renderResets(); });
live.on('rtc', (d) => Voice.onRtc(d.from, d.data));
live.on('msg', (d) => { onMessage(`c:${d.msg.channelId}`, d.msg); if (d.msg.lfg && S.view.kind === 'home') loadDashLfg(); });
live.on('dm', (d) => {
  learnUsers([d.user]);
  if (closedDms.delete(d.withUserId)) saveDmList();
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
  if (i >= 0) { m.list[i] = d.msg; rerenderOne(key, d.msg.id); }
});
live.on('msg.del', (d) => {
  const key = d.channelId ? `c:${d.channelId}` : dmKeyById(d.dmId);
  const m = key && S.msgs.get(key);
  if (!m) return;
  const i = m.list.findIndex((x) => x.id === d.id);
  if (i < 0) return;
  m.list.splice(i, 1);
  if (msgKey() !== key) return;
  const li = $(`#messages .msg[data-id="${d.id}"]`);
  if (!li) { renderMessages(true); return; }
  li.remove();
  if (m.list[i]) rerenderOne(key, m.list[i].id);   // the next one may now need its name shown
  renderSeen();
});
live.on('read', (d) => {
  if (d.target.startsWith('c:')) { const f = findChannel(Number(d.target.slice(2))); if (f && f.channel.lastId <= d.id) { f.channel.unread = 0; f.channel.mentions = 0; } }
  else for (const x of S.dms.values()) if (`d:${x.id}` === d.target && x.lastId <= d.id) x.unread = 0;
  renderRail(); renderSide();
});
live.on('friend', (d) => {
  learnUsers([d.user]);
  const prev = S.friends.get(d.id);
  if (d.state) S.friends.set(d.id, d.state); else S.friends.delete(d.id);
  if (d.state === 'incoming' && prev !== 'incoming') { if (!quiet()) chime('msg', V.deafened); toast(`${nameOf(d.id)} sent you a friend request.`, 5000, { label: 'View', fn: () => { S.friendTab = 'pending'; setView({ kind: 'friends' }); } }); }
  if (d.state === 'friends' && prev === 'outgoing') toast(`${nameOf(d.id)} accepted your friend request.`, 4000);
  renderRail(); renderSide();
  if (S.view.kind === 'friends') renderFriends();
});
live.on('feedback.new', () => { S.fbCount++; renderFbCount(); });
const dmKeyById = (dmId) => { for (const x of S.dms.values()) if (x.id === dmId) return `d:${x.userId}`; return null; };

/* ================= navigation ================= */
/* Private chats you opened stay in the list until you close them with ✕ (a new message brings one back). */
const openDms = new Set(store.get('openDms', []) || []), closedDms = new Set(store.get('closedDms', []) || []);
const saveDmList = () => { store.set('openDms', [...openDms]); store.set('closedDms', [...closedDms]); };
function setView(v) {
  noteUnread(v);
  const leaving = msgKey();
  S.view = v;
  if (leaving && leaving !== msgKey()) trimHistory(leaving);
  if (v.kind === 'dm' && (!openDms.has(v.userId) || closedDms.has(v.userId))) { openDms.add(v.userId); closedDms.delete(v.userId); saveDmList(); }
  cancelReply(); closeMentionPop(); closeSearch(); $('#gamesPanel').hidden = true;
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
  let got = [];
  try {
    const path = key.startsWith('c:') ? `/api/channels/${key.slice(2)}/messages` : `/api/dms/${key.slice(2)}/messages`;
    const r = await api(`${path}${before ? `?before=${before}` : ''}`);
    const ids = new Set(m.list.map((x) => x.id));
    got = r.messages.filter((x) => !ids.has(x.id));
    m.list = older ? got.concat(m.list) : got.concat(m.list.filter((x) => x.id > (got.length ? got[got.length - 1].id : 0)));
    if (m.early) { const have = new Set(m.list.map((x) => x.id)); m.list.push(...m.early.filter((x) => !have.has(x.id))); m.list.sort((x, y) => x.id - y.id); m.early = null; }
    m.hasMore = r.messages.length >= 50;
    m.loaded = true;
    if (!older && r.seenId !== undefined) m.seenId = r.seenId;
  } catch (e) { toast(e.message, 4000); }
  m.loading = false;
  if (msgKey() === key) {
    const box = $('#messages'), fromBottom = box.scrollHeight - box.scrollTop;
    const shown = older && box.querySelector('.msg') && m.list[got.length] && $(`#messages .msg[data-id="${m.list[got.length].id}"]`);
    if (shown) {
      // Older messages: add just them at the top (redrawing a long chat each time would stall).
      const frag = document.createDocumentFragment();
      frag.appendChild(chatTop(m, key));
      got.forEach((msg, i) => frag.appendChild(messageEl(msg, got[i - 1] || null)));
      box.firstElementChild.replaceWith(frag);
      shown.replaceWith(messageEl(m.list[got.length], got[got.length - 1] || null));   // it may now continue the one above
    } else renderMessages();
    if (older) box.scrollTop = box.scrollHeight - fromBottom;
    markViewedRead();
  }
}
/* A chat you scrolled far back in keeps only its newest 100 messages when you leave it (older ones load again when you
   scroll up), so opening it again is quick. */
function trimHistory(key) {
  const m = key && S.msgs.get(key);
  if (m && m.loaded && !m.loading && m.list.length > 150) { m.list = m.list.slice(-100); m.hasMore = true; }
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
  else if (m && !m.loaded) (m.early ||= []).push(msg);   // history is still loading: add it when that arrives
  if (typing.has(key)) { typing.get(key).delete(msg.userId); renderTyping(); }
  const mine = msg.userId === S.me.id;
  const viewing = msgKey() === key && !document.hidden;
  if (key.startsWith('c:')) {
    const f = findChannel(msg.channelId);
    if (f) {
      f.channel.lastId = msg.id;
      if (!mine && !viewing) f.channel.unread = (f.channel.unread || 0) + 1;
      const level = levelFor(key), where = isPrivate(f.server) ? groupName(f.server) : `${f.channel.kind === 'voice' ? '🔊 ' : '#'}${f.channel.name}`;
      if (!mine && !viewing && mentionsMe(msg)) f.channel.mentions = (f.channel.mentions || 0) + 1;
      if (!mine && !viewing && level !== 'mute' && (level === 'all' || mentionsMe(msg))) {
        if (!quiet()) chime('msg', V.deafened);
        notify(`${nameOf(msg.userId)} in ${where}`, decodeMentions(msg.body) || 'Sent a file', () => setView({ kind: 'text', serverId: f.server.id, channelId: f.channel.id }));
      }
    }
  } else {
    const x = S.dms.get(Number(key.slice(2)));
    if (x && !mine && !viewing) x.unread = (x.unread || 0) + 1;
    if (!mine && !viewing && levelFor(key) !== 'mute') {
      if (!quiet()) chime('msg', V.deafened);
      notify(nameOf(msg.userId), decodeMentions(msg.body) || 'Sent a photo or video', () => setView({ kind: 'dm', userId: msg.userId }));
    }
  }
  if (msgKey() === key) { appendMessage(msg); if (viewing) markViewedRead(); }
  renderRail(); renderSide(); updateBadge();
  if (S.view.kind === 'voice') renderHeader();   // the Chat button's count
}
function notify(title, body, onClick) {
  if (!document.hidden || quiet() || !settings.notify || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body: String(body).slice(0, 140), silent: true, tag: 'pl-' + title });
    n.onclick = () => { window.focus(); if (desktop && desktop.focus) desktop.focus(); onClick(); n.close(); };
  } catch {}
}
function updateBadge() {
  let n = 0;
  for (const x of S.dms.values()) n += x.unread || 0;
  for (const st of S.friends.values()) if (st === 'incoming') n++;
  for (const s of S.servers.values()) for (const c of s.channels) n += s.kind === 'group' ? c.unread || 0 : c.mentions || 0;
  document.title = n ? `(${n}) Party Line` : 'Party Line';
  if (desktop && desktop.setBadge) desktop.setBadge(n);
}

/* ================= rendering ================= */
function renderAll() {
  if (!S.ready) return;
  renderRail(); renderSide(); renderHeader(); renderMainView(); renderUserArea(); renderConn(); updateBadge();
}
function renderRail() {
  const homeUnread = [...S.dms.values()].reduce((a, x) => a + (x.unread || 0), 0) + [...S.friends.values()].filter((s) => s === 'incoming').length
    + [...S.servers.values()].filter((s) => s.kind === 'group').reduce((a, s) => a + s.channels.reduce((b, c) => b + (c.unread || 0), 0), 0);
  const homeOn = !S.view.serverId || isPrivate(S.servers.get(S.view.serverId));
  $('#railHome').setAttribute('aria-current', String(homeOn));
  $('#railHomeItem').classList.toggle('current', homeOn);
  $('#railHomeBadge').hidden = !homeUnread; $('#railHomeBadge').textContent = homeUnread > 99 ? '99+' : homeUnread;
  const list = $('#railList');
  list.textContent = '';
  for (const s of S.servers.values()) {
    if (isPrivate(s)) continue;
    const li = document.createElement('li');
    const on = S.view.serverId === s.id;
    const unread = serverLevel(s) !== 'mute' && s.channels.some((c) => c.unread && levelFor(`c:${c.id}`) !== 'mute');
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
  const home = !S.view.serverId || isPrivate(curServer());
  $('#room').classList.toggle('home', home);
  if (home) { renderHomeSide(); return; }
  const s = curServer();
  if (!s) return;
  $('#serverName').textContent = s.name;
  const tl = $('#textList'), vl = $('#voiceList'), cl = $('#catList');
  tl.textContent = ''; vl.textContent = ''; cl.textContent = '';
  const manage = can(s, 'channels');
  // Custom categories, each holding text and voice channels.
  const catLists = new Map();
  for (const cat of s.categories || []) {
    const sec = document.createElement('section'); sec.className = 'cat custom-cat'; sec.dataset.cat = cat.id;
    const head = document.createElement('div'); head.className = 'cat-head';
    const tg = document.createElement('button'); tg.type = 'button'; tg.className = 'cat-toggle'; tg.setAttribute('aria-expanded', String(!S.collapsed?.has(cat.id)));
    tg.innerHTML = iconSvg('chevron'); tg.appendChild(document.createTextNode(cat.name));
    tg.addEventListener('click', () => { S.collapsed ||= new Set(); S.collapsed.has(cat.id) ? S.collapsed.delete(cat.id) : S.collapsed.add(cat.id); renderSide(); });
    head.appendChild(tg);
    if (manage) {
      const ed = document.createElement('button'); ed.type = 'button'; ed.className = 'cat-add'; ed.title = `Edit ${cat.name}`; ed.setAttribute('aria-label', ed.title); ed.innerHTML = iconSvg('gear');
      ed.addEventListener('click', () => editCategory(cat));
      head.appendChild(ed);
    }
    sec.appendChild(head);
    const ul = document.createElement('ul'); ul.className = 'chan-list'; ul.hidden = !!S.collapsed?.has(cat.id);
    sec.appendChild(ul); cl.appendChild(sec);
    catLists.set(cat.id, ul);
    if (manage) dropTarget(head, () => ({ categoryId: cat.id, beforeId: null }));
  }
  if (manage) { dropTarget(tl.parentElement.querySelector('.cat-head'), () => ({ categoryId: null, beforeId: null })); dropTarget(vl.parentElement.querySelector('.cat-head'), () => ({ categoryId: null, beforeId: null })); }
  const listFor = (c) => (c.categoryId && catLists.get(c.categoryId)) || (c.kind === 'text' ? tl : vl);
  for (const c of [...s.channels].sort((a, b) => a.position - b.position || a.id - b.id)) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chan';
    const current = S.view.channelId === c.id;
    b.setAttribute('aria-current', String(current));
    if (c.kind === 'text') {
      const muted = levelFor(`c:${c.id}`) === 'mute';
      if (c.unread && !current && !muted) b.classList.add('unread');
      if (muted) b.classList.add('muted');
      b.innerHTML = '<span class="glyph" aria-hidden="true">#</span>';
      const n = document.createElement('span'); n.className = 'chan-name'; n.textContent = c.name; b.appendChild(n);
      if (c.mentions && !current) { const bd = document.createElement('span'); bd.className = 'chan-badge'; bd.title = 'Mentions of you'; bd.textContent = c.mentions > 99 ? '99+' : c.mentions; b.appendChild(bd); }
      b.addEventListener('click', () => setView({ kind: 'text', serverId: s.id, channelId: c.id }));
      li.appendChild(b);
      listFor(c).appendChild(li);
    } else {
      const people = voiceIn(c.id);
      if (V.channelId === c.id) b.classList.add('in-voice');
      b.innerHTML = iconSvg('volume');
      const n = document.createElement('span'); n.className = 'chan-name'; n.textContent = c.name; b.appendChild(n);
      if (c.id === s.afkChannelId) { const z = document.createElement('span'); z.className = 'chan-afk'; z.textContent = '💤'; z.title = 'AFK channel: quiet people are moved here'; b.appendChild(z); }
      if (people.some((p) => p.sharing)) { const l = document.createElement('span'); l.className = 'chan-live'; l.textContent = 'LIVE'; b.appendChild(l); }
      const tune = S.music && S.music.get(c.id);
      if (tune) { const l = document.createElement('span'); l.className = 'chan-music'; l.title = `Playing: ${tune.now.title}`; l.innerHTML = iconSvg('music'); b.appendChild(l); }
      // The voice channel's own chat: a 💬 count when there's something new (clicking it opens the chat without joining)
      const chatMuted = levelFor(`c:${c.id}`) === 'mute';
      if (c.unread && !(current && S.view.kind === 'text') && !chatMuted) { const cb = document.createElement('span'); cb.className = 'chan-chat'; cb.title = 'New messages in this voice channel’s chat'; cb.textContent = `💬 ${c.unread > 99 ? '99+' : c.unread}`; b.appendChild(cb); }
      b.addEventListener('click', (e) => {
        if (e.target.closest('.chan-chat')) { setView({ kind: 'text', serverId: s.id, channelId: c.id }); return; }
        setView({ kind: 'voice', serverId: s.id, channelId: c.id }); if (V.channelId !== c.id) joinVoice(c.id);
      });
      li.appendChild(b);
      const vst = S.voiceStatus.get(c.id);
      if (vst) { const st = document.createElement('div'); st.className = 'chan-status'; st.textContent = vst.text; st.title = `Status set by ${nameOf(vst.by)}`; li.appendChild(st); }
      if (people.length) {
        const ul = document.createElement('ul'); ul.className = 'members';
        for (const p of people) {
          const mi = document.createElement('li');
          const mb = document.createElement('button');
          mb.type = 'button'; mb.className = 'member' + (p.userId === S.me.id ? ' is-me' : '') + (V.speaking.has(p.userId) ? ' speaking' : '');
          mb.dataset.uid = p.userId;
          mb.appendChild(avEl(p.userId));
          const nm = document.createElement('span'); nm.className = 'member-name'; nameInto(nm, p.userId, s); addCrown(nm, p.userId); mb.appendChild(nm);
          if (p.sharing) { const l = document.createElement('span'); l.className = 'chan-live'; l.textContent = 'LIVE'; mb.appendChild(l); peekOn(mb, p.userId); }
          if (p.deafened) mb.insertAdjacentHTML('beforeend', iconSvg('headphones-off'));
          else if (p.muted || p.serverMuted) mb.insertAdjacentHTML('beforeend', iconSvg('mic-off'));
          mb.addEventListener('click', (e) => openUserPop(p.userId, e.currentTarget));
          mi.appendChild(mb); ul.appendChild(mi);
        }
        li.appendChild(ul);
      }
      listFor(c).appendChild(li);
    }
    if (manage) {
      li.draggable = true; li.dataset.cid = c.id;
      li.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-chan', String(c.id)); e.dataTransfer.effectAllowed = 'move'; li.classList.add('dragging'); });
      li.addEventListener('dragend', () => li.classList.remove('dragging'));
      dropTarget(li, () => ({ categoryId: c.categoryId || null, beforeId: c.id }));
      const gear = document.createElement('button');
      gear.type = 'button'; gear.className = 'chan-del chan-gear'; gear.title = `Edit ${c.name}`; gear.setAttribute('aria-label', gear.title);
      gear.innerHTML = iconSvg('gear');
      gear.addEventListener('click', (e) => { e.stopPropagation(); editChannel(c); });
      li.appendChild(gear);
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
  $('#mRename').hidden = !can(s, 'server');
  $('#mAfk').hidden = !can(s, 'server') || s.kind !== 'server' || !s.channels.some((c) => c.kind === 'voice');
  $('#mRoles').hidden = !can(s, 'server') && !(s.roles || []).length;
  $('#mCategory').hidden = !manage;
  $('#mDev').hidden = !S.me.admin;
  $('#mDelete').hidden = !canManage(s) || s.isDefault;
}
function renderHomeSide() {
  $('#navFriends').setAttribute('aria-current', String(S.view.kind === 'friends'));
  $('#navHome').setAttribute('aria-current', String(S.view.kind === 'home'));
  $('#navDev').hidden = $('#frDev').hidden = !S.me.admin;
  const pend = [...S.friends.values()].filter((s) => s === 'incoming').length;
  for (const el of [$('#pendingCount'), $('#pendingCount2')]) { el.hidden = !pend; el.textContent = pend; }
  const list = $('#dmList');
  list.textContent = '';
  const ids = new Set([...S.dms.keys()].filter((id) => !closedDms.has(id)));
  for (const id of openDms) if (S.users.has(id) && !closedDms.has(id)) ids.add(id);
  if (S.view.kind === 'dm') ids.add(S.view.userId);
  const groups = [...S.servers.values()].filter((g) => g.kind === 'group');
  const items = [...[...ids].map((id) => ({ id, at: (S.dms.get(id) || {}).lastAt || Infinity })),
    ...groups.map((g) => ({ g, at: Math.max((groupText(g) || {}).lastAt || 0, g.id) }))].sort((a, b) => b.at - a.at);
  const sorted = items;
  for (const it of items) {
    if (it.g) { list.appendChild(groupItem(it.g)); continue; }
    const id = it.id;
    const x = S.dms.get(id) || {};
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'dm-item' + (x.unread ? ' unread' : '');
    b.setAttribute('aria-current', String(S.view.kind === 'dm' && S.view.userId === id));
    const w = document.createElement('span'); w.className = 'av-wrap'; w.appendChild(avEl(id));
    const dot = document.createElement('span'); dot.className = 'status-dot ' + statusOf(id); w.appendChild(dot);
    b.appendChild(w);
    const n = document.createElement('span'); n.className = 'dm-name'; n.textContent = nameOf(id); addCrown(n, id); b.appendChild(n);
    if (x.unread) { const c = document.createElement('span'); c.className = 'count-pill'; c.textContent = x.unread; b.appendChild(c); }
    b.addEventListener('click', () => setView({ kind: 'dm', userId: id }));
    li.appendChild(b);
    const close = document.createElement('button'); close.type = 'button'; close.className = 'dm-close'; close.title = `Close chat with ${nameOf(id)}`; close.setAttribute('aria-label', close.title);
    close.innerHTML = iconSvg('x');
    close.addEventListener('click', () => {
      openDms.delete(id); closedDms.add(id); saveDmList();
      if (S.view.kind === 'dm' && S.view.userId === id) setView({ kind: 'friends' }); else renderHomeSide();
    });
    li.appendChild(close); list.appendChild(li);
  }
  $('#dmEmpty').hidden = sorted.length > 0;
}
function groupItem(g) {
  const li = document.createElement('li');
  const t = groupText(g), unread = (t && t.unread) || 0;
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'dm-item' + (unread ? ' unread' : '');
  b.setAttribute('aria-current', String(S.view.serverId === g.id));
  const av = document.createElement('span'); av.className = 'group-av'; av.setAttribute('aria-hidden', 'true');
  for (const id of g.members.filter((x) => x !== S.me.id).slice(0, 2)) av.appendChild(avEl(id));
  b.appendChild(av);
  const n = document.createElement('span'); n.className = 'dm-name'; n.textContent = groupName(g);
  const sub = document.createElement('small'); sub.className = 'dm-sub'; sub.textContent = `${g.members.length} members`; n.appendChild(sub);
  b.appendChild(n);
  if (voiceIn((groupVoice(g) || {}).id).length) b.insertAdjacentHTML('beforeend', `<span class="chan-music" title="Call in progress">${iconSvg('phone')}</span>`);
  if (unread) { const c = document.createElement('span'); c.className = 'count-pill'; c.textContent = unread; b.appendChild(c); }
  b.addEventListener('click', () => setView({ kind: 'text', serverId: g.id, channelId: t.id }));
  li.appendChild(b);
  return li;
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
  $('#pinsBtn').hidden = v.kind !== 'text' && v.kind !== 'dm';
  $('#gamesBtn').hidden = $('#pinsBtn').hidden;
  $('#galleryBtn').hidden = $('#pinsBtn').hidden;
  const dsrv = v.kind === 'text' && S.servers.get(v.serverId);
  const disSecs = v.kind === 'dm' && !user(v.userId).bot ? (S.dms.get(v.userId) || {}).disappear || 0 : dsrv && dsrv.kind === 'group' ? dsrv.disappear || 0 : null;
  $('#disappearBtn').hidden = disSecs === null;
  $('#disappearBtn').classList.toggle('on', !!disSecs);
  $('#disappearBtn').title = disSecs ? `Disappearing messages: on (${disSecs >= 604800 ? '7 days' : disSecs >= 86400 ? '24 hours' : `${disSecs} s`})` : 'Disappearing messages: off';
  if (!$('#pinsBtn').hidden) loadLater(); else renderLater();
  if (!$('#gamesBtn').hidden) loadGames();
  else $('#gamesPanel').hidden = true;
  $('#notifBtn').hidden = v.kind !== 'text' && v.kind !== 'dm';
  if (!$('#notifBtn').hidden) {
    const lv = levelFor(v.kind === 'dm' ? `d:${v.userId}` : `c:${v.channelId}`);
    $('#notifBtn').querySelector('use').setAttribute('href', lv === 'mute' ? '#i-bell-off' : '#i-bell');
    $('#notifBtn').classList.toggle('on', lv === 'mute');
  }
  const priv = isPrivate(S.servers.get(v.serverId)), grp = priv && S.servers.get(v.serverId).kind === 'group';
  // Voice channels: Chat opens their text chat; from the chat, back to the voice view.
  const vf = (v.kind === 'voice' || v.kind === 'text') && !priv && findChannel(v.channelId);
  const isVoiceCh = !!(vf && vf.channel.kind === 'voice');
  $('#vcChatBtn').hidden = !isVoiceCh;
  if (isVoiceCh) {
    const inChat = v.kind === 'text';
    $('#vcChatLabel').textContent = inChat ? (V.channelId === v.channelId ? 'Back to voice' : 'Join voice') : 'Chat';
    $('#vcChatBtn').querySelector('use').setAttribute('href', inChat ? '#i-volume' : '#i-chat');
    const n = inChat ? 0 : vf.channel.unread || 0;
    $('#vcChatCount').hidden = !n; $('#vcChatCount').textContent = n > 99 ? '99+' : n;
  }
  $('#eventsBtn').hidden = !v.serverId || priv;
  if (priv) $('#copyInvite').hidden = true;
  $('#callBtn').hidden = !((v.kind === 'dm' && !user(v.userId).bot) || (grp && v.kind === 'text'));
  $('#groupAddBtn').hidden = $('#groupLeaveBtn').hidden = !grp;
  const soon = v.serverId ? upcoming(v.serverId).filter((e) => e.startsAt < Date.now() + 7 * 86_400_000).length : 0;
  $('#eventsCount').hidden = !soon; $('#eventsCount').textContent = soon;
  if (v.kind === 'friends') { icon.innerHTML = iconSvg('users'); $('#viewTitle').textContent = 'Friends'; $('#viewSub').textContent = ''; }
  else if (v.kind === 'home') { icon.innerHTML = iconSvg('home'); $('#viewTitle').textContent = 'Home'; $('#viewSub').textContent = 'What’s happening'; }
  else if (v.kind === 'dm') {
    icon.textContent = '@'; $('#viewTitle').textContent = nameOf(v.userId);
    $('#viewSub').textContent = presenceLine(v.userId);
  } else {
    const f = findChannel(v.channelId);
    if (!f) return;
    const vchat = v.kind === 'text' && f.channel.kind === 'voice';   // a voice channel's own chat
    if (v.kind === 'text' && !vchat) icon.textContent = '#'; else icon.innerHTML = iconSvg('volume');
    $('#viewTitle').textContent = f.channel.name;
    $('#viewSub').textContent = vchat ? `Chat · ${f.server.name}` : f.channel.topic || f.server.name;
    $('#viewSub').title = f.channel.topic || '';
    if (isPrivate(f.server)) {
      icon.innerHTML = iconSvg(v.kind === 'voice' ? 'phone' : 'users');
      $('#viewTitle').textContent = groupName(f.server);
      $('#viewSub').textContent = v.kind === 'voice' ? 'Call' : `${f.server.members.length} members: ${f.server.members.map(nameOf).join(', ')}`;
    }
  }
}
$('#vcChatBtn').addEventListener('click', () => {
  const v = S.view;
  if (v.kind === 'voice') setView({ kind: 'text', serverId: v.serverId, channelId: v.channelId });
  else { setView({ kind: 'voice', serverId: v.serverId, channelId: v.channelId }); if (V.channelId !== v.channelId) joinVoice(v.channelId); }
});
function renderMainView() {
  const k = S.view.kind;
  $('#viewText').hidden = k !== 'text' && k !== 'dm';
  $('#viewHome').hidden = k !== 'friends';
  $('#viewDash').hidden = k !== 'home';
  if (k === 'home') { renderDash(); loadDashLfg(); }
  $('#viewVoice').hidden = k !== 'voice';
  if (k === 'friends') renderFriends();
  if (k === 'voice') renderVoiceView();
  if (k === 'text' || k === 'dm') {
    const f = k === 'text' && findChannel(S.view.channelId);
    $('#chatInput').placeholder = (k === 'dm' ? `Message @${nameOf(S.view.userId)}` : f && isPrivate(f.server) ? `Message ${groupName(f.server)}` : f ? `Message ${f.channel.kind === 'voice' ? '🔊 ' : '#'}${f.channel.name}` : 'Message') + (isPhone() ? '' : ' · type / for commands');
  }
}
function renderVoiceBits() { renderSide(); renderRail(); renderUserArea(); if (S.view.kind === 'voice') renderVoiceView(); if (S.view.kind === 'home') renderDash(); syncStageExtras(); syncPhoneCall(); syncMusic(); sendOverlay(); syncPreview(); }
/* Listen together (music.js): play what's on in my voice channel. */
function syncMusic() {
  const ch = V.channelId || null, st = ch ? S.music.get(ch) : null;
  updateMusic(ch, st || null, S.serverNow);
  S.serverNow = null;
  $('#musicBack').hidden = !st || listening();
}
/* Android app: while you're in voice, a notification keeps it running when the phone locks or you switch apps. */
const phoneApp = window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform() ? window.Capacitor.registerPlugin('PartyLine') : null;
/* Android app: new features arrive from the server by themselves, but when the app itself has a newer build
   (on the GitHub releases page), offer it. Tapping Update downloads it; Android then asks to install. */
const UPDATE_REPO = 'PoseidonDream/party-line';
/* Which app this is, for the developer panel: "Windows app 1.1.0", "Android app build 12", "Chrome on Windows". */
async function appLabel() {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  if (desktop) return `${os || 'Desktop'} app ${desktop.version || ''}`.trim();
  if (phoneApp && window.Capacitor.getPlatform() === 'android') {
    try { return `Android app build ${(await phoneApp.getVersion()).code}`; } catch { return 'Android app (old build)'; }
  }
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${b}${os ? ` on ${os}` : ''}`;
}
async function checkAppUpdate() {
  if (!phoneApp || window.Capacitor.getPlatform() !== 'android') return;
  let mine = 0;
  try { mine = Number((await phoneApp.getVersion()).code) || 0; } catch {}   // builds before the update check report 0
  try {
    const rel = await (await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`)).json();
    const apk = (rel.assets || []).find((x) => x.name === 'Party-Line-android.apk');
    const build = apk && Number((/build (\d+)/.exec(apk.label || '') || [])[1]);
    if (!build || build <= mine || store.get('skipBuild', 0) === build) return;
    showUpdateCard('A new version of Party Line is ready', 'Tap Update, then open the download to install it over this one.', 'Update', apk.browser_download_url, null, () => store.set('skipBuild', build));
  } catch {}
}
/* The "new version" card, for the Android app (a download) and the desktop app (already downloaded: restart). */
function showUpdateCard(title, note, goLabel, href, onGo, onLater) {
  $('#updateTitle').textContent = title; $('#updateNote').textContent = note;
  const go = $('#updateGo');
  go.setAttribute('role', href ? 'link' : 'button');
  go.textContent = goLabel;
  if (href) go.href = href; else go.removeAttribute('href');
  go.onclick = onGo ? (e) => { e.preventDefault(); onGo(); } : null;
  $('#updateLater').onclick = () => { if (onLater) onLater(); $('#updateBar').hidden = true; };
  $('#updateBar').hidden = false;
}
if (desktop && desktop.onUpdate) desktop.onUpdate((version) => {
  showUpdateCard(`Party Line ${version} is ready`, V.channelId ? 'Restart to update. You’ll be back in voice in a few seconds.' : 'Restart to update. It only takes a few seconds, or it updates next time you open Party Line.',
    'Restart now', null, () => desktop.installUpdate());
});
setTimeout(checkAppUpdate, 5000);
setInterval(checkAppUpdate, 6 * 3600_000);
let phoneInCall = null;
function syncPhoneCall() {
  if (!phoneApp) return;
  const f = V.channelId && findChannel(V.channelId);
  const key = f ? `${f.channel.id}` : '';
  if (key === phoneInCall) return;
  phoneInCall = key;
  phoneApp.setInCall({ inCall: !!f, title: f ? `In voice: ${f.channel.name}` : '' }).catch(() => {});
}

/* ================= messages ================= */
const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;
/* Inline styles. When two could start at the same place, the earlier one in this list wins. */
const INLINE_RE = new RegExp([
  '`([^`\\n]{1,500})`',                                        // 1 `code`
  URL_RE.source,                                                 //   a link
  '<@(\\d+)>',                                                 // 2 @mention
  '<t:(\\d{9,11})(?::(R))?>',                                  // 3, 4 a time in your own time zone
  '\\|\\|([^|\\n](?:[^\\n]*?[^|\\n])?)\\|\\|',     // 5 ||spoiler||
  '\\*\\*([^*\\n](?:[^\\n]*?[^*\\n])?)\\*\\*',     // 6 **bold**
  '__([^_\\n](?:[^\\n]*?[^_\\n])?)__',                    // 7 __underline__
  '~~([^~\\n](?:[^\\n]*?[^~\\n])?)~~',                    // 8 ~~strike~~
  '(?<![\\w*])\\*([^*\\s](?:[^*\\n]*?[^*\\s])?)\\*(?![\\w*])', // 9 *italic*
  '(?<![\\w_])_([^_\\s](?:[^_\\n]*?[^_\\s])?)_(?![\\w_])',         // 10 _italic_
  '<:(\\w{2,32}):(\\d+)>',                                  // 11, 12 custom emoji
  '<m:([cd]):(\\d+):(\\d+)>',                               // 13, 14, 15 a link to a message (Party Bot's reminders)
].join('|'), 'g');
/* <t:unix> shows a moment in each person's own time zone; <t:unix:R> as "in 15 minutes". */
const fmtWhen = (ms) => new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
function fmtRelative(ms) {
  const d = ms - Date.now(), a = Math.abs(d), rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const [n, u] = a < 3600_000 ? [Math.round(d / 60_000), 'minute'] : a < 86_400_000 ? [Math.round(d / 3600_000), 'hour'] : [Math.round(d / 86_400_000), 'day'];
  return rtf.format(n, u);
}
/* Message text: ```code blocks```, > quotes, then inline styles (see INLINE_RE), links and @mentions.
   Mentions are stored as <@userId>. */
function richText(el, text) {
  String(text).split(/```(?:[\w+-]*\n)?([\s\S]*?)```/).forEach((part, i) => {
    if (i % 2) {
      const pre = document.createElement('pre'); pre.className = 'code-block';
      const code = document.createElement('code'); code.textContent = part.replace(/\n$/, ''); pre.appendChild(code);
      el.appendChild(pre);
      return;
    }
    // Runs of lines starting with "> " become a quote.
    const lines = part.split('\n'), segs = [];
    for (const line of lines) {
      const q = /^>\s?/.test(line) && line.trim() !== '>' ? true : /^>$/.test(line.trim());
      const last = segs[segs.length - 1];
      if (last && last.q === q) last.lines.push(q ? line.replace(/^>\s?/, '') : line);
      else segs.push({ q, lines: [q ? line.replace(/^>\s?/, '') : line] });
    }
    segs.forEach((g) => {
      if (g.q) { const bq = document.createElement('blockquote'); inlineText(bq, g.lines.join('\n')); el.appendChild(bq); return; }
      const t = g.lines.join('\n');
      if (t) inlineText(el, t);
    });
  });
}
function inlineText(el, text) {
  let last = 0;
  const add = (tag, cls, inner) => { const x = document.createElement(tag); if (cls) x.className = cls; inlineText(x, inner); el.appendChild(x); return x; };
  for (const m of text.matchAll(INLINE_RE)) {
    if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
    if (m[1] !== undefined) { const c = document.createElement('code'); c.className = 'inline-code'; c.textContent = m[1]; el.appendChild(c); }
    else if (m[2]) {
      const id = Number(m[2]);
      const b = document.createElement('button'); b.type = 'button'; b.className = 'mention' + (id === S.me.id ? ' me' : '');
      b.textContent = `@${nameOf(id)}`;
      b.addEventListener('click', (e) => openUserPop(id, e.currentTarget));
      el.appendChild(b);
    } else if (m[3]) {
      const ms = Number(m[3]) * 1000, t = document.createElement('time'); t.className = 'time-tag';
      t.dateTime = new Date(ms).toISOString(); t.title = new Date(ms).toLocaleString();
      t.textContent = m[4] === 'R' ? fmtRelative(ms) : fmtWhen(ms);
      el.appendChild(t);
    } else if (m[5]) {
      const sp = add('span', 'spoiler', m[5]);
      sp.title = 'Spoiler: click to show'; sp.tabIndex = 0; sp.setAttribute('role', 'button');
      const show = (e) => { e.stopPropagation(); sp.classList.add('shown'); sp.removeAttribute('title'); };
      sp.addEventListener('click', show); sp.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') show(e); });
    }
    else if (m[6]) add('b', null, m[6]);
    else if (m[7]) add('u', null, m[7]);
    else if (m[8]) add('s', null, m[8]);
    else if (m[9] || m[10]) add('em', null, m[9] || m[10]);
    else if (m[11]) el.appendChild(customEmojiEl(m[11], Number(m[12])));
    else if (m[13]) {
      const key = `${m[13]}:${m[14]}`, id = Number(m[15]);
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn small jump-msg'; b.textContent = '↗ Go to message';
      b.addEventListener('click', () => jumpTo(key, id));
      el.appendChild(b);
    }
    else {
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
const decodeMentions = (text) => String(text || '').replace(/^<poll:\d+>$/, '📊 Started a poll').replace(/^<lfg:\d+>$/, '🎮 Looking for a group').replace(/^<s:\d+>$/, 'Sent a sticker').replace(/^<g:[\w-]+>$/, 'Sent a GIF').replace(/<:(\w+):\d+>/g, ':$1:').replace(/\s*<m:[cd]:\d+:\d+>/g, '')
  .replace(/<@(\d+)>/g, (x, id) => `@${nameOf(Number(id))}`).replace(/\*\*/g, '')
  .replace(/\|\|[^\n]*?\|\|/g, '[spoiler]').replace(/```[\w+-]*\n?|~~|__|`/g, '')
  .replace(/<t:(\d{9,11})(?::R)?>/g, (x, t) => fmtWhen(Number(t) * 1000));
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
  const nm = document.createElement('span'); nm.className = 'msg-name'; nm.style.setProperty('--h', hue(nameOf(msg.userId)));
  nameInto(nm, msg.userId, msg.channelId && (findChannel(msg.channelId) || {}).server);
  addCrown(nm, msg.userId);
  head.appendChild(nm);
  if (msg.expiresAt) { const x = document.createElement('span'); x.className = 'msg-expires'; x.textContent = '⏳'; x.title = `Disappears ${fmtRelative(msg.expiresAt)}`; head.appendChild(x); }
  if (msg.pinned) { const p = document.createElement('span'); p.className = 'msg-pinned'; p.title = `Pinned by ${nameOf(msg.pinned.by)}`; p.innerHTML = iconSvg('pin'); head.appendChild(p); }
  const tm = document.createElement('time'); tm.className = 'msg-time'; tm.dateTime = new Date(msg.at).toISOString();
  tm.textContent = `${fmtDay(msg.at)} ${fmtTime(msg.at)}`; tm.title = new Date(msg.at).toLocaleString();
  head.appendChild(tm);
  li.appendChild(head);
  const special = msg.body && /^<([sg]):([\w-]+)>$/.exec(msg.body);
  if (/^<poll:\d+>$/.test(msg.body || '')) li.appendChild(pollEl(msg));
  else if (/^<lfg:\d+>$/.test(msg.body || '')) li.appendChild(lfgEl(msg));
  else if (special) li.appendChild(special[1] === 's' ? stickerEl(Number(special[2])) : gifEl(special[2]));
  else if (msg.body) {
    const body = document.createElement('div'); body.className = 'msg-body';
    if (isJumbo(msg.body)) body.classList.add('jumbo');
    richText(body, msg.body);
    if (msg.editedAt) { const e = document.createElement('span'); e.className = 'msg-edited'; e.textContent = '(edited)'; body.appendChild(e); }
    li.appendChild(body);
  }
  for (const a of msg.attachments || []) li.appendChild(mediaEl(a, msg.id));
  for (const e of msg.embeds || []) li.appendChild(embedEl(e));
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
  tool('clock', 'Remind me about this', (e) => openRemind(msg, e.currentTarget));
  const saved = S.bookmarks.has(msg.id);
  tool('bookmark', saved ? 'Remove from saved messages' : 'Save for later (only you see it)', () => act(() => live.req('bookmark.set', { id: msg.id, on: !saved }), saved ? null : 'Saved. Find it under Home → Saved messages.'), saved ? 'on' : '');
  tool('pin', msg.pinned ? 'Unpin' : 'Pin', () => act(() => live.req('msg.pin', { id: msg.id, on: !msg.pinned }), msg.pinned ? 'Unpinned.' : null), msg.pinned ? 'on' : '');
  if (mine || S.me.admin || (srv && can(srv, 'messages'))) {
    tool('trash', 'Delete', async (ev) => {
      if (ev.shiftKey || await confirmBox('Delete this message?', 'It’s removed for everyone. Hold Shift while clicking to skip this question.')) act(() => live.req('msg.delete', { id: msg.id }));
    }, 'del');
  }
  li.appendChild(tools);
  return li;
}

/* ---------- reactions ---------- */
const QUICK_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👀', '💯', '🙏', '⭐', '✅'];   // 3 ⭐ puts a message in the hall of fame
function reactionsEl(msg) {
  const row = document.createElement('div'); row.className = 'reactions';
  for (const r of msg.reactions) {
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'reaction' + (r.users.includes(S.me.id) ? ' mine' : '');
    // Party Bot adds the first reaction to its polls so the buttons show; it doesn't count as a vote.
    const people = r.users.filter((id) => !user(id).bot);
    const label = emojiLabel(r.emoji);
    emojiInto(b, r.emoji); b.appendChild(document.createTextNode(` ${people.length}`));
    b.title = people.length ? `${people.map(nameOf).join(', ')} reacted with ${label}` : `React with ${label}`;
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
  const srvId = msg.channelId ? ((findChannel(msg.channelId) || {}).server || {}).id : null;
  const custom = [...S.emoji.values()].filter((e) => e.kind === 'emoji').sort((a, b) => (b.serverId === srvId) - (a.serverId === srvId)).slice(0, 24).map((e) => `<:${e.name}:${e.id}>`);
  for (const e of [...QUICK_EMOJI, ...custom]) {
    const b = document.createElement('button'); b.type = 'button'; emojiInto(b, e); b.setAttribute('aria-label', `React with ${emojiLabel(e)}`);
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
  rerenderOne(key, msg.id);
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
function mediaEl(a, msgId) {
  const wrap = document.createElement('div'); wrap.className = 'msg-media';
  const url = absUrl(a.url);
  if (!IMG_RE.test(a.type) && !VID_RE.test(a.type) && !AUD_RE.test(a.type)) {
    // Any other file: a card with its name and size that downloads it.
    wrap.classList.add('file-card');
    const link = document.createElement('a'); link.className = 'file-link'; link.href = url; link.download = a.name;
    link.innerHTML = iconSvg('file');
    const t = document.createElement('span'); t.className = 'file-text';
    const n = document.createElement('b'); n.textContent = a.name; t.appendChild(n);
    const sz = document.createElement('small'); sz.textContent = `${fmtSize(a.size)} · Download`; t.appendChild(sz);
    link.appendChild(t); wrap.appendChild(link);
    return wrap;
  }
  if (AUD_RE.test(a.type)) {
    const au = document.createElement('audio'); au.className = 'media-audio'; au.controls = true; au.preload = 'metadata'; au.src = url;
    if (/^Voice message/.test(a.name)) {
      wrap.classList.add('voice-msg');
      const lbl = document.createElement('span'); lbl.className = 'voice-msg-label'; lbl.innerHTML = iconSvg('mic');
      lbl.appendChild(document.createTextNode(a.name.replace(/\.\w+$/, ''))); wrap.appendChild(lbl);
      // Chrome's recordings don't store their length; seeking far ahead makes the player work it out.
      au.addEventListener('loadedmetadata', () => {
        if (au.duration !== Infinity) return;
        au.addEventListener('durationchange', () => { au.currentTime = 0; }, { once: true });
        au.currentTime = 1e7;
      }, { once: true });
      wrap.appendChild(au);
      return wrap;
    }
    wrap.appendChild(au);
  } else if (a.type.startsWith('image/')) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'media-btn'; b.setAttribute('aria-label', `Open ${a.name}`);
    const img = document.createElement('img'); img.className = 'media-img'; img.loading = 'lazy'; img.src = a.thumbUrl ? absUrl(a.thumbUrl) : url; img.alt = a.name;
    img.addEventListener('load', () => { const box = $('#messages'); if (box.scrollHeight - box.scrollTop - box.clientHeight < img.height + 120) box.scrollTop = box.scrollHeight; });
    b.appendChild(img);
    b.addEventListener('click', () => openLightbox(url, a.name));
    wrap.appendChild(b);
    if (msgId && a.id) wrap.appendChild(saveGifBtn(a.id));
  } else {
    const v = document.createElement('video'); v.className = 'media-video'; v.controls = true; v.preload = 'metadata'; v.src = url; v.playsInline = true;
    wrap.appendChild(v);
    if (msgId) {
      // Watch together: plays for everyone in your voice channel, in step (shown while you're in voice).
      const w = document.createElement('button'); w.type = 'button'; w.className = 'watch-btn'; w.innerHTML = iconSvg('play'); w.appendChild(document.createTextNode('Watch together'));
      w.title = 'Play this for everyone in your voice channel, at the same moment';
      w.addEventListener('click', () => { v.pause(); act(() => live.req('music.watch', { id: msgId, url: a.url })); });
      wrap.appendChild(w);
    }
  }
  const meta = document.createElement('div'); meta.className = 'media-meta';
  const n = document.createElement('span'); n.textContent = `${a.name} · ${fmtSize(a.size)}`; meta.appendChild(n);
  const dl = document.createElement('a'); dl.href = url; dl.download = a.name; dl.textContent = 'Save'; meta.appendChild(dl);
  wrap.appendChild(meta);
  return wrap;
}
/* Link preview card. YouTube previews play right here when clicked. */
function embedEl(e) {
  const card = document.createElement('div'); card.className = 'embed' + (e.big ? ' big' : '');
  const text = document.createElement('div'); text.className = 'embed-text';
  const site = document.createElement('small'); site.className = 'embed-site'; site.textContent = e.site; text.appendChild(site);
  const t = document.createElement('a'); t.className = 'embed-title'; t.href = e.url; t.target = '_blank'; t.rel = 'noopener noreferrer'; t.textContent = e.title; text.appendChild(t);
  if (e.description) { const d = document.createElement('p'); d.className = 'embed-desc'; d.textContent = e.description; text.appendChild(d); }
  card.appendChild(text);
  if (e.image) {
    const box = document.createElement(e.youtube ? 'button' : 'a'); box.className = 'embed-img';
    const img = document.createElement('img'); img.loading = 'lazy'; img.alt = ''; img.src = absUrl(e.image);
    img.addEventListener('error', () => box.remove());
    box.appendChild(img);
    if (e.youtube) {
      box.type = 'button'; box.setAttribute('aria-label', `Play ${e.title}`);
      box.insertAdjacentHTML('beforeend', `<span class="embed-play">${iconSvg('play')}</span>`);
      box.addEventListener('click', () => {
        const f = document.createElement('iframe'); f.className = 'embed-video';
        f.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(e.youtube)}?autoplay=1&rel=0`;
        f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen'; f.allowFullscreen = true; f.title = e.title;
        box.replaceWith(f);
      });
    } else { box.href = e.url; box.target = '_blank'; box.rel = 'noopener noreferrer'; box.tabIndex = -1; }
    card.appendChild(box);
  }
  return card;
}
function introEl() {
  const li = document.createElement('li'); li.className = 'chan-intro';
  const g = document.createElement('div'); g.className = 'glyph-big';
  const h = document.createElement('h2'), p = document.createElement('p');
  if (S.view.kind === 'dm') {
    li.classList.add('dm-intro');
    const w = document.createElement('span'); w.className = 'av-wrap'; w.appendChild(avEl(S.view.userId));
    const dot = document.createElement('span'); dot.className = 'status-dot ' + statusOf(S.view.userId); w.appendChild(dot);
    li.appendChild(w);
    h.textContent = nameOf(S.view.userId);
    p.textContent = `This is the start of your private chat with ${nameOf(S.view.userId)}. Only the two of you can see it.`;
  } else {
    const f = findChannel(S.view.channelId);
    g.textContent = '#'; li.appendChild(g);
    h.textContent = `Welcome to #${f ? f.channel.name : ''}`;
    if (f && isPrivate(f.server)) {
      g.innerHTML = iconSvg('users');
      h.textContent = groupName(f.server);
      p.textContent = `This is the start of your group chat with ${f.server.members.filter((id) => id !== S.me.id).map(nameOf).join(', ')}. Only the people in it can see it.`;
      li.appendChild(h); li.appendChild(p);
      return li;
    }
    if (f && f.channel.kind === 'voice') {
      g.innerHTML = iconSvg('volume');
      h.textContent = `${f.channel.name} chat`;
      p.textContent = 'Share links, clips and game invites with whoever’s in the call. Everyone in the server can read it, even when they’re not in voice.';
    } else p.textContent = 'This is the start of the channel. Messages, photos, videos and files posted here are saved for everyone in the server.';
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
  box.appendChild(chatTop(m, key));
  let prev = null;
  const mark = S.newMark && S.newMark.key === key && m.loaded ? m.list[Math.max(0, m.list.length - S.newMark.count)] : null;
  for (const msg of m.list) {
    if (mark && msg === mark && msg.userId !== S.me.id) { const d = document.createElement('li'); d.className = 'new-divider'; d.innerHTML = '<span>New messages</span>'; box.appendChild(d); prev = null; }
    box.appendChild(messageEl(msg, prev)); prev = msg;
  }
  lastRendered = { key, prev };
  renderSeen();
  if (keepScroll && !atBottom) box.scrollTop = top; else box.scrollTop = box.scrollHeight;
  // Opening a chat with lots of unread: start at the "New messages" line instead of the bottom.
  const div = box.querySelector('.new-divider');
  if (!keepScroll && div && S.newMark.count > 6) box.scrollTop = Math.max(0, div.offsetTop - 40);
  renderNewBar();
}
/* The top of a chat: "Load older messages", the channel's welcome, or "Loading messages…". */
function chatTop(m, key) {
  if (m.hasMore && m.loaded) {
    const more = document.createElement('button'); more.type = 'button'; more.className = 'btn small load-more'; more.textContent = m.loading ? 'Loading…' : 'Load older messages';
    more.addEventListener('click', () => loadHistory(key, true));
    return more;
  }
  if (m.loaded) return introEl();
  const li = document.createElement('li'); li.className = 'sys'; li.textContent = 'Loading messages…';
  return li;
}
function appendMessage(msg) {
  const box = $('#messages');
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120 || msg.userId === S.me.id;
  const m = S.msgs.get(msgKey());
  const list = m ? m.list : [];
  const prev = list.length > 1 ? list[list.length - 2] : null;
  box.appendChild(messageEl(msg, prev));
  renderSeen();
  if (near) box.scrollTop = box.scrollHeight;
}
/* Read receipts in private chats: "Seen" under your last message once they've read it. */
function renderSeen() {
  const old = document.querySelector('#messages .seen-line'); if (old) old.remove();
  if (S.view.kind !== 'dm') return;
  const m = S.msgs.get(msgKey());
  if (!m || !m.list.length) return;
  const last = m.list[m.list.length - 1];
  if (last.userId !== S.me.id || !(m.seenId >= last.id)) return;
  const li = document.createElement('li'); li.className = 'seen-line'; li.textContent = 'Seen';
  $('#messages').appendChild(li);
}
function rerenderMessagesSoft() { if (S.view.kind === 'text' || S.view.kind === 'dm') renderMessages(true); }
/* One message changed (a reaction, a vote, an edit): redraw just it, so a long chat doesn't stall. */
function rerenderOne(key, id) {
  if (msgKey() !== key) return;
  const m = S.msgs.get(key), i = m ? m.list.findIndex((x) => x.id === id) : -1, li = $(`#messages .msg[data-id="${id}"]`);
  if (i < 0) return;   // not in this chat
  if (!li) { renderMessages(true); return; }
  const box = $('#messages'), atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const fresh = messageEl(m.list[i], m.list[i - 1] || null);
  if (li.classList.contains('flash')) fresh.classList.add('flash');
  li.replaceWith(fresh);
  if (atBottom) box.scrollTop = box.scrollHeight;
}
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
  const done = () => rerenderOne(msgKey(), msg.id);
  ta.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { e.preventDefault(); done(); }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const t = encodeEmoji(encodeMentions(ta.value.trim()));
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
  // "/" at the start shows Party Bot's commands.
  const cmd = /^\/([a-z]*)$/i.exec(before);
  if (cmd && S.commands && S.commands.length) {
    const q = cmd[1].toLowerCase();
    const items = S.commands.filter(([name]) => name.startsWith(q)).map(([name, args, desc]) => ({ cmd: name, args, desc }));
    if (!items.length) { closeMentionPop(); return; }
    mention = { start: 0, end: pos, items, index: 0 };
    renderMentionPop();
    return;
  }
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
    if (u.cmd) {
      li.insertAdjacentHTML('beforeend', '<span class="mini-av bot" aria-hidden="true">🤖</span>');
      const n = document.createElement('span'); n.className = 'cmd-name'; n.textContent = '/' + u.cmd; li.appendChild(n);
      if (u.args) { const a = document.createElement('span'); a.className = 'cmd-args'; a.textContent = u.args; li.appendChild(a); }
      const d = document.createElement('span'); d.className = 'cmd-desc'; d.textContent = u.desc; li.appendChild(d);
      li.addEventListener('pointerdown', (e) => { e.preventDefault(); pickMention(u); });
      pop.appendChild(li);
      return;
    }
    li.appendChild(avEl(u.id));
    const n = document.createElement('span'); n.textContent = u.name; li.appendChild(n);
    li.addEventListener('pointerdown', (e) => { e.preventDefault(); pickMention(u); });
    pop.appendChild(li);
  });
  pop.hidden = false;
}
function closeMentionPop() { mention = null; $('#mentionPop').hidden = true; }
function pickMention(u) {
  const v = chatInput.value, ins = u.cmd ? `/${u.cmd} ` : `@${u.name} `;
  chatInput.value = v.slice(0, mention.start) + ins + v.slice(mention.end);
  const caret = mention.start + ins.length;
  chatInput.setSelectionRange(caret, caret);
  closeMentionPop();
  chatInput.focus();
}

chatInput.addEventListener('keydown', (e) => {
  if (mention) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); mention.index = (mention.index + (e.key === 'ArrowDown' ? 1 : -1) + mention.items.length) % mention.items.length; renderMentionPop(); return; }
    const it = mention.items[mention.index];
    // A command typed out in full ("/skip") sends on Enter instead of being picked again.
    if (e.key === 'Enter' && it.cmd && chatInput.value.trim().toLowerCase() === '/' + it.cmd) closeMentionPop();
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(it); return; }
    else if (e.key === 'Escape') { e.preventDefault(); closeMentionPop(); return; }
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
/* Messages go out in order. Text-only messages clear the box at once, so you can keep typing; if one fails,
   its text comes back. Messages with files wait for their uploads. */
let sendChain = Promise.resolve();
$('#chatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (S.sending) return;
  const raw = chatInput.value, body = encodeEmoji(encodeMentions(raw.trim()));
  if (!body && !S.attach.length) return;
  const target = composeTarget();
  if (!target) return;
  if (!live.open) { toast('Not connected to the server right now. Your message is still in the box.', 4000); return; }
  const replyTo = S.replyTo ? S.replyTo.id : null;
  const send = (attachments) => live.req('msg.send', Object.assign({ body, attachments, replyTo }, target))
    .then((r) => { if (r && r.ephemeral) botNote(r.ephemeral); else hideBotNote(); });
  if (!S.attach.length) {
    chatInput.value = ''; autosize(); cancelReply(); typingSentAt = 0;
    sendChain = sendChain.then(() => send([]).catch((ex) => {
      toast(ex.message, 5000);
      if (!chatInput.value) { chatInput.value = raw; autosize(); }
    }));
    return;
  }
  S.sending = true;
  try {
    await sendChain;
    const ids = [];
    for (const a of S.attach) {
      if (!a.id) {
        const small = await thumbnailOf(a.file);
        if (small) { try { a.thumb = (await upload('/api/upload', small)).id; } catch {} }
        const r = await upload('/api/upload', a.file, (p) => setAttachProgress(a, p)); a.id = r.id;
      }
      ids.push({ id: a.id, thumb: a.thumb || null });
    }
    await send(ids);
    chatInput.value = ''; autosize();
    clearAttach(); cancelReply();
    typingSentAt = 0;
  } catch (ex) { toast(ex.message, 5000); }
  finally { S.sending = false; renderTray(); }
});
$('#attachBtn').addEventListener('click', () => { const m = $('#attachMenu'); m.hidden = !m.hidden; $('#attachLfg').hidden = S.view.kind !== 'text'; $('#attachBtn').setAttribute('aria-expanded', String(!m.hidden)); });
$('#attachFiles').addEventListener('click', () => { $('#attachMenu').hidden = true; $('#fileInput').click(); });
$('#attachPoll').addEventListener('click', () => { $('#attachMenu').hidden = true; openPollBuilder(); });
$('#attachLfg').addEventListener('click', () => { $('#attachMenu').hidden = true; openLfgBuilder(); });
document.addEventListener('pointerdown', (e) => { if (!$('#attachMenu').hidden && !e.target.closest('#attachMenu, #attachBtn')) { $('#attachMenu').hidden = true; $('#attachBtn').setAttribute('aria-expanded', 'false'); } });

/* ---------- voice messages: record with the mic, up to 2 minutes ---------- */
let rec = null;   // { recorder, stream, chunks, started, timer, cancelled }
const REC_MAX = 120;
const recType = () => ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
$('#recBtn').addEventListener('click', async () => {
  if (rec) return;
  if (!window.MediaRecorder || !navigator.mediaDevices) { toast('This browser can’t record voice messages.', 4000); return; }
  if (!composeTarget()) return;
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: settings.micId ? { ideal: settings.micId } : undefined, echoCancellation: true, noiseSuppression: true } }); }
  catch { toast('Party Line needs your microphone to record. Allow it in the browser and try again.', 5000); return; }
  const type = recType();
  const recorder = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 48000 } : undefined);
  rec = { recorder, stream, chunks: [], started: Date.now(), cancelled: false };
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
  recorder.onstop = () => finishRecording();
  recorder.start(250);
  rec.timer = setInterval(() => {
    const s = Math.floor((Date.now() - rec.started) / 1000);
    $('#recTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (s >= REC_MAX) recorder.stop();
  }, 250);
  $('#recTime').textContent = '0:00';
  $('#recBar').hidden = false; $('.composer-row').hidden = true;
});
$('#recCancel').addEventListener('click', () => { if (rec) { rec.cancelled = true; rec.recorder.stop(); } });
$('#recSend').addEventListener('click', () => { if (rec && rec.recorder.state !== 'inactive') rec.recorder.stop(); });
async function finishRecording() {
  const r = rec; rec = null;
  clearInterval(r.timer);
  r.stream.getTracks().forEach((t) => t.stop());
  $('#recBar').hidden = true; $('.composer-row').hidden = false;
  const secs = Math.max(1, Math.floor((Date.now() - r.started) / 1000));
  if (r.cancelled || !r.chunks.length) return;
  if (secs < 1) { toast('That was too short.', 2500); return; }
  const type = (r.recorder.mimeType || 'audio/webm').split(';')[0];
  const ext = type === 'audio/mp4' ? 'm4a' : type === 'audio/ogg' ? 'ogg' : 'webm';
  const len = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  const file = new File([await withDuration(new Blob(r.chunks, { type }), Date.now() - r.started)], `Voice message (${len}).${ext}`, { type });
  const target = composeTarget();
  if (!target) return;
  try {
    const up = await upload('/api/upload', file);
    await live.req('msg.send', Object.assign({ body: '', attachments: [{ id: up.id }] }, target));
  } catch (ex) { toast(ex.message, 5000); }
}
$('#fileInput').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
function addFiles(files) {
  for (const f of files) {
    const max = IMG_RE.test(f.type) ? MAX_IMAGE : VID_RE.test(f.type) ? MAX_VIDEO : MAX_FILE;
    if (f.size > max) { toast(`${f.name} is too big. The limit is ${Math.round(max / 1048576)} MB.`, 4500); continue; }
    if (!f.size) { toast(`${f.name} is empty.`, 3000); continue; }
    if (S.attach.length >= 10) { toast('Up to 10 files per message.', 3000); break; }
    S.attach.push({ file: f, url: URL.createObjectURL(f), progress: 0 });
  }
  renderTray();
}
/* Lighter on mobile data: big photos get a small preview (at most 640 px across) made right here; the chat
   shows the preview and the full photo opens on click. Animated GIFs and small photos are left as they are. */
async function thumbnailOf(file) {
  if (!/^image\/(png|jpeg|webp|avif|bmp)$/.test(file.type) || file.size < 150 * 1024 || typeof createImageBitmap !== 'function') return null;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 640 / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 400 * 1024) { bmp.close(); return null; }
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close();
    const blob = await new Promise((r) => c.toBlob(r, 'image/webp', 0.8));
    if (!blob || blob.size >= file.size) return null;
    return new File([blob], `small-${file.name.replace(/\.\w+$/, '')}.webp`, { type: 'image/webp' });
  } catch { return null; }
}
function clearAttach() { for (const a of S.attach) URL.revokeObjectURL(a.url); S.attach = []; renderTray(); }
function setAttachProgress(a, p) { a.progress = p; const bar = document.querySelector(`.att[data-u="${CSS.escape(a.url)}"] .bar i`); if (bar) bar.style.width = `${Math.round(p * 100)}%`; }
function renderTray() {
  const tray = $('#tray');
  tray.textContent = '';
  tray.hidden = !S.attach.length;
  for (const a of S.attach) {
    const d = document.createElement('div'); d.className = 'att'; d.dataset.u = a.url;
    if (IMG_RE.test(a.file.type) || VID_RE.test(a.file.type)) {
      const media = document.createElement(IMG_RE.test(a.file.type) ? 'img' : 'video');
      media.src = a.url; if (media.tagName === 'VIDEO') media.muted = true;
      d.appendChild(media);
    } else { const ic = document.createElement('span'); ic.className = 'att-file'; ic.innerHTML = iconSvg('file'); d.appendChild(ic); }
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

let lbFromGallery = false;   // a window (the media gallery) sits above everything else, so it steps aside while a photo is open
function openLightbox(url, name, video) {
  lbFromGallery = $('#galleryDlg').open;
  if (lbFromGallery) $('#galleryDlg').close();
  $('#lbImg').hidden = !!video; $('#lbVideo').hidden = !video;
  if (video) { $('#lbVideo').src = url; $('#lbVideo').play().catch(() => {}); } else $('#lbImg').src = url;
  $('#lbName').textContent = name; $('#lbSave').href = url; $('#lbSave').download = name; $('#lightbox').hidden = false; $('#lbClose').focus();
}
$('#lbClose').addEventListener('click', () => {
  $('#lightbox').hidden = true; $('#lbImg').src = ''; $('#lbVideo').pause(); $('#lbVideo').removeAttribute('src'); $('#lbVideo').load();
  if (lbFromGallery) { lbFromGallery = false; $('#galleryDlg').showModal(); }
});
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
    const title = document.createElement('h2'); title.className = 'fr-section-title';
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
      const dot = document.createElement('span'); dot.className = 'status-dot ' + statusOf(id); w.appendChild(dot);
      li.appendChild(w);
      const t = document.createElement('div'); t.className = 'fr-text';
      const b = document.createElement('b'); b.textContent = nameOf(id); addCrown(b, id); t.appendChild(b);
      const s = document.createElement('span');
      const vst = S.voice.get(id);
      s.textContent = st === 'incoming' ? 'Wants to be your friend' : st === 'outgoing' ? 'Friend request sent' : vst ? `In voice: ${(findChannel(vst.channelId) || { channel: { name: '' } }).channel.name}` : presenceLine(id);
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
    if (isPrivate(s)) continue;
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
  $('#homeEmpty').hidden = [...S.servers.values()].some((x) => !isPrivate(x));
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
  const vst = S.voiceStatus.get(chId);
  $('#vcStatus').hidden = !vst && !inThis;
  $('#vcStatusText').textContent = vst ? vst.text : 'No status yet. Tell others what’s going on here, like “ranked Valorant 🔥”.';
  $('#vcStatusText').classList.toggle('empty', !vst);
  $('#vcStatusEdit').hidden = !inThis;
  $('#vcStatusEditLabel').textContent = vst ? 'Change' : 'Set a status';
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
  syncStageExtras();
  for (const p of people) {
    const d = document.createElement('div');
    const isMe = p.userId === S.me.id;
    const peer = V.peers.get(p.userId);
    d.className = 'tile' + (V.speaking.has(p.userId) ? ' speaking' : '') + (inThis && !isMe && peer && peer.net !== 'ok' ? ' dim' : '');
    d.dataset.uid = p.userId;
    d.innerHTML = '<span class="lamp" aria-hidden="true"></span>';
    const cam = isMe ? (V.camera ? V.camStream : null) : (p.camera && peer ? peer.camStream : null);
    if (cam && inThis) { d.classList.add('has-cam'); d.appendChild(camVideo(p.userId, cam, isMe)); }
    else d.appendChild(avEl(p.userId, 'avatar'));
    const meta = document.createElement('div'); meta.className = 'tile-meta';
    const n = document.createElement('span'); n.className = 'tile-name'; nameInto(n, p.userId, null, nameOf(p.userId) + (isMe ? ' (you)' : '')); addCrown(n, p.userId); meta.appendChild(n);
    if (S.soundFlash.has(p.userId)) { const f = document.createElement('span'); f.className = 'tile-sound'; f.textContent = S.soundFlash.get(p.userId); f.title = 'Played a sound'; n.appendChild(f); }
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
    if (p.camera && !inThis) badges.insertAdjacentHTML('beforeend', `<span class="tb cam" title="Camera on">${iconSvg('video')}</span>`);
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
$('#stageClose').addEventListener('click', () => { S.watching = null; renderVoiceView(); syncStageExtras(); });

/* ---------- on the stage: draw together, Clip it, pop out (see stagefx.js) ---------- */
const DRAW_COLORS = ['#ffd43b', '#ff6b6b', '#74c0fc', '#8ce99a', '#f783ac', '#b197fc', '#ffa94d', '#66d9e8'];
const drawLayer = createDrawLayer($('#stageCanvas'), $('#stageVideo'));
const clipBuf = createClipBuffer();
drawLayer.onSend((p) => { if (S.watching) live.send('draw', Object.assign({ target: S.watching }, p)); });
function stageStream() {
  if (!S.watching || !V.channelId) return null;
  return (S.watching === S.me.id ? V.screenStream : (V.peers.get(S.watching) || {}).screenStream) || null;
}
/* Keeps the clip recorder on whatever you're watching (once Clip it is switched on: recording uses a fair bit of the
   computer), and tidies up when the share ends. */
function syncStageExtras() {
  const st = stageStream();
  clipBuf.watch(!isPhone() && settings.clips ? st : null);
  const cb = $('#stageClipBtn');
  cb.hidden = !clipsSupported() || isPhone();
  cb.classList.toggle('armed', !!settings.clips);
  cb.title = settings.clips ? 'Save the last 30 seconds as a clip' : 'Turn on Clip it: keeps the last 30 seconds so you can save them';
  $('#stagePipBtn').hidden = !document.pictureInPictureEnabled;
  if (!st) {
    if (drawLayer.drawing) setDrawing(false);
    drawLayer.clear();
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  }
}
function setDrawing(on) {
  drawLayer.setColor(DRAW_COLORS[hue(S.me.name) % DRAW_COLORS.length]);
  drawLayer.setDrawing(on);
  $('#stageDrawBtn').setAttribute('aria-pressed', String(on));
  $('#stageDrawBtn').classList.toggle('on', on);
  if (on && !store.get('drawTip')) { store.set('drawTip', 1); toast('Draw on the screen: everyone watching sees it for a few seconds. Press Esc or Draw again to stop.', 6000); }
}
$('#stageDrawBtn').addEventListener('click', () => setDrawing(!drawLayer.drawing));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawLayer.drawing) setDrawing(false); });
live.on('draw', (d) => {
  if (d.target === S.watching && V.channelId) drawLayer.addRemote(d);
  // On your own screen share, the desktop app can show the drawings on top of your real screen (even over a game).
  if (d.target === S.me.id && V.sharing && desktop && desktop.drawOnScreen) desktop.drawOnScreen({ from: d.from, id: d.id, color: d.color, pts: d.pts, end: d.end });
});
$('#stageClipBtn').addEventListener('click', async () => {
  const b = $('#stageClipBtn'), of = S.watching;
  if (b.disabled || !of) return;
  if (!settings.clips) {
    settings.clips = true; saveSettings(); syncStageExtras(); syncSettingsForm();
    toast('🎬 Clip it is on: from now on it keeps the last 30 seconds of screens you watch. Press it again when something happens. (It uses more of your computer; Settings → Voice turns it off.)', 9000);
    return;
  }
  b.disabled = true;
  try {
    const c = await clipBuf.clip();
    if (!c || c.blob.size < 2000) { toast('Nothing to clip yet. Try again in a few seconds.', 3500); return; }
    toast('🎬 Saving the clip…', 2500);
    const file = new File([await withDuration(c.blob, c.ms)], `Clip of ${of === S.me.id ? 'my' : `${nameOf(of)}’s`} screen (${c.seconds}s).webm`, { type: c.blob.type || 'video/webm' });
    const up = await upload('/api/upload', file);
    const r = await live.req('clip.post', { upload: up.id, of });
    const f = findChannel(r.channelId);
    toast(`🎬 Clip saved${f ? ` in ${f.channel.kind === 'voice' ? '🔊 ' : '#'}${f.channel.name}` : ''}.`, 5000, f ? { label: 'Open', fn: () => setView({ kind: 'text', serverId: f.server.id, channelId: f.channel.id }) } : undefined);
  } catch (e) { toast(e.message || 'Couldn’t save the clip.', 4500); }
  finally { b.disabled = false; }
});
$('#stagePipBtn').addEventListener('click', () => {
  if (document.pictureInPictureElement) { document.exitPictureInPicture().catch(() => {}); return; }
  $('#stageVideo').requestPictureInPicture().catch(() => toast('Pop out isn’t available here.', 3000));
});
$('#stageFull').addEventListener('click', () => { const el = $('#stage'); if (document.fullscreenElement) document.exitFullscreen(); else el.requestFullscreen && el.requestFullscreen().catch(() => {}); });

/* One <video> per person, reused between renders so the picture doesn't flicker. */
const camEls = new Map();
function camVideo(id, stream, mirror) {
  let v = camEls.get(id);
  if (!v) { v = document.createElement('video'); v.className = 'tile-cam'; v.autoplay = true; v.playsInline = true; v.muted = true; camEls.set(id, v); }
  if (v.srcObject !== stream) { v.srcObject = stream; v.play().catch(() => {}); }
  v.classList.toggle('mirror', !!mirror);
  return v;
}
function renderSpeaking(set) {
  document.querySelectorAll('.tile[data-uid], .member[data-uid]').forEach((el) => el.classList.toggle('speaking', set.has(Number(el.dataset.uid))));
  sendOverlay();
}
/* Desktop app: who's in my voice channel and who's talking, for the overlay shown over games. */
let lastOverlay = '';
function sendOverlay() {
  if (!desktop || !desktop.setOverlay) return;
  const f = V.channelId && findChannel(V.channelId);
  const st = f ? {
    channel: f.channel.name,
    people: [...S.voice.values()].filter((v) => v.channelId === V.channelId).map((v) => ({
      name: nameOf(v.userId), talking: V.speaking.has(v.userId), muted: !!(v.muted || v.deafened || v.serverMuted), color: `hsl(${hue(nameOf(v.userId))} 45% 45%)`,
    })),
  } : null;
  const key = JSON.stringify(st);
  if (key !== lastOverlay) { lastOverlay = key; desktop.setOverlay(st); }
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
  if (micPanelOpen) startMeter();
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
  if (!V.channelId) return { text: S.me ? (S.me.custom || { online: 'Online', idle: 'Idle', dnd: 'Do not disturb', invisible: 'Invisible' }[S.me.status || 'online']) : 'Online' };
  if (V.serverMuted) return { text: 'Muted by admin' };
  if (V.deafened) return { text: 'Deafened' };
  if (V.muted) return { text: 'Muted' };
  if (settings.ptt) return { text: V.pttHeld ? 'Talking' : 'Push to talk' };
  return { text: 'In voice' };
}
function renderUserArea() {
  document.body.classList.toggle('in-call', !!V.channelId);   // shows Watch together on shared videos
  if (!S.me) return;
  paintAv($('#meAv'), S.me.id);
  const pref = S.me.status || 'online';
  $('#meDot').className = 'status-dot ' + (pref === 'invisible' ? 'offline' : pref);
  $('#statusBtn').title = `Status: ${{ online: 'Online', idle: 'Idle', dnd: 'Do not disturb', invisible: 'Invisible' }[pref]}. Click to change`;
  $('#meName').textContent = S.me.name; addCrown($('#meName'), S.me.id);
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
    $('#vsChan').textContent = f ? (isPrivate(f.server) ? groupName(f.server) : `${f.channel.name} / ${f.server.name}`) : '';
    const peers = [...V.peers.values()];
    const bad = peers.some((p) => p.net === 'failed');
    $('#vsState').lastChild.textContent = V.joining ? 'Connecting…' : bad ? 'Voice trouble' : 'Voice connected';
    $('#vsState').style.color = bad ? 'var(--danger)' : '';
    const cb = $('#camBtn');
    cb.hidden = !Voice.canCamera();
    cb.classList.toggle('on', V.camera);
    cb.querySelector('use').setAttribute('href', V.camera ? '#i-video-off' : '#i-video');
    cb.querySelector('.lbl').textContent = V.camera ? 'Turn off camera' : 'Turn on camera'; cb.title = V.camera ? 'Turn off camera' : 'Turn on camera';
    const sh = $('#shareBtn');
    sh.hidden = !Voice.canShare();
    sh.classList.toggle('on', V.sharing);
    sh.querySelector('use').setAttribute('href', V.sharing ? '#i-screen-off' : '#i-screen');
    sh.querySelector('.lbl').textContent = V.sharing ? 'Stop sharing' : 'Share screen'; sh.title = V.sharing ? 'Stop sharing' : 'Share your screen';
    syncFx();
    const nb = $('#noiseBtn');
    nb.classList.toggle('active', settings.noiseMode === 'strong');
    nb.title = `Noise filter: ${{ strong: 'Strong', standard: 'Standard', off: 'Off' }[settings.noiseMode]} (N)`;
  }
  if (!V.channelId && !$('#fxPop').hidden) closeFx();
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
$('#camBtn').addEventListener('click', async () => {
  if (V.camera) Voice.stopCamera(); else { await Voice.startCamera(); if (V.camera && S.view.kind !== 'voice') { const f = findChannel(V.channelId); if (f) setView({ kind: 'voice', serverId: f.server.id, channelId: f.channel.id }); } }
  renderVoiceBits();
});
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
/* Desktop app: the mute and deafen keys work even while a game is in front. */
if (desktop && desktop.onHotkey) desktop.onHotkey((what) => {
  if (!V.channelId) return;
  if (what === 'mute') toggleMute(); else if (what === 'deafen') toggleDeafen(); else if (String(what).startsWith('sound:')) playSoundKey(String(what).slice(6));
});
if (desktop && desktop.onPtt) desktop.onPtt((held) => { if (settings.ptt && V.channelId) Voice.setPtt(held); });

/* Quiet in voice: muted or deafened for 30 minutes, or silent and not touching Party Line for 15. With an AFK
   channel set for the server, you're moved there and muted; without one, muted people leave voice (silent
   unmuted people stay). A warning shows 5 minutes before. Sharing your screen pauses it, and so does listening or
   watching together or watching someone's screen (you're there, just quiet). In the AFK channel itself nothing
   happens: that's where quiet people are meant to stay. */
let lastSpoke = Date.now();
function afkChannelFor(chId) { const f = findChannel(chId); return f && f.server.afkChannelId && f.server.afkChannelId !== chId ? f.server.afkChannelId : null; }
setInterval(() => {
  const bar = $('#afkBar');
  if (V.speaking.has(S.me && S.me.id)) lastSpoke = Date.now();
  // Paused: the clocks restart, so coming back from the AFK channel (still muted) or ending a long share or video
  // doesn't count the paused time and move you away at once.
  const here = V.channelId && findChannel(V.channelId);
  const paused = !!V.channelId && (V.sharing || musicPlaying() || !!(S.watching && S.view.kind === 'voice' && S.view.channelId === V.channelId)
    || !!(here && here.server.afkChannelId === V.channelId));
  if (paused) { lastSpoke = Date.now(); if (S.mutedSince) S.mutedSince = Date.now(); }
  if (!V.channelId || paused) { bar.hidden = true; return; }
  const afk = afkChannelFor(V.channelId);
  const mutedLeft = (V.muted || V.deafened) && S.mutedSince ? (window.PL_MUTED_MS || 30 * 60_000) - (Date.now() - S.mutedSince) : Infinity;
  const quietLeft = afk && !(V.muted || V.deafened) ? (window.PL_QUIET_MS || 15 * 60_000) - (Date.now() - Math.max(lastSpoke, lastInput, V.joinedAt || 0)) : Infinity;
  const left = Math.min(mutedLeft, quietLeft);
  if (left <= 0) {
    bar.hidden = true;
    if (afk) {
      const why = quietLeft <= 0 ? 'quiet for 15 minutes' : 'muted for 30 minutes';
      S.mutedSince = 0; lastSpoke = Date.now();
      joinVoice(afk).then(() => { if (!V.muted) toggleMute(); toast(`You were ${why}, so you were moved to the AFK channel. Click another voice channel to come back.`, 7000); });
    } else { Voice.leaveVoice(); S.mutedSince = 0; toast('You were muted for 30 minutes, so you left voice.', 6000); renderVoiceBits(); }
    return;
  }
  if (left > 5 * 60_000) { bar.hidden = true; return; }
  const m = Math.floor(left / 60000), sec = Math.floor((left % 60000) / 1000);
  const what = left === quietLeft ? 'quiet' : V.deafened ? 'deafened' : 'muted';
  $('#afkText').innerHTML = `You’ve been ${what} a while. ${afk ? 'Moving you to the AFK channel' : 'Leaving voice'} in <b>${m}:${String(sec).padStart(2, '0')}</b>.`;
  $('#afkUnmute').textContent = what === 'quiet' ? 'I’m here' : 'Unmute';
  bar.hidden = false;
}, 1000);
$('#afkUnmute').addEventListener('click', () => {
  lastSpoke = Date.now();
  if (V.muted || V.deafened) { if (V.deafened) Voice.setDeafened(false); Voice.setMuted(false); S.mutedSince = 0; renderVoiceBits(); }
});

/* Voice channel status (shown under the channel's name until everyone leaves) */
live.on('voice.status', (d) => { if (d.status) S.voiceStatus.set(d.channelId, d.status); else S.voiceStatus.delete(d.channelId); renderSide(); if (S.view.kind === 'voice') renderVoiceView(); });
$('#vcStatusEdit').addEventListener('click', async () => {
  const chId = S.view.channelId, cur = S.voiceStatus.get(chId);
  const text = await confirmBox('Voice channel status', 'A short line everyone sees under the channel’s name, like “ranked Valorant 🔥” or “just chilling”. Leave it empty to clear it. It goes away when everyone leaves.', 'Save', cur ? cur.text : '', 60);
  if (text === false) return;
  act(() => live.req('voice.status', { channelId: chId, text }));
});

/* Server menu → AFK channel */
$('#mAfk').addEventListener('click', () => {
  closeMenu();
  const srv = curServer(); if (!srv) return;
  const sel = $('#afkSelect');
  sel.innerHTML = '<option value="">Nowhere (off)</option>';
  for (const c of srv.channels.filter((x) => x.kind === 'voice')) { const o = document.createElement('option'); o.value = c.id; o.textContent = `🔊 ${c.name}`; sel.appendChild(o); }
  sel.value = srv.afkChannelId ? String(srv.afkChannelId) : '';
  $('#afkDlg').showModal();
});
$('#afkSave').addEventListener('click', async () => {
  const srv = curServer();
  if (await act(() => live.req('server.afk', { id: srv.id, channelId: Number($('#afkSelect').value) || null }), 'Saved.')) $('#afkDlg').close();
});

/* Go Live preview: while you share your screen, a small snapshot goes out every 15 s; others hover the LIVE badge
   to peek before joining. */
let previewTimer = null;
function syncPreview() {
  const on = V.sharing && V.screenStream;
  if (!on) { clearInterval(previewTimer); previewTimer = null; return; }
  if (previewTimer) return;
  const snap = async () => {
    const track = V.screenStream && V.screenStream.getVideoTracks()[0];
    if (!track || !live.open) return;
    const v = document.createElement('video'); v.muted = true; v.srcObject = new MediaStream([track]);
    try { await v.play(); } catch { return; }
    await new Promise((r) => (v.videoWidth ? r() : v.addEventListener('loadeddata', r, { once: true })));
    const w = 320, h = Math.round(w * (v.videoHeight / v.videoWidth || 9 / 16));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(v, 0, 0, w, h);
    v.srcObject = null;
    live.req('voice.preview', { img: c.toDataURL('image/jpeg', 0.6) }).catch(() => {});
  };
  setTimeout(snap, 1500);
  previewTimer = setInterval(snap, 15_000);
}
live.on('voice.preview', (d) => { if (d.img) S.previews.set(d.userId, d.img); else S.previews.delete(d.userId); });
function peekOn(el, userId) {
  const show = () => {
    const img = S.previews.get(userId), box = $('#livePeek');
    $('#livePeekImg').hidden = !img; if (img) $('#livePeekImg').src = img;
    $('#livePeekText').textContent = `${nameOf(userId)} is sharing their screen${img ? '' : ' (preview coming)'} · click the channel to watch`;
    box.hidden = false;
    const r = el.getBoundingClientRect();
    box.style.left = `${Math.min(innerWidth - box.offsetWidth - 8, r.right + 8)}px`;
    box.style.top = `${Math.max(8, Math.min(innerHeight - box.offsetHeight - 8, r.top - 20))}px`;
  };
  const hide = () => { $('#livePeek').hidden = true; };
  el.addEventListener('mouseenter', show); el.addEventListener('mouseleave', hide);
  el.addEventListener('focus', show); el.addEventListener('blur', hide);
}

/* ---------- meters ---------- */
/* The mic level bars run only while the mic check or Settings shows them (every frame otherwise keeps the computer
   from resting). */
let meterRaf = 0;
function meterLoop() {
  meterRaf = 0;
  if ($('#micPanel').hidden && !$('#settings').open) return;
  const lv = Voice.localMeter.analyser ? Math.min(100, level(Voice.localMeter.analyser) * 400) : 0;
  for (const i of document.querySelectorAll('#micPanel .meter i, #settings .level .meter i')) i.style.width = `${lv}%`;
  meterRaf = requestAnimationFrame(meterLoop);
}
function startMeter() { if (!meterRaf) meterRaf = requestAnimationFrame(meterLoop); }

/* ================= person pop-up ================= */
function openUserPop(id, anchor) {
  const pop = $('#userPop');
  if (!pop.hidden && S.popUser === id) { closeUserPop(); return; }
  S.popUser = id; S.popServer = S.view.serverId || null;
  const isMe = id === S.me.id;
  fillUserPop(id);
  const vst = S.voice.get(id);
  const sameVoice = !isMe && V.channelId && vst && vst.channelId === V.channelId;
  $('#popVolBox').hidden = !sameVoice;
  if (sameVoice) {
    const pref = Voice.peerPrefs(id);
    $('#volRange').value = Math.round(clampLevel(pref.vol) * 100);
    $('#volOut').textContent = `${$('#volRange').value}%`;
    $('#volMute').checked = !!pref.mute;
  }
  const isBot = !!user(id).bot;
  $('#popMsg').hidden = isMe || isBot;
  const fs = S.friends.get(id);
  const fb = $('#popFriend');
  fb.hidden = isMe || isBot || fs === 'friends';
  fb.disabled = fs === 'outgoing';
  fb.lastChild.textContent = fs === 'incoming' ? 'Accept request' : fs === 'outgoing' ? 'Request sent' : 'Add friend';
  const srv = S.popServer && S.servers.get(S.popServer);
  const canVoice = !isMe && srv && can(srv, 'voice'), canKick = !isMe && srv && can(srv, 'kick');
  const admin = !isBot && (canVoice || canKick || (!isMe && S.me.admin));
  $('#popAdmin').hidden = !admin;
  if (admin) {
    const inSrvVoice = canVoice && vst && srv.channels.some((c) => c.id === vst.channelId);
    $('#admVoiceKick').hidden = !inSrvVoice; $('#admMute').hidden = !inSrvVoice;
    $('#admMute').textContent = vst && vst.serverMuted ? 'Unmute for everyone' : 'Mute for everyone';
    $('#admKick').hidden = !canKick || (srv.isDefault && !S.me.admin);
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
/* The top of the person pop-up: banner, picture, status, custom status, game and About me. */
function fillUserPop(id) {
  const u = user(id), isMe = id === S.me.id;
  paintAv($('#popAv'), id);
  $('#popDot').className = 'status-dot ' + statusOf(id);
  $('#popBanner').style.background = u.banner || `hsl(${hue(u.name)} 45% 45%)`;
  $('#popBanner').className = 'pop-banner' + (u.bannerFx ? ` fx-${u.bannerFx}` : '');
  nameInto($('#popName'), id, S.popServer && S.servers.get(S.popServer), nameOf(id) + (isMe ? ' (you)' : '')); addCrown($('#popName'), id);
  $('#popPresence').textContent = u.bot ? 'Bot' : STATUS_TEXT[statusOf(id)];
  $('#popCustom').hidden = !u.custom; $('#popCustom').textContent = u.custom || '';
  $('#popActivity').hidden = !(u.online && u.activity); $('#popActivity').textContent = u.activity ? `🎮 Playing ${u.activity}` : '';
  $('#popBioBox').hidden = !u.bio; $('#popBio').textContent = u.bio || '';
  const games = u.favGames || [];
  $('#popGamesBox').hidden = !games.length; $('#popGames').textContent = '';
  for (const g of games) { const chip = document.createElement('span'); chip.className = 'game-chip'; chip.textContent = `🎮 ${g}`; $('#popGames').appendChild(chip); }
  $('#popBdayBox').hidden = !u.birthday; $('#popBday').textContent = u.birthday ? `${fmtBirthday(u.birthday)}${isBirthday(u.id) ? ' · today! 🎉' : ''}` : '';
  const srv = S.popServer && S.servers.get(S.popServer), roles = rolesOf(srv, id), box = $('#popRoles');
  box.textContent = ''; box.hidden = !roles.length;
  for (const r of roles) { const chip = document.createElement('span'); chip.className = 'role-chip'; chip.style.setProperty('--rc', r.color || 'var(--dim)'); chip.textContent = r.name; box.appendChild(chip); }
  $('#popLevel').hidden = !!u.bot;
  $('#popStreak').hidden = !u.streak; $('#popStreak').textContent = `🔥 ${u.streak}`; $('#popStreak').title = `${u.streak}-day streak`;
  const got = S.perks.achievements.filter((a) => (u.badges || {})[a.key]);
  $('#popBadges').hidden = !got.length; $('#popBadges').textContent = '';
  for (const a of got) { const c = document.createElement('span'); c.className = 'badge-chip'; c.textContent = a.emoji; c.title = `${a.name}: ${a.how}`; c.setAttribute('aria-label', a.name); $('#popBadges').appendChild(c); }
  if (!u.bot) {
    const b = levelBits(u.xp || 0);
    $('#popLevelText').textContent = `Level ${b.level}`; $('#popLevelXp').textContent = `${b.into} / ${b.need} XP to level ${b.level + 1}`;
    $('#popLevelBar').style.width = `${b.pct}%`;
  }
  const pop = $('#userPop');   // keep it on screen if it grew
  if (!pop.hidden) { const r = pop.getBoundingClientRect(); if (r.bottom > innerHeight - 8) pop.style.top = `${Math.max(8, innerHeight - r.height - 8)}px`; }
}
function closeUserPop() { $('#userPop').hidden = true; S.popUser = null; }

/* ---------- your status ---------- */
function openStatusPop() {
  const pop = $('#statusPop');
  for (const b of pop.querySelectorAll('[data-status]')) b.setAttribute('aria-checked', String(b.dataset.status === (S.me.status || 'online')));
  $('#customInput').value = S.me.custom || '';
  pop.hidden = false;
  const r = $('#statusBtn').getBoundingClientRect();
  pop.style.left = `${Math.max(8, r.left)}px`;
  pop.style.top = `${Math.max(8, r.top - pop.offsetHeight - 8)}px`;
  $('#statusBtn').setAttribute('aria-expanded', 'true');
}
function closeStatusPop() { $('#statusPop').hidden = true; $('#statusBtn').setAttribute('aria-expanded', 'false'); }
$('#statusBtn').addEventListener('click', () => ($('#statusPop').hidden ? openStatusPop() : closeStatusPop()));
document.addEventListener('pointerdown', (e) => { if (!$('#statusPop').hidden && !e.target.closest('#statusPop, #statusBtn')) closeStatusPop(); });
for (const b of document.querySelectorAll('#statusPop [data-status]')) {
  b.addEventListener('click', () => { act(() => live.req('profile.set', { status: b.dataset.status })); closeStatusPop(); });
}
$('#customForm').addEventListener('submit', (e) => { e.preventDefault(); act(() => live.req('profile.set', { custom: $('#customInput').value })); closeStatusPop(); });
$('#customClear').addEventListener('click', () => { act(() => live.req('profile.set', { custom: '' })); closeStatusPop(); });

/* Idle by itself: nothing touched for 10 minutes (or the app hidden that long). */
let lastInput = Date.now(), sentIdle = false;
for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) addEventListener(ev, () => { lastInput = Date.now(); if (sentIdle) checkIdle(); }, { passive: true, capture: true });
addEventListener('pointermove', () => { lastInput = Date.now(); }, { passive: true });
function checkIdle() {
  const idle = Date.now() - lastInput > (window.PL_IDLE_MS || 600_000);
  if (idle !== sentIdle && live.open) { sentIdle = idle; live.req('presence.idle', { idle }).catch(() => {}); }
}
setInterval(checkIdle, Math.min(15_000, window.PL_IDLE_MS || 15_000));
/* The desktop app tells us which game is running ("Playing …"). */
let myActivity = null;
if (desktop && desktop.onActivity) desktop.onActivity((name) => { myActivity = name || null; if (live.open) live.req('presence.activity', { name: myActivity }).catch(() => {}); });
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

$('#admReset').addEventListener('click', () => { const id = S.popUser; closeUserPop(); resetPassword(id); });
async function resetPassword(id, name) {
  if (name && !S.users.has(id)) S.users.set(id, { id, name, avatar: null, online: false });
  if (!await confirmBox(`Reset ${nameOf(id)}'s password?`, 'They’re signed out everywhere and get a temporary password from you. They can change it in Settings.', 'Reset')) return;
  const r = await act(() => live.req('admin.resetPassword', { userId: id }));
  if (r) await confirmBox(`New password for ${r.name}`, 'Send this to them privately. They sign in with it, then change it in Settings → Change password.', 'Done', r.password);
}

/* ================= search ================= */
const searchScope = () => (S.view.serverId ? S.view.serverId : -1);
/* The search panel also lists pinned messages (the 📌 button). */
function openSearch() {
  $('#searchForm').hidden = false;
  const s = curServer();
  $('#searchNote').textContent = s ? `Searching messages in ${s.name}.` : 'Searching your private chats.';
  $('#searchResults').textContent = '';
  $('#searchPanel').hidden = false;
  $('#searchInput').focus(); $('#searchInput').select();
}
function closeSearch() { $('#searchPanel').hidden = true; S.savedOpen = false; }
$('#searchBtn').addEventListener('click', () => ($('#searchPanel').hidden ? openSearch() : closeSearch()));
$('#searchClose').addEventListener('click', closeSearch);
$('#searchInput').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeSearch(); } });
document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && S.ready) { e.preventDefault(); openSearch(); } });
$('#searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#searchInput').value.trim();
  if (q.length < 2) { $('#searchNote').textContent = 'Type at least 2 letters.'; return; }
  $('#searchNote').textContent = 'Searching…';
  let res;
  try { res = (await api(`/api/search?q=${encodeURIComponent(q)}&serverId=${searchScope()}`)).messages; }
  catch (ex) { $('#searchNote').textContent = ex.message; return; }
  $('#searchNote').textContent = res.length ? `${res.length === 50 ? '50+' : res.length} result${res.length === 1 ? '' : 's'}. Click one to jump to it.` : `Nothing found for “${q}”.`;
  renderHits(res);
});
async function openPins() {
  S.savedOpen = false;
  const target = S.view.kind === 'dm' ? `userId=${S.view.userId}` : `channelId=${S.view.channelId}`;
  $('#searchForm').hidden = true;
  $('#searchNote').textContent = 'Loading pinned messages…';
  $('#searchResults').textContent = '';
  $('#searchPanel').hidden = false;
  let res;
  try { res = (await api(`/api/pins?${target}`)).messages; }
  catch (ex) { $('#searchNote').textContent = ex.message; return; }
  $('#searchNote').textContent = res.length ? `📌 ${res.length} pinned message${res.length === 1 ? '' : 's'}. Click one to jump to it.` : '📌 Nothing pinned here yet. Point at a message and press the pin button to pin it.';
  renderHits(res);
}
$('#pinsBtn').addEventListener('click', () => ($('#searchPanel').hidden || !$('#searchForm').hidden ? openPins() : closeSearch()));
function renderHits(res) {
  const ol = $('#searchResults');
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
}

/* ================= ⋯ on phones: the header buttons that don't fit (each item just presses the real button) ================= */
function closeMore() { $('#moreMenu').hidden = true; $('#moreBtn').setAttribute('aria-expanded', 'false'); }
$('#moreBtn').addEventListener('click', () => {
  const m = $('#moreMenu');
  if (!m.hidden) { closeMore(); return; }
  for (const b of m.querySelectorAll('[data-proxy]')) {
    const real = $(`#${b.dataset.proxy}`);
    b.hidden = real.hidden;
    const pill = real.querySelector('.count-pill:not([hidden])');
    b.dataset.count = pill ? pill.textContent : '';
  }
  m.hidden = false; $('#moreBtn').setAttribute('aria-expanded', 'true');
});
$('#moreMenu').addEventListener('click', (e) => { const b = e.target.closest('[data-proxy]'); if (!b) return; closeMore(); $(`#${b.dataset.proxy}`).click(); });
document.addEventListener('pointerdown', (e) => { if (!$('#moreMenu').hidden && !e.target.closest('#moreMenu, #moreBtn')) closeMore(); });

/* ================= XP and levels (one total per person for the whole app; the server adds it, see M.addXp) ================= */
const xpLevel = (xp) => Math.floor(Math.sqrt((xp || 0) / 30));
function levelBits(xp) {
  const level = xpLevel(xp), from = 30 * level ** 2, to = 30 * (level + 1) ** 2;
  return { level, into: xp - from, need: to - from, pct: Math.round(((xp - from) / (to - from)) * 100) };
}
live.on('xp', (d) => {
  const u = S.users.get(d.userId);
  if (!u) return;
  const before = xpLevel(u.xp);
  u.xp = d.xp;
  if (d.userId === S.me.id) { S.me.xp = d.xp; if (xpLevel(d.xp) > before) toast(`🎉 You reached level ${xpLevel(d.xp)}!`, 4000); }
  if (S.popUser === d.userId) fillUserPop(d.userId);
  if ($('#topDlg').open) { renderTop(); if (!$('#topAch').hidden) renderAchievements(); }
});
/* Everyone you know in Party Line, most XP first. */
function renderTop() {
  const list = $('#topList'), medals = ['🥇', '🥈', '🥉'];
  list.textContent = '';
  const rows = [...S.users.values()].filter((u) => !u.bot).map((u) => [u.id, u.xp || 0])
    .sort((a, b) => b[1] - a[1] || nameOf(a[0]).localeCompare(nameOf(b[0])));
  rows.forEach(([id, xp], i) => {
    const b = levelBits(xp), li = document.createElement('li');
    li.className = 'top-row' + (id === S.me.id ? ' me' : '');
    const place = document.createElement('span'); place.className = 'top-place'; place.textContent = xp && medals[i] ? medals[i] : String(i + 1);
    const who = document.createElement('div'); who.className = 'top-who';
    const nm = document.createElement('b'); nameInto(nm, id, null, nameOf(id) + (id === S.me.id ? ' (you)' : ''));
    const streak = user(id).streak;
    if (streak) { const f = document.createElement('span'); f.className = 'top-streak'; f.textContent = `🔥 ${streak}`; f.title = `${streak}-day streak`; nm.appendChild(f); }
    const bar = document.createElement('div'); bar.className = 'xp-bar'; bar.title = `${b.into} / ${b.need} XP to level ${b.level + 1}`;
    const fill = document.createElement('span'); fill.style.width = `${b.pct}%`; bar.appendChild(fill);
    who.append(nm, bar);
    const lv = document.createElement('span'); lv.className = 'top-level';
    const n = document.createElement('b'); n.textContent = `Lv ${b.level}`;
    const x = document.createElement('small'); x.textContent = `${xp} XP`;
    lv.append(n, x);
    li.append(place, avEl(id), who, lv);
    list.appendChild(li);
  });
}
/* Your achievements (the ones you don't have yet say how to get them) and what each level unlocks. */
function renderAchievements() {
  const mine = S.me.badges || {}, list = S.perks.achievements, grid = $('#achGrid');
  $('#achCount').textContent = `You have ${list.filter((a) => mine[a.key]).length} of ${list.length}. Everyone sees yours on your profile.`;
  grid.textContent = '';
  for (const a of list) {
    const li = document.createElement('li'); li.className = 'ach' + (mine[a.key] ? ' got' : '');
    const e = document.createElement('span'); e.className = 'ach-emoji'; e.textContent = mine[a.key] ? a.emoji : '🔒';
    const t = document.createElement('div');
    const n = document.createElement('b'); n.textContent = a.name;
    const h = document.createElement('small'); h.textContent = mine[a.key] ? `${a.how} Unlocked ${fmtDay(mine[a.key])}.` : a.how;
    t.append(n, h); li.append(e, t); grid.appendChild(li);
  }
  const lvl = xpLevel(S.me.xp), u = S.perks.unlocks, rewards = [
    [u.nameColor, '🎨', 'Name colors', 'Settings → Profile → Name color'],
    [u.flair.galaxy, '🌌', 'Galaxy picture ring and Matrix banner', 'Settings → Profile'],
    [u.flair.plasma, '⚡', 'Plasma picture ring', 'Settings → Profile'],
    [u.legend, '✨', 'Shimmering Legend name', 'Shows by itself everywhere'],
  ];
  const rl = $('#rewardList'); rl.textContent = '';
  for (const [at, emoji, what, where] of rewards) {
    const li = document.createElement('li'); li.className = 'reward' + (lvl >= at ? ' got' : '');
    li.textContent = `${lvl >= at ? emoji : '🔒'} Level ${at}: ${what}`;
    const sm = document.createElement('small'); sm.textContent = lvl >= at ? where : `${30 * at * at - (S.me.xp || 0)} XP to go`;
    li.appendChild(sm); rl.appendChild(li);
  }
}
function showTopTab(name) {
  for (const t of document.querySelectorAll('[data-toptab]')) t.setAttribute('aria-selected', String(t.dataset.toptab === name));
  $('#topBoard').hidden = name !== 'board'; $('#topAch').hidden = name !== 'ach';
  if (name === 'ach') renderAchievements();
}
document.querySelectorAll('[data-toptab]').forEach((t) => t.addEventListener('click', () => showTopTab(t.dataset.toptab)));
live.on('achievement', (d) => {
  for (const key of d.keys) {
    const a = S.perks.achievements.find((x) => x.key === key);
    if (a) toast(`🏆 Achievement unlocked: ${a.emoji} ${a.name}`, 5000, { label: 'See all', fn: () => { openTop(); showTopTab('ach'); } });
  }
});
function openTop() { closeMenu(); renderTop(); showTopTab('board'); $('#topDlg').showModal(); }
$('#mTop').addEventListener('click', openTop);
$('#navTop').addEventListener('click', () => { openTop(); $('#room').classList.remove('drawer-open'); $('#drawerScrim').hidden = true; });

/* ================= looking for group (see M.createLfg) ================= */
const lfgWhen = (l) => !l.at ? 'now' : l.at < Date.now() ? `started ${fmtTime(l.at)}` : `at ${new Date(l.at).toDateString() === new Date().toDateString() ? '' : fmtDay(l.at) + ' '}${fmtTime(l.at)}`;
function lfgEl(msg) {
  const l = msg.lfg, card = document.createElement('div'); card.className = 'lfg-card';
  if (!l) { card.textContent = '(this group post was removed)'; card.classList.add('gone'); return card; }
  card.classList.toggle('closed', l.closed); card.classList.toggle('full', l.full && !l.closed);
  const head = document.createElement('div'); head.className = 'lfg-head';
  const g = document.createElement('b'); g.textContent = `🎮 ${l.game}`;
  const st = document.createElement('span'); st.className = 'lfg-state';
  const left = l.need - l.members.length;
  st.textContent = l.closed ? (l.expired ? 'Expired' : 'Closed') : l.full ? 'Full' : `Need ${left} more`;
  head.append(g, st);
  const sub = document.createElement('div'); sub.className = 'lfg-sub'; sub.textContent = [lfgWhen(l), l.note].filter(Boolean).join(' · ');
  const people = document.createElement('div'); people.className = 'lfg-people';
  for (const id of [l.by, ...l.members]) { const a = avEl(id); a.title = nameOf(id) + (id === l.by ? ' (posted it)' : ''); a.style.cursor = 'pointer'; a.addEventListener('click', (e) => openUserPop(id, e.currentTarget)); people.appendChild(a); }
  for (let i = 0; i < Math.max(0, left); i++) { const e = document.createElement('span'); e.className = 'lfg-slot'; e.setAttribute('aria-hidden', 'true'); people.appendChild(e); }
  card.append(head, sub, people);
  const btns = document.createElement('div'); btns.className = 'lfg-btns';
  const mine = l.by === S.me.id, joined = l.members.includes(S.me.id), f = msg.channelId && findChannel(msg.channelId);
  const button = (label, cls, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = `btn small ${cls}`; b.textContent = label; b.addEventListener('click', fn); btns.appendChild(b); };
  if (!l.closed && !mine && !joined && !l.full) button('Join', 'primary', () => act(() => live.req('lfg.join', { id: l.id, on: true }), 'You’re in!'));
  if (!l.closed && joined) button('Leave', '', () => act(() => live.req('lfg.join', { id: l.id, on: false })));
  const hv = S.voice.get(l.by), hf = hv && findChannel(hv.channelId);
  if (!l.closed && hf && f && hf.server.id === f.server.id && V.channelId !== hv.channelId && (joined || mine || !l.full)) button(`Join 🔊 ${hf.channel.name}`, '', () => { setView({ kind: 'voice', serverId: hf.server.id, channelId: hf.channel.id }); joinVoice(hf.channel.id); });
  if (!l.closed && (mine || (f && can(f.server, 'messages')))) button('Close', 'ghost', () => act(() => live.req('lfg.close', { id: l.id })));
  if (btns.childNodes.length) card.appendChild(btns);
  return card;
}
live.on('lfg', (d) => {
  const key = `c:${d.channelId}`, m = S.msgs.get(key), msg = m && m.list.find((x) => x.id === d.messageId);
  if (msg) { msg.lfg = d.lfg; rerenderOne(key, msg.id); }
  if (S.view.kind === 'home') loadDashLfg();
});
function openLfgBuilder() {
  if (S.view.kind !== 'text') return;
  const names = new Set([...(S.me.favGames || []), ...[...S.users.values()].flatMap((u) => u.favGames || []), ...(S.games.get(msgKey()) || []).map((g) => g.name)]);
  const dl = $('#lfgGames'); dl.textContent = '';
  for (const n of names) { const o = document.createElement('option'); o.value = n; dl.appendChild(o); }
  $('#lfgGame').value = ''; $('#lfgNeed').value = '2'; $('#lfgWhen').value = 'now'; $('#lfgAt').hidden = true; $('#lfgNote').value = '';
  $('#lfgDlg').showModal(); $('#lfgGame').focus();
}
$('#lfgWhen').addEventListener('change', () => {
  const pick = $('#lfgWhen').value === 'pick';
  $('#lfgAt').hidden = !pick;
  if (pick && !$('#lfgAt').value) $('#lfgAt').value = localInput(atTime(0, 21) > Date.now() ? atTime(0, 21) : atTime(1, 21));
});
$('#lfgForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const w = $('#lfgWhen').value, at = w === 'now' ? null : w === 'pick' ? new Date($('#lfgAt').value).getTime() : Date.now() + Number(w) * 60_000;
  const r = await act(() => live.req('lfg.create', { channelId: S.view.channelId, game: $('#lfgGame').value, need: Number($('#lfgNeed').value), at, note: $('#lfgNote').value }));
  if (r) $('#lfgDlg').close();
});

/* ================= Home dashboard: who's in voice, who's playing, open groups, what's coming up ================= */
async function loadDashLfg() {
  try { S.dashLfg = (await live.req('lfg.list', {})).list || []; } catch { S.dashLfg = S.dashLfg || []; }
  if (S.view.kind === 'home') renderDash();
}
function dashItem(list, parts, onClick) {
  const li = document.createElement('li'); li.className = 'dash-item';
  for (const p of parts) if (p) li.appendChild(p);
  if (onClick) { li.classList.add('click'); li.tabIndex = 0; li.addEventListener('click', (e) => { if (!e.target.closest('button')) onClick(); }); li.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.target.closest('button')) onClick(); }); }
  list.appendChild(li);
  return li;
}
const dashText = (title, sub) => { const d = document.createElement('div'); d.className = 'dash-text'; const b = document.createElement('b'); b.textContent = title; d.appendChild(b); if (sub) { const s = document.createElement('small'); s.textContent = sub; d.appendChild(s); } return d; };
const dashBtn = (label, fn, cls = '') => { const b = document.createElement('button'); b.type = 'button'; b.className = `btn small ${cls}`; b.textContent = label; b.addEventListener('click', fn); return b; };
const dashEmpty = (list, text) => { const li = document.createElement('li'); li.className = 'dash-empty'; li.textContent = text; list.appendChild(li); };
function renderDash() {
  if (!S.me) return;
  const me = user(S.me.id), b = levelBits(me.xp || 0), got = S.perks.achievements.filter((a) => (me.badges || {})[a.key]).length;
  const top = $('#dashMe'); top.textContent = '';
  const av = avEl(S.me.id, 'avatar');
  const hi = document.createElement('div'); hi.className = 'dash-hi';
  const h = document.createElement('h2'); h.textContent = `Hi ${nameOf(S.me.id)} 👋`;
  const stats = document.createElement('div'); stats.className = 'dash-stats';
  stats.textContent = [`Level ${b.level}`, `${b.need - b.into} XP to level ${b.level + 1}`, me.streak ? `🔥 ${me.streak}-day streak` : 'Chat or join voice today to start a 🔥 streak', `🏆 ${got} of ${S.perks.achievements.length}`].join(' · ');
  const bar = document.createElement('div'); bar.className = 'xp-bar'; const fill = document.createElement('span'); fill.style.width = `${b.pct}%`; bar.appendChild(fill);
  hi.append(h, stats, bar);
  const bdays = [...S.users.values()].filter((u) => !u.bot && isBirthday(u.id));
  if (bdays.length) { const p = document.createElement('p'); p.className = 'dash-bday'; p.textContent = `🎂 Today is ${bdays.map((u) => u.id === S.me.id ? 'your' : `${u.name}’s`).join(' and ')} birthday!`; hi.appendChild(p); }
  top.append(av, hi, dashBtn('Leaderboard', openTop));

  const vl = $('#dashVoice'); vl.textContent = '';
  for (const s of S.servers.values()) {
    if (s.kind === 'pair') continue;
    for (const c of s.channels.filter((x) => x.kind === 'voice')) {
      const people = voiceIn(c.id);
      if (!people.length) continue;
      const avs = document.createElement('div'); avs.className = 'dash-avs';
      for (const p of people.slice(0, 6)) avs.appendChild(avEl(p.userId));
      if (people.length > 6) { const more = document.createElement('span'); more.className = 'dash-more'; more.textContent = `+${people.length - 6}`; avs.appendChild(more); }
      const live2 = people.some((p) => p.sharing) ? Object.assign(document.createElement('span'), { className: 'live', textContent: 'LIVE' }) : null;
      const here = V.channelId === c.id;
      const open = () => setView({ kind: 'voice', serverId: s.id, channelId: c.id });
      dashItem(vl, [dashText(isPrivate(s) ? groupName(s) : `🔊 ${c.name}`, isPrivate(s) ? 'Group call' : s.name), live2, avs,
        here ? Object.assign(document.createElement('small'), { className: 'dash-here', textContent: 'You’re here' }) : dashBtn('Join', () => { open(); joinVoice(c.id); }, 'primary')], open);
    }
  }
  if (!vl.childNodes.length) dashEmpty(vl, 'Nobody’s in voice right now. Hop into a voice channel and friends will see you here.');

  const pl = $('#dashPlaying'); pl.textContent = '';
  for (const u of [...S.users.values()].filter((x) => !x.bot && x.online && x.activity).sort((a, z) => a.name.localeCompare(z.name))) {
    const li = dashItem(pl, [avEl(u.id), dashText(u.id === S.me.id ? `${u.name} (you)` : u.name, `🎮 ${u.activity}`)], () => openUserPop(u.id, li));
  }
  if (!pl.childNodes.length) dashEmpty(pl, 'Nobody’s playing anything right now. The desktop app shows the game you’re in.');

  const ll = $('#dashLfg'); ll.textContent = '';
  for (const l of S.dashLfg || []) {
    const f = findChannel(l.channelId);
    if (!f) continue;
    const joined = l.members.includes(S.me.id), mine = l.by === S.me.id;
    const btn = mine ? null : joined ? dashBtn('Leave', () => act(() => live.req('lfg.join', { id: l.id, on: false })))
      : l.full ? null : dashBtn('Join', () => act(() => live.req('lfg.join', { id: l.id, on: true }), 'You’re in!'), 'primary');
    dashItem(ll, [avEl(l.by), dashText(`${l.game}: ${l.full ? 'full' : `need ${l.need - l.members.length} more`}`, `${nameOf(l.by)} · ${lfgWhen(l)} · ${isPrivate(f.server) ? groupName(f.server) : `#${f.channel.name}`}`), btn],
      () => jumpTo(`c:${l.channelId}`, l.messageId));
  }
  if (!ll.childNodes.length) dashEmpty(ll, 'No open groups. In a chat, press + then “Looking for group” to find players.');

  const el = $('#dashEvents'); el.textContent = '';
  const soon = [...S.servers.values()].filter((s) => !isPrivate(s)).flatMap((s) => upcoming(s.id).map((e) => ({ e, s })))
    .filter(({ e }) => e.startsAt < Date.now() + 14 * 86_400_000).sort((a, z) => a.e.startsAt - z.e.startsAt).slice(0, 6);
  for (const { e, s } of soon) {
    const going = (e.going || []).length;
    dashItem(el, [dashText(e.title, `${fmtWhen(e.startsAt)} · ${s.name}${going ? ` · ${going} going` : ''}`)], () => { openServer(s.id); openEvents(); });
  }
  if (!el.childNodes.length) dashEmpty(el, 'Nothing planned. Open Events at the top of a server to plan a game night.');
}

/* ================= polls ================= */
function pollEl(msg) {
  const p = msg.poll, card = document.createElement('div'); card.className = 'poll-card';
  if (!p) { card.textContent = '(this poll was removed)'; card.classList.add('gone'); return card; }
  const q = document.createElement('div'); q.className = 'poll-q'; q.innerHTML = iconSvg('poll'); q.appendChild(document.createTextNode(p.question)); card.appendChild(q);
  const total = p.options.reduce((n, o) => n + o.votes, 0), mine = p.mine || [], top = Math.max(...p.options.map((o) => o.votes));
  p.options.forEach((o, i) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'poll-opt' + (mine.includes(i) ? ' mine' : '') + (p.closed && o.votes === top && top ? ' won' : '');
    b.disabled = p.closed;
    const pct = total ? Math.round((o.votes / total) * 100) : 0;
    b.style.setProperty('--pct', `${pct}%`);
    const t = document.createElement('span'); t.className = 'poll-text'; t.textContent = `${mine.includes(i) ? '✓ ' : ''}${o.text}`;
    const n = document.createElement('span'); n.className = 'poll-num'; n.textContent = `${o.votes} · ${pct}%`;
    b.append(t, n);
    b.title = o.voters && o.voters.length ? `${o.voters.map(nameOf).join(', ')}` : p.anon ? 'Anonymous poll' : 'No votes yet';
    b.setAttribute('aria-pressed', String(mine.includes(i)));
    b.addEventListener('click', async () => {
      const r = await act(() => live.req('poll.vote', { id: p.id, option: i, on: !mine.includes(i) }));
      if (r) { p.mine = r.mine; }
    });
    card.appendChild(b);
  });
  const foot = document.createElement('div'); foot.className = 'poll-foot';
  foot.textContent = [`${p.people} ${p.people === 1 ? 'person' : 'people'} voted`, p.multi ? 'pick several' : null, p.anon ? 'anonymous' : null,
    p.closed ? 'final results' : p.endsAt ? `ends ${fmtRelative(p.endsAt)}` : null].filter(Boolean).join(' · ');
  const f = msg.channelId && findChannel(msg.channelId);
  if (!p.closed && (p.by === S.me.id || (f && can(f.server, 'messages')))) {
    const end = document.createElement('button'); end.type = 'button'; end.className = 'link-btn'; end.textContent = 'End poll';
    end.addEventListener('click', async () => { if (await confirmBox('End this poll now?', 'Voting stops and Party Bot posts the result.', 'End poll')) act(() => live.req('poll.end', { id: p.id })); });
    foot.appendChild(end);
  }
  card.appendChild(foot);
  return card;
}
live.on('poll', (d) => {
  const key = d.channelId ? `c:${d.channelId}` : dmKeyById(d.dmId);
  const m = key && S.msgs.get(key), msg = m && m.list.find((x) => x.id === d.messageId);
  if (!msg) return;
  msg.poll = d.poll;
  rerenderOne(key, msg.id);
});
function pollOptRow(value = '') {
  const row = document.createElement('div'); row.className = 'row poll-opt-row';
  const inp = document.createElement('input'); inp.className = 'input'; inp.maxLength = 80; inp.value = value; inp.placeholder = `Choice ${$('#pollOpts').children.length + 1}`;
  const x = document.createElement('button'); x.type = 'button'; x.className = 'btn icon-btn'; x.innerHTML = iconSvg('x'); x.setAttribute('aria-label', 'Remove this choice');
  x.addEventListener('click', () => { if ($('#pollOpts').children.length > 2) row.remove(); });
  row.append(inp, x);
  $('#pollOpts').appendChild(row);
  return inp;
}
function openPollBuilder() {
  if (!composeTarget()) return;
  $('#pollQ').value = ''; $('#pollOpts').textContent = ''; pollOptRow(); pollOptRow();
  $('#pollMulti').checked = false; $('#pollAnon').checked = false; $('#pollEnds').value = '1440';
  $('#pollDlg').showModal(); $('#pollQ').focus();
}
$('#pollAddOpt').addEventListener('click', () => { if ($('#pollOpts').children.length < 10) pollOptRow().focus(); else toast('Polls can have up to 10 choices.', 3000); });
$('#pollForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const options = [...$('#pollOpts').querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean);
  const r = await act(() => live.req('poll.create', Object.assign({ question: $('#pollQ').value, options, multi: $('#pollMulti').checked, anon: $('#pollAnon').checked, minutes: Number($('#pollEnds').value) }, composeTarget())));
  if (r) $('#pollDlg').close();
});

/* ================= remind me about this (a message) ================= */
let remindFor = null;
function placePop(pop, anchor) {
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.right - pop.offsetWidth))}px`;
  pop.style.top = `${r.bottom + 6 + pop.offsetHeight > innerHeight - 8 ? Math.max(8, r.top - pop.offsetHeight - 6) : r.bottom + 6}px`;
}
function openRemind(msg, anchor) {
  remindFor = msg.id;
  const box = $('#remindPresets'); box.textContent = '';
  for (const [label, at] of laterPresets()) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn small'; b.textContent = label;
    b.addEventListener('click', () => setRemind(at)); box.appendChild(b);
  }
  const d = new Date(Date.now() + 3600_000); d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
  $('#remindWhen').value = localInput(d.getTime());
  placePop($('#remindPop'), anchor);
}
async function setRemind(at) {
  if (await act(() => live.req('remind.set', { id: remindFor, at }), `Okay! Party Bot will remind you ${fmtWhen(at)}.`)) $('#remindPop').hidden = true;
}
$('#remindGo').addEventListener('click', () => { const at = new Date($('#remindWhen').value).getTime(); if (Number.isFinite(at)) setRemind(at); else toast('Pick a day and time.', 3000); });
document.addEventListener('pointerdown', (e) => {
  if (!$('#remindPop').hidden && !e.target.closest('#remindPop, .msg-tool')) $('#remindPop').hidden = true;
  if (!$('#disappearPop').hidden && !e.target.closest('#disappearPop, #disappearBtn')) $('#disappearPop').hidden = true;
});

/* ================= disappearing messages (private chats and group chats) ================= */
live.on('disappear', (d) => {
  const other = d.users.find((id) => id !== S.me.id);
  const x = S.dms.get(other) || { id: d.dmId, userId: other, unread: 0 };
  x.disappear = d.seconds; S.dms.set(other, x);
  renderHeader();
});
$('#disappearBtn').addEventListener('click', (e) => {
  const pop = $('#disappearPop');
  if (!pop.hidden) { pop.hidden = true; return; }
  const v = S.view, srv = v.kind === 'text' && S.servers.get(v.serverId);
  const cur = v.kind === 'dm' ? (S.dms.get(v.userId) || {}).disappear || 0 : (srv && srv.disappear) || 0;
  for (const b of pop.querySelectorAll('[data-secs]')) b.setAttribute('aria-checked', String(Number(b.dataset.secs) === cur));
  placePop(pop, e.currentTarget);
});
document.querySelectorAll('#disappearOpts [data-secs]').forEach((b) => b.addEventListener('click', async () => {
  const v = S.view, target = v.kind === 'dm' ? { userId: v.userId } : { serverId: v.serverId };
  if (await act(() => live.req('disappear.set', Object.assign({ seconds: Number(b.dataset.secs) }, target)))) $('#disappearPop').hidden = true;
}));

/* ================= saved messages (bookmarks) ================= */
live.on('bookmarks', (d) => {
  const was = S.bookmarks; S.bookmarks = new Set(d.ids);
  const key = msgKey();
  if (key) for (const id of new Set([...was, ...S.bookmarks])) if (was.has(id) !== S.bookmarks.has(id)) rerenderOne(key, id);
  if (S.savedOpen && !$('#searchPanel').hidden) openSaved();
});
async function openSaved() {
  S.savedOpen = true;
  $('#searchForm').hidden = true;
  $('#searchNote').textContent = 'Loading saved messages…';
  $('#searchResults').textContent = '';
  $('#searchPanel').hidden = false;
  let res;
  try { res = (await api('/api/bookmarks')).messages; } catch (ex) { $('#searchNote').textContent = ex.message; return; }
  $('#searchNote').textContent = res.length ? `🔖 ${res.length} saved message${res.length === 1 ? '' : 's'}, newest saved first. Only you see these. Click one to jump to it.` : '🔖 Nothing saved yet. Point at a message (or tap it on a phone) and press the bookmark button.';
  renderHits(res);
}
$('#navSaved').addEventListener('click', () => { if (!$('#searchPanel').hidden && S.savedOpen) { closeSearch(); return; } openSaved(); $('#room').classList.remove('drawer-open'); $('#drawerScrim').hidden = true; });

/* ================= send later ================= */
const laterKey = () => msgKey();
function loadLater() {
  const key = laterKey(), target = composeTarget();
  if (!key || !target) return renderLater();
  renderLater();
  live.req('later.list', target).then((r) => { S.later.set(key, r.list); if (laterKey() === key) renderLater(); }).catch(() => {});
}
live.on('later', (d) => {
  const key = d.channelId ? `c:${d.channelId}` : `d:${d.toUserId}`;
  S.later.set(key, d.list);
  if (laterKey() === key) renderLater();
});
live.on('later.failed', (d) => {
  toast(`A message you scheduled couldn’t be sent: ${d.error} It’s back in the message box if it was empty.`, 7000);
  if (!chatInput.value) { chatInput.value = d.body; autosize(); }
});
function renderLater() {
  const ul = $('#laterBar'), list = (laterKey() && S.later.get(laterKey())) || [];
  ul.textContent = ''; ul.hidden = !list.length;
  for (const x of list) {
    const li = document.createElement('li');
    const t = document.createElement('span'); t.className = 'later-when'; t.textContent = `🕒 ${fmtWhen(x.sendAt)}`;
    const b = document.createElement('span'); b.className = 'later-body'; b.textContent = decodeMentions(x.body);
    const c = document.createElement('button'); c.type = 'button'; c.className = 'reply-x'; c.innerHTML = iconSvg('x'); c.title = 'Don’t send it'; c.setAttribute('aria-label', 'Cancel this scheduled message');
    c.addEventListener('click', () => act(() => live.req('later.cancel', { id: x.id }), 'Cancelled.'));
    li.append(t, b, c); ul.appendChild(li);
  }
}
const atTime = (daysAhead, h, m = 0) => { const d = new Date(); d.setDate(d.getDate() + daysAhead); d.setHours(h, m, 0, 0); return d.getTime(); };
function laterPresets() {
  const now = Date.now(), tonight = atTime(0, 21);
  return [
    ['In 1 hour', now + 3600_000],
    tonight - now > 20 * 60_000 ? ['Tonight at 21:00', tonight] : ['Tomorrow at 21:00', atTime(1, 21)],
    ['Tomorrow at 09:00', atTime(1, 9)],
  ];
}
const localInput = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
function openLater() {
  const box = $('#laterPresets'); box.textContent = '';
  for (const [label, at] of laterPresets()) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn small'; b.textContent = label;
    b.addEventListener('click', () => scheduleMsg(at));
    box.appendChild(b);
  }
  const d = new Date(Date.now() + 3600_000); d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
  $('#laterWhen').value = localInput(d.getTime());
  $('#laterPop').hidden = false; $('#laterBtn').setAttribute('aria-expanded', 'true');
}
function closeLater() { $('#laterPop').hidden = true; $('#laterBtn').setAttribute('aria-expanded', 'false'); }
async function scheduleMsg(at) {
  const body = encodeEmoji(encodeMentions(chatInput.value.trim())), target = composeTarget();
  if (!body) { toast('Write the message first, then pick when to send it.', 3500); chatInput.focus(); return; }
  if (!target) return;
  if (await act(() => live.req('later.add', Object.assign({ body, sendAt: at }, target)), `Scheduled for ${fmtWhen(at)}.`)) {
    chatInput.value = ''; autosize(); closeLater();
  }
}
$('#laterBtn').addEventListener('click', () => ($('#laterPop').hidden ? openLater() : closeLater()));
$('#laterGo').addEventListener('click', () => { const at = new Date($('#laterWhen').value).getTime(); if (Number.isFinite(at)) scheduleMsg(at); else toast('Pick a day and time.', 3000); });
document.addEventListener('pointerdown', (e) => { if (!$('#laterPop').hidden && !e.target.closest('#laterPop, #laterBtn')) closeLater(); });

/* ================= quick switcher (Ctrl+P) ================= */
let jumpSel = 0, jumpItems = [];
function jumpCandidates() {
  const out = [];
  for (const s of S.servers.values()) {
    if (isPrivate(s)) {
      if (s.kind === 'group') { const t = groupText(s); if (t) out.push({ label: groupName(s), sub: 'Group chat', icon: 'users', unread: t.unread || 0, at: t.lastAt || 0, go: () => setView({ kind: 'text', serverId: s.id, channelId: t.id }) }); }
      continue;
    }
    for (const c of s.channels) {
      if (c.kind === 'text') out.push({ label: c.name, prefix: '#', sub: s.name, unread: c.unread || 0, at: c.lastAt || 0, go: () => setView({ kind: 'text', serverId: s.id, channelId: c.id }) });
      else out.push({ label: c.name, icon: 'volume', sub: `${s.name} · voice`, unread: 0, at: 0, go: () => { setView({ kind: 'voice', serverId: s.id, channelId: c.id }); if (V.channelId !== c.id) joinVoice(c.id); } });
    }
  }
  // Friends, people you've chatted with, and everyone you share a server with (you can message them too).
  const people = new Set([...S.dms.keys(), ...[...S.friends].filter(([, st]) => st === 'friends').map(([id]) => id),
    ...[...S.servers.values()].filter((x) => !isPrivate(x)).flatMap((x) => x.members || [])]);
  for (const id of people) {
    if (!S.users.has(id) || id === S.me.id || user(id).bot) continue;
    const dm = S.dms.get(id);
    out.push({ label: nameOf(id), prefix: '@', sub: 'Private chat', unread: dm ? dm.unread || 0 : 0, at: dm ? dm.lastAt || 0 : 0, user: id, go: () => setView({ kind: 'dm', userId: id }) });
  }
  return out;
}
function renderJump() {
  const q = $('#jumpInput').value.trim().toLowerCase().replace(/^[#@]/, '');
  const all = jumpCandidates();
  jumpItems = (q ? all.filter((x) => x.label.toLowerCase().includes(q))
    .sort((a, b) => (b.label.toLowerCase().startsWith(q) - a.label.toLowerCase().startsWith(q)) || (b.unread - a.unread) || (b.at - a.at))
    : all.sort((a, b) => (!!b.unread - !!a.unread) || (b.at - a.at))).slice(0, 12);
  jumpSel = Math.min(jumpSel, Math.max(0, jumpItems.length - 1));
  const ul = $('#jumpList'); ul.textContent = '';
  jumpItems.forEach((x, i) => {
    const li = document.createElement('li'); li.className = 'jump-item'; li.setAttribute('role', 'option'); li.setAttribute('aria-selected', String(i === jumpSel)); li.id = `jump-${i}`;
    if (x.user) li.appendChild(avEl(x.user)); else li.insertAdjacentHTML('beforeend', x.icon ? iconSvg(x.icon) : `<span class="glyph">${x.prefix}</span>`);
    const t = document.createElement('span'); t.className = 'jump-label'; t.textContent = x.label;
    const sub = document.createElement('small'); sub.textContent = x.sub;
    li.append(t, sub);
    if (x.unread) { const u = document.createElement('span'); u.className = 'count-pill'; u.textContent = x.unread > 99 ? '99+' : x.unread; li.appendChild(u); }
    li.addEventListener('mousemove', () => { if (jumpSel !== i) { jumpSel = i; renderJump(); } });
    li.addEventListener('click', () => goJump(i));
    ul.appendChild(li);
  });
  if (!jumpItems.length) { const li = document.createElement('li'); li.className = 'hint jump-empty'; li.textContent = 'Nothing matches.'; ul.appendChild(li); }
  $('#jumpInput').setAttribute('aria-activedescendant', jumpItems.length ? `jump-${jumpSel}` : '');
}
function goJump(i) { const x = jumpItems[i]; if (!x) return; $('#jumpDlg').close(); x.go(); $('#room').classList.remove('drawer-open'); $('#drawerScrim').hidden = true; }
function openJump() { if (!S.ready) return; closeMenu(); jumpSel = 0; $('#jumpInput').value = ''; renderJump(); if (!$('#jumpDlg').open) $('#jumpDlg').showModal(); $('#jumpInput').focus(); }
$('#jumpInput').addEventListener('input', () => { jumpSel = 0; renderJump(); });
$('#jumpInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); jumpSel = Math.min(jumpItems.length - 1, jumpSel + 1); renderJump(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); jumpSel = Math.max(0, jumpSel - 1); renderJump(); }
  else if (e.key === 'Enter') { e.preventDefault(); goJump(jumpSel); }
});
$('#jumpDlg').addEventListener('click', (e) => { if (e.target === e.currentTarget) $('#jumpDlg').close(); });
document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'p' && S.ready) { e.preventDefault(); openJump(); } });
$('#navJump').addEventListener('click', openJump);
$('#mJump').addEventListener('click', openJump);

/* ================= media gallery: everything shared in this chat ================= */
let galTab = 'media', galState = null;   // { key, target, items, before, loading }
function openGallery() {
  const target = S.view.kind === 'dm' ? `userId=${S.view.userId}` : `channelId=${S.view.channelId}`;
  galState = { key: msgKey(), target, items: [], before: null, loading: false };
  const f = S.view.kind === 'text' && findChannel(S.view.channelId);
  $('#galTitle').textContent = f ? `Media in #${f.channel.name}` : `Media with ${nameOf(S.view.userId)}`;
  showGalTab(galTab);
  $('#galleryDlg').showModal();
  loadGallery();
}
async function loadGallery() {
  const st = galState;
  if (!st || st.loading) return;
  st.loading = true; $('#galMore').disabled = true;
  if (!st.items.length) $('#galNote').textContent = 'Loading…';
  try {
    const r = await api(`/api/media?${st.target}${st.before ? `&before=${st.before}` : ''}`);
    if (st !== galState) return;
    st.items.push(...r.items); st.before = r.before;
    renderGallery();
  } catch (e) { $('#galNote').textContent = e.message; }
  finally { st.loading = false; $('#galMore').disabled = false; }
}
function showGalTab(tab) {
  galTab = tab;
  document.querySelectorAll('[data-gal]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.gal === tab)));
  $('#galGrid').hidden = tab !== 'media'; $('#galFiles').hidden = tab !== 'files';
  if (galState) renderGallery();
}
document.querySelectorAll('[data-gal]').forEach((t) => t.addEventListener('click', () => showGalTab(t.dataset.gal)));
$('#galMore').addEventListener('click', loadGallery);
$('#galleryBtn').addEventListener('click', openGallery);
function galJump(it) {
  const key = galState.key;
  $('#galleryDlg').close();
  jumpTo(key, it.messageId);
}
function renderGallery() {
  const st = galState, grid = $('#galGrid'), files = $('#galFiles');
  const media = st.items.filter((x) => x.kind === 'image' || x.kind === 'video' || x.kind === 'gif'), other = st.items.filter((x) => x.kind === 'file' || x.kind === 'audio');
  grid.textContent = ''; files.textContent = '';
  for (const it of media) {
    const cell = document.createElement('div'); cell.className = 'gal-cell';
    const b = document.createElement('button'); b.type = 'button'; b.className = 'gal-open'; b.title = `${it.name} · ${nameOf(it.userId)}, ${fmtDay(it.at)}`;
    if (it.kind === 'video') {
      const v = document.createElement('video'); v.src = `${absUrl(it.url)}#t=0.5`; v.preload = 'metadata'; v.muted = true; v.playsInline = true; b.appendChild(v);
      b.insertAdjacentHTML('beforeend', `<span class="gal-badge">${iconSvg('play')}</span>`);
    } else { const img = document.createElement('img'); img.src = absUrl(it.thumbUrl || it.url); img.alt = it.name; img.loading = 'lazy'; b.appendChild(img); if (it.kind === 'gif') b.insertAdjacentHTML('beforeend', '<span class="gal-badge">GIF</span>'); }
    b.addEventListener('click', () => openLightbox(absUrl(it.url), it.name, it.kind === 'video'));
    const j = document.createElement('button'); j.type = 'button'; j.className = 'gal-jump'; j.textContent = 'Go to message'; j.addEventListener('click', () => galJump(it));
    cell.append(b, j); grid.appendChild(cell);
  }
  for (const it of other) {
    const li = document.createElement('li'); li.className = 'gal-file';
    li.innerHTML = iconSvg(it.kind === 'audio' ? 'music' : 'file');
    const t = document.createElement('div');
    const a = document.createElement('a'); a.href = absUrl(it.url); a.download = it.name; a.textContent = it.name;
    const sm = document.createElement('small'); sm.textContent = `${fmtSize(it.size || 0)} · ${nameOf(it.userId)}, ${fmtDay(it.at)}`;
    t.append(a, sm);
    const j = document.createElement('button'); j.type = 'button'; j.className = 'btn small'; j.textContent = 'Go to message'; j.addEventListener('click', () => galJump(it));
    li.append(t, j); files.appendChild(li);
  }
  const shown = galTab === 'media' ? media.length : other.length;
  $('#galNote').textContent = shown ? '' : st.before ? 'Nothing here in the newest messages. Press “Show older” to look further back.' : galTab === 'media' ? 'No photos or videos shared here yet.' : 'No files shared here yet.';
  $('#galMore').hidden = !st.before;
}

/* ================= servers ================= */
const inviteLink = (s) => `${location.origin.startsWith('http') ? location.origin : ''}/invite/${s.invite}`;
async function copyInvite() {
  const s = curServer();
  if (!s) return;
  try { await navigator.clipboard.writeText(inviteLink(s)); toast('Invite link copied. Send it to a friend.', 2600); }
  catch { await confirmBox('Invite link', 'Copy this and send it to a friend:', 'Done', inviteLink(s)); }
}
/* Invite dialog: the permanent link, and links that expire or run out. */
async function openInvites() {
  const s = curServer();
  if (!s) return;
  $('#ivTitle').textContent = `Invite friends to ${s.name}`;
  $('#ivPermanent').value = inviteLink(s);
  $('#ivReset').hidden = !can(s, 'server');
  await renderInvites();
  $('#inviteDlg').showModal();
}
async function renderInvites() {
  const s = curServer(), ol = $('#ivList'); ol.textContent = '';
  let list = [];
  try { list = (await live.req('invite.list', { serverId: s.id })).invites; } catch {}
  for (const iv of list) {
    const li = document.createElement('li'); li.className = 'iv-item';
    const t = document.createElement('div');
    const code = document.createElement('code'); code.textContent = `${location.origin}/invite/${iv.code}`; t.appendChild(code);
    const meta = document.createElement('small');
    meta.textContent = `${iv.expiresAt ? `expires ${fmtRelative(iv.expiresAt)}` : 'never expires'} · ${iv.maxUses ? `${iv.uses} of ${iv.maxUses} used` : `${iv.uses} used`} · by ${nameOf(iv.creatorId)}`;
    t.appendChild(meta); li.appendChild(t);
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'btn small'; copy.textContent = 'Copy';
    copy.addEventListener('click', () => copyText(code.textContent));
    li.appendChild(copy);
    if (iv.creatorId === S.me.id || can(s, 'server')) {
      const del = document.createElement('button'); del.type = 'button'; del.className = 'btn small'; del.textContent = 'Remove';
      del.addEventListener('click', async () => { await act(() => live.req('invite.delete', { code: iv.code })); renderInvites(); });
      li.appendChild(del);
    }
    ol.appendChild(li);
  }
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Link copied. Send it to a friend.', 2600); }
  catch { await confirmBox('Invite link', 'Copy this and send it to a friend:', 'Done', text); }
}
$('#ivCopyPermanent').addEventListener('click', () => copyText($('#ivPermanent').value));
$('#ivCreate').addEventListener('click', async () => {
  const r = await act(() => live.req('invite.create', { serverId: curServer().id, hours: Number($('#ivHours').value), maxUses: Number($('#ivUses').value) }));
  if (r) { await renderInvites(); copyText(`${location.origin}/invite/${r.code}`); }
});
$('#ivReset').addEventListener('click', async () => {
  if (await confirmBox('Make a new permanent link?', 'The old permanent link stops working. Links that run out keep working.', 'Make new link')) {
    await act(() => live.req('invite.reset', { serverId: curServer().id }));
    setTimeout(() => { const s = curServer(); if (s) $('#ivPermanent').value = inviteLink(s); }, 300);
  }
});
$('#copyInvite').addEventListener('click', openInvites);
$('#mInvite').addEventListener('click', () => { closeMenu(); openInvites(); });
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
$('#railHome').addEventListener('click', () => setView({ kind: 'home' }));
$('#navHome').addEventListener('click', () => setView({ kind: 'home' }));
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
  const cams = list.filter((d) => d.kind === 'videoinput' && d.deviceId);
  fill($('#setCam'), cams, 'Camera', settings.camId || '');
  $('#camField').hidden = cams.length < 2;
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
  syncFx();
  $('#setClips').checked = !!settings.clips;
  $('#clipsField').hidden = !clipsSupported() || isPhone();
  for (const r of document.querySelectorAll('input[name="quality"]')) r.checked = r.value === settings.quality;
  for (const r of document.querySelectorAll('input[name="theme"]')) r.checked = r.value === settings.theme;
  $('#setPtt').checked = settings.ptt;
  $('#setNotify').checked = settings.notify && typeof Notification !== 'undefined' && Notification.permission === 'granted';
  $('#notifyField').hidden = typeof Notification === 'undefined';
  syncPushBox();
  $('#inVol').value = Math.round(settings.inputVol * 100); $('#inVolOut').textContent = `${$('#inVol').value}%`;
  $('#outVol').value = Math.round(settings.outputVol * 100); $('#outVolOut').textContent = `${$('#outVol').value}%`;
  $('#pttHint').textContent = desktop ? 'Hold the push-to-talk key to talk, even while you’re in a game (set it in the tray menu).' : 'Hold Space (or the Hold to talk button) to talk. Space only works while Party Line is in front.';
}
const BANNERS = ['', '#e8a33d', '#d9534f', '#d63384', '#8e5cd9', '#3d7be8', '#1aa3a3', '#3b9d4a', '#5b6472'];
let profileBanner = '';
function renderSwatches() {
  const box = $('#setBanner'); box.textContent = '';
  for (const c of BANNERS) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'swatch' + (c ? '' : ' auto'); b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(c === profileBanner)); b.title = c ? c : 'Automatic (from your name)'; b.setAttribute('aria-label', b.title);
    b.style.background = c || `hsl(${hue(S.me.name)} 45% 45%)`;
    b.addEventListener('click', () => { profileBanner = c; renderSwatches(); });
    box.appendChild(b);
  }
}
function fillBirthday(b) {
  const [m, d] = b ? b.split('-').map(Number) : [0, 0];
  const ms = $('#setBdayMonth'), ds = $('#setBdayDay');
  ms.innerHTML = '<option value="">Month</option>' + MONTHS.map((n, i) => `<option value="${i + 1}">${n}</option>`).join('');
  ms.value = m ? String(m) : '';
  const days = () => { const keep = ds.value || (d ? String(d) : ''); const n = ms.value ? new Date(2024, Number(ms.value), 0).getDate() : 31;
    ds.innerHTML = '<option value="">Day</option>' + Array.from({ length: n }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
    ds.value = Number(keep) <= n ? keep : ''; };
  ds.value = ''; days(); ds.value = d ? String(d) : '';
  ms.onchange = days;
}
const birthdayValue = () => ($('#setBdayMonth').value && $('#setBdayDay').value ? `${$('#setBdayMonth').value.padStart(2, '0')}-${$('#setBdayDay').value.padStart(2, '0')}` : '');
const FLAIRS = [['', 'None'], ['glow', 'Glow'], ['rainbow', 'Rainbow'], ['fire', 'Fire'], ['ice', 'Ice'], ['gold', 'Gold'], ['galaxy', 'Galaxy'], ['plasma', 'Plasma']];
let profileNameColor = '';
let profileFlair = '';
function renderFlairs() {
  const box = $('#setFlair'); box.textContent = '';
  for (const [k, label] of FLAIRS) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'flair-opt'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(k === profileFlair));
    const av = avEl(S.me.id); for (const c of [...av.classList]) if (c.startsWith('flair-')) av.classList.remove(c); if (k) av.classList.add(`flair-${k}`);
    const need = S.perks.unlocks.flair[k], locked = need && xpLevel(S.me.xp) < need;
    const t = document.createElement('small'); t.textContent = locked ? `🔒 Lv ${need}` : label;
    b.append(av, t); b.title = locked ? `${label}: unlocks at level ${need}` : label;
    b.classList.toggle('locked', !!locked);
    b.addEventListener('click', () => { if (locked) { toast(`The ${label} ring unlocks at level ${need}.`, 3000); return; } profileFlair = k; renderFlairs(); });
    box.appendChild(b);
  }
}
function renderNameColors() {
  const box = $('#setNameColor'), need = S.perks.unlocks.nameColor, locked = xpLevel(S.me.xp) < need;
  box.textContent = '';
  for (const c of ['', ...S.perks.nameColors]) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'swatch' + (c ? '' : ' none'); b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(c === profileNameColor)); b.setAttribute('aria-label', c ? `Name color ${c}` : 'No name color');
    if (c) b.style.background = c; else b.textContent = '✕';
    b.disabled = locked && !!c;
    b.addEventListener('click', () => { profileNameColor = c; renderNameColors(); });
    box.appendChild(b);
  }
  $('#nameColorHint').textContent = locked ? `🔒 Unlocks at level ${need} (you’re level ${xpLevel(S.me.xp)}).` : 'Your name shows in this color everywhere.';
}
function fillFlair() {
  profileFlair = S.me.flair || ''; renderFlairs();
  profileNameColor = S.me.nameColor || ''; renderNameColors();
  for (const r of document.querySelectorAll('input[name="bannerFx"]')) {
    r.checked = r.value === (S.me.bannerFx || '');
    const need = S.perks.unlocks.bannerFx[r.value], locked = need && xpLevel(S.me.xp) < need;
    r.disabled = !!locked;
    r.nextElementSibling.textContent = locked ? `🔒 Lv ${need}` : { '': 'None', aurora: 'Aurora', stars: 'Stars', scan: 'Scanlines', matrix: 'Matrix' }[r.value];
  }
  $('#setFavGames').value = (S.me.favGames || []).join(', ');
}
$('#setProfileSave').addEventListener('click', () => act(() => live.req('profile.set', { bio: $('#setBio').value, banner: profileBanner, birthday: birthdayValue(),
  flair: profileFlair, bannerFx: (document.querySelector('input[name="bannerFx"]:checked') || {}).value || '', nameColor: profileNameColor, favGames: $('#setFavGames').value }), 'Profile saved.'));
/* Settings is split into tabs: Profile, Look, Voice, Alerts, Account. */
let setTab = 'profile';
function showSetTab(name) {
  setTab = name;
  for (const t of document.querySelectorAll('#settings [role="tab"][data-settab]')) t.setAttribute('aria-selected', String(t.dataset.settab === name));
  for (const p of document.querySelectorAll('#settings .set-tab')) p.hidden = p.dataset.settab !== name;
}
document.querySelectorAll('#settings [role="tab"][data-settab]').forEach((t) => t.addEventListener('click', () => showSetTab(t.dataset.settab)));
function openSettings(tab) {
  showSetTab(typeof tab === 'string' ? tab : setTab);
  setTimeout(startMeter, 0);   // once the dialog is open
  syncSettingsForm();
  $('#setName').value = S.me.name; $('#setNameNote').textContent = 'Friends sign in and find you by this name.';
  $('#setBio').value = S.me.bio || ''; profileBanner = S.me.banner || ''; renderSwatches();
  fillBirthday(S.me.birthday);
  fillFlair();
  $('#pwNote').hidden = true; $('#pwOld').value = ''; $('#pwNew').value = '';
  $('#devOpen').hidden = !S.me.admin;
  $('#appInfo').textContent = desktop ? `Party Line desktop app ${desktop.version || ''} · Server: ${location.host}` : `Server: ${location.host}`;
  refreshDevices();
  $('#settings').showModal();
}
$('#setBtn').addEventListener('click', openSettings);
$('#setMic').addEventListener('change', (e) => Voice.chooseMic(e.target.value));
$('#setCam').addEventListener('change', async (e) => {
  settings.camId = e.target.value; saveSettings();
  if (V.camera) { Voice.stopCamera(); await Voice.startCamera(); }
});
$('#setSpeaker').addEventListener('change', (e) => { settings.speakerId = e.target.value; saveSettings(); Voice.applySpeaker(); });
$('#inVol').addEventListener('input', (e) => { $('#inVolOut').textContent = `${e.target.value}%`; Voice.setInputVol(e.target.value / 100); });
$('#outVol').addEventListener('input', (e) => { $('#outVolOut').textContent = `${e.target.value}%`; settings.outputVol = clampLevel(e.target.value / 100); saveSettings(); Voice.applyAllVolumes(); });
document.querySelectorAll('input[name="noise"]').forEach((r) => r.addEventListener('change', () => Voice.setNoiseMode(r.value).then(renderUserArea)));
document.querySelectorAll('input[name="theme"]').forEach((r) => r.addEventListener('change', () => setTheme(r.value)));
document.querySelectorAll('input[name="accent"]').forEach((r) => r.addEventListener('change', () => { settings.accent = r.value; saveSettings(); applyTheme(); }));
document.querySelectorAll('input[name="quality"]').forEach((r) => r.addEventListener('change', () => { settings.quality = r.value; saveSettings(); }));
$('#setClips').addEventListener('change', (e) => { settings.clips = e.target.checked; saveSettings(); syncStageExtras(); });
$('#setPtt').addEventListener('change', (e) => { settings.ptt = e.target.checked; saveSettings(); Voice.setPtt(false); Voice.applyMic(); renderUserArea(); });
$('#setNotify').addEventListener('change', async (e) => {
  if (e.target.checked && Notification.permission !== 'granted') {
    const p = await Notification.requestPermission().catch(() => 'denied');
    if (p !== 'granted') { e.target.checked = false; toast('Notifications are blocked. Allow them in your browser or system settings.', 5000); return; }
  }
  settings.notify = e.target.checked; saveSettings();
});
/* ================= custom emoji, stickers and saved GIFs ================= */
function setServerEmoji(serverId, list) {
  for (const [id, e] of S.emoji) if (e.serverId === serverId) S.emoji.delete(id);
  for (const e of list) S.emoji.set(e.id, e);
}
live.on('emoji', (d) => { setServerEmoji(d.serverId, d.emoji); rerenderMessagesSoft(); if ($('#emojiDlg').open) renderEmojiDlg(); if (!$('#pickPop').hidden) renderPick(); });
live.on('gifs', (d) => { S.gifs = d.gifs; if (!$('#pickPop').hidden) renderPick(); });
function customEmojiEl(name, id) {
  const e = S.emoji.get(id);
  if (!e) return document.createTextNode(`:${name}:`);   // from a server you're not in any more, or deleted
  const img = document.createElement('img'); img.className = 'c-emoji'; img.src = absUrl(e.url); img.alt = `:${name}:`; img.title = `:${name}:`; img.loading = 'lazy';
  return img;
}
const emojiLabel = (e) => { const m = /^<:(\w+):\d+>$/.exec(e); return m ? `:${m[1]}:` : e; };
function emojiInto(el, e) { const m = /^<:(\w+):(\d+)>$/.exec(e); if (m) el.appendChild(customEmojiEl(m[1], Number(m[2]))); else el.appendChild(document.createTextNode(e)); }
/* Only emoji (and custom emoji), so it shows big. Checked without nested repeats: a long run of emoji followed by
   a letter must not make the regex try every way of splitting the run (that froze the page). */
function isJumbo(body) {
  if (body.length > 400) return false;
  const rest = body.replace(/<:\w{2,32}:\d+>/g, '').replace(/\s+/g, '');
  return !rest || /^\p{Extended_Pictographic}[\u200d\ufe0f\p{Extended_Pictographic}\p{Emoji_Modifier}]*$/u.test(rest);
}
/* ":bora_laugh:" -> "<:bora_laugh:7>". This server's emoji first, then any you can use. Not inside `code`. */
function encodeEmoji(text) {
  if (!text.includes(':') || !S.emoji.size) return text;
  const srv = curServer(), mine = [...S.emoji.values()].filter((e) => e.kind === 'emoji');
  // The lookbehind (not a captured character) lets back-to-back emoji like :a::b: both convert.
  return text.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, i) => (i % 2 ? part : part.replace(/(?<![<\w]):(\w{2,32}):(?!\d+>)/g, (x, name) => {
    const e = mine.find((x2) => x2.name === name.toLowerCase() && srv && x2.serverId === srv.id) || mine.find((x2) => x2.name === name.toLowerCase());
    return e ? `<:${e.name}:${e.id}>` : x;
  }))).join('');
}
function stickerEl(id) {
  const e = S.emoji.get(id), wrap = document.createElement('div'); wrap.className = 'msg-sticker';
  if (!e) { wrap.textContent = '(a sticker that was removed)'; wrap.classList.add('gone'); return wrap; }
  const img = document.createElement('img'); img.src = absUrl(e.url); img.alt = `Sticker :${e.name}:`; img.title = `:${e.name}:`; img.loading = 'lazy';
  wrap.appendChild(img); return wrap;
}
function gifEl(uploadId) {
  const wrap = document.createElement('div'); wrap.className = 'msg-gif msg-media';
  const img = document.createElement('img'); img.className = 'media-img'; img.src = absUrl(`/uploads/${uploadId}`); img.alt = 'GIF'; img.loading = 'lazy';
  const b = document.createElement('button'); b.type = 'button'; b.className = 'media-btn'; b.setAttribute('aria-label', 'Open GIF'); b.appendChild(img);
  b.addEventListener('click', () => openLightbox(absUrl(`/uploads/${uploadId}`), 'GIF'));
  wrap.append(b, saveGifBtn(uploadId));
  return wrap;
}
/* ☆ under pictures: save to your GIFs to send again later. */
function saveGifBtn(uploadId) {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'save-gif';
  const paint = () => { const on = S.gifs.some((g) => g.id === uploadId); b.textContent = on ? '★ Saved' : '☆ Save to my GIFs'; b.classList.toggle('on', on); b.title = on ? 'Remove from your GIFs' : 'Save to your GIFs to send again later'; };
  paint();
  b.addEventListener('click', async (e) => { e.stopPropagation(); const on = !S.gifs.some((g) => g.id === uploadId); await act(() => live.req('gif.fav', { id: uploadId, on })); paint(); });
  return b;
}

/* The 🙂 picker next to the message box: emoji (yours and the servers'), stickers and saved GIFs. */
let pickTab = 'emoji';
const PICK_EMOJI = ['😀', '😂', '🤣', '😊', '😍', '😘', '😎', '🤔', '😴', '😭', '😡', '🥳', '😱', '🙄', '😬', '🤯', '👍', '👎', '👏', '🙏', '💪', '👀', '🔥', '💯', '❤️', '💔', '🎉', '✨', '🎮', '🎧', '🍕', '🍺', '☕', '💀', '🤡', '👻', '✅', '❌'];
function renderPick() {
  const body = $('#pickBody'); body.textContent = '';
  document.querySelectorAll('[data-pick]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.pick === pickTab)));
  const srv = curServer();
  const sorted = (kind) => [...S.emoji.values()].filter((e) => e.kind === kind).sort((a, b) => ((b.serverId === (srv && srv.id)) - (a.serverId === (srv && srv.id))) || a.name.localeCompare(b.name));
  const grid = (cls) => { const g = document.createElement('div'); g.className = 'pick-grid ' + cls; body.appendChild(g); return g; };
  const note = (text) => { const p = document.createElement('p'); p.className = 'hint pick-note'; p.textContent = text; body.appendChild(p); };
  if (pickTab === 'emoji') {
    const custom = sorted('emoji');
    if (custom.length) {
      const g = grid('custom');
      for (const e of custom) {
        const b = document.createElement('button'); b.type = 'button'; b.title = `:${e.name}:`; b.appendChild(customEmojiEl(e.name, e.id));
        b.addEventListener('click', () => insertText(`:${e.name}: `)); g.appendChild(b);
      }
    }
    const g = grid('std');
    for (const e of PICK_EMOJI) { const b = document.createElement('button'); b.type = 'button'; b.textContent = e; b.addEventListener('click', () => insertText(e)); g.appendChild(b); }
    if (!custom.length) note('Add your own emoji from the server menu → Emoji & stickers.');
  } else if (pickTab === 'sticker') {
    const list = sorted('sticker');
    if (!list.length) { note('No stickers yet. Add some from the server menu → Emoji & stickers.'); return; }
    const g = grid('big');
    for (const e of list) {
      const b = document.createElement('button'); b.type = 'button'; b.title = `:${e.name}:`;
      const img = document.createElement('img'); img.src = absUrl(e.url); img.alt = e.name; img.loading = 'lazy'; b.appendChild(img);
      b.addEventListener('click', () => sendSpecial(`<s:${e.id}>`)); g.appendChild(b);
    }
  } else {
    const inp = document.createElement('input'); inp.type = 'search'; inp.className = 'input gif-query'; inp.id = 'gifQuery';
    inp.placeholder = 'Search GIFs'; inp.setAttribute('aria-label', 'Search GIFs'); inp.value = gifQuery; inp.autocomplete = 'off';
    const out = document.createElement('div'); out.className = 'gif-results';
    body.append(inp, out);
    // Searches use the group's shared Giphy allowance, so wait for a pause in typing and for at least 2 letters.
    inp.addEventListener('input', () => { gifQuery = inp.value; clearTimeout(gifTimer); gifTimer = setTimeout(() => { if (gifQuery.trim().length !== 1) searchGifs(out); }, 700); });
    // The picker sits inside the message form: Enter here searches now instead of sending the message being written.
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); gifQuery = inp.value; clearTimeout(gifTimer); searchGifs(out); } });
    searchGifs(out);
    setTimeout(() => inp.focus(), 20);
  }
}
/* GIFs tab: your saved GIFs, then Giphy search (trending when the box is empty). Search goes through our
   server; see gifs.js. */
let gifQuery = '', gifTimer = null, gifSeq = 0, gifSearchOn = null;
const gifCache = new Map();   // search text -> { at, res }: going back to an earlier search costs nothing
function gifGrid(out, items, onPick) {
  const g = document.createElement('div'); g.className = 'pick-grid big gifs'; out.appendChild(g);
  for (const x of items) {
    const b = document.createElement('button'); b.type = 'button'; b.title = x.title ? `Send “${x.title}”` : 'Send this GIF';
    const img = document.createElement('img'); img.src = absUrl(x.preview || x.url); img.alt = x.title || 'GIF'; img.loading = 'lazy'; b.appendChild(img);
    b.addEventListener('click', () => onPick(x, b)); g.appendChild(b);
  }
}
async function searchGifs(out) {
  if (!out.isConnected) return;   // a search typed before the picker was redrawn: the new one has its own
  const q = gifQuery.trim(), my = ++gifSeq;
  const add = (tag, cls, text) => { const e = document.createElement(tag); e.className = cls; e.textContent = text; out.appendChild(e); return e; };
  const paint = (res, err) => {
    if (my !== gifSeq || !out.isConnected) return;
    out.textContent = '';
    if (!q && S.gifs.length) { add('h4', 'pick-h', '★ Saved'); gifGrid(out, S.gifs, (x) => sendSpecial(`<g:${x.id}>`)); }
    if (err) { add('p', 'hint pick-note', err); return; }
    if (!res.enabled) {
      if (!S.gifs.length) add('p', 'hint pick-note', 'GIFs you save (☆ under any picture in the chat) show up here.');
      add('p', 'hint pick-note', 'GIF search is off on this server. The server owner can switch it on with a free Giphy key (see DEPLOY.md).');
      return;
    }
    add('h4', 'pick-h', q ? `Results for “${q}”` : 'Trending');
    if (!res.gifs.length) add('p', 'hint pick-note', 'No GIFs found. Try other words.');
    gifGrid(out, res.gifs, async (x, btn) => {
      btn.disabled = true; btn.classList.add('busy');
      const r = await act(() => api('/api/gifs/send', { method: 'POST', body: { id: x.id } }));
      btn.disabled = false; btn.classList.remove('busy');
      if (r) sendSpecial(`<g:${r.uploadId}>`);
    });
    add('p', 'giphy-credit', 'Powered by GIPHY');
  };
  if (gifSearchOn === false) { paint({ enabled: false, gifs: [] }); return; }
  const ck = q.toLowerCase(), hit = gifCache.get(ck);
  if (hit && Date.now() - hit.at < 10 * 60_000) { paint(hit.res); return; }
  if (!out.childElementCount) add('p', 'hint pick-note', 'Loading GIFs…');
  try {
    const r = await api(`/api/gifs?q=${encodeURIComponent(q)}`);
    gifSearchOn = r.enabled;
    if (r.enabled) { if (gifCache.size > 60) gifCache.clear(); gifCache.set(ck, { at: Date.now(), res: r }); }
    paint(r);
  } catch (e) { paint(null, e.message); }
}
function insertText(t) {
  const ta = chatInput, a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? a;
  ta.value = ta.value.slice(0, a) + t + ta.value.slice(b);
  ta.selectionStart = ta.selectionEnd = a + t.length; ta.focus(); autosize();
}
function sendSpecial(body) {
  const target = composeTarget();
  closePick();
  if (!target) return;
  sendChain = sendChain.then(() => live.req('msg.send', Object.assign({ body, attachments: [], replyTo: S.replyTo ? S.replyTo.id : null }, target)).then(() => cancelReply()).catch((e) => toast(e.message, 4000)));
}
function openPick() { renderPick(); $('#pickPop').hidden = false; $('#pickBtn').setAttribute('aria-expanded', 'true'); }
function closePick() { $('#pickPop').hidden = true; $('#pickBtn').setAttribute('aria-expanded', 'false'); }
$('#pickBtn').addEventListener('click', () => ($('#pickPop').hidden ? openPick() : closePick()));
document.querySelectorAll('[data-pick]').forEach((t) => t.addEventListener('click', () => { pickTab = t.dataset.pick; renderPick(); }));
document.addEventListener('pointerdown', (e) => { if (!$('#pickPop').hidden && !e.target.closest('#pickPop, #pickBtn')) closePick(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#pickPop').hidden) closePick(); });

/* Server menu → Emoji & stickers */
let emojiFile = null;
function renderEmojiDlg() {
  const srv = curServer(); if (!srv) return;
  const mod = can(srv, 'messages');
  for (const kind of ['emoji', 'sticker']) {
    const list = [...S.emoji.values()].filter((e) => e.serverId === srv.id && e.kind === kind).sort((a, b) => a.name.localeCompare(b.name));
    $(kind === 'emoji' ? '#emojiCount' : '#stickerCount').textContent = `${kind === 'emoji' ? 'Emoji' : 'Stickers'} (${list.length} of ${kind === 'emoji' ? 100 : 50})`;
    const box = $(kind === 'emoji' ? '#emojiList' : '#stickerList'); box.textContent = '';
    if (!list.length) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'None yet.'; box.appendChild(p); }
    for (const e of list) {
      const it = document.createElement('div'); it.className = 'emoji-item';
      const img = document.createElement('img'); img.src = absUrl(e.url); img.alt = ''; img.loading = 'lazy';
      const n = document.createElement('span'); n.textContent = `:${e.name}:`; n.title = `Added by ${nameOf(e.by)}`;
      it.append(img, n);
      if (mod || e.by === S.me.id) {
        const x = document.createElement('button'); x.type = 'button'; x.className = 'btn icon-btn'; x.innerHTML = iconSvg('trash'); x.title = `Remove :${e.name}:`; x.setAttribute('aria-label', x.title);
        x.addEventListener('click', async () => { if (await confirmBox(`Remove :${e.name}:?`, 'It disappears from old messages too.', 'Remove')) act(() => live.req('emoji.delete', { id: e.id })); });
        it.appendChild(x);
      }
      box.appendChild(it);
    }
  }
}
function openEmojiDlg() { emojiFile = null; $('#emojiPreview').hidden = true; $('#emojiName').value = ''; renderEmojiDlg(); $('#emojiDlg').showModal(); }
$('#mEmoji').addEventListener('click', () => { closeMenu(); openEmojiDlg(); });
$('#emojiPickFile').addEventListener('click', () => $('#emojiFile').click());
$('#emojiFile').addEventListener('change', () => {
  const f = $('#emojiFile').files[0]; $('#emojiFile').value = '';
  if (!f) return;
  const max = $('#emojiKind').value === 'emoji' ? 524288 : 2097152;
  if (f.size > max) { toast(`That picture is over ${max === 524288 ? '512 KB' : '2 MB'}.`, 4000); return; }
  emojiFile = f;
  const pv = $('#emojiPreview'); pv.src = URL.createObjectURL(f); pv.hidden = false;
  if (!$('#emojiName').value) $('#emojiName').value = f.name.replace(/\.\w+$/, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
});
$('#emojiForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!emojiFile) { toast('Choose a picture first.', 3000); return; }
  const srv = curServer(), kind = $('#emojiKind').value;
  const r = await act(async () => { const up = await upload('/api/upload', emojiFile); return live.req('emoji.add', { serverId: srv.id, uploadId: up.id, name: $('#emojiName').value, kind }); }, kind === 'emoji' ? 'Emoji added.' : 'Sticker added.');
  if (r) { emojiFile = null; $('#emojiPreview').hidden = true; $('#emojiName').value = ''; }
});

/* ================= games to play: each chat's list of game ideas ================= */
const gameTarget = () => (S.view.kind === 'text' ? { channelId: S.view.channelId } : S.view.kind === 'dm' ? { userId: S.view.userId } : null);
let gamesLoading = null;
function loadGames(force) {
  const key = msgKey(), target = gameTarget();
  if (!key || !target || (S.games.has(key) && !force) || gamesLoading === key) { paintGamesCount(); return; }
  gamesLoading = key;
  live.req('games.list', target).then((r) => { S.games.set(key, r.games); if (msgKey() === key) { paintGamesCount(); if (!$('#gamesPanel').hidden) renderGames(); } })
    .catch(() => {}).finally(() => { if (gamesLoading === key) gamesLoading = null; });
}
function paintGamesCount() {
  const list = S.games.get(msgKey()) || [], open = list.filter((g) => !g.playedAt).length;
  $('#gamesCount').hidden = !open; $('#gamesCount').textContent = open;
}
live.on('games', (d) => {
  const key = d.channelId ? `c:${d.channelId}` : dmKeyById(d.dmId);
  if (!key) return;
  S.games.set(key, d.games);
  if (msgKey() === key) { paintGamesCount(); if (!$('#gamesPanel').hidden) renderGames(); }
});
function renderGames() {
  const ul = $('#gamesList'); ul.textContent = '';
  const list = S.games.get(msgKey()) || [];
  $('#gamesPick').disabled = !list.some((g) => !g.playedAt);
  $('#gamesPoll').disabled = list.filter((g) => !g.playedAt).length < 2;
  $('#gamesPlan').hidden = S.view.kind !== 'text' || !curServer() || isPrivate(curServer());   // events belong to servers
  if (!list.length) { const li = document.createElement('li'); li.className = 'hint games-empty'; li.textContent = 'No games yet. Add the ones you want to try together, so you remember them on game night.'; ul.appendChild(li); return; }
  const srv = curServer(), mod = S.view.kind === 'text' && can(srv, 'messages');
  for (const g of list) {
    const li = document.createElement('li'); li.className = 'game' + (g.playedAt ? ' played' : '');
    const vote = document.createElement('button'); vote.type = 'button'; vote.className = 'game-vote' + (g.votes.includes(S.me.id) ? ' mine' : '');
    vote.innerHTML = `<span aria-hidden="true">👍</span><b>${g.votes.length}</b>`;
    vote.title = g.votes.length ? `Want to play: ${g.votes.map(nameOf).join(', ')}` : 'I want to play this';
    vote.setAttribute('aria-pressed', String(g.votes.includes(S.me.id))); vote.setAttribute('aria-label', `${g.votes.includes(S.me.id) ? 'Remove your vote for' : 'Vote for'} ${g.name}`);
    vote.addEventListener('click', () => act(() => live.req('games.vote', { id: g.id, on: !g.votes.includes(S.me.id) })));
    const main = document.createElement('div'); main.className = 'game-main';
    const name = document.createElement(g.url ? 'a' : 'b'); name.className = 'game-name'; name.textContent = g.name;
    if (g.url) { name.href = g.url; name.target = '_blank'; name.rel = 'noopener noreferrer'; name.title = new URL(g.url).hostname; }
    const meta = document.createElement('small'); meta.textContent = [g.note, `added by ${nameOf(g.by)}`, g.playedAt ? `played ${fmtDay(g.playedAt).replace(/^(Today|Yesterday)$/, (w) => w.toLowerCase())}` : null].filter(Boolean).join(' · ');
    main.append(name, meta);
    const played = document.createElement('button'); played.type = 'button'; played.className = 'btn small game-played' + (g.playedAt ? ' on' : '');
    played.textContent = g.playedAt ? '✓ Played' : 'Played?'; played.title = g.playedAt ? 'Move it back to the list' : 'Tick it off: you’ve played it';
    played.addEventListener('click', () => act(() => live.req('games.played', { id: g.id, on: !g.playedAt })));
    li.append(vote, main, played);
    if (g.by === S.me.id || mod) {
      const del = document.createElement('button'); del.type = 'button'; del.className = 'btn small icon-btn game-del'; del.innerHTML = iconSvg('trash'); del.title = `Remove ${g.name}`; del.setAttribute('aria-label', del.title);
      del.addEventListener('click', () => act(() => live.req('games.delete', { id: g.id })));
      li.appendChild(del);
    }
    ul.appendChild(li);
  }
}
function openGames() {
  closeSearch(); renderGames(); $('#gamesPanel').hidden = false; loadGames(true);
  if (!isPhone()) $('#gameName').focus();   // right away: a late focus would grab what you're typing in the message box
}
$('#gamesBtn').addEventListener('click', () => ($('#gamesPanel').hidden ? openGames() : ($('#gamesPanel').hidden = true)));
$('#gamesClose').addEventListener('click', () => { $('#gamesPanel').hidden = true; });
$('#gamesPanel').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); $('#gamesPanel').hidden = true; } });
$('#gamesForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await act(() => live.req('games.add', Object.assign({ name: $('#gameName').value, url: $('#gameUrl').value, note: $('#gameNote').value }, gameTarget())));
  if (r) { $('#gameName').value = ''; $('#gameUrl').value = ''; $('#gameNote').value = ''; loadGames(true); $('#gameName').focus(); }
});
$('#gamesPick').addEventListener('click', () => act(() => live.req('games.pick', gameTarget())));
$('#gamesPlan').addEventListener('click', () => {
  $('#gamesPanel').hidden = true;
  openEvents();
  newEventForm({ title: 'Game night', gameVote: 30, textChannelId: S.view.channelId });
});
$('#gamesPoll').addEventListener('click', async () => {
  if (await act(() => live.req('games.poll', Object.assign({ minutes: Number($('#gamesPollMins').value) }, gameTarget())))) $('#gamesPanel').hidden = true;
});

/* "New in Party Line" (see news.js) */
function showNews() {
  const seen = Number(S.me.newsSeen) || 0;
  if (seen >= latestNews()) return;
  const items = unseenNews(seen);
  live.req('profile.set', { newsSeen: latestNews() }).then(() => { S.me.newsSeen = latestNews(); }).catch(() => {});
  if (!items.length || document.querySelector('dialog[open]')) return;
  const ul = $('#newsList'); ul.textContent = '';
  for (const [icon, title, text] of items) {
    const li = document.createElement('li');
    const i = document.createElement('span'); i.className = 'news-emoji'; i.textContent = icon;
    const t = document.createElement('div'); const b = document.createElement('b'); b.textContent = title; const p = document.createElement('p'); p.textContent = text;
    t.append(b, p); li.append(i, t); ul.appendChild(li);
  }
  $('#newsDlg').showModal();
}
$('#newsOk').addEventListener('click', () => $('#newsDlg').close());
/* Push notifications: the browser keeps a line open to its push service (Google, Mozilla, Apple, Microsoft),
   so private messages, mentions and calls arrive even when Party Line is closed. Works in Chrome, Edge,
   Firefox and Safari, and on iPhone once Party Line is added to the Home Screen. The desktop app and the
   Android app have their own notifications while open, so this is for the website. */
const pushSupported = () => !desktop && !phoneApp && window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
const b64bytes = (s) => { const t = atob((s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(t, (ch) => ch.charCodeAt(0)); };
async function pushSub() { const reg = await navigator.serviceWorker.ready; return { reg, sub: await reg.pushManager.getSubscription() }; }
async function setPush(on) {
  const { reg, sub } = await pushSub();
  if (!on) {
    if (sub) { await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
    settings.push = false; saveSettings(); return;
  }
  if (Notification.permission !== 'granted' && await Notification.requestPermission().catch(() => 'denied') !== 'granted') throw new Error('Notifications are blocked. Allow them in your browser or system settings.');
  const { key } = await api('/api/push/key');
  const s2 = sub || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64bytes(key) });
  await api('/api/push/subscribe', { method: 'POST', body: { subscription: s2.toJSON(), device: S.appLabel || '' } });
  settings.push = true; saveSettings();
}
/* On every start: tell the server again (it forgets addresses the push service retired, and you may have
   signed in as someone else on this browser). */
async function syncPush() {
  if (!pushSupported() || !settings.push) return;
  if (Notification.permission !== 'granted') { settings.push = false; saveSettings(); return; }
  setPush(true).catch(() => {});
}
async function syncPushBox() {
  $('#pushField').hidden = !pushSupported();
  if (!pushSupported()) return;
  const { sub } = await pushSub().catch(() => ({}));
  $('#setPush').checked = !!(sub && settings.push && Notification.permission === 'granted');
}
$('#setPush').addEventListener('change', async (e) => {
  const on = e.target.checked; e.target.disabled = true;
  try { await setPush(on); if (on) toast('Done. You’ll get notifications even when Party Line is closed.', 4000); }
  catch (err) { e.target.checked = false; toast(err.message || 'Couldn’t turn on notifications in this browser.', 6000); }
  finally { e.target.disabled = false; }
});
/* Clicking a push notification opens Party Line at the chat (see sw.js). */
function openFromPush(q) {
  const p = q instanceof URLSearchParams ? q : new URLSearchParams(q);
  if (p.get('dm') && S.users.has(Number(p.get('dm')))) return setView({ kind: 'dm', userId: Number(p.get('dm')) });
  const f = findChannel(Number(p.get('channel') || p.get('call')));
  if (f && (f.channel.kind === 'text' || p.get('channel'))) return setView({ kind: 'text', serverId: f.server.id, channelId: f.channel.id });
  if (f) return openServer(f.server.id);
  if (p.get('friends')) { S.friendTab = 'pending'; setView({ kind: 'friends' }); }
}
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.open && S.ready) openFromPush(e.data.open.split('?')[1] || ''); });
$('#setNameSave').addEventListener('click', async () => {
  const name = $('#setName').value.trim();
  if (!name || name === S.me.name) return;
  try { await live.req('profile.rename', { name }); $('#setNameNote').textContent = 'Saved. Use this name to sign in from now on.'; }
  catch (ex) { $('#setNameNote').textContent = ex.message; }
});
/* Settings → Devices you're signed in on */
async function renderSessions() {
  const ul = $('#sessionList');
  let r; try { r = await live.req('sessions.list', {}); } catch { return; }
  ul.textContent = '';
  for (const x of r.sessions) {
    const li = document.createElement('li');
    const t = document.createElement('div');
    const b = document.createElement('b'); b.textContent = x.device; t.appendChild(b);
    const sm = document.createElement('small'); sm.textContent = x.current ? 'This device' : x.online ? 'Online now' : `Last used ${Date.now() - x.lastSeen < 120_000 ? 'just now' : fmtRelative(x.lastSeen)}`; t.appendChild(sm);
    li.appendChild(t);
    if (!x.current) {
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn small'; btn.textContent = 'Sign out';
      btn.addEventListener('click', async () => { if (await act(() => live.req('sessions.end', { id: x.id }), `Signed out of ${x.device}.`)) { renderSessions(); syncPush(); } });
      li.appendChild(btn);
    }
    ul.appendChild(li);
  }
  $('#sessionsEndOthers').hidden = r.sessions.length < 2;
}
$('#devicesBox').addEventListener('toggle', () => { if ($('#devicesBox').open) renderSessions(); });
$('#sessionsEndOthers').addEventListener('click', async () => {
  if (!await confirmBox('Sign out everywhere else?', 'Every other phone, computer and browser is signed out. This one stays signed in.', 'Sign out')) return;
  if (await act(() => live.req('sessions.end', { others: true }), 'Signed out everywhere else.')) { renderSessions(); syncPush(); }   // this device's notifications, tied to its sign-in again
});
/* Settings → 2-step sign-in */
function syncTwoStep() {
  const on = !!(S.me && S.me.twoStep);
  $('#twoStepState').textContent = on ? 'On' : 'Off'; $('#twoStepState').classList.toggle('on', on);
  $('#twoStepOff').hidden = on; $('#twoStepOn').hidden = !on;
  if (!on) { $('#twoStepSetup').hidden = true; $('#twoStepStart').hidden = false; }
}
$('#twoStepBox').addEventListener('toggle', syncTwoStep);
$('#twoStepStart').addEventListener('click', async () => {
  const r = await act(() => live.req('totp.start', {}));
  if (!r) return;
  $('#twoStepQr').src = r.qr; $('#twoStepSecret').textContent = r.secret.replace(/(.{4})/g, '$1 ').trim();
  $('#twoStepStart').hidden = true; $('#twoStepSetup').hidden = false; $('#twoStepCode').value = ''; $('#twoStepCode').focus();
});
$('#twoStepConfirm').addEventListener('click', async () => {
  if (await act(() => live.req('totp.confirm', { code: $('#twoStepCode').value }), '2-step sign-in is on. New sign-ins will ask for a code.')) { S.me.twoStep = true; syncTwoStep(); }
});
$('#twoStepStop').addEventListener('click', async () => {
  if (await act(() => live.req('totp.stop', { password: $('#twoStepPass').value }), '2-step sign-in is off.')) { S.me.twoStep = false; $('#twoStepPass').value = ''; syncTwoStep(); }
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

/* ================= notification settings ================= */
const LEVEL_TEXT = { all: ['All messages', 'A sound and a notification for every message'], mentions: ['Only @mentions', 'Only when someone mentions you'], mute: ['Nothing', 'Muted: no sounds, notifications or unread highlight'] };
function openNotif(target, anchor) {
  const pop = $('#notifPop'), opts = $('#notifOpts'); opts.textContent = '';
  let cur, choices = ['all', 'mentions', 'mute'], dflt = null;
  if (target.startsWith('s:')) { const srv = S.servers.get(Number(target.slice(2))); cur = serverLevel(srv); $('#notifTitle').textContent = `Notifications for ${srv.name}`; }
  else if (target.startsWith('d:')) { cur = S.notif[target] || 'all'; choices = ['all', 'mute']; $('#notifTitle').textContent = `Notifications from ${nameOf(Number(target.slice(2)))}`; }
  else {
    const f = findChannel(Number(target.slice(2)));
    dflt = serverLevel(f.server); cur = S.notif[target] || 'default';
    $('#notifTitle').textContent = isPrivate(f.server) ? `Notifications for ${groupName(f.server)}` : `Notifications for #${f.channel.name}`;
    if (isPrivate(f.server)) { dflt = null; cur = S.notif[target] || serverLevel(f.server); }
  }
  const opt = (value, label, desc) => {
    const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(cur === value)); b.dataset.level = value;
    b.innerHTML = '<span class="radio-dot"></span><span><b></b><small></small></span>';
    b.querySelector('b').textContent = label; b.querySelector('small').textContent = desc;
    b.addEventListener('click', () => { act(() => live.req('notify.set', { target, level: value === 'default' ? null : value })); pop.hidden = true; });
    opts.appendChild(b);
  };
  if (dflt) opt('default', `Same as the server (${LEVEL_TEXT[dflt][0]})`, 'Follow the server’s notification setting');
  for (const c of choices) opt(c, ...LEVEL_TEXT[c]);
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.right - pop.offsetWidth))}px`;
  pop.style.top = `${Math.min(innerHeight - pop.offsetHeight - 8, r.bottom + 6)}px`;
}
$('#notifBtn').addEventListener('click', (e) => {
  if (!$('#notifPop').hidden) { $('#notifPop').hidden = true; return; }
  openNotif(S.view.kind === 'dm' ? `d:${S.view.userId}` : `c:${S.view.channelId}`, e.currentTarget);
});
$('#mNotify').addEventListener('click', () => { const s = curServer(); closeMenu(); if (s) openNotif(`s:${s.id}`, $('#serverBtn')); });
document.addEventListener('pointerdown', (e) => { if (!$('#notifPop').hidden && !e.target.closest('#notifPop, #notifBtn, #mNotify')) $('#notifPop').hidden = true; });

/* "New messages" line where you left off, and a bar to jump to it when it's scrolled out of view. */
function noteUnread(v) {
  let count = 0, key = null;
  if (v.kind === 'text') { const f = findChannel(v.channelId); count = f ? f.channel.unread || 0 : 0; key = `c:${v.channelId}`; }
  else if (v.kind === 'dm') { count = (S.dms.get(v.userId) || {}).unread || 0; key = `d:${v.userId}`; }
  S.newMark = count ? { key, count } : null;
}
function renderNewBar() {
  const bar = $('#newBar'), div = document.querySelector('#messages .new-divider');
  if (!div || !S.newMark) { bar.hidden = true; return; }
  const box = $('#messages'), above = div.offsetTop < box.scrollTop;
  bar.hidden = !above;
  bar.textContent = `${S.newMark.count} new message${S.newMark.count === 1 ? '' : 's'} · Jump to them`;
}
$('#newBar').addEventListener('click', () => { const d = document.querySelector('#messages .new-divider'); if (d) d.scrollIntoView({ block: 'start' }); renderNewBar(); });
$('#messages').addEventListener('scroll', renderNewBar, { passive: true });
/* Phones and tablets: tap a message to show its react, reply and pin buttons (they'd crowd every message otherwise). */
const touchOnly = matchMedia('(hover: none)');
$('#messages').addEventListener('click', (e) => {
  if (!touchOnly.matches || e.target.closest('a, button, video, audio, input, textarea, select, .spoiler, .msg-tools')) return;
  const msg = e.target.closest('.msg');
  for (const m of document.querySelectorAll('#messages .msg.tools-open')) if (m !== msg) m.classList.remove('tools-open');
  if (msg) msg.classList.toggle('tools-open');
});

/* ================= password reset requests (admins) ================= */
function renderResetBar() {
  const n = (S.resets || []).length;
  $('#resetBar').hidden = !n;
  $('#resetBarText').textContent = n === 1 ? `🔑 ${S.resets[0].name} wants to reset their password.` : `🔑 ${n} people want to reset their password.`;
}
function renderResets() {
  const ol = $('#resetList'); ol.textContent = '';
  if (!S.resets.length) { ol.innerHTML = '<li class="hint">No requests waiting.</li>'; return; }
  for (const r of S.resets) {
    const li = document.createElement('li'); li.className = 'reset-item';
    const who = document.createElement('div'); who.className = 'reset-who';
    who.appendChild(avEl(r.userId));
    const t = document.createElement('div');
    const n = document.createElement('b'); n.textContent = r.name; t.appendChild(n);
    const meta = document.createElement('small'); meta.textContent = `${fmtWhen(r.at)}${r.device ? ` · from ${r.device}` : ''}`; t.appendChild(meta);
    if (r.note) { const q = document.createElement('p'); q.className = 'reset-note'; q.textContent = `“${r.note}”`; t.appendChild(q); }
    who.appendChild(t); li.appendChild(who);
    const btns = document.createElement('div'); btns.className = 'row-btns';
    const no = document.createElement('button'); no.type = 'button'; no.className = 'btn small'; no.textContent = 'Deny';
    no.addEventListener('click', () => act(() => live.req('reset.decide', { id: r.id, approve: false }), 'Request turned down.'));
    const yes = document.createElement('button'); yes.type = 'button'; yes.className = 'btn small primary'; yes.textContent = 'Approve';
    yes.addEventListener('click', async () => { if (await confirmBox(`Approve ${r.name}’s new password?`, 'Only if you’re sure it’s really them. They’ll be signed in with the password they picked.', 'Approve')) act(() => live.req('reset.decide', { id: r.id, approve: true }), `${r.name} can sign in with their new password now.`); });
    btns.append(no, yes); li.appendChild(btns);
    ol.appendChild(li);
  }
}
function openResets() { renderResets(); $('#resetDlg').showModal(); }
$('#resetReview').addEventListener('click', openResets);

/* ================= group chats, calls and ringing ================= */
let groupMode = 'create';
function openGroupDlg(mode) {
  groupMode = mode;
  const g = mode === 'add' ? curServer() : null;
  $('#grTitle').textContent = g ? `Add people to ${groupName(g)}` : 'New group chat';
  $('#grNameField').hidden = !!g; $('#grName').value = '';
  $('#grSubmit').textContent = g ? 'Add' : 'Create group';
  const pick = $('#grPick'); pick.textContent = '';
  const known = new Set([...S.friends].filter(([, st]) => st === 'friends').map(([id]) => id));
  for (const s of S.servers.values()) if (!isPrivate(s)) for (const id of s.members) known.add(id);
  const ids = [...known].filter((id) => id !== S.me.id && !user(id).bot && !(g && g.members.includes(id))).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  for (const id of ids) {
    const l = document.createElement('label'); l.className = 'role-member';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = id;
    l.appendChild(cb); l.appendChild(avEl(id)); l.appendChild(document.createTextNode(nameOf(id)));
    pick.appendChild(l);
  }
  $('#grEmpty').hidden = !!ids.length;
  $('#groupDlg').showModal();
}
$('#newGroupBtn').addEventListener('click', () => openGroupDlg('create'));
$('#groupAddBtn').addEventListener('click', () => openGroupDlg('add'));
$('#groupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const userIds = [...$('#grPick').querySelectorAll('input:checked')].map((x) => Number(x.value));
  if (groupMode === 'add') {
    if (await act(() => live.req('group.add', { serverId: curServer().id, userIds }))) $('#groupDlg').close();
    return;
  }
  const r = await act(() => live.req('group.create', { userIds, name: $('#grName').value }));
  if (r) { $('#groupDlg').close(); const g = S.servers.get(r.id); if (g) setView({ kind: 'text', serverId: g.id, channelId: groupText(g).id }); }
});
$('#groupLeaveBtn').addEventListener('click', async () => {
  const g = curServer();
  if (g && await confirmBox(`Leave ${groupName(g)}?`, 'You won’t get its messages any more. Someone in it can add you back.', 'Leave')) { await act(() => live.req('server.leave', { id: g.id })); setView({ kind: 'friends' }); }
});
async function startCall() {
  const v = S.view;
  let serverId, channelId;
  if (v.kind === 'dm') { const r = await act(() => live.req('call.start', { userId: v.userId })); if (!r) return; ({ serverId, channelId } = r); }
  else { const g = curServer(); if (!g) return; serverId = g.id; channelId = groupVoice(g).id; }
  setView({ kind: 'voice', serverId, channelId });
  if (V.channelId !== channelId) joinVoice(channelId);
}
$('#callBtn').addEventListener('click', startCall);
let ring = null;   // { serverId, channelId, timer, until }
live.on('ring', (d) => {
  if (V.channelId === d.channelId) return;
  const g = S.servers.get(d.serverId);
  if (!g) return;
  stopRing();
  ring = { serverId: d.serverId, channelId: d.channelId, until: Date.now() + 30_000 };
  $('#ringAv').textContent = ''; $('#ringAv').appendChild(avEl(d.from));
  $('#ringTitle').textContent = g.kind === 'pair' ? `${nameOf(d.from)} is calling` : `${nameOf(d.from)} started a call`;
  $('#ringSub').textContent = g.kind === 'pair' ? 'Private call' : groupName(g);
  $('#ringBar').hidden = false;
  const tick = () => { if (!ring) return; if (Date.now() > ring.until) { stopRing(); return; } if (!quiet() && !V.deafened) chime('join'); };
  tick(); ring.timer = setInterval(tick, 2000);
  notify(g.kind === 'pair' ? `📞 ${nameOf(d.from)} is calling` : `📞 Call in ${groupName(g)}`, 'Open Party Line to join.', () => joinRing());
});
live.on('ring.stop', (d) => { if (ring && ring.channelId === d.channelId) stopRing(); });
function stopRing() { if (ring) clearInterval(ring.timer); ring = null; $('#ringBar').hidden = true; }
function joinRing() {
  if (!ring) return;
  const { serverId, channelId } = ring; stopRing();
  setView({ kind: 'voice', serverId, channelId });
  if (V.channelId !== channelId) joinVoice(channelId);
}
$('#ringJoin').addEventListener('click', joinRing);
$('#ringDecline').addEventListener('click', stopRing);

/* ================= channels: settings, categories, drag and drop ================= */
function dropTarget(el, where) {
  el.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('text/x-chan')) { e.preventDefault(); el.classList.add('drop-here'); } });
  el.addEventListener('dragleave', () => el.classList.remove('drop-here'));
  el.addEventListener('drop', (e) => {
    el.classList.remove('drop-here');
    const id = Number(e.dataTransfer.getData('text/x-chan'));
    if (!id) return;
    e.preventDefault(); e.stopPropagation();
    const w = where();
    if (w.beforeId === id) return;
    act(() => live.req('chan.move', Object.assign({ id }, w)));
  });
}
let editingChan = null;
function editChannel(c) {
  editingChan = c;
  $('#chTitle').textContent = `${c.kind === 'text' ? '#' : '🔊 '}${c.name}`;
  $('#chName').value = c.name; $('#chTopic').value = c.topic || '';
  $('#chanDlg').showModal();
}
$('#chanForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await act(() => live.req('chan.edit', { id: editingChan.id, name: $('#chName').value, topic: $('#chTopic').value }), 'Channel saved.');
  if (r) $('#chanDlg').close();
});
async function editCategory(cat) {
  const name = await confirmBox('Edit category', 'Rename it, or clear the name and press Save to delete it (its channels stay).', 'Save', cat.name);
  if (name === false) return;
  if (!name.trim()) act(() => live.req('cat.delete', { id: cat.id }));
  else if (name.trim() !== cat.name) act(() => live.req('cat.rename', { id: cat.id, name: name.trim() }));
}
$('#mCategory').addEventListener('click', async () => {
  closeMenu();
  const name = await confirmBox('Create category', 'Group channels under a heading, like “🎮 Games”. Drag channels into it afterwards.', 'Create', '');
  if (name && name.trim()) act(() => live.req('cat.create', { serverId: curServer().id, name: name.trim() }));
});

/* ================= roles ================= */
const PERM_TEXT = { channels: ['Manage channels', 'Create categories, edit, reorder and delete channels'], messages: ['Moderate messages', 'Delete anyone’s messages, sounds and events'],
  voice: ['Moderate voice', 'Mute people for everyone, disconnect them from voice'], kick: ['Remove members', 'Remove people from the server'], server: ['Manage server', 'Rename the server and manage roles'] };
const ROLE_COLORS = ['', '#e8a33d', '#d9534f', '#d63384', '#8e5cd9', '#3d7be8', '#1aa3a3', '#3b9d4a', '#9aa0a6'];
let editingRole = null, roleDraft = null;
function openRoles() { closeMenu(); editingRole = null; renderRoles(); $('#rolesDlg').showModal(); }
$('#mRoles').addEventListener('click', openRoles);
function renderRoles() {
  const s = curServer(); if (!s) return;
  const mayEdit = can(s, 'server');
  $('#rlTitle').textContent = `Roles in ${s.name}`;
  $('#roleNew').hidden = !mayEdit;
  const ul = $('#rolesList'); ul.textContent = '';
  for (const r of [...(s.roles || [])].sort((a, b) => b.position - a.position)) {
    const li = document.createElement('li');
    const b = document.createElement('button'); b.type = 'button'; b.className = 'role-item' + (editingRole === r.id ? ' on' : '');
    b.innerHTML = '<span class="role-dot"></span>'; b.firstChild.style.background = r.color || 'var(--dim)';
    b.appendChild(document.createTextNode(`${r.name} (${Object.values(s.memberRoles || {}).filter((x) => x.includes(r.id)).length})`));
    b.addEventListener('click', () => { editingRole = r.id; renderRoles(); });
    li.appendChild(b); ul.appendChild(li);
  }
  if (!(s.roles || []).length) ul.innerHTML = '<li class="hint">No roles yet.</li>';
  const r = (s.roles || []).find((x) => x.id === editingRole);
  $('#roleForm').hidden = !r;
  if (!r) return;
  // Unsaved changes live in roleDraft, so redrawing (a color click, someone else's change) keeps them.
  if (!roleDraft || roleDraft.id !== r.id) roleDraft = { id: r.id, name: r.name, color: r.color || '', perms: [...r.perms] };
  $('#roleName').value = roleDraft.name; $('#roleName').disabled = !mayEdit;
  const sw = $('#roleColors'); sw.textContent = '';
  for (const c of ROLE_COLORS) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'swatch' + (c ? '' : ' auto'); b.disabled = !mayEdit;
    b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(c === roleDraft.color)); b.title = c || 'No color'; b.setAttribute('aria-label', b.title);
    b.style.background = c || 'var(--panel-2)';
    b.addEventListener('click', () => { roleDraft.color = c; renderRoles(); });
    sw.appendChild(b);
  }
  const pl = $('#rolePerms'); pl.textContent = '';
  for (const [k, [label, desc]] of Object.entries(PERM_TEXT)) {
    const l = document.createElement('label'); l.className = 'check';
    l.innerHTML = `<input type="checkbox" data-perm="${k}"><span><b></b><small></small></span>`;
    l.querySelector('b').textContent = label; l.querySelector('small').textContent = desc;
    const cb = l.querySelector('input'); cb.checked = roleDraft.perms.includes(k); cb.disabled = !mayEdit;
    cb.addEventListener('change', () => { roleDraft.perms = cb.checked ? [...new Set([...roleDraft.perms, k])] : roleDraft.perms.filter((x) => x !== k); });
    pl.appendChild(l);
  }
  const ml = $('#roleMembers'); ml.textContent = '';
  for (const uid of s.members.filter((id) => !user(id).bot).sort((a, b) => nameOf(a).localeCompare(nameOf(b)))) {
    const l = document.createElement('label'); l.className = 'role-member';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = (s.memberRoles[uid] || []).includes(r.id); cb.disabled = !mayEdit;
    cb.addEventListener('change', () => act(() => live.req('role.assign', { roleId: r.id, userId: uid, on: cb.checked })));
    l.appendChild(cb); l.appendChild(avEl(uid)); l.appendChild(document.createTextNode(nameOf(uid)));
    ml.appendChild(l);
  }
  $('#roleDelete').hidden = !mayEdit;
  $('#roleForm').querySelector('button[type=submit]').hidden = !mayEdit;
}
$('#roleNew').addEventListener('click', async () => {
  const r = await act(() => live.req('role.create', { serverId: curServer().id, name: 'New role', color: '#3d7be8', perms: [] }));
  if (r) { editingRole = r.id; roleDraft = null; renderRoles(); $('#roleName').select(); }
});
$('#roleName').addEventListener('input', () => { if (roleDraft) roleDraft.name = $('#roleName').value; });
$('#roleForm').addEventListener('submit', (e) => {
  e.preventDefault();
  act(() => live.req('role.edit', { id: editingRole, name: roleDraft.name, color: roleDraft.color, perms: roleDraft.perms }), 'Role saved.');
});
$('#roleDelete').addEventListener('click', async () => {
  const s = curServer(), r = (s.roles || []).find((x) => x.id === editingRole);
  if (r && await confirmBox(`Delete the ${r.name} role?`, 'Everyone who has it loses it.', 'Delete')) { await act(() => live.req('role.delete', { id: r.id })); editingRole = null; renderRoles(); }
});

/* ================= soundboard ================= */
function voiceServerId() { const f = V.channelId && findChannel(V.channelId); return f ? f.server.id : null; }
function renderSoundboard() {
  const grid = $('#soundGrid'); grid.textContent = '';
  const sid = voiceServerId(), srv = sid && S.servers.get(sid);
  const btn = (emoji, name, fn, del, keyId) => {
    const wrap = document.createElement('div'); wrap.className = 'sound';
    const b = document.createElement('button'); b.type = 'button'; b.className = 'sound-btn'; b.title = `Play ${name}`;
    b.innerHTML = `<span class="sound-emoji-big" aria-hidden="true"></span><span class="sound-name"></span>`;
    b.firstChild.textContent = emoji; b.lastChild.textContent = name;
    const key = (settings.soundKeys || {})[keyId];
    if (keyCapture === keyId) { const k = document.createElement('span'); k.className = 'sound-key wait'; k.textContent = 'Press keys…'; b.appendChild(k); }
    else if (key) { const k = document.createElement('span'); k.className = 'sound-key'; k.textContent = accelLabel(key); b.appendChild(k); b.title += ` (${accelLabel(key)})`; }
    b.addEventListener('click', () => { if (soundKeysMode) { keyCapture = keyCapture === keyId ? null : keyId; renderSoundboard(); } else fn(); });
    wrap.appendChild(b);
    if (del) { const x = document.createElement('button'); x.type = 'button'; x.className = 'sound-del'; x.title = `Remove ${name}`; x.setAttribute('aria-label', x.title); x.innerHTML = iconSvg('x'); x.addEventListener('click', del); wrap.appendChild(x); }
    grid.appendChild(wrap);
  };
  const play = (data) => live.req('sound.play', data).catch((ex) => toast(ex.message, 3000));
  for (const s of builtinSounds()) btn(s.emoji, s.name, () => play({ builtin: s.id }), null, `b:${s.id}`);
  for (const s of (sid && S.sounds.get(sid)) || []) {
    const mayDelete = s.userId === S.me.id || (srv && can(srv, 'messages'));
    btn(s.emoji, s.name, () => play({ id: s.id }), mayDelete && !soundKeysMode ? async () => { if (await confirmBox(`Remove ${s.name}?`, 'It’s removed from the soundboard for everyone in this server.', 'Remove')) act(() => live.req('sound.delete', { id: s.id })); } : null, `c:${s.id}`);
  }
  $('#soundKeysBtn').setAttribute('aria-pressed', String(soundKeysMode));
  $('#soundKeysBtn').classList.toggle('on', soundKeysMode);
  $('#soundKeysHint').hidden = !soundKeysMode;
  $('#soundKeysHint').textContent = keyCapture ? 'Press a key combination, like Ctrl+Alt+1 or F8. Backspace removes it, Esc cancels.'
    : `Click a sound, then press its keys.${desktop && desktop.setSoundKeys ? ' They work even while you’re in a game.' : ' They work while Party Line is in front (in the desktop app, in any app).'}`;
}
/* ---------- soundboard keys: kept on this device; the desktop app makes them work in any app ---------- */
let soundKeysMode = false, keyCapture = null;
function accelOf(e) {
  const c = e.code;
  const key = /^Key[A-Z]$/.test(c) ? c.slice(3) : /^Digit\d$/.test(c) ? c.slice(5) : /^F([1-9]|1\d|2[0-4])$/.test(c) ? c : /^Numpad\d$/.test(c) ? `num${c.slice(6)}` : null;
  if (!key) return null;
  const mods = [e.ctrlKey || e.metaKey ? 'CommandOrControl' : null, e.altKey ? 'Alt' : null, e.shiftKey ? 'Shift' : null].filter(Boolean);
  // A plain letter or number (or one with only Shift) would go off while typing, so those need Ctrl or Alt.
  if (!/^(F\d|num)/.test(key) && !mods.some((m) => m !== 'Shift')) return null;
  return [...mods, key].join('+');
}
const accelLabel = (a) => a.replace('CommandOrControl', /Mac/.test(navigator.platform) ? 'Cmd' : 'Ctrl').replace(/num(\d)/, 'Num $1');
function syncSoundKeys() {
  if (desktop && desktop.setSoundKeys) desktop.setSoundKeys(Object.entries(settings.soundKeys || {}).map(([id, key]) => ({ id, key })));
}
function playSoundKey(id) {
  if (!V.channelId) return;
  const data = id.startsWith('b:') ? { builtin: id.slice(2) } : { id: Number(id.slice(2)) };
  live.req('sound.play', data).catch((ex) => toast(ex.message, 3000));
}
$('#soundKeysBtn').addEventListener('click', () => { soundKeysMode = !soundKeysMode; keyCapture = null; renderSoundboard(); });
document.addEventListener('keydown', (e) => {
  if (keyCapture) {
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation();
    settings.soundKeys = settings.soundKeys || {};
    if (e.key === 'Backspace' || e.key === 'Delete') delete settings.soundKeys[keyCapture];
    else if (e.key !== 'Escape') {
      const a = accelOf(e);
      if (!a) { toast('Use Ctrl or Alt with a letter or number, or an F key or number pad key.', 3500); return; }
      for (const [id, k] of Object.entries(settings.soundKeys)) if (k === a) delete settings.soundKeys[id];   // one sound per key
      settings.soundKeys[keyCapture] = a;
    }
    keyCapture = null; saveSettings(); syncSoundKeys(); renderSoundboard();
    return;
  }
  if (!V.channelId || isTyping(e.target) || !settings.soundKeys) return;
  const a = accelOf(e), hit = a && Object.entries(settings.soundKeys).find(([, k]) => k === a);
  if (hit) { e.preventDefault(); e.stopPropagation(); playSoundKey(hit[0]); }
}, true);
syncSoundKeys();
/* ---------- voice effects (see Voice.setVoiceFx) ---------- */
const VOICE_FX = [['none', '🙂', 'Normal'], ['robot', '🤖', 'Robot'], ['deep', '🐻', 'Deep'], ['chipmunk', '🐿️', 'Chipmunk'], ['cave', '🏔️', 'Cave echo'], ['radio', '📻', 'Radio']];
for (const box of [$('#fxOpts'), $('#setFx')]) {
  for (const [key, emoji, name] of VOICE_FX) {
    const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'radio'); b.dataset.fx = key; b.textContent = `${emoji} ${name}`;
    b.addEventListener('click', () => { Voice.setVoiceFx(key).then(syncFx); syncFx(); });
    box.appendChild(b);
  }
}
function syncFx() {
  for (const b of document.querySelectorAll('[data-fx]')) b.setAttribute('aria-checked', String(b.dataset.fx === settings.voiceFx));
  const on = VOICE_FX.find(([k]) => k === settings.voiceFx && k !== 'none');
  $('#fxBtn').classList.toggle('active', !!on);
  $('#fxBtn').title = on ? `Voice effect: ${on[2]}` : 'Voice effects';
}
function closeFx() { $('#fxPop').hidden = true; $('#fxBtn').setAttribute('aria-expanded', 'false'); $('#fxHear').checked = false; Voice.setMonitor(false); }
$('#fxBtn').addEventListener('click', () => {
  if (!$('#fxPop').hidden) { closeFx(); return; }
  syncFx();
  const pop = $('#fxPop'); pop.hidden = false;
  const r = $('#fxBtn').getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.left))}px`;
  pop.style.top = `${Math.max(8, r.top - pop.offsetHeight - 8)}px`;
  $('#fxBtn').setAttribute('aria-expanded', 'true');
});
$('#fxHear').addEventListener('change', () => Voice.setMonitor($('#fxHear').checked));
document.addEventListener('pointerdown', (e) => { if (!$('#fxPop').hidden && !e.target.closest('#fxPop, #fxBtn')) closeFx(); });

function openSoundboard() {
  if (!V.channelId) return;
  renderSoundboard();
  $('#soundVol').value = settings.soundVolume ?? 60;
  $('#soundForm').hidden = true; $('#soundAddBtn').hidden = false;
  const pop = $('#soundPop'); pop.hidden = false;
  const r = $('#soundBtn').getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.left))}px`;
  pop.style.top = `${Math.max(8, r.top - pop.offsetHeight - 8)}px`;
  $('#soundBtn').setAttribute('aria-expanded', 'true');
}
function closeSoundboard() { $('#soundPop').hidden = true; $('#soundBtn').setAttribute('aria-expanded', 'false'); soundKeysMode = false; keyCapture = null; }
$('#soundBtn').addEventListener('click', () => ($('#soundPop').hidden ? openSoundboard() : closeSoundboard()));
document.addEventListener('pointerdown', (e) => { if (!$('#soundPop').hidden && !e.target.closest('#soundPop, #soundBtn, #confirmDlg')) closeSoundboard(); });
$('#soundVol').addEventListener('input', () => { settings.soundVolume = Number($('#soundVol').value); saveSettings(); });
let soundFile = null;
$('#soundAddBtn').addEventListener('click', () => { soundFile = null; $('#soundName').value = ''; $('#soundEmoji').value = '🔊'; $('#soundFileName').textContent = 'Pick a short clip: up to 7 seconds and 1 MB.'; $('#soundForm').hidden = false; $('#soundAddBtn').hidden = true; });
$('#soundPick').addEventListener('click', () => $('#soundFile').click());
$('#soundFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (f.size > 1048576) { toast('That file is over 1 MB. Use a shorter clip.', 4000); return; }
  let secs = 0;
  try { secs = await soundLength(f); } catch { toast('That doesn’t look like an audio file this device can play.', 4000); return; }
  if (secs > 7.5) { toast(`That clip is ${Math.round(secs)} seconds long. Sounds can be up to 7 seconds.`, 4500); return; }
  soundFile = f;
  $('#soundFileName').textContent = `${f.name} · ${secs.toFixed(1)} s`;
  if (!$('#soundName').value) $('#soundName').value = f.name.replace(/\.\w+$/, '').slice(0, 24);
});
$('#soundForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!soundFile) { toast('Choose an audio file first.', 3000); return; }
  const sid = voiceServerId();
  const r = await act(async () => { const up = await upload('/api/upload', soundFile); return live.req('sound.add', { serverId: sid, uploadId: up.id, name: $('#soundName').value, emoji: $('#soundEmoji').value.trim() }); }, 'Sound added to the soundboard.');
  if (r) { $('#soundForm').hidden = true; $('#soundAddBtn').hidden = false; }
});

/* ================= events ================= */
const upcoming = (serverId) => (S.events.get(serverId) || []).filter((e) => e.startsAt > Date.now() - 3 * 3600_000).sort((a, b) => a.startsAt - b.startsAt);
function openEvents() {
  const s = curServer();
  if (!s) return;
  $('#evTitle').textContent = `Events in ${s.name}`;
  $('#evForm').hidden = true; $('#evNewBtn').hidden = false;
  renderEvents();
  $('#eventsDlg').showModal();
}
function renderEvents() {
  const s = curServer(), list = $('#evList');
  if (!s) return;
  list.textContent = '';
  const evs = upcoming(s.id);
  $('#evEmpty').hidden = !!evs.length;
  for (const e of evs) {
    const li = document.createElement('li'); li.className = 'ev';
    const d = new Date(e.startsAt), isNow = e.startsAt <= Date.now();
    li.innerHTML = `<div class="ev-date"><b>${d.getDate()}</b><small>${d.toLocaleString(undefined, { month: 'short' })}</small></div><div class="ev-main"></div>`;
    const main = li.querySelector('.ev-main');
    const t = document.createElement('div'); t.className = 'ev-title'; t.textContent = e.title;
    if (isNow) t.insertAdjacentHTML('beforeend', '<span class="chan-live">NOW</span>');
    main.appendChild(t);
    const when = document.createElement('div'); when.className = 'ev-when';
    const ch = e.channelId && findChannel(e.channelId);
    const tc = e.gameVote && e.textChannelId && findChannel(e.textChannelId);
    when.textContent = `${fmtWhen(e.startsAt)} · ${fmtRelative(e.startsAt)}` + (ch ? ` · 🔊 ${ch.channel.name}` : '')
      + (e.gameVote ? ` · 🎮 game vote ${e.gameVote >= 60 ? `${e.gameVote / 60} h` : `${e.gameVote} min`} before${tc ? ` in #${tc.channel.name}` : ''}` : '');
    main.appendChild(when);
    if (e.description) { const p = document.createElement('p'); p.className = 'ev-desc'; p.textContent = e.description; main.appendChild(p); }
    const who = document.createElement('div'); who.className = 'ev-who';
    const names = (ids) => ids.map(nameOf).join(', ');
    who.textContent = `✅ ${e.going.length} going${e.going.length ? ` (${names(e.going)})` : ''}` + (e.maybe.length ? ` · 🤔 ${e.maybe.length} maybe (${names(e.maybe)})` : '');
    main.appendChild(who);
    const btns = document.createElement('div'); btns.className = 'ev-btns';
    const mine = e.going.includes(S.me.id) ? 'going' : e.maybe.includes(S.me.id) ? 'maybe' : '';
    const rsvpBtn = (state, label) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn small' + (mine === state ? ' primary' : ''); b.textContent = label;
      b.setAttribute('aria-pressed', String(mine === state));
      b.addEventListener('click', () => act(() => live.req('event.rsvp', { id: e.id, state: mine === state ? '' : state })));
      btns.appendChild(b);
    };
    rsvpBtn('going', 'Going'); rsvpBtn('maybe', 'Maybe');
    if (isNow && ch) { const j = document.createElement('button'); j.type = 'button'; j.className = 'btn small primary'; j.textContent = 'Join voice'; j.addEventListener('click', () => { $('#eventsDlg').close(); setView({ kind: 'voice', serverId: s.id, channelId: e.channelId }); if (V.channelId !== e.channelId) joinVoice(e.channelId); }); btns.appendChild(j); }
    if (e.creatorId === S.me.id || can(s, 'messages')) {
      const x = document.createElement('button'); x.type = 'button'; x.className = 'link-btn danger'; x.textContent = 'Cancel event';
      x.addEventListener('click', async () => { if (await confirmBox(`Cancel ${e.title}?`, 'It’s removed for everyone, and Party Bot lets the server know.', 'Cancel event')) act(() => live.req('event.delete', { id: e.id })); });
      btns.appendChild(x);
    }
    main.appendChild(btns);
    list.appendChild(li);
  }
}
$('#eventsBtn').addEventListener('click', openEvents);
let evFromChannel = null;   // a game night planned from a chat's 🎮 list is announced (and voted on) there
$('#evNewBtn').addEventListener('click', () => newEventForm());
function newEventForm(preset) {
  const s = curServer();
  evFromChannel = preset && preset.textChannelId || null;
  $('#evVote').value = preset && preset.gameVote ? String(preset.gameVote) : '';
  const sel = $('#evChan'); sel.length = 1;
  for (const c of s.channels.filter((x) => x.kind === 'voice')) sel.add(new Option(c.name, c.id));
  const t = new Date(Date.now() + 86_400_000); t.setMinutes(0, 0, 0); t.setHours(21);
  $('#evWhen').value = new Date(t - t.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  $('#evName').value = preset && preset.title || ''; $('#evDesc').value = '';
  $('#evForm').hidden = false; $('#evNewBtn').hidden = true; $('#evName').focus();
}
$('#evCancelForm').addEventListener('click', () => { $('#evForm').hidden = true; $('#evNewBtn').hidden = false; });
$('#evForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const startsAt = new Date($('#evWhen').value).getTime();
  const r = await act(() => live.req('event.create', { serverId: curServer().id, title: $('#evName').value, startsAt, channelId: $('#evChan').value || null, description: $('#evDesc').value,
    gameVote: Number($('#evVote').value) || null, textChannelId: evFromChannel }), 'Event created. Party Bot told the server.');
  if (r) { $('#evForm').hidden = true; $('#evNewBtn').hidden = false; }
});

/* ================= Party Bot ================= */
function botNote(text) {
  const el = $('#botNoteText'); el.textContent = '';
  richText(el, text);
  $('#botNote').hidden = false;
}
function hideBotNote() { $('#botNote').hidden = true; }
$('#botNoteX').addEventListener('click', hideBotNote);
$('#musicBack').addEventListener('click', () => { listenAgain(); syncMusic(); });
initMusic({
  req: (t, d) => live.req(t, d),
  nameOf,
  channelName: (id) => { const f = findChannel(id); return f ? f.channel.name : ''; },
  note: botNote,
  absUrl,
  changed: () => { $('#musicBack').hidden = !(V.channelId && S.music.get(V.channelId)) || listening(); },
});

/* ================= developer panel ================= */
initDev({
  isAdmin: () => !!(S.me && S.me.admin),
  nameOf,
  diagnostics: Voice.diagnostics,
  channelName: (id) => { const f = findChannel(id); return f ? `${f.channel.name} (${f.server.name})` : `channel ${id}`; },
  rejoin: () => Voice.rejoinVoice(),
  restartMic: () => Voice.setupMic(settings.micId),
  onlinePeople: () => [...S.users.values()].filter((u) => u.online && u.id !== S.me.id).map((u) => u.id),
  isMe: (id) => !!S.me && S.me.id === id,
  appLabel: () => S.appLabel || '',
  avatar: (u) => { if (!S.users.has(u.id)) S.users.set(u.id, { id: u.id, name: u.name, avatar: u.avatar, admin: u.admin, online: false }); return avEl(u.id); },
  resetPassword,
});
$('#mDev').addEventListener('click', () => { closeMenu(); openDev(); });
$('#devOpen').addEventListener('click', () => { $('#settings').close(); openDev(); });
$('#navDev').addEventListener('click', openDev);
$('#frDev').addEventListener('click', openDev);

/* ================= start ================= */
Voice.initVoice({
  myId: () => (S.me ? S.me.id : 0),
  change: () => { if (S.ready) renderVoiceBits(); },
  speaking: renderSpeaking,
  micIssue: (kind) => { if (kind && V.channelId) { micPanelOpen = true; renderMicPanel(); } },
  system: (what, id) => {
    if (what === 'audio-blocked') { $('#audioUnlockRow').hidden = false; log('voice', 'The browser blocked playing sound until a click'); }
    else if (what === 'voice-failed') toast(`Couldn’t connect voice with ${nameOf(id)}. A strict network may be blocking it.`, 6000);
    else toast(what, 4000);
  },
});
const m = location.pathname.match(/^\/invite\/([\w-]+)/);
if (m) { S.pendingInvite = m[1]; history.replaceState(null, '', '/'); }
if (location.search) {
  const q = new URLSearchParams(location.search);
  if (['dm', 'channel', 'call', 'friends'].some((k) => q.has(k))) { S.pendingOpen = q; history.replaceState(null, '', '/'); }
}
if ('serviceWorker' in navigator && window.isSecureContext && !desktop && !phoneApp) navigator.serviceWorker.register('/sw.js').catch(() => {});
if (hasToken()) start(); else showJoinScreen();

/* Esc closes whatever small pop-up, menu or drawer is open (dialogs close themselves; boxes that use Esc themselves,
   like the message box cancelling a reply, mark it handled). */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  let closed = false;
  const shut = (sel, fn) => { const el = $(sel); if (el && !el.hidden) { fn(); closed = true; } };
  shut('#serverMenu', closeMenu);
  shut('#attachMenu', () => { $('#attachMenu').hidden = true; $('#attachBtn').setAttribute('aria-expanded', 'false'); });
  shut('#moreMenu', closeMore);
  shut('#laterPop', closeLater);
  shut('#statusPop', closeStatusPop);
  shut('#emojiPop', closeEmojiPop);
  shut('#remindPop', () => { $('#remindPop').hidden = true; });
  shut('#disappearPop', () => { $('#disappearPop').hidden = true; });
  shut('#notifPop', () => { $('#notifPop').hidden = true; });
  shut('#micPanel', () => { micPanelOpen = false; renderMicPanel(); });
  shut('#soundPop', closeSoundboard);
  shut('#fxPop', closeFx);
  if (!closed && $('#room').classList.contains('drawer-open')) { $('#room').classList.remove('drawer-open'); $('#drawerScrim').hidden = true; closed = true; }
  if (closed) e.preventDefault();
});
