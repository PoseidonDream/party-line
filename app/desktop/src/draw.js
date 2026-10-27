/* Friends' drawings on your shared screen, shown on top of everything (clicks go through). Points are 0 to 1 across
   the screen. Each stroke stays for a moment, then fades, like in the app. */
const canvas = document.getElementById('c'), ctx = canvas.getContext('2d');
const strokes = new Map();
const HOLD = 1500, FADE = 1000;
let raf = 0;
function paint() {
  raf = 0;
  const dpr = window.devicePixelRatio || 1, W = innerWidth, H = innerHeight, now = Date.now();
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(4, W / 260);
  for (const [key, s] of strokes) {
    const alpha = s.done ? 1 - Math.max(0, now - s.doneAt - HOLD) / FADE : 1;
    if (alpha <= 0 || (!s.done && now - s.at > 15000)) { strokes.delete(key); continue; }
    ctx.globalAlpha = alpha; ctx.strokeStyle = s.color; ctx.shadowColor = s.color; ctx.shadowBlur = 10;
    ctx.beginPath();
    s.pts.forEach(([x, y], i) => { if (i) ctx.lineTo(x * W, y * H); else ctx.moveTo(x * W, y * H); });
    if (s.pts.length === 1) ctx.lineTo(s.pts[0][0] * W + 0.1, s.pts[0][1] * H);
    ctx.stroke();
  }
  if (strokes.size) raf = requestAnimationFrame(paint);
}
window.drawings.onStroke((d) => {
  const key = `${d.from}:${d.id}`;
  let s = strokes.get(key);
  if (!s) { s = { pts: [], color: d.color, done: false, doneAt: 0, at: Date.now() }; strokes.set(key, s); }
  s.pts.push(...d.pts);
  if (d.end) { s.done = true; s.doneAt = Date.now(); }
  if (!raf) raf = requestAnimationFrame(paint);
});
