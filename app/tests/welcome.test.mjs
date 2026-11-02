/* The welcome page at the server's address: a download for this device first (Windows, Mac, Linux, Android, or the
   browser on iPhone), "Open Party Line in your browser" and "Sign in" into the app at /app, downloads that always
   fetch the newest release, signed-in people and the desktop/Android apps going straight to the app, in the
   visitor's language, and fitting a phone. */
import http from 'node:http';
import path from 'node:path';
import { startServer, launchBrowser, signUp, RESULTS } from './lib.mjs';

const UA = {
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  electron: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) PartyLine/1.2.4 Chrome/140.0.0.0 Electron/45.2.1 Safari/537.36',
  androidApp: 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36',
};
const GH = 'https://github.com/PoseidonDream/party-line/releases/download/v9.9.9/';

export default async function (ok) {
  // A stand-in for GitHub's "newest release" answer (no .deb in it)
  const gh = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ tag_name: 'v9.9.9', assets: [
      { name: 'Party-Line-9.9.9-win-x64.exe', size: 82_000_000, browser_download_url: `${GH}Party-Line-9.9.9-win-x64.exe` },
      { name: 'Party-Line-9.9.9-mac-universal.dmg', size: 180_000_000, browser_download_url: `${GH}Party-Line-9.9.9-mac-universal.dmg` },
      { name: 'Party-Line-9.9.9-linux-x86_64.AppImage', size: 108_000_000, browser_download_url: `${GH}Party-Line-9.9.9-linux-x86_64.AppImage` },
      { name: 'Party-Line-android.apk', size: 3_200_000, browser_download_url: `${GH}Party-Line-android.apk` },
      { name: 'latest.yml', size: 300, browser_download_url: `${GH}latest.yml` },
    ] }));
  });
  await new Promise((r) => gh.listen(0, '127.0.0.1', r));
  const srv = await startServer({ RELEASES_API: `http://127.0.0.1:${gh.address().port}/latest` });
  const browser = await launchBrowser();
  const errors = [];
  const visit = async (ua, opts = {}) => {
    const ctx = await browser.newContext({ userAgent: ua, viewport: { width: 1440, height: 900 }, ...opts });
    const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(srv.url); return p;
  };
  try {
    // What the address shows
    const html = async (ua) => (await fetch(srv.url, { headers: { 'user-agent': ua } })).text();
    ok('a browser opening the server’s address gets the welcome page', (await html(UA.windows)).includes('id="get"'));
    ok('…the desktop and Android apps get the app itself', (await html(UA.electron)).includes('id="join"') && (await html(UA.androidApp)).includes('id="join"'));

    // A download for this device first
    const first = async (ua, opts) => { const p = await visit(ua, opts); await p.waitForSelector('.pk.rec'); const r = await p.evaluate(() => { const c = document.querySelector('#get .pk'); return { os: c.dataset.os, rec: c.classList.contains('rec'), note: getComputedStyle(c.querySelector('.rec-note')).display !== 'none', ios: getComputedStyle(c.querySelector('.ios-note') || document.body).display !== 'none' && !!c.querySelector('.ios-note') }; }); return { p, ...r }; };
    const win = await first(UA.windows);
    ok('on Windows, the Windows download comes first, highlighted and “Recommended for this device”', win.os === 'windows' && win.rec && win.note && await win.p.isVisible('.pk.rec .btn.lamp:has-text("Download")'));
    await win.p.screenshot({ path: path.join(RESULTS, 'welcome-windows.png') });
    ok('on a Mac, the Mac download', (await first(UA.mac)).os === 'mac');
    ok('on Linux, the Linux download', (await first(UA.linux)).os === 'linux');
    const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
    const and = await first(UA.android, phone);
    ok('on an Android phone, the Android app', and.os === 'android');
    const ios = await first(UA.iphone, phone);
    ok('on an iPhone (no app there), the browser, with how to add it to the Home Screen', ios.os === 'browser' && ios.ios);
    const fits = await and.p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
    await and.p.screenshot({ path: path.join(RESULTS, 'welcome-phone.png'), fullPage: true });
    ok('…and the page fits a phone screen (no sideways scrolling)', fits);
    await win.p.waitForSelector('#ver:not([hidden])');
    ok('the newest version’s number is shown', (await win.p.textContent('#ver')) === 'Version 9.9.9');

    // Downloads
    const where = async (what) => { const r = await fetch(`${srv.url}/download/${what}`, { redirect: 'manual' }); return [r.status, r.headers.get('location')]; };
    ok('“Download” for Windows fetches the newest Windows installer', String(await where('windows')) === `302,${GH}Party-Line-9.9.9-win-x64.exe`);
    ok('…and the Mac, Linux and Android ones', (await where('mac'))[1].endsWith('.dmg') && (await where('linux'))[1].endsWith('.AppImage') && (await where('android'))[1].endsWith('android.apk'));
    ok('…one the newest release doesn’t have opens the releases page instead', (await where('deb'))[1] === 'https://github.com/PoseidonDream/party-line/releases/latest');
    ok('…and an unknown one is “not found”', (await where('nonsense'))[0] === 404);

    // Into the app
    await win.p.click('#openBrowser');
    await win.p.waitForSelector('#join:not([hidden])');
    ok('“Open Party Line in your browser” opens the app at /app, ready to make an account', new URL(win.p.url()).pathname === '/app' && (await win.p.getAttribute('#tabRegister', 'aria-selected')) === 'true');
    await win.p.goto(srv.url); await win.p.click('.hero .btn.ghost:has-text("Sign in")');
    await win.p.waitForSelector('#join:not([hidden])');
    ok('“Sign in” opens the app on the Sign in tab (and the address stays tidy)', (await win.p.getAttribute('#tabLogin', 'aria-selected')) === 'true' && new URL(win.p.url()).search === '');

    // Signed in already
    const me = await signUp(browser, srv.url, 'Deniz');
    await me.goto(`${srv.url}/?friends=1`);
    await me.waitForSelector('#room:not([hidden])');
    ok('someone signed in on this device goes straight from the address to the app', new URL(me.url()).pathname === '/app');

    // Language
    const tr = await visit(UA.windows, { locale: 'tr-TR' });
    await tr.waitForFunction(() => document.querySelector('h1').textContent.includes('Bağlan'));
    ok('the page speaks the visitor’s language (Turkish here), with a language picker', (await tr.textContent('#openBrowser')).includes('tarayıcında') && (await tr.inputValue('#lang')) === 'tr');
    await tr.selectOption('#lang', 'de');
    await tr.waitForFunction(() => document.querySelector('#openBrowser').textContent.includes('Browser öffnen'));
    ok('…and switching it changes the page at once', true);

    ok(`no JavaScript errors${errors.length ? ': ' + errors.join(' | ') : ''}`, !errors.length && !me.errors.length);
  } finally { await browser.close(); await srv.stop(); gh.close(); }
}
