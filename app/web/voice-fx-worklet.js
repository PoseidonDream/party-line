/* Party Line voice effects: a pitch shifter for the Deep and Chipmunk voices (the other effects use the browser's
   own audio nodes, see voice.js). Two read heads move through a short delay line faster or slower than it's written,
   each fading in and out so the jumps back are never heard. Runs inside an AudioWorklet. */
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
