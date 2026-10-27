/* Soundboard: the built-in meme sounds are made on the spot with Web Audio (no recordings to license), and
   uploaded sounds are fetched once and kept. play() mixes them in at the soundboard volume. */
const BUILTIN = [
  { id: 'vineboom', name: 'Vine boom', emoji: '💥' },
  { id: 'pipe', name: 'Metal pipe', emoji: '🔩' },
  { id: 'airhorn', name: 'MLG airhorn', emoji: '📯' },
  { id: 'dundun', name: 'Dun dun dunnn', emoji: '😱' },
  { id: 'crickets', name: 'Crickets', emoji: '🦗' },
  { id: 'trombone', name: 'Sad trombone', emoji: '🎺' },
  { id: 'rimshot', name: 'Ba-dum-tss', emoji: '🥁' },
  { id: 'bonk', name: 'Bonk', emoji: '🔨' },
  { id: 'scratch', name: 'Record scratch', emoji: '💿' },
  { id: 'fart', name: 'Fart', emoji: '💨' },
  { id: 'bleep', name: 'Bleep', emoji: '🤬' },
  { id: 'error', name: 'Error', emoji: '❌' },
  { id: 'spooky', name: 'Spooky', emoji: '🛸' },
  { id: 'slide', name: 'Slide whistle', emoji: '📉' },
  { id: 'victory', name: 'Victory', emoji: '🏆' },
  { id: 'bong', name: 'Bong', emoji: '🔔' },
];
export const builtinSounds = () => BUILTIN;

let ctx = null;
const audio = () => { if (!ctx) ctx = new AudioContext(); if (ctx.state === 'suspended') ctx.resume().catch(() => {}); return ctx; };
const buffers = new Map();   // url -> Promise<AudioBuffer>

function noise(c, secs) {
  const b = c.createBuffer(1, Math.floor(c.sampleRate * secs), c.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}
/* A plucked or struck note: it starts loud and dies away. */
function tone(c, out, { type = 'sawtooth', freq, to, at, dur, vol = 0.3, attack = 0.01 }) {
  const o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, at);
  if (to) o.frequency.exponentialRampToValueAtTime(to, at + dur);
  g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(vol, at + attack); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(out); o.start(at); o.stop(at + dur + 0.05);
}
/* A held note (a horn, a whistle): it stays at the same loudness until it lets go. */
function note(c, out, { type = 'sawtooth', freq, to, at, dur, vol = 0.2, attack = 0.02, release = 0.08, vibrato = 0, lp = 0 }) {
  const o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, at);
  if (to) o.frequency.exponentialRampToValueAtTime(to, at + dur);
  let last = o;
  if (lp) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; o.connect(f); last = f; }
  g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(vol, at + attack);
  g.gain.setValueAtTime(vol, at + Math.max(attack, dur - release)); g.gain.linearRampToValueAtTime(0, at + dur);
  last.connect(g).connect(out);
  if (vibrato) {
    const v = c.createOscillator(), vg = c.createGain();
    v.frequency.value = 5.5; vg.gain.value = freq * vibrato;
    v.connect(vg).connect(o.frequency); v.start(at); v.stop(at + dur + 0.05);
  }
  o.start(at); o.stop(at + dur + 0.05);
}
function hit(c, out, { at, dur, vol = 0.5, freq = 2000, q = 1, type = 'bandpass' }) {
  const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
  s.buffer = noise(c, dur); f.type = type; f.frequency.value = freq; f.Q.value = q;
  g.gain.setValueAtTime(vol, at); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  s.connect(f).connect(g).connect(out); s.start(at);
}
/* A room around the sound: what goes in comes out as it is, plus an echo that dies away over `secs`. */
function space(c, out, secs, wet) {
  const input = c.createGain(), cv = c.createConvolver(), w = c.createGain();
  const len = Math.floor(c.sampleRate * secs), b = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) { const x = b.getChannelData(ch); for (let i = 0; i < len; i++) x[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3; }
  cv.buffer = b; w.gain.value = wet;
  input.connect(out); input.connect(cv).connect(w).connect(out);
  return input;
}
/* Overdrive: louder and crunchier, and it makes low booms audible on phone and laptop speakers. */
const softClip = (k) => { const n = 1024, curve = new Float32Array(n); for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(k * x) / Math.tanh(k); } return curve; };
function drive(c, out, k, level = 0.8) { const s = c.createWaveShaper(), g = c.createGain(); s.curve = softClip(k); s.oversample = '2x'; g.gain.value = level; s.connect(g).connect(out); return s; }

