/* The noise filter: one switch, on by default. On, the microphone goes through a steep low cut (100 Hz) and GTCRN, a
   small speech model that keeps voices and removes the rest, then the voice gate; the browser's own filter is off
   (in front of the model it gets in the way). Measured here with a spoken sentence (fixtures/voice.wav) over music
   made in the page (chords, bass, drums and a sung-style melody, the hardest part): the music has to drop a lot
   between sentences, clearly more than with the model alone, while the voice comes through. Off is the raw
   microphone. Older settings (Strong/Standard) count as On. */
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
    ok('the noise filter is on by default, using the speech model (GTCRN), with the voice gate after it', d1.noise === 'on' && d1.filter === 'speech' && d1.filterRunning && d1.gate === true);
    await a.click('#setBtn'); await a.click('#settings [data-settab="voice"]');
    ok('…with one switch in Settings and the 🌊 button showing it’s on', await a.evaluate(() => document.querySelector('#setNoise').checked && document.querySelectorAll('input[name="noise"]').length === 0 && document.querySelector('#noiseBtn').getAttribute('aria-pressed') === 'true'));
    await a.waitForSelector('#noiseState:not([hidden])');
    ok('…and Settings says it’s running (“only your voice gets through”)', (await a.textContent('#noiseState')).includes('only your voice'));
    await a.keyboard.press('Escape');

    ok('…with the low cut in front, and the browser’s own filter off (it would get in the model’s way)', d1.lowCut === true && d1.browserNs === false);

    // The measurement: voice over music, through the same filters the app uses. Rendered offline (the same result
    // every time, however busy the machine), with a pause at the start while the model loads.
    const measure = (chain) => a.evaluate(async ([b64, chain]) => {
      const sr = 48000, probe = new AudioContext({ sampleRate: sr });
      const voice = await probe.decodeAudioData(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer); await probe.close();
      const v = voice.getChannelData(0), n = v.length, t = (i) => i / sr, music = new Float32Array(n);
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
      const vr = rms(v, (i) => talk[i]), g = vr / rms(music, () => true) / 2;   // music about 6 dB under the voice
      const PAD = sr, ctx = new OfflineAudioContext(1, PAD + n + sr / 2, sr);
      const mix = ctx.createBuffer(1, n, sr), m = mix.getChannelData(0); for (let i = 0; i < n; i++) m[i] = v[i] + music[i] * g;
      const V = await import('/js/voice.js'), nodes = [];
      if (chain.includes('lowcut')) nodes.push(...V.lowCut(ctx));
      await ctx.audioWorklet.addModule('/vendor/gtcrn-worklet.js');
      const wasmBinary = await (await fetch('/vendor/gtcrn.wasm')).arrayBuffer();
      nodes.push(new AudioWorkletNode(ctx, '@sapphi-red/web-noise-suppressor/gtcrn', { outputChannelCount: [1], processorOptions: { maxChannels: 1, wasmBinary } }));
      if (chain.includes('gate')) { await ctx.audioWorklet.addModule('/gate-worklet.js'); nodes.push(new AudioWorkletNode(ctx, 'pl-voice-gate', { outputChannelCount: [1] })); }
      for (let i = 1; i < nodes.length; i++) nodes[i - 1].connect(nodes[i]);
      const src = ctx.createBufferSource(); src.buffer = mix; src.connect(nodes[0]); nodes[nodes.length - 1].connect(ctx.destination); src.start(PAD / sr);
      ctx.suspend(256 / sr).then(() => setTimeout(() => ctx.resume(), 3000));   // the model loads
      const out = (await ctx.startRendering()).getChannelData(0).subarray(PAD);
      // the reference: the clean voice, through the same low cut (what it takes from a voice is inaudible, and its
      // tiny phase shift isn't noise)
      let ref = v;
      if (chain.includes('lowcut')) {
        const off = new OfflineAudioContext(1, n, sr), b = off.createBuffer(1, n, sr); b.copyToChannel(v, 0);
        const s2 = off.createBufferSource(); s2.buffer = b; let last = s2; for (const f of V.lowCut(off)) { last.connect(f); last = f; }
        last.connect(off.destination); s2.start(); ref = (await off.startRendering()).getChannelData(0);
      }
      // line the output up with the input (the filter adds a few tens of ms)
      let best = -Infinity, lag = 0;
      for (let L = 0; L < 4800; L += 16) { let c = 0; for (let i = 0; i < n - 4800; i += 4) c += ref[i] * out[i + L]; if (c > best) { best = c; lag = L; } }
      for (let L = Math.max(0, lag - 24), c0 = lag, top = -Infinity; L <= c0 + 24; L++) { let c = 0; for (let i = 0; i < n - 4800; i++) c += ref[i] * out[i + L]; if (c > top) { top = c; lag = L; } }
      const y = out.subarray(lag, lag + n), db = (x) => 20 * Math.log10(x + 1e-9);
      // while talking: how much of what comes out is the voice (SI-SDR, higher is cleaner)
      let dot = 0, rr = 0; for (let i = 0; i < n; i++) if (talk[i]) { dot += y[i] * ref[i]; rr += ref[i] * ref[i]; }
      let se = 0, ee = 0; for (let i = 0; i < n; i++) if (talk[i]) { const tv = (dot / rr) * ref[i]; se += tv * tv; ee += (y[i] - tv) ** 2; }
      return { musicDrop: db(rms(y, (i) => !talk[i])) - db(rms(m, (i) => !talk[i])), voiceKept: db(rms(y, (i) => talk[i])) - db(vr), clean: 10 * Math.log10(se / ee), lagMs: lag / 48 };
    }, [VOICE, chain]);
    const before = await measure([]), r = await measure(['lowcut', 'gate']);
    ok(`music between sentences drops by more than 30 dB (${r.musicDrop.toFixed(1)} dB; the model alone: ${before.musicDrop.toFixed(1)} dB)`, r.musicDrop < -30 && r.musicDrop < before.musicDrop - 8);
    ok(`…while talking, the voice comes out at least as clean as with the model alone (${r.clean.toFixed(1)} vs ${before.clean.toFixed(1)} dB)`, r.clean >= before.clean - 0.2);
    ok(`…and the voice comes through (${r.voiceKept.toFixed(1)} dB, delay ${r.lagMs.toFixed(0)} ms)`, r.voiceKept > -6 && r.lagMs < 80);
    // The voice gate on its own (it's what still helps where the speech model can't run): a steady background noise,
    // like a fan, under the voice. Between sentences it's cut to silence; the voice comes through.
    const gated = await a.evaluate(async (b64) => {
      const sr = 48000, probe = new AudioContext({ sampleRate: sr });
      const voice = await probe.decodeAudioData(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer); await probe.close();
      const v = voice.getChannelData(0), n = v.length + sr;   // a second of fan before the voice starts
      const ctx = new OfflineAudioContext(1, n, sr);
      await ctx.audioWorklet.addModule('/gate-worklet.js');
      const mix = ctx.createBuffer(1, n, sr), m = mix.getChannelData(0), fan = new Float32Array(n);
      let lp = 0; for (let i = 0; i < n; i++) { lp += (Math.random() * 2 - 1 - lp) * 0.05; fan[i] = lp * 0.12; }   // low rumble, about -40 dB
      for (let i = 0; i < n; i++) m[i] = (i >= sr ? v[i - sr] : 0) + fan[i];
      const src = ctx.createBufferSource(); src.buffer = mix;
      const gate = new AudioWorkletNode(ctx, 'pl-voice-gate', { outputChannelCount: [1] });
      src.connect(gate); gate.connect(ctx.destination); src.start();
      const y = (await ctx.startRendering()).getChannelData(0);
      const talk = new Uint8Array(n); for (let i = sr; i < n; i++) if (Math.abs(v[i - sr]) > 0.01) for (let j = Math.max(0, i - 4800); j < Math.min(n, i + 19200); j++) talk[j] = 1;
      const rms = (x, ok) => { let e = 0, c = 0; for (let i = 0; i < n; i++) if (ok(i)) { e += x[i] * x[i]; c++; } return Math.sqrt(e / Math.max(1, c)); };
      const db = (x) => 20 * Math.log10(x + 1e-9), gap = (i) => i > sr / 2 && !talk[i];   // after half a second to learn the room
      return { noiseDrop: db(rms(y, gap)) - db(rms(m, gap)), voiceKept: db(rms(y, (i) => talk[i] && i >= sr)) - db(rms(m, (i) => talk[i] && i >= sr)) };
    }, VOICE);
    ok(`the voice gate cuts a steady background noise between sentences (${gated.noiseDrop.toFixed(1)} dB)`, gated.noiseDrop < -30);
    ok(`…while the voice comes through (${gated.voiceKept.toFixed(1)} dB)`, gated.voiceKept > -3);

    // Muted: the filter rests (nothing of it is sent); unmuted: it works again
    await a.click('#micBtn');
    await a.waitForFunction(async () => { const V = await import('/js/voice.js'); return (await V.diagnostics()).filterResting; });
    ok('while you’re muted, the noise filter rests (saving battery)', true);
    await a.click('#micBtn');
    await a.waitForFunction(async () => { const V = await import('/js/voice.js'); const d = await V.diagnostics(); return !d.filterResting && d.filter === 'speech'; });
    ok('…and works again when you unmute', true);

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
    await old.fill('#chatInput', 'my own line'); await old.keyboard.press('Enter');
    await old.waitForSelector('#messages .msg:has-text("my own line")');
    await a.evaluate(() => { window.__before = 1; }); await old.evaluate(() => { window.__before = 1; });
    await old.fill('#chatInput', 'half a messa');
    await srv.kill(); await srv.restart({ GIT_COMMIT: 'f00dbab 2026-11-03' });
    await old.waitForSelector('#offlineBar', { state: 'hidden', timeout: 20000 });
    await old.waitForTimeout(4000);
    ok('a half-typed message holds the reload (nothing you were writing is lost)', await old.evaluate(() => window.__before === 1) && (await old.inputValue('#chatInput')) === 'half a messa');
    // …and so does a message being edited
    await old.evaluate(() => { const b = [...document.querySelectorAll('#messages .msg')].find((m) => m.textContent.includes('my own line')).querySelector('.msg-tool[aria-label="Edit"]'); b.click(); });
    await old.waitForSelector('.msg-editbox textarea');
    await old.fill('#chatInput', '');
    await old.waitForTimeout(4000);
    ok('…and so does a message being edited', await old.evaluate(() => window.__before === 1));
    await old.press('.msg-editbox textarea', 'Escape');
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

    // Where the speech model can't run, the older filter steps in, and the browser's own filter is back on
    const c = await signUp(browser, srv.url, 'Mert');
    await c.route('**/vendor/gtcrn.wasm', (route) => route.abort());
    await joinVoice(c);
    await c.waitForFunction(async () => { const V = await import('/js/voice.js'); return !!(await V.diagnostics()).filter; }, null, { timeout: 10000 });
    const d3 = await c.evaluate(async () => (await import('/js/voice.js')).diagnostics());
    ok(`where the speech model can’t run: the steady-noise filter, the low cut and the browser’s own filter (${d3.filter}, browser filter ${d3.browserNs})`, d3.filter === 'steady' && d3.lowCut && d3.browserNs === true);

    const errs = [...a.errors, ...old.errors, ...c.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
