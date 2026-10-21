/* Camera video in voice channels. */
import { startServer, launchBrowser, signUp, joinVoice, RESULTS } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Poseidon', { permissions: ['microphone', 'camera'] });
    const b = await signUp(browser, srv.url, 'Bora', { permissions: ['microphone', 'camera'] });
    await joinVoice(a); await joinVoice(b);
    await b.waitForSelector('#tiles .tile:has-text("Poseidon") .tile-sub:has-text("Connected")', { timeout: 15000 });
    await a.click('#camBtn');
    await a.waitForSelector('#camBtn.on');
    await a.waitForFunction(() => { const v = document.querySelector('.tile.has-cam video'); return v && v.videoWidth > 0; }, null, { timeout: 8000 });
    ok('you see your own camera', true);
    await b.waitForFunction(() => { const t = [...document.querySelectorAll('#tiles .tile')].find((x) => x.textContent.includes('Poseidon')); const v = t && t.querySelector('video'); return v && v.videoWidth > 0; }, null, { timeout: 15000 });
    ok('friends see your camera', true);
    await b.screenshot({ path: `${RESULTS}/camera.png` });
    await b.click('#camBtn');
    await a.waitForFunction(() => { const t = [...document.querySelectorAll('#tiles .tile')].find((x) => x.textContent.includes('Bora')); const v = t && t.querySelector('video'); return v && v.videoWidth > 0; }, null, { timeout: 15000 });
    ok('both cameras at once', true);
    await a.click('#camBtn');
    await b.waitForFunction(() => { const t = [...document.querySelectorAll('#tiles .tile')].find((x) => x.textContent.includes('Poseidon')); return t && !t.querySelector('video') && t.querySelector('.avatar'); }, null, { timeout: 8000 });
    ok('turning it off shows the picture again', true);
    const errs = [...a.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
