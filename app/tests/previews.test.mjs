/* Link previews: a card with title, description, site and picture (passed through our server), no preview for
   <links in angle brackets>, and private network addresses are never fetched. */
import http from 'node:http';
import { startServer, launchBrowser, signUp, RESULTS } from './lib.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

export default async function (ok) {
  let hits = 0;
  const site = http.createServer((req, res) => {
    hits++;
    if (req.url === '/pic.png') { res.setHeader('content-type', 'image/png'); return res.end(PNG); }
    if (req.url === '/old') { res.writeHead(302, { location: '/page' }); return res.end(); }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><head><title>Fallback</title>
      <meta property="og:title" content="Friday Game Night &amp; Pizza">
      <meta property="og:description" content="Bring snacks. We start at 21:00.">
      <meta property="og:site_name" content="Game Club">
      <meta property="og:image" content="/pic.png"></head><body>hi</body></html>`);
  }).listen(0, '127.0.0.1');
  await new Promise((r) => site.once('listening', r));
  const base = `http://127.0.0.1:${site.address().port}`;

  const srv = await startServer({ LINK_PREVIEW_PRIVATE: '1' });
  const strict = await startServer();   // normal settings: private addresses refused
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Poseidon');
    const b = await signUp(browser, srv.url, 'Bora');
    await a.fill('#chatInput', `look at this ${base}/old`); await a.keyboard.press('Enter');
    const card = '#messages .msg:has-text("look at this") .embed';
    await b.waitForSelector(`${card}:has-text("Friday Game Night & Pizza")`, { timeout: 10000 });
    ok('a link gets a preview card with title, description and site, also after a redirect',
      await b.isVisible(`${card} .embed-desc:has-text("Bring snacks")`) && await b.isVisible(`${card} .embed-site:has-text("Game Club")`));
    await b.waitForFunction(() => { const i = document.querySelector('#messages .embed img'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 8000 });
    const src = await b.getAttribute(`${card} img`, 'src');
    ok('the picture comes through our own server', src.startsWith('/api/link-image?') || src.startsWith(srv.url + '/api/link-image?'));
    const forged = await fetch(`${srv.url}/api/link-image?u=${encodeURIComponent(base + '/pic.png')}&s=${'x'.repeat(32)}`);
    ok('the picture pass-through refuses addresses it didn’t sign (not an open proxy)', forged.status === 403);
    await b.screenshot({ path: `${RESULTS}/previews.png` });

    await a.fill('#chatInput', `no card please <${base}/page>`); await a.keyboard.press('Enter');
    await b.waitForSelector('#messages .msg:has-text("no card please")');
    await b.waitForTimeout(1500);
    ok('a <link in angle brackets> gets no preview', (await b.locator('#messages .msg:has-text("no card please") .embed').count()) === 0);

    const c = await signUp(browser, strict.url, 'Cem');
    const before = hits;
    await c.fill('#chatInput', `sneaky ${base}/page and http://169.254.169.254/latest/meta-data`); await c.keyboard.press('Enter');
    await c.waitForSelector('#messages .msg:has-text("sneaky")');
    await c.waitForTimeout(2500);
    ok('addresses inside the server’s own network are never fetched', hits === before && (await c.locator('#messages .embed').count()) === 0);

    const errs = [...a.errors, ...b.errors, ...c.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); await strict.stop(); site.close(); }
}
