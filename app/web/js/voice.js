/* Voice and screen sharing. Everyone in a voice channel connects directly to everyone else (WebRTC);
   the server only passes the handshakes along. The microphone runs through an optional noise filter. */
import { api, live, absUrl } from './net.js';
import { settings, saveSettings, friendVols, clampLevel, audioCtx, makeAnalyser, level, toast } from './util.js';
import { log } from './dev.js';

export const V = {
  channelId: null, serverId: null, joining: false,
  muted: false, deafened: false, serverMuted: false, pttHeld: false,
  sharing: false, screenStream: null, joinedAt: 0,
  camera: false, camStream: null,
  rawStream: null, micStream: null, sendTrack: null, noMic: true, micIssue: null, fx: null,
  peers: new Map(),   // userId -> peer
  members: new Map(), // userId -> voice channel they're in (everyone the server told us about)
  speaking: new Set(),
  ice: null,
};
let hooks = { myId: () => 0, change: () => {}, speaking: () => {}, micIssue: () => {}, system: () => {} };
export function initVoice(h) { hooks = Object.assign(hooks, h); setInterval(speakLoop, 60); setInterval(heal, 2000); }

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
/* With the speech model running, the browser's own noise filter is off: in front of the model it smears noise into
   something the model no longer recognises (measured with music behind a voice: between sentences −27 dB with it,
   −54 dB without). Where the model can't run, the browser's filter stays on. */
let speechOk = null;   // can the speech model run on this device? (null: not tried yet)
const browserNs = () => settings.noiseMode === 'on' && speechOk !== true;
function acquireMic(deviceId) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const e = new Error('no media'); e.name = 'NoMedia'; return Promise.reject(e);
  }
  return navigator.mediaDevices.getUserMedia({
    audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: true, noiseSuppression: browserNs(), autoGainControl: true },
  });
}
const silentStream = () => audioCtx().createMediaStreamDestination().stream;

/* The noise filter. GTCRN, a small speech model (runs on this device, in WebAssembly), keeps voices and removes
   everything else: music, keyboards, fans. A steep low cut (100 Hz) in front of it takes rumble, hum, bass and
   thumps away first (a voice has almost nothing that low). Where the model can't run, Party Line's older filter
   (steady noise only) steps in, with the browser's own filter. */
let workletReady = null, gtcrnReady = null;
function loadDenoiser() {
  const c = audioCtx();
  if (!c.audioWorklet || typeof AudioWorkletNode !== 'function') return Promise.reject(new Error('no worklet'));
  if (!workletReady) workletReady = c.audioWorklet.addModule('/denoise-worklet.js').catch((e) => { workletReady = null; throw e; });
  return workletReady;
}
function loadGtcrn() {
  const c = audioCtx();
  if (!c.audioWorklet || typeof AudioWorkletNode !== 'function' || typeof WebAssembly !== 'object') return Promise.reject(new Error('no worklet'));
  if (c.sampleRate !== 48000 && c.sampleRate !== 16000) return Promise.reject(new Error(`sample rate ${c.sampleRate}`));
  if (!gtcrnReady) {
    gtcrnReady = Promise.all([fetch(absUrl('/vendor/gtcrn.wasm')).then((r) => { if (!r.ok) throw new Error('no model'); return r.arrayBuffer(); }), c.audioWorklet.addModule(absUrl('/vendor/gtcrn-worklet.js'))])
      .then(([wasm]) => wasm).catch((e) => { gtcrnReady = null; throw e; });
  }
  return gtcrnReady;
}
function teardownFx() {
  const fx = V.fx; V.fx = null;
  if (!fx) return;
  for (const n of [fx.source, ...(fx.lowcut || []), fx.node, fx.gate, fx.gain, ...(fx.effect ? fx.effect.nodes : [])]) { try { n && n.stop && n.stop(); } catch {} try { n && n.disconnect(); } catch {} }
  if (fx.filter === 'speech') try { fx.node.port.postMessage('destroy'); } catch {}   // stop the model running in the background
}
/* The low cut in front of the noise filter: two filters make one steep one (4th-order Butterworth at 100 Hz; for these
   filters the browser takes Q in dB). */
