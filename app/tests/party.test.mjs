/* Vote tonight's game, accent colors, GIF search (a local stand-in for Giphy) and voice channel status. */
import http from 'node:http';
import { startServer, launchBrowser, signUp, joinVoice, RESULTS } from './lib.mjs';

const GIF = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');

export default async function (ok) {
  let base = '';
  const searches = [];
  const giphy = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/media/')) { res.writeHead(200, { 'content-type': 'image/gif' }); return res.end(GIF); }
    const item = (id, title) => ({ id, title: `${title} GIF`, images: {
      fixed_width_small: { url: `${base}/media/${id}-small.gif`, width: '100', height: '80' },
      downsized: { url: `${base}/media/${id}.gif`, width: '300', height: '240' } } });
    if (u.searchParams.get('api_key') !== 'test-key') { res.writeHead(403); return res.end('{}'); }
    searches.push(u.pathname + (u.searchParams.get('q') ? `?q=${u.searchParams.get('q')}` : ''));
    const data = u.pathname === '/v1/gifs/search' ? [item('cat1', 'Cat Dance'), item('cat2', 'Cat Jump')] : [item('hello', 'Hello'), item('wow', 'Wow')];
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data }));
  });
  await new Promise((r) => giphy.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${giphy.address().port}`;

  const srv = await startServer({ GIPHY_KEY: 'test-key', GIPHY_BASE: base, LINK_PREVIEW_PRIVATE: '1', POLL_MINUTE_MS: '200' });
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Poseidon');
    const b = await signUp(browser, srv.url, 'Bora');
    const say = async (p, text) => { await p.fill('#chatInput', text); await p.keyboard.press('Enter'); };

    // Vote tonight's game
    for (const p of [a, b]) await p.click('#textList .chan:has-text("game-night")');
    await say(a, '/game Lethal Company'); await say(a, '/game Peak'); await say(b, '/game Among Us');
    await a.click('#gamesBtn');
    await a.waitForSelector('#gamesList .game:has-text("Among Us")');
    await a.selectOption('#gamesPollMins', '15');   // 15 "minutes" of 200 ms each in this test
    await a.click('#gamesPoll');
    const poll = '#messages .msg:has-text("What do we play tonight?")';
    await b.waitForSelector(`${poll} .reaction:has-text("3️⃣")`);
    ok('“Vote tonight’s game” posts a poll of the list for everyone', (await b.textContent(poll)).includes('Among Us'));
    const peak = await b.locator(`${poll} .msg-body`).textContent();
    const n = ['1️⃣', '2️⃣', '3️⃣'][peak.split('\n').findIndex((l) => l.includes('Peak')) - 1] || '2️⃣';
    await b.click(`${poll} .reaction:has-text("${n}")`);
    await a.click(`${poll} .reaction:has-text("${n}")`);
    await say(b, '/vote');
    await b.waitForSelector('#botNote:not([hidden]):has-text("already a vote running")');
    ok('only one vote at a time per chat', true);
    await a.waitForSelector('#messages .msg:has-text("Tonight’s game")', { timeout: 12000 });
    ok('when time’s up, Party Bot announces the winner', (await a.textContent('#messages .msg:has-text("Tonight’s game")')).includes('Peak') && (await a.textContent('#messages .msg:has-text("Tonight’s game")')).includes('2 votes'));

    // Accent color
    await a.click('#setBtn'); await a.click('#settings [role="tab"][data-settab="look"]');
    const lamp = () => a.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--lamp').trim());
    const before = await lamp();
    await a.click('.accent-opt[title="Cyan"]');
    ok('Settings → accent color changes the glow color', before === '#ffad1f' && (await lamp()) === '#22d3ee');
    await a.keyboard.press('Escape');
    await a.reload(); await a.waitForSelector('#room:not([hidden])');
    ok('and it’s remembered on this device', (await lamp()) === '#22d3ee');

    // GIF search
    await a.click('#textList .chan:has-text("general")'); await b.click('#textList .chan:has-text("general")');
    await a.click('#pickBtn'); await a.click('[data-pick="gif"]');
    await a.waitForSelector('#pickBody .pick-h:text-is("Trending")');
    await a.waitForSelector('#pickBody .gifs button[title*="Hello"] img');
    ok('the GIF tab shows trending GIFs', (await a.getAttribute('#pickBody .gifs button[title*="Hello"] img', 'src')).includes('/api/link-image'));
    ok('“Powered by GIPHY” is shown', await a.isVisible('#pickBody .giphy-credit'));
    await a.fill('#gifQuery', 'cat');
    await a.waitForSelector('#pickBody .pick-h:has-text("Results for “cat”")');
    await a.screenshot({ path: `${RESULTS}/gif-picker.png` });
    await a.click('#pickBody .gifs button[title*="Cat Dance"]');
    await b.waitForSelector('#messages .msg-gif img');
    const src = await b.getAttribute('#messages .msg-gif img', 'src');
    ok('picking one sends it, saved on our own server', /\/uploads\/[\w-]+$/.test(src));
    ok('the key stays on the server: browsers never call Giphy', searches.includes('/v1/gifs/search?q=cat'));
    await a.screenshot({ path: `${RESULTS}/gif-search.png` });

    // Voice channel status
    await joinVoice(b);
    await b.waitForSelector('#vcStatus:not([hidden]) #vcStatusEdit');
    await b.click('#vcStatusEdit');
    await b.fill('#cfInput', 'ranked Valorant 🔥'); await b.click('#cfOk');
    await a.waitForSelector('#voiceList .chan-status:text-is("ranked Valorant 🔥")');
    ok('a voice channel status shows under the channel for everyone', true);
    await b.screenshot({ path: `${RESULTS}/voice-status.png` });
    await b.click('#vcLeaveBtn');
    await a.waitForSelector('#voiceList .chan-status', { state: 'detached' });
    ok('it clears when everyone leaves', true);

    const errs = [...a.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); giphy.close(); }
}
