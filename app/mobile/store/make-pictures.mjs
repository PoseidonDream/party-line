/* Makes the Google Play store pictures: the 1024×500 banner ("feature graphic") and phone screenshots, in English and
   Turkish. It starts a throwaway Party Line with a few friends chatting, so no real messages are shown.
   Run from app/tests:  node ../mobile/store/make-pictures.mjs   (needs the tests' Playwright, like the tests do). */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, launchBrowser, signUp } from '../../tests/lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PHONE = { viewport: { width: 400, height: 711 }, deviceScaleFactor: 2.7, isMobile: true, hasTouch: true };   // 1080×1920

const srv = await startServer();
const browser = await launchBrowser();
const req = (pg, t, d) => pg.evaluate(async ([t, d]) => { const { live } = await import('/js/net.js'); return live.req(t, d); }, [t, d]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (pg, file) => { await pg.evaluate(() => document.querySelectorAll('.toast').forEach((e) => e.remove())); await pg.screenshot({ path: file }); };   // no pop-up notes in the pictures
try {
  // The banner
  const banner = await browser.newPage({ viewport: { width: 1024, height: 500 } });
  await banner.setContent(fs.readFileSync(path.join(here, 'banner.html'), 'utf8'), { waitUntil: 'networkidle' });
  await banner.evaluate(() => document.fonts.ready);
  await banner.screenshot({ path: path.join(here, 'feature-graphic.png') });
  await banner.close();

  // Friends chatting
  const bora = await signUp(browser, srv.url, 'Bora');
  const lale = await signUp(browser, srv.url, 'Lale');
  const say = async (pg, body) => { await req(pg, 'msg.send', { channelId: 1, body, attachments: [] }); await wait(150); };
  await say(bora, 'who’s on tonight? 🎮');
  await say(lale, 'me! Valorant at 9?');
  await say(bora, 'in. I’ll bring the snacks 🍕');
  const poll = await req(lale, 'poll.create', { channelId: 1, question: 'What should we play on Friday?', options: ['Valorant', 'Minecraft', 'Lethal Company'], multi: false, anon: false, minutes: 0 });
  const pollId = Number(poll.msg.body.match(/<poll:(\d+)>/)[1]);
  await req(bora, 'poll.vote', { id: pollId, option: 0, on: true }); await req(lale, 'poll.vote', { id: pollId, option: 2, on: true });
  await say(lale, 'vote above 👆 Party Bot announces the winner');

  for (const lang of ['en', 'tr']) {
    const dir = path.join(here, `screenshots-${lang}`); fs.mkdirSync(dir, { recursive: true });
    const me = await signUp(browser, srv.url, lang === 'en' ? 'Deniz' : 'Ece', { ...PHONE, locale: lang === 'en' ? 'en-US' : 'tr-TR' });
    await req(me, 'msg.send', { channelId: 1, body: lang === 'en' ? 'count me in 🙌' : 'ben de varım 🙌', attachments: [] });
    await wait(800);
    await shot(me, path.join(dir, '1-chat.png'));

    // Voice: everyone in the Lobby
    for (const pg of [bora, lale]) {
      if (!(await pg.isVisible('#voiceStatus:not([hidden])'))) { await pg.click('#railList .rail-btn'); await pg.click('#voiceList .chan:has-text("Lobby")'); await pg.waitForSelector('#voiceStatus:not([hidden])', { timeout: 10000 }); }
    }
    await me.click('#drawerBtn'); await me.click('#voiceList .chan:has-text("Lobby")');
    await me.waitForSelector('#voiceStatus:not([hidden])', { timeout: 10000 });
    await wait(2500);
    await shot(me, path.join(dir, '2-voice.png'));
    await me.click('#fxBtn'); await wait(500);
    await shot(me, path.join(dir, '3-voice-effects.png'));
    await me.keyboard.press('Escape'); await me.click('#fxBtn').catch(() => {});
    await me.click('#setBtn'); await me.click('#settings [data-settab="look"]'); await wait(500);
    await shot(me, path.join(dir, '4-settings.png'));
    await me.keyboard.press('Escape');
    await me.click('#vcLeaveBtn').catch(() => {});
    await me.context().close();
  }
  console.log('Pictures saved in', here);
} finally { await browser.close(); await srv.stop(); }
