/* Voice effects, heard from the other side: the pitch a friend actually receives goes up with Chipmunk and down with
   Deep (the test microphone plays a steady tone). */
import { startServer, launchBrowser, signUp } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Poseidon');
    const b = await signUp(browser, srv.url, 'Bora');
    for (const p of [a, b]) { await p.click('#voiceList .chan:has-text("Lobby")'); await p.waitForSelector('#voiceStatus:not([hidden])', { timeout: 10000 }); }
    await a.waitForTimeout(2500);
    // The strongest frequency in Poseidon's voice as it arrives at Bora (the middle of a dozen looks).
    const heard = () => b.evaluate(async () => {
      const { V } = await import('/js/voice.js');
      const p = [...V.peers.values()][0], stream = p && (p.stream || (p.audioEl && p.audioEl.srcObject));
      if (!stream) return 0;
      const ctx = new AudioContext(), an = ctx.createAnalyser(); an.fftSize = 8192; ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Float32Array(an.frequencyBinCount), peaks = [];
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 150)); an.getFloatFrequencyData(buf);
        let best = -1e9, at = 0; for (let k = 5; k < buf.length; k++) if (buf[k] > best) { best = buf[k]; at = k; }
        if (best > -90) peaks.push(at * ctx.sampleRate / an.fftSize);
      }
      ctx.close();
      peaks.sort((x, y) => x - y);
      return peaks.length ? peaks[Math.floor(peaks.length / 2)] : 0;
    });
    const fx = async (name) => { await a.evaluate(async (n) => { const v = await import('/js/voice.js'); await v.setVoiceFx(n); }, name); await a.waitForTimeout(1500); return heard(); };
    const normal = await heard();
    ok(`a friend hears your voice (${Math.round(normal)} Hz)`, normal > 100);
    const chip = await fx('chipmunk');
    ok(`Chipmunk: they hear it higher (${Math.round(chip)} Hz, ×${(chip / normal).toFixed(2)})`, chip / normal > 1.45 && chip / normal < 1.75);
    const deep = await fx('deep');
    ok(`Deep: they hear it lower (${Math.round(deep)} Hz, ×${(deep / normal).toFixed(2)})`, deep / normal > 0.62 && deep / normal < 0.82);
    const robot = await fx('robot');   // the voice times a 50 Hz tone: it splits 50 Hz above and below
    ok(`Robot: they hear it changed (${Math.round(robot)} Hz)`, Math.abs(robot - normal) > 25);
    const demon = await fx('demon');
    ok(`Demon: they hear it much lower (${Math.round(demon)} Hz, ×${(demon / normal).toFixed(2)})`, demon / normal > 0.45 && demon / normal < 0.7);
    const slow = await fx('slowmo');
    ok(`Slow-mo: they hear it deep and drawn out (${Math.round(slow)} Hz, ×${(slow / normal).toFixed(2)})`, slow / normal > 0.64 && slow / normal < 0.8);
    const quiet = [];
    for (const name of ['alien', 'underwater', 'arcade', 'wobbly', 'ghost', 'harmony', 'stadium', 'glitch']) {
      const hz = await fx(name);
      const kept = await a.evaluate(async () => (await import('/js/util.js')).settings.voiceFx);
      if (!(hz > 50) || kept !== name) quiet.push(`${name} (${Math.round(hz)} Hz, setting ${kept})`);
    }
    ok(`every new effect runs and the friend still hears you${quiet.length ? ': ' + quiet.join(', ') : ''}`, !quiet.length);
    const back = await fx('none');
    ok('Normal: back to your own voice', Math.abs(back / normal - 1) < 0.08);
    await a.click('#meBtn');
    await a.waitForFunction(() => parseFloat(document.querySelector('#micPanel .meter i').style.width) > 0, null, { timeout: 5000 });
    ok('the mic check’s level bar moves while it’s open', true);
    await a.click('#meBtn');

    // Developer panel → Voice check: try effects without a call, then use one in calls.
    await a.keyboard.press('Control+Shift+D');
    await a.click('#devPanel [data-tab="lab"]');
    await a.evaluate(() => {   // keep hold of the microphone the panel opens, to check it's let go later
      const md = navigator.mediaDevices, orig = md.getUserMedia.bind(md);
      md.getUserMedia = async (c) => { const st = await orig(c); window.__labStream = st; return st; };
    });
    await a.click('#devPanel button:has-text("Start microphone")');
    await a.waitForFunction(() => { const i = document.querySelector('#labMicMeter i'); return i && parseFloat(i.style.width) > 0; }, null, { timeout: 8000 });
    ok('Voice check: your microphone’s level shows, without being in a call', true);
    await a.click('#devPanel [data-labfx="chipmunk"]');
    await a.click('#labLive');
    await a.waitForFunction(() => { const i = document.querySelector('#labOutMeter i'); return i && parseFloat(i.style.width) > 0; }, null, { timeout: 8000 });
    ok('…“Hear myself live” plays you back through the effect', await a.getAttribute('#labLive', 'aria-pressed') === 'true');
    await a.click('#labRec');
    await a.waitForSelector('#labRecLeft');
    await a.waitForSelector('#labPlay:has-text("Stop")', { timeout: 9000 });
    ok('…recording 5 seconds plays them straight back', true);
    await a.click('#devPanel [data-labfx="demon"]');
    await a.waitForSelector('#devPanel .hint:has-text("through 😈 Demon")');
    ok('…and picking another effect replays the same words through it', true);
    await a.click('#labUse');
    await a.waitForSelector('#labUse:has-text("Friends hear you as")');
    const inCall = await a.evaluate(async () => (await import('/js/util.js')).settings.voiceFx);
    await a.keyboard.press('Escape');
    await a.waitForTimeout(1500);
    const viaLab = await heard();
    ok(`…“Use in calls” switches your call voice to it (${Math.round(viaLab)} Hz, ×${(viaLab / normal).toFixed(2)})`, inCall === 'demon' && viaLab / normal > 0.45 && viaLab / normal < 0.7);
    ok('closing the panel lets go of its microphone', await a.evaluate(() => window.__labStream.getTracks().every((t) => t.readyState === 'ended')));
    const errs = [...a.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