const SYNTH = {
  vineboom(c, out, t) {
    const bus = space(c, out, 1.6, 0.3), d = drive(c, bus, 2.5);
    tone(c, d, { type: 'sine', freq: 95, to: 42, at: t, dur: 1.3, vol: 0.85, attack: 0.006 });
    tone(c, d, { type: 'triangle', freq: 190, to: 84, at: t, dur: 0.9, vol: 0.3, attack: 0.005 });
    hit(c, bus, { at: t, dur: 0.09, freq: 700, q: 0.8, vol: 0.5, type: 'lowpass' });
  },
  pipe(c, out, t) {
    const bus = space(c, out, 2.2, 0.35), d = drive(c, bus, 1.6, 0.7);
    // A falling metal pipe: a clang (a metal bar's out-of-tune overtones), then two smaller bounces.
    const clang = (at, v) => {
      for (const [r, a, len] of [[1, 0.3, 1.8], [2.756, 0.26, 1.3], [5.404, 0.2, 0.9], [8.933, 0.13, 0.55], [13.34, 0.08, 0.3]]) {
        tone(c, d, { type: 'sine', freq: 480 * r, at, dur: len * v, vol: a * v, attack: 0.001 });
        tone(c, d, { type: 'sine', freq: 480 * r * 1.004, at, dur: len * v * 0.8, vol: a * v * 0.5, attack: 0.001 });
      }
      hit(c, d, { at, dur: 0.05, freq: 4000, q: 0.5, type: 'highpass', vol: 0.5 * v });
    };
    clang(t, 1); clang(t + 0.2, 0.5); clang(t + 0.33, 0.3);
  },
  airhorn(c, out, t) {
    const d = drive(c, out, 3);
    for (const [s, len] of [[t, 0.15], [t + 0.2, 0.15], [t + 0.4, 0.15], [t + 0.6, 0.95]]) {
      for (const f of [440, 554, 659, 880]) note(c, d, { freq: f * (1 + (Math.random() - 0.5) * 0.006), at: s, dur: len, vol: 0.09, attack: 0.012, release: 0.04, lp: 3500 });
    }
  },
  dundun(c, out, t) {
    const bus = space(c, out, 1.8, 0.3);
    // Three stabs of an orchestra, each lower than the last; the last one hangs in the air.
    const stab = (root, at, len) => {
      for (const r of [1, 1.189, 1.498, 2]) note(c, bus, { freq: root * r, at, dur: len, vol: 0.08, attack: 0.012, release: len > 1 ? 0.9 : 0.06, lp: 1600, vibrato: len > 1 ? 0.01 : 0 });
      tone(c, bus, { type: 'sine', freq: 110, to: 48, at, dur: 0.55, vol: 0.55, attack: 0.003 });   // timpani
      hit(c, bus, { at, dur: 0.25, freq: 300, q: 0.8, vol: 0.3, type: 'lowpass' });
    };
    stab(196, t, 0.22); stab(185, t + 0.32, 0.22); stab(155.6, t + 0.64, 1.9);
  },
  crickets(c, out, t) {
    const chirp = (f, at) => { for (let i = 0; i < 3; i++) tone(c, out, { type: 'sine', freq: f, to: f * 0.97, at: at + i * 0.045, dur: 0.032, vol: 0.4, attack: 0.004 }); };
    for (let k = 0; k < 6; k++) { chirp(4400, t + k * 0.45); chirp(4950, t + 0.21 + k * 0.45 + (k % 2) * 0.03); }
  },
  trombone(c, out, t) {
    [[293.7, 0.42], [277.2, 0.42], [261.6, 0.42], [246.9, 1.5]].reduce((s, [f, len], i) => {
      const last = i === 3;
      note(c, out, { freq: f, to: last ? f * 0.97 : undefined, at: s, dur: len, vol: 0.45, attack: 0.06, release: last ? 0.5 : 0.1, lp: 1000, vibrato: last ? 0.025 : 0 });
      return s + len + 0.06;
    }, t);
  },
  rimshot(c, out, t) {
    tone(c, out, { type: 'sine', freq: 180, to: 60, at: t, dur: 0.18, vol: 0.6 }); hit(c, out, { at: t, dur: 0.12, freq: 1800, vol: 0.4 });
    tone(c, out, { type: 'sine', freq: 160, to: 55, at: t + 0.22, dur: 0.18, vol: 0.6 }); hit(c, out, { at: t + 0.22, dur: 0.12, freq: 1800, vol: 0.4 });
    hit(c, out, { at: t + 0.48, dur: 1.1, freq: 7000, q: 0.7, type: 'highpass', vol: 0.35 });
  },
  bonk(c, out, t) {
    tone(c, out, { type: 'sine', freq: 520, to: 170, at: t, dur: 0.28, vol: 0.6, attack: 0.002 });
    tone(c, out, { type: 'triangle', freq: 1250, to: 880, at: t, dur: 0.1, vol: 0.35, attack: 0.001 });
    hit(c, out, { at: t, dur: 0.06, freq: 2500, q: 1.2, vol: 0.4 });
  },
  scratch(c, out, t) {
    // The record is pushed back and forth by hand: the pitch and the hiss follow it, then it stops dead.
    const s = c.createBufferSource(), f = c.createBiquadFilter(), o = c.createOscillator(), of = c.createBiquadFilter(), g = c.createGain(), og = c.createGain();
    s.buffer = noise(c, 0.9); f.type = 'bandpass'; f.Q.value = 3; o.type = 'sawtooth'; of.type = 'lowpass'; of.frequency.value = 2500; og.gain.value = 0.35;
    const pts = [[0, 300], [0.11, 1500], [0.2, 260], [0.32, 1900], [0.44, 220], [0.6, 1100], [0.74, 140]];
    f.frequency.setValueAtTime(pts[0][1], t); o.frequency.setValueAtTime(pts[0][1] / 4, t);
    for (const [dt, v] of pts.slice(1)) { f.frequency.exponentialRampToValueAtTime(v, t + dt); o.frequency.exponentialRampToValueAtTime(v / 4, t + dt); }
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.9, t + 0.02); g.gain.setValueAtTime(0.9, t + 0.66); g.gain.linearRampToValueAtTime(0, t + 0.76);
    s.connect(f).connect(g); o.connect(of).connect(og).connect(g); g.connect(out);
    s.start(t); o.start(t); o.stop(t + 0.8);
  },
  fart(c, out, t) {
    const o = c.createOscillator(), g = c.createGain(), lp = c.createBiquadFilter(), len = 0.9, n = 60;
    o.type = 'sawtooth'; lp.type = 'lowpass'; lp.frequency.value = 520; lp.Q.value = 4;
    const pitch = new Float32Array(n), loud = new Float32Array(n + 1);
    for (let i = 0; i < n; i++) pitch[i] = (82 + 28 * Math.sin((i / n) * Math.PI)) * (0.85 + Math.random() * 0.3);
    for (let i = 0; i < n; i++) loud[i] = Math.min(1, i / 3) * (1 - i / n) ** 0.5 * (0.6 + Math.random() * 0.4) * 0.6;
    o.frequency.setValueCurveAtTime(pitch, t, len); g.gain.setValueCurveAtTime(loud, t, len);
    o.connect(lp).connect(g).connect(out); o.start(t); o.stop(t + len + 0.05);
    hit(c, out, { at: t, dur: len, freq: 220, q: 2, vol: 0.2 });
  },
  bleep(c, out, t) { note(c, out, { type: 'sine', freq: 1000, at: t, dur: 0.65, vol: 0.35, attack: 0.005, release: 0.02 }); },
  error(c, out, t) {
    for (const f of [880, 659.3]) note(c, out, { type: 'triangle', freq: f, at: t, dur: 0.16, vol: 0.25, attack: 0.004, release: 0.03 });
    for (const f of [587.3, 440]) note(c, out, { type: 'triangle', freq: f, at: t + 0.19, dur: 0.42, vol: 0.25, attack: 0.004, release: 0.2 });
  },
  spooky(c, out, t) {
    // A wobbly theremin, like an old UFO film.
    const bus = space(c, out, 2.5, 0.45), o = c.createOscillator(), g = c.createGain(), v = c.createOscillator(), vg = c.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(300, t);
    for (const [dt, f] of [[0.6, 620], [1.2, 440], [1.8, 720], [2.6, 360]]) o.frequency.linearRampToValueAtTime(f, t + dt);
    v.frequency.value = 6; vg.gain.value = 14; v.connect(vg).connect(o.frequency);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.4, t + 0.3); g.gain.setValueAtTime(0.4, t + 1.9); g.gain.linearRampToValueAtTime(0, t + 2.6);
    o.connect(g).connect(bus); o.start(t); v.start(t); o.stop(t + 2.65); v.stop(t + 2.65);
  },
  slide(c, out, t) {
    note(c, out, { type: 'sine', freq: 1800, to: 280, at: t, dur: 0.95, vol: 0.35, attack: 0.03, release: 0.12, vibrato: 0.012 });
    hit(c, out, { at: t, dur: 0.95, freq: 1200, q: 1.5, vol: 0.05 });
  },
  victory(c, out, t) {
    [[523.25, 0.1], [659.25, 0.1], [783.99, 0.1], [1046.5, 0.24], [783.99, 0.1], [1046.5, 0.7]].reduce((s, [f, len], i, all) => {
      note(c, out, { type: 'square', freq: f, at: s, dur: len, vol: 0.1, attack: 0.004, release: i === all.length - 1 ? 0.3 : 0.02, lp: 4500 });
      return s + len + 0.02;
    }, t);
    note(c, out, { type: 'triangle', freq: 130.8, at: t, dur: 1.4, vol: 0.3, attack: 0.01, release: 0.3 });
  },
  bong(c, out, t) {
    // A big bell: its overtones aren't in tune with each other, and the low hum rings longest.
    const bus = space(c, out, 2, 0.25);
    for (const [r, a, len] of [[0.5, 0.25, 3], [1, 0.35, 2.5], [1.183, 0.18, 1.8], [1.506, 0.14, 1.5], [2, 0.12, 1.2], [2.66, 0.07, 0.8], [3.01, 0.05, 0.6]]) tone(c, bus, { type: 'sine', freq: 233 * r, at: t, dur: len, vol: a * 0.75, attack: 0.002 });
    hit(c, bus, { at: t, dur: 0.04, freq: 1500, q: 1, vol: 0.3 });
  },
  // Sounds the soundboard used to have, still played when an older shortcut or app sends them.
  ding(c, out, t) { tone(c, out, { type: 'sine', freq: 1320, at: t, dur: 1.4, vol: 0.4, attack: 0.002 }); tone(c, out, { type: 'sine', freq: 2640, at: t, dur: 0.8, vol: 0.12, attack: 0.002 }); },
  drumroll(c, out, t) { for (let i = 0; i < 28; i++) hit(c, out, { at: t + i * 0.055, dur: 0.07, freq: 900, q: 0.8, vol: 0.18 + i * 0.012 }); tone(c, out, { type: 'sine', freq: 140, to: 50, at: t + 1.6, dur: 0.3, vol: 0.7 }); hit(c, out, { at: t + 1.6, dur: 1, freq: 6000, q: 0.6, type: 'highpass', vol: 0.4 }); },
  boing(c, out, t) { const o = c.createOscillator(), g = c.createGain(), lfo = c.createOscillator(), lg = c.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(520, t + 0.7);
    lfo.frequency.value = 14; lg.gain.value = 40; lfo.connect(lg).connect(o.frequency);
    g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
    o.connect(g).connect(out); o.start(t); lfo.start(t); o.stop(t + 0.85); lfo.stop(t + 0.85); },
};

