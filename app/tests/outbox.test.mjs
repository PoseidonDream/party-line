/* Messages wait for the connection: written while the server is unreachable, they show above the message box as
   "Waiting for the connection…", are saved on the device, and go out by themselves (in order, once each) when it's back. */
import { startServer, launchBrowser, signUp, openDb } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Deniz');
    const b = await signUp(browser, srv.url, 'Bora');
    const req = (p, t, d) => p.evaluate(async ([t, d]) => { const { live } = await import('/js/net.js'); return live.req(t, d); }, [t, d]);

    // The same one-time tag twice: posted once
    const r1 = await req(a, 'msg.send', { channelId: 1, body: 'only once please', attachments: [], nonce: 'tag-123456789' });
    const r2 = await req(a, 'msg.send', { channelId: 1, body: 'only once please', attachments: [], nonce: 'tag-123456789' });
    await b.waitForSelector('#messages .msg:has-text("only once please")');
    await b.waitForTimeout(500);
    ok('a message sent again with the same tag (after a dropped connection) is posted only once', r1.msg.id === r2.msg.id && await b.locator('#messages .msg-body:text-is("only once please")').count() === 1);

    // The server goes away
    await srv.kill();
    await a.waitForSelector('#offlineBar:not([hidden])', { timeout: 10000 });
    for (const text of ['first while offline', 'second while offline']) { await a.fill('#chatInput', text); await a.keyboard.press('Enter'); }
    await a.waitForSelector('#outbox:not([hidden]) li:has-text("second while offline")');
    ok('a message written while offline waits above the message box (“Waiting for the connection…”)', (await a.textContent('#outbox')).includes('Waiting for the connection') && (await a.inputValue('#chatInput')) === '');
    ok('…and is saved on the device, so closing the app doesn’t lose it', await a.evaluate(() => (JSON.parse(localStorage.getItem('pl:outbox')) || []).length === 2));

    // Back
    await srv.restart();
    await b.waitForSelector('#messages .msg:has-text("second while offline")', { timeout: 20000 });
    const order = await b.$$eval('#messages .msg-body', (els) => els.map((e) => e.textContent).filter((x) => x.includes('while offline')));
    ok('when the connection is back, they go out by themselves, in order, once each', JSON.stringify(order) === JSON.stringify(['first while offline', 'second while offline']));
    await a.waitForSelector('#outbox', { state: 'hidden' });
    ok('…and the waiting list empties', await a.evaluate(() => (JSON.parse(localStorage.getItem('pl:outbox')) || []).length === 0));

    // A waiting message can be taken back
    await srv.kill();
    await a.waitForSelector('#offlineBar:not([hidden])', { timeout: 10000 });
    await a.fill('#chatInput', 'never mind'); await a.keyboard.press('Enter');
    await a.click('#outbox li:has-text("never mind") button');
    await srv.restart();
    await a.waitForSelector('#offlineBar', { state: 'hidden', timeout: 20000 });
    await b.waitForTimeout(1500);
    ok('…and one can be taken back before it goes (✕)', await b.locator('#messages .msg:has-text("never mind")').count() === 0);
    // The tag is kept with the message: sent again after a server restart, still only once
    await srv.kill(); await srv.restart();
    await a.waitForSelector('#offlineBar', { state: 'hidden', timeout: 20000 });
    const r3 = await req(a, 'msg.send', { channelId: 1, body: 'only once please', attachments: [], nonce: 'tag-123456789' });
    ok('…even after the server restarts in between', r3.msg.id === r1.msg.id && r3.again === true);

    // Signed out by the server while offline (password changed elsewhere): waiting messages are dropped, not sent as the next person
    await srv.kill();
    await a.waitForSelector('#offlineBar:not([hidden])', { timeout: 10000 });
    await a.fill('#chatInput', 'from the old sign-in'); await a.keyboard.press('Enter');
    await a.waitForSelector('#outbox li:has-text("from the old sign-in")');
    const db = openDb(srv); db.prepare("DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE name = 'Deniz')").run(); db.close();
    await srv.restart();
    await a.waitForSelector('#join:not([hidden])', { timeout: 20000 });
    await a.click('#tabRegister'); await a.fill('#authName', 'Lale'); await a.fill('#authPass', 'pass1234'); await a.check('#authAgree'); await a.click('#authBtn');
    await a.waitForSelector('#room:not([hidden])');
    await b.waitForTimeout(2000);
    ok('…and when the server signs you out, your waiting messages are dropped, never sent by whoever signs in next', await b.locator('#messages .msg:has-text("from the old sign-in")').count() === 0 && await a.evaluate(() => (JSON.parse(localStorage.getItem('pl:outbox')) || []).length === 0));

    const errs = [...a.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
