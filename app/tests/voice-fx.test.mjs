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
    const back = await fx('none');
    ok('Normal: back to your own voice', Math.abs(back / normal - 1) < 0.08);
    await a.click('#meBtn');
    await a.waitForFunction(() => parseFloat(document.querySelector('#micPanel .meter i').style.width) > 0, null, { timeout: 5000 });
    ok('the mic check’s level bar moves while it’s open', true);
    await a.click('#meBtn');
    const errs = [...a.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
