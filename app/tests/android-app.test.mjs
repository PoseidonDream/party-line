/* The Android app (Google Play build): the page loads inside the app with Capacitor's real bridge script, not a
   stand-in, so a call the bridge doesn't have would show up here as the app being stuck on "Connecting…". */
import { startServer, launchBrowser, androidContext, openDb } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer({ CSP_TEST_EVAL: '' });   // the page's safety rules exactly as on a real server
  const browser = await launchBrowser();
  try {
    const ctx = await androidContext(browser, srv.url, { getVersion: { code: 20, name: '1.0.20', fromPlay: true } });
    const p = await ctx.newPage();
    p.errors = [];
    p.on('pageerror', (e) => p.errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy/.test(m.text())) p.errors.push(m.text()); });
    await p.goto(srv.url);
    await p.waitForSelector('#join:not([hidden])', { timeout: 8000 });
    ok('the app opens on the sign-in screen (not stuck on “Connecting…”)', await p.isHidden('#booting'));

    await p.click('#tabRegister'); await p.fill('#authName', 'Phone'); await p.fill('#authPass', 'pass1234');
    await p.check('#authAgree'); await p.click('#authBtn');
    await p.waitForSelector('#room:not([hidden])', { timeout: 10000 });
    ok('making an account in the app gets you in', true);
    const db = openDb(srv);
    const device = db.prepare('SELECT device FROM sessions ORDER BY created_at DESC LIMIT 1').get().device;
    db.close();
    ok('the app reports its build through the bridge (“Android app build 20”)', device === 'Android app build 20', device);

    await p.tap('#drawerBtn');
    await p.tap('#voiceList .chan:has-text("Lobby")');
    await p.waitForSelector('#voiceStatus:not([hidden])', { timeout: 10000 });
    for (let i = 0; i < 50 && !(await p.evaluate(() => window.__native.some((c) => c.method === 'setInCall' && c.options.inCall))); i++) await p.waitForTimeout(100);
    const inCall = await p.evaluate(() => window.__native.filter((c) => c.method === 'setInCall').map((c) => c.options));
    ok('joining voice starts the “In voice” notification that keeps voice running in the background', inCall.some((o) => o.inCall === true && /Lobby/.test(o.title)));
    await p.click('#vcLeaveBtn');
    await p.waitForTimeout(500);
    const after = await p.evaluate(() => window.__native.filter((c) => c.method === 'setInCall').map((c) => c.options));
    ok('…and leaving voice ends it', after.length > inCall.length && after[after.length - 1].inCall === false);

    await p.waitForTimeout(5500);   // the update check runs 5 seconds after opening
    ok('installed from Google Play: no “new version” card (Play updates it)', await p.isHidden('#updateBar'));
    ok(`no JavaScript errors${p.errors.length ? ': ' + p.errors.join(' | ') : ''}`, !p.errors.length);
  } finally { await browser.close(); await srv.stop(); }
}
