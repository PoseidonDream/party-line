/* Voice and screen sharing. Everyone in a voice channel connects directly to everyone else (WebRTC);
   the server only passes the handshakes along. The microphone runs through an optional noise filter. */
import { api, live, absUrl } from './net.js';
import { settings, saveSettings, friendVols, clampLevel, audioCtx, makeAnalyser, level, toast } from './util.js';
import { log } from './dev.js';

export const V = {
  channelId: null, serverId: null, joining: false,
  muted: false, deafened: false, serverMuted: false, pttHeld: false,
  sharing: false, screenStream: null,
  camera: false, camStream: null,
  rawStream: null, micStream: null, sendTrack: null, noMic: true, micIssue: null, fx: null,
  peers: new Map(),   // userId -> peer
  members: new Map(), // userId -> voice channel they're in (everyone the server told us about)
  speaking: new Set(),
  ice: null,
};
let hooks = { myId: () => 0, change: () => {}, speaking: () => {}, micIssue: () => {}, system: () => {} };
export function initVoice(h) { hooks = Object.assign(hooks, h); setInterval(speakLoop, 120); setInterval(heal, 2000); }

/* ================= microphone ================= */
export function issueFromError(err) {
  switch (err && err.name) {
    case 'NotAllowedError': case 'SecurityError': return 'blocked';
    case 'NotFoundError': case 'OverconstrainedError': return 'notfound';
    case 'NotReadableError': case 'AbortError': return 'busy';
    case 'NoMedia': return 'unsupported';
    default: return 'unknown';
  }
}
function acquireMic(deviceId) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const e = new Error('no media'); e.name = 'NoMedia'; return Promise.reject(e);
  }
  return navigator.mediaDevices.getUserMedia({
    audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: true, noiseSuppression: settings.noiseMode !== 'off', autoGainControl: true },
  });
}
const silentStream = () => audioCtx().createMediaStreamDestination().stream;

