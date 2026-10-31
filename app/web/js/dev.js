/* Developer panel (admins only) and the event log every app keeps.
   Voice events and errors are also reported to the server, so an admin can see what went wrong on a friend's device. */
import { live, api } from './net.js';
import { fmtTime, fmtSize, toast, audioCtx, level } from './util.js';

/* ---------- the log ---------- */
export const events = [];   // this device, newest last
const listeners = new Set();
export function log(kind, text) {
  const e = { at: Date.now(), kind, text: String(text).slice(0, 500), mine: true };
  events.push(e);
  if (events.length > 300) events.shift();
  for (const fn of listeners) fn(e);
  if (kind === 'voice' || kind === 'error') { try { live.send('dev.report', { kind, text: e.text }); } catch {} }
}
window.addEventListener('error', (e) => log('error', `${e.message} (${String(e.filename || '').split('/').pop()}:${e.lineno})`));
window.addEventListener('unhandledrejection', (e) => log('error', `Unhandled: ${e.reason && (e.reason.message || e.reason)}`));
live.on('down', () => log('voice', 'Lost connection to the server'));
live.on('open', () => log('info', 'Connected to the server'));

/* ---------- the panel ---------- */
let ctx = null, dlg = null, tab = 'overview', timer = 0, stats = null, lastDiag = null, serverLog = [];
const answers = new Map();   // userId -> { at, data, prev }
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const dur = (s) => (s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : s < 86400 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`);

export function initDev(c) {
  ctx = c;
  // An admin asked this app how its voice is doing: answer with the same numbers the panel shows.
  live.on('dev.ask', async (d) => {
    const data = await ctx.diagnostics();
    data.events = events.slice(-40);
    data.userAgent = navigator.userAgent;
    live.send('dev.answer', { to: d.from, data });
    toast(`${ctx.nameOf(d.from)} checked your voice connection to help fix problems.`, 4000);
  });
  live.on('dev.log', (d) => { serverLog.push(d.entry); if (serverLog.length > 500) serverLog.shift(); if (dlg && dlg.open && tab === 'log') renderLog(); });
  live.on('dev.answer', (d) => {
    const prev = answers.get(d.userId);
    answers.set(d.userId, { at: Date.now(), data: d.data, prev: prev && prev.data });
    if (dlg && dlg.open && tab === 'people') renderPeople();
  });
  listeners.add(() => { if (dlg && dlg.open && tab === 'log') renderLog(); });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'd' && ctx.isAdmin()) { e.preventDefault(); openDev(); }
  });
}

function build() {
  dlg = el('dialog', 'dev-panel');
  dlg.id = 'devPanel';
  dlg.setAttribute('aria-labelledby', 'devTitle');
  dlg.innerHTML = `
    <div class="set-head"><h2 id="devTitle">Developer</h2>
      <button type="button" class="btn icon-btn" data-close aria-label="Close developer panel"><svg class="ic"><use href="#i-x"/></svg></button></div>
    <div class="tabs dev-tabs" role="tablist">
      <button type="button" class="tab" role="tab" data-tab="overview">Server</button>
      <button type="button" class="tab" role="tab" data-tab="everyone">Everyone</button>
      <button type="button" class="tab" role="tab" data-tab="voice">My voice</button>
      <button type="button" class="tab" role="tab" data-tab="lab">Voice check</button>
      <button type="button" class="tab" role="tab" data-tab="log">Log</button>
      <button type="button" class="tab" role="tab" data-tab="audit">Admin log</button>
      <button type="button" class="tab" role="tab" data-tab="people">Check a friend</button>
      <button type="button" class="tab" role="tab" data-tab="features">Features</button>
      <button type="button" class="tab" role="tab" data-tab="reports">Reports</button>
    </div>
    <div class="dev-body" id="devBody"></div>`;
  document.body.appendChild(dlg);
  dlg.querySelector('[data-close]').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => { clearInterval(timer); timer = 0; stopLab(); });
  dlg.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { if (tab === 'lab' && b.dataset.tab !== 'lab') stopLab(); tab = b.dataset.tab; render(); }));
}
export function openDev() {
  if (!ctx || !ctx.isAdmin()) return;
  if (!dlg) build();
  if (!dlg.open) dlg.showModal();
  render();
  clearInterval(timer);
  let n = 0;
  timer = setInterval(() => { n++; if (tab === 'voice') renderVoice(); else if (tab === 'overview' && n % 5 === 0) render(); }, 1000);
}

async function loadStats() {
  try { stats = await live.req('dev.stats', {}); serverLog = stats.log.slice(); }
  catch (e) { stats = { error: e.message }; }
}
async function render() {
  dlg.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  if (tab === 'overview' || tab === 'everyone' || tab === 'audit' || (tab === 'log' && !stats)) await loadStats();
  if (tab === 'overview') renderOverview();
  else if (tab === 'everyone') renderEveryone();
  else if (tab === 'voice') renderVoice();
  else if (tab === 'log') renderLog();
  else if (tab === 'audit') renderAudit();
  else if (tab === 'lab') renderLab();
  else if (tab === 'features') renderFeatures();
  else if (tab === 'reports') renderReports();
  else renderPeople();
}
const body = () => dlg.querySelector('#devBody');

/* ---------- Server ---------- */
function renderOverview() {
  const b = body(); b.textContent = '';
  if (!stats || stats.error) { b.appendChild(el('p', 'error', stats ? stats.error : 'Loading…')); return; }
  const s = stats.server;
  const grid = el('div', 'dev-cards');
  const card = (label, value, sub, bad) => { const c = el('div', 'dev-card' + (bad ? ' bad' : '')); c.append(el('span', 'dev-label', label), el('b', null, value)); if (sub) c.appendChild(el('small', null, sub)); grid.appendChild(c); };
  card('Up for', dur(s.uptime), `Node ${s.node}`);
  const [commit, date] = String(s.version || '').split(' ');
  card('Server version', commit || 'unknown', commit ? `from ${date || '?'}` : 'updates set it automatically');
  card('Your app', ctx.appLabel() || 'unknown', 'what you’re using right now');
  card('Online now', String(s.online), `${s.connections} open app${s.connections === 1 ? '' : 's'}`);
  card('Accounts', String(s.users), 'anyone with the address can sign up');
  card('Memory', fmtSize(s.rss), `${fmtSize(s.heap)} in use`);
  card('Database', fmtSize(s.dbBytes));
  card('Photos and videos', fmtSize(s.uploads.bytes), `${s.uploads.files} file${s.uploads.files === 1 ? '' : 's'}`);
  card('Voice relay', s.turn ? 'On' : 'Off', s.turn ? 'friends on strict networks can connect' : 'not set up, strict networks may fail', !s.turn);
  card('Media server', s.sfu ? 'On' : 'Off', s.sfu ? 'voice goes through the server' : 'voice goes directly between people');
  b.appendChild(grid);
  b.appendChild(el('h3', 'dev-h', 'Health'));
  if (!s.health || !s.health.length) b.appendChild(el('p', 'hint', '✅ All good: enough disk space and memory, and updates and backups are working. Party Bot messages you privately if that changes.'));
  else for (const t of s.health) b.appendChild(el('p', 'error', t.replace(/`/g, '')));
  b.appendChild(el('h3', 'dev-h', 'Backups'));
  const bk = s.backup;
  b.appendChild(el('p', 'hint', bk && bk.at
    ? `Last nightly backup: ${new Date(bk.at * 1000).toLocaleString()} (${fmtSize(bk.bytes || 0)}). ${bk.offsite ? `Also copied off the server to ${bk.offsite}.` : bk.offsiteError ? `Copying it off the server FAILED: ${bk.offsiteError}` : 'It’s only on this server: download one now and then, or set up off-server copies (see DEPLOY.md).'}`
    : 'Nightly backups are made by the server setup (deploy/backup.sh). You can also download everything right now.'));
  const dl = el('button', 'btn small', 'Download a backup');
  dl.type = 'button'; dl.id = 'devBackup';
  dl.addEventListener('click', async () => {
    dl.disabled = true;
    try {
      const { url } = await api('/api/dev/backup-link', { method: 'POST' });
      const a = document.createElement('a'); a.href = url; a.download = ''; document.body.appendChild(a); a.click(); a.remove();
      toast('Your backup is downloading: every account, message, photo and file. Keep it somewhere safe and private.', 6000);
    } catch (e) { toast(e.message, 5000); }
    finally { dl.disabled = false; }
  });
  b.appendChild(dl);
  b.appendChild(el('h3', 'dev-h', 'Voice channels'));
  if (!stats.voice.length) b.appendChild(el('p', 'hint', 'Nobody is in voice.'));
  const byChan = new Map();
  for (const v of stats.voice) { if (!byChan.has(v.channelId)) byChan.set(v.channelId, []); byChan.get(v.channelId).push(v); }
  for (const [chId, list] of byChan) {
    const box = el('div', 'dev-chan');
    box.appendChild(el('b', null, `${ctx.channelName(chId)} · ${list.length} ${list.length === 1 ? 'person' : 'people'}`));
    const ul = el('ul', 'dev-list');
    for (const v of list) {
      const flags = [v.serverMuted ? 'muted by admin' : v.muted ? 'muted' : null, v.deafened ? 'deafened' : null, v.sharing ? 'sharing screen' : null, v.camera ? 'camera on' : null].filter(Boolean);
      ul.appendChild(el('li', null, `${ctx.nameOf(v.userId)} — in for ${dur(Math.round((Date.now() - v.since) / 1000))}${flags.length ? ' · ' + flags.join(', ') : ''}`));
    }
    box.appendChild(ul); b.appendChild(box);
  }
  b.appendChild(el('h3', 'dev-h', 'Online'));
  b.appendChild(el('p', 'hint', stats.people.map((p) => `${ctx.nameOf(p.userId)}${p.devices > 1 ? ` (${p.devices} devices)` : ''}`).join(', ') || 'Nobody.'));
}

