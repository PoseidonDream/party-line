/* Screens for the ad video (make-ad.py puts them together): a throwaway Party Line where a few friends chat, plan game
   night and hang out in voice, filmed on a phone, in English and Turkish. Nothing real is shown.
   Run from app/tests:  node ../mobile/store/make-ad-shots.mjs  (needs the tests' Playwright, like the tests do). */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, launchBrowser, signUp } from '../../tests/lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PHONE = { viewport: { width: 400, height: 760 }, deviceScaleFactor: 2.7, isMobile: true, hasTouch: true };   // 1080×2052
const TEXT = {
  en: { me: 'Deniz', chat: ['who’s on tonight? 🎮', 'me! Valorant at 9?', 'in. I’ll bring the snacks 🍕'], mine: 'count me in 🙌',
    poll: ['What should we play on Friday?', 'Valorant', 'Minecraft', 'Lethal Company'], event: 'Game night 🎮', bio: 'Admin of the group 👑 night owl, Valorant main' },
  tr: { me: 'Ece', chat: ['bu akşam kim var? 🎮', 'ben! 9’da Valorant?', 'varım. atıştırmalıklar benden 🍕'], mine: 'ben de varım 🙌',
    poll: ['Cuma ne oynayalım?', 'Valorant', 'Minecraft', 'Lethal Company'], event: 'Oyun gecesi 🎮', bio: 'Grubun yöneticisi 👑 gece kuşu, Valorant' },
};

const req = (pg, t, d) => pg.evaluate(async ([t, d]) => { const { live } = await import('/js/net.js'); return live.req(t, d); }, [t, d]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const closeAll = (pg) => pg.evaluate(() => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); document.querySelector('#room').classList.remove('drawer-open'); const s = document.querySelector('#drawerScrim'); if (s) s.hidden = true; for (const p of document.querySelectorAll('.toast, #newsDlg[open]')) p.remove(); });
const shot = async (pg, file) => { await pg.evaluate(() => document.querySelectorAll('.toast').forEach((e) => e.remove())); await wait(500); await pg.screenshot({ path: file }); };

