/* Movement: the loading screen (the name, with a light running along a row of switchboard jacks) while the app
   starts, fading into the app instead of vanishing; and the welcome page's arrivals: the headline, the downloads,
   and the screenshot and feature cards rising into view as you scroll to them. With "reduce motion" on, none of it
   moves and nothing is ever hidden waiting for an animation. */
import { startServer, launchBrowser } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    // ---- the loading screen ----
    const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    p.errors = []; p.on('pageerror', (e) => p.errors.push(e.message));
    let release; const held = new Promise((r) => { release = r; });
    await p.route('**/js/main.js', async (route) => { await held; route.continue(); });   // the app's code is slow to arrive
    await p.goto(srv.url + '/app', { waitUntil: 'commit' });
    await p.waitForSelector('#booting .boot-mark');
    const boot = await p.evaluate(() => ({
      name: document.querySelector('.boot-mark').textContent.replace(/\s+/g, ' ').trim(),
      lamps: document.querySelectorAll('.boot-jacks .jack').length,
      moving: document.querySelector('#booting').getAnimations({ subtree: true }).filter((a) => a.animationName === 'boot-lamp').length,
      text: document.querySelector('#bootText').textContent,
      covers: getComputedStyle(document.querySelector('#booting')).backgroundColor === getComputedStyle(document.body).backgroundColor,
    }));
    ok(`while the app loads: the name, ${boot.lamps} switchboard lamps lighting up one after the other, and “Connecting…”`, boot.name === 'Party Line' && boot.lamps === 5 && boot.moving === 5 && boot.text === 'Connecting…' && boot.covers);
    release();
    await p.waitForSelector('#join:not([hidden])');
    const fading = await p.evaluate(() => { const b = document.querySelector('#booting'); return b.hidden && b.getAnimations().some((a) => a.animationName === 'boot-out'); });
    await p.waitForSelector('#booting', { state: 'hidden', timeout: 3000 });
    ok('when the app is ready, the loading screen fades into it', fading);
    await p.click('#tabRegister');   // (it's out of the way at once: clicks go to the app underneath)
    await p.waitForFunction(() => document.querySelector('#booting').classList.contains('gone'), null, { timeout: 3000 });
    ok('…and is then taken out of the page (its lamps don’t keep running behind the app)', await p.evaluate(() => getComputedStyle(document.querySelector('#booting')).display === 'none'));
    await p.fill('#authName', 'Deniz'); await p.fill('#authPass', 'pass1234'); await p.check('#authAgree'); await p.click('#authBtn');
    await p.waitForSelector('#room:not([hidden])', { timeout: 10000 });
    await p.waitForSelector('#booting', { state: 'hidden', timeout: 3000 });
    ok('signing in shows it again while connecting, then the app', true);

    // ---- the welcome page ----
    const w = await (await browser.newContext({ viewport: { width: 1280, height: 700 } })).newPage();
    w.errors = []; w.on('pageerror', (e) => w.errors.push(e.message));
    await w.goto(srv.url + '/');
    await w.waitForSelector('.pk.rec');
    const hero = await w.evaluate(() => ({
      anim: document.documentElement.classList.contains('anim'),
      words: [...document.querySelectorAll('h1 .w')].map((el) => getComputedStyle(el).animationName.split(',')[0]),
      lamp: getComputedStyle(document.querySelector('h1 .lit')).animationName.includes('lamp-on'),
      cards: [...document.querySelectorAll('.pk')].every((el) => getComputedStyle(el).animationName.includes('up-in')),
      waiting: [...document.querySelectorAll('.feat')].every((el) => el.classList.contains('rv') && !el.classList.contains('in')),   // (told apart by their marks, not by how they look: on a very slow machine the page's safety net shows everything after 6 s)
    }));
    ok('the welcome page arrives: the headline word by word (“Talk.” lights up like a lamp), then the downloads', hero.anim && hero.words.length === 3 && hero.words.every((n) => n === 'up-in') && hero.lamp && hero.cards);
    ok('the feature cards wait below, out of sight', hero.waiting);
    const lit = () => w.evaluate(() => [...document.querySelectorAll('.jacks i')].map((i) => (i.classList.contains('on') ? 1 : 0)).join(''));
    const before = await lit(); await w.waitForFunction((b) => [...document.querySelectorAll('.jacks i')].map((i) => (i.classList.contains('on') ? 1 : 0)).join('') !== b, before, { timeout: 5000 });
    ok('the lamps on the little switchboard blink', true);
    await w.evaluate(() => document.querySelector('.feats').scrollIntoView({ behavior: 'instant', block: 'center' }));
    await w.waitForFunction(() => [...document.querySelectorAll('.feat')].every((el) => el.classList.contains('in') && getComputedStyle(el).opacity === '1'), null, { timeout: 5000 });
    ok('…and rise into view when you scroll to them', true);
    await w.waitForFunction(() => getComputedStyle(document.querySelector('h1 .lit')).color === 'rgb(255, 173, 31)');
    ok('nothing makes the page scroll sideways', await w.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

    // ---- "reduce motion" ----
    const calm = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1280, height: 700 } });
    const q = await calm.newPage();
    await q.goto(srv.url + '/'); await q.waitForSelector('.pk.rec');
    const still = await q.evaluate(() => ({ anim: document.documentElement.classList.contains('anim'), running: document.getAnimations().length, shown: [...document.querySelectorAll('.feat, .preview, h1 .w, .pk')].every((el) => getComputedStyle(el).opacity === '1') }));
    ok('with “reduce motion” on, the welcome page is simply all there (nothing moves, nothing waits hidden)', !still.anim && still.running === 0 && still.shown);
    const r = await calm.newPage();
    await r.goto(srv.url + '/app'); await r.waitForSelector('#join:not([hidden])');
    ok('…and the loading screen doesn’t fade: it’s gone at once', await r.isHidden('#booting') && await r.evaluate(() => document.getAnimations().length === 0));

    const errs = [...p.errors, ...w.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
