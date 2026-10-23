/* The developer panel: only for admins; server numbers, live voice numbers, the shared log, checking a friend. */
import { startServer, launchBrowser, signUp, joinVoice, RESULTS } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Poseidon');
    const b = await signUp(browser, srv.url, 'Bora');
    const c = await signUp(browser, srv.url, 'Cem');   // signs up, then leaves
    await c.context().close();
    await joinVoice(a); await joinVoice(b);
    await a.waitForSelector('#tiles .tile:has-text("Bora") .tile-sub:has-text("Connected")', { timeout: 15000 });

    await b.keyboard.press('Control+Shift+D');
    await b.click('#serverBtn');
    ok('friends don’t get the panel', !(await b.isVisible('#devPanel')) && await b.isHidden('#mDev'));
    await b.keyboard.press('Escape');

    await a.click('#serverBtn'); await a.click('#mDev');
    await a.waitForSelector('#devPanel .dev-card:has-text("Online now") b:text-is("2")');
    await a.waitForSelector('#devPanel .dev-chan:has-text("Lobby")');
    ok('Server tab shows who’s online and in voice', true);

    await a.click('#devPanel [data-tab="everyone"]');
    await a.waitForSelector('#devPanel .dev-table tr:has-text("Cem") td:has-text("just now")');
    await a.waitForSelector('#devPanel .dev-table tr:has-text("Bora") td:has-text("online now")');
    ok('Everyone tab lists people who signed up before, with when they were last online', true);
    await a.fill('#devPanel .dev-search', 'ce');
    ok('you can search it', (await a.locator('#devPanel .dev-table tbody tr').count()) === 1);
    await a.screenshot({ path: `${RESULTS}/dev-everyone.png` });

    await a.click('#devPanel [data-tab="voice"]');
    await a.waitForFunction(() => { const td = [...document.querySelectorAll('#devPanel .dev-table td')]; return td.some((x) => /^[1-9]\d* kbps$/.test(x.textContent)); }, null, { timeout: 8000 });
    ok('My voice tab shows live audio numbers for each friend', true);
    ok('it shows whether the path is direct', await a.isVisible('#devPanel .dev-table td:has-text("direct")'));
    await a.screenshot({ path: `${RESULTS}/dev-voice.png` });

    // something goes wrong on Bora's computer: their microphone stops
    await b.evaluate(async () => { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop()); });
    await b.evaluate(() => window.dispatchEvent(new ErrorEvent('error', { message: 'test error from Bora', filename: 'x.js', lineno: 7 })));
    await a.click('#devPanel [data-tab="log"]');
    await a.waitForSelector('#devPanel .dev-log li:has-text("test error from Bora") b:text-is("Bora")', { timeout: 8000 });
    ok('errors on a friend’s device show up in your log', true);

    await a.click('#devPanel [data-tab="people"]');
    await a.click('#devPanel .dev-chan:has-text("Bora") button');
    await a.waitForSelector('#devPanel .dev-chan:has-text("Bora") .dev-table td:has-text("Poseidon")', { timeout: 8000 });
    ok('checking a friend shows their live voice numbers', true);
    await b.waitForSelector('.toast:has-text("checked your voice connection")');
    ok('the friend is told you checked', true);
    await a.screenshot({ path: `${RESULTS}/dev-friend.png` });

    const errs = a.errors;
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
