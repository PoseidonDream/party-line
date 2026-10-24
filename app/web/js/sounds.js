/* Soundboard: the built-in sounds are made on the spot with Web Audio (no recordings to license), and
   uploaded sounds are fetched once and kept. play() mixes them in at the soundboard volume. */
const BUILTIN = [
  { id: 'airhorn', name: 'Airhorn', emoji: '📯' },
  { id: 'rimshot', name: 'Ba-dum-tss', emoji: '🥁' },
  { id: 'trombone', name: 'Sad trombone', emoji: '🎺' },
  { id: 'ding', name: 'Ding', emoji: '🔔' },
  { id: 'drumroll', name: 'Drumroll', emoji: '🪘' },
  { id: 'boing', name: 'Boing', emoji: '🦘' },
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
function tone(c, out, { type = 'sawtooth', freq, to, at, dur, vol = 0.3, attack = 0.01 }) {
  const o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, at);
  if (to) o.frequency.exponentialRampToValueAtTime(to, at + dur);
  g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(vol, at + attack); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(out); o.start(at); o.stop(at + dur + 0.05);
}
function hit(c, out, { at, dur, vol = 0.5, freq = 2000, q = 1, type = 'bandpass' }) {
  const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
  s.buffer = noise(c, dur); f.type = type; f.frequency.value = freq; f.Q.value = q;
  g.gain.setValueAtTime(vol, at); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  s.connect(f).connect(g).connect(out); s.start(at);
}
const SYNTH = {
  airhorn(c, out, t) { for (const [s, e] of [[t, 0.35], [t + 0.45, 0.35], [t + 0.9, 0.9]]) for (const f of [415, 622, 830]) tone(c, out, { freq: f, at: s, dur: e, vol: 0.12, attack: 0.02 }); },
  rimshot(c, out, t) {
    tone(c, out, { type: 'sine', freq: 180, to: 60, at: t, dur: 0.18, vol: 0.6 }); hit(c, out, { at: t, dur: 0.12, freq: 1800, vol: 0.4 });
    tone(c, out, { type: 'sine', freq: 160, to: 55, at: t + 0.22, dur: 0.18, vol: 0.6 }); hit(c, out, { at: t + 0.22, dur: 0.12, freq: 1800, vol: 0.4 });
    hit(c, out, { at: t + 0.48, dur: 1.1, freq: 7000, q: 0.7, type: 'highpass', vol: 0.35 });
  },
  trombone(c, out, t) { [[392, 0.38], [370, 0.38], [349, 0.38], [330, 1.2]].reduce((s, [f, d]) => { tone(c, out, { freq: f, to: d > 1 ? f * 0.94 : undefined, at: s, dur: d, vol: 0.2, attack: 0.05 }); return s + d + 0.04; }, t); },
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
  if (s.builtin) { const f = SYNTH[s.builtin]; if (f) f(c, out, c.currentTime + 0.02); return; }
  if (!buffers.has(s.url)) buffers.set(s.url, fetch(s.url).then((r) => r.arrayBuffer()).then((b) => c.decodeAudioData(b)));
  try {
    const src = c.createBufferSource(); src.buffer = await buffers.get(s.url);
    src.connect(out); src.start();
  } catch { buffers.delete(s.url); }
}
/* How long an audio file is, to keep uploads short. */
export function soundLength(file) {
  return file.arrayBuffer().then((b) => audio().decodeAudioData(b)).then((buf) => buf.duration);
}
