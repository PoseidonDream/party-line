/* Small shared helpers and the settings saved on this device. */
import { store } from './net.js';

export const $ = (s) => document.querySelector(s);
export const iconSvg = (name) => `<svg class="ic" aria-hidden="true"><use href="#i-${name}"/></svg>`;
export const MAX_LEVEL = 1.5;   // every volume slider goes up to 150%
export const clampLevel = (v) => Math.max(0, Math.min(MAX_LEVEL, Number.isFinite(+v) ? +v : 1));

export const settings = Object.assign(
  { noiseMode: 'strong', ptt: false, quality: 'motion', micId: '', speakerId: '', inputVol: 1, outputVol: 1, notify: false, theme: 'dark', musicVolume: 60 },
  store.get('settings', {}) || {},
);
if (!['off', 'standard', 'strong'].includes(settings.noiseMode)) settings.noiseMode = 'strong';
if (!['none', 'robot', 'deep', 'chipmunk', 'cave', 'radio', 'alien', 'demon', 'underwater', 'arcade', 'wobbly', 'ghost', 'harmony', 'stadium', 'glitch', 'slowmo'].includes(settings.voiceFx)) settings.voiceFx = 'none';   // the same list as VOICE_FX in voice.js
if (!['system', 'dark', 'light'].includes(settings.theme)) settings.theme = 'dark';
if (!['amber', 'cyan', 'violet', 'green', 'pink', 'white'].includes(settings.accent)) settings.accent = 'amber';
// Party Line went black: "match my device" from before becomes dark once (people can switch back in Settings).
if (!settings.themeV) { if (settings.theme === 'system') settings.theme = 'dark'; settings.themeV = 2; }
settings.inputVol = clampLevel(settings.inputVol); settings.outputVol = clampLevel(settings.outputVol);
export const saveSettings = () => store.set('settings', settings);
export const friendVols = store.get('vols', {}) || {};   // per-person volume, by user id
export const saveVols = () => store.set('vols', friendVols);

export function hue(s) { let h = 7; for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) >>> 0; return h % 360; }
export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = [...parts[0]][0] || '';
  const last = parts.length > 1 ? ([...parts[parts.length - 1]][0] || '') : '';
  return (first + last).toLocaleUpperCase();
}

export function toast(text, ms = 3200, action) {
  const el = document.createElement('div');
  el.className = 'toast';
  const t = document.createElement('span'); t.textContent = text; el.appendChild(t);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn small'; b.textContent = action.label;
    b.addEventListener('click', () => { el.remove(); action.fn(); });
    el.appendChild(b);
  }
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

let actx = null;
export function audioCtx() {
  if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state === 'suspended') actx.resume().catch(() => {});
  return actx;
}
export function chime(kind, deafened) {
  if (deafened) return;
  try {
    const c = audioCtx(); const t0 = c.currentTime + 0.01;
    const notes = { join: [523.25, 783.99], leave: [659.25, 392], on: [880], off: [440], msg: [987.77, 1318.51] }[kind] || [600];
    notes.forEach((f, i) => {
      const o = c.createOscillator(), g = c.createGain();
      const st = t0 + i * 0.09;
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, st);
      g.gain.exponentialRampToValueAtTime(0.1, st + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, st + 0.22);
      o.connect(g).connect(c.destination);
      o.start(st); o.stop(st + 0.25);
    });
  } catch {}
}
const buf = new Uint8Array(512);
export function level(an) {
  if (!an) return 0;
  an.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
  return Math.sqrt(sum / buf.length);
}
export function makeAnalyser(stream) {
  if (!stream || !stream.getAudioTracks().length) return { source: null, analyser: null };
  try {
    const c = audioCtx();
    const source = c.createMediaStreamSource(stream);
    const analyser = c.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    return { source, analyser };
  } catch { return { source: null, analyser: null }; }
}
export const locale = () => (settings.lang && settings.lang !== 'en' ? settings.lang : []);   // dates in the chosen language (English: the device's own style)
export const fmtTime = (ts) => new Date(ts).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
export function fmtDay(ts) {
  const d = new Date(ts), n = new Date();
  if (d.toDateString() === n.toDateString()) return 'Today';
  const y = new Date(n); y.setDate(n.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: d.getFullYear() === n.getFullYear() ? undefined : 'numeric' });
}
export const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
