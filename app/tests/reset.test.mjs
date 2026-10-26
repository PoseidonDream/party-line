/* Forgot password: the person asks with a new password, an admin approves in the app, and they're signed in
   (and signed out everywhere else). Denied requests say so. */
import { startServer, launchBrowser, signUp, openPage, RESULTS } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Poseidon');
    const old = await signUp(browser, srv.url, 'Bora');   // Bora's old device, still signed in

    const ask = async (name, pass, note) => {
      const p = await openPage(browser, srv.url);
      await p.click('#tabLogin');
      await p.click('#authForgot');
      await p.fill('#authName', name); await p.fill('#authPass', pass); await p.fill('#resetNote', note);
      await p.click('#authBtn');
      await p.waitForSelector('#resetWait:not([hidden])');
      return p;
    };
    const b = await ask('Bora', 'brandnew99', 'it’s me, new phone');
    ok('asking shows a waiting screen', true);
    await a.waitForSelector('#resetBar:not([hidden]):has-text("Bora wants to reset their password")');
    ok('the admin is told right away', true);
    await a.click('#resetReview');
    await a.waitForSelector('#resetList .reset-item:has-text("Bora"):has-text("new phone")');
    ok('the request shows the note and the device', /from (Chrome|Browser)/.test(await a.textContent('#resetList .reset-item small')));
    await a.screenshot({ path: `${RESULTS}/reset-review.png` });
    await a.click('#resetList .reset-item button:text-is("Approve")');
    await a.click('#cfOk');
    await b.waitForSelector('#room:not([hidden])', { timeout: 10000 });
    ok('once approved, they’re signed in on the device that asked', true);
    await old.waitForSelector('#join:not([hidden])', { timeout: 10000 });
    ok('their other devices are signed out', true);
    await a.waitForSelector('#resetBar', { state: 'hidden' });
    await a.keyboard.press('Escape');

    const login = (pass) => fetch(`${srv.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Bora', password: pass }) });
    ok('the old password stops working and the new one works', (await login('pass1234')).status === 400 && (await login('brandnew99')).ok);

    const c = await ask('Bora', 'sneaky123', 'trust me');
    await a.waitForSelector('#resetBar:not([hidden])');
    await a.click('#resetReview');
    await a.click('#resetList .reset-item button:text-is("Deny")');
    await c.waitForSelector('#authError:not([hidden]):has-text("turned the request down")', { timeout: 10000 });
    ok('a denied request tells the person asking', (await login('sneaky123')).status === 400);

    const nobody = await fetch(`${srv.url}/api/reset-request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Nobody', newPassword: 'whatever1' }) });
    ok('asking for a name that doesn’t exist is refused', nobody.status === 400);

    const errs = [...a.errors, ...b.errors, ...c.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