/* Plays a sound: { builtin: 'airhorn' } or { url }. volume 0..1. */
export async function playSound(s, volume) {
  const c = audio(), out = c.createGain();
  out.gain.value = Math.max(0, Math.min(1, volume));
  out.connect(c.destination);
  if (s.builtin) { const f = Object.hasOwn(SYNTH, s.builtin) && SYNTH[s.builtin]; if (f) f(c, out, c.currentTime + 0.02); return; }
  if (!buffers.has(s.url)) buffers.set(s.url, fetch(s.url).then((r) => r.arrayBuffer()).then((b) => c.decodeAudioData(b)));
  try {
    const src = c.createBufferSource(); src.buffer = await buffers.get(s.url);
    src.connect(out); src.start();
  } catch { buffers.delete(s.url); }
}
/* A built-in sound recorded into a buffer instead of played (for the tests: is it loud enough, and not clipped?). */
export function renderBuiltin(id, secs = 4) {
  const c = new OfflineAudioContext(1, 48000 * secs, 48000), out = c.createGain();
  out.connect(c.destination);
  SYNTH[id](c, out, 0.02);
  return c.startRendering();
}
/* Adding a sound: any audio or video file this device can play is opened, and the part you pick (up to 7
   seconds) becomes a small WAV file that plays everywhere, at a steady loudness. */
