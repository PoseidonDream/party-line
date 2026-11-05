/* Echo warning: when your speakers reach your microphone, friends hear themselves a moment later. The app notices
   your microphone following their voices 60–360 ms later and tells you privately (once per call) that headphones
   fix it. Here Bora talks (a recorded voice); on Deniz's side Bora's voice is fed back, 150 ms later, into what
   Deniz's echo check listens to: a real echo, made in the audio engine. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launchBrowser, signUp, joinVoice } from './lib.mjs';

const VOICE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'voice.wav');

export default async function (ok) {
  const srv = await startServer();
  const talker = await launchBrowser({ micFile: VOICE });
  const browser = await launchBrowser();
  try {
    const b = await signUp(talker, srv.url, 'Bora');
    const a = await signUp(browser, srv.url, 'Deniz');
    for (const p of [a, b]) await joinVoice(p);
    await a.waitForTimeout(12000);
    ok('in a normal call (no echo), nothing is said', await a.locator('.toast:has-text("hearing themselves")').count() === 0);

    await a.evaluate(async () => {
      const V = await import('/js/voice.js'), { audioCtx } = await import('/js/util.js');
      const p = [...V.V.peers.values()][0], c = audioCtx();
      const src = c.createMediaStreamSource(p.stream || p.audioEl.srcObject), delay = c.createDelay(1), an = c.createAnalyser();
      delay.delayTime.value = 0.15; an.fftSize = 512; src.connect(delay); delay.connect(an);
      V.localMeter.analyser = an;   // what the echo check hears from "Deniz's microphone": Bora, 150 ms late
    });
    await a.waitForSelector('.toast:has-text("hearing themselves")', { timeout: 25000 });
    ok('with an echo, Deniz is told privately that headphones fix it', (await a.textContent('.toast')).includes('Headphones'));
    ok('…and nobody else is told', await b.locator('.toast:has-text("hearing themselves")').count() === 0);
    const scores = await a.evaluate(async () => {
      const { echoScore } = await import('/js/voice.js');
      const remote = Array.from({ length: 160 }, (_, i) => (Math.sin(i / 3) > 0 ? 0.1 + 0.05 * Math.sin(i) : 0));
      const echo = remote.map((_, i) => 0.4 * (remote[i - 3] || 0) + 0.003);
      const own = remote.map((_, i) => (i % 17 < 5 ? 0.08 : 0.01));
      return [echoScore(echo, remote), echoScore(own, remote)];
    });
    ok(`…the check tells an echo (${scores[0].toFixed(2)}) from someone simply talking (${scores[1].toFixed(2)})`, scores[0] > 0.9 && scores[1] < 0.5);
    const errs = [...a.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await talker.close(); await browser.close(); await srv.stop(); }
}