let workletReady = null;
function loadDenoiser() {
  const c = audioCtx();
  if (!c.audioWorklet || typeof AudioWorkletNode !== 'function') return Promise.reject(new Error('no worklet'));
  if (!workletReady) workletReady = c.audioWorklet.addModule('/denoise-worklet.js').catch((e) => { workletReady = null; throw e; });
  return workletReady;
}
function teardownFx() {
  const fx = V.fx; V.fx = null;
  if (!fx) return;
  for (const n of [fx.source, fx.node, fx.gain]) { try { n && n.disconnect(); } catch {} }
}
// The mic goes through the audio engine when the Strong filter is on or your mic volume isn't 100%.
const needsFx = () => settings.noiseMode === 'strong' || Math.abs(settings.inputVol - 1) > 0.004;
async function buildSend(raw) {
  if (!needsFx()) { teardownFx(); return raw; }
  let c, source;
  try { c = audioCtx(); source = c.createMediaStreamSource(raw); } catch { teardownFx(); return raw; }
  let node = null;
  if (settings.noiseMode === 'strong') {
    try {
      await loadDenoiser();
      node = new AudioWorkletNode(c, 'pl-denoise', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { strength: 1 } });
    } catch {
      settings.noiseMode = 'standard'; saveSettings();
      toast("The Strong noise filter can't run here, so the Standard filter is on instead.", 6000);
    }
  }
  const gain = c.createGain();
  gain.gain.value = settings.inputVol;
  const dest = c.createMediaStreamDestination();
  try { dest.channelCount = 1; } catch {}
  if (node) { source.connect(node); node.connect(gain); } else source.connect(gain);
  gain.connect(dest);
  teardownFx();
  V.fx = { source, node, gain, dest };
  return dest.stream;
}
export let localMeter = { source: null, analyser: null };
async function installMic(raw, real) {
  const send = real ? await buildSend(raw) : raw;
  const oldRaw = V.rawStream, oldSend = V.micStream;
  V.rawStream = raw; V.micStream = send; V.sendTrack = send.getAudioTracks()[0] || null;
  if (send !== raw) raw.getAudioTracks().forEach((t) => { t.enabled = true; });
  for (const p of V.peers.values()) if (p.micSender) p.micSender.replaceTrack(V.sendTrack).catch(() => {});
  if (lk && lk.mic && V.sendTrack) lk.mic.track.replaceTrack(V.sendTrack, true).catch(() => {});
  const keep = new Set([...raw.getTracks(), ...send.getTracks()]);
  for (const st of [oldRaw, oldSend]) if (st) st.getTracks().forEach((t) => { if (!keep.has(t)) t.stop(); });
  try { localMeter.source && localMeter.source.disconnect(); } catch {}
  localMeter = makeAnalyser(send);
  const track = raw.getAudioTracks()[0];
  if (!track || !real) return;
  track.addEventListener('ended', () => { log('voice', `Microphone stopped (${track.label || 'mic'})`); if (V.rawStream === raw) { V.noMic = true; applyMic(); setIssue('disconnected'); } });
  track.addEventListener('mute', () => { log('voice', 'The computer muted the microphone'); setTimeout(() => { if (V.rawStream === raw && track.muted && !V.noMic) setIssue('osmuted'); }, 1500); });
  track.addEventListener('unmute', () => { log('info', 'Microphone unmuted by the computer'); if (V.rawStream === raw && V.micIssue === 'osmuted') setIssue(null); });
}
function setIssue(kind) { if (V.micIssue !== kind) { V.micIssue = kind; hooks.micIssue(kind); hooks.change(); } }
export async function setupMic(deviceId = settings.micId) {
  let stream = null, err = null;
  try { stream = await acquireMic(deviceId); }
  catch (e) {
    err = e;
    if (deviceId && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) {
      try { stream = await acquireMic(''); err = null; } catch (e2) { err = e2; }
    }
  }
  if (stream) {
    await installMic(stream, true); V.noMic = false;
    const t = stream.getAudioTracks()[0];
    setIssue(t && t.muted ? 'osmuted' : null);
  } else {
    if (!V.micStream) await installMic(silentStream(), false);
    V.noMic = true;
    setIssue(issueFromError(err));
    log('voice', `Microphone didn’t start: ${err && (err.name + ' ' + err.message)}`);
  }
  applyMic(); hooks.change();
  return err;
}
export async function chooseMic(id) { settings.micId = id; saveSettings(); if (V.rawStream) return setupMic(id); return null; }
export function stopMic() {
  for (const st of [V.rawStream, V.micStream]) if (st) st.getTracks().forEach((t) => t.stop());
  teardownFx();
  V.rawStream = V.micStream = V.sendTrack = null; V.noMic = true;
}
export async function setNoiseMode(mode) {
  if (!['off', 'standard', 'strong'].includes(mode) || settings.noiseMode === mode) return;
  const prev = settings.noiseMode;
  settings.noiseMode = mode; saveSettings();
  if (V.rawStream && !V.noMic) {
    if ((prev === 'off') !== (mode === 'off')) await setupMic(settings.micId);   // the browser's own filter needs a fresh stream
    else { await installMic(V.rawStream, true); applyMic(); }
  }
  hooks.change();
}
let rebuilding = null;
export function setInputVol(v) {
  settings.inputVol = clampLevel(v); saveSettings();
  if (V.fx && V.fx.gain) { V.fx.gain.gain.setTargetAtTime(settings.inputVol, audioCtx().currentTime, 0.03); return; }
  if (!needsFx() || !V.rawStream || V.noMic || rebuilding) return;
  rebuilding = installMic(V.rawStream, true).then(applyMic).finally(() => { rebuilding = null; });
}
export const micLive = () => !!V.channelId && !V.muted && !V.serverMuted && !V.deafened && !V.noMic && (!settings.ptt || V.pttHeld);
export function applyMic() { if (V.sendTrack) V.sendTrack.enabled = micLive(); }