/* ---------- Everyone (every account that ever signed up) ---------- */
let peopleFilter = '';
const ago = (ts) => {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 30 * 86400) return `${Math.round(s / 86400)} days ago`;
  return new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
};
function renderEveryone() {
  const b = body(); b.textContent = '';
  if (!stats || stats.error) { b.appendChild(el('p', 'error', stats ? stats.error : 'Loading…')); return; }
  const list = stats.directory || [];
  const online = list.filter((u) => u.online).length;
  const recent = list.filter((u) => u.lastSeen && Date.now() - u.lastSeen < 7 * 86400_000).length;
  b.appendChild(el('p', 'hint', `${list.length} account${list.length === 1 ? '' : 's'} · ${online} online now · ${recent} active this week`));
  const search = el('input', 'input dev-search');
  search.type = 'search'; search.placeholder = 'Find someone'; search.value = peopleFilter; search.setAttribute('aria-label', 'Find someone');
  search.addEventListener('input', () => { peopleFilter = search.value; draw(); });
  b.appendChild(search);
  const wrap = el('div');
  b.appendChild(wrap);
  function draw() {
    wrap.textContent = '';
    const q = peopleFilter.trim().toLowerCase();
    const rows = list.filter((u) => !q || u.name.toLowerCase().includes(q));
    const tbl = el('table', 'dev-table');
    tbl.innerHTML = '<thead><tr><th>Name</th><th>Last online</th><th>Joined</th><th>Messages</th><th>Servers</th><th>Friends</th><th>Devices</th><th></th></tr></thead>';
    const tb = el('tbody');
    for (const u of rows) {
      const tr = el('tr');
      const name = el('td'), who = el('span', 'dev-name');
      who.appendChild(ctx.avatar(u));
      who.appendChild(el('span', null, u.name + (u.admin ? ' (admin)' : '')));
      name.appendChild(who); tr.appendChild(name);
      const st = el('td', u.online ? 'ok' : null, u.online ? `online now · ${(u.apps || []).join(', ')}` : ago(u.lastSeen));
      tr.appendChild(st);
      tr.appendChild(el('td', null, new Date(u.createdAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })));
      for (const k of ['messages', 'servers', 'friends', 'devices']) tr.appendChild(el('td', null, String(u[k])));
      const acts = el('td', 'dev-acts');
      if (u.online && !ctx.isMe(u.id)) {
        const d = el('button', 'btn small', 'Diagnostics'); d.type = 'button';
        d.addEventListener('click', () => { tab = 'people'; render(); live.req('dev.ask', { userId: u.id }).catch((e) => toast(e.message, 3000)); });
        acts.appendChild(d);
      }
      if (!ctx.isMe(u.id)) {
        const r = el('button', 'btn small', 'Reset password'); r.type = 'button';
        r.addEventListener('click', () => ctx.resetPassword(u.id, u.name));
        acts.appendChild(r);
      }
      tr.appendChild(acts);
      tb.appendChild(tr);
    }
    tbl.appendChild(tb);
    wrap.appendChild(rows.length ? tbl : el('p', 'hint', 'Nobody by that name.'));
  }
  draw();
}

