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

    // Three ways to start watching
    await b.evaluate(() => { window.PL_MUTED_MS = 3_600_000; });
    await b.click(`${live} .chan-live`);
    await b.waitForSelector('#stage:not([hidden])', { timeout: 10000 });
    await b.waitForFunction(() => document.querySelector('#stageVideo').videoWidth > 0, null, { timeout: 15000 });
    ok('clicking LIVE in the channel list takes you into their channel and shows their screen', (await b.textContent('#stageTitle')).includes('Poseidon'));
    await b.click('#stageClose');
    await b.click('#tiles .tile.is-live:has-text("Poseidon")');
    await b.waitForSelector('#stage:not([hidden])');
    ok('clicking the bubble of whoever is live opens their screen', true);
    await b.click('#vcLeaveBtn');
    await b.waitForSelector('#voiceStatus', { state: 'hidden' });
    await b.click('#voiceList .chan:has-text("Lobby")');
    await b.waitForSelector('#stage:not([hidden])', { timeout: 10000 });
    await b.waitForFunction(() => document.querySelector('#stageVideo').videoWidth > 0, null, { timeout: 15000 });
    ok('clicking a voice channel where someone is live joins it and opens the stream right away', true);
    await b.click('#stageClose');
    await b.click('#voiceList .member:has-text("Poseidon")');
    await b.click('#popWatch');
    await b.waitForSelector('#stage:not([hidden])');
    ok('their profile card has “Watch screen” while they share', true);
    await b.click('#stageClose');
    await a.click('#shareBtn'); await a.waitForSelector('#shareBtn:not(.on)');
    await a.click('#shareBtn'); await a.waitForSelector('#shareBtn.on', { timeout: 8000 });
    await b.click('.toast:has-text("Poseidon is sharing their screen") button:has-text("Watch")', { timeout: 10000 });
    await b.waitForSelector('#stage:not([hidden])');
    ok('when someone in your channel starts sharing, a note offers to watch it', true);

    const errs = [...a.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
