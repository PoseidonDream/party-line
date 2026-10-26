/* Read receipts in private chats, search filters, the admin action log, and invite links that run out. */
import { startServer, launchBrowser, signUp, RESULTS } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Poseidon');
    const b = await signUp(browser, srv.url, 'Bora');

    // Read receipts
    await b.fill('#chatInput', 'hello there'); await b.keyboard.press('Enter');
    await a.click('#messages .msg:has-text("hello there") .mini-av'); await a.click('#popMsg');
    await a.fill('#chatInput', 'did you see this?'); await a.keyboard.press('Enter');
    await a.waitForSelector('#messages .msg:has-text("did you see this?")');
    await a.waitForTimeout(500);
    ok('no “Seen” before they read it', await a.locator('#messages .seen-line').count() === 0);
    await b.click('#railHome'); await b.click('#dmList .dm-item:has-text("Poseidon")');
    await a.waitForSelector('#messages .seen-line:text-is("Seen")', { timeout: 8000 });
    ok('“Seen” shows once they open the chat', true);
    await a.fill('#chatInput', 'and this?'); await a.keyboard.press('Enter');
    await a.waitForSelector('#messages .seen-line:text-is("Seen")', { timeout: 8000 });
    ok('it moves to your newest message when they read that too', true);

    // Search filters
    await b.click('#railList .rail-btn');
    await b.click('#textList .chan:has-text("general")');
    await b.setInputFiles('#fileInput', { name: 'plan.txt', mimeType: 'text/plain', buffer: Buffer.from('plan') });
    await b.click('#chatForm button[type=submit]');
    await b.waitForSelector('#tray', { state: 'hidden' });
    await a.click('#railList .rail-btn');
    await a.click('#textList .chan:has-text("game-night")');
    await a.fill('#chatInput', 'hello from game night'); await a.keyboard.press('Enter');
    const search = async (q) => { await a.click('#searchBtn'); await a.fill('#searchInput', q); await a.keyboard.press('Enter'); await a.waitForSelector('#searchNote:not(:has-text("Searching"))'); return a.locator('#searchResults .search-hit').allTextContents(); };
    let hits = await search('from:Bora hello');
    ok('from: finds only that person’s messages', hits.length === 1 && hits[0].includes('hello there'));
    await a.click('#searchClose');
    hits = await search('has:file');
    ok('has:file finds messages with files', hits.length === 1 && hits[0].includes('Bora'));
    await a.click('#searchClose');
    hits = await search('hello in:#game-night');
    ok('in:#channel searches one channel', hits.length === 1 && hits[0].includes('game night'));
    await a.click('#searchClose');

    // Admin log
    await b.fill('#chatInput', 'delete me please'); await b.keyboard.press('Enter');
    await a.click('#textList .chan:has-text("general")');
    const doomed = '#messages .msg:has-text("delete me please")';
    await a.locator(doomed).hover();
    await a.click(`${doomed} .msg-tool.del`, { modifiers: ['Shift'] });
    await a.click('#navDev').catch(async () => { await a.click('#railHome'); await a.click('#navDev'); });
    await a.click('#devPanel [data-tab="audit"]');
    await a.waitForSelector('#devPanel .dev-table tr:has-text("Deleted a message"):has-text("delete me please")');
    ok('deleting someone else’s message shows in the admin log', true);
    await a.screenshot({ path: `${RESULTS}/admin-log.png` });
    await a.keyboard.press('Escape');

    // Invite links that run out
    await a.click('#railAdd');
    await a.fill('#asName', 'HQ'); await a.press('#asName', 'Enter');
    await a.waitForSelector('#serverName:text-is("HQ")');
    await a.click('#copyInvite');
    await a.selectOption('#ivUses', '1');
    await a.click('#ivCreate');
    await a.waitForSelector('#ivList .iv-item:has-text("0 of 1 used")');
    const link = (await a.textContent('#ivList .iv-item code')).trim();
    ok('a one-use invite link can be made', /\/invite\/\w+$/.test(link));
    if (await a.isVisible('#confirmDlg[open]')) await a.click('#cfOk');   // no clipboard in tests: the copy box shows
    await a.keyboard.press('Escape');
    const use = async (p) => { await p.click('#railAdd'); await p.fill('#asInvite', link); await p.press('#asInvite', 'Enter'); };
    await use(b);
    await b.waitForSelector('#railList .rail-btn[title="HQ"]');
    const c = await signUp(browser, srv.url, 'Cem');
    await use(c);
    await c.waitForSelector('#asError:not([hidden]):has-text("expired")');
    ok('once it’s used up, it stops working', await c.locator('#railList .rail-btn[title="HQ"]').count() === 0);

    const errs = [...a.errors, ...b.errors, ...c.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
