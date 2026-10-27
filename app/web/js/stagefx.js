/* Extras for watching a screen share on the stage: drawing on it together, and "Clip it".
   Drawings use points from 0 to 1 across the shared picture (not the window), so they land on the same spot for
   everyone however big their window is. Each stroke stays for a moment, then fades. */

const HOLD = 1500, FADE = 1000;

export function createDrawLayer(canvas, video) {
  const ctx = canvas.getContext('2d');
  const strokes = new Map();   // "from:id" -> { pts, color, done, doneAt, at }
  let raf = 0, drawing = false, mine = null, pending = [], flushTimer = 0, onSend = () => {}, color = '#ffd43b';

  /* Where the picture actually is inside the stage (the video keeps its shape, with bars around it). */
  function picture() {
    const W = canvas.clientWidth, H = canvas.clientHeight, vw = video.videoWidth || 16, vh = video.videoHeight || 9;
    const k = Math.min(W / vw, H / vh), w = vw * k, h = vh * k;
    return { x: (W - w) / 2, y: (H - h) / 2, w, h };
  }
  function paint() {
    raf = 0;
    const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const r = picture(), now = Date.now();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(3, r.w / 260);
    for (const [key, s] of strokes) {
      const alpha = s.done ? 1 - Math.max(0, now - s.doneAt - HOLD) / FADE : 1;
      if (alpha <= 0 || (!s.done && now - s.at > 15_000)) { strokes.delete(key); continue; }
      ctx.globalAlpha = alpha; ctx.strokeStyle = s.color; ctx.shadowColor = s.color; ctx.shadowBlur = 8;
      ctx.beginPath();
      s.pts.forEach(([x, y], i) => { const px = r.x + x * r.w, py = r.y + y * r.h; if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
      if (s.pts.length === 1) { const [x, y] = s.pts[0]; ctx.lineTo(r.x + x * r.w + 0.1, r.y + y * r.h); }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (strokes.size) raf = requestAnimationFrame(paint);
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(paint); };
  function add(key, pts, c, end) {
    let s = strokes.get(key);
    if (!s) { s = { pts: [], color: c, done: false, doneAt: 0, at: Date.now() }; strokes.set(key, s); }
    s.pts.push(...pts);
    if (end) { s.done = true; s.doneAt = Date.now(); }
    kick();
  }
  function flush(end) {
    clearTimeout(flushTimer); flushTimer = 0;
    if (!mine || (!pending.length && !end)) return;
    onSend({ id: mine, color, pts: pending, end: !!end });
    pending = [];
  }
  const point = (e) => { const b = canvas.getBoundingClientRect(), r = picture(); return [(e.clientX - b.left - r.x) / r.w, (e.clientY - b.top - r.y) / r.h].map((n) => Math.round(n * 1e4) / 1e4); };
  canvas.addEventListener('pointerdown', (e) => {
    if (!drawing || e.button > 0) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    mine = Math.random().toString(36).slice(2, 10);
    const p = point(e);
    add(`me:${mine}`, [p], color, false);
    pending = [p];
    flushTimer = setTimeout(() => flush(false), 50);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!mine) return;
    const p = point(e);
    add(`me:${mine}`, [p], color, false);
    pending.push(p);
    if (pending.length >= 50) flush(false);
    else if (!flushTimer) flushTimer = setTimeout(() => flush(false), 50);
  });
  const up = () => { if (!mine) return; add(`me:${mine}`, [], color, true); flush(true); mine = null; };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  return {
    setDrawing(on) { drawing = !!on; canvas.classList.toggle('drawing', drawing); if (!drawing) up(); },
    get drawing() { return drawing; },
    setColor(c) { color = c; },
    onSend(fn) { onSend = fn; },
    addRemote(d) { add(`${d.from}:${d.id}`, d.pts || [], d.color, d.end); },
    clear() { strokes.clear(); kick(); },
  };
}

/* "Clip it": while you watch a screen share, two recorders take turns so that one of them always holds between 15
   and 30 seconds of the latest picture and sound. clip() hands that recording over as a video file. */
export const clipsSupported = () => typeof MediaRecorder === 'function' && typeof MediaRecorder.isTypeSupported === 'function';
export function createClipBuffer(seconds = 30) {
  let stream = null, timers = [];
  const recs = [null, null];
  const mimeFor = (s) => {
    const audio = s.getAudioTracks().length;
    return [audio ? 'video/webm;codecs=vp8,opus' : 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
  };
  function start(slot) {
    if (!stream) return;
    let rec;
    try { rec = new MediaRecorder(stream, { mimeType: mimeFor(stream), videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 96_000 }); } catch { return; }
    const r = { rec, chunks: [], at: Date.now() };
    rec.ondataavailable = (e) => { if (e.data && e.data.size) r.chunks.push(e.data); };
    try { rec.start(1000); } catch { return; }
    recs[slot] = r;
  }
  function drop(slot) {
    const r = recs[slot]; recs[slot] = null;
    if (r) { r.rec.ondataavailable = null; try { r.rec.stop(); } catch {} }
  }
  function stopAll() { for (const t of timers) { clearTimeout(t); clearInterval(t); } timers = []; drop(0); drop(1); }
  return {
    watch(s) {
      if (s === stream) return;
      stopAll(); stream = s || null;
      if (!stream || !clipsSupported()) return;
      start(0);
      timers.push(setInterval(() => { drop(0); start(0); }, seconds * 1000));
      timers.push(setTimeout(() => { start(1); timers.push(setInterval(() => { drop(1); start(1); }, seconds * 1000)); }, seconds * 500));
    },
    get ready() { return recs.some(Boolean); },
    /* The longest recording so far (stopped, handed over, and started again). */
    clip() {
      const slot = recs[0] && (!recs[1] || recs[0].at <= recs[1].at) ? 0 : recs[1] ? 1 : -1;
      if (slot < 0) return Promise.resolve(null);
      const r = recs[slot]; recs[slot] = null;
      return new Promise((resolve) => {
        r.rec.onstop = () => {
          const type = (r.rec.mimeType || 'video/webm').split(';')[0];
          const ms = Date.now() - r.at;
          resolve(r.chunks.length ? { blob: new Blob(r.chunks, { type }), ms, seconds: Math.round(ms / 1000) } : null);
        };
        try { r.rec.stop(); } catch { resolve(null); }
        start(slot);
      });
    },
    stop: stopAll,
  };
}
