/* The Private chats list: a chat you open stays there (even before anyone writes), ✕ closes it, and a new
   message brings it back. */
import { startServer, launchBrowser, signUp } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Poseidon');
    const b = await signUp(browser, srv.url, 'Bora');
    await b.fill('#chatInput', 'hi all'); await b.keyboard.press('Enter');
    await a.fill('#chatInput', 'yo'); await a.keyboard.press('Enter');
    await a.click('#messages .msg:has-text("hi all") .mini-av');
    await a.click('#popMsg');
    await a.waitForSelector('#viewTitle:text-is("Bora")');
    await a.click('#navFriends');
    await a.waitForSelector('#dmList .dm-item:has-text("Bora")');
    ok('a private chat you opened stays in the list, even with no messages yet', true);
    await a.reload(); await a.waitForSelector('#room:not([hidden])');
    await a.click('#railHome');
    await a.waitForSelector('#dmList .dm-item:has-text("Bora")');
    ok('it’s still there after reopening the app', true);
    await a.locator('#dmList li:has-text("Bora")').hover();
    await a.click('#dmList li:has-text("Bora") .dm-close');
    await a.waitForSelector('#dmList .dm-item:has-text("Bora")', { state: 'detached' });
    ok('✕ closes it', true);
    await b.click('#messages .msg:has-text("yo") .mini-av');
    await b.click('#popMsg');
    await b.fill('#chatInput', 'psst'); await b.keyboard.press('Enter');
    await a.waitForSelector('#dmList .dm-item:has-text("Bora")');
    ok('a new message brings it back', true);
    const errs = [...a.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