/* ---------- My voice ---------- */
function peerTable(d, prev) {
  const tbl = el('table', 'dev-table');
  tbl.innerHTML = '<thead><tr><th>Friend</th><th>Link</th><th>Path</th><th>Ping</th><th>Loss</th><th>Jitter</th><th>In</th><th>Out</th><th>Level</th></tr></thead>';
  const tb = el('tbody');
  for (const p of d.peers) {
    const q = prev && prev.peers.find((x) => x.userId === p.userId);
    const secs = prev ? Math.max(0.5, (d.at - prev.at) / 1000) : 1;
    const kbps = (now, old) => (now != null && old != null ? `${Math.max(0, Math.round(((now - old) * 8) / 1000 / secs))} kbps` : '–');
    const lossPct = p.in && p.in.packets ? `${((100 * Math.max(0, p.in.lost)) / (p.in.packets + Math.max(0, p.in.lost))).toFixed(1)}%` : '–';
    const tr = el('tr');
    const inKbps = kbps(p.in && p.in.bytes, q && q.in && q.in.bytes);
    const deadIn = prev && inKbps === '0 kbps';
    const cells = [
      ctx.nameOf(p.userId),
      p.state ? `${p.state}${p.ice && p.ice !== p.state ? ` / ${p.ice}` : ''}` : p.net,
      p.path ? `${p.path.relayed ? 'relayed' : 'direct'} ${p.path.protocol || ''} (${p.path.local}→${p.path.remote})` : d.mode === 'media server' ? 'media server' : '–',
      p.path && p.path.rttMs != null ? `${p.path.rttMs} ms` : '–',
      lossPct,
      p.in ? `${p.in.jitterMs} ms` : '–',
      inKbps,
      kbps(p.out && p.out.bytes, q && q.out && q.out.bytes),
      p.in ? String(p.in.level) : p.hearing ? 'yes' : 'no',
    ];
    cells.forEach((c, i) => { const td = el('td', null, c); if ((i === 1 && /failed|disconnected/.test(c)) || (i === 6 && deadIn)) td.className = 'bad'; tr.appendChild(td); });
    tb.appendChild(tr);
  }
  tbl.appendChild(tb);
  return tbl;
}
function micSummary(d) {
  const ul = el('ul', 'dev-facts');
  const add = (k, v, bad) => { const li = el('li', bad ? 'bad' : null); li.append(el('span', null, k), el('b', null, v)); ul.appendChild(li); };
  add('In voice', d.inVoice ? `${ctx.channelName(d.inVoice)} (${d.mode})` : 'no');
  add('Microphone', d.mic ? `${d.mic.label || 'mic'} · ${d.mic.state}${d.mic.muted ? ' · muted by computer' : ''}` : 'not started', !!(d.mic && (d.mic.state !== 'live' || d.mic.muted)));
  add('Sending', d.send ? (d.send.live ? 'yes' : d.muted ? 'no (muted)' : d.deafened ? 'no (deafened)' : d.ptt ? 'no (push to talk)' : 'no') + (d.send.state !== 'live' ? ` · track ${d.send.state}` : '') : '–', !!(d.send && d.send.state !== 'live'));
  add('Mic problem', d.micIssue || 'none', !!d.micIssue);
  add('Noise filter', `${d.noise}${d.noise === 'strong' ? (d.filterRunning ? ' (running)' : ' (not running)') : ''}`);
  add('Audio engine', d.audio ? `${d.audio.state} · ${d.audio.sampleRate} Hz` : '–', !!(d.audio && d.audio.state !== 'running'));
  return ul;
}
async function renderVoice() {
  const d = await ctx.diagnostics();
  const prev = lastDiag; lastDiag = d;
  if (!dlg.open || tab !== 'voice') return;
  const b = body(); b.textContent = '';
  b.appendChild(micSummary(d));
  if (d.peers.length) b.appendChild(peerTable(d, prev));
  else b.appendChild(el('p', 'hint', d.inVoice ? 'Nobody else is in your voice channel.' : 'Join a voice channel to see live connection numbers.'));
  const row = el('div', 'pop-btns dev-actions');
  const btn = (label, fn) => { const x = el('button', 'btn small', label); x.type = 'button'; x.addEventListener('click', fn); row.appendChild(x); };
  btn('Rejoin voice', () => ctx.rejoin());
  btn('Restart mic', () => ctx.restartMic());
  btn('Copy report', () => navigator.clipboard.writeText(JSON.stringify({ diagnostics: d, events: events.slice(-80) }, null, 2)).then(() => toast('Copied.', 1500)));
  b.appendChild(row);
  b.appendChild(el('p', 'hint', 'In and Out should stay above about 10 kbps while you’re connected. 0 kbps in red means audio stopped arriving from that friend.'));
}

