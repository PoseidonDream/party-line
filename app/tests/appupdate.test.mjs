/* The "new version" card. Android: shown when GitHub's newest release has a newer build than the app, not
   when it's up to date, and "Later" hides it for that build. Desktop: shown when the app has downloaded an
   update, and "Restart now" asks the app to restart. */
import { startServer, launchBrowser, RESULTS } from './lib.mjs';

async function open(browser, url, myBuild, latestBuild) {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 800 } });
  await ctx.addInitScript((code) => {
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', registerPlugin: () => ({ setInCall: async () => {}, getVersion: async () => ({ code, name: `1.0.${code}` }) }) };
  }, myBuild);
  await ctx.route('https://api.github.com/**', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({
    tag_name: 'v1.1.0', assets: [{ name: 'Party-Line-android.apk', label: `Party Line for Android (build ${latestBuild})`, browser_download_url: 'https://github.com/x/y/releases/download/v1.1.0/Party-Line-android.apk' }] }) }));
  const p = await ctx.newPage();
  p.errors = []; p.on('pageerror', (e) => p.errors.push(e.message));
  await p.goto(url);
  await p.click('#tabRegister'); await p.fill('#authName', `User${myBuild}x${latestBuild}`); await p.fill('#authPass', 'pass1234'); await p.fill('#authGroup', 'test');
  await p.click('#authBtn'); await p.waitForSelector('#room:not([hidden])');
  return p;
}

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const old = await open(browser, srv.url, 5, 9);
    await old.waitForSelector('#updateBar:not([hidden])', { timeout: 10000 });
    ok('an older Android app offers the newer build', (await old.getAttribute('#updateGo', 'href')).endsWith('Party-Line-android.apk'));
    await old.click('#updateLater');
    await old.reload(); await old.waitForSelector('#room:not([hidden])'); await old.waitForTimeout(6500);
    ok('“Later” hides it for that build', await old.isHidden('#updateBar'));
    const fresh = await open(browser, srv.url, 9, 9);
    await fresh.waitForTimeout(6500);
    ok('an up-to-date app shows nothing', await fresh.isHidden('#updateBar'));

    // Desktop app (a stand-in for its bridge): the update is ready to install.
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(() => {
      window.partyLineDesktop = { version: '1.2.0', setBadge() {}, focus() {}, onPtt() {}, onActivity() {}, setTheme() {}, onHotkey() {}, setOverlay() {},
        onUpdate(cb) { window.__fireUpdate = cb; }, installUpdate() { window.__installed = true; } };
    });
    const d = await ctx.newPage(); d.errors = []; d.on('pageerror', (e) => d.errors.push(e.message));
    await d.goto(srv.url);
    await d.click('#tabRegister'); await d.fill('#authName', 'DesktopUser'); await d.fill('#authPass', 'pass1234'); await d.fill('#authGroup', 'test');
    await d.click('#authBtn'); await d.waitForSelector('#room:not([hidden])');
    await d.evaluate(() => window.__fireUpdate('1.3.0'));
    await d.waitForSelector('#updateBar:not([hidden])');
    ok('the desktop app shows “Party Line 1.3.0 is ready” in Party Line’s own style', (await d.textContent('#updateTitle')) === 'Party Line 1.3.0 is ready' && (await d.textContent('#updateGo')) === 'Restart now');
    await d.waitForTimeout(500); await d.screenshot({ path: `${RESULTS}/update-card-desktop.png` });
    await d.click('#updateGo');
    ok('“Restart now” restarts the app to install it', await d.evaluate(() => window.__installed === true));
    const errs = [...old.errors, ...fresh.errors, ...d.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