/* A colorful picture for the admin's profile background (a night sky over hills). */
function sky() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b1055"/><stop offset=".6" stop-color="#d53369"/><stop offset="1" stop-color="#ffb347"/></linearGradient></defs>
    <rect width="1200" height="600" fill="url(#g)"/>${Array.from({ length: 60 }, (_, i) => `<circle cx="${(i * 97) % 1200}" cy="${(i * 53) % 300}" r="${1 + (i % 3)}" fill="#fff" opacity=".8"/>`).join('')}
    <circle cx="880" cy="170" r="70" fill="#ffe8a3"/><path d="M0 480 Q200 380 420 470 T860 450 T1200 470 V600 H0Z" fill="#1b0b33"/><path d="M0 540 Q300 460 600 530 T1200 520 V600 H0Z" fill="#0d0620"/></svg>`;
}

const srv = await startServer({ MSG_BURST: '500' });
const browser = await launchBrowser();
try {
  const svgPage = await browser.newPage({ viewport: { width: 1200, height: 600 } });
  await svgPage.setContent(`<body style="margin:0">${sky()}</body>`);
  const skyPng = await svgPage.screenshot(); await svgPage.close();

  for (const lang of ['en', 'tr']) {
    const T = TEXT[lang], dir = path.join(here, 'ad', `shots-${lang}`);
    fs.mkdirSync(dir, { recursive: true });
    const run = await startServer({ MSG_BURST: '500' });   // a fresh server per language
    try {
      const opts = { ...PHONE, locale: lang === 'en' ? 'en-US' : 'tr-TR' };
      const pos = await signUp(browser, run.url, 'Poseidon');   // the admin
      const bora = await signUp(browser, run.url, 'Bora');
      const lale = await signUp(browser, run.url, 'Lale');
      // The admin's profile: a background, a ring, a bio
      await pos.click('#setBtn'); await pos.click('#settings [data-settab="profile"]');
      await pos.setInputFiles('#setBgFile', { name: 'sky.png', mimeType: 'image/png', buffer: skyPng });
      await pos.waitForSelector('#cropDlg[open]'); await pos.click('#cropOk'); await pos.waitForSelector('#prevBanner.has-bg');
      await pos.click('input[name="bannerFx"][value="stars"] + span'); await pos.click('#setFlair .flair-opt >> nth=3');
      await pos.fill('#setBio', T.bio); await pos.click('#setProfileSave'); await wait(600); await closeAll(pos);

      const say = async (pg, body) => { await req(pg, 'msg.send', { channelId: 1, body, attachments: [] }); await wait(200); };
      await say(bora, T.chat[0]); await say(lale, T.chat[1]); await say(pos, T.chat[2]);
      const poll = await req(lale, 'poll.create', { channelId: 1, question: T.poll[0], options: T.poll.slice(1), multi: false, anon: false, minutes: 0 });
      const pollId = Number(poll.msg.body.match(/<poll:(\d+)>/)[1]);
      await req(bora, 'poll.vote', { id: pollId, option: 0, on: true }); await req(pos, 'poll.vote', { id: pollId, option: 0, on: true }); await req(lale, 'poll.vote', { id: pollId, option: 2, on: true });

      const me = await signUp(browser, run.url, T.me, opts);
      await closeAll(me);
      await req(me, 'msg.send', { channelId: 1, body: T.mine, attachments: [] });
      const last = await me.waitForSelector(`#messages .msg:has-text("${T.mine}")`);
      const mid = Number(await last.getAttribute('data-id'));
      for (const [pg, e] of [[bora, '🔥'], [lale, '😂'], [pos, '🔥']]) await req(pg, 'react', { id: mid, emoji: e, on: true });
      await wait(900); await closeAll(me);
      await shot(me, path.join(dir, '1-chat.png'));

      // Voice: everyone in the Lobby
      for (const pg of [pos, bora, lale]) { await pg.click('#railList .rail-btn'); await pg.click('#voiceList .chan:has-text("Lobby")'); await pg.waitForSelector('#voiceStatus:not([hidden])', { timeout: 10000 }); }
      await me.tap('#drawerBtn'); await me.tap('#voiceList .chan:has-text("Lobby")');
      await me.waitForSelector('#voiceStatus:not([hidden])', { timeout: 10000 });
      await wait(3000); await closeAll(me);
      await shot(me, path.join(dir, '2-voice.png'));
      await me.tap('#fxBtn'); await wait(600);
      await shot(me, path.join(dir, '3-effects.png'));
      await closeAll(me); await me.keyboard.press('Escape'); await me.tap('#fxBtn').catch(() => {}); await closeAll(me);
      await me.tap('#soundBtn'); await wait(700);
      await shot(me, path.join(dir, '4-soundboard.png'));
      await me.keyboard.press('Escape'); await me.tap('#soundBtn').catch(() => {}); await closeAll(me);
      await me.tap('#vcLeaveBtn').catch(() => {}); await wait(500);

      // Events (planned after the chat was filmed: Party Bot announces it in English, whatever the app's language)
      const ev = await req(pos, 'event.create', { serverId: 1, title: T.event, startsAt: Date.now() + 2 * 86400_000 + 3600_000, gameVote: 30 });
      await req(bora, 'event.rsvp', { id: ev.id, state: 'going' }); await req(lale, 'event.rsvp', { id: ev.id, state: 'maybe' });
      await me.tap('#drawerBtn'); await me.tap('#textList .chan:has-text("general")'); await closeAll(me);
      await me.evaluate(() => document.querySelector('header button:has(svg use[href="#i-calendar"]), #eventsBtn')?.click());
      await wait(900);
      await shot(me, path.join(dir, '5-events.png'));
      await closeAll(me);

      // The admin's profile card
      await me.tap(`#messages .msg:has-text("${T.chat[2]}") .mini-av`);
      await me.waitForSelector('#userPop:not([hidden]) #popBanner.has-bg'); await wait(900);
      await shot(me, path.join(dir, '6-profile.png'));
      await me.keyboard.press('Escape'); await me.mouse.click(10, 300); await closeAll(me);

      // Levels: the Home page
      await me.evaluate(() => { document.querySelector('#railHome').click(); document.querySelector('#navHome').click(); });
      await closeAll(me); await wait(900);
      await shot(me, path.join(dir, '7-home.png'));
      console.log(`${lang}: saved in ${dir}`);
    } finally { await run.stop(); }
  }
} finally { await browser.close(); await srv.stop(); }