/* ---------- Voice check: try the voice effects without being in a call ----------
   Its own microphone, so it works anywhere and friends in a call never hear it. Sound goes
   (live mic or a 5-second recording) → input → the effect → out → your speakers. */
const lab = { stream: null, source: null, micAn: null, input: null, out: null, outAn: null, chain: null, fx: 'none', seq: 0, live: false, rec: null, recAt: 0, buffer: null, player: null, raf: 0, note: '' };
const freeChain = (ch) => { for (const n of (ch && ch.nodes) || []) { try { n.stop && n.stop(); } catch {} try { n.disconnect(); } catch {} } };
const fxName = (k) => { const f = ctx.voiceLab.effects.find(([key]) => key === k); return f ? `${f[1]} ${f[2]}` : k; };
async function labWire() {
  const c = audioCtx(), my = ++lab.seq;
  if (!lab.input) {
    lab.input = c.createGain(); lab.out = c.createGain(); lab.outAn = c.createAnalyser(); lab.outAn.fftSize = 512;
    lab.out.connect(lab.outAn); lab.out.connect(c.destination);
  }
  let chain = null;
  try { chain = await ctx.voiceLab.build(lab.fx); } catch { toast('That effect can’t run on this device.', 3000); }
  if (my !== lab.seq) { freeChain(chain); return; }   // another effect was picked meanwhile
  try { lab.input.disconnect(); } catch {}
  freeChain(lab.chain); lab.chain = chain;
  if (chain) { lab.input.connect(chain.input); chain.output.connect(lab.out); } else lab.input.connect(lab.out);
}
async function labStartMic() {
  try { lab.stream = await ctx.voiceLab.mic(); }
  catch { lab.note = 'The microphone didn’t start. Check that Party Line is allowed to use it.'; renderLab(); return; }
  const c = audioCtx();
  lab.source = c.createMediaStreamSource(lab.stream);
  lab.micAn = c.createAnalyser(); lab.micAn.fftSize = 512; lab.source.connect(lab.micAn);
  lab.note = '';
  await labWire();
  renderLab();
}
function labSetLive(on) {
  lab.live = !!on && !!lab.source;
  try { lab.source && lab.source.disconnect(lab.input); } catch {}
  if (lab.live) { labStopPlay(); lab.source.connect(lab.input); }
  renderLab();
}
function labStopPlay() { const p = lab.player; lab.player = null; if (p) { try { p.stop(); } catch {} try { p.disconnect(); } catch {} } }
function labPlay() {
  if (!lab.buffer || !lab.input) return;
  labStopPlay();
  const s = audioCtx().createBufferSource(); s.buffer = lab.buffer; s.connect(lab.input);
  s.onended = () => { if (lab.player === s) { lab.player = null; renderLab(); } };
  s.start(); lab.player = s;
  renderLab();
}
function labRecord() {
  if (!lab.stream || lab.rec || typeof MediaRecorder !== 'function') return;
  if (lab.live) labSetLive(false);
  labStopPlay();
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
  const rec = new MediaRecorder(lab.stream, mime ? { mimeType: mime } : undefined), chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = async () => {
    if (lab.rec !== rec) return;
    lab.rec = null;
    try { lab.buffer = await audioCtx().decodeAudioData(await new Blob(chunks, { type: rec.mimeType }).arrayBuffer()); lab.note = ''; labPlay(); }
    catch { lab.note = 'Couldn’t play the recording back on this device. Try “Hear myself live” instead.'; renderLab(); }
  };
  lab.rec = rec; lab.recAt = Date.now();
  rec.start();
  setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, 5000);
  renderLab();
}
async function labPick(k) {
  lab.fx = k;
  renderLab();
  if (!lab.input) return;
  await labWire();
  if (lab.buffer && !lab.live && !lab.rec) labPlay();   // hear the same recording through the new effect
}
function stopLab() {
  cancelAnimationFrame(lab.raf); lab.raf = 0;
  if (lab.rec) { const r = lab.rec; lab.rec = null; try { r.stop(); } catch {} }
  labStopPlay();
  lab.live = false;
  try { lab.source && lab.source.disconnect(); } catch {}
  if (lab.stream) lab.stream.getTracks().forEach((t) => t.stop());
  lab.stream = null; lab.source = null; lab.micAn = null;
  freeChain(lab.chain); lab.chain = null; lab.seq++;
  try { lab.input && lab.input.disconnect(); } catch {}
  try { lab.out && lab.out.disconnect(); } catch {}
  lab.input = null; lab.out = null; lab.outAn = null;
}
function labMeters() {
  lab.raf = 0;
  if (!dlg || !dlg.open || tab !== 'lab') return;
  const set = (id, an) => { const i = dlg.querySelector(`#${id} i`); if (i) i.style.width = `${Math.min(100, level(an) * 400)}%`; };
  set('labMicMeter', lab.micAn); set('labOutMeter', lab.outAn);
  const t = dlg.querySelector('#labRecLeft');
  if (t && lab.rec) t.textContent = `Recording… ${Math.max(0, Math.ceil(5 - (Date.now() - lab.recAt) / 1000))}`;
  lab.raf = requestAnimationFrame(labMeters);
}
function renderLab() {
  if (!dlg || !dlg.open || tab !== 'lab') return;
  const b = body(); b.textContent = '';
  b.appendChild(el('p', 'hint', 'Try the voice effects without joining a call. Only you hear this — friends in a call don’t.'));
  const btn = (label, fn, cls = 'btn small') => { const x = el('button', cls, label); x.type = 'button'; x.addEventListener('click', fn); return x; };
  if (!lab.stream) {
    const row = el('div', 'pop-btns dev-actions');
    row.appendChild(btn('🎤 Start microphone', labStartMic, 'btn primary'));
    b.appendChild(row);
  } else {
    const meters = el('div', 'lab-meters');
    for (const [id, label] of [['labMicMeter', 'Your microphone'], ['labOutMeter', 'What comes out']]) {
      const m = el('div', 'lab-meter'); m.appendChild(el('span', 'dev-label', label));
      const bar = el('div', 'meter'); bar.id = id; bar.appendChild(el('i')); m.appendChild(bar); meters.appendChild(m);
    }
    b.appendChild(meters);
  }
  if (lab.note) b.appendChild(el('p', 'error', lab.note));

  b.appendChild(el('h3', 'dev-h', 'Effect'));
  const opts = el('div', 'dis-opts fx-opts lab-fx'); opts.setAttribute('role', 'radiogroup'); opts.setAttribute('aria-label', 'Effect to try');
  for (const [key, emoji, name] of ctx.voiceLab.effects) {
    const x = btn(`${emoji} ${name}`, () => labPick(key), ''); x.setAttribute('role', 'radio'); x.dataset.labfx = key;
    x.setAttribute('aria-checked', String(key === lab.fx)); opts.appendChild(x);
  }
  b.appendChild(opts);

  b.appendChild(el('h3', 'dev-h', 'Listen'));
  const row = el('div', 'pop-btns dev-actions');
  const liveBtn = btn(lab.live ? '🎧 Stop hearing myself' : '🎧 Hear myself live', () => labSetLive(!lab.live));
  liveBtn.id = 'labLive'; liveBtn.setAttribute('aria-pressed', String(lab.live)); liveBtn.disabled = !lab.stream;
  const recBtn = btn('⏺ Record 5 seconds', labRecord); recBtn.id = 'labRec'; recBtn.disabled = !lab.stream || !!lab.rec;
  if (lab.rec) { recBtn.textContent = ''; const t = el('span', null, 'Recording… 5'); t.id = 'labRecLeft'; recBtn.appendChild(t); }
  const playBtn = btn(lab.player ? '⏹ Stop' : '▶ Play it back', () => (lab.player ? (labStopPlay(), renderLab()) : labPlay())); playBtn.id = 'labPlay'; playBtn.disabled = !lab.buffer || !!lab.rec;
  row.append(liveBtn, recBtn, playBtn);
  b.appendChild(row);
  b.appendChild(el('p', 'hint', lab.live ? 'Wear headphones, or it echoes.'
    : lab.buffer ? `Playing your recording${lab.player ? ` through ${fxName(lab.fx)}` : ''}. Click another effect to hear the same words through it.`
      : 'Record yourself saying something, then click through the effects to hear it each way. No headphones needed.'));

  b.appendChild(el('h3', 'dev-h', 'In calls'));
  const use = el('div', 'pop-btns dev-actions');
  const cur = ctx.voiceLab.current();
  const useBtn = btn(cur === lab.fx ? `✓ Friends hear you as ${fxName(lab.fx)}` : `Use ${fxName(lab.fx)} in calls`, async () => { await ctx.voiceLab.use(lab.fx); toast(lab.fx === 'none' ? 'Voice effect off in calls.' : `In calls, friends now hear you as ${fxName(lab.fx)}.`, 3000); renderLab(); });
  useBtn.id = 'labUse'; useBtn.disabled = cur === lab.fx;
  use.appendChild(useBtn);
  b.appendChild(use);
  if (!lab.raf && lab.stream) lab.raf = requestAnimationFrame(labMeters);
}

