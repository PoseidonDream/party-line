/* Streaks and achievements, level rewards, the hall of fame, looking for group, the Home dashboard, drawing on
   screen shares, Clip it, pop out and soundboard keys. Bora uses a stand-in for the desktop app's bridge. */
import { startServer, launchBrowser, signUp, joinVoice, RESULTS } from './lib.mjs';

const BRIDGE = `window.partyLineDesktop = {
  version: '9.9.9', setBadge() {}, focus() {}, onPtt() {}, onActivity() {}, setTheme() {}, setOverlay() {},
  onHotkey(cb) { window.__hotkey = cb; }, setSoundKeys(list) { window.__soundKeys = list; }, drawOnScreen(d) { (window.__draws ||= []).push(d); },
};`;

export default async function (ok) {
  const srv = await startServer({ XP_GAP_MS: '1', HOF_STARS: '1' });
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Poseidon');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone'] });
    await ctx.addInitScript(BRIDGE);
    const b = await ctx.newPage(); b.errors = []; b.on('pageerror', (e) => b.errors.push(e.message));
    await b.goto(srv.url);
    await b.click('#tabRegister'); await b.fill('#authName', 'Bora'); await b.fill('#authPass', 'pass1234');
    if (await b.isVisible('#authGroup')) await b.fill('#authGroup', 'test');
    await b.click('#authBtn'); await b.waitForSelector('#room:not([hidden])');

    const say = async (p, text) => { await p.fill('#chatInput', text); await p.keyboard.press('Enter'); };
    const req = (p, type, data) => p.evaluate(async ([t, d]) => { const { live } = await import('/js/net.js'); return live.req(t, d); }, [type, data]);
    const botSays = (p, text, timeout = 8000) => p.waitForSelector(`#messages .msg:has(.bot-tag):has-text("${text}")`, { timeout });
    const clearToasts = (p) => p.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    const general = await a.evaluate(() => Number(document.querySelector('#textList .chan[aria-current="true"]').closest('li').dataset.cid));

    // Streaks and achievements
    await say(a, 'first message ever');
    await a.waitForSelector('.toast:has-text("Achievement unlocked: 💬 First words")');
    ok('the first message unlocks an achievement', true);
    await b.click('#messages .msg:has-text("first message ever") .mini-av');
    await b.waitForSelector('#userPop:not([hidden]) #popStreak:not([hidden])');
    ok('profiles show the 🔥 streak and badges', (await b.textContent('#popStreak')) === '🔥 1' && await b.isVisible('#popBadges .badge-chip[aria-label="First words"]'));
    await b.keyboard.press('Escape'); await b.mouse.click(700, 300);
    await clearToasts(a);
    await a.click('#serverBtn'); await a.click('#mTop'); await a.click('[data-toptab="ach"]');
    ok('the Achievements tab shows yours and how to get the rest', /You have \d+ of 15/.test(await a.textContent('#achCount'))
      && await a.isVisible('#achGrid .ach.got:has-text("First words")') && await a.isVisible('#achGrid .ach:not(.got):has-text("Chatterbox")'));
    await a.keyboard.press('Escape');

    // Level rewards
    const locked = await a.evaluate(async () => { const { live } = await import('/js/net.js'); try { await live.req('profile.set', { nameColor: '#ff6b6b' }); return ''; } catch (e) { return e.message; } });
    ok('name colors stay locked until level 5', /level 5/.test(locked));
    await a.evaluate(async (ch) => { const { live } = await import('/js/net.js'); for (let i = 0; i < 75; i++) await live.req('msg.send', { channelId: ch, body: `grinding ${i}`, attachments: [] }); }, general);
    await a.waitForSelector('.toast:has-text("You reached level 5")');
    await clearToasts(a);
    await a.click('#setBtn'); await a.click('#settings [role="tab"][data-settab="profile"]');
    ok('…then unlock in Settings, while higher rewards still show a lock', await a.isEnabled('#setNameColor .swatch[aria-label="Name color #ff6b6b"]')
      && await a.isVisible('#setFlair .flair-opt.locked:has-text("Lv 10")') && await a.isDisabled('input[name="bannerFx"][value="matrix"]'));
    await a.click('#setNameColor .swatch[aria-label="Name color #ff6b6b"]');
    await a.click('#setProfileSave');
    await a.waitForSelector('.toast:has-text("Profile saved")');
    await a.keyboard.press('Escape');
    await b.waitForFunction(() => [...document.querySelectorAll('#messages .msg-name')].some((n) => n.textContent.includes('Poseidon') && getComputedStyle(n).color === 'rgb(255, 107, 107)'));
    ok('everyone sees your name in your color', true);

    // Hall of fame
    const mid = Number(await a.getAttribute('#messages .msg:has-text("first message ever")', 'data-id'));
    await req(a, 'react', { id: mid, emoji: '⭐', on: true });
    await a.waitForTimeout(400);
    ok('your own ⭐ doesn’t count', !(await a.isVisible('#textList .chan:has-text("hall-of-fame")')));
    await req(b, 'react', { id: mid, emoji: '⭐', on: true });
    await a.waitForSelector('#textList .chan:has-text("hall-of-fame")');
    await a.click('#textList .chan:has-text("hall-of-fame")');
    await a.waitForSelector('#messages .msg:has(.bot-tag):has-text("first message ever") .jump-msg');
    ok('with enough ⭐ a message goes into #hall-of-fame (made when the first one gets in)', true);
    await a.click('#textList .chan:has-text("general")');
    const famous = await req(b, 'msg.send', { channelId: general, body: 'oops, delete me later', attachments: [] });
    await req(a, 'react', { id: famous.msg.id, emoji: '⭐', on: true });
    await a.click('#textList .chan:has-text("hall-of-fame")');
    await a.waitForSelector('#messages .msg:has-text("oops, delete me later")');
    await req(b, 'msg.delete', { id: famous.msg.id });
    await a.waitForSelector('#messages .msg:has-text("oops, delete me later")', { state: 'detached' });
    ok('deleting a message also takes its copy out of the hall of fame', true);
    await a.click('#textList .chan:has-text("general")');

    // Looking for group
    await req(b, 'profile.set', { favGames: 'Valorant, Peak' });
    await a.click('#attachBtn'); await a.click('#attachLfg');
    await a.fill('#lfgGame', 'Valorant'); await a.selectOption('#lfgNeed', '1'); await a.fill('#lfgNote', 'ranked');
    await a.click('#lfgForm button[type=submit]');
    const lfg = '#messages .lfg-card:has-text("Valorant")';
    await b.waitForSelector(lfg);
    await botSays(b, 'is looking for Valorant players');
    ok('a group post pings friends who list that game', await b.isVisible('#messages .msg:has-text("is looking for Valorant players") .mention:has-text("@Bora")'));
    await b.click(`${lfg} button:has-text("Join")`);
    await a.waitForSelector(`${lfg} .lfg-state:text-is("Full")`);
    await botSays(a, 'Valorant squad is full');
    ok('when it fills up, everyone in it gets pinged', true);
    await b.click(`${lfg} button:has-text("Leave")`);
    await a.waitForSelector(`${lfg} .lfg-state:text-is("Need 1 more")`);
    ok('people can leave and make room again', true);
    await say(b, '/lfg Peak 3 | chill');
    await a.waitForSelector('#messages .lfg-card:has-text("Peak"):has-text("Need 3 more"):has-text("chill")');
    ok('/lfg makes one from the message box', true);
    await a.screenshot({ path: `${RESULTS}/lfg.png` });

    // Home dashboard
    await req(b, 'presence.activity', { name: 'Minecraft' });
    await req(a, 'event.create', { serverId: 1, title: 'Movie night', startsAt: Date.now() + 86_400_000, textChannelId: general });
    await joinVoice(b);
    await clearToasts(a);
    await a.click('#railHome');
    await a.waitForSelector('#viewDash:not([hidden]) #dashVoice .dash-item:has-text("Lobby") button:has-text("Join")');
    ok('Home shows who’s in voice, with a Join button', true);
    ok('…who’s playing what', await a.isVisible('#dashPlaying .dash-item:has-text("Bora"):has-text("Minecraft")'));
    await a.waitForSelector('#dashLfg .dash-item:has-text("Peak")');
    ok('…open group posts and what’s coming up', await a.isVisible('#dashEvents .dash-item:has-text("Movie night")'));
    await a.screenshot({ path: `${RESULTS}/dashboard.png` });
    await a.click('#dashVoice .dash-item:has-text("Lobby") button:has-text("Join")');
    await a.waitForSelector('#voiceStatus:not([hidden])');
    ok('Join on Home puts you in that voice channel', true);

    // Screen share extras: Bora shares, Poseidon watches
    await b.click('#shareBtn'); await b.waitForSelector('#shareBtn.on', { timeout: 8000 });
    await a.click('.tile .live');
    await a.waitForSelector('#stage:not([hidden])');
    await a.waitForFunction(() => document.querySelector('#stageVideo').videoWidth > 0, null, { timeout: 10000 });
    ok('Pop out is offered where the browser has it', (await a.evaluate(() => !!document.pictureInPictureEnabled)) === await a.isVisible('#stagePipBtn'));
    await clearToasts(a);
    await a.click('#stageDrawBtn');
    const box = await a.locator('#stageCanvas').boundingBox();
    await a.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.45); await a.mouse.down();
    for (let i = 1; i <= 10; i++) await a.mouse.move(box.x + box.width * (0.4 + i * 0.02), box.y + box.height * 0.5, { steps: 2 });
    await a.mouse.up();
    await b.waitForFunction(() => (window.__draws || []).some((d) => d.end), null, { timeout: 5000 });
    const draws = await b.evaluate(() => window.__draws);
    ok('drawings reach the sharer’s desktop app, to show on top of their real screen', draws.some((d) => d.pts.length) && draws.every((d) => d.pts.every(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1)));
    const painted = await b.evaluate(() => { const c = document.querySelector('#stageCanvas'); if (!c.width) return false; const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < px.length; i += 4) if (px[i]) return true; return false; });
    ok('…and over the screen share for everyone watching it', painted);
    await a.click('#stageDrawBtn');
    await clearToasts(a);
    ok('Clip it starts switched off (recording costs computer power)', !(await a.evaluate(async () => { const m = await import('/js/util.js'); return !!m.settings.clips; })));
    await a.click('#stageClipBtn');
    await a.waitForSelector('.toast:has-text("Clip it is on")');
    ok('the first press switches it on and explains', await a.isVisible('#stageClipBtn.armed'));
    await a.waitForTimeout(2500);   // something to clip
    await clearToasts(a);
    await a.click('#stageClipBtn');
    await a.waitForSelector('.toast:has-text("Clip saved in #clips-and-highlights")', { timeout: 15000 });
    await a.click('.toast:has-text("Clip saved") button:has-text("Open")');
    await a.waitForSelector('#messages .msg:has-text("Clip of Bora’s screen") video.media-video');
    ok('Clip it saves the last seconds of the screen share as a video in #clips-and-highlights', true);
    const clipLen = await a.evaluate(() => new Promise((res) => {
      const x = document.createElement('video'); x.preload = 'metadata';
      x.onloadedmetadata = () => res(x.duration); x.onerror = () => res(-1); x.src = [...document.querySelectorAll('#messages video.media-video')].pop().src;
      setTimeout(() => res(x.duration), 5000);
    }));
    ok(`…and the video knows its length, so it can be skipped through (${Number(clipLen).toFixed(1)} s)`, Number.isFinite(clipLen) && clipLen > 1);
    await a.click('#voiceList .chan:has-text("Lobby")');   // back to the voice channel, to see who plays sounds

    // Soundboard keys (Bora has the desktop app)
    await clearToasts(b);
    await b.click('#soundBtn'); await b.click('#soundKeysBtn');
    await b.locator('#soundGrid .sound-btn').first().click();
    await b.keyboard.press('Control+Alt+1');
    await b.waitForSelector('#soundGrid .sound-key:text-is("Ctrl+Alt+1")');
    const keys = await b.evaluate(() => window.__soundKeys);
    ok('a sound can get its own keys, and the desktop app is told (so they work in any app)', keys.length === 1 && keys[0].key === 'CommandOrControl+Alt+1' && keys[0].id.startsWith('b:'));
    await b.click('#soundKeysBtn'); await b.mouse.click(900, 400);
    const bId = Number(await a.getAttribute('#voiceList .member:has-text("Bora")', 'data-uid'));
    await b.keyboard.press('Control+Alt+1');
    await a.waitForSelector(`.tile[data-uid="${bId}"] .tile-sound`);
    ok('pressing them plays the sound', true);
    await a.waitForSelector(`.tile[data-uid="${bId}"] .tile-sound`, { state: 'detached', timeout: 6000 });
    await b.evaluate((id) => window.__hotkey(`sound:${id}`), keys[0].id);
    await a.waitForSelector(`.tile[data-uid="${bId}"] .tile-sound`);
    ok('…and so does the key from the desktop app while another app is in front', true);

    // Achievements from all of the above
    await a.click('#railHome'); await a.click('#navTop'); await a.click('[data-toptab="ach"]');
    const got = await a.locator('#achGrid .ach.got b').allTextContents();
    ok(`achievements for the hall of fame, a full group, drawing, a clip and an event (${got.join(', ')})`, ['Famous', 'Squad up', 'Picasso', 'Director', 'Planner'].every((n) => got.includes(n)));
    await a.screenshot({ path: `${RESULTS}/achievements.png` });

    const errs = [...a.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
