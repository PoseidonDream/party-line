/* Party Line noise filter: spectral noise suppression + voice gate.
   Runs inside an AudioWorklet. 512-point FFT, 50% overlap, sqrt-Hann windows. */
class Denoiser {
  constructor(sr, opts) {
    const N = 512, H = 256;
    this.N = N; this.H = H; this.K = N / 2 + 1; this.sr = sr;
    this.strength = opts && opts.strength != null ? opts.strength : 1;
    this.win = new Float32Array(N);
    for (let n = 0; n < N; n++) this.win[n] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N));
    this.inF = new Float32Array(N); this.outF = new Float32Array(H); this.ola = new Float32Array(N);
    this.rover = N - H;
    this.re = new Float32Array(N); this.im = new Float32Array(N);
    const K = this.K;
    this.ps = new Float32Array(K); this.psN = new Float32Array(K); this.noise = new Float32Array(K); this.pPrev = new Float32Array(K);
    // minimum statistics: the noise floor is the lowest smoothed power seen in the last ~1.2 s
    this.U = 8; this.V = Math.max(4, Math.round((0.15 * sr) / H)); this.vCount = 0; this.uIdx = 0;
    this.minCur = new Float32Array(K).fill(Infinity); this.minHist = new Float32Array(this.U * K).fill(Infinity);
    this.bias = 2.2;
    this.gPrev = new Float32Array(K).fill(1); this.g = new Float32Array(K); this.gs = new Float32Array(K);
    this.frames = 0; this.gate = 1; this.hold = 0;
    this.lo = Math.max(1, Math.round((250 * N) / sr));   // voice band for the gate
    this.hi = Math.min(K - 1, Math.round((3800 * N) / sr));
    this.over = 1.6;                                      // suppress a little beyond the measured floor
    this.floor = 0.07;                                    // about -23 dB per bin
    this.gateFloor = 0.2;                                 // about -14 dB more between words
    this.rev = new Uint16Array(N);
    const bits = Math.log2(N);
    for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); this.rev[i] = r; }
    this.cos = new Float32Array(N / 2); this.sin = new Float32Array(N / 2);
    for (let k = 0; k < N / 2; k++) { this.cos[k] = Math.cos((2 * Math.PI * k) / N); this.sin[k] = Math.sin((2 * Math.PI * k) / N); }
  }
  fft(re, im) {
    const N = this.N, rev = this.rev;
    for (let i = 0; i < N; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, step = N / size;
      for (let i = 0; i < N; i += size) {
        for (let j = 0; j < half; j++) {
          const k = j * step, wr = this.cos[k], wi = -this.sin[k];
          const a = i + j, b = a + half;
          const tr = wr * re[b] - wi * im[b], ti = wr * im[b] + wi * re[b];
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  }
  frame() {
    const N = this.N, K = this.K, re = this.re, im = this.im, w = this.win;
    for (let n = 0; n < N; n++) { re[n] = this.inF[n] * w[n]; im[n] = 0; }
    this.fft(re, im);
    this.frames++;
    const first = this.frames === 1;
    let sp = 0, nz = 0;
    for (let k = 0; k < K; k++) {
      const p = re[k] * re[k] + im[k] * im[k] + 1e-14;
      const ps = this.ps[k] = first ? p : 0.7 * this.ps[k] + 0.3 * p;
      const pn = this.psN[k] = first ? p : 0.85 * this.psN[k] + 0.15 * p;
      if (pn < this.minCur[k]) this.minCur[k] = pn;
      let m = this.minCur[k];
      for (let u = 0; u < this.U; u++) { const h = this.minHist[u * K + k]; if (h < m) m = h; }
      const target = m * this.bias;
      const n0 = this.noise[k] = first || target < this.noise[k] ? target : 0.9 * this.noise[k] + 0.1 * target;
      const ne = n0 * this.over;
      const post = p / ne;
      const prio = 0.97 * (this.gPrev[k] * this.gPrev[k] * this.pPrev[k]) / ne + 0.03 * Math.max(post - 1, 0);
      let g = prio / (1 + prio);
      if (g < this.floor) g = this.floor;
      this.g[k] = g; this.gPrev[k] = g; this.pPrev[k] = p;
      if (k >= this.lo && k <= this.hi) { sp += ps; nz += ne; }
    }
    if (++this.vCount >= this.V) {
      this.minHist.set(this.minCur, this.uIdx * K);
      this.uIdx = (this.uIdx + 1) % this.U; this.vCount = 0; this.minCur.fill(Infinity);
    }
    // smooth gains across neighbouring bins to avoid "musical noise" chirps
    for (let k = 0; k < K; k++) {
      const a = this.g[k > 0 ? k - 1 : k], b = this.g[k], c = this.g[k < K - 1 ? k + 1 : k];
      this.gs[k] = 0.25 * a + 0.5 * b + 0.25 * c;
    }
    // voice gate: open fast when the voice band rises clearly above the noise, close slowly after a short hold
    if (sp / (nz + 1e-14) > 2.5) this.hold = Math.round((0.18 * this.sr) / this.H);
    const target = this.hold > 0 ? 1 : this.gateFloor;
    if (this.hold > 0) this.hold--;
    this.gate = target > this.gate ? this.gate + (target - this.gate) * 0.6 : this.gate + (target - this.gate) * 0.06;
    const s = this.strength;
    for (let k = 0; k < K; k++) {
      const g = 1 - s + s * this.gs[k] * this.gate;
      re[k] *= g; im[k] *= g;
      if (k > 0 && k < N / 2) { re[N - k] *= g; im[N - k] *= g; }
    }
    for (let n = 0; n < N; n++) im[n] = -im[n];
    this.fft(re, im);
    for (let n = 0; n < N; n++) this.ola[n] += (re[n] / N) * w[n];
  }
  process(input, output) {
    const N = this.N, H = this.H, lat = N - H;
    for (let i = 0; i < input.length; i++) {
      this.inF[this.rover] = input[i];
      output[i] = this.outF[this.rover - lat];
      this.rover++;
      if (this.rover >= N) {
        this.rover = lat;
        this.frame();
        for (let k = 0; k < H; k++) this.outF[k] = this.ola[k];
        this.ola.copyWithin(0, H, N); this.ola.fill(0, N - H);
        this.inF.copyWithin(0, H, N);
      }
    }
  }
}

if (typeof registerProcessor === 'function') {
  registerProcessor('pl-denoise', class extends AudioWorkletProcessor {
    constructor(options) {
      super();
      this.d = new Denoiser(sampleRate, options && options.processorOptions);
      this.mono = new Float32Array(128);
      this.port.onmessage = (e) => { if (e.data && typeof e.data.strength === 'number') this.d.strength = e.data.strength; };
    }
    process(inputs, outputs) {
      const inp = inputs[0], out = outputs[0];
      if (!out || !out[0]) return true;
      const len = out[0].length;
      if (this.mono.length !== len) this.mono = new Float32Array(len);
      this.mono.fill(0);
      if (inp && inp.length) {
        for (let c = 0; c < inp.length; c++) { const ch = inp[c]; for (let i = 0; i < len; i++) this.mono[i] += ch[i] / inp.length; }
      }
      this.d.process(this.mono, out[0]);
      for (let c = 1; c < out.length; c++) out[c].set(out[0]);
      return true;
    }
  });
}