/* ================= joining and leaving ================= */
export async function joinVoice(channelId) {
  if (V.joining) return;
  V.joining = true; hooks.change();
  try {
    if (!V.micStream) await setupMic(settings.micId);
    // Asked every time: relay passwords expire, and the media server may have been switched on or off.
    try { const r = await api('/api/ice'); V.ice = r.iceServers; V.sfu = !!r.sfu; }
    catch { if (!V.ice) { V.ice = [{ urls: 'stun:stun.l.google.com:19302' }]; V.sfu = false; } }
    if (V.channelId) closeAllPeers();
    const r = await live.req('voice.join', { channelId, muted: V.muted, deafened: V.deafened });
    log('info', `Joined voice channel ${channelId} (${V.sfu ? 'media server' : 'direct'}, ${r.peers.length} already there)`);
    V.channelId = channelId;
    V.serverMuted = false;
    holdCallLock();
    if (V.sfu) {
      try { await sfuConnect(channelId); }
      catch (e) { leaveVoice(); throw new Error(`Couldn’t connect to voice: ${e.message}`); }
    } else for (const id of r.peers) getPeer(id);   // we're the newcomer, so we start the handshakes
    for (const id of r.peers) V.members.set(id, channelId);
    if (V.sharing) sendVoiceState();
    applyMic(); applyAllVolumes();
  } finally { V.joining = false; hooks.change(); }
}
export function leaveVoice(notifyServer = true) {
  if (!V.channelId) return;
  log('info', notifyServer ? 'Left voice' : 'Removed from voice');
  if (notifyServer) live.send('voice.leave', {});
  if (V.sharing) stopShare(false);
  if (V.camera) stopCamera(false);
  closeAllPeers();
  V.channelId = null; V.serverId = null; V.serverMuted = false;
  releaseCallLock();
  stopMic();
  hooks.change();
}
/* After the connection to the server comes back, the server has forgotten our voice spot: take it again. */
export async function rejoinVoice() {
  const id = V.channelId;
  if (!id) return;
  log('voice', 'Rejoining voice after a lost connection');
  closeAllPeers();
  V.channelId = null;
  try { await joinVoice(id); } catch { leaveVoice(false); hooks.system('You were disconnected from voice.'); }
}
export function sendVoiceState() {
  if (!V.channelId) return;
  live.send('voice.state', { muted: V.muted, deafened: V.deafened, sharing: V.sharing, screenId: V.screenStream ? V.screenStream.id : null, camera: V.camera });
}
export function setMuted(b) { V.muted = !!b; if (!V.muted && V.deafened) V.deafened = false; applyMic(); applyAllVolumes(); sendVoiceState(); hooks.change(); }
export function setDeafened(b) { V.deafened = !!b; applyMic(); applyAllVolumes(); sendVoiceState(); hooks.change(); }
export function setPtt(held) { if (V.pttHeld === held) return; V.pttHeld = held; applyMic(); hooks.change(); }

/* Called with every voice state the server reports, ours included. */
export function onVoiceState(st) {
  const me = hooks.myId();
  V.members.set(st.userId, st.channelId);
  if (st.userId === me) {
    if (V.channelId && st.channelId === V.channelId && st.serverMuted !== V.serverMuted) { V.serverMuted = st.serverMuted; applyMic(); hooks.change(); }
    if (st.channelId === V.channelId) V.serverId = st.serverId;
    return;
  }
  const p = V.peers.get(st.userId);
  if (p && st.channelId !== V.channelId) closePeer(st.userId);
  else if (p && !st.sharing && p.screenStream) { p.screenStream = null; p.screenId = null; hooks.change(); }
  if (p && !st.camera && p.camStream) { p.camStream = null; p.camId = null; hooks.change(); }
}
export function onVoiceLeft(userId) { V.members.delete(userId); if (userId !== hooks.myId()) closePeer(userId); }

