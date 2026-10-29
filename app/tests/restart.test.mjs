/* Updating the server restarts it. People should reconnect, and voice should come back by itself. */
import { startServer, launchBrowser, signUp, joinVoice } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Ayla'), b = await signUp(browser, srv.url, 'Cem');
    await joinVoice(a); await joinVoice(b);
    await a.waitForSelector('#tiles .tile .tile-sub:has-text("Connected")', { timeout: 15000 });
    ok('in voice together', true);
    await srv.kill();
    await a.waitForSelector('#offlineBar:not([hidden])', { timeout: 8000 });
    ok('"Reconnecting" shows while the server is down', true);
    await srv.restart();
    await a.waitForSelector('#offlineBar[hidden]', { state: 'attached', timeout: 30000 });
    ok('reconnects after the restart', true);
    await a.waitForSelector('#tiles .tile .tile-sub:has-text("Connected")', { timeout: 20000 });
    await b.waitForSelector('#tiles .tile .tile-sub:has-text("Connected")', { timeout: 20000 });
    ok('voice comes back by itself for both', true);

    // A network that lets the website through but blocks the live connection: after 10 seconds of "Connecting…"
    // the app says so and offers a way out, instead of spinning forever.
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
      window.WebSocket = class { constructor() { setTimeout(() => this.onclose && this.onclose({ code: 1006 }), 50); } send() {} close() {} };
    });
    const c = await ctx.newPage();
    await c.goto(srv.url + '/');
    await c.click('#tabLogin'); await c.fill('#authName', 'Ayla'); await c.fill('#authPass', 'pass1234'); await c.click('#authBtn');
    await c.waitForSelector('#bootText:has-text("Connecting…")');
    await c.waitForSelector('#bootHelp:not([hidden])', { timeout: 15000 });
    ok('a blocked live connection is explained after 10 seconds', /can’t open its live connection/.test(await c.textContent('#bootWhy')) && (await c.textContent('#bootDetail')) === 'WebSocket 1006');
    await c.click('#bootSignOut');
    await c.waitForSelector('#join:not([hidden])');
    ok('…and you can sign out from there', await c.isHidden('#booting'));
  } finally { await browser.close(); await srv.stop(); }
}
