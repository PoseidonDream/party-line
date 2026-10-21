/* Dark and light mode: the corner toggle, the Settings choice, and remembering it. */
import { startServer, launchBrowser, openPage, signUp } from './lib.mjs';

const DARK = 'rgb(17, 21, 29)', LIGHT = 'rgb(232, 235, 240)';
export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const p = await openPage(browser, srv.url, { colorScheme: 'dark' });
    const bg = () => p.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await p.waitForSelector('#join:not([hidden])');
    ok('follows a dark computer by default', (await bg()) === DARK);
    await p.click('#themeToggle');
    ok('corner toggle switches to light', (await bg()) === LIGHT);
    await p.reload();
    ok('the choice is remembered', (await bg()) === LIGHT);
    const q = await signUp(browser, srv.url, 'Deniz', { colorScheme: 'light' });
    await q.click('#setBtn');
    await q.click('.theme-opt:has-text("Dark")');
    ok('Settings → Dark works', (await q.evaluate(() => getComputedStyle(document.body).backgroundColor)) === DARK);
    await q.click('.theme-opt:has-text("System")');
    ok('Settings → System follows the computer again', (await q.evaluate(() => getComputedStyle(document.body).backgroundColor)) === LIGHT);
  } finally { await browser.close(); await srv.stop(); }
}
