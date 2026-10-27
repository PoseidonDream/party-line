/* "New in Party Line", birthdays, custom emoji, stickers and saved GIFs. */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { startServer, launchBrowser, signUp, RESULTS } from './lib.mjs';

// Two tiny pictures (a red and a blue dot).
const RED = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const BLUE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

export default async function (ok) {
  const srv = await startServer({ BIRTHDAY_HOUR: '0' });
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Poseidon');
    const b = await signUp(browser, srv.url, 'Bora');

    // New in Party Line
    ok('new accounts don’t get the “New in Party Line” list', !(await a.isVisible('#newsDlg[open]')));
    const db = new DatabaseSync(path.join(srv.dataDir, 'party-line.db'));
    db.prepare("UPDATE users SET news_seen = 0 WHERE name = 'Bora'").run();
    db.close();
    await b.reload();
    await b.waitForSelector('#newsDlg[open] .news-list li');
    ok('after an update, friends see what’s new (newest first)', (await b.textContent('#newsList')).includes('Media gallery'));
    await b.screenshot({ path: `${RESULTS}/whats-new.png` });
    await b.click('#newsOk');
    await b.reload(); await b.waitForSelector('#room:not([hidden])'); await b.waitForTimeout(800);
    ok('and only once', !(await b.isVisible('#newsDlg[open]')));

    // Birthdays
    const now = new Date();
    await a.click('#setBtn'); await a.click('#settings [role="tab"][data-settab="profile"]');
    await a.selectOption('#setBdayMonth', String(now.getMonth() + 1));
    await a.selectOption('#setBdayDay', String(now.getDate()));
    await a.click('#setProfileSave');
    await a.keyboard.press('Escape');
    await b.waitForSelector('#messages .msg:has-text("Happy birthday")');
    ok('Party Bot says happy birthday in #general, mentioning them', await b.isVisible('#messages .msg:has-text("Happy birthday") .mention:has-text("@Poseidon")'));
    await a.fill('#chatInput', 'thank you!'); await a.keyboard.press('Enter');
    await b.waitForSelector('#messages .msg:has-text("thank you!")');
    ok('friends see a 🎂 next to their name', await b.isVisible('#messages .msg-name:has-text("Poseidon") .bday'));

    // Custom emoji and stickers
    await a.click('#serverBtn'); await a.click('#mEmoji');
    await a.waitForSelector('#emojiDlg[open]');
    await a.setInputFiles('#emojiFile', { name: 'Party Parrot.png', mimeType: 'image/png', buffer: RED });
    ok('the name is suggested from the file', (await a.inputValue('#emojiName')) === 'party_parrot');
    await a.click('#emojiAdd');
    await a.waitForSelector('#emojiList .emoji-item:has-text(":party_parrot:")');
    await a.selectOption('#emojiKind', 'sticker');
    await a.setInputFiles('#emojiFile', { name: 'wave.png', mimeType: 'image/png', buffer: BLUE });
    await a.click('#emojiAdd');
    await a.waitForSelector('#stickerList .emoji-item:has-text(":wave:")');
    ok('emoji and stickers can be added to a server', true);
    await a.keyboard.press('Escape');

    await b.fill('#chatInput', 'hello :party_parrot: friends'); await b.keyboard.press('Enter');
    await a.waitForSelector('#messages .msg:has-text("hello") img.c-emoji[alt=":party_parrot:"]');
    ok('typing :name: shows the custom emoji', true);
    await b.fill('#chatInput', ':party_parrot:'); await b.keyboard.press('Enter');
    await a.waitForSelector('#messages .msg-body.jumbo img.c-emoji');
    ok('an emoji on its own shows big', true);

    await b.click('#pickBtn');
    await b.click('[data-pick="sticker"]');
    await b.click('#pickBody button[title=":wave:"]');
    await a.waitForSelector('#messages .msg-sticker img[alt="Sticker :wave:"]');
    ok('stickers send from the 🙂 picker', await b.isHidden('#pickPop'));

    const hello = '#messages .msg:has-text("hello")';
    await a.locator(hello).hover();
    await a.click(`${hello} .msg-tool[aria-label="Add reaction"]`);
    await a.click('#emojiPop button[aria-label="React with :party_parrot:"]');
    await b.waitForSelector(`${hello} .reaction img.c-emoji`);
    ok('custom emoji work as reactions', (await b.textContent(`${hello} .reaction:has(img.c-emoji)`)).trim() === '1');

    // Saved GIFs
    await b.setInputFiles('#fileInput', { name: 'meme.png', mimeType: 'image/png', buffer: RED });
    await b.click('#chatForm button[type=submit]');
    await b.waitForSelector('#tray', { state: 'hidden' });
    const meme = '#messages .msg:has(.media-img[alt="meme.png"])';
    await a.waitForSelector(meme);
    await a.locator(meme).hover();
    await a.click(`${meme} .save-gif`);
    await a.waitForSelector(`${meme} .save-gif.on`);
    await a.click('#pickBtn'); await a.click('[data-pick="gif"]');
    await a.click('#pickBody .pick-grid.gifs button');
    await b.waitForSelector('#messages .msg-gif img');
    ok('pictures can be saved to “my GIFs” and sent again in one click', true);
    await b.screenshot({ path: `${RESULTS}/emoji-stickers.png` });

    const errs = [...a.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
