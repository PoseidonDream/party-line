/* Watch party (/watch on the big screen), media gallery, game night planner, profile flair, quick switcher,
   saved messages and send later. */
import { startServer, launchBrowser, signUp, joinVoice, RESULTS } from './lib.mjs';
import { FAKE_YT } from './bot.test.mjs';

const RED = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

export default async function (ok) {
  const srv = await startServer({ POLL_MINUTE_MS: '200', LATER_TICK_MS: '400', LATER_MIN_MS: '0' });
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Poseidon');
    const b = await signUp(browser, srv.url, 'Bora');
    for (const p of [a, b]) await p.context().route('https://www.youtube.com/iframe_api', (r) => r.fulfill({ contentType: 'text/javascript', body: FAKE_YT }));
    const say = async (p, text) => { await p.fill('#chatInput', text); await p.keyboard.press('Enter'); };
    const req = (p, type, data) => p.evaluate(async ([t, d]) => { const { live } = await import('/js/net.js'); return live.req(t, d); }, [type, data]);

    // Watch party
    await joinVoice(a); await joinVoice(b);
    for (const p of [a, b]) await p.click('#textList .chan:has-text("general")');
    await say(a, '/watch https://youtu.be/dQw4w9WgXcQ');
    await b.waitForSelector('#messages .msg:has-text("Now showing")');
    await b.waitForSelector('#musicCard.big:not([hidden])');
    ok('/watch opens the video on the big screen for everyone', await a.isVisible('#musicCard.big'));
    await b.click('#musicBig');
    ok('anyone can shrink it back for themselves', await b.isVisible('#musicCard:not(.big)') && await a.isVisible('#musicCard.big'));
    await a.click('#musicStop');
    await b.waitForSelector('#musicCard', { state: 'hidden' });
    await a.click('#vcLeaveBtn'); await b.click('#vcLeaveBtn');

    // Media gallery
    await b.setInputFiles('#fileInput', [{ name: 'sunset.png', mimeType: 'image/png', buffer: RED }, { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') }]);
    await b.click('#chatForm button[type=submit]');
    await b.waitForSelector('#tray', { state: 'hidden' });
    await a.waitForSelector('#messages .msg:has(.media-img[alt="sunset.png"])');
    await a.click('#galleryBtn');
    await a.waitForSelector('#galleryDlg[open] .gal-cell img[alt="sunset.png"]');
    ok('Media shows every photo shared in the chat', true);
    await a.click('#galleryDlg [data-gal="files"]');
    await a.waitForSelector('#galFiles .gal-file:has-text("notes.txt")');
    ok('and files in their own tab', true);
    await a.click('#galleryDlg [data-gal="media"]');
    await a.click('#galGrid .gal-open');
    await a.waitForSelector('#lightbox:not([hidden]) #lbImg[src*="/uploads/"]');
    ok('a photo opens big', true);
    await a.click('#lbClose');
    await a.waitForSelector('#galleryDlg[open]');
    ok('closing it goes back to the gallery', true);
    await a.keyboard.press('Escape');

    // Profile flair
    await a.click('#setBtn'); await a.click('#settings [role="tab"][data-settab="profile"]');
    await a.click('#setFlair .flair-opt[title="Rainbow"]');
    await a.click('.fx-pick .theme-opt:has-text("Stars")');
    await a.fill('#setFavGames', 'Valorant, Peak, Valorant, Minecraft');
    await a.click('#setProfileSave');
    await a.waitForSelector('.toast:has-text("Profile saved")');
    await a.keyboard.press('Escape');
    await say(a, 'look at my ring');
    await b.waitForSelector('#messages .msg:has-text("look at my ring") .mini-av.flair-rainbow');
    ok('a picture ring shows on your messages for everyone', true);
    await b.click('#messages .msg:has-text("look at my ring") .mini-av');
    await b.waitForSelector('#userPop:not([hidden]) #popBanner.fx-stars');
    const chips = await b.locator('#popGames .game-chip').allTextContents();
    ok('the profile shows the banner effect and favorite games (no duplicates)', chips.join('|') === '🎮 Valorant|🎮 Peak|🎮 Minecraft');
    await b.screenshot({ path: `${RESULTS}/flair.png` });
    await b.keyboard.press('Escape'); await b.mouse.click(700, 300);

    // Game night planner
    await a.click('#gamesBtn');
    await say(a, '/game Lethal Company'); await say(b, '/game Peak');
    await a.click('#gamesPlan');
    await a.waitForSelector('#eventsDlg[open] #evForm:not([hidden])');
    ok('“Plan game night” opens a prefilled event with a game vote', (await a.inputValue('#evName')) === 'Game night' && (await a.inputValue('#evVote')) === '30');
    await a.click('#evCancelForm'); await a.keyboard.press('Escape');
    const startsAt = Date.now() + 8000;   // in this test a "minute" is 200 ms: the vote opens 3 s before
    await req(a, 'event.create', { serverId: 1, title: 'Friday game night', startsAt, gameVote: 15, textChannelId: await a.evaluate(() => Number(document.querySelector('#textList .chan[aria-current="true"]').closest('li').dataset.cid)) });
    await b.click('#railList .rail-btn').catch(() => {});
    await b.waitForSelector('#messages .msg:has-text("What do we play tonight?"):has-text("Friday game night")', { timeout: 15000 });
    ok('before game night starts, Party Bot opens the game vote, mentioning who’s going', await b.isVisible('#messages .msg:has-text("Friday game night") .mention:has-text("@Poseidon")'));

    // Quick switcher
    await a.keyboard.press('Control+p');
    await a.waitForSelector('#jumpDlg[open]');
    await a.keyboard.type('game');
    await a.keyboard.press('Enter');
    await a.waitForSelector('#viewTitle:text-is("game-night")');
    ok('Ctrl+P jumps to a channel by typing part of its name', true);
    await a.keyboard.press('Control+p'); await a.keyboard.type('bor'); await a.keyboard.press('Enter');
    await a.waitForSelector('#chatInput[placeholder*="Bora"]');
    ok('and to a friend’s private chat', true);

    // Saved messages
    await a.click('#railList .rail-btn'); await a.click('#textList .chan:has-text("general")');
    const msg = '#messages .msg:has-text("look at my ring")';
    await a.locator(msg).hover();
    await a.click(`${msg} .msg-tool[aria-label^="Save for later"]`);
    await a.waitForSelector(`${msg} .msg-tool.on[aria-label^="Remove from saved"]`);
    await a.click('#railHome'); await a.click('#navSaved');
    await a.waitForSelector('#searchResults .search-hit:has-text("look at my ring")');
    ok('saved messages are listed under Home → Saved messages', true);
    await a.click('#searchResults .search-hit:has-text("look at my ring")');
    await a.waitForSelector('#viewTitle:text-is("general")');
    ok('clicking one jumps to it', true);

    // Send later
    await a.fill('#chatInput', 'pizza is here!');
    await a.click('#laterBtn');
    await a.click('#laterPresets .btn:has-text("In 1 hour")');
    await a.waitForSelector('#laterBar li:has-text("pizza is here!")');
    ok('a scheduled message waits above the message box (only you see it)', (await a.inputValue('#chatInput')) === '' && await b.locator('#laterBar li').count() === 0);
    await a.click('#laterBar li:has-text("pizza is here!") .reply-x');
    await a.waitForSelector('#laterBar', { state: 'hidden' });
    ok('it can be cancelled', true);
    const general = await a.evaluate(() => Number(document.querySelector('#textList .chan[aria-current="true"]').closest('li').dataset.cid));
    await req(a, 'later.add', { channelId: general, body: 'sent by the clock', sendAt: Date.now() + 1200 });
    await b.click('#textList .chan:has-text("general")');
    await b.waitForSelector('#messages .msg:has-text("sent by the clock")', { timeout: 8000 });
    ok('at the chosen time it’s sent as you', await b.isVisible('#messages .msg:has-text("sent by the clock") .msg-name:has-text("Poseidon")'));

    const errs = [...a.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
