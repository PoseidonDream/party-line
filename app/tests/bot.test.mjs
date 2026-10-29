/* Party Bot: command hints, Listen together (YouTube in sync for everyone in a voice channel) and the fun
   commands. YouTube itself isn't reachable from tests, so a stand-in player with the same API is served. */
import { startServer, launchBrowser, signUp, joinVoice, RESULTS } from './lib.mjs';

/* Just enough of YouTube's IFrame Player API: a clock that plays, pauses, seeks and can be told to end or fail. */
export const FAKE_YT = `
window.YT = { Player: function (id, o) {
  const el = document.getElementById(id), box = document.createElement('div');
  box.className = 'fake-yt'; el.replaceWith(box);
  let video = o.videoId, state = -1, base = (o.playerVars && o.playerVars.start) || 0, at = Date.now(), vol = 100;
  const fire = (d) => o.events.onStateChange && o.events.onStateChange({ data: d });
  const now = () => state === 1 ? base + (Date.now() - at) / 1000 : base;
  const p = {
    getCurrentTime: now, getPlayerState: () => state, getVideo: () => video, getVolume: () => vol,
    playVideo() { if (state !== 1) { base = now(); at = Date.now(); state = 1; fire(1); } },
    pauseVideo() { if (state === 1) { base = now(); state = 2; fire(2); } },
    seekTo(t) { base = t; at = Date.now(); },
    loadVideoById(v) { video = v.videoId; base = v.startSeconds || 0; at = Date.now(); state = 1; fire(1); },
    setVolume(v) { vol = v; },
    destroy() { box.remove(); window.__yt = null; },
    end() { base = now(); state = 0; fire(0); },
    fail(code) { o.events.onError && o.events.onError({ data: code }); },
  };
  window.__yt = p;
  setTimeout(() => { o.events.onReady && o.events.onReady({ target: p }); if (o.playerVars && o.playerVars.autoplay) p.playVideo(); }, 50);
  return p;
} };
setTimeout(() => window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady(), 0);`;

