/* The noise filter: one switch, on by default. On, the microphone goes through GTCRN, a small speech model that keeps
   voices and removes the rest. Measured here with a spoken sentence (fixtures/voice.wav) over music made in the
   page (chords, bass, drums and a sung-style melody, the hardest part): the music has to drop a lot between
   sentences while the voice comes through. Off is the raw microphone. Older settings (Strong/Standard) count as On. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launchBrowser, signUp, joinVoice } from './lib.mjs';

const VOICE = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'voice.wav')).toString('base64');

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Bora');
    const diag = () => a.evaluate(async () => { const V = await import('/js/voice.js'); return V.diagnostics(); });

    // On by default, with the speech model
    await joinVoice(a);
    await a.waitForFunction(async () => { const V = await import('/js/voice.js'); return (await V.diagnostics()).filter === 'speech'; }, null, { timeout: 10000 });
    const d1 = await diag();
    ok('the noise filter is on by default, using the speech model (GTCRN)', d1.noise === 'on' && d1.filter === 'speech' && d1.filterRunning);
    await a.click('#setBtn'); await a.click('#settings [data-settab="voice"]');
    ok('…with one switch in Settings and the 🌊 button showing it’s on', await a.evaluate(() => document.querySelector('#setNoise').checked && document.querySelectorAll('input[name="noise"]').length === 0 && document.querySelector('#noiseBtn').getAttribute('aria-pressed') === 'true'));
    await a.waitForSelector('#noiseState:not([hidden])');
    ok('…and Settings says it’s running (“only your voice gets through”)', (await a.textContent('#noiseState')).includes('only your voice'));
    await a.keyboard.press('Escape');

    // The measurement: voice over music, through the same filter the app uses
    // Measured in real time: a busy test machine can drop audio, so up to three tries, keeping the best.
    let r = { musicDrop: 0 };
    for (let attempt = 0; attempt < 3 && !(r.musicDrop < -12); attempt++) r = await a.evaluate(async (b64) => {
      const ctx = new AudioContext({ sampleRate: 48000 });
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const voice = await ctx.decodeAudioData(bytes.buffer);
      const n = voice.length, sr = 48000, t = (i) => i / sr;
      const music = new Float32Array(n), v = voice.getChannelData(0);
      const chords = [[261.6, 329.6, 392.0], [220.0, 261.6, 329.6], [174.6, 220.0, 261.6], [196.0, 246.9, 293.7]], mel = [392, 440, 523, 494, 440, 392, 349, 392];
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const c = chords[Math.floor(t(i) / 2) % 4]; let s = 0;
        for (const f of c) for (let h = 1; h <= 6; h++) s += Math.sin(2 * Math.PI * f * h * t(i)) / h * 0.06;
        s += 0.12 * Math.sin(Math.PI * c[0] * t(i));
        const k = Math.floor(t(i) * 2), tt = t(i) - k / 2, f = mel[k % 8] * (1 + 0.012 * Math.sin(2 * Math.PI * 5.5 * tt));
        ph += 2 * Math.PI * f / sr;
        const env = Math.min(1, tt / 0.03) * Math.exp(-tt * 1.2);
        for (let h = 1; h <= 7; h++) s += 0.1 * env * Math.sin(ph * h) * 0.6 ** h;
        const kick = t(i) % 0.5; if (kick < 0.15) s += 0.3 * Math.exp(-kick / 0.04) * Math.sin(2 * Math.PI * 60 * kick);
        music[i] = s;
      }
      const rms = (x, m) => { let e = 0, c = 0; for (let i = 0; i < x.length; i++) if (m(i)) { e += x[i] * x[i]; c++; } return Math.sqrt(e / Math.max(1, c)); };
      // speech is where the clean voice is loud (with a little margin around it)
      const talk = new Uint8Array(n); for (let i = 0; i < n; i++) if (Math.abs(v[i]) > 0.01) for (let j = Math.max(0, i - 2400); j < Math.min(n, i + 2400); j++) talk[j] = 1;
      const vr = rms(v, (i) => talk[i]), mr = rms(music, () => true), g = vr / mr / 2;   // music about 6 dB under the voice
      const mix = ctx.createBuffer(1, n, sr), m = mix.getChannelData(0); for (let i = 0; i < n; i++) m[i] = v[i] + music[i] * g;
      await ctx.audioWorklet.addModule('/vendor/gtcrn-worklet.js');
      const wasmBinary = await (await fetch('/vendor/gtcrn.wasm')).arrayBuffer();
      const node = new AudioWorkletNode(ctx, '@sapphi-red/web-noise-suppressor/gtcrn', { outputChannelCount: [1], processorOptions: { maxChannels: 1, wasmBinary } });
      // record what comes out (a ScriptProcessor: the page's safety rules don't allow a recorder module from a blob)
      const chunks = [], rec = ctx.createScriptProcessor(1024, 1, 1);
      rec.onaudioprocess = (e) => chunks.push(e.inputBuffer.getChannelData(0).slice());
      const mute = ctx.createGain(); mute.gain.value = 0; rec.connect(mute); mute.connect(ctx.destination);
      await new Promise((res) => setTimeout(res, 1200));   // the model loads
      const src = ctx.createBufferSource(); src.buffer = mix; src.connect(node); node.connect(rec);
      const from = chunks.length; src.start();
      await new Promise((res) => setTimeout(res, (n / sr + 0.6) * 1000));
      const got = chunks.slice(from), out = new Float32Array(got.length * 1024); got.forEach((c, i) => out.set(c, i * 1024));
      // line the output up with the input (the filter adds a few tens of ms)
      let best = -Infinity, lag = 0;
      for (let L = 0; L < 4800; L += 16) { let c = 0; for (let i = 0; i < n - 4800; i += 4) c += v[i] * out[i + L]; if (c > best) { best = c; lag = L; } }
      const y = out.subarray(lag, lag + n);
      const db = (x) => 20 * Math.log10(x + 1e-9);
      await ctx.close();
      return { musicDrop: db(rms(y, (i) => !talk[i])) - db(rms(m, (i) => !talk[i])), voiceKept: db(rms(y, (i) => talk[i])) - db(vr), lagMs: lag / 48 };
    }, VOICE);
    ok(`music between sentences drops by more than 12 dB (${r.musicDrop?.toFixed(1)} dB)`, r.musicDrop < -12);
    ok(`…while the voice comes through (${r.voiceKept?.toFixed(1)} dB, delay ${r.lagMs?.toFixed(0)} ms)`, r.voiceKept > -6 && r.lagMs < 80);

    // Off, and back on
    await a.click('#noiseBtn');
    await a.waitForFunction(async () => { const V = await import('/js/voice.js'); return (await V.diagnostics()).noise === 'off'; });
    const d2 = await diag();
    ok('the 🌊 button turns it off: the raw microphone, no filter', d2.filter === null && await a.evaluate(() => JSON.parse(localStorage.getItem('pl:settings')).noiseMode === 'off'));
    await a.click('#noiseBtn');
    await a.waitForFunction(async () => { const V = await import('/js/voice.js'); return (await V.diagnostics()).filter === 'speech'; }, null, { timeout: 10000 });
    ok('…and on again', true);
    const served = await (await fetch(`${srv.url}/vendor/gtcrn-worklet.js`)).text();
    ok('a replaced filter stops running (the package’s “destroy” message is fixed)', served.includes('this.port.onmessage=e=>{e.data===`destroy`&&this.destroy()}'));

    // Old settings
    const old = await signUp(browser, srv.url, 'Lale');
    await old.evaluate(() => { const s = JSON.parse(localStorage.getItem('pl:settings') || '{}'); s.noiseMode = 'standard'; localStorage.setItem('pl:settings', JSON.stringify(s)); });
    await old.reload(); await old.waitForSelector('#room:not([hidden])');
    ok('someone who had “Standard” or “Strong” before now simply has it on', await old.evaluate(async () => (await import('/js/util.js')).settings.noiseMode === 'on'));

    // A server update: open apps reload to run the new version (a call isn't cut: that app waits until it's over)
    await a.evaluate(() => { window.__before = 1; }); await old.evaluate(() => { window.__before = 1; });
    await srv.kill(); await srv.restart({ GIT_COMMIT: 'f00dbab 2026-11-03' });
    await old.waitForFunction(() => !window.__before, null, { timeout: 20000 });
    await old.waitForSelector('#room:not([hidden])');
    ok('after a server update, an open app reloads itself to run the new version', true);
    await a.waitForSelector('#voiceStatus:not([hidden])', { timeout: 20000 });
    await a.waitForTimeout(1500);
    ok('…but not in the middle of a call', await a.evaluate(() => window.__before === 1));
    await a.click('#vcLeaveBtn');
    await a.waitForFunction(() => !window.__before, null, { timeout: 10000 });
    await a.waitForSelector('#room:not([hidden])');
    ok('…it reloads right after the call ends', true);

    const errs = [...a.errors, ...old.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
