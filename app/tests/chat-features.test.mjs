/* Discord-style chat extras: @mentions, replies, reactions, "typing…" and search. */
import { startServer, launchBrowser, signUp, RESULTS } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer({ MSG_BURST: '500' });   // it types 60 messages in a row
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Poseidon');
    const b = await signUp(browser, srv.url, 'Deniz Can');

    // typing indicator
    await a.type('#chatInput', 'hel');
    await b.waitForSelector('#typingLine:has-text("Poseidon is typing")', { timeout: 5000 });
    ok('"is typing…" shows for others', true);
    await a.fill('#chatInput', '');

    // mention autocomplete, a name with a space
    await a.click('#railHome'); await a.click('#railList .rail-btn');   // Deniz switches away so the mention counts as unread
    await b.click('#railHome');
    await a.type('#chatInput', 'hey @den');
    await a.waitForSelector('#mentionPop:not([hidden]) li:has-text("Deniz Can")');
    ok('typing @ suggests people', true);
    await a.press('#chatInput', 'Enter');
    const picked = await a.inputValue('#chatInput');
    ok(`picking a suggestion fills in the name (${JSON.stringify(picked)})`, picked === 'hey @Deniz Can ');
    await a.type('#chatInput', 'look at this');
    await a.press('#chatInput', 'Enter');
    await a.waitForSelector('.msg .mention:has-text("@Deniz Can")');
    ok('the mention shows as a highlighted name', true);
    await b.waitForSelector('#railList .rail-badge:has-text("1")', { timeout: 5000 });
    ok('the mentioned person gets a badge on the server', true);
    await b.click('#railList .rail-btn');
    await b.waitForSelector('.msg.mentioned:has-text("look at this")');
    ok('their message is highlighted for them', true);

    // reply
    await b.hover('.msg:has-text("look at this")');
    await b.click('.msg:has-text("look at this") .msg-tool[title="Reply"]');
    await b.waitForSelector('#replyBar:not([hidden]):has-text("Replying to Poseidon")');
    await b.fill('#chatInput', 'nice one');
    await b.press('#chatInput', 'Enter');
    await a.waitForSelector('.msg.has-reply:has-text("nice one") .msg-reply:has-text("Poseidon")');
    ok('replies show what they answer', true);
    ok('the reply bar closes after sending', await b.isHidden('#replyBar'));

    // reactions
    await a.hover('.msg:has-text("nice one")');
    await a.click('.msg:has-text("nice one") .msg-tool[title="Add reaction"]');
    await a.click('#emojiPop button:has-text("🔥")');
    await b.waitForSelector('.msg:has-text("nice one") .reaction:has-text("🔥 1")');
    ok('reactions appear for everyone', true);
    await b.click('.msg:has-text("nice one") .reaction:has-text("🔥")');
    await a.waitForSelector('.msg:has-text("nice one") .reaction:has-text("🔥 2")');
    ok('clicking a reaction adds yours', true);
    await b.click('.msg:has-text("nice one") .reaction:has-text("🔥")');
    await a.waitForSelector('.msg:has-text("nice one") .reaction:has-text("🔥 1")');
    ok('clicking again takes it back', true);

    // reactions and replies survive a reload
    await a.reload();
    await a.waitForSelector('.msg.has-reply:has-text("nice one") .reaction:has-text("🔥 1")');
    ok('replies and reactions are saved', true);

    // search, then jump to an older message
    await a.fill('#chatInput', 'the secret word is banana'); await a.press('#chatInput', 'Enter');
    await a.waitForSelector('.msg-body:has-text("banana")');
    for (let i = 1; i <= 60; i++) { await a.fill('#chatInput', `filler ${i}`); await a.press('#chatInput', 'Enter'); await a.waitForSelector(`.msg-body:text-is("filler ${i}")`); }
    await b.reload(); await b.waitForSelector('.msg-body:text-is("filler 60")');   // after a reload only the newest 50 are loaded
    ok('banana is not loaded yet', !(await b.isVisible('.msg-body:has-text("banana")')));
    await b.keyboard.press('Control+k');
    await b.fill('#searchInput', 'banana');
    await b.press('#searchInput', 'Enter');
    await b.waitForSelector('.search-hit:has-text("banana")');
    ok('search finds the message', true);
    await b.click('.search-hit:has-text("banana")');
    await b.waitForSelector('.msg.flash:has-text("banana")');
    ok('clicking a result jumps to it', true);
    await b.screenshot({ path: `${RESULTS}/chat-features.png` });

    const errs = [...a.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