export default async function (ok) {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    const reg = await fetch(`${srv.url}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'party BOT', password: 'pass1234' }) });
    ok('nobody can take the bot’s name', reg.status === 400 && /bot/i.test((await reg.json()).error));

    const a = await signUp(browser, srv.url, 'Poseidon');
    const b = await signUp(browser, srv.url, 'Bora');
    for (const p of [a, b]) await p.context().route('https://www.youtube.com/iframe_api', (r) => r.fulfill({ contentType: 'text/javascript', body: FAKE_YT }));
    const say = async (p, text) => { await p.fill('#chatInput', text); await p.keyboard.press('Enter'); };
    const botMsg = (p, text, timeout = 8000) => p.waitForSelector(`#messages .msg:has(.bot-tag):has-text("${text}")`, { timeout });

    await a.fill('#chatInput', '/pl');
    await a.waitForSelector('#mentionPop:not([hidden]) li:has-text("/play")');
    await a.keyboard.press('Enter');
    ok('typing / shows the bot’s commands', (await a.inputValue('#chatInput')) === '/play ');

    await say(a, '/play https://youtu.be/dQw4w9WgXcQ');
    await a.waitForSelector('#botNote:not([hidden]):has-text("Join a voice channel first")');
    ok('/play outside voice is answered privately', (await a.locator('#messages .msg:has(.bot-tag)').count()) === 0);

    await joinVoice(a); await joinVoice(b);
    for (const p of [a, b]) await p.click('#textList .chan:has-text("general")');
    await say(a, '/play https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=4');
    await botMsg(b, 'Now playing');
    ok('the bot announces it in the chat, marked as a bot', await b.isVisible('#messages .msg:has-text("Now playing") .bot-tag'));
    await a.waitForSelector('#musicCard:not([hidden])'); await b.waitForSelector('#musicCard:not([hidden])');
    await a.waitForFunction(() => window.__yt && window.__yt.getPlayerState() === 1, null, { timeout: 8000 });
    await b.waitForFunction(() => window.__yt && window.__yt.getPlayerState() === 1, null, { timeout: 8000 });
    await a.waitForTimeout(2500);
    const [ta, tb] = await Promise.all([a.evaluate(() => window.__yt.getCurrentTime()), b.evaluate(() => window.__yt.getCurrentTime())]);
    ok(`both hear the same video at the same moment (${ta.toFixed(1)} s and ${tb.toFixed(1)} s)`,
      ta > 0.5 && Math.abs(ta - tb) < 1.5 && await b.evaluate(() => window.__yt.getVideo()) === 'dQw4w9WgXcQ');
    await a.screenshot({ path: `${RESULTS}/bot-music.png` });

    await b.click('#musicPause');
    await botMsg(a, 'paused');
    await a.waitForFunction(() => window.__yt.getPlayerState() === 2, null, { timeout: 5000 });
    ok('pausing pauses it for everyone', true);
    await a.click('#musicPause');
    await botMsg(b, 'resumed');
    await b.waitForFunction(() => window.__yt.getPlayerState() === 1, null, { timeout: 5000 });
    ok('resuming starts it again for everyone', true);

    await say(b, '/play abcdefghijk');
    await botMsg(a, 'added');
    await a.waitForSelector('#musicNext:has-text("Next:")');
    ok('/play while something plays adds it to the queue', true);
    await say(a, '/queue');
    await a.waitForSelector('#botNote:not([hidden]):has-text("1.")');
    ok('/queue lists what’s next', true);

    // The server ignores an "ended" in a video's first 5 s.
    await b.waitForFunction(() => window.__yt.getCurrentTime() > 6, null, { timeout: 15000 });
    await b.evaluate(() => window.__yt.end());
    await a.waitForFunction(() => window.__yt && window.__yt.getVideo() === 'abcdefghijk', null, { timeout: 8000 });
    ok('when a video ends, the next one plays for everyone', await b.evaluate(() => window.__yt.getVideo()) === 'abcdefghijk');
    await a.evaluate(() => window.__yt.fail(150));
    await botMsg(b, 'outside YouTube');
    await b.waitForSelector('#musicCard', { state: 'hidden', timeout: 5000 });
    ok('a video YouTube won’t play is skipped with a note', true);

    await say(a, '/play dQw4w9WgXcQ');
    await b.waitForSelector('#musicCard:not([hidden])');
    await b.click('#musicHide');
    ok('you can stop listening just for yourself', await b.isHidden('#musicCard') && await b.isVisible('#musicBack') && await a.isVisible('#musicCard'));
    await b.click('#musicBack');
    await b.waitForSelector('#musicCard:not([hidden])');
    await a.click('#musicStop');
    await botMsg(b, 'stopped the music');
    await b.waitForSelector('#musicCard', { state: 'hidden' });
    ok('stop ends it for everyone', true);

    await say(a, '/roll 2d6');
    await botMsg(b, 'rolled');
    await say(b, '/coinflip');
    await botMsg(a, 'flipped a coin');
    ok('/roll and /coinflip post their results', true);
    await say(a, '/poll Pizza or burgers? | Pizza | Burgers');
    const poll = '#messages .poll-card:has-text("Pizza or burgers?")';
    await b.waitForSelector(`${poll} .poll-opt:has-text("Burgers")`);
    ok('/poll posts a poll with a button for each choice, starting at 0 votes', (await b.textContent(`${poll} .poll-opt:has-text("Pizza") .poll-num`)) === '0 · 0%');
    await b.click(`${poll} .poll-opt:has-text("Pizza")`);
    await a.waitForSelector(`${poll} .poll-opt:has-text("Pizza") .poll-num:text-is("1 · 100%")`);
    ok('voting counts for everyone', true);
    await say(b, '/remind 5s stretch your legs');
    await b.waitForSelector('#botNote:not([hidden]):has-text("remind you here in 5 seconds")');
    await botMsg(a, 'stretch your legs', 25000);   // reminders are checked every 15 s
    ok('/remind posts the reminder later, mentioning the person', await a.isVisible('#messages .msg:has-text("stretch your legs") .mention:has-text("@Bora")'));
    await say(a, '/help');
    await a.waitForSelector('#botNote:not([hidden]):has-text("Party Bot commands")');
    await say(a, '/shrug is not a command');
    await a.waitForSelector('#messages .msg:has-text("/shrug is not a command")');
    ok('/help answers privately, and unknown /words are sent as normal messages', true);
    await a.screenshot({ path: `${RESULTS}/bot-chat.png` });

    const errs = [...a.errors, ...b.errors];
    ok(`no JavaScript errors${errs.length ? ': ' + errs.join(' | ') : ''}`, !errs.length);
  } finally { await browser.close(); await srv.stop(); }
}
