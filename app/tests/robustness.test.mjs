/* Things found by poking at the app: odd words that used to reach inside the server's lookup tables, and the phone
   layout of the message box and the header. */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { startServer, launchBrowser, signUp } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Poseidon', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const req = (t, d) => a.evaluate(async ([t, d]) => { const { live } = await import('/js/net.js'); return live.req(t, d).then((r) => r, (e) => ({ error: e.message })); }, [t, d]);
    const search = await a.evaluate(async (q) => { const { api } = await import('/js/net.js'); try { await api(`/api/search?q=${encodeURIComponent(q)}`); return 'ok'; } catch (e) { return e.message; } }, 'has:constructor');
    ok('searching for has:constructor is just a search', search === 'ok');
    const general = await a.evaluate(() => Number(document.querySelector('#textList .chan').closest('li').dataset.cid));
    const r = await req('msg.send', { channelId: general, body: '/remind 10 constructor stretch', attachments: [] });
    ok('/remind with a made-up unit explains how to use it', /Say when, then what/.test(r.ephemeral || ''));
    const m = await req('music.control', { action: '__proto__' });
    ok('an unknown player button is refused politely', m.error === 'Unknown action.');
    const post = async (p, body) => { const res = await fetch(srv.url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body }); return [res.status, res.headers.get('content-type') || '', await res.text()]; };
    const [s1, t1, b1] = await post('/api/register', '{"name":');
    const [s2, t2, b2] = await post('/api/login', JSON.stringify({ name: 'x'.repeat(2e6) }));
    ok('a broken or huge request gets a short answer, not a web page with the server’s insides',
      s1 === 400 && s2 === 413 && /json/.test(t1) && /json/.test(t2) && JSON.parse(b1).error && JSON.parse(b2).error && !/\sat \S+ \(|node_modules/.test(b1 + b2));
    ok('…and doesn’t fill the server log', !/SyntaxError|PayloadTooLarge/.test(srv.log()));

    const send = await a.locator('#chatForm button[type=submit]').boundingBox();
    ok('on a phone the Send button fits inside the screen', send && send.x + send.width <= 390);
    const cut = await a.evaluate(() => { const t = document.querySelector('#viewTitle'); return t.scrollWidth > t.clientWidth; });
    ok('…and the channel name isn’t cut off in the header (the rest is under ⋯)', !cut && await a.isVisible('#moreBtn'));
    await a.click('#moreBtn');
    await a.click('#moreMenu [data-proxy="galleryBtn"]');
    await a.waitForSelector('#galleryDlg[open]');
    ok('⋯ opens what moved into it', true);

    // A long chat: after scrolling back through 1,000 messages, a reaction or vote updates just that message
    const db = new DatabaseSync(path.join(srv.dataDir, 'party-line.db'));
    const ins = db.prepare('INSERT INTO messages (channel_id, user_id, body, created_at) VALUES (?, 1, ?, ?)');
    db.exec('BEGIN'); for (let i = 0; i < 1200; i++) ins.run(general, `old message ${i} with **bold** and https://example.com/${i}`, Date.now() - (1200 - i) * 60_000); db.exec('COMMIT'); db.close();
    const d = await signUp(browser, srv.url, 'Bora');
    await d.waitForSelector('#messages .msg');
    for (let i = 0; i < 40 && await d.evaluate(() => document.querySelectorAll('#messages .msg').length) < 1000; i++) {
      await d.evaluate(() => { const m = document.querySelector('#messages'); m.scrollTop = 0; m.dispatchEvent(new Event('scroll')); });
      await d.waitForTimeout(150);
    }
    const loaded = await d.evaluate(() => document.querySelectorAll('#messages .msg').length);
    const last = await d.evaluate(() => Number([...document.querySelectorAll('#messages .msg')].pop().dataset.id));
    await d.evaluate(() => { window.__lt = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(e.duration); }).observe({ type: 'longtask' }); });
    await req('react', { id: last, emoji: '🔥', on: true });
    await d.waitForSelector('#messages .msg:last-child .reaction');
    await d.waitForTimeout(300);
    const stall = Math.max(0, ...await d.evaluate(() => window.__lt));
    ok(`with ${loaded} messages loaded, a reaction shows without the app stalling (longest pause ${Math.round(stall)} ms)`, loaded >= 1000 && stall < 400);
    ok(`no JavaScript errors${[...a.errors, ...d.errors].length ? ': ' + [...a.errors, ...d.errors].join(' | ') : ''}`, ![...a.errors, ...d.errors].length);
  } finally { await browser.close(); await srv.stop(); }
}
