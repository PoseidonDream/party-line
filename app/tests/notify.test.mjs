/* Notification settings (mute a channel, server setting, saved on the server) and the "New messages" line. */
import { startServer, launchBrowser, signUp, RESULTS } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Poseidon');
    const b = await signUp(browser, srv.url, 'Bora');

    await a.click('#textList .chan:has-text("general")');
    await a.click('#notifBtn');
    await a.waitForSelector('#notifPop:not([hidden]) [data-level="default"][aria-checked="true"]');
    ok('a channel follows the server setting by default', true);
    await a.click('#notifPop [data-level="mute"]');
    await a.waitForSelector('#notifBtn.on');
    await a.click('#textList .chan:has-text("game-night")');
    await b.click('#textList .chan:has-text("general")');
    await b.fill('#chatInput', 'muted channel message'); await b.keyboard.press('Enter');
    await a.waitForTimeout(800);
    ok('a muted channel looks quiet: dimmed, no unread highlight', await a.isVisible('#textList .chan.muted:has-text("general")') && await a.locator('#textList .chan.unread:has-text("general")').count() === 0);
    await a.reload(); await a.waitForSelector('#room:not([hidden])');
    ok('settings are saved on the server (they follow you to other devices)', await a.isVisible('#textList .chan.muted:has-text("general")'));

    await a.click('#serverBtn'); await a.click('#mNotify');
    await a.waitForSelector('#notifPop:not([hidden]) [data-level="mentions"][aria-checked="true"]');
    await a.click('#notifPop [data-level="all"]');
    await a.click('#textList .chan:has-text("game-night")');
    await a.click('#notifBtn');
    await a.waitForSelector('#notifPop [data-level="default"]:has-text("All messages")');
    ok('the server setting can be changed, and channels following it show it', true);
    await a.keyboard.press('Escape'); await a.mouse.click(700, 400);

    for (let i = 1; i <= 8; i++) { await b.fill('#chatInput', `catch-up ${i}`); await b.keyboard.press('Enter'); }
    await a.waitForSelector('#textList .chan:has-text("general")');
    await a.waitForTimeout(500);
    await a.click('#textList .chan:has-text("general")');
    await a.waitForSelector('#messages .new-divider');
    const order = await a.evaluate(() => [...document.querySelectorAll('#messages > li')].map((x) => x.classList.contains('new-divider') ? 'DIVIDER' : (x.querySelector('.msg-body') || {}).textContent));
    const at = order.indexOf('DIVIDER');
    ok('opening a chat shows a “New messages” line right before what you missed', at >= 0 && ['muted channel message', 'catch-up 1'].includes(order[at + 1]));
    await a.screenshot({ path: `${RESULTS}/new-messages.png` });

    const errs = [...a.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
