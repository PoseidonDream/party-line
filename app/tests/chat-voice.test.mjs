/* The main journey: two people sign up, chat, share a photo, become friends, message privately,
   talk in voice, share a screen, and the admin uses their tools. Also checks the phone layout. */
import { startServer, launchBrowser, signUp, openPage, joinVoice, assert, RESULTS } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Poseidon');
    const b = await signUp(browser, srv.url, 'Bora');
    ok('two people sign up', true);

    await a.fill('#chatInput', 'hello from Poseidon https://example.com');
    await a.press('#chatInput', 'Enter');
    await b.waitForSelector('.msg-body:has-text("hello from Poseidon")', { timeout: 5000 });
    ok('a message shows up live for the other person', true);
    ok('links become clickable', await b.isVisible('.msg-body a[href="https://example.com"]'));

    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
    await a.setInputFiles('#fileInput', { name: 'dot.png', mimeType: 'image/png', buffer: png });
    await a.press('#chatInput', 'Enter');
    await b.waitForSelector('.media-img', { timeout: 8000 });
    ok('photos upload and show for others', true);

    await b.reload();
    await b.waitForSelector('.msg-body:has-text("hello from Poseidon")', { timeout: 8000 });
    ok('history loads after a reload, still signed in', true);

    await a.click('#railHome'); await a.click('#navFriends');
    await a.click('.tab[data-tab="add"]');
    await a.fill('#frAddName', 'bora');
    await a.click('#frAddForm button[type=submit]');
    await a.waitForSelector('#frAddNote:has-text("sent")');
    await b.click('#railHome'); await b.click('#navFriends');
    await b.click('.tab[data-tab="pending"]');
    await b.click('.fr-act.ok');
    await a.click('.tab[data-tab="all"]');
    await a.waitForSelector('.fr-row:has-text("Bora")');
    ok('friend requests can be sent and accepted', true);

    await a.click('.fr-row:has-text("Bora") .fr-act[title^="Message"]');
    await a.fill('#chatInput', 'secret dm');
    await a.press('#chatInput', 'Enter');
    await b.waitForSelector('.dm-item:has-text("Poseidon") .count-pill', { timeout: 5000 });
    await b.click('.dm-item:has-text("Poseidon")');
    await b.waitForSelector('.msg-body:has-text("secret dm")');
    ok('private messages arrive with an unread count', true);

    await joinVoice(a); await joinVoice(b);
    await a.waitForSelector('#tiles .tile:has-text("Bora") .tile-sub:has-text("Connected")', { timeout: 15000 });
    await b.waitForSelector('#tiles .tile:has-text("Poseidon") .tile-sub:has-text("Connected")', { timeout: 15000 });
    ok('voice connects both ways', true);
    ok('audio is received', await b.evaluate(() => { const el = document.querySelector('#audioSink audio'); return !!(el && el.srcObject && el.srcObject.getAudioTracks().length); }));

    await a.keyboard.press('m');
    await b.waitForSelector('#tiles .tile:has-text("Poseidon") .tile-sub:has-text("Muted")');
    ok('muting shows for others', true);
    await a.keyboard.press('m');

    // What the app asks the browser for: the shared sound without Party Line's own (friends' voices), so watchers
    // don't hear everyone twice
    await a.evaluate(() => {
      const md = navigator.mediaDevices, real = md.getDisplayMedia.bind(md);
      md.getDisplayMedia = (c) => { window.__shareAsk = c; return real(c); };
    });
    await a.click('#shareBtn');
    await a.waitForSelector('#shareBtn.on', { timeout: 8000 });
    const ask = await a.evaluate(() => ({ audio: window.__shareAsk.audio, leaveOut: !!navigator.mediaDevices.getSupportedConstraints().restrictOwnAudio }));
    ok(`a shared screen’s sound leaves out Party Line’s own voices (${ask.leaveOut ? 'left out of the capture' : 'echo cancellation'})`,
      ask.audio.restrictOwnAudio === true && ask.audio.echoCancellation === !ask.leaveOut);
    await b.waitForSelector('#tiles .tile:has-text("Poseidon") .live', { timeout: 8000 });
    await b.click('#tiles .tile:has-text("Poseidon") .live');
    await b.waitForFunction(() => { const v = document.querySelector('#stageVideo'); return v && v.srcObject && v.srcObject.getVideoTracks().length && v.videoWidth > 0; }, null, { timeout: 15000 });
    ok('screen sharing reaches the viewer', true);
    await b.screenshot({ path: `${RESULTS}/screen-share.png` });

    await a.click('#tiles .tile:has-text("Bora")');
    await a.waitForSelector('#popAdmin:not([hidden])');
    await a.click('#admVoiceKick');
    await b.waitForSelector('.toast:has-text("admin disconnected")', { timeout: 5000 });
    ok('admin can disconnect someone from voice', true);

    const phone = await openPage(browser, srv.url, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await phone.click('#tabLogin');
    await phone.fill('#authName', 'Bora'); await phone.fill('#authPass', 'pass1234');
    await phone.click('#authBtn');
    await phone.waitForSelector('#room:not([hidden])');
    await phone.screenshot({ path: `${RESULTS}/phone.png` });
    ok('signing in on a phone works', true);

    const errs = [...a.errors, ...b.errors, ...phone.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
