/* Status (online, idle, do not disturb, invisible), custom status, About me and banner, and "Playing …" from
   the desktop app. */
import { startServer, launchBrowser, signUp, RESULTS } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    // Poseidon uses a stand-in for the desktop app (to report a game) and goes idle after 1.5 s untouched.
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone'] });
    await ctx.addInitScript(() => {
      window.PL_IDLE_MS = 1500;
      let report = null;
      window.partyLineDesktop = { version: 'test', setBadge() {}, focus() {}, onPtt() {}, setTheme() {}, onActivity(cb) { report = cb; } };
      window.__playing = (name) => report && report(name);
    });
    const a = await ctx.newPage();
    a.errors = []; a.on('pageerror', (e) => a.errors.push(e.message));
    await a.goto(srv.url);
    await a.click('#tabRegister'); await a.fill('#authName', 'Poseidon'); await a.fill('#authPass', 'pass1234'); await a.fill('#authGroup', 'test');
    await a.click('#authBtn'); await a.waitForSelector('#room:not([hidden])');
    const b = await signUp(browser, srv.url, 'Bora');

    await a.fill('#chatInput', 'hello'); await a.keyboard.press('Enter');
    const pop = async (state) => {
      if (await b.isHidden('#userPop')) await b.click('#messages .msg:has-text("hello") .mini-av');
      await b.waitForSelector(`#popDot.${state}`, { timeout: 25000 });
    };
    await a.mouse.move(100, 100);
    await pop('online');
    ok('a friend’s status shows in their profile', (await b.textContent('#popPresence')).includes('Online'));

    await a.mouse.move(5, 5);
    await a.waitForTimeout(500);
    await pop('idle');   // untouched for 1.5 s
    ok('untouched for a while: Idle by itself', (await b.textContent('#popPresence')).includes('Idle'));
    await a.mouse.click(640, 400);
    await pop('online');
    ok('using the app again: back to Online', true);

    await a.click('#statusBtn');
    await a.click('#statusPop [data-status="dnd"]');
    await pop('dnd');
    ok('Do not disturb shows for friends and on your own picture', await a.isVisible('#meDot.dnd'));
    await a.click('#statusBtn');
    await a.fill('#customInput', 'studying 📚'); await a.click('#customForm button[type=submit]');
    await b.waitForSelector('#popCustom:not([hidden]):has-text("studying 📚")');
    ok('custom status shows in the profile and under your name', (await a.textContent('#meStatus')).includes('studying'));

    await a.evaluate(() => window.__playing('VALORANT'));
    await b.waitForSelector('#popActivity:not([hidden]):has-text("Playing VALORANT")');
    ok('the desktop app’s game shows as “Playing …”', true);
    await a.evaluate(() => window.__playing(null));
    await b.waitForSelector('#popActivity', { state: 'hidden' });

    await a.click('#setBtn');
    await a.fill('#setBio', 'Plays support. Pizza > burgers.');
    await a.click('#setBanner .swatch[title="#3d7be8"]');
    await a.click('#setProfileSave');
    await a.waitForSelector('.toast:has-text("Profile saved")');
    await a.keyboard.press('Escape');
    await b.waitForSelector('#popBioBox:not([hidden]):has-text("Pizza > burgers")');
    ok('About me and banner color show in the profile', (await b.evaluate(() => getComputedStyle(document.querySelector('#popBanner')).backgroundColor)) === 'rgb(61, 123, 232)');
    await b.screenshot({ path: `${RESULTS}/status-profile.png` });

    await a.click('#statusBtn');
    await a.click('#statusPop [data-status="invisible"]');
    await pop('offline');
    ok('Invisible looks offline to friends', (await b.textContent('#popPresence')).includes('Offline') && await a.isVisible('#room'));
    await a.click('#statusBtn');
    await a.click('#statusPop [data-status="online"]');
    await pop('online');

    const errs = [...a.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
