/* Events: plan one, Party Bot announces it with a time in each person's time zone, Going / Maybe, the reminder
   that pings everyone going, and cancelling. */
import { startServer, launchBrowser, signUp, RESULTS } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Poseidon');
    const b = await signUp(browser, srv.url, 'Bora');

    await a.click('#eventsBtn');
    await a.waitForSelector('#eventsDlg[open] #evEmpty:not([hidden])');
    await a.click('#evNewBtn');
    await a.fill('#evName', 'Game night');
    // 10 minutes from now, so the 15-minute reminder is due right away.
    const when = await a.evaluate(() => { const t = new Date(Date.now() + 10 * 60_000); return new Date(t - t.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); });
    await a.fill('#evWhen', when);
    await a.selectOption('#evChan', { label: 'Lobby' });
    await a.fill('#evDesc', 'Bring snacks');
    await a.click('#evForm button[type=submit]');
    await a.waitForSelector('#evList .ev:has-text("Game night"):has-text("1 going")');
    ok('planning an event lists it with you going', await a.isVisible('#evList .ev:has-text("Lobby"):has-text("Bring snacks")'));
    await a.keyboard.press('Escape');

    await b.waitForSelector('#messages .msg:has(.bot-tag):has-text("planned Game night") .time-tag');
    ok('Party Bot announces it, with the time shown in your own time zone', /\d/.test(await b.textContent('#messages .time-tag')));
    await b.waitForSelector('#eventsCount:not([hidden]):text-is("1")');
    ok('the Events button counts upcoming events', true);

    await b.click('#eventsBtn');
    await b.click('#evList .ev:has-text("Game night") button:text-is("Going")');
    await a.click('#eventsBtn');
    await a.waitForSelector('#evList .ev:has-text("2 going (Poseidon, Bora)")');
    ok('saying Going shows for everyone', true);
    await b.click('#evList .ev:has-text("Game night") button:text-is("Maybe")');
    await a.waitForSelector('#evList .ev:has-text("1 going"):has-text("1 maybe (Bora)")');
    ok('Maybe moves you to the maybe list', true);
    ok('only whoever made it (or an admin) can cancel it', await b.locator('#evList .link-btn:text-is("Cancel event")').count() === 0 && await a.locator('#evList .link-btn:text-is("Cancel event")').count() === 1);
    await a.screenshot({ path: `${RESULTS}/events.png` });
    await b.keyboard.press('Escape');

    await b.waitForSelector('#messages .msg:has(.bot-tag):has-text("Game night starts")', { timeout: 40000 });
    ok('15 minutes before, Party Bot pings everyone going', await b.isVisible('#messages .msg:has-text("Game night starts") .mention:has-text("@Poseidon")'));

    await a.click('#evList .link-btn:text-is("Cancel event")');
    await a.click('#cfOk');
    await b.waitForSelector('#messages .msg:has(.bot-tag):has-text("was cancelled")');
    await b.waitForSelector('#eventsCount', { state: 'hidden' });
    ok('cancelling removes it and tells the server', true);

    const errs = [...a.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