/* ================= peer connections ================= */
const signal = (to, data) => live.send('rtc', { to, data });
function getPeer(id) {
  let p = V.peers.get(id);
  if (p) return p;
  const pc = new RTCPeerConnection({ iceServers: V.ice || [] });
  p = { id, pc, polite: hooks.myId() > id, makingOffer: false, ignoreOffer: false, micSender: null, screenSenders: [],
    audioEl: null, stream: null, gain: null, source: null, analyser: null, screenStream: null, screenId: null,
    camStream: null, camId: null, camSenders: [], net: 'connecting', failNotified: false,
    createdAt: Date.now(), flowingAt: 0, lastBytes: -1, healStage: 0, healAt: 0 };
  V.peers.set(id, p);
  if (!V.micStream) V.micStream = silentStream();
  p.micSender = pc.addTrack(V.sendTrack || V.micStream.getAudioTracks()[0], V.micStream);
  if (V.sharing && V.screenStream) addScreenTo(p);
  if (V.camera && V.camStream) addCameraTo(p);
  pc.onnegotiationneeded = async () => {
    try { p.makingOffer = true; await pc.setLocalDescription(); signal(id, { desc: pc.localDescription }); }
    catch (e) { console.warn('offer', e); }
    finally { p.makingOffer = false; }
  };
  pc.onicecandidate = ({ candidate }) => { if (candidate) signal(id, { cand: candidate }); };
  pc.ontrack = (e) => {
    const st = e.streams[0] || new MediaStream([e.track]);
    if (p.camId && st.id === p.camId) { p.camStream = st; hooks.change(); }
    else if (e.track.kind === 'video' || (p.screenId && st.id === p.screenId)) { p.screenStream = st; hooks.change(); }
    else setRemoteAudio(p, st);
  };
  pc.onconnectionstatechange = () => log(pc.connectionState === 'failed' ? 'voice' : 'info', `Voice link with #${id}: ${pc.connectionState}`);
  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    if (s === 'disconnected' || s === 'failed') log('voice', `Voice path to #${id}: ${s}${s === 'failed' ? ', retrying' : ''}`);
    p.net = (s === 'connected' || s === 'completed') ? 'ok' : s === 'failed' ? 'failed' : s === 'disconnected' ? 'unstable' : 'connecting';
    if (s === 'failed') {
      try { pc.restartIce(); } catch {}
      if (!p.failNotified) { p.failNotified = true; hooks.system('voice-failed', id); }
    }
    hooks.change();
  };
  hooks.change();
  return p;
}
export async function onRtc(from, data) {
  if (!V.channelId || !data || lk) return;
  if (data.reset) {   // they rebuilt their side of a broken connection
    closePeer(from);
    if (hooks.myId() < from) getPeer(from);
    return;
  }
  const p = getPeer(from);
  const pc = p.pc;
  try {
    if ('cam' in data) {
      p.camId = data.cam || null;
      if (!data.cam) p.camStream = null;
      hooks.change();
    } else if ('screen' in data) {
      p.screenId = data.screen || null;
      if (!data.screen) p.screenStream = null;
      hooks.change();
    } else if (data.desc) {
      const desc = data.desc;
      const collision = desc.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
      p.ignoreOffer = !p.polite && collision;
      if (p.ignoreOffer) return;
      await pc.setRemoteDescription(desc);
      if (desc.type === 'offer') { await pc.setLocalDescription(); signal(from, { desc: pc.localDescription }); }
    } else if (data.cand) {
      try { await pc.addIceCandidate(data.cand); } catch (e) { if (!p.ignoreOffer) console.warn('ice', e); }
    }
  } catch (e) { console.warn('rtc', e); }
}
function closePeer(id) {
  const p = V.peers.get(id);
  if (!p) return;
  V.peers.delete(id);
  try { p.pc.close(); } catch {}
  try { p.source && p.source.disconnect(); } catch {}
  try { p.gain && p.gain.disconnect(); } catch {}
  if (p.audioEl) { p.audioEl.srcObject = null; p.audioEl.remove(); }
  V.speaking.delete(id);
  hooks.change();
}
function closeAllPeers() {
  if (lk) { const room = lk.room; lk = null; room.disconnect(false).catch(() => {}); }
  for (const id of [...V.peers.keys()]) closePeer(id);
}

/* ================= hearing people ================= */
function setRemoteAudio(p, stream) {
  if (p.stream === stream) return;
  p.stream = stream;
  if (!p.audioEl) {
    p.audioEl = document.createElement('audio');
    p.audioEl.autoplay = true; p.audioEl.playsInline = true;
    document.getElementById('audioSink').appendChild(p.audioEl);
  }
  p.audioEl.srcObject = stream;
  if (settings.speakerId && p.audioEl.setSinkId) p.audioEl.setSinkId(settings.speakerId).catch(() => {});
  p.audioEl.play().catch(() => hooks.system('audio-blocked'));
  try { p.source && p.source.disconnect(); } catch {}
  try { p.gain && p.gain.disconnect(); } catch {}
  p.gain = null;
  const a = makeAnalyser(stream); p.source = a.source; p.analyser = a.analyser;
  applyVolume(p);
  hooks.change();
}
let outBus = null;
function bus() {
  if (!outBus) {
    const c = audioCtx();
    outBus = c.createDynamicsCompressor();
    outBus.threshold.value = -6; outBus.knee.value = 6; outBus.ratio.value = 12; outBus.attack.value = 0.003; outBus.release.value = 0.2;
    outBus.connect(c.destination);
    if (settings.speakerId && typeof c.setSinkId === 'function') c.setSinkId(settings.speakerId).catch(() => {});
  }
  return outBus;
}
export const peerPrefs = (id) => friendVols[id] || { vol: 1, mute: false };
// Up to 100% a person plays through a normal audio element. Above that their voice goes through a gain node and a limiter.
function applyVolume(p) {
  if (!p.audioEl) return;
  const pref = peerPrefs(p.id);
  const v = V.deafened || pref.mute ? 0 : clampLevel(pref.vol) * settings.outputVol;
  if (v <= 1 || !p.source) {
    try { p.gain && p.gain.disconnect(); } catch {}
    p.gain = null;
    p.audioEl.muted = false; p.audioEl.volume = Math.min(1, v);
  } else {
    if (!p.gain) { p.gain = audioCtx().createGain(); p.source.connect(p.gain); p.gain.connect(bus()); }
    p.gain.gain.value = v;
    p.audioEl.muted = true;
  }
}
export function applyAllVolumes() { for (const p of V.peers.values()) applyVolume(p); }
export function applySpeaker() {
  if (outBus && typeof audioCtx().setSinkId === 'function') audioCtx().setSinkId(settings.speakerId || '').catch(() => {});
  for (const el of document.querySelectorAll('#audioSink audio, #stageVideo')) if (el.setSinkId) el.setSinkId(settings.speakerId || '').catch(() => {});
}
export function unlockAudio() { for (const p of V.peers.values()) if (p.audioEl) p.audioEl.play().catch(() => {}); audioCtx(); }

