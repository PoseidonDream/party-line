/* On phones: message buttons (react, reply, pin) show when you tap a message, not on every message at once. */
import { startServer, launchBrowser, signUp, RESULTS } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Poseidon');
    await a.fill('#chatInput', 'first message'); await a.keyboard.press('Enter');
    await a.fill('#chatInput', 'second message'); await a.keyboard.press('Enter');
    const p = await signUp(browser, srv.url, 'Cem', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await p.waitForSelector('#messages .msg:has-text("second message")');
    await p.waitForTimeout(400);
    const shown = () => p.evaluate(() => [...document.querySelectorAll('#messages .msg')].filter((m) => getComputedStyle(m.querySelector('.msg-tools')).opacity === '1').length);
    ok('no message buttons until you tap', (await shown()) === 0);
    await p.tap('#messages .msg:has-text("first message") .msg-body'); await p.waitForTimeout(300);
    ok('tapping a message shows its buttons', (await shown()) === 1 && await p.isVisible('#messages .msg.tools-open:has-text("first message")'));
    await p.tap('#messages .msg:has-text("second message") .msg-body'); await p.waitForTimeout(300);
    ok('tapping another message moves them there', (await shown()) === 1 && await p.isVisible('#messages .msg.tools-open:has-text("second message")'));
    await p.tap('#messages .msg.tools-open .msg-tool[aria-label="Reply"]');
    await p.waitForSelector('#replyBar:not([hidden])');
    ok('and they work', true);
    await p.screenshot({ path: `${RESULTS}/phone-tap.png` });
    const errs = [...a.errors, ...p.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
