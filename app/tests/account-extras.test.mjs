/* Optional email and age. Email: a code confirms the address, then "Forgot your password?" can send a code there that
   signs you in with a new password. Age: a private, self-declared birth date; 18+ channels only open for people who
   confirmed they're 18 or older, and nothing from them reaches anyone else. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, launchBrowser, signUp, openPage } from './lib.mjs';

const mailDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-mail-'));
/* The newest code emailed to someone. */
const codeFor = (to) => {
  const mails = fs.readdirSync(mailDir).sort().map((f) => JSON.parse(fs.readFileSync(path.join(mailDir, f), 'utf8'))).filter((m) => m.to === to);
  return mails.length ? /\b(\d{6})\b/.exec(mails[mails.length - 1].text)[1] : null;
};
/* A live connection from outside the browser, signed in as the same person as a page. */
const sockets = [];
async function liveOf(page, url) {
  const token = await page.evaluate(() => JSON.parse(localStorage.getItem('pl:token')));
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`);
    const pending = new Map(), seen = []; let rid = 0;
    const api = { seen, ws, token,
      req: (t, data) => new Promise((res, rej) => { const id = ++rid; pending.set(id, (d) => (d.error ? rej(new Error(d.error)) : res(d))); ws.send(JSON.stringify(Object.assign({ t, rid: id }, data))); }) };
    ws.onmessage = (e) => { const d = JSON.parse(e.data); seen.push(d); if (d.t === 'ready') { api.ready = d; resolve(api); } if (d.t === 'ack' && pending.has(d.rid)) { pending.get(d.rid)(d); pending.delete(d.rid); } };
    ws.onerror = reject;
    sockets.push(api);
  });
}
const tryReq = (l, t, d) => l.req(t, d).then(() => 'ok', (e) => e.message);
const yearsAgo = (n) => { const d = new Date(); d.setFullYear(d.getFullYear() - n); d.setDate(d.getDate() - 2); return d.toISOString().slice(0, 10); };

export default async function (ok) {
  const plain = await startServer();
  const info = await (await fetch(`${plain.url}/api/info`)).json();
  ok('without email set up on the server, email stays hidden', info.mail === false);
  await plain.stop();

  const srv = await startServer({ MAIL_DIR: mailDir });
  const browser = await launchBrowser();
  const post = (p, body) => fetch(srv.url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  try {
    // ---- Email ----
    const a = await signUp(browser, srv.url, 'Ayla');
    await a.click('#setBtn'); await a.click('#settings [data-settab="account"]');
    await a.click('#emailBox summary');
    ok('Settings → Account has an optional Email box', await a.isVisible('#emailInput') && (await a.textContent('#emailState')) === 'None');
    await a.fill('#emailInput', 'Ayla@Example.com'); await a.click('#emailSend');
    await a.waitForSelector('#emailCodeRow:not([hidden])');
    const code = codeFor('ayla@example.com');
    ok('a 6-digit code is emailed to the address', !!code);
    await a.fill('#emailCode', '000000'); await a.click('#emailConfirm');
    await a.waitForSelector('.toast:has-text("doesn’t match")');
    ok('a wrong code is refused', (await a.textContent('#emailState')) === 'None');
    await a.fill('#emailCode', code); await a.click('#emailConfirm');
    await a.waitForSelector('#emailState:has-text("Confirmed")');
    ok('the right code confirms it', (await a.textContent('#emailNow')).includes('ayla@example.com'));
    const taken = await signUp(browser, srv.url, 'Bora');
    const bora = await liveOf(taken, srv.url);
    ok('another account can’t use the same email', /already uses/.test(await tryReq(bora, 'email.start', { email: 'ayla@example.com' })));

    // Forgot password, by email
    const r = await openPage(browser, srv.url);
    await r.click('#tabLogin'); await r.click('#authForgot');
    await r.waitForSelector('#authMailReset:not([hidden])');
    await r.fill('#authName', 'Ayla'); await r.click('#authMailReset');
    await r.waitForSelector('#mailCodeField:not([hidden])');
    ok('“Forgot your password?” offers a code by email', true);
    const nobody = await post('/api/reset-email', { name: 'Nobody here' });
    ok('…and answers the same for an account without email (nobody can find out which have one)', nobody.ok === true);
    await r.fill('#mailCode', codeFor('ayla@example.com')); await r.fill('#authPass', 'brandnew99'); await r.click('#authBtn');
    await r.waitForSelector('#room:not([hidden])', { timeout: 10000 });
    ok('the code and a new password sign you in', true);
    const oldPass = await post('/api/login', { name: 'Ayla', password: 'pass1234' });
    const newPass = await post('/api/login', { name: 'Ayla', password: 'brandnew99' });
    ok('…the old password stops working, the new one works', oldPass.status === 400 && !!newPass.token);
    await a.waitForSelector('#join:not([hidden])', { timeout: 10000 });
    ok('…and other devices are signed out', true);

    // ---- Age and 18+ channels ----
    const admin = await signUp(browser, srv.url, 'Poseidon');
    const adminLive = await liveOf(admin, srv.url);
    const made = await adminLive.req('chan.create', { serverId: adminLive.ready.servers[0].id, kind: 'text', name: 'after-dark' });
    const chId = made.id;
    await adminLive.req('chan.edit', { id: chId, adult: true });
    await admin.waitForSelector('#textList .chan:has-text("after-dark") .chan-adult');
    ok('admins can mark a channel 18+ (🔞 next to its name)', true);

    const teen = await signUp(browser, srv.url, 'Teen');
    await teen.click('#textList .chan:has-text("after-dark")');
    await teen.waitForSelector('.adult-gate');
    ok('someone who hasn’t confirmed their age sees a note instead of the chat', await teen.isHidden('#chatForm'));
    const teenLive = await liveOf(teen, srv.url);
    ok('…and can’t post there', /18 and older/.test(await tryReq(teenLive, 'msg.send', { channelId: chId, body: 'hi', attachments: [] })));
    await teen.click('.adult-gate button');
    await teen.waitForSelector('#ageBox[open]');
    await teen.fill('#ageBorn', yearsAgo(10)); await teen.click('#ageSave'); await teen.click('#cfOk');
    await teen.waitForSelector('.toast:has-text("13 and older")');
    ok('a birth date under 13 is refused', (await teen.textContent('#ageState')) === 'Not confirmed');
    await teen.fill('#ageBorn', yearsAgo(15)); await teen.click('#ageSave'); await teen.click('#cfOk');
    await teen.waitForSelector('#ageState:has-text("Under 18")');
    ok('a 15-year-old is confirmed as under 18', await teen.isHidden('#ageForm'));
    ok('…and can’t change it to older afterwards', /already confirmed/.test(await tryReq(teenLive, 'age.set', { born: yearsAgo(30) })));

    await admin.click('#textList .chan:has-text("after-dark")');
    await admin.waitForSelector('.adult-gate');
    ok('the admin is held back too until they confirm their own age', await admin.isHidden('#chatForm'));
    await adminLive.req('age.set', { born: yearsAgo(30) });
    await admin.waitForSelector('#chatForm:not(.locked)');
    await admin.fill('#chatInput', 'grown-up talk'); await admin.keyboard.press('Enter');
    await admin.waitForSelector('#messages .msg:has-text("grown-up talk")');
    ok('someone confirmed 18+ reads and posts there', true);
    await teen.waitForTimeout(800);
    ok('nothing posted there reaches people under 18', !teenLive.seen.some((d) => d.t === 'msg' && d.msg && d.msg.channelId === chId));
    const search = await (await fetch(`${srv.url}/api/search?q=grown-up`, { headers: { authorization: `Bearer ${teenLive.token}` } })).json();
    ok('…not even through search', search.messages.length === 0);
    const errs = [...a.errors, ...admin.errors, ...teen.errors].filter((e) => !/18 and older|13 and older|doesn’t match/.test(e));
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { for (const l of sockets) try { l.ws.close(); } catch {} await browser.close(); await srv.stop(); fs.rmSync(mailDir, { recursive: true, force: true }); }
}