function speakLoop() {
  const now = new Set();
  if (V.channelId && micLive() && level(localMeter.analyser) > 0.02) now.add(hooks.myId());
  for (const p of V.peers.values()) if (p.analyser && level(p.analyser) > 0.02) now.add(p.id);
  let changed = now.size !== V.speaking.size;
  if (!changed) for (const id of now) if (!V.speaking.has(id)) { changed = true; break; }
  if (changed) { V.speaking = now; hooks.speaking(now); }
}

/* ================= screen sharing ================= */
const QUALITY = { motion: { height: 720, fps: 30, bitrate: 2_500_000, hint: 'motion' }, detail: { height: 1080, fps: 15, bitrate: 3_000_000, hint: 'detail' } };
export const canShare = () => !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
function addScreenTo(p) {
  const s = V.screenStream;
  signal(p.id, { screen: s.id });   // tell them which incoming stream is the screen before it arrives
  const q = QUALITY[settings.quality] || QUALITY.motion;
  for (const t of s.getTracks()) {
    const sender = p.pc.addTrack(t, s);
    p.screenSenders.push(sender);
    if (t.kind === 'video') {
      try {
        const prm = sender.getParameters();
        prm.encodings = prm.encodings && prm.encodings.length ? prm.encodings : [{}];
        prm.encodings[0].maxBitrate = q.bitrate;
        sender.setParameters(prm).catch(() => {});
      } catch {}
    }
  }
}
export async function startShare() {
  if (!V.channelId || V.sharing) return;
  const q = QUALITY[settings.quality] || QUALITY.motion;
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: q.fps, max: q.fps }, height: { ideal: q.height, max: q.height } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (e) {
    if (e && e.name !== 'NotAllowedError' && e.name !== 'AbortError') toast("Couldn't start screen sharing.", 4000);
    return;
  }
  const vt = stream.getVideoTracks()[0];
  if (vt) { try { vt.contentHint = q.hint; } catch {} vt.addEventListener('ended', () => stopShare(true)); }
  V.screenStream = stream; V.sharing = true;
  if (lk) await sfuPublishScreen();
  else for (const p of V.peers.values()) addScreenTo(p);
  sendVoiceState();
  hooks.change();
}
export function stopShare(notify = true) {
  if (!V.sharing) return;
  const s = V.screenStream;
  V.sharing = false; V.screenStream = null;
  if (lk) sfuUnpublish(lk.screen);
  for (const p of V.peers.values()) {
    for (const sender of p.screenSenders) { try { p.pc.removeTrack(sender); } catch {} }
    p.screenSenders = [];
    if (notify) signal(p.id, { screen: null });
  }
  if (s) s.getTracks().forEach((t) => t.stop());
  if (notify) sendVoiceState();
  hooks.change();
}

/* ================= camera ================= */
export const canCamera = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
function addCameraTo(p) {
  signal(p.id, { cam: V.camStream.id });   // which incoming video is the camera, before it arrives
  for (const t of V.camStream.getVideoTracks()) {
    const sender = p.pc.addTrack(t, V.camStream);
    p.camSenders.push(sender);
    try {
      const prm = sender.getParameters();
      prm.encodings = prm.encodings && prm.encodings.length ? prm.encodings : [{}];
      prm.encodings[0].maxBitrate = 600_000;
      sender.setParameters(prm).catch(() => {});
    } catch {}
  }
}
export async function startCamera() {
  if (!V.channelId || V.camera) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: settings.camId ? { ideal: settings.camId } : undefined, width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 } },
    });
  } catch (e) {
    toast(e && e.name === 'NotAllowedError' ? 'Camera access is blocked. Allow it in your browser or system settings.' : 'Couldn’t start your camera. Is another app using it?', 5000);
    return;
  }
  const t = stream.getVideoTracks()[0];
  if (t) t.addEventListener('ended', () => stopCamera(true));
  V.camStream = stream; V.camera = true;
  if (lk) await sfuPublishCamera();
  else for (const p of V.peers.values()) addCameraTo(p);
  sendVoiceState();
  hooks.change();
}
export function stopCamera(notify = true) {
  if (!V.camera) return;
  const s = V.camStream;
  V.camera = false; V.camStream = null;
  if (lk) sfuUnpublish(lk.cam);
  for (const p of V.peers.values()) {
    for (const sender of p.camSenders) { try { p.pc.removeTrack(sender); } catch {} }
    p.camSenders = [];
    if (notify) signal(p.id, { cam: null });
  }
  if (s) s.getTracks().forEach((t) => t.stop());
  if (notify) sendVoiceState();
  hooks.change();
}

