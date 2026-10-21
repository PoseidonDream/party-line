/* Admin tools: resetting a forgotten password. */
import { startServer, launchBrowser, signUp, openPage } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const admin = await signUp(browser, srv.url, 'Poseidon');
    const bora = await signUp(browser, srv.url, 'Bora');
    await bora.fill('#chatInput', 'hi'); await bora.press('#chatInput', 'Enter');
    await admin.waitForSelector('.msg:has-text("hi") .mini-av');
    await admin.click('.msg:has-text("hi") .mini-av');
    await admin.waitForSelector('#admReset:visible');
    await admin.click('#admReset');
    await admin.click('#cfOk');
    await admin.waitForSelector('#cfInput:visible');
    const temp = await admin.inputValue('#cfInput');
    ok(`admin gets a temporary password (${temp})`, /^[a-z]+-[a-z]+-\d{3}$/.test(temp));
    await admin.click('#cfOk');
    await bora.waitForSelector('#join:not([hidden])', { timeout: 5000 });
    ok('the person is signed out everywhere', true);
    const p = await openPage(browser, srv.url);
    await p.click('#tabLogin'); await p.fill('#authName', 'Bora'); await p.fill('#authPass', 'pass1234'); await p.click('#authBtn');
    await p.waitForSelector('#authError:not([hidden])');
    ok('the old password no longer works', true);
    await p.fill('#authPass', temp); await p.click('#authBtn');
    await p.waitForSelector('#room:not([hidden])');
    ok('the temporary password works', true);
    await p.click('#setBtn'); await p.click('.pw-box summary');
    await p.fill('#pwOld', temp); await p.fill('#pwNew', 'newpass99'); await p.click('#pwSave');
    await p.waitForSelector('#pwNote:has-text("changed")');
    ok('they can change it to their own', true);
    const bOnly = await signUp(browser, srv.url, 'Cem');
    await bOnly.fill('#chatInput', 'yo'); await bOnly.press('#chatInput', 'Enter');
    await bOnly.click('.msg:has-text("hi") .mini-av');
    ok('non-admins don’t see admin tools', await bOnly.isHidden('#popAdmin'));
  } finally { await browser.close(); await srv.stop(); }
}
