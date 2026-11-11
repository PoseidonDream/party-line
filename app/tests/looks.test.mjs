/* Looks: Settings → Look offers Classic (the app as it was), Paper and Arcade. The choice is this device's own, is
   there before the page draws (also on the loading and sign-in screens), and works together with Dark/Light and
   the accent colour. Paper's serif typeface is only fetched by people who choose Paper. (Text contrast in every
   look, dark and light, is checked in a11y.test.mjs.) */
import { startServer, launchBrowser, signUp } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const p = await signUp(browser, srv.url, 'Deniz');
    const serif = []; p.on('request', (r) => { if (/\/fonts\/charis-sil/.test(r.url())) serif.push(r.url()); });
    const look = () => p.evaluate(() => {
      const root = document.documentElement, cs = (sel) => getComputedStyle(document.querySelector(sel));
      return { attr: root.dataset.look || null, bg: getComputedStyle(document.body).backgroundColor, side: cs('.side').backgroundColor, head: cs('.server-btn').fontFamily.split(',')[0].replace(/"/g, ''),
        lamp: getComputedStyle(root).getPropertyValue('--lamp').trim(), bar: document.querySelector('meta[name="theme-color"]').content, saved: (JSON.parse(localStorage.getItem('pl:settings')) || {}).look };
    });
    const pick = async (name, value) => { await p.click(`.${name}-opt:has(input[value="${value}"])`); await p.waitForTimeout(150); };
    await p.waitForTimeout(600);
    ok('nobody fetches the Paper typeface before choosing Paper', serif.length === 0);

    await p.click('#setBtn'); await p.click('#settings [data-settab="look"]');
    const choices = await p.evaluate(() => [...document.querySelectorAll('input[name="look"]')].map((r) => `${r.value}${r.checked ? '*' : ''}`).join(' '));
    ok(`Settings → Look offers three looks, Classic first and chosen (${choices})`, choices === 'classic* paper arcade');
    const classic = await look();

    await pick('look', 'paper');
    const paper = await look();
    ok(`choosing Paper changes the app at once: warm paper colours and a serif for headings (${paper.head})`, paper.attr === 'paper' && paper.bg === 'rgb(28, 25, 21)' && paper.bg !== classic.bg && paper.head === 'Charis SIL' && paper.saved === 'paper');
    await pick('theme', 'light');
    const paperLight = await look();
    ok('…and Dark/Light still works inside the look (Paper by day is cream)', paperLight.bg === 'rgb(247, 242, 232)' && paperLight.side === 'rgb(240, 233, 219)');
    ok('…the phone’s status bar takes the page’s colour', paperLight.bar === '#f7f2e8');
    await p.waitForFunction(() => document.fonts.check('700 20px "Charis SIL"'), null, { timeout: 10000 }).catch(() => {});
    ok(`…and now the Paper typeface is fetched from this server (${serif.length} file${serif.length === 1 ? '' : 's'})`, serif.length > 0 && serif.every((u) => u.startsWith(srv.url)));

    await pick('accent', 'cyan');
    const cyan = await look();
    await pick('accent', 'amber');
    const own = await look();
    ok(`the accent colour still works in a look (cyan ${cyan.lamp}), and the first colour is the look’s own (${own.lamp})`, cyan.lamp === '#06b6d4' && own.lamp === '#b84a31');

    await pick('look', 'arcade');
    const arcade = await look();
    ok(`Arcade: blocks of colour and chunky type (${arcade.head})`, arcade.attr === 'arcade' && arcade.side === 'rgb(255, 217, 59)' && arcade.head === 'JetBrains Mono' && arcade.saved === 'arcade');
    await pick('theme', 'dark');
    const night = await look();
    ok('…with a dark side too', night.bg === 'rgb(29, 26, 44)' && night.side === 'rgb(58, 42, 138)');

    // Before the page draws: reload with the app's code held back
    let release; const held = new Promise((r) => { release = r; });
    await p.route('**/js/main.js', async (route) => { await held; route.continue(); });
    await p.reload({ waitUntil: 'commit' });
    await p.waitForSelector('#booting .boot-mark');
    const early = await p.evaluate(() => ({ attr: document.documentElement.dataset.look, bg: getComputedStyle(document.querySelector('#booting')).backgroundColor }));
    ok('the look is there before the app’s code has arrived (the loading screen wears it)', early.attr === 'arcade' && early.bg === 'rgb(29, 26, 44)');
    release(); await p.unroute('**/js/main.js');
    await p.waitForSelector('#room:not([hidden])');

    await p.click('#setBtn'); await p.click('#settings [data-settab="look"]');
    await pick('look', 'classic'); await pick('theme', 'dark');
    const back = await look();
    ok('Classic brings the app back exactly as it was', back.attr === null && back.bg === classic.bg && back.side === classic.side && back.head === classic.head && back.lamp === classic.lamp);

    // The sign-in screen keeps this device's look
    await pick('look', 'paper'); await pick('theme', 'light');
    await p.click('#settings [data-settab="account"]'); await p.click('#signOut');
    await p.waitForSelector('#join:not([hidden])');
    const join = await p.evaluate(() => ({ attr: document.documentElement.dataset.look, word: getComputedStyle(document.querySelector('.wordmark')).fontFamily.split(',')[0].replace(/"/g, ''), bg: getComputedStyle(document.body).backgroundColor }));
    ok('after signing out, the sign-in screen keeps this device’s look', join.attr === 'paper' && join.word === 'Charis SIL' && join.bg === 'rgb(247, 242, 232)');

    ok(`no JavaScript errors${p.errors.length ? ': ' + p.errors.join(' | ') : ''}`, !p.errors.length);
  } finally { await browser.close(); await srv.stop(); }
}
