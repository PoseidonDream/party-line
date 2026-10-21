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
  } finally { await browser.close(); await srv.stop(); }
}
