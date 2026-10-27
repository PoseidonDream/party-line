/* Settings → Devices you're signed in on (sign one out, or everywhere else) and 2-step sign-in with an
   authenticator app code. */
import crypto from 'node:crypto';
import { startServer, launchBrowser, signUp, openPage } from './lib.mjs';

/* What an authenticator app shows for a key, 30 s steps (RFC 6238). */
function totp(key, offset = 0) {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = ''; for (const ch of key.replace(/\s+/g, '')) bits += B32.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = []; for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const h = crypto.createHmac('sha1', Buffer.from(bytes)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
async function signIn(browser, url, name, code) {
  const p = await openPage(browser, url);
  await p.click('#tabLogin');
  await p.fill('#authName', name); await p.fill('#authPass', 'pass1234');
  await p.click('#authBtn');
  return p;
}

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Poseidon');
    const phone = await signIn(browser, srv.url, 'Poseidon');
    await phone.waitForSelector('#room:not([hidden])');

    // Devices
    await a.click('#setBtn'); await a.click('#settings [role="tab"][data-settab="account"]'); await a.click('#devicesBox summary');
    await a.waitForSelector('#sessionList li:nth-child(2)');
    const items = await a.locator('#sessionList li').allTextContents();
    ok('Settings lists every device you’re signed in on, with this one marked', items.length === 2 && items.some((t) => t.includes('This device')) && items.every((t) => /Chrome|Browser/.test(t)));
    await a.click('#sessionList li:has(button) button');
    await phone.waitForSelector('#join:not([hidden])', { timeout: 8000 });
    ok('“Sign out” on another device signs it out right away', true);
    await a.waitForFunction(() => document.querySelectorAll('#sessionList li').length === 1);

    // 2-step sign-in
    await a.click('#twoStepBox summary');
    await a.click('#twoStepStart');
    await a.waitForSelector('#twoStepSetup:not([hidden]) img.qr[src^="data:image/svg+xml"]');
    const key = (await a.textContent('#twoStepSecret')).trim();
    ok('turning it on shows a QR code and a key for the authenticator app', /^[A-Z2-7 ]{32,}$/.test(key));
    await a.fill('#twoStepCode', '000000'); await a.click('#twoStepConfirm');
    await a.waitForSelector('.toast:has-text("doesn’t match")');
    await a.fill('#twoStepCode', totp(key));
    await a.click('#twoStepConfirm');
    await a.waitForSelector('#twoStepState:text-is("On")');
    ok('a wrong code is refused; the right one turns it on', true);
    await a.keyboard.press('Escape');

    const p2 = await signIn(browser, srv.url, 'Poseidon');
    await p2.waitForSelector('#codeField:not([hidden])');
    ok('signing in on a new device then asks for the code', await p2.isHidden('#room'));
    await p2.fill('#authCode', '123456'); await p2.click('#authBtn');
    await p2.waitForSelector('#authError:not([hidden])');
    await p2.fill('#authCode', totp(key, 1)); await p2.click('#authBtn');   // the next code is accepted too (clocks drift)
    await p2.waitForSelector('#room:not([hidden])');
    ok('with the right code it signs in', true);

    await a.click('#setBtn');   // the 2-step box is still open from before
    await a.fill('#twoStepPass', 'pass1234'); await a.click('#twoStepStop');
    await a.waitForSelector('#twoStepState:text-is("Off")');
    const p3 = await signIn(browser, srv.url, 'Poseidon');
    await p3.waitForSelector('#room:not([hidden])');
    ok('turning it off (with your password) stops asking for codes', true);

    const errs = [...a.errors, ...p2.errors, ...p3.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