/* ---------- Features: how much friends use each one (see server/src/usage.js), least used first ---------- */
const dayLabel = (k) => new Date(`${k}T12:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' });
async function renderFeatures() {
  const b = body(); b.textContent = '';
  b.appendChild(el('p', 'hint', 'Loading…'));
  let s;
  try { s = await live.req('usage.stats', {}); } catch (e) { b.textContent = ''; b.appendChild(el('p', 'error', e.message)); return; }
  if (!dlg.open || tab !== 'features') return;
  b.textContent = '';
  b.appendChild(el('p', 'hint', `How often friends used each feature in the last 7 days, least used first. ${s.people} ${s.people === 1 ? 'person was' : 'people were'} active. `
    + `${s.since ? `Counting since ${dayLabel(s.since)}.` : 'Nothing counted yet.'} Party Bot sends you this report every Monday morning.`));
  const row = el('div', 'pop-btns dev-actions');
  const send = el('button', 'btn small', 'Send me the report now'); send.type = 'button'; send.id = 'usageSend';
  send.addEventListener('click', () => live.req('usage.send', {}).then(() => toast('Party Bot sent you the report privately.', 3000), (e) => toast(e.message, 3000)));
  row.appendChild(send); b.appendChild(row);
  const t = el('table', 'dev-table usage-table'), head = el('tr');
  for (const h of ['Feature', 'Last 7 days', 'People', 'Week before', 'Last used']) head.appendChild(el('th', null, h));
  t.appendChild(el('thead')).appendChild(head);
  const tb = el('tbody'); t.appendChild(tb);
  for (const f of s.features) {
    const tr = el('tr', f.off ? 'off' : !f.uses ? 'unused' : null); tr.dataset.key = f.key;
    const name = el('td'); name.appendChild(el('b', null, f.name)); name.appendChild(el('small', null, f.off ? `Off: ${f.off}` : f.where)); tr.appendChild(name);
    tr.appendChild(el('td', f.uses || f.off ? null : 'zero', f.off ? '–' : String(f.uses)));
    tr.appendChild(el('td', null, f.off ? '–' : String(f.people)));
    tr.appendChild(el('td', null, f.off ? '–' : String(f.before)));
    tr.appendChild(el('td', null, f.lastDay ? dayLabel(f.lastDay) : 'never'));
    tb.appendChild(tr);
  }
  b.appendChild(t);
}

/* ---------- Reports: messages and people friends reported (server: M.addReport), open ones first ---------- */
async function renderReports(list) {
  const b = body();
  if (!list) {
    b.textContent = ''; b.appendChild(el('p', 'hint', 'Loading…'));
    try { list = (await live.req('report.list', {})).reports; } catch (e) { b.textContent = ''; b.appendChild(el('p', 'error', e.message)); return; }
  }
  if (!dlg.open || tab !== 'reports') return;
  b.textContent = '';
  const open = list.filter((r) => !r.handledAt).length;
  b.appendChild(el('p', 'hint', open ? `${open} report${open === 1 ? '' : 's'} to look at. Party Bot tells you about each new one.` : 'Nothing to look at. When someone reports a message or a person, it shows here and Party Bot tells you.'));
  const ul = el('ul', 'report-list');
  for (const r of list) {
    const li = el('li', r.handledAt ? 'done' : null); li.dataset.id = r.id;
    li.appendChild(el('b', null, `🚩 ${r.reasonText} · about ${r.user ? r.user.name : 'a deleted account'}`));
    li.appendChild(el('small', null, `Reported by ${r.reporter ? r.reporter.name : 'a deleted account'} · ${fmtTime(r.at)}${r.handledAt ? ` · ${r.outcome}` : ''}`));
    if (r.excerpt) li.appendChild(el('blockquote', null, r.excerpt));
    if (r.note) li.appendChild(el('p', null, `“${r.note}”`));
    if (!r.handledAt) {
      const row = el('div', 'pop-btns dev-actions');
      const act = (label, action, cls) => {
        const x = el('button', cls || 'btn small', label); x.type = 'button';
        x.addEventListener('click', async () => {
          try { renderReports((await live.req('report.resolve', { id: r.id, action })).reports); } catch (e) { toast(e.message, 3000); }
        });
        row.appendChild(x);
      };
      if (r.messageId) act('Delete the message', 'delete', 'btn small danger');
      act(r.messageId ? 'Keep it' : 'Done', 'dismiss');
      li.appendChild(row);
      if (r.user) li.appendChild(el('small', 'hint', `To remove ${r.user.name} from a server, click their name in it → Remove from server.`));
    }
    ul.appendChild(li);
  }
  b.appendChild(ul);
}

/* ---------- Log ---------- */
let logFilter = 'all';
function renderLog() {
  const b = body(); b.textContent = '';
  const filters = el('div', 'dev-filters');
  for (const [k, label] of [['all', 'Everyone'], ['voice', 'Voice problems'], ['error', 'Errors'], ['mine', 'This device']]) {
    const x = el('button', 'tab', label); x.type = 'button'; x.setAttribute('aria-selected', String(logFilter === k));
    x.addEventListener('click', () => { logFilter = k; renderLog(); });
    filters.appendChild(x);
  }
  b.appendChild(filters);
  const all = logFilter === 'mine' ? events.slice() : serverLog.filter((e) => logFilter === 'all' || e.kind === logFilter);
  const ol = el('ol', 'dev-log');
  for (const e of all.slice(-300).reverse()) {
    const li = el('li', `k-${e.kind}`);
    li.append(el('time', null, `${new Date(e.at).toLocaleDateString([], { day: 'numeric', month: 'short' })} ${fmtTime(e.at)}:${String(new Date(e.at).getSeconds()).padStart(2, '0')}`),
      el('span', 'dev-kind', e.kind), el('b', null, e.mine ? 'this device' : ctx.nameOf(e.userId)), el('span', 'dev-text', e.text));
    ol.appendChild(li);
  }
  if (!all.length) b.appendChild(el('p', 'hint', 'Nothing logged yet. Voice problems and errors from everyone’s app show up here as they happen.'));
  b.appendChild(ol);
}

/* ---------- Admin log: who deleted, kicked, muted or changed what ---------- */
function renderAudit() {
  const b = body(); b.textContent = '';
  if (!stats || stats.error) { b.appendChild(el('p', 'error', stats ? stats.error : 'Loading…')); return; }
  const list = stats.audit || [];
  if (!list.length) { b.appendChild(el('p', 'hint', 'Nothing yet. When someone deletes another person’s message, removes or mutes someone, or changes channels and roles, it shows up here.')); return; }
  const tbl = el('table', 'dev-table');
  tbl.innerHTML = '<thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th><th>Server</th></tr></thead>';
  const tb = el('tbody');
  for (const a of list) {
    const tr = el('tr');
    tr.append(el('td', null, `${new Date(a.at).toLocaleDateString([], { day: 'numeric', month: 'short' })} ${fmtTime(a.at)}`), el('td', null, a.actor || '?'),
      el('td', null, a.action), el('td', 'dev-text', a.details || ''), el('td', null, a.server || ''));
    tb.appendChild(tr);
  }
  tbl.appendChild(tb); b.appendChild(tbl);
}

/* ---------- Check a friend ---------- */
async function renderPeople() {
  const b = body(); b.textContent = '';
  b.appendChild(el('p', 'hint', 'Get a friend’s live voice numbers from their device. They get a short note that you checked.'));
  const people = ctx.onlinePeople();
  if (!people.length) b.appendChild(el('p', 'hint', 'Nobody else is online.'));
  for (const id of people) {
    const box = el('div', 'dev-chan');
    const head = el('div', 'dev-row');
    head.appendChild(el('b', null, ctx.nameOf(id)));
    const ask = el('button', 'btn small', answers.has(id) ? 'Check again' : 'Get diagnostics'); ask.type = 'button';
    ask.addEventListener('click', () => live.req('dev.ask', { userId: id }).then(() => { ask.textContent = 'Asking…'; }).catch((e) => toast(e.message, 3000)));
    head.appendChild(ask);
    box.appendChild(head);
    const a = answers.get(id);
    if (a) {
      box.appendChild(el('small', 'hint', `Checked at ${fmtTime(a.at)} · ${a.data.userAgent ? a.data.userAgent.replace(/.*\) /, '').slice(0, 80) : ''}`));
      box.appendChild(micSummary(a.data));
      if (a.data.peers && a.data.peers.length) box.appendChild(peerTable(a.data, a.prev));
      if (a.data.events && a.data.events.length) {
        const ol = el('ol', 'dev-log small');
        for (const e of a.data.events.slice(-12).reverse()) { const li = el('li', `k-${e.kind}`); li.append(el('time', null, fmtTime(e.at)), el('span', 'dev-kind', e.kind), el('span', 'dev-text', e.text)); ol.appendChild(li); }
        box.appendChild(ol);
      }
    }
    b.appendChild(box);
  }
}
