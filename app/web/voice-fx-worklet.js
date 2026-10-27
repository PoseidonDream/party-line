/* Party Line voice effects that need their own sound processing (the others use the browser's own audio nodes, see
   voice.js). Runs inside an AudioWorklet.
   The pitch shifter (Deep, Chipmunk and friends): two read heads move through a short delay line faster or slower
   than it's written, each fading in and out so the jumps back are never heard. */
class PitchShift extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.ratio = o.ratio > 0 ? o.ratio : 1;
    this.win = Math.round(sampleRate * 0.06);       // 60 ms grains
    this.buf = new Float32Array(this.win * 2 + 4);
    this.w = 0; this.phase = 0;
  }
  read(delay) {
    const n = this.buf.length;
    let pos = this.w - delay;
    while (pos < 0) pos += n;
    const i = Math.floor(pos), f = pos - i, a = this.buf[i % n], b = this.buf[(i + 1) % n];
    return a + (b - a) * f;
  }
  process(inputs, outputs) {
    const inp = inputs[0] && inputs[0][0], out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const n = this.buf.length, step = (1 - this.ratio) / this.win;
    for (let i = 0; i < out.length; i++) {
      this.buf[this.w] = inp ? inp[i] : 0;
      this.phase += step;
      if (this.phase >= 1) this.phase -= 1; else if (this.phase < 0) this.phase += 1;
      const p2 = (this.phase + 0.5) % 1, g1 = 0.5 - 0.5 * Math.cos(2 * Math.PI * this.phase);
      out[i] = g1 * this.read(this.phase * this.win + 1) + (1 - g1) * this.read(p2 * this.win + 1);
      this.w = (this.w + 1) % n;
    }
    return true;
  }
}
registerProcessor('pl-pitch', PitchShift);

/* Arcade (8-bit): the voice is sampled less often and with fewer steps, like an old game console. */
class Crush extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.hold = Math.max(1, Math.round(sampleRate / (o.rate || 6000)));
    this.levels = 2 ** ((o.bits || 5) - 1);
    this.n = 0; this.v = 0;
  }
  process(inputs, outputs) {
    const inp = inputs[0] && inputs[0][0], out = outputs[0] && outputs[0][0];
    if (!out) return true;
    for (let i = 0; i < out.length; i++) {
      if (this.n++ % this.hold === 0) { const x = Math.max(-1, Math.min(1, (inp ? inp[i] : 0) * 4)); this.v = Math.round(x * this.levels) / this.levels; }
      out[i] = this.v * 0.3;
    }
    return true;
  }
}
registerProcessor('pl-crush', Crush);

/* Glitchy: every second or so a tiny piece of what you just said repeats a few times, like a skipping CD. */
class Glitch extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(sampleRate);   // the last second
    this.w = 0; this.left = 0; this.len = 0; this.start = 0; this.pos = 0;
    this.wait = this.nextWait();
  }
  nextWait() { return Math.round(sampleRate * (0.5 + Math.random() * 1.2)); }
  process(inputs, outputs) {
    const inp = inputs[0] && inputs[0][0], out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const n = this.buf.length, edge = 96;
    for (let i = 0; i < out.length; i++) {
      const x = inp ? inp[i] : 0;
      this.buf[this.w] = x; this.w = (this.w + 1) % n;
      if (this.left > 0) {
        // short fades at both ends of the piece, so it repeats without clicks
        const fade = Math.min(1, this.pos / edge, (this.len - this.pos) / edge);
        out[i] = this.buf[(this.start + this.pos) % n] * fade;
        if (++this.pos >= this.len) this.pos = 0;
        this.left--;
        continue;
      }
      out[i] = x;
      if (--this.wait <= 0) {
        this.len = Math.round(sampleRate * (0.05 + Math.random() * 0.07));
        this.start = (this.w - this.len + n) % n; this.pos = 0;
        this.left = this.len * (2 + Math.floor(Math.random() * 3));
        this.wait = this.nextWait();
      }
    }
    return true;
  }
}
registerProcessor('pl-glitch', Glitch);

/* Slow-mo: your voice played back slower, so it comes out deep and drawn out, like a slowed-down video.
   Playing slower than you talk builds up a backlog, so it catches up in your pauses (it skips ahead through
   quiet parts), and if you talk without a break for too long it jumps ahead, with a short crossfade. */
class Slow extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.rate = o.rate > 0 && o.rate < 1 ? o.rate : 0.72;
    this.n = Math.round(sampleRate * 4);                 // the last 4 seconds
    this.buf = new Float32Array(this.n);
    this.loud = new Float32Array(Math.ceil(this.n / 128) + 1);   // how loud each 128-sample piece was
    this.w = 0; this.r = 0;                              // samples written / read position, counted from the start
    this.maxLag = sampleRate * 1.5; this.keepLag = sampleRate * 0.3; this.minLag = sampleRate * 0.03;
    this.xf = 0; this.oldR = 0;                          // crossfade after a jump
  }
  at(pos) {
    const i = Math.floor(pos), f = pos - i, a = this.buf[i % this.n], b = this.buf[(i + 1) % this.n];
    return a + (b - a) * f;
  }
  process(inputs, outputs) {
    const inp = inputs[0] && inputs[0][0], out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const len = out.length, pieces = this.loud.length;
    let e = 0;
    for (let i = 0; i < len; i++) { const x = inp ? inp[i] : 0; this.buf[(this.w + i) % this.n] = x; e += x * x; }
    this.loud[Math.floor(this.w / 128) % pieces] = Math.sqrt(e / len);
    this.w += len;
    const XF = 512;
    for (let i = 0; i < len; i++) {
      const lag = this.w - this.r;
      if (lag > this.maxLag && !this.xf) { this.oldR = this.r; this.r = this.w - this.keepLag; this.xf = XF; }
      let y = this.at(this.r);
      if (this.xf) { const k = this.xf / XF; y = y * (1 - k) + this.at(this.oldR) * k; this.oldR += this.rate; this.xf--; }
      out[i] = y;
      const quiet = this.loud[Math.floor(this.r / 128) % pieces] < 0.006;
      this.r += quiet && lag > this.minLag ? 4 : this.rate;   // pauses go by fast, to catch up
      if (this.r > this.w - 2) this.r = this.w - 2;
    }
    return true;
  }
}
registerProcessor('pl-slow', Slow);
