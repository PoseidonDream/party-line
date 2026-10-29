/* What Google Play asks of an app where people post things: agreeing to rules at sign-up, a privacy policy, blocking
   and reporting, and deleting your account (in the app and on a web page). */
import { startServer, launchBrowser, signUp, openPage, openDb } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer({ CONTACT_EMAIL: 'owner@example.com' });
  const browser = await launchBrowser();
  try {
    const api = (p, body, token) => fetch(srv.url + p, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: `Bearer ${token}` } : {}), body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));

    // Agreeing to the rules
    const noAgree = await api('/api/register', { name: 'Nope', password: 'pass1234', groupPassword: 'test' });
    ok('making an account needs agreeing to the rules', noAgree.status === 400 && /community rules/.test(noAgree.error));
    const p = await openPage(browser, srv.url);
    await p.click('#tabRegister'); await p.fill('#authName', 'Lale'); await p.fill('#authPass', 'pass1234'); await p.fill('#authGroup', 'test');
    ok('…the box is on the Create account form, with links to the rules and the privacy policy', await p.isVisible('#agreeField a[href="/rules"]') && await p.isVisible('#agreeField a[href="/privacy"]'));
    await p.click('#authBtn');
    ok('…and without ticking it, it says so', /agree to the community rules/.test(await p.textContent('#authError')));
    await p.check('#authAgree'); await p.click('#authBtn'); await p.waitForSelector('#room:not([hidden])');
    const lale = p;

    // The pages
    for (const [path, title] of [['/privacy', 'Privacy policy'], ['/rules', 'Community rules'], ['/delete-account', 'Delete your account']]) {
      const page = await browser.newPage(); await page.goto(srv.url + path);
      const h1 = await page.textContent('h1');
      if (path !== '/delete-account') await page.waitForSelector('#contact a[href="mailto:owner@example.com"]');
      ok(`${path} shows the ${title.toLowerCase()}${path !== '/delete-account' ? ', with the server’s contact address' : ''}`, h1 === title);
      await page.close();
    }

    const a = await signUp(browser, srv.url, 'Poseidon');
    const b = await signUp(browser, srv.url, 'Bora');
    const req = (pg, t, d) => pg.evaluate(async ([t, d]) => { const { live } = await import('/js/net.js'); return live.req(t, d).then((r) => r, (e) => ({ error: e.message })); }, [t, d]);
    const bad = await req(lale, 'msg.send', { channelId: 1, body: 'you are all terrible', attachments: [] });
    await req(lale, 'msg.send', { channelId: 1, body: 'and another one', attachments: [] });
    const lid = bad.msg.userId;

    // Blocking
    await b.waitForSelector('#messages .msg:has-text("you are all terrible")');
    await b.click('#messages .msg:has-text("you are all terrible") .mini-av');
    await b.click('#popBlock'); await b.click('#cfOk');
    await b.waitForSelector('#messages .blocked-row');
    ok('blocking from the profile card hides their messages (one line for a run of them)', await b.locator('#messages .blocked-row').count() === 1 && !(await b.isVisible('#messages .msg:has-text("you are all terrible")')));
    await b.click('#messages .blocked-row .link-btn');
    ok('…“Show” shows them anyway', await b.isVisible('#messages .msg:has-text("you are all terrible")'));
    const db = openDb(srv); const ids = Object.fromEntries(db.prepare('SELECT name, id FROM users').all().map((r) => [r.name, r.id])); db.close();
    const dmTry = await req(lale, 'msg.send', { toUserId: ids.Bora, body: 'hello?', attachments: [] });
    ok('…they can’t message you', /couldn’t be delivered/.test(dmTry.error || ''));
    const frTry = await req(lale, 'friend.request', { name: 'Bora' });
    ok('…or send you a friend request', /can’t send Bora a friend request/.test(frTry.error || ''));
    const callTry = await req(lale, 'call.start', { userId: ids.Bora });
    ok('…or call you', /can’t call/.test(callTry.error || ''));
    await b.click('#setBtn'); await b.click('#settings [data-settab="account"]'); await b.click('#blockedBox summary');
    ok('Settings → Account lists who you blocked', (await b.textContent('#blockedList')).includes('Lale'));
    await b.click('#blockedList button'); await b.waitForSelector('#blockedList:has-text("Nobody")');
    ok('…and unblocks them', (await req(lale, 'friend.request', { name: 'Bora' })).state === 'outgoing');
    await b.keyboard.press('Escape');

    // Reporting
    await b.hover('#messages .msg:has-text("you are all terrible")');
    await b.click('#messages .msg:has-text("you are all terrible") .msg-tool[aria-label="Report"]');
    await b.waitForSelector('#reportDlg[open]');
    ok('Report on a message shows what you’re reporting', (await b.textContent('#reportWhat')).includes('you are all terrible'));
    await b.check('#reportDlg input[value="harassment"]'); await b.fill('#reportNote', 'not ok');
    await b.click('#reportSend');
    await b.waitForSelector('.toast:has-text("admins got your report")');
    const bot = () => { const d = openDb(srv); try { return d.prepare("SELECT body FROM messages WHERE dm_id IS NOT NULL AND user_id = (SELECT id FROM users WHERE is_bot = 1)").all().map((r) => r.body); } finally { d.close(); } };
    const note = bot().find((x) => /Report/.test(x)) || '';
    ok('…the admins get a private note from Party Bot with the reason and the message', /from Bora about \*\*Lale\*\*: Harassment or bullying/.test(note) && /you are all terrible/.test(note) && /not ok/.test(note));
    await a.keyboard.press('Control+Shift+D'); await a.click('#devPanel [data-tab="reports"]');
    await a.waitForSelector('#devPanel .report-list li');
    ok('…and it’s in Developer → Reports', (await a.textContent('#devPanel .report-list')).includes('Harassment or bullying'));
    await a.click('#devPanel .report-list button:has-text("Delete the message")');
    await a.waitForSelector('#devPanel .report-list li.done');
    await b.waitForSelector('#messages .msg:has-text("you are all terrible")', { state: 'detached' });
    ok('…where an admin deletes the message for everyone', true);
    await a.keyboard.press('Escape');
    ok('reporting a person from their profile card works too', !(await req(b, 'report.send', { userId: lid, reason: 'spam' })).error);

    // Deleting an account in the app
    await lale.click('#setBtn'); await lale.click('#settings [data-settab="account"]'); await lale.click('#deleteBox summary');
    await lale.fill('#deletePass', 'wrong'); await lale.click('#deleteAccountBtn'); await lale.click('#cfOk');
    await lale.waitForSelector('.toast:has-text("password isn’t right")');
    ok('deleting your account needs your password', true);
    await lale.fill('#deletePass', 'pass1234'); await lale.click('#deleteAccountBtn'); await lale.click('#cfOk');
    await lale.waitForSelector('#join:not([hidden])');
    ok('Settings → Account → Delete my account signs you out', await lale.waitForSelector('.toast:has-text("account was deleted")').then(() => true, () => false));
    await b.waitForSelector('#messages .msg:has-text("and another one")', { state: 'detached' });
    ok('…and your messages disappear for everyone', true);
    const relog = await api('/api/login', { name: 'Lale', password: 'pass1234' });
    ok('…and the account is gone', relog.status === 400);
    const d2 = openDb(srv); const left = d2.prepare('SELECT COUNT(*) AS n FROM messages WHERE user_id = ?').get(lid).n; d2.close();
    ok('…with nothing of it left on the server', left === 0);

    // Deleting an account on the web page
    await api('/api/register', { name: 'Temp', password: 'pass1234', groupPassword: 'test', agree: true });
    const page = await browser.newPage(); await page.goto(`${srv.url}/delete-account`);
    await page.fill('#name', 'Temp'); await page.fill('#pass', 'pass1234'); await page.check('#sure'); await page.click('#go');
    await page.waitForSelector('#done:not([hidden])');
    ok('the /delete-account page deletes an account without the app', (await api('/api/login', { name: 'Temp', password: 'pass1234' })).status === 400);
    const errs = [...a.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
