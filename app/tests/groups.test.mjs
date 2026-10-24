/* Group chats (create, chat, add people, leave), group calls that ring, and 1-on-1 calls from a private chat. */
import { startServer, launchBrowser, signUp, RESULTS } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Poseidon');
    const b = await signUp(browser, srv.url, 'Bora');
    const c = await signUp(browser, srv.url, 'Cem');
    const d = await signUp(browser, srv.url, 'Deniz');
    for (const p of [a, b, c, d]) await p.click('#railHome');

    await a.click('#newGroupBtn');
    await a.check('#grPick label:has-text("Bora") input'); await a.check('#grPick label:has-text("Cem") input');
    await a.fill('#grName', 'Squad');
    await a.click('#grSubmit');
    await a.waitForSelector('#viewTitle:text-is("Squad")');
    await b.waitForSelector('#dmList .dm-item:has-text("Squad")');
    ok('a new group chat shows under Private chats for everyone in it', await d.locator('#dmList .dm-item:has-text("Squad")').count() === 0);
    ok('group chats stay out of the server bar', await b.locator('#railList .rail-btn[title="Squad"]').count() === 0);
    await a.waitForSelector('#messages .msg:has(.bot-tag):has-text("started a group chat")');

    await b.click('#dmList .dm-item:has-text("Squad")');
    await b.fill('#chatInput', 'who is up for valorant'); await b.keyboard.press('Enter');
    await a.waitForSelector('#messages .msg:has-text("who is up for valorant")');
    await c.waitForSelector('#dmList .dm-item:has-text("Squad") .count-pill');   // the bot's welcome and Bora's message
    ok('messages reach the group, with an unread count', true);

    await a.click('#groupAddBtn');
    await a.check('#grPick label:has-text("Deniz") input');
    await a.click('#grSubmit');
    await d.waitForSelector('#dmList .dm-item:has-text("Squad")');
    await b.waitForSelector('#messages .msg:has(.bot-tag):has-text("added Deniz")');
    ok('people can be added to a group later', true);

    await a.click('#callBtn');
    await a.waitForSelector('#voiceStatus:not([hidden])');
    await b.waitForSelector('#ringBar:not([hidden]):has-text("Poseidon started a call")');
    await c.waitForSelector('#ringBar:not([hidden])');
    ok('starting a group call rings everyone else', true);
    await c.click('#ringDecline');
    ok('declining hides the ring', await c.isHidden('#ringBar'));
    await b.click('#ringJoin');
    await a.waitForSelector('#tiles .tile:has-text("Bora") .tile-sub:has-text("Connected")', { timeout: 15000 });
    ok('joining connects the call', await b.isVisible('#viewTitle:text-is("Squad")'));
    await a.screenshot({ path: `${RESULTS}/group-call.png` });
    await a.click('#vcLeaveBtn'); await b.click('#vcLeaveBtn');
    await d.waitForSelector('#ringBar', { state: 'hidden' });
    ok('the ring stops when the call ends', true);

    await c.click('#dmList .dm-item:has-text("Squad")');
    await c.click('#groupLeaveBtn'); await c.click('#cfOk');
    await a.click('#dmList .dm-item:has-text("Squad")');
    await a.waitForSelector('#messages .msg:has(.bot-tag):has-text("Cem left the group")');
    ok('leaving a group tells the others', await c.locator('#dmList .dm-item:has-text("Squad")').count() === 0);

    // 1-on-1 call from a private chat
    await a.click('#messages .msg:has-text("who is up for valorant") .mini-av');
    await a.click('#popMsg');
    await a.waitForSelector('#viewTitle:text-is("Bora")');
    await a.click('#callBtn');
    await b.waitForSelector('#ringBar:not([hidden]):has-text("Poseidon is calling")');
    ok('calling someone from your private chat rings them', await c.isHidden('#ringBar'));
    await b.click('#ringJoin');
    await b.waitForSelector('#viewTitle:text-is("Call with Poseidon")');
    await a.waitForSelector('#tiles .tile:has-text("Bora") .tile-sub:has-text("Connected")', { timeout: 15000 });
    ok('the private call connects', await a.isVisible('#viewTitle:text-is("Call with Bora")'));

    const errs = [...a.errors, ...b.errors, ...c.errors, ...d.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
