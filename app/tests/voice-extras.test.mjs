/* Voice extras: the AFK channel (quiet or long-muted people are moved there and muted) and the Go Live preview
   (hover a LIVE badge to see a snapshot of someone's screen before joining). */
import { startServer, launchBrowser, signUp, joinVoice, RESULTS } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Poseidon');
    const b = await signUp(browser, srv.url, 'Bora');

    await a.click('#serverBtn'); await a.click('#mAfk');
    await a.selectOption('#afkSelect', { label: '🔊 Gaming' });
    await a.click('#afkSave');
    await a.waitForSelector('#voiceList .chan:has-text("Gaming") .chan-afk');
    ok('an admin can pick an AFK channel (it shows 💤)', await b.isVisible('#voiceList .chan:has-text("Gaming") .chan-afk'));

    await joinVoice(b);
    await b.evaluate(() => { window.PL_MUTED_MS = 4000; });
    await b.click('#micBtn');
    await b.waitForSelector('#afkBar:not([hidden]):has-text("Moving you to the AFK channel")');
    ok('a warning shows before moving you', true);
    await b.waitForSelector('#voiceList .chan:has-text("Gaming") + .members .member:has-text("Bora")', { timeout: 10000 });
    // (the note comes once the move is done: through the media server that's a moment after the list shows it)
    ok('muted too long: moved to the AFK channel instead of disconnected', await b.waitForSelector('.toast:has-text("moved to the AFK channel")', { timeout: 10000 }).then(() => true, () => false));

    // Go Live preview
    await joinVoice(a);
    await a.click('#shareBtn');
    await a.waitForSelector('#shareBtn.on', { timeout: 8000 });
    const live = '#voiceList .member:has-text("Poseidon"):has(.chan-live)';
    await b.waitForSelector(live);
    await b.waitForTimeout(3000);   // the first snapshot goes out 1.5 s after sharing starts
    await b.hover(live);
    await b.waitForSelector('#livePeek:not([hidden]) img[src^="data:image/jpeg"]', { timeout: 8000 });
    ok('hovering LIVE shows a snapshot of their screen before you join', (await b.textContent('#livePeekText')).includes('Poseidon is sharing'));
    await b.screenshot({ path: `${RESULTS}/live-peek.png` });

    const errs = [...a.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
