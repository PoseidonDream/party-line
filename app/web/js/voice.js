/* Voice and screen sharing. Everyone in a voice channel connects directly to everyone else (WebRTC);
   the server only passes the handshakes along. The microphone runs through an optional noise filter. */
import { api, live } from './net.js';
import { settings, saveSettings, friendVols, clampLevel, audioCtx, makeAnalyser, level, toast } from './util.js';

export const V = {
  channelId: null, serverId: null, joining: false,
  muted: false, deafened: false, serverMuted: false, pttHeld: false,
  sharing: false, screenStream: null,
  rawStream: null, micStream: null, sendTrack: null, noMic: true, micIssue: null, fx: null,
  peers: new Map(),   // userId -> peer
  speaking: new Set(),
  ice: null,
};
let hooks = { myId: () => 0, change: () => {}, speaking: () => {}, micIssue: () => {}, system: () => {} };
export function initVoice(h) { hooks = Object.assign(hooks, h); setInterval(speakLoop, 120); }

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
  const keep = new Set([...raw.getTracks(), ...send.getTracks()]);
  for (const st of [oldRaw, oldSend]) if (st) st.getTracks().forEach((t) => { if (!keep.has(t)) t.stop(); });
  try { localMeter.source && localMeter.source.disconnect(); } catch {}
  localMeter = makeAnalyser(send);
  const track = raw.getAudioTracks()[0];
  if (!track || !real) return;
  track.addEventListener('ended', () => { if (V.rawStream === raw) { V.noMic = true; applyMic(); setIssue('disconnected'); } });
  track.addEventListener('mute', () => setTimeout(() => { if (V.rawStream === raw && track.muted && !V.noMic) setIssue('osmuted'); }, 1500));
  track.addEventListener('unmute', () => { if (V.rawStream === raw && V.micIssue === 'osmuted') setIssue(null); });
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
    if (!V.ice) { try { V.ice = (await api('/api/ice')).iceServers; } catch { V.ice = [{ urls: 'stun:stun.l.google.com:19302' }]; } }
    if (V.channelId) closeAllPeers();
    const r = await live.req('voice.join', { channelId, muted: V.muted, deafened: V.deafened });
    V.channelId = channelId;
    V.serverMuted = false;
    for (const id of r.peers) getPeer(id);   // we're the newcomer, so we start the handshakes
    if (V.sharing) sendVoiceState();
    applyMic(); applyAllVolumes();
  } finally { V.joining = false; hooks.change(); }
}
export function leaveVoice(notifyServer = true) {
  if (!V.channelId) return;
  if (notifyServer) live.send('voice.leave', {});
  if (V.sharing) stopShare(false);
  closeAllPeers();
  V.channelId = null; V.serverId = null; V.serverMuted = false;
  stopMic();
  hooks.change();
}
/* After the connection to the server comes back, the server has forgotten our voice spot: take it again. */
export async function rejoinVoice() {
  const id = V.channelId;
  if (!id) return;
  closeAllPeers();
  V.channelId = null;
  try { await joinVoice(id); } catch { leaveVoice(false); hooks.system('You were disconnected from voice.'); }
}
export function sendVoiceState() {
  if (!V.channelId) return;
  live.send('voice.state', { muted: V.muted, deafened: V.deafened, sharing: V.sharing, screenId: V.screenStream ? V.screenStream.id : null });
}
export function setMuted(b) { V.muted = !!b; if (!V.muted && V.deafened) V.deafened = false; applyMic(); applyAllVolumes(); sendVoiceState(); hooks.change(); }
export function setDeafened(b) { V.deafened = !!b; applyMic(); applyAllVolumes(); sendVoiceState(); hooks.change(); }
export function setPtt(held) { if (V.pttHeld === held) return; V.pttHeld = held; applyMic(); hooks.change(); }

/* Called with every voice state the server reports, ours included. */
export function onVoiceState(st) {
  const me = hooks.myId();
  if (st.userId === me) {
    if (V.channelId && st.channelId === V.channelId && st.serverMuted !== V.serverMuted) { V.serverMuted = st.serverMuted; applyMic(); hooks.change(); }
    if (st.channelId === V.channelId) V.serverId = st.serverId;
    return;
  }
  const p = V.peers.get(st.userId);
  if (p && st.channelId !== V.channelId) closePeer(st.userId);
  else if (p && !st.sharing && p.screenStream) { p.screenStream = null; p.screenId = null; hooks.change(); }
}
export function onVoiceLeft(userId) { if (userId !== hooks.myId()) closePeer(userId); }

/* ================= peer connections ================= */
const signal = (to, data) => live.send('rtc', { to, data });
function getPeer(id) {
  let p = V.peers.get(id);
  if (p) return p;
  const pc = new RTCPeerConnection({ iceServers: V.ice || [] });
  p = { id, pc, polite: hooks.myId() > id, makingOffer: false, ignoreOffer: false, micSender: null, screenSenders: [],
    audioEl: null, stream: null, gain: null, source: null, analyser: null, screenStream: null, screenId: null, net: 'connecting', failNotified: false };
  V.peers.set(id, p);
  if (!V.micStream) V.micStream = silentStream();
  p.micSender = pc.addTrack(V.sendTrack || V.micStream.getAudioTracks()[0], V.micStream);
  if (V.sharing && V.screenStream) addScreenTo(p);
  pc.onnegotiationneeded = async () => {
    try { p.makingOffer = true; await pc.setLocalDescription(); signal(id, { desc: pc.localDescription }); }
    catch (e) { console.warn('offer', e); }
    finally { p.makingOffer = false; }
  };
  pc.onicecandidate = ({ candidate }) => { if (candidate) signal(id, { cand: candidate }); };
  pc.ontrack = (e) => {
    const st = e.streams[0] || new MediaStream([e.track]);
    if (e.track.kind === 'video' || (p.screenId && st.id === p.screenId)) { p.screenStream = st; hooks.change(); }
    else setRemoteAudio(p, st);
  };
  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
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
  if (!V.channelId || !data) return;
  const p = getPeer(from);
  const pc = p.pc;
  try {
    if ('screen' in data) {
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
function closeAllPeers() { for (const id of [...V.peers.keys()]) closePeer(id); }

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
  for (const p of V.peers.values()) addScreenTo(p);
  sendVoiceState();
  hooks.change();
}
export function stopShare(notify = true) {
  if (!V.sharing) return;
  const s = V.screenStream;
  V.sharing = false; V.screenStream = null;
  for (const p of V.peers.values()) {
    for (const sender of p.screenSenders) { try { p.pc.removeTrack(sender); } catch {} }
    p.screenSenders = [];
    if (notify) signal(p.id, { screen: null });
  }
  if (s) s.getTracks().forEach((t) => t.stop());
  if (notify) sendVoiceState();
  hooks.change();
}