/* ================= media server (big voice channels) =================
   When the server has a LiveKit media server set up, everyone sends their voice, camera and screen once to it
   and it passes them on, instead of sending a copy to each person. People show up in V.peers the same way. */
let lk = null;   // { room, L, mic, screen: [], cam: [] }
function loadLiveKit() {
  if (window.LivekitClient) return Promise.resolve(window.LivekitClient);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = absUrl('/vendor/livekit-client.js');
    s.onload = () => resolve(window.LivekitClient);
    s.onerror = () => reject(new Error('the voice library didn’t load'));
    document.head.appendChild(s);
  });
}
function sfuPeer(id) {
  let p = V.peers.get(id);
  if (!p) {
    p = { id, pc: null, audioEl: null, stream: null, gain: null, source: null, analyser: null, screenStream: null, camStream: null,
      screenSenders: [], camSenders: [], net: 'ok', failNotified: false };
    V.peers.set(id, p);
    hooks.change();
  }
  return p;
}
async function sfuConnect(channelId) {
  const L = await loadLiveKit();
  const { url, token } = await api(`/api/voice-token?channelId=${channelId}`);
  const room = new L.Room({ adaptiveStream: true, dynacast: true });
  const src = L.Track.Source;
  const idOf = (part) => Number(part.identity);
  const isScreen = (pub) => pub.source === src.ScreenShare || pub.source === src.ScreenShareAudio;
  room.on(L.RoomEvent.ParticipantConnected, (part) => sfuPeer(idOf(part)));
  room.on(L.RoomEvent.ParticipantDisconnected, (part) => closePeer(idOf(part)));
  room.on(L.RoomEvent.TrackSubscribed, (track, pub, part) => {
    const p = sfuPeer(idOf(part)), t = track.mediaStreamTrack;
    if (pub.source === src.Camera) p.camStream = new MediaStream([t]);
    else if (isScreen(pub)) { p.screenStream = new MediaStream([...(p.screenStream ? p.screenStream.getTracks() : []), t]); }
    else setRemoteAudio(p, new MediaStream([t]));
    hooks.change();
  });
  room.on(L.RoomEvent.TrackUnsubscribed, (track, pub, part) => {
    const p = V.peers.get(idOf(part));
    if (!p) return;
    if (pub.source === src.Camera) p.camStream = null;
    else if (isScreen(pub) && p.screenStream) {
      const rest = p.screenStream.getTracks().filter((x) => x !== track.mediaStreamTrack);
      p.screenStream = rest.some((x) => x.kind === 'video') ? new MediaStream(rest) : null;
    }
    hooks.change();
  });
  room.on(L.RoomEvent.ConnectionQualityChanged, (q, part) => {
    if (part.isLocal) return;
    const p = V.peers.get(idOf(part));
    if (p) { p.net = q === 'lost' ? 'failed' : q === 'poor' ? 'unstable' : 'ok'; hooks.change(); }
  });
  room.on(L.RoomEvent.Reconnecting, () => log('voice', 'Media server connection dropped, reconnecting'));
  room.on(L.RoomEvent.Reconnecting, () => { for (const p of V.peers.values()) p.net = 'unstable'; hooks.change(); });
  room.on(L.RoomEvent.Reconnected, () => { for (const p of V.peers.values()) p.net = 'ok'; hooks.change(); });
  room.on(L.RoomEvent.Disconnected, (reason) => {
    if (!lk || lk.room !== room || !V.channelId) return;   // we left on purpose
    log('voice', `Media server disconnected (${reason})`);
    lk = null;
    rejoinVoice();
  });
  await room.connect(url, token, { rtcConfig: { iceServers: V.ice || [] } });
  lk = { room, L, mic: null, screen: [], cam: [] };
  for (const part of room.remoteParticipants.values()) sfuPeer(idOf(part));
  lk.mic = await room.localParticipant.publishTrack(V.sendTrack, { source: src.Microphone, name: 'mic', dtx: true, red: true });
  if (V.sharing && V.screenStream) await sfuPublishScreen();
  if (V.camera && V.camStream) await sfuPublishCamera();
}
async function sfuPublishScreen() {
  const src = lk.L.Track.Source, q = QUALITY[settings.quality] || QUALITY.motion;
  for (const t of V.screenStream.getTracks()) {
    lk.screen.push(await lk.room.localParticipant.publishTrack(t, t.kind === 'video'
      ? { source: src.ScreenShare, name: 'screen', simulcast: false, videoEncoding: { maxBitrate: q.bitrate, maxFramerate: q.fps } }
      : { source: src.ScreenShareAudio, name: 'screen-audio' }));
  }
}
async function sfuPublishCamera() {
  const src = lk.L.Track.Source;
  for (const t of V.camStream.getVideoTracks()) {
    lk.cam.push(await lk.room.localParticipant.publishTrack(t, { source: src.Camera, name: 'camera', simulcast: true, videoEncoding: { maxBitrate: 600_000, maxFramerate: 24 } }));
  }
}
function sfuUnpublish(list) {
  const room = lk && lk.room;
  for (const pub of list.splice(0)) { try { room.localParticipant.unpublishTrack(pub.track, false); } catch {} }
}

