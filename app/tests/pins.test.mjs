/* Pinned messages: pin from the message menu, the bot's note, the 📌 list, unpin. */
import { startServer, launchBrowser, signUp, RESULTS } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Poseidon');
    const b = await signUp(browser, srv.url, 'Bora');
    await a.fill('#chatInput', 'Game night is Friday at 21:00'); await a.keyboard.press('Enter');
    await a.fill('#chatInput', 'just chatting'); await a.keyboard.press('Enter');
    await b.waitForSelector('#messages .msg:has-text("just chatting")');
    ok('two messages sent quickly both arrive, in order', await b.evaluate(() => { const t = [...document.querySelectorAll('#messages .msg-body')].map((x) => x.textContent); return t.indexOf('Game night is Friday at 21:00') < t.indexOf('just chatting'); }));
    const msg = (p) => p.locator('#messages .msg:has-text("Game night is Friday")').first();   // the bot's note quotes it too
    await msg(b).waitFor();
    await msg(b).hover();
    await msg(b).locator('.msg-tool[aria-label="Pin"]').click();
    await a.waitForSelector('#messages .msg:has-text("Game night is Friday") .msg-pinned');
    ok('pinning marks the message for everyone', true);
    await a.waitForSelector('#messages .msg:has(.bot-tag):has-text("Bora pinned a message")');
    ok('Party Bot says who pinned it, replying to the message', await a.isVisible('#messages .msg:has-text("pinned a message") .reply-ref, #messages .msg.has-reply:has-text("pinned a message")'));
    await a.click('#pinsBtn');
    await a.waitForSelector('#searchResults .search-hit:has-text("Game night is Friday")');
    ok('the 📌 button lists pinned messages', (await a.locator('#searchResults .search-hit').count()) === 1 && await a.isHidden('#searchForm'));
    await a.screenshot({ path: `${RESULTS}/pins.png` });
    await a.click('#searchResults .search-hit');
    await a.waitForSelector('.msg.flash:has-text("Game night is Friday")');
    ok('clicking a pin jumps to the message', true);
    await msg(a).hover();
    await msg(a).locator('.msg-tool[aria-label="Unpin"]').click();
    await b.waitForSelector('#messages .msg:not(:has(.msg-pinned)):has-text("Game night is Friday") >> nth=0');
    await b.click('#pinsBtn');
    await b.waitForSelector('#searchNote:has-text("Nothing pinned here yet")');
    ok('unpinning removes it everywhere', true);
    const errs = [...a.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
