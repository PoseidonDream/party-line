/* The voice gate: the microphone is cut completely between sentences, so friends hear nothing at all (not the hum of a
   fan, hiss, or what's left of the background after the noise filter) while you're not talking, like Discord's
   automatic input sensitivity. It runs after the noise filter, on the audio thread (so it never lags, also in the
   background), and finds the right level by itself:
   - It follows a smoothed level of the sound (rising at once, falling over about 30 ms), so the flicker of a steady
     noise doesn't look like someone starting to talk.
   - It learns the background: quiet moments pull it down quickly, steady sound lifts it slowly (about 3 s; in the first
     moments after joining voice it learns fast). Speech has tiny pauses, so talking never "becomes background".
   - It opens when the sound is clearly above the background (2.5×, and never for very faint sound) in about 5 ms,
     stays open through the short pauses between words (300 ms), then fades out over about 60 ms.
   Measured (tests/noise.test.mjs): a fan or hiss under a voice drops by 35–45 dB between sentences; the voice, even
   from a quiet microphone, comes through untouched. */
class VoiceGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.env = 0;         // the smoothed level (RMS)
    this.floor = 0.002;   // the background level it has learned
    this.gain = 0;        // 0 closed, 1 open
    this.hold = 0;        // blocks left before it starts closing
    this.age = 0;         // samples since it started (it learns fast at first)
    this.min = 0.004;     // never opens for anything fainter than this (about -48 dBFS)
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length || !out || !out.length) return true;   // resting (muted): nothing comes in
    const x = inp[0], n = x.length;
    let s = 0;
    for (let i = 0; i < n; i++) s += x[i] * x[i];
    const rms = Math.sqrt(s / n);
    this.env += (rms - this.env) * (rms > this.env ? 0.5 : 0.08);
    if (this.env < this.floor) this.floor += (this.env - this.floor) * 0.03;
    else this.floor += (this.env - this.floor) * (this.age < sampleRate * 1.5 ? 0.012 : 0.0008);
    this.age += n;
    if (this.env > Math.max(this.min, this.floor * 2.5)) this.hold = Math.round((0.3 * sampleRate) / n);
    else if (this.hold > 0) this.hold--;
    const target = this.hold > 0 ? 1 : 0;
    const k = 1 - Math.exp(-1 / ((target > this.gain ? 0.005 : 0.06) * sampleRate));   // per sample: 5 ms up, 60 ms down
    let g = this.gain;
    for (let ch = 0; ch < out.length; ch++) {
      const xi = inp[ch] || inp[0], o = out[ch];
      g = this.gain;
      for (let i = 0; i < n; i++) { g += (target - g) * k; o[i] = xi[i] * g; }
    }
    this.gain = g;
    return true;
  }
}
registerProcessor('pl-voice-gate', VoiceGate);