/* ================= diagnostics (developer panel) ================= */
export async function diagnostics() {
  const raw = V.rawStream && V.rawStream.getAudioTracks()[0];
  let ctx = null;
  try { const c = audioCtx(); ctx = { state: c.state, sampleRate: c.sampleRate, baseLatency: c.baseLatency }; } catch {}
  const out = {
    at: Date.now(), inVoice: V.channelId, mode: lk ? 'media server' : 'direct', joining: V.joining,
    muted: V.muted, deafened: V.deafened, serverMuted: V.serverMuted, ptt: settings.ptt, sharing: V.sharing, camera: V.camera,
    mic: raw ? { label: raw.label, state: raw.readyState, muted: raw.muted, enabled: raw.enabled } : null,
    send: V.sendTrack ? { state: V.sendTrack.readyState, enabled: V.sendTrack.enabled, live: micLive() } : null,
    micIssue: V.micIssue, noMic: V.noMic, noise: settings.noiseMode, filterRunning: !!(V.fx && V.fx.node), audio: ctx,
    peers: [],
  };
  for (const p of V.peers.values()) {
    const d = { userId: p.id, net: p.net, hearing: !!(p.stream && p.stream.getAudioTracks().some((t) => t.readyState === 'live')),
      audioEl: p.audioEl ? { paused: p.audioEl.paused, muted: p.audioEl.muted, volume: +p.audioEl.volume.toFixed(2) } : null };
    if (p.pc) {
      const pc = p.pc;
      Object.assign(d, { state: pc.connectionState, ice: pc.iceConnectionState, signaling: pc.signalingState });
      try {
        const rep = await pc.getStats();
        const by = new Map(); rep.forEach((s) => by.set(s.id, s));
        let pair = null;
        rep.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = by.get(s.selectedCandidatePairId); });
        if (!pair) rep.forEach((s) => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; });
        if (pair) {
          const lc = by.get(pair.localCandidateId) || {}, rc = by.get(pair.remoteCandidateId) || {};
          d.path = { local: lc.candidateType, remote: rc.candidateType, protocol: lc.protocol, relayed: lc.candidateType === 'relay' || rc.candidateType === 'relay',
            rttMs: pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null };
        }
        rep.forEach((s) => {
          if (s.type === 'inbound-rtp' && s.kind === 'audio') d.in = { bytes: s.bytesReceived, packets: s.packetsReceived, lost: s.packetsLost, jitterMs: Math.round((s.jitter || 0) * 1000), level: +(s.audioLevel || 0).toFixed(3), concealed: s.concealedSamples, samples: s.totalSamplesReceived };
          if (s.type === 'outbound-rtp' && s.kind === 'audio') d.out = { bytes: s.bytesSent, packets: s.packetsSent };
          if (s.type === 'inbound-rtp' && s.kind === 'video') d.videoIn = { bytes: s.bytesReceived, fps: s.framesPerSecond, width: s.frameWidth, height: s.frameHeight };
        });
      } catch (e) { d.statsError = String(e); }
    }
    out.peers.push(d);
  }
  return out;
}

