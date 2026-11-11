/* Accessibility: axe-core checks the main screens in the dark and the light look (labels, roles, contrast, keyboard
   access to scrolling areas, heading order), from the sign-in screen and policy pages to the crop window. And the
   keyboard: a skip link, message buttons that show up when reached with Tab, the crop window, Esc closing menus. */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { startServer, launchBrowser, signUp } from './lib.mjs';

// Run through the test tool, not as a <script> in the page: the page only runs the server's own scripts.
const AXE = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

export default async function (ok) {
  const srv = await startServer({ XP_GAP_MS: '1' });
  const browser = await launchBrowser();
  try {
    const b = await signUp(browser, srv.url, 'Bora');
    const req = (p, t, d) => p.evaluate(async ([t, d]) => { const { live } = await import('/js/net.js'); return live.req(t, d); }, [t, d]);
    await req(b, 'msg.send', { channelId: 1, body: 'hello **there** https://example.com', attachments: [] });
    await req(b, 'poll.create', { channelId: 1, question: 'Pizza?', options: ['Yes', 'No'] });
    await req(b, 'lfg.create', { channelId: 1, game: 'Valorant', need: 2 });
    // Before signing in: the sign-in screen with its cookie notice, and the policy pages, in both looks
    const early = [];
    for (const scheme of ['dark', 'light']) {
      const v = await browser.newPage({ colorScheme: scheme, reducedMotion: 'reduce' });   // the settled look, not a frame half-way through an entrance
      for (const where of ['/', '/app', '/privacy', '/terms', '/cookies', '/rules', '/delete-account']) {
        await v.goto(srv.url + where);
        if (where === '/app') await v.waitForSelector('#cookieBanner:not([hidden])');
        if (where === '/') await v.waitForSelector('.pk.rec');
        await v.evaluate(AXE).catch(() => {});
        const found = await v.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations.map((x) => `${x.id} (${x.nodes[0].target.join(' ')})`));
        for (const x of found) early.push(`${scheme} ${where}: ${x}`);
      }
      await v.close();
    }
    for (const [look, theme] of [['paper', 'dark'], ['paper', 'light'], ['arcade', 'dark'], ['arcade', 'light']]) {   // the sign-in screen in the other looks
      const ctx = await browser.newContext({ reducedMotion: 'reduce' });
      await ctx.addInitScript(([look, theme]) => localStorage.setItem('pl:settings', JSON.stringify({ look, theme, themeV: 2 })), [look, theme]);
      const v = await ctx.newPage();
      await v.goto(srv.url + '/app'); await v.waitForSelector('#cookieBanner:not([hidden])');
      await v.evaluate(AXE).catch(() => {});
      const found = await v.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations.map((x) => `${x.id} (${x.nodes[0].target.join(' ')})`));
      for (const x of found) early.push(`${look} ${theme} /app: ${x}`);
      await ctx.close();
    }
    ok(`the welcome page, sign-in screen, cookie notice and policy pages have no accessibility problems${early.length ? ': ' + early.slice(0, 6).join(' | ') : ''}`, !early.length);

    // Every look (Settings → Look), dark and light: the same screens, the same checks (text contrast above all)
    for (const [look, theme, who] of [['classic', 'dark', 'Poseidon'], ['classic', 'light', 'Lale'], ['paper', 'dark', 'Pinar'], ['paper', 'light', 'Pelin'], ['arcade', 'dark', 'Arda'], ['arcade', 'light', 'Aras']]) {
      const a = await signUp(browser, srv.url, who), lead = look === 'classic' && theme === 'dark';   // (the keyboard checks run once)
      if (!lead) {
        await a.evaluate(([look, theme]) => { const s = JSON.parse(localStorage.getItem('pl:settings') || '{}'); s.theme = theme; s.look = look; localStorage.setItem('pl:settings', JSON.stringify(s)); }, [look, theme]);
        await a.reload(); await a.waitForSelector('#room:not([hidden])');
      }
      await req(a, 'msg.send', { channelId: 1, body: 'hi from me', attachments: [] });
      const found = [];
      const audit = async (where) => {
        await a.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));   // they fade in and go away
        await a.evaluate(AXE).catch(() => {});
        await a.waitForSelector('#booting', { state: 'hidden' });   // (the loading screen has finished fading out)
        const v = await a.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations.map((x) => `${x.id} (${x.nodes[0].target.join(' ')})`));
        for (const x of v) found.push(`${where}: ${x}`);
      };
      await audit('chat');
      if (lead) {
        const firstInRoom = await a.evaluate(() => document.querySelector('#room').querySelector('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])').id);
        await a.focus('#textList .chan >> nth=0'); await a.focus('#skipLink');
        const first = [firstInRoom, await a.evaluate(() => { const r = document.activeElement.getBoundingClientRect(); return r.top >= 0 && r.height > 20; })];
        await a.keyboard.press('Enter');
        ok('the first stop for Tab is “Skip to the message box”, it shows up, and Enter goes there', first[0] === 'skipLink' && first[1] && await a.evaluate(() => document.activeElement.id === 'chatInput'));
        await a.focus('#messages .msg:has-text("hi from me") .msg-tool >> nth=0');
        await a.waitForTimeout(200);
        ok('a message’s buttons show up when reached with Tab', await a.evaluate(() => Number(getComputedStyle(document.activeElement.closest('.msg-tools')).opacity) === 1));
        await a.evaluate(() => { const d = document.querySelector('#termsDlg'); d.showModal(); }); await audit('terms window');
        await a.evaluate(() => document.querySelector('#termsDlg').close());
      }
      await a.click('#railHome'); await audit('home');
      await a.click('#navFriends'); await audit('friends');
      await a.click('#navTop'); await audit('leaderboard'); await a.click('[data-toptab="ach"]'); await audit('achievements'); await a.keyboard.press('Escape');
      await a.click('#railList .rail-btn');
      await a.click('#setBtn');
      for (const t of ['profile', 'look', 'voice', 'alerts', 'account']) { await a.click(`#settings [role="tab"][data-settab="${t}"]`); await audit(`settings ${t}`); }
      await a.click('#privacyBox > summary'); await audit('settings privacy');
      await a.click('#settings [role="tab"][data-settab="profile"]');
      const PNG = Buffer.from(await a.evaluate(() => { const c = document.createElement('canvas'); c.width = 400; c.height = 300; const g = c.getContext('2d'); g.fillStyle = '#4a7'; g.fillRect(0, 0, 400, 300); g.fillStyle = '#a47'; g.fillRect(0, 0, 200, 150); return c.toDataURL('image/png').split(',')[1]; }), 'base64');
      await a.setInputFiles('#setBgFile', { name: 'bg.png', mimeType: 'image/png', buffer: PNG });
      await a.waitForSelector('#cropDlg[open]'); await audit('crop window');
      if (lead) {
        await a.focus('#cropFrame');
        const before = await a.evaluate(() => document.querySelector('#cropFrame').style.backgroundPosition);
        await a.keyboard.press('ArrowLeft'); await a.keyboard.press('ArrowLeft'); await a.keyboard.press('+');
        const after = await a.evaluate(() => [document.querySelector('#cropFrame').style.backgroundPosition, document.querySelector('#cropZoom').value]);
        ok('the crop window works with the keyboard (arrows move the picture, + zooms)', after[0] !== before && Number(after[1]) > 1);
      }
      await a.click('#cropDlg button[value="cancel"] >> nth=1');
      await a.keyboard.press('Escape');
      await a.click('#attachBtn'); await a.click('#attachPoll'); await audit('new poll'); await a.keyboard.press('Escape');
      await a.click('#voiceList .chan:has-text("Lobby")'); await a.waitForSelector('#voiceStatus:not([hidden])', { timeout: 10000 }); await audit('voice');
      ok(`${look}, ${theme}: no accessibility problems${found.length ? ': ' + [...new Set(found)].slice(0, 8).join(' | ') : ''}`, !found.length);
      if (lead) {
        const stays = [];
        for (const [open, pop] of [['#soundBtn', '#soundPop'], ['#fxBtn', '#fxPop'], ['#meBtn', '#micPanel'], ['general'], ['#serverBtn', '#serverMenu'], ['#attachBtn', '#attachMenu'], ['#statusBtn', '#statusPop'], ['#laterBtn', '#laterPop']]) {
          if (open === 'general') { await a.click('#textList .chan:has-text("general")'); continue; }
          await a.click(open); await a.waitForSelector(pop, { state: 'visible' });
          await a.keyboard.press('Escape');
          if (await a.isVisible(pop)) { stays.push(pop); await a.click(open); }
        }
        ok(`Esc closes menus and pop-ups${stays.length ? ` (stays open: ${stays.join(', ')})` : ''}`, !stays.length);
      }
      await a.click('#vcLeaveBtn');
      await a.context().close();
    }
  } finally { await browser.close(); await srv.stop(); }
}
