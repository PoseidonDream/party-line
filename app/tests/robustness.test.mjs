/* Things found by poking at the app: odd words that used to reach inside the server's lookup tables, and the phone
   layout of the message box and the header. */
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

    const send = await a.locator('#chatForm button[type=submit]').boundingBox();
    ok('on a phone the Send button fits inside the screen', send && send.x + send.width <= 390);
    const cut = await a.evaluate(() => { const t = document.querySelector('#viewTitle'); return t.scrollWidth > t.clientWidth; });
    ok('…and the channel name isn’t cut off in the header (the rest is under ⋯)', !cut && await a.isVisible('#moreBtn'));
    await a.click('#moreBtn');
    await a.click('#moreMenu [data-proxy="galleryBtn"]');
    await a.waitForSelector('#galleryDlg[open]');
    ok('⋯ opens what moved into it', true);
    ok(`no JavaScript errors${a.errors.length ? ': ' + a.errors.join(' | ') : ''}`, !a.errors.length);
  } finally { await browser.close(); await srv.stop(); }
}
