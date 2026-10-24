/* Listen together: when someone uses /play in a voice channel you're in, this plays the same YouTube video
   at the same moment for everyone there, in YouTube's own player (a small window at the bottom right).
   The server keeps the queue and the clock; each device checks every 2 s that it's still in step. */
import { $, iconSvg, settings, saveSettings } from './util.js';

let ctx = null;          // { req(type, data), nameOf(id), channelName(id), note(text), changed() }
let state = null;        // the server's music state for my voice channel: { now, queue }
let channelId = null;    // my voice channel
let offset = 0;          // serverClock - Date.now()
let player = null, playerReady = false, loadedSeq = null;
let api = null;          // Promise for window.YT
let timer = null;
let reported = null;     // seq already reported as ended or failed
let leftSeq = null;      // seq this person chose not to listen to

export function initMusic(c) {
  ctx = c;
  $('#musicPause').addEventListener('click', () => control(state && state.now && state.now.startedAt == null ? 'resume' : 'pause'));
  $('#musicSkip').addEventListener('click', () => control('skip'));
  $('#musicStop').addEventListener('click', () => control('stop'));
  $('#musicHide').addEventListener('click', () => { leftSeq = state && state.now ? state.now.seq : null; teardown(); render(); ctx.changed(); });
  $('#musicStart').addEventListener('click', () => { if (player && playerReady) { player.playVideo(); $('#musicStart').hidden = true; } });
  const vol = $('#musicVol');
  vol.value = settings.musicVolume ?? 60;
  vol.addEventListener('input', () => { settings.musicVolume = Number(vol.value); saveSettings(); if (player && playerReady) player.setVolume(settings.musicVolume); });
}
function control(action) { ctx.req('music.control', { action }).then((r) => { if (r && r.ephemeral) ctx.note(r.ephemeral); }).catch(() => {}); }

/* Called with every update: my voice channel (or null), the music state there, and the server's clock. */
export function updateMusic(myChannelId, st, serverNow) {
  if (serverNow) offset = serverNow - Date.now();
  if (myChannelId !== channelId) leftSeq = null;
  channelId = myChannelId;
  state = st && st.now ? st : null;
  if (state && state.now.seq !== leftSeq) leftSeq = null;
  render();
  if (!state || leftSeq != null) { teardown(); return; }
  ensurePlayer().then(sync);
  if (!timer) timer = setInterval(sync, 2000);
}
export const listening = () => !!(state && leftSeq == null);
export function listenAgain() { leftSeq = null; if (state) { render(); ensurePlayer().then(sync); if (!timer) timer = setInterval(sync, 2000); } }

function render() {
  const card = $('#musicCard');
  const show = !!(state && leftSeq == null);
  card.hidden = !show;
  document.body.classList.toggle('music-on', show);
  if (!state) return;
  const n = state.now;
  $('#musicTitle').textContent = n.title;
  $('#musicBy').textContent = `Added by ${ctx.nameOf(n.by)} · 🔊 ${ctx.channelName(channelId)}`;
  const paused = n.startedAt == null;
  $('#musicPause').innerHTML = iconSvg(paused ? 'play' : 'pause');
  $('#musicPause').title = paused ? 'Resume for everyone' : 'Pause for everyone';
  $('#musicPause').setAttribute('aria-label', $('#musicPause').title);
  const next = state.queue[0];
  $('#musicNext').textContent = next ? `Next: ${next.title}${state.queue.length > 1 ? ` (+${state.queue.length - 1} more)` : ''}` : 'Nothing queued next. Add more with /play';
}

function loadApi() {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (!api) api = new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(window.YT); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { api = null; reject(new Error('YouTube didn’t load')); };
    document.head.appendChild(s);
  });
  return api;
}
function ensurePlayer() {
  return loadApi().then((YT) => {
    if (player || !state) return;
    playerReady = false; loadedSeq = state.now.seq;
    player = new YT.Player('musicPlayer', {
      width: '100%', height: '100%', videoId: state.now.videoId,
      playerVars: { autoplay: 1, controls: 0, disablekb: 1, playsinline: 1, rel: 0, modestbranding: 1, start: Math.floor(expected() || 0) },
      events: {
        onReady: (e) => { if (!player || e.target !== player) return; playerReady = true; player.setVolume(settings.musicVolume ?? 60); sync(); },   // ignore a player closed while loading
        onStateChange: (e) => {
          if (e.data === 0 && state && reported !== state.now.seq) { reported = state.now.seq; ctx.req('music.event', { kind: 'ended', channelId, seq: state.now.seq }).catch(() => {}); }
          if (e.data === 1) $('#musicStart').hidden = true;
        },
        onError: (e) => {
          if (state && reported !== state.now.seq) { reported = state.now.seq; ctx.req('music.event', { kind: 'error', code: e.data, channelId, seq: state.now.seq }).catch(() => {}); }
        },
      },
    });
  }).catch(() => { $('#musicNext').textContent = 'YouTube couldn’t load on this device.'; });
}
function teardown() {
  if (timer) { clearInterval(timer); timer = null; }
  if (player) { try { player.destroy(); } catch {} player = null; }
  playerReady = false; loadedSeq = null;
  // destroy() removes the player's element; put a fresh one back for next time.
  if (!document.getElementById('musicPlayer')) { const d = document.createElement('div'); d.id = 'musicPlayer'; $('#musicFrame').prepend(d); }
}
/* Where the video should be right now, in seconds (negative: it starts in a moment). */
function expected() {
  if (!state) return 0;
  const n = state.now;
  return n.startedAt == null ? n.pausedAt : (Date.now() + offset - n.startedAt) / 1000;
}
function sync() {
  if (!player || !playerReady || !state || leftSeq != null) return;
  const n = state.now;
  if (loadedSeq !== n.seq) { loadedSeq = n.seq; player.loadVideoById({ videoId: n.videoId, startSeconds: Math.max(0, expected()) }); return; }
  const want = expected(), have = player.getCurrentTime() || 0, ps = player.getPlayerState();
  if (n.startedAt == null || want < 0) {
    if (ps === 1 || ps === 3) player.pauseVideo();
    if (Math.abs(have - Math.max(0, want)) > 1) player.seekTo(Math.max(0, want), true);
    return;
  }
  if (Math.abs(have - want) > 2) player.seekTo(want, true);
  if (ps !== 1 && ps !== 3 && ps !== 0) {
    player.playVideo();
    // Browsers may block sound that starts without a click. If it still isn't playing, offer a button.
    setTimeout(() => { if (player && playerReady && player.getPlayerState() !== 1 && state && state.now.startedAt != null) $('#musicStart').hidden = false; }, 1500);
  }
}
