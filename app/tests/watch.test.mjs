/* Watch together: a video shared in the chat plays for everyone in the voice channel, at the same moment,
   in the Listen together player (pause, skip and stop work for everyone). */
import { startServer, launchBrowser, signUp, joinVoice, RESULTS } from './lib.mjs';

/* A real 8-second WebM, recorded from a canvas in the browser. */
async function makeVideo(page) {
  const b64 = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 320; c.height = 180;
    const g = c.getContext('2d'); let f = 0;
    const draw = setInterval(() => { g.fillStyle = `hsl(${(f++ * 7) % 360} 70% 50%)`; g.fillRect(0, 0, 320, 180); g.fillStyle = '#fff'; g.font = '40px sans-serif'; g.fillText(String(f), 120, 100); }, 40);
    const rec = new MediaRecorder(c.captureStream(25), { mimeType: 'video/webm' });
    const parts = []; rec.ondataavailable = (e) => parts.push(e.data);
    const done = new Promise((r) => { rec.onstop = r; });
    rec.start(); await new Promise((r) => setTimeout(r, 8000)); rec.stop(); await done; clearInterval(draw);
    const buf = new Uint8Array(await new Blob(parts).arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  });
  return Buffer.from(b64, 'base64');
}

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Poseidon');
    const b = await signUp(browser, srv.url, 'Bora');
    const c = await signUp(browser, srv.url, 'Cem');
    const video = await makeVideo(a);

    await a.click('#railList .rail-btn'); await a.click('#textList .chan:has-text("general")');
    await a.setInputFiles('#fileInput', { name: 'clip.webm', mimeType: 'video/webm', buffer: video });
    await a.click('#chatForm button[type=submit]');
    await a.waitForSelector('#tray', { state: 'hidden' });
    const clip = '#messages .msg:has(video)';
    await c.waitForSelector(clip);
    ok('“Watch together” only shows while you’re in voice', !(await c.isVisible(`${clip} .watch-btn`)));

    await joinVoice(a); await joinVoice(b);
    await a.click('#textList .chan:has-text("general")'); await b.click('#textList .chan:has-text("general")');
    await a.click(`${clip} .watch-btn`);
    await b.waitForSelector('#musicCard.is-file:not([hidden]) video');
    await a.waitForSelector('#musicCard.is-file:not([hidden]) video');
    ok('it opens the player for everyone in the voice channel', (await b.textContent('#musicTitle')).includes('clip.webm'));
    await b.waitForSelector('#messages .msg:has-text("Now showing")');
    ok('Party Bot says what’s playing', await b.isVisible('#messages .msg:has-text("Now showing"):has-text("clip.webm")'));
    ok('people not in the voice channel don’t get it', await c.isHidden('#musicCard'));

    const time = (p) => p.evaluate(() => { const v = document.querySelector('#musicFrame video'); return v ? { t: v.currentTime, paused: v.paused } : null; });
    await a.waitForFunction(() => { const v = document.querySelector('#musicFrame video'); return v && v.currentTime > 1.5; }, null, { timeout: 10000 });
    const [ta, tb] = [await time(a), await time(b)];
    ok(`it plays at the same moment for both (${ta.t.toFixed(1)} s vs ${tb.t.toFixed(1)} s)`, !ta.paused && !tb.paused && Math.abs(ta.t - tb.t) < 1.5);
    await b.screenshot({ path: `${RESULTS}/watch-together.png` });

    await b.click('#musicPause');
    await a.waitForFunction(() => { const v = document.querySelector('#musicFrame video'); return v && v.paused; }, null, { timeout: 6000 });
    ok('pausing pauses it for everyone', true);
    await a.click('#musicStop');
    await b.waitForSelector('#musicCard', { state: 'hidden' });
    ok('stop closes it for everyone', true);

    const errs = [...a.errors, ...b.errors, ...c.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