export const lowCut = (c) => [-5.33, 2.32].map((q) => { const b = c.createBiquadFilter(); b.type = 'highpass'; b.frequency.value = 100; b.Q.value = q; return b; });
// The mic goes through the audio engine when the noise filter is on, your mic volume isn't 100% or there's a voice effect.
const needsFx = () => settings.noiseMode === 'on' || Math.abs(settings.inputVol - 1) > 0.004 || settings.voiceFx !== 'none';

/* ================= voice effects (for fun: your friends hear you through them) ================= */
export const VOICE_FX = ['none', 'robot', 'deep', 'chipmunk', 'cave', 'radio', 'alien', 'demon', 'underwater', 'arcade', 'wobbly', 'ghost', 'harmony', 'stadium', 'glitch', 'slowmo'];
/* The voice gate (gate-worklet.js): with the noise filter on, the mic is cut completely between sentences. */
let gateReady = null;
function loadGate() {
  const c = audioCtx();
  if (!c.audioWorklet || typeof AudioWorkletNode !== 'function') return Promise.reject(new Error('no worklet'));
  if (!gateReady) gateReady = c.audioWorklet.addModule(absUrl('/gate-worklet.js')).catch((e) => { gateReady = null; throw e; });
  return gateReady;
}
let pitchReady = null;
function loadPitch() {
  const c = audioCtx();
  if (!c.audioWorklet || typeof AudioWorkletNode !== 'function') return Promise.reject(new Error('no worklet'));
  if (!pitchReady) pitchReady = c.audioWorklet.addModule('/voice-fx-worklet.js').catch((e) => { pitchReady = null; throw e; });
  return pitchReady;
}
const softClip = (k) => { const n = 1024, curve = new Float32Array(n); for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(k * x) / Math.tanh(k); } return curve; };
/* Nodes for one effect: sound goes into `input` and comes out of `output`. */
async function effectChain(c, kind) {
  const nodes = [];
  const keep = (n) => { nodes.push(n); return n; };
  const gain = (v) => { const g = keep(c.createGain()); g.gain.value = v; return g; };
  const filter = (type, f, q = 0.7) => { const b = keep(c.createBiquadFilter()); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
  const worklet = async (name, opts) => { await loadPitch(); return keep(new AudioWorkletNode(c, name, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: opts })); };
  const pitch = (ratio) => worklet('pl-pitch', { ratio });
  const shaper = (k) => { const w = keep(c.createWaveShaper()); w.curve = softClip(k); return w; };
  // A delay whose length swings back and forth: the voice's pitch wobbles (vibrato), slow or fast.
  const wobble = (rate, depth, base) => {
    const d = keep(c.createDelay(0.1)), o = keep(c.createOscillator()), g = gain(depth);
    d.delayTime.value = base; o.frequency.value = rate; o.connect(g); g.connect(d.delayTime); o.start();
    return d;
  };
  // A room: an echo made of noise that dies away over `secs`.
  const room = (secs, decay) => {
    const cv = keep(c.createConvolver()), len = Math.floor(c.sampleRate * secs), b = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const x = b.getChannelData(ch); for (let i = 0; i < len; i++) x[i] = (Math.random() * 2 - 1) * (1 - i / len) ** decay; }
    cv.buffer = b;
    return cv;
  };
  const chain = (...ns) => { for (let i = 1; i < ns.length; i++) ns[i - 1].connect(ns[i]); return ns[ns.length - 1]; };
  const done = (input, output) => ({ input, output, nodes });

  if (kind === 'deep' || kind === 'chipmunk') { const n = await pitch(kind === 'deep' ? 0.72 : 1.6); return done(n, n); }
  if (kind === 'robot') {
    // A ring modulator (the voice times a 50 Hz tone) and a short metallic ring.
    const ring = gain(0), osc = keep(c.createOscillator()), comb = keep(c.createDelay(0.05)), fb = gain(0.55), out = gain(0.9);
    osc.frequency.value = 50; osc.connect(ring.gain); osc.start();
    comb.delayTime.value = 0.009;
    ring.connect(out); ring.connect(comb); comb.connect(fb); fb.connect(comb); comb.connect(out);
    return done(ring, out);
  }
  if (kind === 'cave') {
    const input = gain(1), d = keep(c.createDelay(1)), fb = gain(0.45), lp = filter('lowpass', 2200), wet = gain(0.55), out = gain(1);
    d.delayTime.value = 0.24;
    input.connect(out); input.connect(d); d.connect(lp); lp.connect(fb); fb.connect(d); lp.connect(wet); wet.connect(out);
    return done(input, out);
  }
  if (kind === 'radio') {
    const hp = filter('highpass', 450), mid = filter('peaking', 1500, 1), out = gain(0.7);
    mid.gain.value = 6;
    chain(hp, filter('lowpass', 3000), mid, shaper(6), out);
    return done(hp, out);
  }
  if (kind === 'alien') {
    // Higher, with a fast warble and a metallic swoosh.
    const p = await pitch(1.3), w = wobble(8, 0.0012, 0.005), fb = gain(0.35), out = gain(0.9);
    p.connect(w); w.connect(fb); fb.connect(w); w.connect(out);
    return done(p, out);
  }
  if (kind === 'demon') {
    // Much lower, doubled an octave further down, growly, in a big room.
    const input = gain(1), low = await pitch(0.6), lower = await pitch(0.5), mix = gain(1), out = gain(0.85), wet = gain(0.3);
    input.connect(low); input.connect(lower);
    chain(low, gain(0.8), mix); chain(lower, gain(0.45), mix);
    chain(mix, shaper(2.5), filter('lowpass', 3500), out);
    chain(out, room(1.2, 3), wet);
    const end = gain(1); out.connect(end); wet.connect(end);
    return done(input, end);
  }
  if (kind === 'underwater') {
    const lp = filter('lowpass', 550, 3), out = gain(1.6);
    chain(lp, wobble(1.3, 0.003, 0.008), out);
    return done(lp, out);
  }
  if (kind === 'arcade') {
    const cr = await worklet('pl-crush', { rate: 5500, bits: 5 }), out = gain(1);
    chain(cr, filter('lowpass', 6000), out);
    return done(cr, out);
  }
  if (kind === 'wobbly') { const w = wobble(0.7, 0.018, 0.022); return done(w, w); }
  if (kind === 'ghost') {
    // A little higher, airy and shaky, mostly echo.
    const hp = filter('highpass', 300), p = await pitch(1.1), w = wobble(5, 0.0008, 0.003), dry = gain(0.45), wet = gain(0.9), out = gain(1);
    chain(hp, p, w);
    w.connect(dry); dry.connect(out);
    chain(w, room(3, 2), wet, out);
    return done(hp, out);
  }
  if (kind === 'harmony') {
    // Three of you singing together: your voice, a fifth below and a third above.
    const input = gain(1), out = gain(0.75);
    input.connect(out);
    chain(input, await pitch(0.667), gain(0.55), out);
    chain(input, await pitch(1.26), gain(0.45), out);
    return done(input, out);
  }
  if (kind === 'stadium') {
    // A stadium announcer: brighter, steadier, a slap back off the far stand and a huge room.
    const hp = filter('highpass', 140), comp = keep(c.createDynamicsCompressor()), pres = filter('peaking', 3000, 1), slap = keep(c.createDelay(0.5)), out = gain(0.9);
    comp.threshold.value = -26; comp.ratio.value = 4;
    pres.gain.value = 4; slap.delayTime.value = 0.11;
    chain(hp, comp, pres, out);
    chain(pres, slap, gain(0.35), out);
    chain(pres, room(2.2, 2.5), gain(0.5), out);
    return done(hp, out);
  }
  if (kind === 'glitch') { const g = await worklet('pl-glitch', {}); return done(g, g); }
  if (kind === 'slowmo') {
    // Deep and slow, like a slowed-down video, with a little room around it.
    const sl = await worklet('pl-slow', { rate: 0.72 }), out = gain(1);
    sl.connect(out);
    chain(sl, room(1.4, 3), gain(0.18), out);
    return done(sl, out);
  }
  return null;
}
/* For the developer panel's voice check: the same effects on any sound, and a microphone of its own. */
export const buildEffect = (kind) => effectChain(audioCtx(), kind);
export const testMic = () => acquireMic(settings.micId).catch(() => acquireMic(''));
export async function setVoiceFx(kind) {
  if (!VOICE_FX.includes(kind) || settings.voiceFx === kind) return;
  settings.voiceFx = kind; saveSettings();
  if (V.rawStream && !V.noMic) { await installMic(V.rawStream, true); applyMic(); }
  hooks.change();
}
/* "Hear myself": your own mic, as your friends hear it, through your speakers or headphones. */
let monitor = null;
export function setMonitor(on) {
  try { monitor && monitor.disconnect(); } catch {}
  monitor = null;
  if (on && V.micStream && !V.noMic) { const c = audioCtx(); monitor = c.createMediaStreamSource(V.micStream); monitor.connect(c.destination); }
  applyMic();   // the noise filter works while you hear yourself, muted or not
}
export const monitoring = () => !!monitor;
async function buildSend(raw) {
  if (!needsFx()) { teardownFx(); return raw; }
  let c, source;
  try { c = audioCtx(); source = c.createMediaStreamSource(raw); } catch { teardownFx(); return raw; }
  let node = null, filter = null;
  if (settings.noiseMode === 'on') {
    try {
      const wasmBinary = await loadGtcrn();
      node = new AudioWorkletNode(c, '@sapphi-red/web-noise-suppressor/gtcrn', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { maxChannels: 1, wasmBinary } });
      filter = 'speech'; speechOk = true;
    } catch {
      speechOk = false;
      try {
        await loadDenoiser();
        node = new AudioWorkletNode(c, 'pl-denoise', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { strength: 1 } });
        filter = 'steady';
      } catch { filter = 'browser'; }   // the browser's own filter still runs
    }
  }
  // With the noise filter on, the mic is also cut between sentences (friends hear nothing while you're not talking).
  let gate = null;
  if (settings.noiseMode === 'on') {
    try { await loadGate(); gate = new AudioWorkletNode(c, 'pl-voice-gate', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] }); } catch {}
  }
  let effect = null;
  if (settings.voiceFx !== 'none') {
    try { effect = await effectChain(c, settings.voiceFx); }
    catch { settings.voiceFx = 'none'; saveSettings(); toast("Voice effects can't run here.", 5000); }
  }
  const gain = c.createGain();
  gain.gain.value = settings.inputVol;
  const dest = c.createMediaStreamDestination();
  try { dest.channelCount = 1; } catch {}
  const lowcut = settings.noiseMode === 'on' ? lowCut(c) : null;
  let last = source;   // mic → low cut → noise filter → gate → effect → volume
  if (lowcut) for (const b of lowcut) { last.connect(b); last = b; }
  const feed = last;   // what feeds the noise filter (cut off from it while it rests)
  if (node) { last.connect(node); last = node; }
  if (gate) { last.connect(gate); last = gate; }
  if (effect) { last.connect(effect.input); last = effect.output; }
  last.connect(gain);
  gain.connect(dest);
  teardownFx();
  V.fx = { source, lowcut, feed, node, gate, gain, dest, effect, filter };
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
  if (monitor) setMonitor(true);
  const track = raw.getAudioTracks()[0];
  if (!track || !real) return;
  track.addEventListener('ended', () => { log('voice', `Microphone stopped (${track.label || 'mic'})`); if (V.rawStream === raw) { V.noMic = true; applyMic(); setIssue('disconnected'); } });
  track.addEventListener('mute', () => { log('voice', 'The computer muted the microphone'); setTimeout(() => { if (V.rawStream === raw && track.muted && !V.noMic) setIssue('osmuted'); }, 1500); });
  track.addEventListener('unmute', () => { log('info', 'Microphone unmuted by the computer'); if (V.rawStream === raw && V.micIssue === 'osmuted') setIssue(null); });
}
function setIssue(kind) { if (V.micIssue !== kind) { V.micIssue = kind; hooks.micIssue(kind); hooks.change(); } }
let nsRetried = false;   // the microphone was opened again once to switch the browser's filter (not every time: some can't)
export async function setupMic(deviceId = settings.micId) {
  // Whether the speech model runs here decides whether the browser's own filter is wanted (see browserNs)
  if (settings.noiseMode === 'on' && speechOk === null) await loadGtcrn().then(() => { speechOk = true; }, () => { speechOk = false; });
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
    // The speech model didn't start after all (or started after failing before): once more, with the browser's
    // own filter switched to match
    const ns = t && t.getSettings ? t.getSettings().noiseSuppression : undefined;
    if (!nsRetried && typeof ns === 'boolean' && ns !== browserNs()) { nsRetried = true; return setupMic(deviceId); }
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
  setMonitor(false);
  for (const st of [V.rawStream, V.micStream]) if (st) st.getTracks().forEach((t) => t.stop());
  teardownFx();
  V.rawStream = V.micStream = V.sendTrack = null; V.noMic = true;
}
export async function setNoiseMode(mode) {
  if (!['off', 'on'].includes(mode) || settings.noiseMode === mode) return;
  settings.noiseMode = mode; saveSettings();
  if (V.rawStream && !V.noMic) await setupMic(settings.micId);   // the browser's own filter needs a fresh stream
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
export function applyMic() { if (V.sendTrack) V.sendTrack.enabled = micLive(); restFilter(!micLive() && !monitor); }   // (not while you're hearing yourself)
/* While you're muted, deafened or not holding push to talk, the noise filter gets no sound to work on (it rests,
   saving battery on phones), and picks up again the moment you can be heard. */
function restFilter(rest) {
  const fx = V.fx;
  if (!fx || !fx.node || !!fx.resting === rest) return;
  try { if (rest) fx.feed.disconnect(fx.node); else fx.feed.connect(fx.node); fx.resting = rest; } catch {}
}

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
    V.channelId = channelId; V.joinedAt = Date.now();
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
  V.channelId = null; V.rejoining = true;
  try { await joinVoice(id); } catch { leaveVoice(false); hooks.system('You were disconnected from voice.'); }
  finally { V.rejoining = false; }
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
// Small changes (even volumes) slide over a fraction of a second instead of stepping; muting and big jumps are instant.
// The talking loop (every 60 ms) moves it along (stepVolume), so there are no extra timers.
function glideVolume(p, target) {
  if (target === 0 || Math.abs(p.audioEl.volume - target) > 0.25) { p.audioEl.volume = target; p.volTarget = null; return; }
  p.volTarget = target;
}
function stepVolume(p) {
  if (p.volTarget == null || !p.audioEl) return;
  const d = p.volTarget - p.audioEl.volume;
  if (Math.abs(d) <= 0.03) { p.audioEl.volume = p.volTarget; p.volTarget = null; } else p.audioEl.volume += Math.sign(d) * 0.03;
}
// Up to 100% a person plays through a normal audio element. Above that their voice goes through a gain node and a limiter.
function applyVolume(p) {
  if (!p.audioEl) return;
  const pref = peerPrefs(p.id);
  const v = V.deafened || pref.mute ? 0 : clampLevel(pref.vol) * settings.outputVol * (p.autoGain || 1);
  // Switch paths with some room either side of 100% (in at 105%, out below 90%), so a level hovering around 100%
  // (even volumes moves it in small steps) doesn't flip back and forth with a click each time.
  const boost = !!p.source && v > 0 && (p.gain ? v >= 0.9 : v > 1.05);
  if (!boost) {
    try { p.gain && p.gain.disconnect(); } catch {}
    p.gain = null;
    p.audioEl.muted = false; glideVolume(p, Math.min(1, v));
  } else {
    const c = audioCtx();
    if (!p.gain) { p.gain = c.createGain(); p.gain.gain.value = v; p.source.connect(p.gain); p.gain.connect(bus()); }
    else p.gain.gain.setTargetAtTime(v, c.currentTime, 0.08);   // glide, no zipper noise
    p.audioEl.muted = true; p.volTarget = null;
  }
}
export function applyAllVolumes() { for (const p of V.peers.values()) applyVolume(p); }
export function applySpeaker() {
  if (outBus && typeof audioCtx().setSinkId === 'function') audioCtx().setSinkId(settings.speakerId || '').catch(() => {});
  for (const el of document.querySelectorAll('#audioSink audio, #stageVideo')) if (el.setSinkId) el.setSinkId(settings.speakerId || '').catch(() => {});
}
export function unlockAudio() { for (const p of V.peers.values()) if (p.audioEl) p.audioEl.play().catch(() => {}); audioCtx(); }

/* Even volumes: while a friend talks, their usual loudness is learned (slowly, over a few seconds of speech), and their
   volume is nudged toward the same level for everyone, at most twice as loud or half as loud. It works on top of the
   volume you set for them, so quiet friends get a bit louder and loud ones a bit softer without touching a slider. */
const EVEN_TARGET = 0.08;
export function evenOut(p, lv) {
  p.loud = p.loud ? p.loud * 0.985 + lv * 0.015 : lv;
  p.heard = (p.heard || 0) + 1;
  if (p.heard < 30) return;   // about 2 seconds of talking first
  const want = Math.min(2, Math.max(0.5, EVEN_TARGET / p.loud)), g = p.autoGain || 1, next = g + (want - g) * 0.08;
  if (Math.abs(next - g) / g > 0.03) { p.autoGain = next; applyVolume(p); }
}
/* Echo warning: if your speakers reach your microphone, friends hear themselves a moment later. Every 60 ms this notes
   how loud friends are (what you hear) and how loud your microphone is (what you send, after the filters). When your
   microphone keeps following their voices 60–360 ms later, while you aren't the one talking, it's their echo: you
   get a private hint (once per call), and nobody else is told. It uses the levels the talking loop measures (every
   60 ms), so nothing extra is sampled. */
const ECHO_N = 160;   // about 10 seconds
const echoRemote = [], echoMic = [];
let echoTick = 0, echoHits = 0, echoToldFor = null;
export function echoScore(mic, remote) {
  // the best match between the mic's loudness and friends' loudness 1–6 steps (60–360 ms) earlier
  const n = Math.min(mic.length, remote.length);
  let best = 0;
  for (let lag = 1; lag <= 6; lag++) {
    const xs = [], ys = [];
    for (let i = lag; i < n; i++) if (remote[i - lag] > 0.02) { xs.push(remote[i - lag]); ys.push(mic[i]); }   // only while friends talk
    if (xs.length < 30) continue;
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < xs.length; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    if (my < 0.008 || !sxx || !syy) continue;   // the mic barely picks anything up: no echo worth mentioning
    best = Math.max(best, sxy / Math.sqrt(sxx * syy));
  }
  return best;
}
function echoWatch(remote, mic) {
  if (!V.channelId || !micLive() || !localMeter.analyser || !V.peers.size) { echoRemote.length = echoMic.length = 0; echoHits = 0; return; }
  echoRemote.push(V.deafened ? 0 : remote); echoMic.push(mic);
  if (echoRemote.length > ECHO_N) { echoRemote.shift(); echoMic.shift(); }
  if (++echoTick % 33 || echoRemote.length < ECHO_N) return;   // look every 2 seconds, once there's 10 seconds to look at
  echoHits = echoScore(echoMic, echoRemote) > 0.7 ? echoHits + 1 : 0;
  if (echoHits >= 2 && echoToldFor !== V.channelId) { echoToldFor = V.channelId; hooks.echo && hooks.echo(); }
}
function speakLoop() {
  const now = new Set(), sending = V.channelId && micLive(), mic = sending ? level(localMeter.analyser) : 0;
  if (sending && mic > 0.02) now.add(hooks.myId());
  let heard = 0;   // the loudest friend you hear, for the echo check
  for (const p of V.peers.values()) {
    const lv = p.analyser ? level(p.analyser) : 0;
    if (lv > 0.02) now.add(p.id);
    if (lv > 0.012) evenOut(p, lv);   // they're talking (quiet talkers too: everyone else's noise filter keeps silence near zero)
    stepVolume(p);
    const pref = peerPrefs(p.id);
    if (pref.vol > 0 && !pref.mute) heard = Math.max(heard, lv);
  }
  echoWatch(heard, mic);
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
/* The sound of a shared screen leaves out Party Line's own sound (friends' voices, the soundboard, music), or
   watchers would hear everyone twice. Browsers that can leave it out of the capture do (restrictOwnAudio); elsewhere
   (like the Windows desktop app, which shares the whole computer's sound) echo cancellation takes it out, the same
   way it keeps friends' voices out of your microphone. */
export function shareAudio() {
  const supported = navigator.mediaDevices.getSupportedConstraints ? navigator.mediaDevices.getSupportedConstraints() : {};
  return { restrictOwnAudio: true, echoCancellation: !supported.restrictOwnAudio, noiseSuppression: false, autoGainControl: false };
}
export async function startShare() {
  if (!V.channelId || V.sharing) return;
  const q = QUALITY[settings.quality] || QUALITY.motion;
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: q.fps, max: q.fps }, height: { ideal: q.height, max: q.height } },
      audio: shareAudio(),
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
    else { p.lkAudio = track; setRemoteAudio(p, new MediaStream([t])); }
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
    micIssue: V.micIssue, noMic: V.noMic, noise: settings.noiseMode, filterRunning: !!(V.fx && V.fx.node), filterResting: !!(V.fx && V.fx.resting), gate: !!(V.fx && V.fx.gate), lowCut: !!(V.fx && V.fx.lowcut), browserNs: raw && raw.getSettings ? raw.getSettings().noiseSuppression : null, filter: V.fx ? V.fx.filter || null : null, audio: ctx,
    peers: [],
  };
  for (const p of V.peers.values()) {
    const d = { userId: p.id, net: p.net, hearing: !!(p.stream && p.stream.getAudioTracks().some((t) => t.readyState === 'live')),
      audioEl: p.audioEl ? { paused: p.audioEl.paused, muted: p.audioEl.muted, volume: +p.audioEl.volume.toFixed(2) } : null, autoGain: +(p.autoGain || 1).toFixed(2) };
    // Direct mode: one connection per friend. Media server mode: this friend's audio receiver and our mic sender.
    const sources = p.pc ? [p.pc] : [p.lkAudio && p.lkAudio.receiver, lk && lk.mic && lk.mic.track && lk.mic.track.sender].filter(Boolean);
    if (p.pc) Object.assign(d, { state: p.pc.connectionState, ice: p.pc.iceConnectionState, signaling: p.pc.signalingState });
    else if (lk) d.state = lk.room.state;
    for (const source of sources) {
      try {
        const rep = await source.getStats();
        const by = new Map(); rep.forEach((s) => by.set(s.id, s));
        let pair = null;
        rep.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = by.get(s.selectedCandidatePairId); });
        if (!pair) rep.forEach((s) => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; });
        if (pair && !d.path) {
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
