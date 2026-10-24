/* The Android app's update banner: shown when GitHub's newest release has a newer build than the app,
   not shown when the app is up to date, and "Later" hides it for that build. */
import { startServer, launchBrowser } from './lib.mjs';

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
    const errs = [...old.errors, ...fresh.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
