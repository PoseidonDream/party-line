/* Even volumes: a friend whose mic is quiet comes through a bit louder, a loud one a bit softer (at most 2× or ½),
   learned while they talk, on top of the volume you set. The test microphones play a recorded voice
   (fixtures/voice.wav). */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launchBrowser, signUp, joinVoice } from './lib.mjs';

const VOICE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'voice.wav');

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser({ micFile: VOICE });
  try {
    const a = await signUp(browser, srv.url, 'Deniz');
    const b = await signUp(browser, srv.url, 'Bora');
    for (const p of [a, b]) await joinVoice(p);
    const gainForBora = () => a.evaluate(async () => { const V = await import('/js/voice.js'); const d = await V.diagnostics(); return (d.peers[0] || {}).autoGain || 0; });
    const setBoraMic = (v) => b.evaluate(async (v) => { const V = await import('/js/voice.js'); V.setInputVol(v); }, v);

    await setBoraMic(0.15);
    for (let i = 0; i < 80 && (await gainForBora()) <= 1.3; i++) await a.waitForTimeout(500);
    const up = await gainForBora();
    ok(`a friend with a quiet mic is turned up for you (×${up})`, up > 1.3 && up <= 2);
    await setBoraMic(3);
    for (let i = 0; i < 100 && (await gainForBora()) >= 0.9; i++) await a.waitForTimeout(500);
    const down = await gainForBora();
    ok(`…and a loud one turned down (×${down}), never below half`, down < 0.9 && down >= 0.5);
    const vol = await a.evaluate(async () => { const V = await import('/js/voice.js'); return (await V.diagnostics()).peers[0].audioEl.volume; });
    ok(`…by changing how loud they play for you (volume ${vol})`, vol < 0.95);
    const errs = [...a.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
