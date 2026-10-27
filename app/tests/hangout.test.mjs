/* Polls, XP and levels, chat in voice channels, voice effects, "remind me about this" and disappearing messages. */
import { startServer, launchBrowser, signUp, joinVoice, RESULTS } from './lib.mjs';

export default async function (ok) {
  const srv = await startServer({
    POLL_TEST: '1', POLL_MINUTE_MS: '300', POLL_TICK_MS: '300', XP_GAP_MS: '1', XP_VOICE_MS: '700',
    REMIND_TICK_MS: '300', LATER_MIN_MS: '0', DISAPPEAR_TEST: '1', DISAPPEAR_TICK_MS: '300',
  });
  const browser = await launchBrowser();
  try {
    const a = await signUp(browser, srv.url, 'Poseidon');
    const b = await signUp(browser, srv.url, 'Bora');
    const say = async (p, text) => { await p.fill('#chatInput', text); await p.keyboard.press('Enter'); };
    const req = (p, type, data) => p.evaluate(async ([t, d]) => { const { live } = await import('/js/net.js'); return live.req(t, d); }, [type, data]);
    const botSays = (p, text, timeout = 8000) => p.waitForSelector(`#messages .msg:has(.bot-tag):has-text("${text}")`, { timeout });
    const general = await a.evaluate(() => Number(document.querySelector('#textList .chan[aria-current="true"]').closest('li').dataset.cid));

    // Polls
    await a.click('#attachBtn'); await a.click('#attachPoll');
    await a.waitForSelector('#pollDlg[open]');
    await a.fill('#pollQ', 'Pizza or burgers?');
    await a.locator('#pollOpts input').nth(0).fill('Pizza');
    await a.locator('#pollOpts input').nth(1).fill('Burgers');
    await a.click('#pollAddOpt');
    await a.locator('#pollOpts input').nth(2).fill('Tacos');
    await a.click('#pollForm button[type=submit]');
    const card = '#messages .poll-card:has-text("Pizza or burgers?")';
    await b.waitForSelector(card);
    ok('+ then Poll posts a poll card for everyone', (await b.locator(`${card} .poll-opt`).count()) === 3);
    await b.click(`${card} .poll-opt:has-text("Tacos")`);
    await a.waitForSelector(`${card} .poll-opt:has-text("Tacos") .poll-num:text-is("1 · 100%")`);
    ok('votes show up live, with who voted', (await a.getAttribute(`${card} .poll-opt:has-text("Tacos")`, 'title')) === 'Bora');
    await b.click(`${card} .poll-opt:has-text("Pizza")`);
    await a.waitForSelector(`${card} .poll-opt:has-text("Pizza") .poll-num:text-is("1 · 100%")`);
    ok('with one choice allowed, picking another moves your vote', (await a.textContent(`${card} .poll-opt:has-text("Tacos") .poll-num`)) === '0 · 0%');
    await b.reload(); await b.waitForSelector(`${card} .poll-opt.mine:has-text("Pizza")`);
    ok('your own vote stays marked after reopening the app', true);
    ok('only whoever made the poll (or a moderator) can end it', !(await b.isVisible(`${card} .poll-foot .link-btn`)));
    await a.click(`${card} .poll-foot .link-btn`); await a.click('#cfOk');
    await botSays(b, 'won with 1 vote');
    await b.waitForSelector(`${card} .poll-opt.won:has-text("Pizza")`);
    await b.locator(card).scrollIntoViewIfNeeded(); await b.screenshot({ path: `${RESULTS}/poll.png` });
    ok('ending it posts the winner and locks the poll', await b.isDisabled(`${card} .poll-opt:has-text("Burgers")`) && /final results/.test(await b.textContent(`${card} .poll-foot`)));
    await req(a, 'poll.create', { channelId: general, question: 'Secret ballot?', options: ['Yes', 'No'], anon: true });
    const anon = '#messages .poll-card:has-text("Secret ballot?")';
    await b.click(`${anon} .poll-opt:has-text("Yes")`);
    await a.waitForSelector(`${anon} .poll-opt:has-text("Yes") .poll-num:text-is("1 · 100%")`);
    ok('anonymous polls show only the numbers', (await a.getAttribute(`${anon} .poll-opt:has-text("Yes")`, 'title')) === 'Anonymous poll');
    await req(a, 'poll.create', { channelId: general, question: 'Quick one?', options: ['A', 'B'], minutes: 1 });
    await botSays(b, 'Quick one?” ended with no votes');
    ok('a poll with a time limit ends by itself', true);
    await say(a, '/poll Movie night? | Yes | No | Maybe');
    await b.waitForSelector('#messages .poll-card:has-text("Movie night?")');
    ok('/poll makes the same poll card', (await b.locator('#messages .poll-card:has-text("Movie night?") .poll-opt').count()) === 3);

    // XP and levels
    for (let i = 1; i <= 12; i++) await say(b, `message number ${i}`);
    await botSays(a, 'Bora reached level 2');
    await b.waitForSelector('.toast:has-text("You reached level 2")');
    ok('chatting earns XP, and level-ups get a cheer from Party Bot', true);
    await a.click('#messages .msg:has-text("message number") .mini-av >> nth=0');   // a run of messages shows the picture once
    await a.waitForSelector('#userPop:not([hidden]) #popLevel:not([hidden])');
    ok('the profile shows the level and how far to the next', (await a.textContent('#popLevelText')) === 'Level 2' && (await a.textContent('#popLevelXp')) === '0 / 150 XP to level 3');
    await a.keyboard.press('Escape'); await a.mouse.click(700, 300);
    await a.click('#serverBtn'); await a.click('#mTop');
    await a.waitForSelector('#topDlg[open] .top-row');
    const first = await a.textContent('#topList .top-row:first-child');
    ok('the leaderboard puts the most active first', /🥇/.test(first) && /Bora/.test(first) && /Lv 2/.test(first) && /120 XP/.test(first));
    await a.screenshot({ path: `${RESULTS}/leaderboard.png` });
    await a.keyboard.press('Escape');
    await say(b, '/rank');
    await botSays(a, 'is level 2 (120 XP, #1 overall)');
    await say(b, '/top');
    await botSays(a, 'Leaderboard');
    ok('/rank and /top post levels in the chat', true);

    // Chat in voice channels
    await joinVoice(a); await joinVoice(b);
    await a.click('#vcChatBtn');
    await a.waitForSelector('#viewSub:has-text("Chat")');
    await say(a, 'who is up for a match?');
    await b.waitForSelector('#vcChatCount:not([hidden])');
    ok('a voice channel has its own chat, and people in the call see new messages counted', true);
    await b.click('#vcChatBtn');
    await b.waitForSelector('#messages .msg:has-text("who is up for a match?")');
    await b.click('#vcChatBtn');
    await b.waitForSelector('#vcChatLabel:text-is("Chat")');
    ok('Chat opens it and “Back to voice” returns', true);
    await b.click('#textList .chan:has-text("general")');
    await say(a, 'last call for the match');
    await b.waitForSelector('#voiceList .chan-chat');
    await b.click('#voiceList .chan-chat');
    await b.waitForSelector('#messages .msg:has-text("last call for the match")');
    ok('from elsewhere, the 💬 count in the channel list opens that chat', true);
    const bId = Number(await a.getAttribute('#voiceList .member:has-text("Bora")', 'data-uid'));
    await a.click('#serverBtn'); await a.click('#mTop');
    const boraXp = () => a.evaluate(() => Number(/(\d+) XP/.exec([...document.querySelectorAll('#topList .top-row')].find((r) => r.textContent.includes('Bora')).textContent)[1]));
    const xpBefore = await boraXp();
    await a.waitForFunction((n) => Number(/(\d+) XP/.exec([...document.querySelectorAll('#topList .top-row')].find((r) => r.textContent.includes('Bora')).textContent)[1]) >= n + 5, xpBefore, { timeout: 5000 });
    ok('time in voice together earns XP too (the leaderboard updates live)', (await boraXp()) > xpBefore);
    await a.keyboard.press('Escape');

    // Voice effects
    const fx = (p) => p.evaluate(async () => {
      const { V, monitoring } = await import('/js/voice.js');
      const e = V.fx && V.fx.effect;
      return { on: !!e, worklet: !!(e && e.nodes[0] instanceof AudioWorkletNode), sending: !!(V.fx && V.sendTrack === V.fx.dest.stream.getAudioTracks()[0]), monitoring: monitoring() };
    });
    const fxUntil = async (p, want) => { for (let i = 0; i < 50; i++) { const st = await fx(p); if (want(st)) return st; await p.waitForTimeout(100); } return fx(p); };
    await a.click('#fxBtn');
    await a.waitForSelector('#fxPop:not([hidden])');
    await a.click('#fxOpts [data-fx="robot"]');
    let st = await fxUntil(a, (x) => x.on);
    ok('picking Robot sends your voice through the effect', st.on && st.sending && await a.isVisible('#fxBtn.active'));
    await a.click('#fxOpts [data-fx="deep"]');
    ok('Deep and Chipmunk shift the pitch', (await fxUntil(a, (x) => x.worklet)).worklet);
    await a.screenshot({ path: `${RESULTS}/voice-fx.png` });
    await a.check('#fxHear');
    ok('“Hear myself” plays your mic back to you', (await fx(a)).monitoring);
    await a.mouse.click(700, 300);
    await a.waitForSelector('#fxPop', { state: 'hidden' });
    ok('…until the pop-up closes', !(await fx(a)).monitoring);
    await a.click('#setBtn'); await a.click('#settings [role="tab"][data-settab="voice"]');
    ok('Settings shows the same choice', await a.isVisible('#setFx [data-fx="deep"][aria-checked="true"]'));
    await a.click('#setFx [data-fx="none"]');
    st = await fxUntil(a, (x) => !x.on);
    ok('Normal turns it off', !st.on && !(await a.isVisible('#fxBtn.active')));
    await a.keyboard.press('Escape');
    await a.click('#vcLeaveBtn'); await b.click('#vcLeaveBtn');

    // Remind me about this
    await a.click('#textList .chan:has-text("general")');
    const target = '#messages .msg:has-text("message number 7")';
    await a.locator(target).hover();
    await a.click(`${target} .msg-tool[title="Remind me about this"]`);
    await a.waitForSelector('#remindPop:not([hidden]) #remindPresets button');
    await a.click('#remindPresets button:has-text("In 1 hour")');
    await a.waitForSelector('.toast:has-text("Party Bot will remind you")');
    ok('the clock on a message sets a reminder', await a.isHidden('#remindPop'));
    const mid = Number(await a.getAttribute(target, 'data-id'));
    await req(a, 'remind.set', { id: mid, at: Date.now() + 800 });
    await a.click('#railHome');
    await a.click('#dmList .dm-item:has-text("Party Bot")', { timeout: 8000 });
    await a.waitForSelector('#messages .msg:has-text("remind you about this message from Bora in #general")');
    ok('Party Bot sends it back privately when it’s time, quoting the message', await a.isVisible('#messages .msg:has-text("message number 7")'));
    await a.click('#messages .jump-msg >> nth=-1');
    await a.waitForSelector(`#messages .msg.flash[data-id="${mid}"]`);
    ok('“Go to message” jumps right to it', (await a.textContent('#viewTitle')) === 'general');

    // Disappearing messages (and XP for private chats: one level for the whole app)
    const myXp = async () => { await a.click('#railHome'); await a.click('#navTop'); const t = await a.textContent('#topList .top-row.me .top-level'); await a.keyboard.press('Escape'); return Number(/(\d+) XP/.exec(t)[1]); };
    const xpBeforeDm = await myXp();
    await a.click('#railList .rail-btn'); await a.click('#textList .chan:has-text("general")');
    await a.click('#messages .msg:has-text("message number") .mini-av >> nth=0'); await a.click('#popMsg');
    await a.waitForSelector('#viewTitle:text-is("Bora")');
    await a.click('#disappearBtn');
    await a.click('#disappearOpts [data-secs="86400"]');
    await botSays(a, 'turned on disappearing messages');
    ok('either person can turn on disappearing messages in a private chat', await a.isVisible('#disappearBtn.on'));
    await say(a, 'this goes away tomorrow');
    await a.waitForSelector('#messages .msg:has-text("this goes away tomorrow") .msg-expires');
    ok('new messages show when they’ll go', true);
    ok('chatting in private chats earns XP too (Home → Leaderboard)', (await myXp()) >= xpBeforeDm + 10);
    await a.click('#dmList .dm-item:has-text("Bora")');
    await req(a, 'disappear.set', { userId: bId, seconds: 2 });
    await say(a, 'self destructing');
    await b.click('#railHome');
    await b.click('#dmList .dm-item:has-text("Poseidon")');
    await b.waitForSelector('#messages .msg:has-text("self destructing")');
    await b.waitForSelector('#messages .msg:has-text("self destructing")', { state: 'detached', timeout: 8000 });
    await a.waitForSelector('#messages .msg:has-text("self destructing")', { state: 'detached' });
    ok('when the time is up they’re deleted for both people', true);

    const errs = [...a.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