export const MAX_CLIP = 7;
export async function openClip(file) { return audio().decodeAudioData(await file.arrayBuffer()); }
export async function clipToWav(buf, start, len) {
  const rate = Math.min(48000, buf.sampleRate), n = Math.max(1, Math.round(len * rate));
  const c = new OfflineAudioContext(1, n, rate), src = c.createBufferSource();
  src.buffer = buf; src.connect(c.destination); src.start(0, start, len);
  const d = (await c.startRendering()).getChannelData(0);
  let peak = 0; for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  const gain = peak > 0 ? Math.min(4, 0.9 / peak) : 1, fade = Math.min(d.length / 2, Math.round(rate * 0.01));
  const out = new DataView(new ArrayBuffer(44 + d.length * 2)), str = (o, t) => { for (let i = 0; i < t.length; i++) out.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); out.setUint32(4, 36 + d.length * 2, true); str(8, 'WAVE'); str(12, 'fmt '); out.setUint32(16, 16, true);
  out.setUint16(20, 1, true); out.setUint16(22, 1, true); out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  str(36, 'data'); out.setUint32(40, d.length * 2, true);
  for (let i = 0; i < d.length; i++) {
    const edge = Math.min(1, i / fade, (d.length - 1 - i) / fade);   // a 10 ms fade at both ends, so a cut never clicks
    out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, d[i] * gain * edge)) * 0x7fff, true);
  }
  return new Blob([out.buffer], { type: 'audio/wav' });
}
/* Plays part of a clip to you alone (the Preview button). Returns a function that stops it. */
export function previewClip(buf, start, len, volume, onEnd) {
  const c = audio(), src = c.createBufferSource(), g = c.createGain();
  src.buffer = buf; g.gain.value = Math.max(0, Math.min(1, volume));
  src.connect(g).connect(c.destination); src.onended = onEnd; src.start(0, start, len);
  return () => { src.onended = null; try { src.stop(); } catch {} };
}
