/* Sharing any file (download cards, served safely) and voice messages recorded with the mic. */
import { startServer, launchBrowser, signUp, RESULTS } from './lib.mjs';

/* A short silent WAV file. */
function wav(seconds = 1) {
  const rate = 8000, n = rate * seconds, b = Buffer.alloc(44 + n);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34);
  b.write('data', 36); b.writeUInt32LE(n, 40); b.fill(128, 44);
  return b;
}

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Poseidon');
    const b = await signUp(browser, srv.url, 'Bora');
    const send = async (files) => {
      await a.setInputFiles('#fileInput', files);
      await a.waitForSelector('#tray:not([hidden])');
      await a.click('#chatForm button[type=submit]');
      await a.waitForSelector('#tray', { state: 'hidden' });
    };

    await send([{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('game night notes') }, { name: 'evil.html', mimeType: 'text/html', buffer: Buffer.from('<script>alert(1)</script>') }]);
    await b.waitForSelector('.file-card:has-text("notes.txt")');
    await b.waitForSelector('.file-card:has-text("evil.html")');
    ok('any file shows as a download card with its name and size', await b.isVisible('.file-card:has-text("notes.txt") small:has-text("Download")'));
    const href = await b.getAttribute('.file-card:has-text("evil.html") a', 'href');
    const r = await fetch(new URL(href, srv.url));
    ok('files that aren’t photos, videos or audio always download, never open in the page',
      /^attachment/.test(r.headers.get('content-disposition')) && r.headers.get('content-type') === 'application/octet-stream' && /sandbox/.test(r.headers.get('content-security-policy')));
    const txt = await (await fetch(new URL(await b.getAttribute('.file-card:has-text("notes.txt") a', 'href'), srv.url))).text();
    ok('the downloaded file is the same', txt === 'game night notes');

    await send([{ name: 'clip.wav', mimeType: 'audio/wav', buffer: wav(1) }]);
    await b.waitForSelector('.msg-media audio.media-audio');
    ok('audio files get a player in the chat', true);

    // A big photo gets a small preview in the chat; clicking opens the full one.
    const png = await a.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 1600; c.height = 1200; const g = c.getContext('2d');
      const d = g.createImageData(1600, 1200); for (let i = 0; i < d.data.length; i++) d.data[i] = (i % 4 === 3) ? 255 : Math.random() * 255;
      g.putImageData(d, 0, 0); return c.toDataURL('image/png').split(',')[1];
    });
    await send([{ name: 'holiday.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') }]);
    await b.waitForSelector('.msg-media img.media-img[alt="holiday.png"]');
    await b.waitForFunction(() => { const i = document.querySelector('img.media-img[alt="holiday.png"]'); return i.complete && i.naturalWidth > 0; });
    const dims = await b.evaluate(() => { const i = document.querySelector('img.media-img[alt="holiday.png"]'); return [i.naturalWidth, i.src]; });
    ok(`big photos show a small preview in the chat (${dims[0]} px wide)`, dims[0] <= 640);
    await b.click('.msg-media img.media-img[alt="holiday.png"]');
    await b.waitForSelector('#lightbox:not([hidden]) img');
    await b.waitForFunction(() => { const i = document.querySelector('#lightbox img'); return i && i.complete && i.naturalWidth > 0; });
    ok('clicking opens the full photo', await b.evaluate(() => document.querySelector('#lightbox img').naturalWidth) === 1600);
    await b.keyboard.press('Escape');

    const big = Buffer.alloc(26 * 1048576);
    await a.setInputFiles('#fileInput', [{ name: 'huge.zip', mimeType: 'application/zip', buffer: big }]);
    await a.waitForSelector('.toast:has-text("too big")');
    ok('files over 25 MB are refused with a clear message', await a.isHidden('#tray'));

    await a.click('#recBtn');
    await a.waitForSelector('#recBar:not([hidden])');
    await a.waitForTimeout(1600);
    ok('recording shows a timer', /^0:0[1-9]$/.test((await a.textContent('#recTime')).trim()));
    await a.click('#recSend');
    await b.waitForSelector('.voice-msg:has-text("Voice message (0:0")', { timeout: 10000 });
    const dur = await b.evaluate(() => new Promise((res) => {
      const au = document.querySelector('.voice-msg audio');
      const t0 = Date.now();
      const check = () => { if (au.duration > 0 && au.duration !== Infinity) res(au.duration); else if (Date.now() - t0 > 6000) res(au.duration || -1); else setTimeout(check, 100); };
      check();
    }));
    ok(`a voice message arrives and plays (${dur.toFixed ? dur.toFixed(1) : dur} s)`, dur > 0 && dur !== Infinity);
    await a.click('#recBtn'); await a.waitForTimeout(500); await a.click('#recCancel');
    await a.waitForSelector('#recBar', { state: 'hidden' });
    await a.waitForTimeout(800);
    ok('cancel throws the recording away', (await b.locator('.voice-msg').count()) === 1);
    await b.screenshot({ path: `${RESULTS}/files.png` });

    const errs = [...a.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