/* ================= self-healing =================
   Every 2 s, check that sound is still arriving from each friend. If it stops (a Wi-Fi dropout, a sleeping
   network card, a router hiccup), repair it without anyone pressing anything: first an ICE restart (find a
   new network path), then, if that doesn't bring sound back, a completely fresh connection. */
const missing = new Map();   // userId -> since when they're in our channel with no connection
async function heal() {
  if (!V.channelId) return;
  keepAudioAlive();
  if (lk) return;   // the media server reconnects by itself
  const t = Date.now();
  // Someone is in your channel but there's no voice connection to them at all: connect, or ask them to.
  for (const [id, ch] of V.members) {
    if (ch !== V.channelId || id === hooks.myId() || V.peers.has(id)) { missing.delete(id); continue; }
    if (!missing.has(id)) { missing.set(id, t); continue; }
    if (t - missing.get(id) > 10000) {
      missing.set(id, t);
      log('voice', `No voice connection with #${id}; connecting`);
      if (hooks.myId() < id) getPeer(id); else signal(id, { reset: true });
    }
  }
  for (const p of [...V.peers.values()]) {
    const pc = p.pc;
    if (!pc) continue;
    if (pc.connectionState === 'closed') { log('voice', `Voice connection with #${p.id} closed; rebuilding it`); rebuildPeer(p.id); continue; }
    let bytes = null;
    try { (await pc.getStats()).forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'audio') bytes = (bytes || 0) + (s.bytesReceived || 0); }); } catch {}
    if (V.peers.get(p.id) !== p) continue;
    if (bytes != null && bytes > p.lastBytes) {
      p.lastBytes = bytes; p.flowingAt = t;
      if (p.healStage) { log('voice', `Voice with #${p.id} is back`); p.healStage = 0; p.failNotified = false; }
      continue;
    }
    const quiet = t - (p.flowingAt || p.createdAt);
    const ice = pc.iceConnectionState;
    if (!p.healStage && (quiet > 8000 || ice === 'failed' || (ice === 'disconnected' && quiet > 4000))) {
      p.healStage = 1; p.healAt = t;
      log('voice', `No sound from #${p.id} for ${Math.round(quiet / 1000)} s (${ice}); looking for a new network path`);
      try { pc.restartIce(); } catch {}
    } else if (p.healStage === 1 && t - p.healAt > 12000) {
      p.healStage = 2; p.healAt = t;
      log('voice', `Rebuilding the voice connection with #${p.id}`);
      rebuildPeer(p.id);
    } else if (p.healStage === 2 && t - p.healAt > 20000) {
      p.healAt = t;   // still nothing: keep trying every 20 s while you're both in the channel
      log('voice', `Still no sound from #${p.id}; trying again`);
      rebuildPeer(p.id);
    }
  }
}
function rebuildPeer(id) {
  const stage = (V.peers.get(id) || {}).healStage || 2;
  closePeer(id);
  signal(id, { reset: true });
  if (hooks.myId() < id) { const p = getPeer(id); p.healStage = stage; p.healAt = Date.now(); }
}
/* The audio engine runs the noise filter and loud-volume boost. Chrome can pause it (a headset reconnecting,
   the computer waking up); a paused engine means friends hear silence. Also replay anything paused. */
function keepAudioAlive() {
  try {
    const c = audioCtx();
    if (c.state !== 'running' && !keepAudioAlive.warned) { keepAudioAlive.warned = true; log('voice', `Audio engine was ${c.state}; restarting it`); }
    if (c.state === 'running') keepAudioAlive.warned = false;
  } catch {}
  if (V.sendTrack && V.sendTrack.readyState === 'ended' && !V.noMic && !keepAudioAlive.micBusy) {
    keepAudioAlive.micBusy = true;
    log('voice', 'Microphone stream ended; starting it again');
    setupMic(settings.micId).finally(() => { keepAudioAlive.micBusy = false; });
  }
  for (const p of V.peers.values()) if (p.audioEl && p.audioEl.paused && p.stream) p.audioEl.play().catch(() => {});
}
/* While you're in voice, hold a Web Lock: Chrome never freezes or discards a tab that holds one. */
let lockRelease = null;
function holdCallLock() {
  if (lockRelease || !navigator.locks) return;
  navigator.locks.request('party-line-voice', () => new Promise((resolve) => { lockRelease = resolve; })).catch(() => {});
}
function releaseCallLock() { if (lockRelease) { lockRelease(); lockRelease = null; } }
